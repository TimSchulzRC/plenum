import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { hoverIntent, PrefetchCache } from '../src/renderer/src/lib/cache.ts'

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

test('Hover lädt erst nach der Wartezeit, kurzes Überfahren lädt nichts', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    let calls = 0
    const h = hoverIntent(() => calls++, 150)
    h.onMouseEnter()
    mock.timers.tick(100)
    h.onMouseLeave()
    mock.timers.tick(500)
    assert.equal(calls, 0)
    h.onMouseEnter()
    mock.timers.tick(150)
    assert.equal(calls, 1)
  } finally {
    mock.timers.reset()
  }
})

test('Linksklick lädt sofort, Rechtsklick nicht', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    let calls = 0
    const h = hoverIntent(() => calls++, 150)
    h.onMouseEnter()
    h.onMouseDown({ button: 2 })
    assert.equal(calls, 0)
    h.onMouseDown({ button: 0 })
    assert.equal(calls, 1)
    mock.timers.tick(500)
    assert.equal(calls, 1, 'der Hover-Timer läuft nach dem Klick nicht mehr')
  } finally {
    mock.timers.reset()
  }
})

test('Öffnen nutzt die laufende Vorab-Anfrage statt einer zweiten', async () => {
  const cache = new PrefetchCache<string>({ maxEntries: 10, freshMs: 1000 })
  const d = deferred<string>()
  let fetches = 0
  const fetcher = () => (fetches++, d.promise)
  cache.prefetch('a', fetcher)
  const opened = cache.load('a', fetcher)
  d.resolve('msgs')
  assert.equal(await opened, 'msgs')
  assert.equal(fetches, 1)
  assert.equal(cache.peek('a'), 'msgs')
})

test('Frische Einträge werden nicht erneut vorgeladen, veraltete schon', async () => {
  let now = 0
  const cache = new PrefetchCache<number>({ maxEntries: 10, freshMs: 1000, now: () => now })
  let fetches = 0
  const fetcher = async () => ++fetches
  cache.prefetch('a', fetcher)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(cache.peek('a'), 1)
  cache.prefetch('a', fetcher)
  assert.equal(fetches, 1)
  now = 2000
  cache.prefetch('a', fetcher)
  assert.equal(fetches, 2)
})

test('markStale behält die Daten, verwirft aber die laufende Anfrage', async () => {
  const cache = new PrefetchCache<string>({ maxEntries: 10, freshMs: 1000 })
  cache.set('a', 'alt')
  const old = deferred<string>()
  cache.prefetch('a', () => old.promise)
  cache.markStale('a')
  assert.equal(cache.peek('a'), 'alt')
  assert.equal(cache.isFresh('a'), false)
  const next = cache.load('a', async () => 'neu')
  old.resolve('zwischendurch')
  assert.equal(await next, 'neu')
  await old.promise
  assert.equal(cache.peek('a'), 'neu')
})

test('Fehler beim Vorladen bleiben still und blockieren nichts', async () => {
  const cache = new PrefetchCache<string>({ maxEntries: 10, freshMs: 1000 })
  cache.prefetch('a', () => Promise.reject(new Error('offline')))
  await new Promise((r) => setImmediate(r))
  assert.equal(cache.peek('a'), undefined)
  assert.equal(await cache.load('a', async () => 'ok'), 'ok')
})

test('Der Cache wirft die ältesten Einträge raus', () => {
  const cache = new PrefetchCache<number>({ maxEntries: 2, freshMs: 1000 })
  cache.set('a', 1)
  cache.set('b', 2)
  cache.set('a', 3)
  cache.set('c', 4)
  assert.equal(cache.peek('b'), undefined)
  assert.equal(cache.peek('a'), 3)
  assert.equal(cache.peek('c'), 4)
})
