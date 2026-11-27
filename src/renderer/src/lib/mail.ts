import type { MailAddress, MailAttachment, MailImages, MailMessage, MailReplyKind, MailSummary } from '@shared/types'

// Empfänger und Betreff für Antworten und Weiterleitungen, wie Outlook sie vorschlägt.
// me: eigene Adressen des Kontos, die bei „Allen antworten“ wegfallen.
export function replyDraft(m: Pick<MailMessage, 'from' | 'to' | 'cc' | 'subject'> & { replyTo?: MailAddress[] }, kind: MailReplyKind, me: string[]): { to: string[]; cc: string[]; subject: string } {
  const mine = new Set(me.map((a) => a.toLowerCase()))
  const seen = new Set<string>()
  const pick = (list: (MailAddress | undefined)[]) => {
    const out: string[] = []
    for (const a of list) {
      const addr = a?.address?.trim()
      if (!addr || mine.has(addr.toLowerCase()) || seen.has(addr.toLowerCase())) continue
      seen.add(addr.toLowerCase())
      out.push(addr)
    }
    return out
  }
  const subject = m.subject === '(Kein Betreff)' ? '' : m.subject
  if (kind === 'forward') return { to: [], cc: [], subject: /^(wg|fw|fwd):/i.test(subject) ? subject : `WG: ${subject}` }
  const re = /^(aw|re):/i.test(subject) ? subject : `AW: ${subject}`
  // Gibt die Mail eine Antwortadresse an, geht die Antwort dorthin statt an den Absender
  const sender = m.replyTo?.length ? m.replyTo : [m.from]
  if (kind === 'reply') {
    // Eigene gesendete Mail beantworten: an die ursprünglichen Empfänger
    const fromMe = !m.replyTo?.length && !!m.from && mine.has(m.from.address.toLowerCase())
    return { to: pick(fromMe ? m.to : sender), cc: [], subject: re }
  }
  const to = pick([...sender, ...m.to])
  return { to, cc: pick(m.cc), subject: re }
}

// Gemeinsamer Posteingang: Seiten aus mehreren Konten nach Eingang sortiert, neueste oben
export function mergeMail(lists: MailSummary[][]): MailSummary[] {
  return lists.flat().sort((a, b) => b.received - a.received)
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`
}

export function addressLabel(a?: MailAddress): string {
  if (!a) return ''
  return a.name || a.address
}

// Eingebettete Bilder, die die App nachlädt: Inline-Anhänge in ihrer Reihenfolge, höchstens 20 und
// zusammen höchstens 8 MB
export const INLINE_BUDGET = 8 * 1024 * 1024
export function inlineToLoad(attachments: MailAttachment[]): string[] {
  const out: string[] = []
  let budget = INLINE_BUDGET
  for (const a of attachments) {
    if (!a.isInline || a.size > budget || out.length >= 20) continue
    out.push(a.id)
    budget -= a.size
  }
  return out
}

// Mail mit nachgeladenen Bildern: Bilder ins HTML, eingebettete Anhänge aus der Liste. Solange die
// Bilder fehlen, fehlen auch die Inline-Anhänge in der Liste, sonst spränge sie. Danach bleibt ein
// Inline-Anhang stehen, wenn das HTML sein Bild nicht nutzt oder es nicht geladen wurde.
export function withImages(m: MailMessage, imgs?: MailImages): MailMessage {
  if (!imgs) return { ...m, attachments: m.attachments.filter((a) => !a.isInline), inlineImages: {} }
  const embedded = new Set(Object.entries(imgs.cids).filter(([, cid]) => m.body.includes(`cid:${cid}`)).map(([id]) => id))
  return { ...m, attachments: m.attachments.filter((a) => !embedded.has(a.id)), inlineImages: imgs.images }
}
