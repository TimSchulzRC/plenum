// Werkzeuge des lokalen MCP-Servers. Alle lesen nur. Die Daten kommen über McpAccount aus den
// laufenden Konten (siehe source.ts). Ohne Electron-Abhängigkeiten, damit `pnpm test` die
// Werkzeuge mit Testkonten prüfen kann.
import type {
  AccountInfo,
  ActivityItem,
  CalendarEvent,
  CallLogEntry,
  ChatSummary,
  MailAddress,
  MailFolder,
  MailFolderKind,
  MailMessage,
  MailSummary,
  Message,
  Person,
  Team
} from '@shared/types'
import type { MailQuery } from '../engine/mail'
import type { ToolDef, ToolResult } from './protocol'

export interface Page<T> {
  items: T[]
  // URL der nächstälteren Seite, wie sie der Chat-Dienst liefert
  older?: string
}

export interface Download {
  data: Uint8Array
  contentType: string
}

// Ein Konto aus Sicht des MCP-Servers.
export interface McpAccount {
  id: string
  info(): AccountInfo
  chats(): ChatSummary[]
  teams(): Team[]
  name(mri: string): string | undefined
  // Neueste zuerst oder in beliebiger Reihenfolge; older ist die Adresse der älteren Seite
  messages(conversationId: string, pageSize: number, older?: string): Promise<Page<Message>>
  callLog(pageSize: number, older?: string): Promise<Page<CallLogEntry>>
  activity(): Promise<ActivityItem[]>
  calendar(start: number, end: number): Promise<CalendarEvent[]>
  searchPeople(query: string): Promise<Person[]>
  download(url: string): Promise<Download>
  // E-Mail über Graph oder Outlook REST (engine/mail.ts). hasMail ist false, solange die Web-App
  // noch keinen Token dafür angefordert hat.
  hasMail(): boolean
  mailFolders(): Promise<MailFolder[]>
  mailQuery(q: MailQuery): Promise<MailSummary[]>
  mail(id: string): Promise<McpMail>
  mailAttachment(messageId: string, attachmentId: string): Promise<{ name: string; contentType?: string; data: Uint8Array }>
}

// Eine Mail für den Agenten: der Text schon als Klartext (HTML umgewandelt in source.ts)
export type McpMail = Omit<MailMessage, 'bodyType' | 'body' | 'inlineImages'> & { text: string }

export interface ToolDeps {
  accounts(): McpAccount[]
  // Legt eine heruntergeladene Datei lokal ab und gibt den Pfad zurück
  saveFile(name: string, data: Uint8Array): Promise<string>
  now?(): number
}

// Fehler, dessen Meldung so an den Agenten geht.
export class ToolError extends Error {
  readonly expected = true
}

const DAY = 86_400_000
const MAX_TEXT = 4000
const MAX_INLINE_IMAGE = 4 * 1024 * 1024
const MAX_INLINE_TEXT = 200_000
const MAX_MAIL_TEXT = 20_000

// ---------- Hilfen ----------

const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0')

// Ortszeit mit Versatz, z. B. 2026-11-25T14:03:00+01:00
export function localIso(ms: number | undefined): string | undefined {
  if (!ms) return undefined
  const d = new Date(ms)
  const off = -d.getTimezoneOffset()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`
}

// Datum (Ortszeit, Tagesbeginn) oder Zeitpunkt nach ISO 8601
export function parseTime(v: unknown, field: string): number | undefined {
  if (v == null || v === '') return undefined
  const s = String(v).trim()
  const d = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (d) return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])).getTime()
  const t = Date.parse(s)
  if (Number.isNaN(t)) throw new ToolError(`${field}: „${s}“ ist kein Datum. Erwartet wird z. B. 2026-11-25 oder 2026-11-25T14:00:00+01:00.`)
  return t
}

function int(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.floor(n)))
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)} … [gekürzt, ${s.length} Zeichen]` : s
}

function words(q: string | undefined): string[] {
  return (q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
}

function matchesAll(haystack: string, ws: string[]): boolean {
  const h = haystack.toLowerCase()
  return ws.every((w) => h.includes(w))
}

// Cursor für ältere Seiten: Adresse des Chat-Dienstes, gebunden an die Unterhaltung
export function encodeCursor(conversationId: string, url: string): string {
  return Buffer.from(JSON.stringify({ c: conversationId, u: url })).toString('base64url')
}

export function decodeCursor(cursor: string, conversationId: string): string {
  try {
    const o = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (o?.c === conversationId && typeof o.u === 'string') return o.u
  } catch {
    /* unten */
  }
  throw new ToolError('cursor passt nicht zu dieser Unterhaltung. Nimm next_cursor aus der letzten Antwort für dieselbe conversation_id.')
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker))
  return out
}

// Bilder im Nachrichtentext liegen im Async Media Service von Teams
const AMS_HOST = /(^|\.)(asm\.skype\.com|asyncgw\.teams\.microsoft\.com)$|\.ams\./
export function imageUrls(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/<img\b[^>]*?\bsrc="([^"]+)"/gi)) {
    const src = m[1].replace(/&amp;/g, '&')
    try {
      if (AMS_HOST.test(new URL(src).hostname)) out.push(src)
    } catch {
      /* keine URL */
    }
  }
  return [...new Set(out)]
}

// ---------- Konten ----------

function label(a: McpAccount): string {
  const i = a.info()
  return i.upn || i.label
}

function resolveAccounts(deps: ToolDeps, arg: unknown): McpAccount[] {
  const all = deps.accounts()
  if (all.length === 0) throw new ToolError('In Plenum ist kein Konto angemeldet.')
  const q = str(arg)?.toLowerCase()
  if (!q) return all
  const exact = all.filter((a) => {
    const i = a.info()
    return a.id.toLowerCase() === q || i.upn?.toLowerCase() === q
  })
  if (exact.length) return exact
  const loose = all.filter((a) => {
    const i = a.info()
    return [i.label, i.displayName, i.upn, i.tenantName].some((s) => s?.toLowerCase().includes(q))
  })
  if (loose.length === 1) return loose
  const list = all.map((a) => `${label(a)} (id ${a.id})`).join(', ')
  if (loose.length > 1) throw new ToolError(`„${arg}“ passt auf mehrere Konten: ${loose.map(label).join(', ')}. Nimm die E-Mail-Adresse oder die id.`)
  throw new ToolError(`Kein Konto passt auf „${arg}“. Vorhanden: ${list}.`)
}

