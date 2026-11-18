/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine } from './engine'
import type { Family } from './tokens'
import { log } from '../log'

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

  async json<T = any>(family: Family, url: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: boolean } = {}): Promise<T> {
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
