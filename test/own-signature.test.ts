import assert from 'node:assert/strict'
import { test } from 'node:test'
import { learnSignature, type SigLine } from '../src/renderer/src/lib/mail-signature.ts'

const L = (...texts: (string | SigLine)[]): SigLine[] => texts.map((t) => (typeof t === 'string' ? { text: t } : t))
const me = 'Alex Beispiel alex'
const logo: SigLine = { text: '', image: true, imageKey: '1200:AAAlogo;' }
const sig: (string | SigLine)[] = ['Alex Beispiel', 'Senior Consultant', logo, 'Contoso GmbH | Musterstraße 1 | 12345 Musterstadt', 'Tel. +49 123 456789']
const learn = (...mails: SigLine[][]) => learnSignature(mails.map((lines) => ({ lines, sender: me })))

test('Eigene Signatur: gleiches Ende in zwei gesendeten Mails, ab dem eigenen Namen', () => {
  const a = L('Hallo Kim,', 'passt, bis Montag.', 'Viele Grüße', ...sig)
  const b = L('Hi Robin,', 'anbei die Zahlen.', 'Beste Grüße', ...sig, { text: 'Von: Robin Nord <robin@northwind.example>', boundary: true }, 'Gesendet: Montag', 'Betreff: Zahlen', 'Hallo Alex', 'Robin')
  assert.deepEqual(learn(a, b), { mail: 0, start: 3, end: 8 })
  // Gleiche Grußformel und gleicher Satz davor: beginnt trotzdem beim Namen
  const c = L('Hi Robin,', 'passt, bis Montag.', 'Viele Grüße', ...sig)
  assert.deepEqual(learn(a, c), { mail: 0, start: 3, end: 8 })
  // Logo vor dem Namen gehört dazu
  const d = L('Hallo Kim,', 'danke.', logo, ...sig)
  const e = L('Hi,', 'passt.', logo, ...sig)
  assert.deepEqual(learn(d, e), { mail: 0, start: 2, end: 8 })
})

test('Eigene Signatur: neueste Mail ohne Signatur (vom Handy), dann aus den nächsten', () => {
  const phone = L('Ok, passt.', 'Von meinem iPhone gesendet')
  const a = L('Hallo Kim,', 'passt.', 'Viele Grüße', ...sig)
  const b = L('Hi,', 'anbei.', 'Gruß', ...sig)
  assert.deepEqual(learn(phone, a, b), { mail: 1, start: 3, end: 8 })
})

test('Eigene Signatur: nur eine Mail, dann die Regeln, mit Namenszeile', () => {
  const a = L('Hallo Kim,', 'passt, bis Montag.', 'Viele Grüße', ...sig)
  assert.deepEqual(learn(a), { mail: 0, start: 3, end: 8 })
})

test('Review: gleicher Inhalt am Ende zweier Mails ist keine Signatur', () => {
  // Zwei Mails enden mit demselben internen Hinweis und Link: kein Name, keine Signatur
  const vpn = ['Internal VPN', 'https://vpn.contoso.example/setup?token=abc']
  assert.equal(learn(L('Hallo Kim,', 'hier der Zugang:', ...vpn), L('Hi Robin,', 'für dich auch:', ...vpn)), undefined)
  // Gleiche Bildunterschrift mit verschiedenen Screenshots und Namen darunter: Bilder verschieden
  const shotA: SigLine = { text: '', image: true, imageKey: '90000:AAA;' }
  const shotB: SigLine = { text: '', image: true, imageKey: '88000:BBB;' }
  const tail = ['Alex Beispiel', 'Tel. +49 123 456789']
  const r = learn(L('Hallo,', 'siehe Bild:', shotA, ...tail), L('Hi,', 'siehe Bild:', shotB, ...tail))
  assert.deepEqual(r, { mail: 0, start: 3, end: 5 })
  // Bild ohne bekannte Quelle ist nie gleich
  const unknown: SigLine = { text: '', image: true }
  assert.deepEqual(learn(L('Hallo,', 'ok.', unknown, ...tail), L('Hi,', 'gut.', unknown, ...tail)), { mail: 0, start: 3, end: 5 })
  // Signatur eines anderen Namens (weitergeleitete Mail ohne Kopf) wird nicht übernommen
  const other = ['Kim Fabrik', 'Fabrikam AG', 'Tel. +49 40 1234567']
  assert.equal(learn(L('Hallo,', 'zur Info.', ...other), L('Hi,', 'siehe unten.', ...other)), undefined)
})

test('Eigene Signatur: nichts erfinden', () => {
  // Nur der Name: keine Angabe, die nur in Signaturen steht
  assert.equal(learn(L('Hallo Kim,', 'danke dir.', 'Alex Beispiel'), L('Hi Robin,', 'danke dir.', 'Alex Beispiel')), undefined)
  // Gleicher Satz am Ende ist Inhalt
  const x = L('Hallo,', 'Bitte ruf mich unter +49 123 456789 an.', 'Alex Beispiel')
  assert.equal(learn(x, L('Hi,', ...x.slice(1))), undefined)
  // Ohne bekannten Absender keine Signatur
  assert.equal(learnSignature([{ lines: L('Hallo,', 'ok.', ...sig) }, { lines: L('Hi,', 'gut.', ...sig) }]), undefined)
  assert.equal(learn(), undefined)
})