function readyAccounts(deps: ToolDeps, arg: unknown): { ready: McpAccount[]; warnings: string[] } {
  const ready: McpAccount[] = []
  const warnings: string[] = []
  for (const a of resolveAccounts(deps, arg)) {
    const i = a.info()
    if (i.status === 'ready') ready.push(a)
    else warnings.push(`${label(a)}: nicht verbunden (${i.status}${i.statusDetail ? `, ${i.statusDetail}` : ''})`)
  }
  if (ready.length === 0) throw new ToolError(`Kein passendes Konto ist verbunden. ${warnings.join('; ')}`)
  return { ready, warnings }
}

function baseId(conversationId: string): string {
  return conversationId.replace(/;messageid=\d+$/, '')
}

function knows(a: McpAccount, conversationId: string): boolean {
  const id = baseId(conversationId)
  return a.chats().some((c) => c.id === id) || a.teams().some((t) => t.channels.some((c) => c.id === id))
}

function accountFor(deps: ToolDeps, conversationId: string, arg: unknown): McpAccount {
  const { ready } = readyAccounts(deps, arg)
  const found = ready.filter((a) => knows(a, conversationId))
  if (found.length) return found[0]
  if (ready.length === 1) return ready[0]
  throw new ToolError(`Die Unterhaltung ${conversationId} ist in keinem Konto bekannt. Gib account an.`)
}

// ---------- Unterhaltungen ----------

interface ConvRef {
  account: McpAccount
  id: string
  kind: string
  title: string
  team?: string
  members?: string[]
  lastActivity: number
  unread: boolean
  lastMessage?: ChatSummary['lastMessage']
}

function conversations(a: McpAccount): ConvRef[] {
  const out: ConvRef[] = []
  for (const c of a.chats()) {
    if (c.kind === 'channel' || c.kind === 'system' || c.hidden) continue
    const members = c.members.map((m) => c.memberNames?.[m] || a.name(m) || '').filter(Boolean)
    out.push({ account: a, id: c.id, kind: c.kind, title: c.title, members, lastActivity: c.lastActivity, unread: c.unread, lastMessage: c.lastMessage })
  }
  for (const t of a.teams()) {
    for (const ch of t.channels) {
      out.push({ account: a, id: ch.id, kind: 'channel', title: `${t.displayName} › ${ch.displayName}`, team: t.displayName, lastActivity: ch.lastActivity ?? 0, unread: ch.unread })
    }
  }
  return out
}

function titleOf(a: McpAccount, conversationId: string): { title?: string; kind?: string } {
  const c = conversations(a).find((x) => x.id === baseId(conversationId))
  return { title: c?.title, kind: c?.kind }
}

const KINDS = ['all', 'chat', 'oneOnOne', 'group', 'meeting', 'channel', 'self']

function kindMatches(kind: string, filter: string): boolean {
  if (filter === 'all') return true
  if (filter === 'chat') return kind !== 'channel'
  return kind === filter
}

// ---------- Nachrichten ----------

function formatMessage(m: Message, a: McpAccount): Record<string, unknown> {
  const o: Record<string, unknown> = { id: m.id, time: localIso(m.time), from: m.fromName || a.name(m.from) || m.from || undefined }
  if (m.isMine) o.mine = true
  if (m.parentId && m.parentId !== m.id) o.reply_to = m.parentId
  if (m.kind === 'deleted') return { ...o, deleted: true }
  if (m.kind === 'system' || m.kind === 'call') return { ...o, event: m.systemText || m.kind }
  if (m.subject) o.subject = m.subject
  o.text = clip(m.text, MAX_TEXT)
  if (m.importance) o.importance = m.importance
  if (m.editedTime) o.edited = localIso(m.editedTime)
  if (m.attachments.length) o.files = m.attachments.map((f) => ({ name: f.name, type: f.fileType, size: f.size, url: f.url }))
  const images = imageUrls(m.html)
  if (images.length) o.images = images
  if (m.reactions.length) o.reactions = m.reactions.map((r) => ({ reaction: r.key, by: r.users.map((u) => a.name(u.mri) || u.mri) }))
  return o
}

// Seiten des Chat-Dienstes holen, bis limit Nachrichten da sind oder since erreicht ist.
async function readMessages(
  a: McpAccount,
  conversationId: string,
  opts: { limit: number; since?: number; older?: string; maxPages?: number }
): Promise<{ messages: Message[]; older?: string }> {
  const out: Message[] = []
  let older = opts.older
  let first = true
  for (let page = 0; page < (opts.maxPages ?? 50) && out.length < opts.limit; page++) {
    if (!first && !older) break
    first = false
    const want = Math.min(200, opts.limit - out.length)
    const res = await a.messages(conversationId, want, older)
    older = res.older
    let reachedSince = false
    for (const m of res.items) {
      if (opts.since && m.time && m.time < opts.since) reachedSince = true
      else out.push(m)
    }
    if (reachedSince) {
      older = undefined
      break
    }
    if (res.items.length === 0) break
  }
  out.sort((x, y) => y.time - x.time || Number(y.id) - Number(x.id))
  return { messages: out.slice(0, opts.limit), older }
}

interface ScanOpts {
  accountArg: unknown
  conversationId?: string
  since: number
  until?: number
  maxConversations: number
  kind: string
}

interface ScanResult {
  found: { account: McpAccount; conv: { id: string; title: string; kind: string }; messages: Message[] }[]
  scanned: number
  skipped: number
  errors: string[]
  warnings: string[]
}

