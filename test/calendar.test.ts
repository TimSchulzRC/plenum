import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ACCOUNT_COLORS, accountColor, allDayOn, dragRange, findMeetingChat, ipcErrorText, localTime, mergeCalendars, parseAttendees, planEvents, wallHours } from '../src/renderer/src/lib/calendar.ts'

process.env.TZ = 'Europe/Berlin'

test('Ganztägiger Termin aus Graph (Mitternacht UTC) steht nur an seinem Tag', () => {
  const ev = { start: Date.parse('2026-11-18T00:00:00Z'), end: Date.parse('2026-11-19T00:00:00Z') }
  // Alte Prüfung: Ende 19.11. 01:00 Berlin liegt nach Beginn des 19.11. und zählte doppelt
  const nov19 = new Date(2026, 10, 19)
  assert.equal(ev.end > nov19.getTime(), true)
  assert.equal(allDayOn(ev, new Date(2026, 10, 17)), false)
  assert.equal(allDayOn(ev, new Date(2026, 10, 18)), true)
  assert.equal(allDayOn(ev, nov19), false)
})

test('Mehrtägig und als lokale Mitternacht geliefert', () => {
  const ev = { start: Date.parse('2026-11-17T23:00:00Z'), end: Date.parse('2026-11-19T23:00:00Z') }
  assert.equal(allDayOn(ev, new Date(2026, 10, 17)), false)
  assert.equal(allDayOn(ev, new Date(2026, 10, 18)), true)
  assert.equal(allDayOn(ev, new Date(2026, 10, 19)), true)
  assert.equal(allDayOn(ev, new Date(2026, 10, 20)), false)
})

test('Termin ohne Dauer belegt seinen Tag', () => {
  const t = Date.parse('2026-11-18T00:00:00Z')
  assert.equal(allDayOn({ start: t, end: t }, new Date(2026, 10, 18)), true)
})

test('Am Tag der Zeitumstellung steht 10:00 auf der 10-Uhr-Zeile', () => {
  // 25.10.2026: um 03:00 zurück auf 02:00, der Tag hat 25 Stunden
  const ten = new Date(2026, 9, 25, 10, 0).getTime()
  const midnight = new Date(2026, 9, 25).getTime()
  assert.equal((ten - midnight) / 3600_000, 11)
  assert.equal(wallHours(ten), 10)
  assert.equal(wallHours(new Date(2026, 2, 29, 10, 30).getTime()), 10.5)
})

const H = 3600_000
const t0 = Date.parse('2026-11-26T09:00:00Z')
const ev = (id: string, extra: Partial<{ start: number; end: number; iCalUId: string; joinUrl: string; isCancelled: boolean }> = {}) => ({
  id,
  start: t0,
  end: t0 + H,
  ...extra
})

test('Derselbe Termin in zwei Konten erscheint einmal mit beiden Konten', () => {
  const merged = mergeCalendars([
    { accountId: 'a', events: [ev('a1', { iCalUId: 'UID-1' }), ev('a2', { start: t0 + 2 * H, end: t0 + 3 * H })] },
    { accountId: 'b', events: [ev('b1', { iCalUId: 'uid-1' })] }
  ])
  assert.equal(merged.length, 2)
  assert.deepEqual(merged[0].sources.map((s) => s.accountId), ['a', 'b'])
  assert.equal(merged[0].event.id, 'a1')
  assert.deepEqual(merged[1].sources.map((s) => s.accountId), ['a'])
})

test('Ohne iCal-UID zählt der Teilnahmelink, Abfrageparameter egal', () => {
  const link = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0'
  const merged = mergeCalendars([
    { accountId: 'a', events: [ev('a1', { joinUrl: `${link}?context=%7b%22Tid%22%3a%22x%22%7d` })] },
    { accountId: 'b', events: [ev('b1', { iCalUId: 'other', joinUrl: `${link}?context=%7b%22Tid%22%3a%22y%22%7d` })] }
  ])
  assert.equal(merged.length, 1)
  assert.deepEqual(merged[0].sources.map((s) => s.accountId), ['a', 'b'])
})

test('Gleicher Link, andere Zeit: Vorkommen einer Serie bleiben getrennt', () => {
  const joinUrl = 'https://teams.microsoft.com/l/meetup-join/series'
  const merged = mergeCalendars([
    { accountId: 'a', events: [ev('a1', { joinUrl }), ev('a2', { joinUrl, start: t0 + 24 * H, end: t0 + 25 * H })] },
    { accountId: 'b', events: [ev('b1', { joinUrl, start: t0 + 24 * H, end: t0 + 25 * H })] }
  ])
  assert.equal(merged.length, 2)
  assert.deepEqual(merged[1].sources.map((s) => s.accountId), ['a', 'b'])
})

test('Termine im selben Konto werden nie zusammengelegt', () => {
  const merged = mergeCalendars([{ accountId: 'a', events: [ev('a1', { iCalUId: 'x' }), ev('a2', { iCalUId: 'x' })] }])
  assert.equal(merged.length, 2)
})

