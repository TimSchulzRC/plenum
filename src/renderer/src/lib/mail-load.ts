import type { MailImages, MailMessage } from '@shared/types'
import { api } from '../api'
import { PrefetchCache } from './cache'

// Geöffnete und vorgeladene Mails. Der Inhalt einer gesendeten oder empfangenen Mail ändert sich
// nicht, deshalb zeigt der Leser eine gespeicherte Mail sofort. Entwürfe nie: Die kann man in
// Outlook weiter bearbeiten. Die Bilder hält der Hauptprozess (tmimg://mailcid).
const messages = new PrefetchCache<MailMessage>({ maxEntries: 40, freshMs: 30 * 60_000 })
const key = (accountId: string, id: string) => `${accountId}|${id}`

export const cachedMail = (accountId: string, id: string): MailMessage | undefined => messages.peek(key(accountId, id))

// background: nur vorgeladen, die geöffnete Mail geht im Postfach vor. fresh: nicht aus dem Speicher
// und nicht hinein (Entwürfe).
export function loadMail(accountId: string, id: string, opts: { background?: boolean; fresh?: boolean } = {}): Promise<MailMessage> {
  if (opts.fresh) return api.getMail(accountId, id, opts.background)
  const k = key(accountId, id)
  const hit = messages.peek(k)
  return hit ? Promise.resolve(hit) : messages.load(k, () => api.getMail(accountId, id, opts.background))
}

// Welche Inline-Anhänge eingebettete Bilder sind, damit die Liste sie weglässt. Die Bilder selbst
// lädt das Dokument der Mail über tmimg://mailcid.
export async function loadImageIndex(m: MailMessage): Promise<MailImages> {
  if (!m.attachments.some((a) => a.isInline)) return { images: {}, cids: {} }
  return { images: {}, cids: await api.getMailImageIndex(m.accountId, m.id) }
}

// Bilder als data:-URL, für die eigene Signatur (Logo)
export function loadImages(m: MailMessage): Promise<MailImages> {
  if (!m.attachments.some((a) => a.isInline)) return Promise.resolve({ images: {}, cids: {} })
  return api.getMailImages(m.accountId, m.id)
}

// Beim Überfahren in der Liste: Mail und Bilder schon laden, hinter geöffneten Mails. Fehler zeigt
// erst das Öffnen. Entwürfe nicht.
export function prefetchMail(m: { accountId: string; id: string; isDraft: boolean }): void {
  if (m.isDraft) return
  void loadMail(m.accountId, m.id, { background: true })
    .then((x) => {
      if (x.attachments.some((a) => a.isInline)) void api.prefetchMailImages(x.accountId, x.id)
    })
    .catch(() => undefined)
}

// Nach dem Laden der Liste die obersten Mails ohne Bilder vorladen, nacheinander und hinter allem,
// was der Nutzer öffnet
export async function prefetchTop(list: { accountId: string; id: string; isDraft: boolean }[]): Promise<void> {
  for (const m of list) {
    if (m.isDraft || messages.peek(key(m.accountId, m.id))) continue
    await loadMail(m.accountId, m.id, { background: true }).catch(() => undefined)
  }
}
