// URLs für Bilder, die über den Hauptprozess mit den Teams-Tokens geladen werden.
export function avatarUrl(accountId: string, mri: string, name = '', size = 'HR96x96'): string | undefined {
  if (!mri || !accountId || !mri.startsWith('8:')) return undefined
  return `tmimg://avatar/${accountId}/${encodeURIComponent(mri)}?name=${encodeURIComponent(name)}&size=${size}`
}

// Profilbild zu einer Mailadresse. Der Hauptprozess sucht die Person in Teams, kennt Teams sie nicht,
// antwortet er mit 404 und das Avatar zeigt die Initialen.
export function mailAvatarUrl(accountId: string, address: string | undefined, name = '', size = 'HR64x64'): string | undefined {
  const a = address?.trim().toLowerCase()
  if (!accountId || !a || !a.includes('@')) return undefined
  return `tmimg://mailavatar/${accountId}/${encodeURIComponent(a)}?name=${encodeURIComponent(name)}&size=${size}`
}

export function teamPictureUrl(accountId: string, groupId: string | undefined, etag: string | undefined, name: string): string | undefined {
  if (!groupId) return undefined
  return `tmimg://team/${accountId}/${encodeURIComponent(groupId)}?name=${encodeURIComponent(name)}&etag=${encodeURIComponent(etag ?? '')}`
}

export function proxyUrl(accountId: string, url: string): string {
  return `tmimg://proxy/${accountId}/x?u=${encodeURIComponent(url)}`
}

const PUBLIC_HOSTS = /(^|\.)(statics\.teams\.cdn\.office\.net|res\.cdn\.office\.net|static\.teams\.cdn\.office\.net|media\.giphy\.com|giphy\.com)$/

export function needsProxy(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && !PUBLIC_HOSTS.test(u.hostname)
  } catch {
    return false
  }
}
