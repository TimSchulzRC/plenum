import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OlderCursors } from '../src/main/older-cursors.ts'

test('Neuladen der neuesten Seite setzt den Cursor nach dem Zurückblättern nicht zurück', () => {
  const c = new OlderCursors()
  // Neueste Seite: älteste Nachricht bei t=300, weiter mit Link p2
  c.set('chat', 300, 'p2')
  // Zurückblättern: Seite 2 reicht bis t=200, weiter mit p3
  assert.equal(c.get('chat', 300), 'p2')
  c.set('chat', 200, 'p3')
  // Das 30-s-Neuladen holt wieder die neueste Seite (inzwischen bis t=310)
  c.set('chat', 310, 'p2b')
  // Die Oberfläche zeigt weiter alles ab t=200 und fragt mit dieser Zeit nach: p3, nicht p2
  assert.equal(c.get('chat', 200), 'p3')
})

test('Unbekannte Stelle liefert keinen Cursor, Chats sind getrennt', () => {
  const c = new OlderCursors()
  c.set('a', 100, 'x')
  assert.equal(c.get('a', 99), undefined)
  assert.equal(c.get('b', 100), undefined)
})

test('Pro Chat bleiben höchstens 50 Cursor', () => {
  const c = new OlderCursors()
  for (let i = 0; i < 60; i++) c.set('a', i, `l${i}`)
  assert.equal(c.get('a', 0), undefined)
  assert.equal(c.get('a', 59), 'l59')
  assert.equal(c.get('a', 10), 'l10')
})
