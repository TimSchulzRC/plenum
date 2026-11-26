import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NO_CALENDAR_TOKEN, firstWriter, graphEventBody, mayTryNextWriter, outlookEventBody } from '../src/main/engine/events.ts'

process.env.TZ = 'Europe/Berlin'

const base = { subject: 'Kickoff', attendees: [], teamsMeeting: false, isAllDay: false }

test('Termin mit Uhrzeit geht als UTC raus', () => {
  const start = new Date(2026, 10, 26, 10, 0).getTime()
  const b = graphEventBody({ ...base, start, end: start + 3600_000 })
  assert.deepEqual(b.start, { dateTime: '2026-11-26T09:00:00', timeZone: 'UTC' })
  assert.deepEqual(b.end, { dateTime: '2026-11-26T10:00:00', timeZone: 'UTC' })
  assert.equal(b.isOnlineMeeting, undefined)
  assert.equal(b.body, undefined)
})

test('Ganztägig zählen die lokalen Kalendertage, nicht die UTC-Zeitpunkte', () => {
  // Lokale Mitternacht in Berlin ist 23:00 UTC am Vortag
  const start = new Date(2026, 10, 27).getTime()
  const end = new Date(2026, 10, 29).getTime()
  const b = graphEventBody({ ...base, isAllDay: true, start, end })
  assert.deepEqual(b.start, { dateTime: '2026-11-27T00:00:00', timeZone: 'UTC' })
  assert.deepEqual(b.end, { dateTime: '2026-11-29T00:00:00', timeZone: 'UTC' })
  assert.equal(b.isAllDay, true)
})

test('Teams-Besprechung, Teilnehmer, Ort und Text', () => {
  const start = Date.UTC(2026, 10, 26, 9)
  const ev = { ...base, start, end: start + 1800_000, teamsMeeting: true, attendees: ['kim@fabrikam.de'], location: 'Raum 1', body: 'Agenda' }
  const g = graphEventBody(ev)
  assert.equal(g.isOnlineMeeting, true)
  assert.equal(g.onlineMeetingProvider, 'teamsForBusiness')
  assert.deepEqual(g.attendees, [{ emailAddress: { address: 'kim@fabrikam.de' }, type: 'required' }])
  assert.deepEqual(g.location, { displayName: 'Raum 1' })
  assert.deepEqual(g.body, { contentType: 'text', content: 'Agenda' })
  const o = outlookEventBody(ev)
  assert.equal(o.IsOnlineMeeting, true)
  assert.equal(o.OnlineMeetingProvider, 'TeamsForBusiness')
  assert.deepEqual(o.Attendees, [{ EmailAddress: { Address: 'kim@fabrikam.de' }, Type: 'Required' }])
  assert.deepEqual(o.Start, { DateTime: '2026-11-26T09:00:00', TimeZone: 'UTC' })
})

test('Nur wenn sicher nichts angelegt wurde, kommt der nächste Weg dran', () => {
  for (const s of [0, 401, 403, 404, 405]) assert.equal(mayTryNextWriter(s), true, String(s))
  for (const s of [-1, 400, 408, 409, 429, 500, 502, 503, 504]) assert.equal(mayTryNextWriter(s), false, String(s))
})

const fail = (status: number | undefined, message: string) => () => Promise.reject(Object.assign(new Error(message), status === undefined ? {} : { status }))

test('Ohne Berechtigung bei Graph versucht es Outlook', async () => {
  const calls: string[] = []
  const r = await firstWriter([
    ['graph', () => (calls.push('graph'), fail(403, 'graph 403')())],
    ['outlook', async () => (calls.push('outlook'), { Id: 'x' })]
  ])
  assert.deepEqual(calls, ['graph', 'outlook'])
  assert.equal(r.source, 'outlook')
})

test('Serverfehler oder Netzfehler: kein zweiter Versuch, sonst droht ein doppelter Termin', async () => {
  for (const status of [500, 504, undefined]) {
    let outlook = false
    await assert.rejects(
      firstWriter([
        ['graph', fail(status, 'kaputt')],
        ['outlook', async () => ((outlook = true), {})]
      ]),
      /Unklar, ob der Termin angelegt wurde \(graph: kaputt\)\. Sieh im Kalender nach/
    )
    assert.equal(outlook, false, String(status))
  }
})

test('Abgelehnt (400) heißt sicher nicht angelegt', async () => {
  await assert.rejects(firstWriter([['graph', fail(400, 'graph 400')]]), /^Error: Termin nicht angelegt \(graph: graph 400\)$/)
})

test('Ohne Token eine verständliche Meldung', async () => {
  await assert.rejects(firstWriter([]), (e: Error) => e.message === NO_CALENDAR_TOKEN)
})
