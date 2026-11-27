import type { MailFolder, MailFolderKind, MailPage, MailSummary } from '@shared/types'
import { api } from '../api'
import { PrefetchCache } from './cache'

// Ordner und erste Listenseite je Konto und Ordner, über Besuche des Mail-Tabs hinweg. Die Ansicht zeigt
// den gespeicherten Stand sofort und gleicht im Hintergrund ab. Vorgeladen wird nach dem Start
// (warmMail) und beim Überfahren: Mail in der Seitenleiste, Ordner in der Ordnerliste. Vorgeladenes
// läuft im Hauptprozess hinter dem, was man öffnet.
const folders = new PrefetchCache<MailFolder[]>({ maxEntries: 20, freshMs: 60_000 })
const lists = new PrefetchCache<MailPage>({ maxEntries: 60, freshMs: 30_000 })
const listKey = (accountId: string, folderId: string) => `${accountId}|${folderId}`
// Listen, die gerade im Hintergrund laden
const background = new Set<string>()

// Eigene Änderungen (gelesen, gelöscht) der letzten zwei Minuten. Eine Liste, die der Server vor der
// Änderung beantwortet hat, brächte sonst den alten Stand zurück.
type Change = { patch?: Partial<MailSummary>; deleted?: boolean; at: number }
const changes = new Map<string, Change>()

function withChanges(accountId: string, items: MailSummary[]): MailSummary[] {
  const now = Date.now()
  for (const [k, c] of changes) if (now - c.at > 120_000) changes.delete(k)
  if (!changes.size) return items
  return items.flatMap((i) => {
    const c = changes.get(`${accountId}|${i.id}`)
    if (!c) return [i]
    return c.deleted ? [] : [{ ...i, ...c.patch }]
  })
}

export const cachedFolders = (accountId: string): MailFolder[] | undefined => folders.peek(accountId)
export const cachedList = (accountId: string, folderId: string): MailPage | undefined => lists.peek(listKey(accountId, folderId))

// force: auch einen frischen Stand neu holen (Neu laden, regelmäßiger Abgleich). quiet: vorgeladen.
export function loadFolders(accountId: string, force = false, quiet = false): Promise<MailFolder[]> {
  const hit = folders.peek(accountId)
  if (hit && !force && folders.isFresh(accountId)) return Promise.resolve(hit)
  return folders.load(accountId, () => api.getMailFolders(accountId, quiet))
}

export function loadList(accountId: string, folderId: string, force = false, quiet = false): Promise<MailPage> {
  const k = listKey(accountId, folderId)
  const hit = lists.peek(k)
  if (hit && !force && lists.isFresh(k)) return Promise.resolve(hit)
  // Lädt sie schon im Hintergrund, jetzt aber für die Anzeige: nach vorn holen
  if (!quiet && lists.loading(k) && background.has(k)) {
    background.delete(k)
    void api.promoteMailList(accountId, folderId).catch(() => undefined)
  }
  return lists.load(k, () => {
    if (quiet) background.add(k)
    return api
      .listMail(accountId, folderId, undefined, quiet)
      .then((p) => ({ ...p, items: withChanges(accountId, p.items) }))
      .finally(() => background.delete(k))
  })
}

export function prefetchList(accountId: string, folderId: string): void {
  void loadList(accountId, folderId, false, true).catch(() => undefined)
}

// Ordner und Posteingang der Konten schon laden, damit der Mail-Tab gleich etwas zeigt
export function warmMail(accountIds: string[]): void {
  for (const id of accountIds) {
    void loadFolders(id, false, true).catch(() => undefined)
    prefetchList(id, 'inbox')
  }
}

// Gelesen markiert oder gelöscht: in den gespeicherten Listen des Kontos und in Antworten, die noch
// unterwegs sind
export function noteMailChange(accountId: string, id: string, change: { patch: Partial<MailSummary> } | { deleted: true }): void {
  changes.set(`${accountId}|${id}`, { ...change, at: Date.now() })
  for (const k of lists.keys()) if (k.startsWith(`${accountId}|`)) lists.update(k, (p) => ({ ...p, items: withChanges(accountId, p.items) }))
}

// Ungelesen-Zahlen der Ordner sofort anpassen, auch im Speicher
export function updateCachedFolders(accountId: string, fn: (list: MailFolder[]) => MailFolder[]): void {
  folders.update(accountId, fn)
}

// Nach Senden oder Löschen: Gesendete bzw. Gelöschte beim nächsten Öffnen neu laden
export function staleFolder(accountId: string, kind: MailFolderKind): string | undefined {
  const f = folders.peek(accountId)?.find((x) => x.kind === kind)
  if (!f) return undefined
  const id = kind === 'inbox' ? 'inbox' : f.id
  lists.markStale(listKey(accountId, id))
  folders.markStale(accountId)
  return id
}
