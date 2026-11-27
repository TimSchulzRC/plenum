/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine } from './engine'
import { OUTLOOK_AUDIENCES, type Family } from './tokens'
import { log } from '../log'
import { uploadAmsImage } from './ams'
import { firstWriter, graphEventBody, mayTryNextWriter, outlookEventBody } from './events'
import {
  attachmentBody,
  attachmentUrl,
  attachmentsUrl,
  camelize,
  CREATE_REPLY,
  folderListUrl,
  folderName,
  MAIL_BASE,
  MAIL_TEXTS,
  mailPageApi,
  mailQueryUrl,
  messageActionUrl,
  messageUrl,
  messagesUrl,
  newDraftBody,
  NO_MAIL_TOKEN,
  pascalize,
  recipientsPatch,
  replyDraftBody,
  wellKnownUrl,
  type MailApi,
  type MailQuery
} from './mail'
import type { MailDraft, MailFile, MailFolderKind, MailReplyKind, NewCalendarEvent } from '@shared/types'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: string
  ) {
    super(message)
  }
}

const CONV_VIEW = 'msnp24Equivalent|supportsMessageProperties'

// Dünne Schicht über die internen Teams-APIs, die die Web-App selbst nutzt.
export class TeamsApi {
  constructor(private readonly engine: Engine) {}

  base(family: Family): string {
    const b = this.engine.tokens.base(family)
    if (!b) throw new ApiError(0, `Endpunkt ${family} noch nicht bekannt`)
    return b
  }