test('Ohne UID, Link und Titel bleiben gleich lange Termine getrennt', () => {
  const merged = mergeCalendars([
    { accountId: 'a', events: [ev('a1')] },
    { accountId: 'b', events: [ev('b1')] }
  ])
  assert.equal(merged.length, 2)
})

test('Abgesagt nur, wenn alle Kalender absagen', () => {
  const merged = mergeCalendars([
    { accountId: 'a', events: [ev('a1', { iCalUId: 'x', isCancelled: true })] },
    { accountId: 'b', events: [ev('b1', { iCalUId: 'x' })] }
  ])
  assert.equal(merged[0].event.isCancelled, undefined)
  assert.equal(merged[0].sources.length, 2)
})

test('Kontofarben: erstes Konto behält die Markenfarbe, Reihenfolge bestimmt die Farbe', () => {
  assert.equal(accountColor(['a', 'b'], 'a'), ACCOUNT_COLORS[0])
  assert.equal(accountColor(['a', 'b'], 'b'), ACCOUNT_COLORS[1])
  assert.equal(accountColor(['a'], 'unbekannt'), ACCOUNT_COLORS[0])
})

test('Teilnehmer: Komma, Semikolon, Leerzeichen und „Name <adresse>“', () => {
  assert.deepEqual(parseAttendees('a@x.de, b@y.com;c@z.org  A@x.de'), { valid: ['a@x.de', 'b@y.com', 'c@z.org'], invalid: [] })
  assert.deepEqual(parseAttendees('Max <max@firma.de>, kaputt'), { valid: ['max@firma.de'], invalid: ['kaputt'] })
  assert.deepEqual(parseAttendees('  '), { valid: [], invalid: [] })
})

