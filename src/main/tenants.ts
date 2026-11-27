// Mandantenliste der Teams-Web-App (GET {mt}/beta/users/tenantsv2) lesen.
// Ohne Electron-Abhängigkeit, damit die Tests sie laden können.
import type { TenantInfo } from '../shared/types'

/* eslint-disable @typescript-eslint/no-explicit-any */
// currentTenantId: Mandant, in dem die Web-App des Kontos gerade läuft (tid aus dem Token)
export function parseTenants(raw: unknown, currentTenantId?: string): TenantInfo[] {
  const list: any[] = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.value) ? (raw as any).value : []
  const out: TenantInfo[] = []
  for (const t of list) {
    const tenantId = typeof t?.tenantId === 'string' ? t.tenantId : ''
    if (!tenantId || out.some((x) => x.tenantId === tenantId)) continue
    // Offene Einladungen nimmt die Web-App erst beim Wechsel an, die bieten wir nicht an
    if (t.isInvitationRedeemed === false) continue
    const name = typeof t.tenantName === 'string' && t.tenantName.trim() ? t.tenantName.trim() : undefined
    out.push({
      tenantId,
      tenantName: name,
      // Die Web-App kennt kein Feld für den Heimatmandanten, dort ist man Mitglied statt Gast
      guest: String(t.userType ?? '').toLowerCase() === 'guest',
      current: tenantId === currentTenantId,
      hidden: t.isTenantHidden === true
    })
  }
  // Aktueller Mandant zuerst, dann nach Name
  return out.sort((a, b) => Number(b.current) - Number(a.current) || (a.tenantName ?? '').localeCompare(b.tenantName ?? '', 'de'))
}

// Heimatmandant der angemeldeten Person nach dem Token der Web-App. Als Gast trägt das Token den
// Aussteller des Heimatmandanten im idp-Claim, als Mitglied fehlt er, dann ist es der Mandant selbst.
// Ein anderer Anbieter (z. B. live.com): unbekannt.
export function homeTenantOf(me: { tid?: string; idp?: string }): string | undefined {
  if (!me.idp) return me.tid?.toLowerCase()
  const m = /^https:\/\/(?:sts\.windows\.net|login\.microsoftonline\.com)\/([0-9a-f-]{36})(?:\/|$)/i.exec(me.idp)
  return m?.[1].toLowerCase()
}

// Die Web-App eines Hauptkontos läuft als Gast in einem fremden Mandanten: Heimatmandant, sonst undefined
export function foreignHome(me: { tid?: string; idp?: string }): string | undefined {
  const home = homeTenantOf(me)
  return home && me.tid && home !== me.tid.toLowerCase() ? home : undefined
}

// Läuft die Sitzung als Gast? Ein idp-Claim, dessen Mandant nicht der eigene ist oder sich nicht lesen lässt
export const guestSession = (me: { tid?: string; idp?: string }): boolean => !!me.idp && homeTenantOf(me) !== me.tid?.toLowerCase()
