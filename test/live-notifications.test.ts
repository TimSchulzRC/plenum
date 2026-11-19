import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LiveNotifications, type NotificationKey } from '../src/main/live-notifications.ts'

class Fake {
  closed = false
  close(): void {
    this.closed = true
  }
}

const key = (conversationId: string, kind: NotificationKey['kind'] = 'chat'): NotificationKey => ({ accountId: 'a', conversationId, kind })

test('hält Mitteilungen fest, bis die Unterhaltung gelesen ist', () => {
  const live = new LiveNotifications<Fake>()
  const a = new Fake()
  const b = new Fake()
  live.add(a, key('chat-a'))
  live.add(b, key('chat-b'))
  const unread = new Set(['chat-a', 'chat-b'])
  assert.equal(live.closeRead((k) => unread.has(k.conversationId)), 0)
  assert.equal(live.size, 2)
  unread.delete('chat-a')
  assert.equal(live.closeRead((k) => unread.has(k.conversationId)), 1)
  assert.equal(a.closed, true)
  assert.equal(b.closed, false)
  assert.equal(live.size, 1)
})

test('Klick oder Schließen lässt nur die Referenz los', () => {
  const live = new LiveNotifications<Fake>()
  const a = new Fake()
  live.add(a, key('chat-a'))
  live.forget(a)
  assert.equal(live.size, 0)
  assert.equal(a.closed, false)
})

test('die Liste bleibt begrenzt, die älteste fällt heraus', () => {
  const live = new LiveNotifications<Fake>(2)
  const items = [new Fake(), new Fake(), new Fake()]
  items.forEach((f, i) => live.add(f, key(`c${i}`)))
  assert.equal(live.size, 2)
  assert.deepEqual(
    items.map((f) => f.closed),
    [true, false, false]
  )
})
