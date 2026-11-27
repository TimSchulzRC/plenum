import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TokenStore } from '../src/main/engine/tokens.ts'

// Erfundene Tokens: nur der mittlere Teil zählt, die Signatur prüft die App nicht
const jwt = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`
const HOME = '11111111-2222-3333-4444-555555555555'
const GUEST = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const auth = (claims: Record<string, unknown>) => ({ authorization: `Bearer ${jwt(claims)}` })

test('Identität der Sitzung: aus dem Chat-Dienst, nicht aus Spaces-Tokens anderer Mandanten', () => {
  const t = new TokenStore()
  t.capture('https://teams.microsoft.com/api/csa/emea/api/v3/teams/users/me', 'GET', auth({ aud: 'https://chatsvcagg.teams.microsoft.com', oid: 'me-home', tid: HOME, exp: 2000 }))
  assert.equal(t.me.tid, HOME)
  // Die Web-App holt für Mitteilungen aus dem Gastmandanten ein Spaces-Token dort (mit idp)
  t.capture('https://teams.microsoft.com/api/mt/emea/beta/users/tenantsv2', 'GET', auth({ aud: 'https://api.spaces.skype.com', oid: 'me-guest', tid: GUEST, idp: `https://sts.windows.net/${HOME}/`, exp: 9000 }))
  assert.equal(t.me.tid, HOME)
  assert.equal(t.me.oid, 'me-home')
  assert.equal(t.me.idp, undefined)
  // Läuft die ganze Sitzung im Gastmandanten, sagt es der Chat-Dienst
  t.capture('https://teams.microsoft.com/api/csa/emea/api/v3/teams/users/me', 'GET', auth({ aud: 'https://chatsvcagg.teams.microsoft.com', oid: 'me-guest', tid: GUEST, idp: `https://sts.windows.net/${HOME}/`, exp: 3000 }))
  assert.equal(t.me.tid, GUEST)
  assert.ok(t.me.idp)
})

test('Eigene Anfragen nehmen das Token des Mandanten der Sitzung, auch wenn ein fremdes länger gilt', () => {
  const t = new TokenStore()
  t.capture('https://teams.microsoft.com/api/csa/emea/api/v3/teams/users/me', 'GET', auth({ aud: 'https://chatsvcagg.teams.microsoft.com', oid: 'me-home', tid: HOME, exp: 2000 }))
  const home = jwt({ aud: 'https://api.spaces.skype.com', oid: 'me-home', tid: HOME, exp: 5000 })
  const guest = jwt({ aud: 'https://api.spaces.skype.com', oid: 'me-guest', tid: GUEST, idp: `https://sts.windows.net/${HOME}/`, exp: 9000 })
  t.capture('https://teams.microsoft.com/api/mt/emea/beta/users/x', 'GET', { authorization: `Bearer ${home}` })
  t.capture('https://teams.microsoft.com/api/mt/emea/beta/users/y', 'GET', { authorization: `Bearer ${guest}` })
  assert.equal(t.findBearer('api.spaces.skype.com'), home)
  assert.equal(t.bearerFor(['https://api.spaces.skype.com']), home)
  assert.equal(t.headersFor('mt').authorization, `Bearer ${home}`)
  // Gibt es keins im Mandanten der Sitzung, das neueste
  const outlook = jwt({ aud: 'https://outlook.office.com/', oid: 'me-guest', tid: GUEST, exp: 7000 })
  t.capture('https://outlook.office.com/api/v2.0/me/messages', 'GET', { authorization: `Bearer ${outlook}` })
  assert.equal(t.bearerFor(['https://outlook.office.com/']), outlook)
  // reset() verwirft alles
  t.reset()
  assert.equal(t.findBearer('api.spaces.skype.com'), undefined)
  assert.deepEqual(t.me, {})
})
