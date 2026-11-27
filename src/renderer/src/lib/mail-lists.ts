import type { MailFolder, MailPage, MailSummary } from '@shared/types'
import { api } from '../api'
import { PrefetchCache } from './cache'

// Ordner und erste Listenseite je Konto und Ordner, über Besuche des Mail-Tabs hinweg. Die Ansicht zeigt
// den gespeicherten Stand sofort und gleicht im Hintergrund ab. Vorgeladen wird nach dem Start
// (warmMail) und beim Überfahren: Mail in der Seitenleiste, Ordner in der Ordnerliste.
const folders = new PrefetchCache<MailFolder[]>({ maxEntries: 20, freshMs: 60_000 })
const lists = new PrefetchCache<MailPage>({ maxEntries: 60, freshMs: 30_000 })
const listKey = (accountId: string, folderId: string) => `${accountId}|${folderId}`

export const cachedFolders = (accountId: string): MailFolder[] | undefined => folders.peek(accountId)
export const cachedList = (accountId: string, folderId: string): MailPage | undefined => lists.peek(listKey(accountId, folderId))

// force: auch einen frischen Stand neu holen (Neu laden, regelmäßiger Abgleich)
export function loadFolders(accountId: string, force = false): Promise<MailFolder[]> {
  const hit = folders.peek(accountId)
  if (hit && !force && folders.isFresh(accountId)) return Promise.resolve(hit)
  return folders.load(accountId, () => api.getMailFolders(accountId))
}

export function loadList(accountId: string, folderId: string, force = false): Promise<MailPage> {
  const k = listKey(accountId, folderId)
  const hit = lists.peek(k)
  if (hit && !force && lists.isFresh(k)) return Promise.resolve(hit)
  return lists.load(k, () => api.listMail(accountId, folderId))
}

export function prefetchList(accountId: string, folderId: string): void {
  void loadList(accountId, folderId).catch(() => undefined)
}

// Ordner und Posteingang der Konten schon laden, damit der Mail-Tab gleich etwas zeigt
export function warmMail(accountIds: string[]): void {
  for (const id of accountIds) {
    void loadFolders(id).catch(() => undefined)
    prefetchList(id, 'inbox')
  }
}

// Gelesen markiert oder gelöscht: auch in den gespeicherten Listen des Kontos, sonst zeigte der
// nächste Besuch kurz den alten Stand
export function updateCachedMail(accountId: string, fn: (items: MailSummary[]) => MailSummary[]): void {
  for (const k of lists.keys()) if (k.startsWith(`${accountId}|`)) lists.update(k, (p) => ({ ...p, items: fn(p.items) }))
}
