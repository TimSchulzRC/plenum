import assert from 'node:assert/strict'
import { test } from 'node:test'
import { usageFor, type UsageContext } from '../src/main/usage-events.ts'

const ctx: UsageContext = { conversationKind: (_a, c) => (c === 'channel-1' ? 'channel' : 'group') }

test('Nachricht: Art und Merkmale, nie Inhalt oder IDs', () => {
  const html = '<p>Geheimer Plan mit <a href="https://intern.example">Link</a></p><img src="data:image/png;base64,AAA">'
  const spec = usageFor('sendMessage', ['acc-1', 'chat-1', html, { replyToId: '123', importance: 'high' }], ctx)
  assert.deepEqual(spec, {
    event: 'message_sent',
    props: { conversation_kind: 'group', is_thread_reply: true, has_subject: false, importance: 'high', has_images: true, has_quote: false, has_code: false, has_list: false, has_link: true }
  })
  assert.doesNotMatch(JSON.stringify(spec), /Geheim|intern\.example|chat-1|acc-1|123/)
})

test('Kanal wird als Kanal erkannt', () => {
  assert.equal(usageFor('deleteMessage', ['acc', 'channel-1', 'm'], ctx)?.props?.conversation_kind, 'channel')
})

test('Reaktionen: bekannte Schlüssel bleiben, alles andere wird zu other', () => {
  assert.equal(usageFor('setReaction', ['a', 'c', 'm', 'heart', true], ctx)?.props?.reaction, 'heart')
  assert.equal(usageFor('setReaction', ['a', 'c', 'm', 'x y <script>', false], ctx)?.props?.reaction, 'other')
  assert.equal(usageFor('setReaction', ['a', 'c', 'm', 'heart', false], ctx)?.event, 'reaction_removed')
})

test('Personensuche: ohne Suchbegriff und gedrosselt', () => {
  const spec = usageFor('searchPeople', ['acc', 'Max Mustermann'], ctx)
  assert.equal(spec?.event, 'people_searched')
  assert.ok(spec?.throttleMs)
  assert.doesNotMatch(JSON.stringify(spec), /Mustermann/)
})

test('Anrufe und Freigaben', () => {
  assert.deepEqual(usageFor('startCall', ['acc', { mris: ['8:orgid:x', '8:orgid:y'] }, true], ctx), {
    event: 'call_start_clicked',
    props: { video: true, target: 'people', people: 2 }
  })
  assert.equal(usageFor('pickDisplaySource', ['screen:1:0'], ctx)?.props?.kind, 'screen')
  assert.equal(usageFor('pickDisplaySource', ['window:42:0'], ctx)?.props?.kind, 'window')
  assert.equal(usageFor('pickDisplaySource', [null], ctx)?.props?.kind, 'cancelled')
})

test('Lesende Aufrufe und Kontextmenüs sind kein Nutzungsereignis', () => {
  assert.equal(usageFor('getMessages', ['acc', 'chat'], ctx), null)
  assert.equal(usageFor('imageAction', ['src', 'menu', 0, 0], ctx), null)
  assert.equal(usageFor('imageAction', ['src', 'save', 0, 0], ctx)?.event, 'image_action')
})

test('MCP: Client und Ergebnis, sonst nichts', () => {
  const spec = usageFor('installMcp', ['codex'], ctx)
  assert.equal(spec?.event, 'mcp_install_clicked')
  assert.deepEqual(spec?.props, { client: 'codex' })
  assert.deepEqual(spec?.resultProps?.({ ok: true, message: 'codex mcp add plenum --url http://127.0.0.1:47311/mcp/geheim' }), { ok: true })
  assert.deepEqual(usageFor('setMcpEnabled', [false], ctx), { event: 'mcp_toggled', props: { on: false } })
})

test('Testmitteilung meldet, ob sie ankam', () => {
  const spec = usageFor('testNotification', [], ctx)
  assert.deepEqual(spec?.resultProps?.({ ok: false, error: 'denied' }), { ok: false, error: 'denied' })
})

test('Neuer Termin: nur Merkmale, nie Titel, Ort, Text oder Adressen', () => {
  const ev = { subject: 'Geheimes Projekt', start: 1, end: 2, isAllDay: false, location: 'Raum Elbe', attendees: ['kim@fabrikam.de', 'robin@fabrikam.de'], teamsMeeting: true, body: 'Agenda' }
  const spec = usageFor('createEvent', ['acc-1', ev], ctx)
  assert.deepEqual(spec, {
    event: 'calendar_event_created',
    props: { all_day: false, teams_meeting: true, attendees: 2, has_location: true, has_body: true }
  })
  assert.doesNotMatch(JSON.stringify(spec), /Geheim|Elbe|fabrikam|Agenda|acc-1/)
})

test('Mail gesendet: Art und Anzahl, nie Adressen, Betreff, Text oder Dateinamen', () => {
  const draft = { to: ['kim@fabrikam.de'], cc: ['robin@fabrikam.de'], subject: 'Geheim', text: 'Vertraulich', attachments: [{ name: 'plan.pdf', contentType: 'application/pdf', data: 'AAA' }] }
  const spec = usageFor('sendMail', ['acc-1', draft, { id: 'AAMk', kind: 'replyAll' }], ctx)
  assert.deepEqual(spec, { event: 'mail_sent', props: { kind: 'replyAll', recipients: 2, attachments: 1 } })
  assert.doesNotMatch(JSON.stringify(spec), /fabrikam|Geheim|Vertraulich|plan|AAMk|acc-1/)
  assert.equal(usageFor('sendMail', ['acc-1', draft], ctx)?.props?.kind, 'new')
})
