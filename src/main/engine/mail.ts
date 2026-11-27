/* eslint-disable @typescript-eslint/no-explicit-any */
// E-Mail mit den Tokens der Teams-Web-App. Erster Weg ist Microsoft Graph (Mail.ReadWrite), zweiter
// Outlook REST v2.0 (Mail.ReadWrite und Mail.Send): Nicht jede Sitzung der Web-App holt einen
// Graph-Token, und senden darf nur der Outlook-Token. Beide verwenden dieselben IDs.
// Ohne Electron-Abhängigkeit, damit die Tests die Datei direkt laden.
import type { MailAddress, MailAttachment, MailDraft, MailFile, MailFolder, MailFolderKind, MailMessage, MailSummary } from '@shared/types'
import type { WriteTexts } from './events'

export type MailApi = 'graph' | 'outlook'

export const GRAPH = 'https://graph.microsoft.com/v1.0'
export const MAIL_BASE: Record<MailApi, string> = { graph: `${GRAPH}/me`, outlook: 'https://outlook.office.com/api/v2.0/me' }

// Reihenfolge der bekannten Ordner in der Liste
export const WELL_KNOWN: MailFolderKind[] = ['inbox', 'drafts', 'sentitems', 'archive', 'deleteditems', 'junkemail']
const OUTLOOK_FOLDER: Record<MailFolderKind, string> = { inbox: 'Inbox', drafts: 'Drafts', sentitems: 'SentItems', archive: 'Archive', deleteditems: 'DeletedItems', junkemail: 'JunkEmail' }

const SUMMARY = ['id', 'conversationId', 'subject', 'from', 'toRecipients', 'bodyPreview', 'receivedDateTime', 'isRead', 'isDraft', 'hasAttachments', 'importance', 'flag']
const FOLDER = ['id', 'displayName', 'unreadItemCount', 'totalItemCount']

const pascal = (k: string) => k.charAt(0).toUpperCase() + k.slice(1)
const select = (api: MailApi, list: string[]) => (api === 'graph' ? list : list.map(pascal)).join(',')
// Bekannte Ordner heißen bei Outlook Inbox, SentItems …, eigene Ordner haben ihre ID
export const folderName = (api: MailApi, folder: string) => (api === 'outlook' && folder in OUTLOOK_FOLDER ? OUTLOOK_FOLDER[folder as MailFolderKind] : folder)
const folderRef = (api: MailApi, folder: string) => encodeURIComponent(folderName(api, folder))
const folders = (api: MailApi) => (api === 'graph' ? 'mailFolders' : 'MailFolders')

export function folderListUrl(api: MailApi): string {
  return `${MAIL_BASE[api]}/${folders(api)}?$top=100&$select=${select(api, FOLDER)}`
}

export function wellKnownUrl(api: MailApi, kind: MailFolderKind): string {
  return `${MAIL_BASE[api]}/${folders(api)}/${folderRef(api, kind)}?$select=${select(api, FOLDER)}`
}

export function messagesUrl(api: MailApi, folderId: string, top = 40): string {
  return `${MAIL_BASE[api]}/${folders(api)}/${folderRef(api, folderId)}/messages?$top=${top}&$select=${select(api, SUMMARY)}&$orderby=${api === 'graph' ? 'receivedDateTime' : 'ReceivedDateTime'} desc`
}

// Abfrage für den MCP-Server: ein Ordner oder (ohne folder) das ganze Postfach, neueste zuerst.
// Mit search sucht Exchange selbst (KQL, z. B. from:anna subject:Angebot). $search lässt sich nicht
// mit $filter oder $orderby kombinieren, Exchange sortiert die Treffer aber nach Datum. Den Zeitraum
// grenzt dort KQL nach Tagen ein, genau schneidet der Aufrufer danach zu.
export interface MailQuery {
  folder?: string
  search?: string
  since?: number
  until?: number
  unreadOnly?: boolean
  top: number
}

