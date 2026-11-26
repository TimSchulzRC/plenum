import type { MailAddress, MailMessage, MailReplyKind, MailSummary } from '@shared/types'

// Empfänger und Betreff für Antworten und Weiterleitungen, wie Outlook sie vorschlägt.
// me: eigene Adressen des Kontos, die bei „Allen antworten“ wegfallen.
export function replyDraft(m: Pick<MailMessage, 'from' | 'to' | 'cc' | 'subject'>, kind: MailReplyKind, me: string[]): { to: string[]; cc: string[]; subject: string } {
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
  if (kind === 'reply') {
    // Eigene gesendete Mail beantworten: an die ursprünglichen Empfänger
    const fromMe = !!m.from && mine.has(m.from.address.toLowerCase())
    return { to: pick(fromMe ? m.to : [m.from]), cc: [], subject: re }
  }
  const to = pick([m.from, ...m.to])
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
