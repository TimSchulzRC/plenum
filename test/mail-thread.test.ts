import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findSignatures, isMe, parseMailDate, parsePerson, parseWrote, shortDate, threadParts, type SigLine } from '../src/renderer/src/lib/mail-signature.ts'

const L = (...texts: (string | SigLine)[]): SigLine[] => texts.map((t) => (typeof t === 'string' ? { text: t } : t))

test('Absender aus dem Kopf: Name und Adresse in den üblichen Schreibweisen', () => {
  assert.deepEqual(parsePerson(' Kim Fabrik <kim@fabrikam.de>'), { name: 'Kim Fabrik', address: 'kim@fabrikam.de' })
  assert.deepEqual(parsePerson('Fabrik, Kim [mailto:kim@fabrikam.de]'), { name: 'Fabrik, Kim', address: 'kim@fabrikam.de' })
  assert.deepEqual(parsePerson('"Kim Fabrik" <kim@fabrikam.de>;'), { name: 'Kim Fabrik', address: 'kim@fabrikam.de' })
  assert.deepEqual(parsePerson('kim@fabrikam.de'), { name: undefined, address: 'kim@fabrikam.de' })
  assert.deepEqual(parsePerson('Kim Fabrik <kim@fabrikam.de> Im Auftrag von Support <support@fabrikam.de>'), { name: 'Kim Fabrik', address: 'kim@fabrikam.de' })
  assert.deepEqual(parsePerson('Robin Nord'), { name: 'Robin Nord', address: undefined })
  assert.equal(parsePerson('  '), undefined)
})

test('„Am … schrieb …:“ und „On … wrote:“: Datum und Absender', () => {
  assert.deepEqual(parseWrote('Am Mi., 25. Nov. 2026 um 14:02 Uhr schrieb Alex Beispiel <alex@contoso.com>:'), {
    date: 'Mi., 25. Nov. 2026 um 14:02 Uhr',
    sender: { name: 'Alex Beispiel', address: 'alex@contoso.com' }
  })
  assert.deepEqual(parseWrote('On Tue, Nov 24, 2026 at 11:03 AM Kim Fabrik <kim@fabrikam.de> wrote:'), {
    date: 'Tue, Nov 24, 2026 at 11:03 AM',
    sender: { name: 'Kim Fabrik', address: 'kim@fabrikam.de' }
  })
  assert.deepEqual(parseWrote('On 24.11.2026 11:03, Kim Fabrik wrote:'), { date: '24.11.2026 11:03', sender: { name: 'Kim Fabrik', address: undefined } })
  // Ohne Datum bleibt alles der Absender
  assert.deepEqual(parseWrote('On Monday Kim Fabrik wrote:'), { sender: { name: 'Monday Kim Fabrik', address: undefined } })
})

test('Datum ohne Wochentag', () => {
  assert.equal(shortDate('Dienstag, 24. November 2026 11:03'), '24. November 2026 11:03')
  assert.equal(shortDate('Wednesday, November 25, 2026 9:30 AM'), 'November 25, 2026 9:30 AM')
  assert.equal(shortDate('Mi., 25. Nov. 2026 um 14:02 Uhr'), '25. Nov. 2026 um 14:02 Uhr')
  assert.equal(shortDate('24.11.2026 11:03'), '24.11.2026 11:03')
  // Monat, kein Wochentag
  assert.equal(shortDate('Mai 2026'), 'Mai 2026')
  assert.equal(shortDate('Montag'), 'Montag')
})

test('Eigene Nachrichten: Adresse entscheidet, sonst Vor- und Nachname', () => {
  const me = [{ name: 'Alex Beispiel', address: 'alex@contoso.com' }]
  assert.equal(isMe({ name: 'Irgendwer', address: 'ALEX@contoso.com' }, me), true)
  assert.equal(isMe({ name: 'Beispiel, Alex (Contoso)' }, me), true)
  // Gleicher Name, andere Adresse: jemand anderes
  assert.equal(isMe({ name: 'Alex Beispiel', address: 'alex.beispiel@example.org' }, me), false)
  assert.equal(isMe({ name: 'Alex' }, me), false)
  assert.equal(isMe({ name: 'Alex Kim' }, me), false)
  assert.equal(isMe({ name: 'Kim Fabrik', address: 'kim@fabrikam.de' }, me), false)
  assert.equal(isMe(undefined, me), false)
  assert.equal(isMe({ address: 'alex@contoso.com' }, [{ name: 'Alex Beispiel' }]), false)
})