// Liest die Nachrichten der zuletzt aktiven Unterhaltungen ab since. Grundlage für Suche und Dateiliste.
async function scan(deps: ToolDeps, o: ScanOpts): Promise<ScanResult> {
  let targets: { account: McpAccount; id: string; title: string; kind: string }[]
  let warnings: string[] = []
  if (o.conversationId) {
    const a = accountFor(deps, o.conversationId, o.accountArg)
    const t = titleOf(a, o.conversationId)
    targets = [{ account: a, id: o.conversationId, title: t.title ?? o.conversationId, kind: t.kind ?? 'unknown' }]
  } else {
    const r = readyAccounts(deps, o.accountArg)
    warnings = r.warnings
    // Kanäle ohne bekannte letzte Aktivität zählen mit, landen aber hinten
    targets = r.ready
      .flatMap(conversations)
      .filter((c) => kindMatches(c.kind, o.kind) && (c.lastActivity === 0 || c.lastActivity >= o.since))
      .sort((x, y) => y.lastActivity - x.lastActivity)
      .map((c) => ({ account: c.account, id: c.id, title: c.title, kind: c.kind }))
  }
  const chosen = targets.slice(0, o.maxConversations)
  const errors: string[] = []
  const found = await pool(chosen, 4, async (t) => {
    try {
      const { messages } = await readMessages(t.account, t.id, { limit: 1000, since: o.since, maxPages: 5 })
      return { account: t.account, conv: { id: t.id, title: t.title, kind: t.kind }, messages: messages.filter((m) => !o.until || m.time <= o.until) }
    } catch (e) {
      if (errors.length < 5) errors.push(`${t.title}: ${(e as Error).message}`)
      return { account: t.account, conv: { id: t.id, title: t.title, kind: t.kind }, messages: [] }
    }
  })
  return { found, scanned: chosen.length, skipped: targets.length - chosen.length, errors, warnings }
}

// ---------- Dateien ----------

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|log|ya?ml|ini|cfg|conf|sql|js|ts|tsx|jsx|py|java|cs|go|rs|rb|php|sh|bat|ps1|css|svg|eml|vtt|srt)$/i

function isText(type: string, name: string): boolean {
  return /^text\/|json|xml|javascript|csv|yaml|x-sh/i.test(type) || TEXT_EXT.test(name)
}

function fileNameFrom(url: string): string {
  try {
    const u = new URL(url)
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '')
    if (/\/views\/(imgo|imgpsh|imgpsh_fullsize)/.test(u.pathname)) return 'bild'
    return last || 'datei'
  } catch {
    return 'datei'
  }
}

function extFor(type: string): string {
  const m: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'application/pdf': '.pdf' }
  return m[type.split(';')[0].trim().toLowerCase()] ?? ''
}

// Datei lokal ablegen und so zurückgeben, wie der Agent sie am besten liest: Text direkt, Bilder als
// Bild, alles andere als Pfad.
async function fileResult(deps: ToolDeps, rawName: string, contentType: string, data: Uint8Array, extra: Record<string, unknown> = {}): Promise<ToolResult> {
  const type = contentType.split(';')[0].trim().toLowerCase() || 'application/octet-stream'
  let name = rawName.replace(/[/\\:]/g, '_')
  if (!/\.[a-z0-9]{1,6}$/i.test(name)) name += extFor(type)
  const path = await deps.saveFile(name, data)
  const info = { ...extra, name, type, size: data.byteLength, saved_to: path }
  if (type.startsWith('image/') && type !== 'image/svg+xml' && data.byteLength <= MAX_INLINE_IMAGE) {
    return {
      content: [
        { type: 'text', text: JSON.stringify(info) },
        { type: 'image', data: Buffer.from(data).toString('base64'), mimeType: type }
      ]
    }
  }
  if (isText(type, name)) {
    const text = new TextDecoder('utf-8').decode(data)
    return { content: [{ type: 'text', text: JSON.stringify({ ...info, text: clip(text, MAX_INLINE_TEXT) }) }] }
  }
  return { content: [{ type: 'text', text: JSON.stringify({ ...info, note: 'Binärdatei. Den Inhalt unter saved_to mit einem passenden Werkzeug lesen.' }) }] }
}

// ---------- E-Mail ----------

const MAIL_ALL = ['all', 'alle', '*']
// Standardordner, wie sie Graph in der Adresse versteht (engine/mail.ts übersetzt für Outlook)
const MAIL_KINDS: MailFolderKind[] = ['inbox', 'drafts', 'sentitems', 'archive', 'deleteditems', 'junkemail']

function addr(a: MailAddress | undefined): string | undefined {
  if (!a) return undefined
  if (!a.address) return a.name
  return a.name && a.name.toLowerCase() !== a.address.toLowerCase() ? `${a.name} <${a.address}>` : a.address
}

function addrs(list: MailAddress[], max = 20): string[] | undefined {
  if (!list.length) return undefined
  const out = list.slice(0, max).map(addr).filter((x): x is string => !!x)
  if (list.length > max) out.push(`… ${list.length - max} weitere`)
  return out
}

// Konten, deren Postfach erreichbar ist. Ohne Mail-Token gibt es nur einen Hinweis.
function mailAccounts(deps: ToolDeps, arg: unknown): { ready: McpAccount[]; warnings: string[] } {
  const r = readyAccounts(deps, arg)
  const ready = r.ready.filter((a) => a.hasMail())
  const warnings = [
    ...r.warnings,
    ...r.ready.filter((a) => !a.hasMail()).map((a) => `${label(a)}: Die Teams-Web-App hat für dieses Konto noch keinen Zugriff auf E-Mails angefordert`)
  ]
  if (ready.length === 0) throw new ToolError(`Kein passendes Konto hat Zugriff auf E-Mails. ${warnings.join('; ')}. In ein paar Minuten erneut versuchen.`)
  return { ready, warnings }
}

// Ordner als Standardname (inbox, sentitems …), id oder Anzeigename. undefined heißt ganzes Postfach.
function resolveFolder(arg: string | undefined, folders: MailFolder[]): { id?: string; name?: string } | string {
  if (!arg || MAIL_ALL.includes(arg.toLowerCase())) return {}
  const q = arg.toLowerCase()
  const kind = MAIL_KINDS.find((k) => k === q)
  if (kind) return { id: kind, name: folders.find((f) => f.kind === kind)?.name ?? kind }
  const byId = folders.find((f) => f.id === arg)
  if (byId) return { id: byId.id, name: byId.name }
  const exact = folders.filter((f) => f.name.toLowerCase() === q)
  const loose = exact.length ? exact : folders.filter((f) => f.name.toLowerCase().includes(q))
  if (loose.length === 1) return { id: loose[0].id, name: loose[0].name }
  if (loose.length > 1) return `„${arg}“ passt auf mehrere Ordner: ${loose.map((f) => f.name).join(', ')}`
  return `Kein Ordner „${arg}“. Vorhanden: ${folders.map((f) => f.name).join(', ')}`
}

