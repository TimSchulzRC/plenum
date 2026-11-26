import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTenants } from '../src/main/tenants.ts'

test('Mandantenliste aus tenantsv2: aktueller Mandant zuerst, offene Einladungen fallen weg', () => {
  const raw = [
    { tenantId: 't2', tenantName: 'Zeta GmbH', userType: 'guest', isInvitationRedeemed: true },
    { tenantId: 't1', tenantName: 'Heimat AG', userType: 'member', isInvitationRedeemed: true, isTenantHidden: false },
    { tenantId: 't3', tenantName: 'Alpha KG', userType: 'guest', isInvitationRedeemed: false },
    { tenantId: 't4', tenantName: ' Beta SE ', userType: 'guest', isTenantHidden: true },
    { tenantId: 't4', tenantName: 'Beta SE doppelt', userType: 'guest' }
  ]
  assert.deepEqual(parseTenants(raw, 't1'), [
    { tenantId: 't1', tenantName: 'Heimat AG', guest: false, current: true, hidden: false },
    { tenantId: 't4', tenantName: 'Beta SE', guest: true, current: false, hidden: true },
    { tenantId: 't2', tenantName: 'Zeta GmbH', guest: true, current: false, hidden: false }
  ])
})

test('Mandantenliste: leere oder fremde Antworten ergeben eine leere Liste', () => {
  assert.deepEqual(parseTenants(null), [])
  assert.deepEqual(parseTenants({ error: 'x' }), [])
  assert.deepEqual(parseTenants([{ id: 'ohne-tenantId' }, 'kaputt']), [])
})
