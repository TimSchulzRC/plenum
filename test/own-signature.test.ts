import assert from 'node:assert/strict'
import { test } from 'node:test'
import { learnSignature, type SigLine } from '../src/renderer/src/lib/mail-signature.ts'

const L = (...texts: (string | SigLine)[]): SigLine[] => texts.map((t) => (typeof t === 'string' ? { text: t } : t))
const sig = ['Alex Beispiel', 'Senior Consultant', { text: '', image: true }, 'Contoso GmbH | Musterstraße 1 | 12345 Musterstadt', 'Tel. +49 123 456789']

test('Eigene Signatur: gleiches Ende in zwei gesendeten Mails, ohne Grußformel', () => {
  const a = L('Hallo Kim,', 'passt, bis Montag.', 'Viele Grüße', ...sig)
  const b = L('Hi Robin,', 'anbei die Zahlen.', 'Beste Grüße', ...sig, { text: 'Von: Robin Nord <robin@northwind.example>', boundary: true }, 'Gesendet: Montag', 'Betreff: Zahlen', 'Hallo Alex', 'Robin')
  assert.deepEqual(learnSignature([{ lines: a }, { lines: b }]), { mail: 0, start: 3, end: 8 })
  // Gleiche Grußformel in beiden: bleibt trotzdem draußen
  const c = L('Hi Robin,', 'danke!', 'Viele Grüße', ...sig)
  assert.deepEqual(learnSignature([{ lines: a }, { lines: c }]), { mail: 0, start: 3, end: 8 })
})

test('Eigene Signatur: neueste Mail ohne Signatur (vom Handy), dann aus den nächsten', () => {
  const phone = L('Ok, passt.', 'Von meinem iPhone gesendet')
  const a = L('Hallo Kim,', 'passt.', 'Viele Grüße', ...sig)
  const b = L('Hi,', 'anbei.', 'Gruß', ...sig)
  assert.deepEqual(learnSignature([{ lines: phone }, { lines: a }, { lines: b }]), { mail: 1, start: 3, end: 8 })
})

test('Eigene Signatur: nur eine Mail, dann die Regeln, mit Namenszeile', () => {
  const a = L('Hallo Kim,', 'passt, bis Montag.', 'Viele Grüße', ...sig)
  assert.deepEqual(learnSignature([{ lines: a, sender: 'Alex Beispiel alex' }]), { mail: 0, start: 3, end: 8 })
})

test('Eigene Signatur: nichts erfinden', () => {
  // Gleiches Ende ohne Angabe, die nur in Signaturen steht
  assert.equal(learnSignature([{ lines: L('Hallo Kim,', 'danke dir.', 'Alex') }, { lines: L('Hi Robin,', 'danke dir.', 'Alex') }]), undefined)
  // Gleicher Satz am Ende ist Inhalt
  const x = L('Hallo,', 'Bitte ruf mich unter +49 123 456789 an.', 'Alex')
  assert.equal(learnSignature([{ lines: x }, { lines: L('Hi,', ...x.slice(1)) }]), undefined)
  assert.equal(learnSignature([]), undefined)
})
