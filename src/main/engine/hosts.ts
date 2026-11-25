// Hostprüfungen ohne Electron-Abhängigkeit, damit die Tests sie direkt laden können.

function hostOf(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl)
    return u.protocol === 'https:' ? u.hostname : null
  } catch {
    return null
  }
}

// Hosts, an die wir die Tokens der Web-App schicken dürfen. Ohne sharepoint.com und windows.net,
// denn deren Subdomains gehören beliebigen Mandanten.
const TOKEN_HOSTS = /(^|\.)(microsoft\.com|cloud\.microsoft|office\.com|office\.net|live\.com|skype\.com|microsoft\.us)$/

export function mayReceiveTokens(rawUrl: string): boolean {
  const h = hostOf(rawUrl)
  return !!h && TOKEN_HOSTS.test(h)
}

// Links, die die Teams-Web-App selbst öffnen kann (Besprechungen, Chats).
const TEAMS_HOSTS = /(^|\.)teams\.(microsoft\.com|cloud\.microsoft|live\.com|microsoft\.us)$/

export function isTeamsUrl(rawUrl: string): boolean {
  const h = hostOf(rawUrl)
  return !!h && TEAMS_HOSTS.test(h)
}

// Nachrichtenseite einer Unterhaltung im Chat-Dienst (z. B. der Cursor für ältere Seiten im MCP-Server):
// <region>.ng.msg.teams.microsoft.com/v1/… oder teams.microsoft.com/api/chatsvc/<region>/v1/…
export function isChatMessagesPage(rawUrl: string): boolean {
  if (!mayReceiveTokens(rawUrl)) return false
  const u = new URL(rawUrl)
  const page = /^\/v1\/users\/[^/]+\/conversations\/[^/]+\/messages$/
  if (/(^|\.)msg\.teams\.microsoft\.com$/.test(u.hostname)) return page.test(u.pathname)
  const m = u.pathname.match(/^\/api\/chatsvc\/[^/]+(\/.*)$/)
  return TEAMS_HOSTS.test(u.hostname) && !!m && page.test(m[1])
}

// Ansicht eines Bildes im Async Media Service von Teams
const AMS_HOSTS = /(^|\.)(asm\.skype\.com|asyncgw\.teams\.microsoft\.com)$|\.ams\./
export function isAmsView(rawUrl: string): boolean {
  if (!mayReceiveTokens(rawUrl)) return false
  const u = new URL(rawUrl)
  return AMS_HOSTS.test(u.hostname) && /^\/v1\/objects\/[^/]+\/views\/[^/]+$/.test(u.pathname)
}