function formatMailSummary(m: MailSummary, a: McpAccount, folderName?: string): Record<string, unknown> {
  return {
    message_id: m.id,
    account: label(a),
    folder: folderName,
    received: localIso(m.received),
    from: addr(m.from),
    to: addrs(m.to, 10),
    subject: m.subject,
    preview: m.preview ? clip(m.preview, 300) : undefined,
    unread: !m.isRead || undefined,
    attachments: m.hasAttachments || undefined,
    importance: m.importance !== 'normal' ? m.importance : undefined,
    flagged: m.flagged || undefined,
    draft: m.isDraft || undefined
  }
}

interface MailRun {
  query?: string
  folderArg?: string
  since?: number
  until?: number
  unreadOnly: boolean
  limit: number
}

// Fragt die Konten nacheinander je Postfach (Exchange drosselt bei vielen gleichzeitigen Anfragen)
// und führt die Treffer zusammen, neueste zuerst.
async function runMailQuery(deps: ToolDeps, accountArg: unknown, o: MailRun): Promise<Record<string, unknown>> {
  const { ready, warnings } = mailAccounts(deps, accountArg)
  const errors: string[] = []
  let full = false
  const lists = await pool(ready, 2, async (a) => {
    try {
      const folders = await a.mailFolders().catch(() => [] as MailFolder[])
      const folder = resolveFolder(o.folderArg, folders)
      if (typeof folder === 'string') {
        errors.push(`${label(a)}: ${folder}`)
        return []
      }
      const items = await a.mailQuery({ folder: folder.id, search: o.query, since: o.since, until: o.until, unreadOnly: o.unreadOnly, top: o.limit })
      if (items.length >= o.limit) full = true
      const names = new Map(folders.map((f) => [f.id, f.name]))
      return items
        .filter((m) => (!o.since || m.received >= o.since) && (!o.until || m.received < o.until) && (!o.unreadOnly || !m.isRead))
        .map((m) => ({ m, a, folder: folder.name ?? (m.folderId ? names.get(m.folderId) : undefined) }))
    } catch (e) {
      errors.push(`${label(a)}: ${(e as Error).message}`)
      return []
    }
  })
  const all = lists.flat().sort((x, y) => y.m.received - x.m.received)
  const shown = all.slice(0, o.limit)
  const more = full || all.length > o.limit
  return {
    mails: shown.map(({ m, a, folder }) => formatMailSummary(m, a, folder)),
    more: more || undefined,
    next_until: more && shown.length ? localIso(shown[shown.length - 1].m.received) : undefined,
    errors: errors.length ? errors : undefined,
    warnings: warnings.length ? warnings : undefined
  }
}

// Mail-IDs gelten nur im eigenen Postfach. Ohne account der Reihe nach probieren.
async function findMail<T>(deps: ToolDeps, accountArg: unknown, fn: (a: McpAccount) => Promise<T>): Promise<{ a: McpAccount; value: T }> {
  const { ready } = mailAccounts(deps, accountArg)
  let last: unknown
  for (const a of ready) {
    try {
      return { a, value: await fn(a) }
    } catch (e) {
      last = e
      const status = (e as { status?: number }).status
      if (ready.length === 1 || (status !== 400 && status !== 404)) throw e
    }
  }
  throw new ToolError(`Die Mail ist in keinem Konto zu finden (${(last as Error)?.message ?? 'unbekannt'}). Gib account aus list_mail an.`)
}

// ---------- Schemas ----------

const ACCOUNT_PROP = {
  type: 'string',
  description: 'Konto als E-Mail-Adresse, Name oder id aus list_accounts. Ohne Angabe: alle Konten.'
}

function schema(props: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties: props, required, additionalProperties: false }
}

// ---------- Werkzeuge ----------

