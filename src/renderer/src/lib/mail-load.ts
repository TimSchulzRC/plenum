import type { MailImages, MailMessage } from '@shared/types'
import { api } from '../api'
import { PrefetchCache } from './cache'
import { inlineToLoad } from './mail'

// Geöffnete und vorgeladene Mails. Der Inhalt einer Mail ändert sich nicht, deshalb zeigt der Leser
// eine gespeicherte Mail sofort und fragt nicht noch einmal. Bilder brauchen viel Speicher, davon
// weniger.
const messages = new PrefetchCache<MailMessage>({ maxEntries: 40, freshMs: 30 * 60_000 })
const images = new PrefetchCache<MailImages>({ maxEntries: 12, freshMs: 30 * 60_000 })
const NO_IMAGES: MailImages = { images: {}, cids: {} }
const key = (accountId: string, id: string) => `${accountId}|${id}`

export const cachedMail = (accountId: string, id: string): MailMessage | undefined => messages.peek(key(accountId, id))
export const cachedImages = (m: MailMessage): MailImages | undefined => (inlineToLoad(m.attachments).length ? images.peek(key(m.accountId, m.id)) : NO_IMAGES)

export function loadMail(accountId: string, id: string): Promise<MailMessage> {
  const k = key(accountId, id)
  const hit = messages.peek(k)
  return hit ? Promise.resolve(hit) : messages.load(k, () => api.getMail(accountId, id))
}

// Eingebettete Bilder einer geladenen Mail, ohne Inline-Anhänge sofort leer
export function loadImages(m: MailMessage): Promise<MailImages> {
  const ids = inlineToLoad(m.attachments)
  if (!ids.length) return Promise.resolve(NO_IMAGES)
  const k = key(m.accountId, m.id)
  const hit = images.peek(k)
  return hit ? Promise.resolve(hit) : images.load(k, () => api.getMailImages(m.accountId, m.id, ids))
}

// Beim Überfahren in der Liste: Mail und Bilder schon laden, Fehler zeigt erst das Öffnen
export function prefetchMail(accountId: string, id: string): void {
  void loadMail(accountId, id)
    .then(loadImages)
    .catch(() => undefined)
}

// Nach dem Laden der Liste die obersten Mails ohne Bilder vorladen, nacheinander: Exchange drosselt
// schon bei wenigen gleichzeitigen Anfragen je Postfach
export async function prefetchTop(list: { accountId: string; id: string }[]): Promise<void> {
  for (const m of list) {
    if (messages.peek(key(m.accountId, m.id))) continue
    await loadMail(m.accountId, m.id).catch(() => undefined)
  }
}
