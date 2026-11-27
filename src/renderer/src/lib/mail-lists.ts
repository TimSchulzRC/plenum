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
// Listen, die gerade im Hintergrund laden, mit der Anfrage, der die Markierung gehört
const background = new Map<string, object>()

// Eigene Änderungen. Eine Antwort auf eine Anfrage, die vor dem Abschluss der Änderung begonnen hat,
// kennt sie womöglich noch nicht: Für die gilt die Änderung. Spätere Antworten zeigen den Stand des
// Servers, auch wenn man die Mail inzwischen anderswo (Outlook) wieder geändert hat.
type Change = { patch?: Partial<MailSummary>; deleted?: boolean; settled: number }
const changes = new Map<string, Change>()
// Ungelesen-Zahlen, die die App selbst angepasst hat, je Konto: welche Ordner und bis wann
type Bump = { folders: Set<string>; settled: number }
const bumps = new Map<string, Bump[]>()
const KEEP = 120_000

function prune(now: number): void {
  for (const [k, c] of changes) if (now - c.settled > KEEP) changes.delete(k)
  for (const [k, list] of bumps) {
    const left = list.filter((b) => now - b.settled <= KEEP)
    if (left.length) bumps.set(k, left)
    else bumps.delete(k)
  }
}

function withChanges(accountId: string, items: MailSummary[], started: number): MailSummary[] {
  prune(Date.now())
  if (!changes.size) return items
  return items.flatMap((i) => {
    const c = changes.get(`${accountId}|${i.id}`)
    if (!c || started >= c.settled) return [i]
    return c.deleted ? [] : [{ ...i, ...c.patch }]
  })
}

const folderKey = (f: MailFolder) => (f.kind === 'inbox' ? 'inbox' : f.id)

// Antwort auf eine Anfrage, die vor dem Abschluss einer eigenen Anpassung begann: Ob die Zahl die
// Änderung schon enthält, weiß man nicht. Dann bleibt die angepasste Zahl, den Stand des Servers holt die
// Ansicht nach dem Abschluss neu.
function withBumps(accountId: string, list: MailFolder[], started: number): MailFolder[] {
  prune(Date.now())
  const open = new Set((bumps.get(accountId) ?? []).filter((b) => started < b.settled).flatMap((b) => [...b.folders]))
  if (!open.size) return list
  const mine = folders.peek(accountId)
  return list.map((f) => {
    const cur = open.has(folderKey(f)) ? mine?.find((x) => x.id === f.id) : undefined
    return cur ? { ...f, unread: cur.unread } : f
  })
}

export const cachedFolders = (accountId: string): MailFolder[] | undefined => folders.peek(accountId)
export const cachedList = (accountId: string, folderId: string): MailPage | undefined => lists.peek(listKey(accountId, folderId))

// force: auch einen frischen Stand neu holen (Neu laden, regelmäßiger Abgleich). quiet: vorgeladen.
export function loadFolders(accountId: string, force = false, quiet = false): Promise<MailFolder[]> {
  const hit = folders.peek(accountId)
  if (hit && !force && folders.isFresh(accountId)) return Promise.resolve(hit)
  return folders.load(accountId, () => {
    const started = Date.now()
    return api.getMailFolders(accountId, quiet).then((list) => withBumps(accountId, list, started))
  })
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
    const started = Date.now()
    const mark = {}
    if (quiet) background.set(k, mark)
    return api
      .listMail(accountId, folderId, undefined, quiet)
      .then((p) => ({ ...p, items: withChanges(accountId, p.items, started) }))
      .finally(() => {
        if (background.get(k) === mark) background.delete(k)
      })
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

// Gelesen markiert oder gelöscht: sofort in den gespeicherten Listen des Kontos und in Antworten, die vor
// dem Abschluss beginnen. Gibt eine Funktion zurück, die den Abschluss meldet (ohne: schon abgeschlossen).
export function noteMailChange(accountId: string, id: string, change: { patch: Partial<MailSummary> } | { deleted: true }, pending = false): () => void {
  const c: Change = { ...change, settled: pending ? Infinity : Date.now() }
  changes.set(`${accountId}|${id}`, c)
  // Nur diese Mail: Andere hat der Server inzwischen womöglich anders gemeldet
  const apply = (items: MailSummary[]) => items.flatMap((i) => (i.id !== id ? [i] : 'deleted' in change ? [] : [{ ...i, ...change.patch }]))
  for (const k of lists.keys()) if (k.startsWith(`${accountId}|`)) lists.update(k, (p) => ({ ...p, items: apply(p.items) }))
  return () => {
    c.settled = Date.now()
  }
}

// Ungelesen-Zahl eines Ordners selbst angepasst (folderId wie in der Liste, Posteingang 'inbox'): auch im
// Speicher und in Antworten, die vor dem Abschluss beginnen
export function noteUnreadBump(accountId: string, folderId: string, delta: number, pending = false): () => void {
  const b: Bump = { folders: new Set([folderId]), settled: pending ? Infinity : Date.now() }
  bumps.set(accountId, [...(bumps.get(accountId) ?? []), b])
  folders.update(accountId, (list) => list.map((f) => (folderKey(f) === folderId ? { ...f, unread: Math.max(0, f.unread + delta) } : f)))
  return () => {
    b.settled = Date.now()
  }
}

// Nach dem Abschluss eines Schreibens: Eine Ordnerabfrage, die schon läuft, begann davor. Sie zählt nicht
// mehr, die nächste startet neu und liefert den Stand danach.
export function foldersAfterWrite(accountId: string): void {
  folders.markStale(accountId)
}

// Nach Senden oder Löschen: Gesendete bzw. Gelöschte beim nächsten Öffnen neu laden
export function staleFolder(accountId: string, kind: MailFolderKind): string | undefined {
  const f = folders.peek(accountId)?.find((x) => x.kind === kind)
  if (!f) return undefined
  const id = folderKey(f)
  lists.markStale(listKey(accountId, id))
  folders.markStale(accountId)
  return id
}