test('Besprechungschat: bevorzugtes Konto zuerst, dann die anderen, dann deren Gastmandanten', () => {
  const join = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x'
  const sources = [
    { accountId: 'a', event: { joinUrl: join } },
    { accountId: 'b', event: { threadId: '19:meeting_abc@thread.v2' } }
  ]
  const chats: Record<string, { id: string; meeting?: { joinUrl?: string } }[]> = {
    a: [{ id: '19:meeting_abc@thread.v2', meeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=y' } }],
    b: [{ id: '19:meeting_abc@thread.v2' }]
  }
  const none = () => []
  assert.deepEqual(findMeetingChat(sources, 'b', none, (id) => chats[id]), { accountId: 'b', chatId: '19:meeting_abc@thread.v2' })
  assert.deepEqual(findMeetingChat(sources, 'x', none, (id) => chats[id]), { accountId: 'a', chatId: '19:meeting_abc@thread.v2' })
  // Nur der Gastmandant von a kennt den Chat
  const guestChats: Record<string, { id: string; meeting?: { joinUrl?: string } }[]> = { a: [], b: [], 'a-g': [{ id: 'g-chat', meeting: { joinUrl: join } }] }
  const guests = (id: string) => (id === 'a' ? ['a-g'] : [])
  assert.deepEqual(findMeetingChat(sources, 'b', guests, (id) => guestChats[id]), { accountId: 'a-g', chatId: 'g-chat' })
  // Ein eingeladenes Konto geht vor jedem Gastmandanten
  assert.deepEqual(findMeetingChat(sources, 'a', guests, (id) => ({ ...guestChats, b: chats.b })[id]), { accountId: 'b', chatId: '19:meeting_abc@thread.v2' })
  assert.equal(findMeetingChat([{ accountId: 'a', event: {} }], 'a', guests, (id) => guestChats[id]), undefined)
  // Nur die Kopie von b trägt die Thread-ID, den Chat kennt aber nur der Gastmandant von a
  const split = [
    { accountId: 'a', event: {} },
    { accountId: 'b', event: { threadId: 'g-chat' } }
  ]
  assert.deepEqual(findMeetingChat(split, 'a', guests, (id) => guestChats[id]), { accountId: 'a-g', chatId: 'g-chat' })
})

test('Fehlertext ohne Electron-Vorsatz', () => {
  assert.equal(ipcErrorText(new Error("Error invoking remote method 'api': Error: Termin nicht angelegt (graph: graph 403)")), 'Termin nicht angelegt (graph: graph 403)')
  assert.equal(ipcErrorText(new Error('schlicht')), 'schlicht')
})

test('Ganztägig am Tag der Zeitumstellung endet am nächsten Kalendertag', () => {
  // 25.10.2026 hat 25 Stunden: lokale Mitternacht plus 24 h wäre noch der 25.10.
  const start = localTime('2026-10-25')
  const end = localTime('2026-10-25', '00:00', 1)
  assert.equal(new Date(start + 86_400_000).getDate(), 25)
  assert.equal(new Date(end).getDate(), 26)
  assert.equal(new Date(end).getHours(), 0)
  assert.equal(new Date(localTime('2026-11-26', '14:30')).getHours(), 14)
})

test('Gezogener Zeitraum rastet auf Viertelstunden ein, auch nach oben gezogen', () => {
  const day = new Date(2026, 10, 26)
  const at = (h: number, m = 0) => new Date(2026, 10, 26, h, m).getTime()
  assert.deepEqual(dragRange(day, 9.1, 10.6), { start: at(9), end: at(10, 45) })
  assert.deepEqual(dragRange(day, 10.6, 9.1), { start: at(9), end: at(10, 45) })
  // Innerhalb einer Viertelstunde: genau eine
  assert.deepEqual(dragRange(day, 14.01, 14.2), { start: at(14), end: at(14, 15) })
})

test('Gezogener Zeitraum bleibt im Tag', () => {
  const day = new Date(2026, 10, 26)
  assert.deepEqual(dragRange(day, -1, 0.1), { start: new Date(2026, 10, 26).getTime(), end: new Date(2026, 10, 26, 0, 15).getTime() })
  assert.equal(dragRange(day, 23.2, 30).end, new Date(2026, 10, 27).getTime())
})

test('Am Tag der Zeitumstellung passt der gezogene Zeitraum zur Zeile', () => {
  // 25. Oktober 2026: um 3 Uhr zurück auf 2 Uhr
  const r = dragRange(new Date(2026, 9, 25), 10, 11.4)
  assert.equal(wallHours(r.start), 10)
  assert.equal(wallHours(r.end), 11.5)
})

const draft = { subject: 'Abstimmung', attendees: ['kunde@firma.de'], teamsMeeting: true }
const upn = (id: string) => ({ a: 'tim@a.de', b: 'tim@b.de' })[id]

test('Ein Konto: Termin wie bisher', () => {
  assert.deepEqual(planEvents(draft, ['a'], 'block', upn), [{ accountId: 'a', event: draft, copy: false }])
})

test('Blocker: Organisator lädt ein, weitere Konten bekommen eine Kopie ohne Teilnehmer und Besprechung', () => {
  const plan = planEvents(draft, ['b', 'a'], 'block', upn)
  assert.deepEqual(plan, [
    { accountId: 'b', event: draft, copy: false },
    { accountId: 'a', event: { ...draft, attendees: [], teamsMeeting: false }, copy: true }
  ])
})

test('Einladen: Organisator lädt die weiteren Konten als Teilnehmer ein, ohne doppelte Adresse', () => {
  const plan = planEvents({ ...draft, attendees: ['kunde@firma.de', 'TIM@b.de'] }, ['a', 'b'], 'invite', upn)
  assert.equal(plan.length, 1)
  assert.equal(plan[0].accountId, 'a')
  assert.deepEqual(plan[0].event.attendees, ['kunde@firma.de', 'TIM@b.de'])
  assert.deepEqual(planEvents(draft, ['a', 'b'], 'invite', upn)[0].event.attendees, ['kunde@firma.de', 'tim@b.de'])
})

test('Einladen ohne bekannte Adresse scheitert, statt das Konto still auszulassen', () => {
  assert.throws(() => planEvents(draft, ['a', 'c'], 'invite', upn))
})

test('Blocker in einem zweiten Konto erscheint mit dem Termin nur einmal', () => {
  const start = Date.parse('2026-11-26T09:00:00Z')
  const end = start + 3600_000
  const real = { id: '1', subject: 'Abstimmung', start, end, iCalUId: 'uid-1', joinUrl: 'https://teams.microsoft.com/l/meetup-join/x' }
  const copy = { id: '2', subject: 'Abstimmung ', start, end, iCalUId: 'uid-2' }
  const merged = mergeCalendars([
    { accountId: 'a', events: [real] },
    { accountId: 'b', events: [copy] }
  ])
  assert.equal(merged.length, 1)
  assert.deepEqual(merged[0].sources.map((s) => s.accountId), ['a', 'b'])
  assert.equal(merged[0].event, real)
})

test('Gleicher Titel und Zeit, aber zwei Besprechungslinks: zwei Termine', () => {
  const start = Date.parse('2026-11-26T09:00:00Z')
  const end = start + 1800_000
  const merged = mergeCalendars([
    { accountId: 'a', events: [{ id: '1', subject: 'Daily', start, end, joinUrl: 'https://teams.microsoft.com/l/meetup-join/a' }] },
    { accountId: 'b', events: [{ id: '2', subject: 'Daily', start, end, joinUrl: 'https://teams.microsoft.com/l/meetup-join/b' }] }
  ])
  assert.equal(merged.length, 2)
})

test('Gleicher Titel und Zeit im selben Konto bleiben zwei Termine', () => {
  const start = Date.parse('2026-11-26T09:00:00Z')
  const merged = mergeCalendars([{ accountId: 'a', events: [{ id: '1', subject: 'Fokus', start, end: start + 1 }, { id: '2', subject: 'Fokus', start, end: start + 1 }] }])
  assert.equal(merged.length, 2)
})
