import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isTeamsUrl, mayReceiveTokens } from '../src/main/engine/hosts.ts'
import { classify } from '../src/main/engine/tokens.ts'

test('Bild-URLs fremder Hosts bekommen keine Tokens, auch wenn der Pfad nach Teams-API aussieht', () => {
  const evil = 'https://evil.example/api/mt/emea/a.png'
  // classify allein schaut nur auf den Pfad und hielte das für die mt-API
  assert.equal(classify(evil)?.family, 'mt')
  assert.equal(mayReceiveTokens(evil), false)
  assert.equal(mayReceiveTokens('https://evil.example/x/api/chatsvc/emea/v1/a'), false)
  assert.equal(mayReceiveTokens('https://contoso.sharepoint.com/api/mt/emea/a.png'), false)
  assert.equal(mayReceiveTokens('https://teams.microsoft.com.evil.example/api/mt/emea/a.png'), false)
  assert.equal(mayReceiveTokens('http://teams.microsoft.com/api/mt/emea/a.png'), false)
})

test('Microsoft-Hosts bekommen weiter Tokens', () => {
  assert.equal(mayReceiveTokens('https://teams.microsoft.com/api/mt/emea/beta/users/x/profilepicturev2'), true)
  assert.equal(mayReceiveTokens('https://eu-api.asm.skype.com/v1/objects/0-weu-d1-abc/views/imgo'), true)
  assert.equal(mayReceiveTokens('https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations'), true)
  assert.equal(mayReceiveTokens('https://graph.microsoft.com/v1.0/me/photo/$value'), true)
  assert.equal(mayReceiveTokens('https://teams.cloud.microsoft/api/mt/emea/a'), true)
})

test('Nur Teams-Links öffnen sich in der Web-App', () => {
  assert.equal(isTeamsUrl('https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0'), true)
  assert.equal(isTeamsUrl('https://teams.microsoft.com/meet/3881234567?p=abc'), true)
  assert.equal(isTeamsUrl('https://teams.live.com/meet/9876'), true)
  assert.equal(isTeamsUrl('https://teams.cloud.microsoft/l/meetup-join/x'), true)
  assert.equal(isTeamsUrl('https://us02web.zoom.us/j/123456789'), false)
  assert.equal(isTeamsUrl('https://evil.example/teams.microsoft.com'), false)
  assert.equal(isTeamsUrl('https://teams.microsoft.com.evil.example/l/meetup-join/x'), false)
  assert.equal(isTeamsUrl('javascript:alert(1)'), false)
  assert.equal(isTeamsUrl('not a url'), false)
})