  async json<T = any>(
    family: Family,
    url: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: boolean; omitCookies?: boolean } = {}
  ): Promise<T> {
    let res = await this.engine.request(family, url, init)
    if (res.status === 401) {
      // Token evtl. gerade abgelaufen – kurz warten, die Web-App erneuert ihn.
      await new Promise((r) => setTimeout(r, 1500))
      res = await this.engine.request(family, url, init)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      log.warn(`[api] ${init.method ?? 'GET'} ${url.split('?')[0]} -> ${res.status} ${body.slice(0, 300)}`)
      throw new ApiError(res.status, `${family} ${res.status}`, body)
    }
    const text = await res.text()
    if (!text) return {} as T
    try {
      return JSON.parse(text) as T
    } catch {
      return text as unknown as T
    }
  }

  // ---------- Chat-Service ----------
  chatsvc(path: string): string {
    return `${this.base('chatsvc')}${path}`
  }

  conversations(startTime = 1, pageSize = 200): Promise<any> {
    return this.json(
      'chatsvc',
      this.chatsvc(`/v1/users/ME/conversations?view=${encodeURIComponent(CONV_VIEW)}&pageSize=${pageSize}&startTime=${startTime}&targetType=Passport|Skype|Lync|Thread|Agent|ShortCircuit|PSTN|Flxt|NotificationStream|ModernBots|secureConversation|InteropChat`)
    )
  }

  conversationsByUrl(url: string): Promise<any> {
    return this.json('chatsvc', url)
  }

  messages(conversationId: string, pageSize = 60, startTime = 1, endTime?: number): Promise<any> {
    const end = endTime ? `&endTime=${endTime}` : ''
    return this.json(
      'chatsvc',
      this.chatsvc(`/v1/users/ME/conversations/${encodeURIComponent(conversationId)}/messages?view=${encodeURIComponent(CONV_VIEW)}&pageSize=${pageSize}&startTime=${startTime}${end}`)
    )
  }

  messagesByUrl(url: string): Promise<any> {
    return this.json('chatsvc', url)
  }

  consumptionHorizons(conversationId: string): Promise<any> {
    return this.json('chatsvc', this.chatsvc(`/v1/threads/${encodeURIComponent(conversationId)}/consumptionhorizons`))
  }

  thread(conversationId: string): Promise<any> {
    return this.json('chatsvc', this.chatsvc(`/v1/threads/${encodeURIComponent(conversationId)}?view=msnp24Equivalent`))
  }

  sendMessage(conversationId: string, body: any): Promise<any> {
    return this.json('chatsvc', this.chatsvc(`/v1/users/ME/conversations/${encodeURIComponent(conversationId)}/messages`), {
      method: 'POST',
      body
    })
  }

  editMessage(conversationId: string, messageId: string, body: any): Promise<any> {
    return this.json('chatsvc', this.chatsvc(`/v1/users/ME/conversations/${encodeURIComponent(conversationId)}/messages/${messageId}`), {
      method: 'PUT',
      body
    })
  }

  deleteMessage(conversationId: string, messageId: string): Promise<any> {
    return this.json(
      'chatsvc',
      this.chatsvc(`/v1/users/ME/conversations/${encodeURIComponent(conversationId)}/messages/${messageId}?behavior=softDelete`),
      { method: 'DELETE' }
    )
  }

  setEmotion(conversationId: string, messageId: string, key: string, on: boolean): Promise<any> {
    const url = this.chatsvc(`/v1/users/ME/conversations/${encodeURIComponent(conversationId)}/messages/${messageId}/properties?name=emotions`)
    return on
      ? this.json('chatsvc', url, { method: 'PUT', body: { emotions: { key, value: Date.now() } } })
      : this.json('chatsvc', url, { method: 'DELETE', body: { emotions: { key } } })
  }

  setConsumptionHorizon(conversationId: string, horizon: string): Promise<any> {
    return this.json(
      'chatsvc',
      this.chatsvc(`/v1/users/ME/conversations/${encodeURIComponent(conversationId)}/properties?name=consumptionhorizon`),
      { method: 'PUT', body: { consumptionhorizon: horizon } }
    )
  }

  createThread(members: { id: string; role: string }[], properties: Record<string, unknown>): Promise<Response> {
    return this.engine.request('chatsvc', this.chatsvc('/v1/threads'), { method: 'POST', body: { members, properties } })
  }

  // Bild in den Async Media Service laden, Leserecht für die Unterhaltung. Gibt die Objekt-ID zurück.
  async uploadImage(conversationId: string, data: Uint8Array, mime: string): Promise<string> {
    const skype = this.engine.tokens.skypeToken?.token
    if (!skype) throw new ApiError(0, 'Teams ist noch nicht verbunden, das Bild kann noch nicht hochgeladen werden')
    return uploadAmsImage((url, init) => this.json('ams', url, init), skype, conversationId, data, mime)
  }

  // ---------- Dateien in OneDrive/SharePoint (Anhänge an Chatnachrichten) ----------
  // Graph mit dem Token der Web-App. Den bekommt sie erst einige Sekunden nach dem Start.
  files<T = any>(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    const t = this.engine.tokens
    if (!t.has('graph') && !t.findBearer('graph.microsoft.com')) throw new ApiError(0, 'OneDrive ist noch nicht bereit. Versuch es in einer Minute noch einmal.')
    return this.json<T>('graph', url, init)
  }

  // Upload-Session (Teil hochladen, abbrechen): Die Adresse ist vorsigniert und bekommt keinen Token.
  // Ohne Cookies, sie antwortet wie Graph mit Access-Control-Allow-Origin: *.
  uploadSession(url: string, init: { method: string; body?: Uint8Array; headers?: Record<string, string> }): Promise<any> {
    return this.json('other', url, { ...init, omitCookies: true })
  }

  // ---------- Chat-Service-Aggregator (Teams, Kanäle, Chats) ----------
  teamsAndChats(): Promise<any> {
    return this.json(
      'csa',
      `${this.base('csa')}/api/v3/teams/users/me?isPrefetch=false&enableMembershipSummary=true&supportsAdditionalSystemGeneratedFolders=true&supportsSliceItems=true&enableEngageCommunities=false`
    )
  }

  folderActions(body: Record<string, unknown>): Promise<any> {
    return this.json('csa', `${this.base('csa')}/api/v1/teams/users/me/conversationFolders?supportsAdditionalSystemGeneratedFolders=true&supportsSliceItems=true`, {
      method: 'POST',
      body
    })
  }

  channelPosts(teamId: string, channelId: string, pageSize = 20): Promise<any> {
    return this.json(
      'csa',
      `${this.base('csa')}/api/v2/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}?filterSystemMessage=true&pageSize=${pageSize}`
    )
  }

  // ---------- Middle Tier (Personen) ----------
  fetchShortProfiles(mris: string[]): Promise<any> {
    return this.json(
      'mt',
      `${this.base('mt')}/beta/users/fetchShortProfile?isMailAddress=false&enableGuest=true&includeIBBarredUsers=true&skypeTeamsInfo=true`,
      { method: 'POST', body: mris }
    )
  }

  // Dasselbe für Mailadressen, so findet die E-Mail-Ansicht die MRI zu Absendern
  fetchShortProfilesByMail(addresses: string[]): Promise<any> {
    return this.json(
      'mt',
      `${this.base('mt')}/beta/users/fetchShortProfile?isMailAddress=true&canBeSmtpAddress=false&enableGuest=true&includeIBBarredUsers=true&skypeTeamsInfo=true`,
      { method: 'POST', body: addresses }
    )
  }

  fetchFederated(mris: string[]): Promise<any> {
    return this.json('mt', `${this.base('mt')}/beta/users/fetchFederated`, { method: 'POST', body: mris })
  }

  searchUsersMt(query: string): Promise<any> {
    return this.json(
      'mt',
      `${this.base('mt')}/beta/users/searchV2?includeDLs=false&includeBots=false&enableGuest=true&source=newChat&skypeTeamsInfo=true`,
      { method: 'POST', body: query }
    )
  }

  searchSubstrate(query: string): Promise<any> {
    return this.json('substrate', 'https://substrate.office.com/search/api/v1/suggestions?scenario=powerbar', {
      method: 'POST',
      body: {
        EntityRequests: [
          {
            Query: { QueryString: query, DisplayQueryString: query },
            EntityType: 'People',
            Size: 15,
            Fields: ['Id', 'MRI', 'DisplayName', 'EmailAddresses', 'GivenName', 'Surname', 'JobTitle', 'Department', 'UserPrincipalName', 'ExternalDirectoryObjectId', 'PeopleType', 'PeopleSubtype'],
            Filter: { And: [{ Or: [{ Term: { PeopleType: 'Person' } }, { Term: { PeopleType: 'Other' } }] }] }
          }
        ],
        Cvid: cryptoRandomId(),
        AppName: 'Microsoft Teams',
        Scenario: { Name: 'powerbar' }
      }
    })
  }

  profilePictureUrl(mri: string, displayName: string, size = 'HR96x96'): string {
    return `${this.base('mt')}/beta/users/${encodeURIComponent(mri)}/profilepicturev2?size=${size}&displayname=${encodeURIComponent(displayName)}`
  }

  teamPictureUrl(groupId: string, etag: string | undefined, displayName: string): string {
    return `${this.base('mt')}/beta/teams/${encodeURIComponent(groupId)}/profilepicturev2?etag=${encodeURIComponent(etag ?? '')}&displayName=${encodeURIComponent(displayName)}&size=HR64x64`
  }

  // ---------- Präsenz ----------
  presenceUrl(path: string): string {
    const b = this.engine.tokens.base('presence') ?? 'https://presence.teams.microsoft.com'
    return `${b}${path}`
  }

  getPresence(mris: string[]): Promise<any> {
    return this.json('presence', this.presenceUrl('/v1/presence/getpresence/'), {
      method: 'POST',
      body: mris.map((mri) => ({ mri }))
    })
  }

  // Zurücksetzen macht die Web-App mit einem PUT ohne Inhalt (DELETE wird mit 401 abgelehnt).
  forceAvailability(availability: string | null): Promise<any> {
    return availability
      ? this.json('presence', this.presenceUrl('/v1/me/forceavailability/'), { method: 'PUT', body: { availability } })
      : this.json('presence', this.presenceUrl('/v1/me/forceavailability/'), { method: 'PUT' })
  }

  // ---------- Kalender ----------
  async calendarView(startIso: string, endIso: string): Promise<{ source: string; data: any }> {
    const errors: string[] = []
    const tries: [string, () => Promise<any>][] = []
    if (this.engine.tokens.has('mt')) {
      const mt = this.base('mt')
      tries.push(['mt-v2.1', () => this.json('mt', `${mt}/v2.1/me/calendars/default/calendarView?StartDate=${encodeURIComponent(startIso)}&EndDate=${encodeURIComponent(endIso)}&shouldDecryptData=true`)])
      tries.push(['mt-beta', () => this.json('mt', `${mt}/beta/me/calendarEvents?StartDate=${encodeURIComponent(startIso)}&EndDate=${encodeURIComponent(endIso)}`)])
    }
    if (this.engine.tokens.findBearer('graph.microsoft.com')) {
      tries.push(['graph', () => this.json('graph', `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(startIso)}&endDateTime=${encodeURIComponent(endIso)}&$top=200&$orderby=start/dateTime`, { headers: { prefer: 'outlook.timezone="UTC"' } })])
    }
    if (this.engine.tokens.findBearer('outlook.office')) {
      tries.push(['outlook', () => this.json('outlook', `https://outlook.office.com/api/v2.0/me/calendarview?startDateTime=${encodeURIComponent(startIso)}&endDateTime=${encodeURIComponent(endIso)}&$top=200`, { headers: { prefer: 'outlook.timezone="UTC"' } })])
    }
    for (const [name, fn] of tries) {
      try {
        return { source: name, data: await fn() }
      } catch (e) {
        errors.push(`${name}: ${(e as Error).message}`)
      }
    }
    throw new ApiError(0, `Kalender nicht abrufbar (${errors.join('; ') || 'kein Token'})`)
  }

  // Termin im Kalender dieses Kontos anlegen. Der nächste Weg kommt nur dran, wenn der vorige sicher
  // nichts angelegt hat (siehe mayTryNextWriter), sonst stünde der Termin doppelt im Kalender.
  async createEvent(ev: NewCalendarEvent): Promise<{ source: string; data: any }> {
    const tries: [string, () => Promise<any>][] = []
    // Die Graph- und Outlook-Tokens der Teams-Web-App dürfen Calendars.ReadWrite. Graph legt die
    // Teams-Besprechung selbst an. Die Outlook-Felder dafür gibt es nur in der Beta-API.
    const tokens = this.engine.tokens
    if (tokens.has('graph') || tokens.findBearer('graph.microsoft.com')) {
      tries.push(['graph', () => this.json('graph', 'https://graph.microsoft.com/v1.0/me/events', { method: 'POST', body: graphEventBody(ev) })])
    }
    const outlook = tokens.bearerFor(OUTLOOK_AUDIENCES)
    if (outlook) {
      const version = ev.teamsMeeting ? 'beta' : 'v2.0'
      const headers = { authorization: `Bearer ${outlook}` }
      tries.push(['outlook', () => this.json('outlook', `https://outlook.office.com/api/${version}/me/events`, { method: 'POST', body: outlookEventBody(ev), headers })])
    }
    try {
      return await firstWriter(tries)
    } catch (e) {
      throw new ApiError((e as { status?: number }).status ?? 0, (e as Error).message)
    }
  }

  // ---------- E-Mail: Graph, sonst Outlook (siehe mail.ts) ----------
  private mailApis(order: MailApi[]): MailApi[] {
    const t = this.engine.tokens
    // Nur mit einem Token des eigenen Mandanten (siehe TokenStore.pick), eine Vorlage allein reicht nicht
    return order.filter((a) => (a === 'graph' ? !!t.findBearer('graph.microsoft.com') : !!t.bearerFor(OUTLOOK_AUDIENCES)))
  }

  hasMailToken(): boolean {
    return this.mailApis(['graph', 'outlook']).length > 0
  }

  // Outlook mit dem Mail-Token (nicht dem Such-Token), Anfrage in PascalCase, Antwort in camelCase.
  // Bei 401 noch einmal mit dem Token, den die Web-App inzwischen erneuert hat.
  private async mailRequest<T = any>(api: MailApi, url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    if (api === 'graph') return this.json('graph', url, init)
    const body = init.body === undefined ? undefined : pascalize(init.body)
    const send = (token: string) => this.json('outlook', url, { ...init, body, headers: { authorization: `Bearer ${token}` } }).then(camelize)
    const token = this.engine.tokens.bearerFor(OUTLOOK_AUDIENCES)
    if (!token) throw new ApiError(0, NO_MAIL_TOKEN)
    try {
      return await send(token)
    } catch (e) {
      const fresh = this.engine.tokens.bearerFor(OUTLOOK_AUDIENCES)
      if (!(e instanceof ApiError && e.status === 401) || !fresh || fresh === token) throw e
      return send(fresh)
    }
  }

  // Erster Weg, der klappt. Zum nächsten nur, wenn der vorige sicher nichts getan hat (mayTryNextWriter),
  // auch beim Schreiben: sonst entstünde ein Entwurf doppelt.
  private async mail<T = any>(build: (api: MailApi) => [string, { method?: string; body?: unknown }?]): Promise<T> {
    const apis = this.mailApis(['graph', 'outlook'])
    if (!apis.length) throw new ApiError(0, NO_MAIL_TOKEN)
    let last: unknown
    for (const api of apis) {
      const [url, init] = build(api)
      try {
        return await this.mailRequest<T>(api, url, init)
      } catch (e) {
        last = e
        if (!(e instanceof ApiError && mayTryNextWriter(e.status))) throw e
      }
    }
    throw last
  }

  mailFolders(): Promise<any> {
    return this.mail((api) => [folderListUrl(api)])
  }

  mailWellKnown(kind: MailFolderKind): Promise<any> {
    return this.mail((api) => [wellKnownUrl(api, kind)])
  }

  // Folgeseiten gehen an den Dienst, der sie geliefert hat
  mailMessages(folderId: string, next?: string): Promise<any> {
    if (next === undefined) return this.mail((api) => [messagesUrl(api, folderId)])
    const api = mailPageApi(next)
    if (!api) throw new ApiError(0, 'Ungültige Folgeseite')
    return this.mailRequest(api, next)
  }

  // Für den MCP-Server: Ordner oder ganzes Postfach, mit Filter oder Suche (siehe mailQueryUrl).
  // Folgeseiten wie bei mailMessages nur an den Dienst, der sie geliefert hat.
  mailQuery(q: MailQuery, next?: string): Promise<any> {
    if (next === undefined) return this.mail((api) => [mailQueryUrl(api, q)])
    const api = mailPageApi(next)
    if (!api) throw new ApiError(0, 'Ungültige Folgeseite')
    return this.mailRequest(api, next)
  }

  mailMessage(id: string): Promise<any> {
    return this.mail((api) => [messageUrl(api, id)])
  }

  mailAttachments(id: string): Promise<any> {
    return this.mail((api) => [attachmentsUrl(api, id)])
  }

  mailAttachment(id: string, attachmentId: string): Promise<any> {
    return this.mail((api) => [attachmentUrl(api, id, attachmentId)])
  }

  setMailRead(id: string, isRead: boolean): Promise<any> {
    return this.mail((api) => [messageActionUrl(api, id), { method: 'PATCH', body: { isRead } }])
  }

  // In „Gelöschte Elemente“ verschieben, wie Entf in Outlook
  moveMail(id: string, destination: MailFolderKind): Promise<any> {
    return this.mail((api) => [messageActionUrl(api, id, 'move'), { method: 'POST', body: { destinationId: folderName(api, destination) } }])
  }

  // Entwurf: neue Mail oder Antwort/Weiterleitung mit Zitat, bei Antworten danach die Empfänger
  async createMailDraft(draft: MailDraft, reply?: { id: string; kind: MailReplyKind }): Promise<string> {
    const res = reply
      ? await this.mail((api) => [messageActionUrl(api, reply.id, CREATE_REPLY[api][reply.kind]), { method: 'POST', body: replyDraftBody(draft, reply.kind) }])
      : await this.mail((api) => [`${MAIL_BASE[api]}/messages`, { method: 'POST', body: newDraftBody(draft) }])
    if (!res?.id) throw new ApiError(0, 'Kein Entwurf angelegt')
    const id = String(res.id)
    if (reply) await this.mail((api) => [messageActionUrl(api, id), { method: 'PATCH', body: recipientsPatch(draft) }])
    return id
  }

  addMailAttachment(draftId: string, file: MailFile): Promise<any> {
    return this.mail((api) => [messageActionUrl(api, draftId, 'attachments'), { method: 'POST', body: attachmentBody(file) }])
  }

  // Entwurf verschicken. Mail.Send hat nur der Outlook-Token der Web-App, Graph kommt nur dran, wenn
  // Outlook sicher nichts verschickt hat (siehe firstWriter), etwa weil ein Token fehlt.
  async sendMailDraft(draftId: string): Promise<{ source: string }> {
    const tries = this.mailApis(['outlook', 'graph']).map((api): [string, () => Promise<any>] => [api, () => this.mailRequest(api, messageActionUrl(api, draftId, 'send'), { method: 'POST' })])
    try {
      return await firstWriter(tries, MAIL_TEXTS)
    } catch (e) {
      throw new ApiError((e as { status?: number }).status ?? 0, (e as Error).message)
    }
  }
}

export function cryptoRandomId(): string {
  const b = new Uint8Array(16)
  globalThis.crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

export function clientMessageId(): string {
  let s = String(Math.floor(Math.random() * 9) + 1)
  for (let i = 0; i < 18; i++) s += Math.floor(Math.random() * 10)
  return s
}
