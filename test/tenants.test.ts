import assert from 'node:assert/strict'
import { test } from 'node:test'
import { foreignHome, guestSession, homeTenantOf, parseTenants } from '../src/main/tenants.ts'

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

test('Heimatmandant: Mitglied ohne idp, Gast mit dem Aussteller des Heimatmandanten', () => {
  const home = '11111111-2222-3333-4444-555555555555'
  const guest = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  // Mitglied im eigenen Mandanten
  assert.equal(homeTenantOf({ tid: home }), home)
  assert.equal(foreignHome({ tid: home }), undefined)
  // Als Gast in einem fremden Mandanten (v1- und v2-Aussteller, Großschreibung egal)
  assert.equal(homeTenantOf({ tid: guest, idp: `https://sts.windows.net/${home}/` }), home)
  assert.equal(foreignHome({ tid: guest, idp: `https://sts.windows.net/${home}/` }), home)
  assert.equal(foreignHome({ tid: guest.toUpperCase(), idp: `https://login.microsoftonline.com/${home.toUpperCase()}/v2.0` }), home)
  // idp eines anderen Anbieters: Heimatmandant unbekannt, also kein Rückweg
  assert.equal(homeTenantOf({ tid: guest, idp: 'live.com' }), undefined)
  assert.equal(foreignHome({ tid: guest, idp: 'live.com' }), undefined)
  // Ohne Token
  assert.equal(foreignHome({}), undefined)
  // Gastsitzung auch dann, wenn sich der Heimatmandant nicht lesen lässt
  assert.equal(guestSession({ tid: guest, idp: 'live.com' }), true)
  assert.equal(guestSession({ tid: guest, idp: `https://sts.windows.net/${home}/` }), true)
  assert.equal(guestSession({ tid: home }), false)
  assert.equal(guestSession({ tid: home, idp: `https://sts.windows.net/${home.toUpperCase()}/` }), false)
  assert.equal(guestSession({}), false)
})