const isoUtc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export function mailQueryUrl(api: MailApi, q: MailQuery): string {
  const p = (k: string) => (api === 'graph' ? k : pascal(k))
  const base = q.folder ? `${MAIL_BASE[api]}/${folders(api)}/${folderRef(api, q.folder)}/messages` : `${MAIL_BASE[api]}/messages`
  const parts = [`$top=${q.top}`, `$select=${select(api, [...SUMMARY, 'parentFolderId'])}`]
  const search = q.search?.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()
  if (search) {
    // Einen Tag Puffer je Seite: KQL rechnet in ganzen Tagen, Ortszeit kann daneben liegen.
    // Die Suchwörter in Klammern, damit ein OR darin den Zeitraum nicht aushebelt.
    const range: string[] = []
    if (q.since) range.push(`received>=${isoDay(q.since - 86_400_000)}`)
    if (q.until) range.push(`received<=${isoDay(q.until + 86_400_000)}`)
    const kql = range.length ? [`(${search})`, ...range].join(' AND ') : search
    parts.push(`$search=${encodeURIComponent(`"${kql}"`)}`)
  } else {
    // Exchange verlangt die Spalte aus $orderby als erste Bedingung im Filter
    const f = [`${p('receivedDateTime')} ge ${isoUtc(q.since ?? Date.UTC(1900, 0, 1))}`]
    // Auf die volle Sekunde aufrunden, sonst fiele bei until 12:00:00.5 die Mail von 12:00:00 weg.
    // Den genauen Schnitt macht der Aufrufer.
    if (q.until) f.push(`${p('receivedDateTime')} lt ${isoUtc(Math.ceil(q.until / 1000) * 1000)}`)
    if (q.unreadOnly) f.push(`${p('isRead')} eq false`)
    parts.push(`$filter=${encodeURIComponent(f.join(' and '))}`, `$orderby=${p('receivedDateTime')} desc`)
  }
  return `${base}?${parts.join('&')}`
}

export function messageUrl(api: MailApi, id: string): string {
  return `${MAIL_BASE[api]}/messages/${encodeURIComponent(id)}?$select=${select(api, [...SUMMARY, 'ccRecipients', 'replyTo', 'body'])}`
}

export function attachmentsUrl(api: MailApi, id: string): string {
  return `${MAIL_BASE[api]}/messages/${encodeURIComponent(id)}/attachments?$select=${select(api, ['id', 'name', 'contentType', 'size', 'isInline'])}`
}

