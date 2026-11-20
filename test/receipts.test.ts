import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readReceipt } from '../src/renderer/src/lib/receipts.ts'

const members = ['8:orgid:a', '8:orgid:b', '8:orgid:c']

test('Gruppenchat: teilt in Leser und Nicht-Leser auf', () => {
  const r = readReceipt(members, { '8:orgid:a': 1700000000500, '8:orgid:b': 1699999999999 }, '1700000000000')
  assert.deepEqual(r.seen, ['8:orgid:a'])
  assert.deepEqual(r.unseen, ['8:orgid:b', '8:orgid:c'])
  assert.equal(r.text, 'Gesehen von 1')
})

test('Gruppenchat: alle gelesen heißt nur "Gesehen"', () => {
  const h = Object.fromEntries(members.map((m) => [m, 1700000000000]))
  const r = readReceipt(members, h, '1700000000000')
  assert.equal(r.unseen.length, 0)
  assert.equal(r.text, 'Gesehen')
})

test('niemand gelesen heißt "Gesendet"', () => {
  const r = readReceipt(members, {}, '1700000000000')
  assert.deepEqual(r.seen, [])
  assert.equal(r.text, 'Gesendet')
})
