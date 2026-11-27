// Liest die Header mit, die die Teams-Web-App bei ihren eigenen API-Aufrufen sendet.
// Daraus ergeben sich Basis-URLs (Region, Host) und Auth-Header pro API-Familie,
// die wir für eigene Aufrufe wiederverwenden.

export type Family =
  | 'chatsvc'
  | 'csa'
  | 'mt'
  | 'presence'
  | 'ams'
  | 'graph'
  | 'substrate'
  | 'authsvc'
  | 'outlook'
  | 'other'

export interface CapturedRequest {
  family: Family
  base: string
  headers: Record<string, string>
  at: number
  url: string
  method: string
}

interface JwtInfo {
  aud?: string
  exp?: number
  oid?: string
  tid?: string
  name?: string
  upn?: string
  scp?: string
  // Aussteller des Heimatmandanten, nur bei Gästen (siehe homeTenantOf)
  idp?: string
}

const SKIP_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'accept-encoding',
  'connection',
  'cookie',
  'origin',
  'referer',
  'user-agent',
  'x-ms-request-id',
  'x-ms-client-request-id',
  'ms-cv',
  'traceparent',
  'tracestate',
  'request-id',
  'x-ms-correlation-id',
  'x-anchormailbox',
  'priority',
  'if-none-match',
  'if-modified-since',
  'range',
  'pragma',
  'cache-control',
  'accept-language',
  'x-ms-scenario-id',
  'x-ms-session-id',
  'x-ms-test-user',
  'upgrade-insecure-requests'
])

export function decodeJwt(token: string): JwtInfo | null {
  try {
    const part = token.split('.')[1]
    if (!part) return null
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const c = JSON.parse(json)
    return {
      aud: c.aud,
      exp: typeof c.exp === 'number' ? c.exp * 1000 : undefined,
      oid: c.oid,
      tid: c.tid,
      name: c.name,
      upn: c.upn || c.unique_name || c.preferred_username || c.email,
      scp: c.scp,
      // Immer gesetzt (auch undefined), sonst bliebe beim Zusammenführen in me ein alter Wert stehen
      idp: typeof c.idp === 'string' ? c.idp : undefined
    }
  } catch {
    return null
  }
}