export function attachmentUrl(api: MailApi, messageId: string, attachmentId: string): string {
  return `${MAIL_BASE[api]}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
}

export function messageActionUrl(api: MailApi, id: string, action = ''): string {
  return `${MAIL_BASE[api]}/messages/${encodeURIComponent(id)}${action ? `/${action}` : ''}`
}

// Folgeseite nur, wenn sie wieder auf Graph bzw. Outlook zeigt: Die Adresse kommt vom Server und
// bekommt den Token. Der Ordner steht darin als mailFolders('inbox'), wir fragen mit mailFolders/inbox.
// Ohne Ordner (Suche des MCP-Servers im ganzen Postfach) heißt der Pfad nur …/me/messages.
export function mailPageApi(url: string | undefined): MailApi | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    if (u.origin === 'https://graph.microsoft.com' && /^\/v1\.0\/me(?:\/mailFolders(?:\/[^/()]+|\('[^/']+'\)))?\/messages$/.test(u.pathname)) return 'graph'
    if (u.origin === 'https://outlook.office.com' && /^\/api\/v2\.0\/me(?:\/mailfolders(?:\/[^/()]+|\('[^/']+'\)))?\/messages$/i.test(u.pathname)) return 'outlook'
  } catch {
    /* ungültig */
  }
  return undefined
}

// Outlook antwortet in PascalCase (Subject, EmailAddress …), Graph in camelCase. Die Zuordnung unten
// erwartet camelCase. Schlüssel mit @ (@odata.nextLink) bleiben, wie sie sind.
export function camelize(v: any): any {
  if (Array.isArray(v)) return v.map(camelize)
  if (!v || typeof v !== 'object') return v
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) out[k.startsWith('@') ? k : k.charAt(0).toLowerCase() + k.slice(1)] = camelize(x)
  return out
}

// Anfragen an Outlook brauchen PascalCase, Anhänge dort einen eigenen Typnamen
export function pascalize(v: any): any {
  if (Array.isArray(v)) return v.map(pascalize)
  if (!v || typeof v !== 'object') return v
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) {
    if (k === '@odata.type') out[k] = x === '#microsoft.graph.fileAttachment' ? '#Microsoft.OutlookServices.FileAttachment' : x
    else out[k.startsWith('@') ? k : pascal(k)] = pascalize(x)
  }
  return out
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
    flagged: String(m.flag?.flagStatus ?? '').toLowerCase() === 'flagged',
    folderId: m.parentFolderId || undefined
  }
}

export function mapMessage(m: any, accountId: string, attachments: MailAttachment[], inlineImages: Record<string, string>): MailMessage {
  const type = String(m.body?.contentType ?? 'html').toLowerCase() === 'text' ? 'text' : 'html'
  return {
    ...mapSummary(m, accountId),
    cc: addresses(m.ccRecipients),
    replyTo: addresses(m.replyTo),
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

// POST …/messages/{id}/createReply | createReplyAll | createForward. Graph und Outlook setzen comment
// über das Zitat der ursprünglichen Nachricht. Die Empfänger setzt danach ein PATCH (recipientsPatch),
// so wie die Oberfläche sie zeigt: Antworten legt Outlook nur mit dem Kommentar an. Weiterleiten
// braucht die Empfänger schon beim Anlegen (Graph antwortet sonst mit 400).
export function replyDraftBody(d: MailDraft, kind: 'reply' | 'replyAll' | 'forward'): Record<string, unknown> {
  return { comment: textToHtml(d.text), ...(kind === 'forward' ? { toRecipients: recipients(d.to) } : {}) }
}

export function recipientsPatch(d: MailDraft): Record<string, unknown> {
  return { toRecipients: recipients(d.to), ccRecipients: recipients(d.cc) }
}

export const CREATE_REPLY: Record<MailApi, Record<'reply' | 'replyAll' | 'forward', string>> = {
  graph: { reply: 'createReply', replyAll: 'createReplyAll', forward: 'createForward' },
  outlook: { reply: 'createreply', replyAll: 'createreplyall', forward: 'createforward' }
}

// POST /me/messages/{id}/attachments
export function attachmentBody(f: MailFile): Record<string, unknown> {
  return { '@odata.type': '#microsoft.graph.fileAttachment', name: f.name, contentType: f.contentType || 'application/octet-stream', contentBytes: f.data }
}

export const NO_MAIL_TOKEN =
  'Die Teams-Web-App hat für dieses Konto noch keinen Zugriff auf E-Mails angefordert. Versuche es in ein paar Minuten erneut.'

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

// Jeder Anhang geht in einer eigenen Anfrage an Graph, direkt nur unter 3 MB (größere bräuchten eine Upload-Sitzung)
export const MAX_ATTACHMENT_BYTES = 3_000_000

// ---------- Mail als Text (für den MCP-Server) ----------

const TEXT_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  shy: '',
  zwnj: '',
  zwj: '',
  euro: '€',
  copy: '©',
  reg: '®',
  trade: '™',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  bull: '•',
  middot: '·',
  laquo: '«',
  raquo: '»',
  bdquo: '„',
  ldquo: '“',
  rdquo: '”',
  sbquo: '‚',
  lsquo: '‘',
  rsquo: '’',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  szlig: 'ß',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  deg: '°',
  sect: '§',
  times: '×'
}

function decodeEntities(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isNaN(n) || n > 0x10ffff ? m : String.fromCodePoint(n)
    }
    return TEXT_ENTITIES[e] ?? TEXT_ENTITIES[e.toLowerCase()] ?? m
  })
}

// Outlook schreibt Links in Safe Links um, die eigentliche Adresse steht im Parameter url
export function unwrapSafeLink(href: string): string {
  try {
    const u = new URL(href)
    if (/(^|\.)safelinks\.protection\.outlook\.com$/i.test(u.hostname)) return u.searchParams.get('url') || href
  } catch {
    /* keine absolute Adresse */
  }
  return href
}

function linkText(attrs: string, inner: string): string {
  const raw = attrs.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)')/i)
  const text = inner.trim()
  if (!raw) return inner
  const href = unwrapSafeLink(decodeEntities(raw[2] ?? raw[3] ?? '').trim())
  if (!/^(https?|mailto):/i.test(href)) return inner
  const target = href.replace(/^mailto:/i, '')
  const plain = decodeEntities(text.replace(/<[^>]+>/g, '')).trim()
  if (!plain) return ` ${target} `
  // Steht die Adresse schon im Text (oder der Text ist die Adresse), nicht doppelt
  const same = plain.includes(target) || (plain.length >= 8 && target.includes(plain))
  return same ? inner : `${inner} (${target})`
}

// Mail-HTML als lesbarer Text: ohne Kopf, Styles und Kommentare, Absätze und Tabellenzeilen auf
// eigenen Zeilen, Zellen mit „ | “ getrennt, Links mit Ziel in Klammern. Ein Blockwechsel ist genau
// ein Zeilenumbruch: Outlook schreibt Leerzeilen als eigene Absätze (<p>&nbsp;</p>).
export function mailHtmlToText(html: string): string {
  if (!html) return ''
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title|xml)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_, attrs: string, inner: string) => linkText(attrs, inner))
  // Zeilenumbrüche im Quelltext sind nur Leerraum, außer in <pre>
  s = s.replace(/(<pre\b[^>]*>)([\s\S]*?)(<\/pre\s*>)/gi, (_, a: string, body: string, b: string) => a + body.replace(/\n/g, '<br>') + b)
  s = s
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/<img\b[^>]*\balt\s*=\s*"([^"]+)"[^>]*>/gi, ' $1 ')
  // Absätze direkt in Tabellenzellen (Outlook: <td><p class=MsoNormal>…</p></td>) sind keine
  // eigenen Zeilen, sonst zerfiele jede Tabellenzeile
  for (let i = 0; i < 3; i++) {
    s = s.replace(/(<t[dh]\b[^>]*>)\s*<(?:p|div|span)\b[^>]*>/gi, '$1').replace(/<\/(?:p|div|span)\s*>\s*(<\/t[dh]\s*>)/gi, '$1')
  }
  s = s
    .replace(/<\/t[dh]\s*>/gi, ' | ')
    .replace(/<li\b[^>]*>/gi, '\u0001- ')
    .replace(/<hr\b[^>]*>/gi, '\u0001---\u0001')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/?(p|div|tr|table|tbody|thead|ul|ol|li|h[1-6]|pre|blockquote|section|article|header|footer|center)\b[^>]*>/gi, '\u0001')
    .replace(/<[^>]+>/g, '')
  // Wie im Browser: Ein Blockwechsel bricht nur um, wenn die Zeile schon Text hat, <br> immer.
  // So bleibt <div><br></div> eine Leerzeile, und <div>Text<br></div> wird keine zusätzliche.
  let out = ''
  let hasText = false
  for (const part of s.split(/(\u0001|\n)/)) {
    if (part === '\u0001') {
      if (hasText) out += '\n'
      hasText = false
    } else if (part === '\n') {
      out += '\n'
      hasText = false
    } else {
      out += part
      // &nbsp; und das Zeichen selbst zählen als Text: Outlook schreibt Leerzeilen als <p>&nbsp;</p>
      if (/[^ \t\r]/.test(part)) hasText = true
    }
  }
  return decodeEntities(out)
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').replace(/^\s*\|\s*|\s*\|\s*$/g, '').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