test('Verlauf: je Nachricht Absender, Datum, Kopf und Signatur', () => {
  const lines = L(
    'Hallo Alex,', 'passt, Mittwoch um 10 Uhr.', 'Viele Grüße', 'Kim Fabrik', 'Leitung Integration', 'Tel. +49 40 1234567',
    'Von: Alex Beispiel <alex@contoso.com>', 'Gesendet: Dienstag, 24. November 2026 16:12', 'An: Kim Fabrik <kim@fabrikam.de>', 'Betreff: AW: Workshop',
    'Hallo Kim,', 'Mittwoch passt mir.', 'Beste Grüße', 'Alex Beispiel', 'Senior Consultant', 'Tel. +49 123 456789',
    'Am 24.11.2026 um 11:03 schrieb Kim Fabrik <kim@fabrikam.de>:',
    'Hallo Alex,', 'wann hättest du Zeit?'
  )
  const top = { name: 'Kim Fabrik', address: 'kim@fabrikam.de' }
  const parts = threadParts(lines, findSignatures(lines, 'Kim Fabrik kim'), top)
  assert.deepEqual(parts, [
    { start: 0, body: 0, end: 6, sender: top, signature: { start: 4, end: 6 } },
    { start: 6, body: 10, end: 16, sender: { name: 'Alex Beispiel', address: 'alex@contoso.com' }, date: 'Dienstag, 24. November 2026 16:12', signature: { start: 14, end: 16 } },
    { start: 16, body: 17, end: 19, sender: top, date: '24.11.2026 um 11:03' }
  ])
})

test('Verlauf: Weiterleitung hat einen eigenen Kopf, Zitat ohne Kopf keinen Absender', () => {
  const forward = L({ text: 'Von: Robin Nord <robin@northwind.example>', boundary: true }, 'Gesendet: Montag, 23. November 2026 09:00', 'Betreff: Zahlen', 'Anbei die Zahlen.', 'Mehr dazu morgen.')
  assert.deepEqual(threadParts(forward, [], { name: 'Alex Beispiel', address: 'alex@contoso.com' }), [
    { start: 0, body: 3, end: 5, sender: { name: 'Robin Nord', address: 'robin@northwind.example' }, date: 'Montag, 23. November 2026 09:00' }
  ])
  const bare = L('Danke!', 'Passt so.', { text: 'Hier der alte Text.', boundary: true }, 'Noch eine Zeile.')
  assert.deepEqual(threadParts(bare, [], { name: 'Kim Fabrik' }), [
    { start: 0, body: 0, end: 2, sender: { name: 'Kim Fabrik' } },
    { start: 2, body: 2, end: 4 }
  ])
})

test('Datum aus dem Kopf: deutsche und englische Schreibweisen', () => {
  const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime()
  assert.equal(parseMailDate('Dienstag, 24. November 2026 11:03'), at(2026, 11, 24, 11, 3))
  assert.equal(parseMailDate('24.11.2026 11:03'), at(2026, 11, 24, 11, 3))
  assert.equal(parseMailDate('24.11.26 um 9:05'), at(2026, 11, 24, 9, 5))
  assert.equal(parseMailDate('Mi., 25. Nov. 2026 um 14:02 Uhr'), at(2026, 11, 25, 14, 2))
  assert.equal(parseMailDate('Montag, 2. März 2026 08:00'), at(2026, 3, 2, 8, 0))
  assert.equal(parseMailDate('Wednesday, November 25, 2026 9:30 AM'), at(2026, 11, 25, 9, 30))
  assert.equal(parseMailDate('Tue, Nov 24, 2026 at 12:15 PM'), at(2026, 11, 24, 12, 15))
  assert.equal(parseMailDate('Tue, Nov 24, 2026 at 12:15 AM'), at(2026, 11, 24, 0, 15))
  assert.equal(parseMailDate('Friday, 27 November 2026 20:44'), at(2026, 11, 27, 20, 44))
  assert.equal(parseMailDate('Mon Nov 23 2026 09:00'), at(2026, 11, 23, 9, 0))
  // Schrägstrich: nur eindeutig, wenn eine Zahl über 12 liegt (US: Monat/Tag, UK: Tag/Monat)
  assert.equal(parseMailDate('11/24/2026 3:00 PM'), at(2026, 11, 24, 15, 0))
  assert.equal(parseMailDate('24/11/2026 15:00'), at(2026, 11, 24, 15, 0))
  assert.equal(parseMailDate('11/12/2026 10:00'), undefined)
  assert.equal(parseMailDate('5/5/2026 10:00'), at(2026, 5, 5, 10, 0))
  // Ohne Jahr, ohne Monat oder unmöglich: kein Datum
  assert.equal(parseMailDate('Dienstag 11:03'), undefined)
  assert.equal(parseMailDate('am Wochenende 2026'), undefined)
  assert.equal(parseMailDate('31.02.2026 10:00'), undefined)
})