export function classify(rawUrl: string): { family: Family; base: string } | null {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return null
  }
  const p = u.pathname
  const h = u.hostname
  let m: RegExpMatchArray | null

  if ((m = p.match(/^(.*?\/api\/chatsvc\/[^/]+)\//))) return { family: 'chatsvc', base: u.origin + m[1] }
  if (/\.msg\.teams\.microsoft\.com$/.test(h) || /^[a-z0-9-]+\.ng\.msg\./.test(h)) {
    if (/\/v1\/(users|threads)\//.test(p)) return { family: 'chatsvc', base: u.origin }
  }
  if ((m = p.match(/^(.*?\/api\/csa\/[^/]+)\//))) return { family: 'csa', base: u.origin + m[1] }
  if ((m = p.match(/^(.*?\/api\/mt\/part\/[^/]+)\//))) return { family: 'mt', base: u.origin + m[1] }
  if ((m = p.match(/^(.*?\/api\/mt\/[^/]+)\//))) return { family: 'mt', base: u.origin + m[1] }
  if ((m = p.match(/^(.*?\/ups\/[^/]+)\/v1\//))) return { family: 'presence', base: u.origin + m[1] }
  if ((m = p.match(/^(.*?\/api\/presence\/[^/]+)\//))) return { family: 'presence', base: u.origin + m[1] }
  if (/^presence\.teams\.(microsoft\.com|cloud\.microsoft)$/.test(h)) return { family: 'presence', base: u.origin }
  if (/asm\.skype\.com$/.test(h) || /asyncgw\.teams\.microsoft\.com$/.test(h) || /\.ams\./.test(h))
    return { family: 'ams', base: u.origin }
  if (h === 'graph.microsoft.com') return { family: 'graph', base: u.origin }
  if (/substrate\.office\.com$/.test(h)) return { family: 'substrate', base: u.origin }
  if ((m = p.match(/^(.*?\/api\/authsvc)\//))) return { family: 'authsvc', base: u.origin + m[1] }
  if (/^outlook\.(office|office365)\.com$/.test(h) || h === 'outlook.cloud.microsoft')
    return { family: 'outlook', base: u.origin }
  return null
}

export class TokenStore {
  // Letzte erfasste Anfrage pro Familie (mit Auth-Header).
  templates = new Map<Family, CapturedRequest>()
  // Neuester Bearer-Token pro Audience.
  bearers = new Map<string, { token: string; exp?: number; at: number }>()
  skypeToken?: { token: string; at: number }
  me: JwtInfo = {}
  // Alle gesehenen Endpunkte für die Diagnose.
  seen = new Map<string, { method: string; count: number; at: number }>()
  onChange?: (family: Family) => void

  // Alles Erfasste verwerfen (Neuladen in einem anderen Mandanten oder nach abgelaufener Sitzung):
  // Bereit ist die Engine erst wieder mit frischen Tokens der Web-App
  reset(): void {
    this.templates.clear()
    this.bearers.clear()
    this.skypeToken = undefined
    this.me = {}
  }

  capture(url: string, method: string, headers: Record<string, string | string[]>): void {
    const lower: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v

    const auth = lower['authorization']
    if (auth && /^bearer\s/i.test(auth)) {
      const tok = auth.replace(/^bearer\s+/i, '')
      const info = decodeJwt(tok)
      if (info?.aud) {
        const prev = this.bearers.get(info.aud)
        if (!prev || (info.exp ?? 0) >= (prev.exp ?? 0)) this.bearers.set(info.aud, { token: tok, exp: info.exp, at: Date.now() })
        if (info.oid && (!this.me.oid || info.aud.includes('api.spaces.skype.com') || info.aud.includes('chatsvcagg'))) {
          this.me = { ...this.me, ...info }
        }
      }
    }
    const skype =
      lower['x-skypetoken'] ||
      (lower['authentication'] && lower['authentication'].replace(/^skypetoken=/i, '')) ||
      (auth && /^skype_token\s/i.test(auth) ? auth.replace(/^skype_token\s+/i, '') : undefined)
    if (skype) this.skypeToken = { token: skype, at: Date.now() }

    const cls = classify(url)
    if (!cls) return
    const key = `${method} ${url.split('?')[0].replace(/\/(19|48|8|28|4):[^/]+/g, '/{id}').replace(/\/\d{6,}/g, '/{n}')}`
    const s = this.seen.get(key)
    this.seen.set(key, { method, count: (s?.count ?? 0) + 1, at: Date.now() })

    const hasAuth = !!(auth || lower['authentication'] || lower['x-skypetoken'])
    if (!hasAuth && cls.family !== 'ams') return
    const tpl: Record<string, string> = {}
    for (const [k, v] of Object.entries(lower)) {
      if (SKIP_HEADERS.has(k) || k.startsWith('sec-') || k.startsWith(':')) continue
      tpl[k] = v
    }
    const prev = this.templates.get(cls.family)
    // Basis-URL nur übernehmen, wenn die alte noch nicht gesetzt war oder sich die Region ändert.
    this.templates.set(cls.family, { family: cls.family, base: cls.base, headers: tpl, at: Date.now(), url, method })
    if (!prev || prev.base !== cls.base) this.onChange?.(cls.family)
  }

  has(family: Family): boolean {
    return this.templates.has(family)
  }

  base(family: Family): string | undefined {
    return this.templates.get(family)?.base
  }

  // Header für einen eigenen Aufruf: Vorlage der Familie, Bearer durch den neuesten Token gleicher Audience ersetzt.
  headersFor(family: Family): Record<string, string> {
    const tpl = this.templates.get(family)
    const h: Record<string, string> = { ...(tpl?.headers ?? {}) }
    const auth = h['authorization']
    if (auth && /^bearer\s/i.test(auth)) {
      const info = decodeJwt(auth.replace(/^bearer\s+/i, ''))
      if (info?.aud) {
        const newest = this.bearers.get(info.aud)
        if (newest) h['authorization'] = `Bearer ${newest.token}`
      }
    } else if (!auth) {
      const aud = FAMILY_AUDIENCE[family]
      const tok = aud ? this.findBearer(aud) : undefined
      if (tok) h['authorization'] = `Bearer ${tok}`
    }
    if (this.skypeToken) {
      if (h['authentication']) h['authentication'] = `skypetoken=${this.skypeToken.token}`
      if (h['x-skypetoken']) h['x-skypetoken'] = this.skypeToken.token
      if (h['authorization'] && /^skype_token\s/i.test(h['authorization']))
        h['authorization'] = `skype_token ${this.skypeToken.token}`
    }
    return h
  }

  findBearer(audPart: string): string | undefined {
    let best: { token: string; exp?: number } | undefined
    for (const [aud, t] of this.bearers) {
      if (!aud.includes(audPart)) continue
      if (!best || (t.exp ?? 0) > (best.exp ?? 0)) best = t
    }
    return best?.token
  }

  // Neuester Token für genau diese Audiences (ohne Teilstring-Treffer wie bei findBearer)
  bearerFor(auds: string[]): string | undefined {
    let best: { token: string; exp?: number } | undefined
    for (const aud of auds) {
      const t = this.bearers.get(aud)
      if (t && (!best || (t.exp ?? 0) > (best.exp ?? 0))) best = t
    }
    return best?.token
  }

  expiry(family: Family): number | undefined {
    const h = this.headersFor(family)
    const auth = h['authorization']
    if (auth && /^bearer\s/i.test(auth)) return decodeJwt(auth.replace(/^bearer\s+/i, ''))?.exp
    return undefined
  }
}

export const FAMILY_AUDIENCE: Partial<Record<Family, string>> = {
  csa: 'chatsvcagg.teams.microsoft.com',
  mt: 'api.spaces.skype.com',
  presence: 'presence.teams.microsoft.com',
  graph: 'graph.microsoft.com',
  substrate: 'substrate.office.com',
  authsvc: 'api.spaces.skype.com',
  outlook: 'outlook.office'
}

// Outlook-Token für Mail und Kalender. Die Web-App ruft outlook.office.com auch mit einem eigenen
// Such-Token auf, der nichts anderes darf. Deshalb zählt nur diese Audience.
export const OUTLOOK_AUDIENCES = ['https://outlook.office.com/', 'https://outlook.office.com', 'https://outlook.office365.com/', 'https://outlook.office365.com']
