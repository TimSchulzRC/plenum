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
