/* eslint-disable @typescript-eslint/no-explicit-any */
// Verbindet die Werkzeuge des MCP-Servers mit den laufenden Konten. Ruft nur lesende Endpunkte auf,
// auch bei E-Mail (GET auf Graph bzw. Outlook REST, nichts wird als gelesen markiert).
import type { AccountService } from '../account'
import { mapCallLog, mapChatsvcMessage } from '../engine/parse'
import { isAmsView, isChatMessagesPage } from '../engine/hosts'
import { mailHtmlToText } from '../engine/mail'
import { ToolError, type McpAccount, type Page } from './tools'
import type { CallLogEntry, Message } from '@shared/types'

const MAX_DOWNLOAD = 50 * 1024 * 1024

// Ältere Seiten holt nur eine Nachrichtenseite des Chat-Dienstes, sonst gingen die Tokens an
// eine Adresse aus dem Cursor, den der Agent mitschickt.
function olderUrl(url: string, conversationId: string, pageSize: number): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new ToolError('cursor ist ungültig')
  }
  const conv = u.pathname.match(/\/conversations\/([^/]+)\/messages$/)?.[1]
  if (!isChatMessagesPage(url) || !conv || decodeURIComponent(conv) !== conversationId) {
    throw new ToolError('cursor ist ungültig')
  }
  u.searchParams.set('pageSize', String(pageSize))
  return u.toString()
}

async function page(acct: AccountService, conversationId: string, pageSize: number, older?: string): Promise<{ raw: any[]; older?: string }> {
  const res = older ? await acct.api.messagesByUrl(olderUrl(older, conversationId, pageSize)) : await acct.api.messages(conversationId, pageSize)
  const raw: any[] = res?.messages ?? []
  return { raw, older: raw.length ? res?._metadata?.backwardLink || undefined : undefined }
}

function base64url(s: string): string {
  return Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

async function readBody(res: Response): Promise<Uint8Array> {
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > MAX_DOWNLOAD) throw new ToolError(`Datei ist größer als ${MAX_DOWNLOAD / 1024 / 1024} MB`)
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.byteLength > MAX_DOWNLOAD) throw new ToolError(`Datei ist größer als ${MAX_DOWNLOAD / 1024 / 1024} MB`)
  return buf
}

async function download(acct: AccountService, url: string): Promise<{ data: Uint8Array; contentType: string }> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new ToolError('url ist keine gültige Adresse')
  }
  if (u.protocol !== 'https:') throw new ToolError('url muss eine https-Adresse sein')
  const host = u.hostname.toLowerCase()

  // Dateien aus Chats liegen in SharePoint oder OneDrive. Die Tokens der Web-App gehen nie an
  // *.sharepoint.com (Subdomains beliebiger Mandanten). Graph liefert zur Datei eine vorab
  // freigegebene Download-Adresse, die ohne Token und Cookies geladen wird.
  if (/(^|\.)sharepoint(-df)?\.com$/.test(host) || /(^|\.)(onedrive\.live\.com|1drv\.ms)$/.test(host)) {
    if (!acct.engine.tokens.findBearer('graph.microsoft.com')) {
      throw new ToolError(
        'Für Dateien aus SharePoint und OneDrive fehlt noch ein Graph-Token der Teams-Web-App. Öffne in Plenum einmal den Kalender und versuche es dann erneut.'
      )
    }
    let item: any
    try {
      item = await acct.api.json('graph', `https://graph.microsoft.com/v1.0/shares/u!${base64url(url)}/driveItem`)
    } catch (e) {
      throw new ToolError(`Datei nicht abrufbar (${(e as Error).message}). Die Datei ist evtl. nicht mehr freigegeben.`)
    }
    const link = item?.['@microsoft.graph.downloadUrl']
    if (typeof link !== 'string' || !link.startsWith('https://')) throw new ToolError('Graph liefert keine Download-Adresse für diese Datei')
    if (Number(item?.size) > MAX_DOWNLOAD) throw new ToolError(`Datei ist größer als ${MAX_DOWNLOAD / 1024 / 1024} MB`)
    // Globales fetch statt der Sitzung der Web-App: keine Tokens, keine Cookies
    const res = await fetch(link)
    if (!res.ok) throw new ToolError(`Datei nicht abrufbar (HTTP ${res.status})`)
    return { data: await readBody(res), contentType: item?.file?.mimeType || res.headers.get('content-type') || 'application/octet-stream' }
  }

  if (isAmsView(url)) {
    const res = await acct.engine.request('ams', url, { headers: { accept: 'image/*,*/*' } })
    if (!res.ok) throw new ToolError(`Bild nicht abrufbar (HTTP ${res.status})`)
    return { data: await readBody(res), contentType: res.headers.get('content-type') ?? 'application/octet-stream' }
  }
  throw new ToolError('Abrufbar sind nur Dateien aus SharePoint und OneDrive und Bilder aus Teams-Nachrichten')
}

export function mcpAccount(acct: AccountService): McpAccount {
  const names = (mri: string) => acct.people.get(mri)?.displayName
  return {
    id: acct.id,
    info: () => acct.info(),
    chats: () => [...acct.chats.values()],
    teams: () => acct.teams,
    name: names,
    async messages(conversationId, pageSize, older): Promise<Page<Message>> {
      const myMri = acct.record.mri ?? ''
      const res = await page(acct, conversationId, pageSize, older)
      const items = res.raw
        .filter((m) => !/^Control\//.test(m.messagetype || m.messageType || ''))
        .map((m) => mapChatsvcMessage(m, myMri, names))
      return { items, older: res.older }
    },
    async callLog(pageSize, older): Promise<Page<CallLogEntry>> {
      const myMri = acct.record.mri ?? ''
      const res = await page(acct, '48:calllogs', pageSize, older)
      const items = res.raw.map((m) => mapCallLog(m, myMri)).filter(Boolean) as CallLogEntry[]
      const unknown = [...new Set(items.map((e) => e.peerMri).filter((m): m is string => !!m && !acct.people.has(m)))]
      if (unknown.length) await acct.getPeople(unknown).catch(() => [])
      return { items, older: res.older }
    },
    activity: () => acct.getActivity(),
    calendar: (start, end) => acct.getCalendar(start, end),
    searchPeople: (q) => acct.searchPeople(q),
    download: (url) => download(acct, url),
    hasMail: () => acct.api.hasMailToken(),
    mailFolders: () => acct.getMailFolders(),
    mailQuery: (q, next) => acct.queryMail(q, next),
    async mail(id) {
      const { bodyType, body, inlineImages: _, ...rest } = await acct.getMail(id, { inlineImages: false })
      return { ...rest, text: bodyType === 'html' ? mailHtmlToText(body) : body.replace(/\r\n?/g, '\n').trim() }
    },
    mailAttachment: (id, attachmentId) => acct.getMailAttachment(id, attachmentId)
  }
}
