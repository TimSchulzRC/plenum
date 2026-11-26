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
