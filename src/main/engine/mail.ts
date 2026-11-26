/* eslint-disable @typescript-eslint/no-explicit-any */
// E-Mail über Microsoft Graph mit dem Graph-Token der Teams-Web-App (Mail.ReadWrite).
// Ohne Electron-Abhängigkeit, damit die Tests die Datei direkt laden.
import type { MailAddress, MailAttachment, MailDraft, MailFile, MailFolder, MailFolderKind, MailMessage, MailSummary } from '@shared/types'
import type { WriteTexts } from './events'

export const GRAPH = 'https://graph.microsoft.com/v1.0'

// Reihenfolge der bekannten Ordner in der Liste
export const WELL_KNOWN: MailFolderKind[] = ['inbox', 'drafts', 'sentitems', 'archive', 'deleteditems', 'junkemail']

const SUMMARY_FIELDS = 'id,conversationId,subject,from,toRecipients,bodyPreview,receivedDateTime,isRead,isDraft,hasAttachments,importance,flag'

export function folderListUrl(): string {
  return `${GRAPH}/me/mailFolders?$top=100&$select=id,displayName,unreadItemCount,totalItemCount`
}

export function wellKnownUrl(kind: MailFolderKind): string {
  return `${GRAPH}/me/mailFolders/${kind}?$select=id,displayName,unreadItemCount,totalItemCount`
}

export function messagesUrl(folderId: string, top = 40): string {
  return `${GRAPH}/me/mailFolders/${encodeURIComponent(folderId)}/messages?$top=${top}&$select=${SUMMARY_FIELDS}&$orderby=receivedDateTime desc`
}

export function messageUrl(id: string): string {
  return `${GRAPH}/me/messages/${encodeURIComponent(id)}?$select=${SUMMARY_FIELDS},ccRecipients,body`
}

export function attachmentsUrl(id: string): string {
  return `${GRAPH}/me/messages/${encodeURIComponent(id)}/attachments?$select=id,name,contentType,size,isInline`
}

export function attachmentUrl(messageId: string, attachmentId: string): string {
  return `${GRAPH}/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
}

// Nächste Seite nur, wenn sie wieder auf Graph zeigt: Die Adresse kommt vom Server und bekommt den Token.
export function isGraphPage(url: string | undefined): url is string {
  if (!url) return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname === 'graph.microsoft.com' && /^\/v1\.0\/me\/mailFolders\/[^/]+\/messages$/.test(u.pathname)
  } catch {
    return false
  }
}

function address(r: any): MailAddress | undefined {
  const a = r?.emailAddress
  if (!a?.address && !a?.name) return undefined
  return { name: a.name || undefined, address: a.address ?? '' }
}

function addresses(list: any): MailAddress[] {
  return Array.isArray(list) ? (list.map(address).filter(Boolean) as MailAddress[]) : []
}

export function mapFolder(f: any, kind?: MailFolderKind): MailFolder {
  return { id: String(f.id), name: String(f.displayName ?? ''), kind, unread: Number(f.unreadItemCount) || 0, total: Number(f.totalItemCount) || 0 }
}

// Bekannte Ordner nach vorn, in fester Reihenfolge, der Rest alphabetisch
export function sortFolders(list: MailFolder[]): MailFolder[] {
  const rank = (f: MailFolder) => (f.kind ? WELL_KNOWN.indexOf(f.kind) : WELL_KNOWN.length)
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'de'))
}

export function mapSummary(m: any, accountId: string): MailSummary {
  const imp = String(m.importance ?? 'normal').toLowerCase()
  return {
    id: String(m.id),
    accountId,
    conversationId: m.conversationId || undefined,
    subject: m.subject || '(Kein Betreff)',
    from: address(m.from),
    to: addresses(m.toRecipients),
    preview: String(m.bodyPreview ?? '').replace(/\s+/g, ' ').trim(),
    received: Date.parse(m.receivedDateTime) || 0,
    isRead: !!m.isRead,
    isDraft: !!m.isDraft,
    hasAttachments: !!m.hasAttachments,
    importance: imp === 'high' || imp === 'low' ? imp : 'normal',
    flagged: m.flag?.flagStatus === 'flagged'
  }
}

export function mapMessage(m: any, accountId: string, attachments: MailAttachment[], inlineImages: Record<string, string>): MailMessage {
  const type = String(m.body?.contentType ?? 'html').toLowerCase() === 'text' ? 'text' : 'html'
  return {
    ...mapSummary(m, accountId),
    cc: addresses(m.ccRecipients),
    bodyType: type,
    body: String(m.body?.content ?? ''),
    attachments,
    inlineImages
  }
}

export function mapAttachment(a: any): MailAttachment {
  return { id: String(a.id), name: a.name || 'Anhang', contentType: a.contentType || undefined, size: Number(a.size) || 0, isInline: !!a.isInline }
}

// Content-ID ohne spitze Klammern, so wie sie im HTML als cid:… steht
export function contentId(raw: unknown): string | undefined {
  const s = typeof raw === 'string' ? raw.trim().replace(/^<|>$/g, '') : ''
  return s || undefined
}

const recipients = (list: string[]) => list.map((address) => ({ emailAddress: { address } }))

// Senden geht in zwei Schritten: Graph legt den Entwurf an (Mail.ReadWrite), verschickt wird er
// über Outlook (dort hat der Token Mail.Send, bei Graph fehlt es). Scheitert das Senden, bleibt
// die Mail unter „Entwürfe“.

// POST /me/messages: neue Mail als Entwurf
export function newDraftBody(d: MailDraft): Record<string, unknown> {
  return { subject: d.subject, body: { contentType: 'HTML', content: textToHtml(d.text) }, toRecipients: recipients(d.to), ccRecipients: recipients(d.cc) }
}

// POST /me/messages/{id}/createReply | createReplyAll | createForward. Graph setzt comment über das
// Zitat der ursprünglichen Nachricht. Die Empfänger gehen so raus, wie die Oberfläche sie zeigt.
export function replyDraftBody(d: MailDraft): Record<string, unknown> {
  return { comment: textToHtml(d.text), message: { toRecipients: recipients(d.to), ccRecipients: recipients(d.cc) } }
}

export const CREATE_REPLY: Record<'reply' | 'replyAll' | 'forward', string> = { reply: 'createReply', replyAll: 'createReplyAll', forward: 'createForward' }

// POST /me/messages/{id}/attachments
export function attachmentBody(f: MailFile): Record<string, unknown> {
  return { '@odata.type': '#microsoft.graph.fileAttachment', name: f.name, contentType: f.contentType || 'application/octet-stream', contentBytes: f.data }
}

export const MAIL_TEXTS: WriteTexts = {
  noToken: 'Nicht gesendet: Die Teams-Web-App hat für dieses Konto noch keinen Zugriff zum Senden angefordert. Die Mail liegt unter „Entwürfe“.',
  failed: 'Nicht gesendet, die Mail liegt unter „Entwürfe“',
  unclear: 'Unklar, ob die Mail gesendet wurde ({errors}). Sieh unter „Gesendete Elemente“ nach, bevor du sie noch einmal schickst.'
}

// Eigener Text aus dem Eingabefeld als HTML: Zeilenumbrüche bleiben, nichts wird als Markup gelesen
export function textToHtml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  return `<div style="font-family: Aptos, Calibri, Helvetica, sans-serif; font-size: 11pt">${esc.replace(/\r?\n/g, '<br>')}</div>`
}

// Höchstens so viel Anhang in einer Anfrage: Graph nimmt bis 4 MB, Base64 macht ein Drittel mehr daraus
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024
