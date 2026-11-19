import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conversationOf, parseRealtimeFrame } from '../src/main/engine/realtime.ts'

const HOST = 'https://emea.ng.msg.teams.microsoft.com'

// Trouter-Frame wie im WebSocket der Web-App: Der Body ist JSON in einem String.
function frame(body: unknown): string {
  return `3:::${JSON.stringify({ id: 7, method: 'POST', url: '/v4/f/abc/messaging', headers: {}, body: JSON.stringify(body) })}`
}

function message(resourceType: string, resource: Record<string, unknown>) {
  return { time: '2026-11-19T10:00:00Z', type: 'EventMessage', resourceType, resourceLink: `${HOST}/v1/users/ME/conversations/x/messages/1`, resource }
}

test('Lesebestätigung eines anderen: Chat und Leser', () => {
  const evs = parseRealtimeFrame(
    frame(
      message('NewMessage', {
        id: '1763546400000',
        messagetype: 'ThreadActivity/MemberConsumptionHorizonUpdate',
        conversationLink: `${HOST}/v1/users/ME/conversations/19:abc_def@unq.gbl.spaces`,
        from: `${HOST}/v1/users/ME/contacts/19:abc_def@unq.gbl.spaces`,
        content: JSON.stringify({ user: '8:orgid:1111-2222', consumptionhorizon: '1763546300000;1763546400000;123' })
      })
    )
  )
  assert.deepEqual(evs, [{ kind: 'read-receipt', conversationId: '19:abc_def@unq.gbl.spaces', from: '8:orgid:1111-2222' }])
})

test('Neue Nachricht, Bearbeitung und Tippen', () => {
  const conv = `${HOST}/v1/users/ME/conversations/19%3Aroom%40thread.v2`
  assert.deepEqual(parseRealtimeFrame(frame(message('NewMessage', { messagetype: 'RichText/Html', conversationLink: conv }))), [
    { kind: 'new-message', conversationId: '19:room@thread.v2' }
  ])
  assert.deepEqual(parseRealtimeFrame(frame(message('MessageUpdate', { messagetype: 'RichText/Html', conversationLink: conv }))), [
    { kind: 'message-update', conversationId: '19:room@thread.v2' }
  ])
  const typing = parseRealtimeFrame(
    frame(message('NewMessage', { messagetype: 'Control/Typing', conversationLink: conv, from: `${HOST}/v1/users/ME/contacts/8:orgid:9999`, imdisplayname: 'Muster, Max' }))
  )
  assert.deepEqual(typing, [{ kind: 'typing', conversationId: '19:room@thread.v2', from: '8:orgid:9999', name: 'Muster, Max', clear: false }])
})

test('ThreadUpdate ohne conversationLink: ID aus dem /threads/-Link', () => {
  const evs = parseRealtimeFrame(
    frame({ resourceType: 'ThreadUpdate', resourceLink: `${HOST}/v1/threads/19%3Aroom%40thread.v2`, resource: { properties: {} } })
  )
  assert.deepEqual(evs, [{ kind: 'thread-update', conversationId: '19:room@thread.v2' }])
})

test('Kanalantwort: ID ohne ;messageid', () => {
  assert.equal(conversationOf({ conversationLink: `${HOST}/v1/users/ME/conversations/19:chan@thread.tacv2;messageid=1700` }), '19:chan@thread.tacv2')
})

test('Kein Trouter-Frame oder unlesbarer Body: null für den Rückfall', () => {
  assert.equal(parseRealtimeFrame('2::'), null)
  assert.equal(parseRealtimeFrame('5:1+::{"name":"ping"}'), null)
  assert.equal(parseRealtimeFrame(`3:::${JSON.stringify({ id: 1, url: '/v4/f/abc/messaging', body: 'H4sIAAAA' })}`), null)
  assert.equal(parseRealtimeFrame(`3:::${JSON.stringify({ id: 1, url: '/v4/f/abc/unifiedPresenceService', body: JSON.stringify({ presence: [] }) })}`), null)
})
