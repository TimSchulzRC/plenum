// Token für eine weitere Ressource (z. B. die eigene SharePoint-Site) still holen, wie MSAL in der
// Teams-Web-App: Anmeldung mit prompt=none über die Cookies der Sitzung, Code mit PKCE eintauschen.
// Ohne Electron-Abhängigkeit, damit die Tests die Datei direkt laden können.
import { createHash, randomBytes } from 'node:crypto'

// Client-ID der Teams-Web-App
export const TEAMS_WEB_CLIENT_ID = '5e3ce6c0-2b1f-4285-8d4b-75ee78787346'
const LOGIN = 'https://login.microsoftonline.com'

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export interface SilentRequest {
  authorizeUrl: string
  tokenUrl: string
  redirectUri: string
  verifier: string
  state: string
  scope: string
}

export function silentRequest(opts: { tenant: string; resource: string; webOrigin: string; loginHint?: string }): SilentRequest {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))
  const redirectUri = `${opts.webOrigin}/v2/authv2`
  const scope = `${opts.resource.replace(/\/+$/, '')}/.default openid profile offline_access`
  const q = new URLSearchParams({
    client_id: TEAMS_WEB_CLIENT_ID,
    scope,
    redirect_uri: redirectUri,
    response_mode: 'fragment',
    response_type: 'code',
    prompt: 'none',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    nonce: b64url(randomBytes(16)),
    client_info: '1'
  })
  if (opts.loginHint) q.set('login_hint', opts.loginHint)
  const tenant = encodeURIComponent(opts.tenant)
  return {
    authorizeUrl: `${LOGIN}/${tenant}/oauth2/v2.0/authorize?${q}`,
    tokenUrl: `${LOGIN}/${tenant}/oauth2/v2.0/token`,
    redirectUri,
    verifier,
    state,
    scope
  }
}

// Ergebnis der Weiterleitung auf redirect_uri: Code oder Fehler aus dem Fragment
export function parseRedirect(url: string, req: SilentRequest): { code: string } | { error: string } | null {
  if (!url.startsWith(req.redirectUri)) return null
  const hash = url.includes('#') ? url.slice(url.indexOf('#') + 1) : url.split('?')[1] ?? ''
  const p = new URLSearchParams(hash)
  if (p.get('error')) return { error: `${p.get('error')}: ${(p.get('error_description') ?? '').split(/\r?\n/)[0]}` }
  if (p.get('state') !== req.state) return { error: 'state passt nicht' }
  const code = p.get('code')
  return code ? { code } : { error: 'kein Code in der Antwort' }
}

export function tokenRequestBody(req: SilentRequest, code: string): string {
  return new URLSearchParams({
    client_id: TEAMS_WEB_CLIENT_ID,
    redirect_uri: req.redirectUri,
    scope: req.scope,
    code,
    code_verifier: req.verifier,
    grant_type: 'authorization_code',
    client_info: '1'
  }).toString()
}
