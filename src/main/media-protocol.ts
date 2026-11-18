import { protocol } from 'electron'
import type { AccountService } from './account'
import { classify } from './engine/tokens'
import { mayReceiveTokens } from './engine/hosts'
import { log } from './log'

export const MEDIA_SCHEME = 'tmimg'

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
  ])
}

interface CacheEntry {
  body: ArrayBuffer
  type: string
  at: number
  status: number
}
const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<CacheEntry>>()
const MAX = 800

function remember(key: string, e: CacheEntry): void {
  cache.set(key, e)
  if (cache.size > MAX) {
    const first = cache.keys().next().value
    if (first) cache.delete(first)
  }
}

// tmimg://avatar/<accountId>/<mri>?name=..   tmimg://team/<accountId>/<groupId>?name=..&etag=..
// tmimg://proxy/<accountId>/x?u=<url>
export function handleMediaProtocol(getAccount: (id: string) => AccountService | undefined): void {
  protocol.handle(MEDIA_SCHEME, async (req) => {
    const u = new URL(req.url)
    const [, accountId, rawId] = u.pathname.split('/')
    const acct = getAccount(accountId)
    if (!acct) return new Response(null, { status: 404 })
    const key = req.url
    const cached = cache.get(key)
    const maxAge = u.host === 'proxy' ? 24 * 3600_000 : 3600_000
    if (cached && Date.now() - cached.at < (cached.status === 200 ? maxAge : 5 * 60_000)) {
      return new Response(cached.status === 200 ? cached.body : null, { status: cached.status, headers: { 'content-type': cached.type, 'cache-control': 'max-age=3600' } })
    }
    let p = inflight.get(key)
    if (!p) {
      p = (async (): Promise<CacheEntry> => {
        try {
          let target: string
          let family: Parameters<typeof acct.engine.request>[0] = 'mt'
          // Nach dem Start kurz auf die Tokens der Web-App warten
          for (let i = 0; i < 40 && u.host !== 'proxy' && !acct.engine.tokens.has('mt'); i++) await new Promise((r) => setTimeout(r, 500))
          if (u.host === 'avatar') {
            if (!acct.engine.tokens.has('mt')) return { body: new ArrayBuffer(0), type: 'text/plain', at: 0, status: 503 }
            target = acct.api.profilePictureUrl(decodeURIComponent(rawId ?? ''), u.searchParams.get('name') ?? '', u.searchParams.get('size') ?? 'HR96x96')
          } else if (u.host === 'team') {
            if (!acct.engine.tokens.has('mt')) return { body: new ArrayBuffer(0), type: 'text/plain', at: 0, status: 503 }
            target = acct.api.teamPictureUrl(decodeURIComponent(rawId ?? ''), u.searchParams.get('etag') ?? undefined, u.searchParams.get('name') ?? '')
          } else {
            target = u.searchParams.get('u') ?? ''
            // Die URL stammt aus Nachrichten-HTML. Tokens gehen nur an Microsoft-Hosts, sonst kann
            // jeder Absender mit <img src="https://fremd.example/api/mt/x"> das Token abgreifen.
            family = (mayReceiveTokens(target) && classify(target)?.family) || 'other'
          }
          const res = await acct.engine.request(family, target, { headers: { accept: 'image/avif,image/webp,image/png,image/*,*/*' } })
          if (!res.ok) return { body: new ArrayBuffer(0), type: 'text/plain', at: Date.now(), status: res.status }
          const type = res.headers.get('content-type') ?? 'image/png'
          if (/json|html/.test(type)) return { body: new ArrayBuffer(0), type: 'text/plain', at: Date.now(), status: 404 }
          return { body: await res.arrayBuffer(), type, at: Date.now(), status: 200 }
        } catch (e) {
          log.warn('media fetch failed', (e as Error).message)
          return { body: new ArrayBuffer(0), type: 'text/plain', at: Date.now(), status: 502 }
        }
      })()
      inflight.set(key, p)
    }
    const entry = await p
    inflight.delete(key)
    if (entry.at) remember(key, entry)
    return new Response(entry.status === 200 ? entry.body.slice(0) : null, {
      status: entry.status,
      headers: { 'content-type': entry.type, 'cache-control': 'max-age=3600' }
    })
  })
}