export function createTools(deps: ToolDeps): ToolDef[] {
  const now = () => deps.now?.() ?? Date.now()

  const tools: ToolDef[] = [
    {
      name: 'list_accounts',
      title: 'Konten',
      description: 'Listet alle in Plenum angemeldeten Teams-Konten mit Name, E-Mail, Organisation, Verbindungsstatus und Zahl ungelesener Chats.',
      inputSchema: schema({}),
      run: async () => ({
        accounts: deps.accounts().map((a) => {
          const i = a.info()
          return {
            id: a.id,
            name: i.displayName || i.label,
            email: i.upn,
            organization: i.tenantName,
            status: i.status,
            unread_chats: i.unread,
            teams_with_unread: i.teamsUnread,
            unread_activity: i.activityUnread
          }
        })
      })
    },
    {
      name: 'list_conversations',
      title: 'Chats und Kanäle',
      description:
        'Listet Chats (1:1, Gruppe, Besprechung) und Teams-Kanäle, die zuletzt aktiven zuerst, mit letzter Nachricht und Ungelesen-Status. Die conversation_id brauchst du für get_messages, search_messages und list_files.',
      inputSchema: schema({
        account: ACCOUNT_PROP,
        query: { type: 'string', description: 'Filter auf Titel, Kanal- oder Teamname und Namen der Mitglieder' },
        kind: { type: 'string', enum: KINDS, description: 'chat = alle Chats ohne Kanäle. Standard: all' },
        unread_only: { type: 'boolean', description: 'Nur ungelesene' },
        since: { type: 'string', description: 'Nur mit Aktivität ab diesem Datum (ISO 8601)' },
        limit: { type: 'integer', minimum: 1, maximum: 300, description: 'Standard 30' }
      }),
      run: async (args) => {
        const { ready, warnings } = readyAccounts(deps, args.account)
        const kind = KINDS.includes(String(args.kind)) ? String(args.kind) : 'all'
        const ws = words(str(args.query))
        const since = parseTime(args.since, 'since')
        const limit = int(args.limit, 30, 1, 300)
        const all = ready
          .flatMap(conversations)
          .filter((c) => kindMatches(c.kind, kind))
          .filter((c) => !args.unread_only || c.unread)
          .filter((c) => !since || c.lastActivity >= since)
          .filter((c) => ws.length === 0 || matchesAll([c.title, c.team ?? '', ...(c.members ?? [])].join(' '), ws))
          .sort((x, y) => y.lastActivity - x.lastActivity)
        return {
          total: all.length,
          conversations: all.slice(0, limit).map((c) => ({
            conversation_id: c.id,
            account: label(c.account),
            kind: c.kind,
            title: c.title,
            members: c.members && c.members.length > 20 ? [...c.members.slice(0, 20), `… ${c.members.length - 20} weitere`] : c.members,
            unread: c.unread,
            last_activity: localIso(c.lastActivity),
            last_message: c.lastMessage ? { from: c.lastMessage.fromName, text: clip(c.lastMessage.text, 300), time: localIso(c.lastMessage.time) } : undefined
          })),
          warnings: warnings.length ? warnings : undefined
        }
      }
    },
    {
      name: 'list_teams',
      title: 'Teams und Kanäle',
      description: 'Listet die Teams mit ihren Kanälen. Die conversation_id eines Kanals geht an get_messages.',
      inputSchema: schema({ account: ACCOUNT_PROP }),
      run: async (args) => {
        const { ready, warnings } = readyAccounts(deps, args.account)
        return {
          teams: ready.flatMap((a) =>
            a.teams().map((t) => ({
              account: label(a),
              team: t.displayName,
              team_id: t.id,
              description: t.description || undefined,
              archived: t.isArchived || undefined,
              channels: t.channels.map((c) => ({ conversation_id: c.id, name: c.displayName, unread: c.unread, last_activity: localIso(c.lastActivity) }))
            }))
          ),
          warnings: warnings.length ? warnings : undefined
        }
      }
    },
    {
      name: 'get_messages',
      title: 'Nachrichten lesen',
      description:
        'Liest die Nachrichten eines Chats oder Kanals, die neuesten zuerst abgerufen und alt nach neu sortiert. In Kanälen stehen Antworten mit reply_to (id des Beitrags). Für ältere Nachrichten next_cursor als cursor übergeben. Dateien und Bilder stehen unter files und images, ihr Inhalt kommt über read_file.',
      inputSchema: schema(
        {
          conversation_id: { type: 'string', description: 'Aus list_conversations oder list_teams' },
          thread_id: { type: 'string', description: 'Nur die Antworten auf diesen Kanalbeitrag (id des Beitrags)' },
          account: { type: 'string', description: 'Nur nötig, wenn die Unterhaltung in keinem Konto bekannt ist' },
          limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Standard 50' },
          since: { type: 'string', description: 'Nur Nachrichten ab diesem Zeitpunkt (ISO 8601)' },
          cursor: { type: 'string', description: 'next_cursor aus der vorigen Antwort' }
        },
        ['conversation_id']
      ),
      run: async (args) => {
        const conv = str(args.conversation_id)
        if (!conv) throw new ToolError('conversation_id fehlt')
        const thread = str(args.thread_id)
        const target = thread ? `${baseId(conv)};messageid=${thread}` : conv
        const a = accountFor(deps, conv, args.account)
        const older = str(args.cursor) ? decodeCursor(String(args.cursor), target) : undefined
        const { messages, older: next } = await readMessages(a, target, { limit: int(args.limit, 50, 1, 500), since: parseTime(args.since, 'since'), older })
        const t = titleOf(a, conv)
        return {
          conversation: { conversation_id: conv, title: t.title, kind: t.kind, account: label(a) },
          messages: messages.reverse().map((m) => formatMessage(m, a)),
          next_cursor: next ? encodeCursor(target, next) : undefined
        }
      }
    },
    {
      name: 'search_messages',
      title: 'Nachrichten durchsuchen',
      description:
        'Durchsucht die Nachrichten der zuletzt aktiven Chats und Kanäle nach Wörtern (alle müssen vorkommen, auch in Absender und Dateinamen). Die Suche liest die Nachrichten ab since, Standard die letzten 30 Tage, in höchstens max_conversations Unterhaltungen. Für ältere Treffer since früher setzen oder conversation_id angeben.',
      inputSchema: schema({
        query: { type: 'string', description: 'Suchwörter. Leer lassen, um nur nach from zu filtern.' },
        from: { type: 'string', description: 'Nur Nachrichten dieses Absenders (Teil des Namens)' },
        account: ACCOUNT_PROP,
        conversation_id: { type: 'string', description: 'Nur in dieser Unterhaltung suchen' },
        kind: { type: 'string', enum: KINDS, description: 'Art der Unterhaltungen. Standard: all' },
        since: { type: 'string', description: 'Ab diesem Datum (ISO 8601). Standard: vor 30 Tagen' },
        until: { type: 'string', description: 'Bis zu diesem Zeitpunkt (ISO 8601)' },
        max_conversations: { type: 'integer', minimum: 1, maximum: 150, description: 'Standard 40' },
        limit: { type: 'integer', minimum: 1, maximum: 300, description: 'Höchstzahl Treffer, Standard 50' }
      }),
      run: async (args) => {
        const ws = words(str(args.query))
        const from = str(args.from)?.toLowerCase()
        if (ws.length === 0 && !from) throw new ToolError('query oder from angeben')
        const since = parseTime(args.since, 'since') ?? now() - 30 * DAY
        const res = await scan(deps, {
          accountArg: args.account,
          conversationId: str(args.conversation_id),
          since,
          until: parseTime(args.until, 'until'),
          maxConversations: int(args.max_conversations, 40, 1, 150),
          kind: KINDS.includes(String(args.kind)) ? String(args.kind) : 'all'
        })
        const hits: { time: number; out: Record<string, unknown> }[] = []
        for (const f of res.found) {
          for (const m of f.messages) {
            if (m.kind !== 'text' && m.kind !== 'card') continue
            const sender = m.fromName || f.account.name(m.from) || ''
            if (from && !sender.toLowerCase().includes(from) && m.from.toLowerCase() !== from) continue
            if (ws.length && !matchesAll([m.subject ?? '', m.text, sender, ...m.attachments.map((x) => x.name)].join(' '), ws)) continue
            hits.push({
              time: m.time,
              out: { conversation_id: f.conv.id, conversation: f.conv.title, kind: f.conv.kind, account: label(f.account), ...formatMessage(m, f.account) }
            })
          }
        }
        hits.sort((x, y) => y.time - x.time)
        const limit = int(args.limit, 50, 1, 300)
        return {
          total_hits: hits.length,
          hits: hits.slice(0, limit).map((h) => h.out),
          searched: { since: localIso(since), conversations: res.scanned, not_searched: res.skipped || undefined },
          errors: res.errors.length ? res.errors : undefined,
          warnings: res.warnings.length ? res.warnings : undefined
        }
      }
    },
    {
      name: 'list_files',
      title: 'Geteilte Dateien',
      description:
        'Listet Dateien und Bilder, die in Chats und Kanälen geteilt wurden, die neuesten zuerst. Liest wie search_messages die Nachrichten ab since (Standard 30 Tage) in den zuletzt aktiven Unterhaltungen. Den Inhalt einer Datei liefert read_file mit der url.',
      inputSchema: schema({
        query: { type: 'string', description: 'Filter auf den Dateinamen' },
        account: ACCOUNT_PROP,
        conversation_id: { type: 'string', description: 'Nur aus dieser Unterhaltung' },
        include_images: { type: 'boolean', description: 'Auch eingefügte Bilder. Standard: true' },
        since: { type: 'string', description: 'Ab diesem Datum (ISO 8601). Standard: vor 30 Tagen' },
        max_conversations: { type: 'integer', minimum: 1, maximum: 150, description: 'Standard 40' },
        limit: { type: 'integer', minimum: 1, maximum: 300, description: 'Standard 50' }
      }),
      run: async (args) => {
        const ws = words(str(args.query))
        const images = args.include_images !== false && ws.length === 0
        const since = parseTime(args.since, 'since') ?? now() - 30 * DAY
        const res = await scan(deps, {
          accountArg: args.account,
          conversationId: str(args.conversation_id),
          since,
          maxConversations: int(args.max_conversations, 40, 1, 150),
          kind: 'all'
        })
        const files: { time: number; out: Record<string, unknown> }[] = []
        for (const f of res.found) {
          for (const m of f.messages) {
            const ctx = {
              from: m.fromName || f.account.name(m.from) || m.from,
              time: localIso(m.time),
              conversation_id: f.conv.id,
              conversation: f.conv.title,
              message_id: m.id,
              account: label(f.account)
            }
            for (const x of m.attachments) {
              if (ws.length && !matchesAll(x.name, ws)) continue
              files.push({ time: m.time, out: { name: x.name, kind: 'file', type: x.fileType, size: x.size, url: x.url, ...ctx } })
            }
            if (images) for (const url of imageUrls(m.html)) files.push({ time: m.time, out: { name: 'Bild', kind: 'image', url, ...ctx } })
          }
        }
        files.sort((x, y) => y.time - x.time)
        return {
          total: files.length,
          files: files.slice(0, int(args.limit, 50, 1, 300)).map((x) => x.out),
          searched: { since: localIso(since), conversations: res.scanned, not_searched: res.skipped || undefined },
          errors: res.errors.length ? res.errors : undefined,
          warnings: res.warnings.length ? res.warnings : undefined
        }
      }
    },
    {
      name: 'read_file',
      title: 'Datei lesen',
      description:
        'Lädt eine in Teams geteilte Datei oder ein Bild (url aus get_messages oder list_files). Text kommt direkt zurück, Bilder als Bild. Jede Datei landet zusätzlich in einem lokalen Ordner, der Pfad steht in der Antwort, z. B. für PDFs und Office-Dateien.',
      inputSchema: schema(
        {
          url: { type: 'string', description: 'url der Datei oder des Bildes' },
          name: { type: 'string', description: 'Dateiname zum Speichern, z. B. aus list_files' },
          account: { type: 'string', description: 'Konto, in dem die Datei geteilt wurde. Standard: das Konto der conversation_id oder das erste' },
          conversation_id: { type: 'string', description: 'Unterhaltung, in der die Datei geteilt wurde, um das Konto zu finden' }
        },
        ['url']
      ),
      run: async (args): Promise<ToolResult> => {
        const url = str(args.url)
        if (!url || !/^https:\/\//i.test(url)) throw new ToolError('url muss eine https-Adresse sein')
        const conv = str(args.conversation_id)
        const a = conv ? accountFor(deps, conv, args.account) : readyAccounts(deps, args.account).ready[0]
        const file = await a.download(url)
        return fileResult(deps, str(args.name) ?? fileNameFrom(url), file.contentType, file.data)
      }
    },
    {
      name: 'get_call_history',
      title: 'Anrufverlauf',
      description: 'Liest den Anrufverlauf (eingehend, ausgehend, verpasst) mit Gesprächspartner, Zeit und Dauer, die neuesten zuerst.',
      inputSchema: schema({
        account: ACCOUNT_PROP,
        missed_only: { type: 'boolean', description: 'Nur verpasste Anrufe' },
        since: { type: 'string', description: 'Ab diesem Datum (ISO 8601)' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Standard 50' }
      }),
      run: async (args) => {
        const { ready, warnings } = readyAccounts(deps, args.account)
        const since = parseTime(args.since, 'since')
        const limit = int(args.limit, 50, 1, 500)
        const errors: string[] = []
        const all = await pool(ready, 2, async (a) => {
          const out: CallLogEntry[] = []
          let older: string | undefined
          try {
            for (let page = 0; page < 10 && out.length < limit; page++) {
              const res = await a.callLog(Math.min(100, limit), older)
              let reached = false
              for (const e of res.items) {
                if (since && e.time < since) reached = true
                else if (!args.missed_only || e.state === 'missed') out.push(e)
              }
              older = res.older
              if (reached || !older || res.items.length === 0) break
            }
          } catch (e) {
            errors.push(`${label(a)}: ${(e as Error).message}`)
          }
          return out.map((e) => ({ e, a }))
        })
        const entries = all
          .flat()
          .sort((x, y) => y.e.time - x.e.time)
          .slice(0, limit)
          .map(({ e, a }) => ({
            time: localIso(e.time),
            direction: e.direction,
            state: e.state,
            duration_sec: e.durationSec,
            peer: e.peerName || (e.peerMri ? a.name(e.peerMri) : undefined) || e.peerMri,
            peer_id: e.peerMri,
            call_type: e.callType,
            conversation_id: e.threadId,
            conversation: e.threadId ? titleOf(a, e.threadId).title : undefined,
            account: label(a)
          }))
        return { calls: entries, errors: errors.length ? errors : undefined, warnings: warnings.length ? warnings : undefined }
      }
    },
    {
      name: 'get_activity',
      title: 'Aktivität',
      description: 'Liest den Aktivitäts-Feed: Erwähnungen, Antworten, Reaktionen, verpasste Anrufe und Besprechungshinweise, die neuesten zuerst.',
      inputSchema: schema({
        account: ACCOUNT_PROP,
        unread_only: { type: 'boolean', description: 'Nur ungelesene Einträge' },
        type: { type: 'string', enum: ['mention', 'reply', 'reaction', 'call', 'meeting', 'membership', 'like', 'other'] },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Standard 50' }
      }),
      run: async (args) => {
        const { ready, warnings } = readyAccounts(deps, args.account)
        const errors: string[] = []
        const lists = await pool(ready, 2, async (a) => {
          try {
            return (await a.activity()).map((it) => ({ it, a }))
          } catch (e) {
            errors.push(`${label(a)}: ${(e as Error).message}`)
            return []
          }
        })
        const items = lists
          .flat()
          .filter(({ it }) => (!args.unread_only || !it.read) && (!args.type || it.type === args.type))
          .sort((x, y) => y.it.time - x.it.time)
          .slice(0, int(args.limit, 50, 1, 200))
          .map(({ it, a }) => ({
            time: localIso(it.time),
            type: it.type,
            who: it.actorName || undefined,
            what: it.title,
            preview: it.preview ? clip(it.preview, 500) : undefined,
            where: it.location || (it.conversationId ? titleOf(a, it.conversationId).title : undefined),
            conversation_id: it.conversationId,
            message_id: it.messageId,
            read: it.read,
            account: label(a)
          }))
        return { activity: items, errors: errors.length ? errors : undefined, warnings: warnings.length ? warnings : undefined }
      }
    },
    {
      name: 'get_calendar',
      title: 'Kalender',
      description: 'Liest die Termine und Besprechungen im Zeitraum, Standard heute plus 7 Tage, höchstens 62 Tage.',
      inputSchema: schema({
        account: ACCOUNT_PROP,
        start: { type: 'string', description: 'Beginn (ISO 8601). Standard: heute 0 Uhr' },
        end: { type: 'string', description: 'Ende (ISO 8601). Standard: start plus 7 Tage' }
      }),
      run: async (args) => {
        const { ready, warnings } = readyAccounts(deps, args.account)
        const today = new Date(now())
        today.setHours(0, 0, 0, 0)
        const start = parseTime(args.start, 'start') ?? today.getTime()
        const end = parseTime(args.end, 'end') ?? start + 7 * DAY
        if (end <= start) throw new ToolError('end muss nach start liegen')
        if (end - start > 62 * DAY) throw new ToolError('Der Zeitraum darf höchstens 62 Tage lang sein')
        const errors: string[] = []
        const lists = await pool(ready, 2, async (a) => {
          try {
            return (await a.calendar(start, end)).map((e) => ({ e, a }))
          } catch (e) {
            errors.push(`${label(a)}: ${(e as Error).message}`)
            return []
          }
        })
        const events = lists
          .flat()
          .sort((x, y) => x.e.start - y.e.start)
          .map(({ e, a }) => ({
            subject: e.subject,
            start: localIso(e.start),
            end: localIso(e.end),
            all_day: e.isAllDay || undefined,
            location: e.location || undefined,
            organizer: e.organizer || undefined,
            online_meeting: e.isOnlineMeeting || undefined,
            join_url: e.joinUrl,
            cancelled: e.isCancelled || undefined,
            show_as: e.showAs,
            my_response: e.myResponse,
            conversation_id: e.threadId,
            account: label(a)
          }))
        return { range: { start: localIso(start), end: localIso(end) }, events, errors: errors.length ? errors : undefined, warnings: warnings.length ? warnings : undefined }
      }
    },
    {
      name: 'search_people',
      title: 'Personen suchen',
      description: 'Sucht Personen im Verzeichnis der Organisation nach Name oder E-Mail und liefert Funktion, Abteilung und E-Mail.',
      inputSchema: schema({ query: { type: 'string' }, account: ACCOUNT_PROP }, ['query']),
      run: async (args) => {
        const q = str(args.query)
        if (!q) throw new ToolError('query fehlt')
        const { ready, warnings } = readyAccounts(deps, args.account)
        const errors: string[] = []
        const lists = await pool(ready, 2, async (a) => {
          try {
            return (await a.searchPeople(q)).map((p) => ({
              name: p.displayName,
              email: p.email || p.upn,
              job_title: p.jobTitle,
              department: p.department,
              id: p.mri,
              account: label(a)
            }))
          } catch (e) {
            errors.push(`${label(a)}: ${(e as Error).message}`)
            return []
          }
        })
        return { people: lists.flat(), errors: errors.length ? errors : undefined, warnings: warnings.length ? warnings : undefined }
      }
    },
    {
      name: 'list_mail_folders',
      title: 'E-Mail-Ordner',
      description: 'Listet die E-Mail-Ordner der Postfächer (oberste Ebene) mit Zahl ungelesener und aller Mails. folder_id oder Name gehen an list_mail und search_mail.',
      inputSchema: schema({ account: ACCOUNT_PROP }),
      run: async (args) => {
        const { ready, warnings } = mailAccounts(deps, args.account)
        const errors: string[] = []
        const lists = await pool(ready, 2, async (a) => {
          try {
            return (await a.mailFolders()).map((f) => ({ account: label(a), folder_id: f.id, name: f.name, kind: f.kind, unread: f.unread, total: f.total }))
          } catch (e) {
            errors.push(`${label(a)}: ${(e as Error).message}`)
            return []
          }
        })
        return { folders: lists.flat(), errors: errors.length ? errors : undefined, warnings: warnings.length ? warnings : undefined }
      }
    },
    {
      name: 'list_mail',
      title: 'E-Mails',
      description:
        'Listet die E-Mails eines Ordners, die neuesten zuerst, mit Absender, Betreff und Vorschau. Standard: Posteingang aller Konten. Den vollen Text liefert get_mail mit message_id. Für ältere Mails next_until als until übergeben.',
      inputSchema: schema({
        account: ACCOUNT_PROP,
        folder: { type: 'string', description: 'inbox, sentitems, drafts, archive, deleteditems, junkemail, all (alle Ordner), ein Ordnername oder folder_id. Standard: inbox' },
        unread_only: { type: 'boolean', description: 'Nur ungelesene' },
        since: { type: 'string', description: 'Nur Mails ab diesem Zeitpunkt (ISO 8601)' },
        until: { type: 'string', description: 'Nur Mails vor diesem Zeitpunkt (ISO 8601), z. B. next_until der vorigen Antwort' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Standard 25' }
      }),
      run: async (args) =>
        runMailQuery(deps, args.account, {
          folderArg: str(args.folder) ?? 'inbox',
          since: parseTime(args.since, 'since'),
          until: parseTime(args.until, 'until'),
          unreadOnly: args.unread_only === true,
          limit: int(args.limit, 25, 1, 100)
        })
    },
    {
      name: 'search_mail',
      title: 'E-Mails durchsuchen',
      description:
        'Durchsucht die Postfächer serverseitig (Exchange-Suche über Betreff, Text, Absender, Empfänger und Anhangsnamen), Standard alle Ordner, die neuesten Treffer zuerst. query versteht Wörter und KQL, z. B. "Angebot Nord", from:anna@firma.de, to:kunde.de, subject:Rechnung, hasattachments:true. Den vollen Text liefert get_mail.',
      inputSchema: schema(
        {
          query: { type: 'string', description: 'Suchwörter oder KQL' },
          account: ACCOUNT_PROP,
          folder: { type: 'string', description: 'Nur in diesem Ordner (Name, folder_id oder inbox, sentitems …). Standard: alle Ordner' },
          unread_only: { type: 'boolean', description: 'Nur ungelesene' },
          since: { type: 'string', description: 'Ab diesem Zeitpunkt (ISO 8601)' },
          until: { type: 'string', description: 'Vor diesem Zeitpunkt (ISO 8601)' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Standard 25' }
        },
        ['query']
      ),
      run: async (args) => {
        const query = str(args.query)
        if (!query) throw new ToolError('query fehlt')
        return runMailQuery(deps, args.account, {
          query,
          folderArg: str(args.folder),
          since: parseTime(args.since, 'since'),
          until: parseTime(args.until, 'until'),
          unreadOnly: args.unread_only === true,
          limit: int(args.limit, 25, 1, 100)
        })
      }
    },
    {
      name: 'get_mail',
      title: 'E-Mail lesen',
      description:
        'Liest eine E-Mail vollständig: Absender, alle Empfänger, Datum und den Text (HTML als lesbarer Text, Links mit Ziel in Klammern, zitierte Vorgänger bleiben drin). Anhänge stehen unter attachments, ihren Inhalt liefert read_mail_attachment. Markiert nichts als gelesen.',
      inputSchema: schema(
        {
          message_id: { type: 'string', description: 'Aus list_mail oder search_mail' },
          account: { type: 'string', description: 'Konto aus list_mail. Ohne Angabe werden alle Konten probiert.' },
          max_chars: { type: 'integer', minimum: 1000, maximum: 200000, description: 'Höchstlänge des Texts, Standard 20000' }
        },
        ['message_id']
      ),
      run: async (args) => {
        const id = str(args.message_id)
        if (!id) throw new ToolError('message_id fehlt')
        const { a, value: m } = await findMail(deps, args.account, (x) => x.mail(id))
        return {
          message_id: m.id,
          account: label(a),
          thread_id: m.conversationId,
          received: localIso(m.received),
          from: addr(m.from),
          to: addrs(m.to, 100),
          cc: addrs(m.cc, 100),
          reply_to: addrs(m.replyTo),
          subject: m.subject,
          unread: !m.isRead || undefined,
          importance: m.importance !== 'normal' ? m.importance : undefined,
          flagged: m.flagged || undefined,
          draft: m.isDraft || undefined,
          text: clip(m.text, int(args.max_chars, MAX_MAIL_TEXT, 1000, 200_000)),
          attachments: m.attachments.length
            ? m.attachments.map((x) => ({ attachment_id: x.id, name: x.name, type: x.contentType, size: x.size, inline: x.isInline || undefined }))
            : undefined
        }
      }
    },
    {
      name: 'read_mail_attachment',
      title: 'E-Mail-Anhang lesen',
      description:
        'Lädt einen Anhang einer E-Mail (attachment_id aus get_mail). Text kommt direkt zurück, Bilder als Bild. Jeder Anhang landet zusätzlich in einem lokalen Ordner, der Pfad steht in saved_to, z. B. für PDFs und Office-Dateien.',
      inputSchema: schema(
        {
          message_id: { type: 'string' },
          attachment_id: { type: 'string' },
          account: { type: 'string', description: 'Konto aus get_mail. Ohne Angabe werden alle Konten probiert.' }
        },
        ['message_id', 'attachment_id']
      ),
      run: async (args): Promise<ToolResult> => {
        const id = str(args.message_id)
        const att = str(args.attachment_id)
        if (!id || !att) throw new ToolError('message_id und attachment_id angeben')
        const { value: f } = await findMail(deps, args.account, (x) => x.mailAttachment(id, att))
        return fileResult(deps, f.name, f.contentType ?? 'application/octet-stream', f.data)
      }
    }
  ]
  return tools
}

export const SERVER_INSTRUCTIONS = [
  'Lesender Zugriff auf Microsoft Teams und die zugehörigen Postfächer über die App Plenum, für alle dort angemeldeten Konten.',
  'Nichts davon sendet, ändert oder markiert etwas als gelesen.',
  'Ablauf: list_conversations (oder list_teams für Kanäle) liefert conversation_id, get_messages liest einen Chat, search_messages sucht über viele Chats.',
  'Dateien: list_files oder die files/images einer Nachricht, Inhalt über read_file.',
  'Anrufe: get_call_history. Erwähnungen und Antworten: get_activity. Termine: get_calendar.',
  'E-Mail: list_mail (Ordner, Standard Posteingang) oder search_mail (Exchange-Suche im ganzen Postfach) liefern message_id, get_mail den vollen Text, read_mail_attachment einen Anhang.',
  'Ohne account gelten die Werkzeuge für alle Konten. Zeiten sind Ortszeit mit Versatz (ISO 8601).'
].join(' ')
