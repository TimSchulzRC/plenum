import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAmsView, isChatMessagesPage, isTeamsUrl, loginCookieToSet, mayReceiveTokens, teamsStartUrl } from '../src/main/engine/hosts.ts'
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

test('MCP: Cursor nur auf Nachrichtenseiten des Chat-Dienstes', () => {
  assert.equal(isChatMessagesPage('https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations/19%3Aabc%40thread.v2/messages?startTime=1&syncState=x'), true)
  assert.equal(isChatMessagesPage('https://teams.microsoft.com/api/chatsvc/emea/v1/users/ME/conversations/19%3Aabc%40thread.tacv2%3Bmessageid%3D1/messages?pageSize=20'), true)
  assert.equal(isChatMessagesPage('https://emea.ng.msg.teams.microsoft.com/v1/users/ME/properties'), false)
  assert.equal(isChatMessagesPage('https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations/19%3Aabc/messages/123'), false)
  assert.equal(isChatMessagesPage('https://evil.example/v1/users/ME/conversations/19%3Aabc/messages'), false)
  // Andere Microsoft-Hosts mit passendem Pfad sind nicht der Chat-Dienst
  assert.equal(isChatMessagesPage('https://login.microsoftonline.com/api/chatsvc/emea/v1/users/ME/conversations/19%3Aabc/messages'), false)
  assert.equal(isChatMessagesPage('https://graph.microsoft.com/v1/users/ME/conversations/19%3Aabc/messages'), false)
})

test('MCP: Bilder nur als Ansicht eines AMS-Objekts auf Microsoft-Hosts', () => {
  assert.equal(isAmsView('https://eu-api.asm.skype.com/v1/objects/0-weu-d1-abc/views/imgo'), true)
  assert.equal(isAmsView('https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/0-weu-d1-abc/views/imgpsh_fullsize'), true)
  assert.equal(isAmsView('https://eu-api.asm.skype.com/v1/objects/0-weu-d1-abc/content/imgpsh'), false)
  assert.equal(isAmsView('https://x.ams.evil.example/v1/objects/a/views/imgo'), false)
  assert.equal(isAmsView('https://graph.microsoft.com/v1.0/me/messages'), false)
})

test('nur Anmelde-Cookies von Entra ID wandern in die Sitzung eines Gastmandanten', () => {
  assert.equal(loginCookieToSet({ name: 'x', value: '1', domain: 'teams.microsoft.com', path: '/' }), null)
  assert.equal(loginCookieToSet({ name: 'x', value: '1', domain: '.evil-login.microsoftonline.com.example' }), null)
  assert.deepEqual(loginCookieToSet({ name: 'ESTSAUTHPERSISTENT', value: 'v', domain: '.login.microsoftonline.com', path: '/', secure: true, httpOnly: true, expirationDate: 99, sameSite: 'no_restriction' }), {
    url: 'https://login.microsoftonline.com/',
    name: 'ESTSAUTHPERSISTENT',
    value: 'v',
    domain: '.login.microsoftonline.com',
    path: '/',
    secure: true,
    httpOnly: true,
    expirationDate: 99,
    sameSite: 'no_restriction'
  })
  // Host-Cookie ohne Punkt bleibt Host-Cookie
  assert.equal(loginCookieToSet({ name: 'buid', value: 'v', domain: 'login.microsoftonline.com', path: '/' })?.domain, undefined)
})

test('Gastmandant startet die Web-App mit tenantId', () => {
  assert.equal(teamsStartUrl('https://teams.microsoft.com/v2/'), 'https://teams.microsoft.com/v2/')
  assert.equal(teamsStartUrl('https://teams.microsoft.com/v2/', 'a1b2-c3'), 'https://teams.microsoft.com/v2/?tenantId=a1b2-c3')
  assert.equal(teamsStartUrl('https://teams.microsoft.com/v2/', 'a1b2-c3', 'alex@contoso.com'), 'https://teams.microsoft.com/v2/?tenantId=a1b2-c3&login_hint=alex%40contoso.com')
})
