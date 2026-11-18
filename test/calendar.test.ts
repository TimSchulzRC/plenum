import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allDayOn, wallHours } from '../src/renderer/src/lib/calendar.ts'

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
