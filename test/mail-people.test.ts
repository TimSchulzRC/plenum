import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MailDirectory, mailMatches } from '../src/main/engine/mail-people.ts'

function fake(known: Record<string, string>, fail = false) {
  const calls: string[][] = []
  const lookup = async (list: string[]) => {
    calls.push(list)
    if (fail) throw new Error('429')
    return new Map(list.filter((a) => known[a]).map((a) => [a, known[a]]))
  }
  return { calls, lookup }
}

test('Adressen einer Liste gehen in einem Abruf, klein geschrieben und ohne Doppel', async () => {
  const f = fake({ 'anna@firma.de': '8:orgid:a' })
  const dir = new MailDirectory(f.lookup)
  const res = await Promise.all([dir.resolve('Anna@Firma.de'), dir.resolve('anna@firma.de'), dir.resolve('extern@example.com')])
  assert.deepEqual(res, ['8:orgid:a', '8:orgid:a', undefined])
  assert.deepEqual(f.calls, [['anna@firma.de', 'extern@example.com']])
})

test('Treffer und Fehlschläge werden gemerkt, nicht pro Rendern neu gefragt', async () => {
  const f = fake({ 'anna@firma.de': '8:orgid:a' })
  const dir = new MailDirectory(f.lookup)
  await Promise.all([dir.resolve('anna@firma.de'), dir.resolve('extern@example.com')])
  assert.equal(await dir.resolve('anna@firma.de'), '8:orgid:a')
  assert.equal(await dir.resolve('extern@example.com'), undefined)
  assert.equal(f.calls.length, 1)
})

test('Unbekannte Adressen fragt es nach sechs Stunden noch einmal', async () => {
  let now = 1_000_000
  const f = fake({})
  const dir = new MailDirectory(f.lookup, () => now)
  await dir.resolve('extern@example.com')
  now += 5 * 3600_000
  await dir.resolve('extern@example.com')
  assert.equal(f.calls.length, 1)
  now += 2 * 3600_000
  await dir.resolve('extern@example.com')
  assert.equal(f.calls.length, 2)
})

test('Scheitert der Abruf, merkt es nichts und fragt eine Minute lang nicht', async () => {
  let now = 1_000_000
  const f = fake({ 'anna@firma.de': '8:orgid:a' }, true)
  const dir = new MailDirectory(f.lookup, () => now)
  assert.equal(await dir.resolve('anna@firma.de'), undefined)
  assert.equal(await dir.resolve('anna@firma.de'), undefined)
  assert.equal(f.calls.length, 1)
  now += 61_000
  await dir.resolve('anna@firma.de')
  assert.equal(f.calls.length, 2)
})

test('Große Listen gehen in Abrufen zu höchstens 50 Adressen', async () => {
  const f = fake({})
  const dir = new MailDirectory(f.lookup)
  await Promise.all(Array.from({ length: 120 }, (_, i) => dir.resolve(`p${i}@firma.de`)))
  assert.deepEqual(
    f.calls.map((c) => c.length),
    [50, 50, 20]
  )
})

test('Ohne gültige Adresse kein Abruf', async () => {
  const f = fake({})
  const dir = new MailDirectory(f.lookup)
  assert.equal(await dir.resolve(''), undefined)
  assert.equal(await dir.resolve('Max Mustermann'), undefined)
  assert.equal(await dir.resolve('/O=EXCHANGELABS/OU=EXCHANGE'), undefined)
  assert.equal(f.calls.length, 0)
})

test('Personen passen über Mail oder UPN, nur mit Teams-MRI', () => {
  const found = mailMatches(
    ['anna@firma.de', 'ben@firma.de', 'tel@firma.de', 'fremd@example.com'],
    [
      undefined,
      { mri: '8:orgid:a', email: 'Anna@Firma.de' },
      { mri: '8:orgid:b', email: 'b.alias@firma.de', userPrincipalName: 'ben@firma.de' },
      { mri: '4:+4930123', email: 'tel@firma.de' },
      { mri: '8:orgid:x' }
    ]
  )
  assert.deepEqual([...found], [
    ['anna@firma.de', '8:orgid:a'],
    ['ben@firma.de', '8:orgid:b']
  ])
})
