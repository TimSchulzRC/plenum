import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inlineToLoad, Limiter, MailImageStore, type ImageEntry } from '../src/main/engine/mail-images.ts'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('Eingebettete Bilder: höchstens 20 und 8 MB, in Reihenfolge der Anhänge', () => {
  const att = (id: string, size: number, isInline = true) => ({ id, size, isInline })
  assert.deepEqual(inlineToLoad([att('a', 100), att('doc', 100, false), att('b', 7 * 1024 * 1024), att('c', 2 * 1024 * 1024), att('d', 500)]).map((r) => r.id), ['a', 'b', 'd'])
  assert.equal(inlineToLoad(Array.from({ length: 30 }, (_, i) => att(String(i), 10))).length, 20)
})

test('Limiter: höchstens vier gleichzeitig, Geöffnetes vor Vorgeladenem', async () => {
  const lim = new Limiter(4)
  let running = 0
  let peak = 0
  const order: string[] = []
  const job = (name: string) => async () => {
    running++
    peak = Math.max(peak, running)
    await wait(10)
    order.push(name)
    running--
  }
  const all = [
    ...['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map((n) => lim.run(job(n), false)),
    lim.run(job('h1'), true)
  ]
  await Promise.all(all)
  assert.equal(peak, 4)
  // h1 kam nach sechs Hintergrundanfragen, läuft aber vor b5 und b6
  assert.ok(order.indexOf('h1') < order.indexOf('b5'))
  assert.ok(order.indexOf('h1') < order.indexOf('b6'))
})

const entry = (cid: string): ImageEntry => ({ cid, type: 'image/png', data: new Uint8Array(10) })

test('Bildspeicher: ein Bild steht bereit, sobald sein Anhang da ist', async () => {
  const delays: Record<string, number> = { a: 5, b: 60 }
  const store = new MailImageStore({
    list: async () => [{ id: 'a', size: 1 }, { id: 'b', size: 1 }],
    fetch: async (_m, id) => {
      await wait(delays[id])
      return entry(`${id}@x`)
    }
  })
  const t0 = Date.now()
  const a = await store.image('m1', 'a@x')
  assert.equal(a?.cid, 'a@x')
  assert.ok(Date.now() - t0 < 50, 'wartet nicht auf das langsame Bild')
  assert.equal((await store.image('m1', 'b@x'))?.cid, 'b@x')
  assert.equal(await store.image('m1', 'fehlt@x'), undefined)
  assert.deepEqual(await store.index('m1'), { a: 'a@x', b: 'b@x' })
})

test('Bildspeicher: gedrosselter Anhang wird beim nächsten Mal wieder versucht, geladene nicht', async () => {
  const calls: string[] = []
  let fail = true
  const store = new MailImageStore({
    list: async () => [{ id: 'a', size: 1 }, { id: 'b', size: 1 }],
    fetch: async (_m, id) => {
      calls.push(id)
      if (id === 'b' && fail) throw new Error('429')
      return entry(`${id}@x`)
    }
  })
  assert.equal(await store.image('m1', 'b@x'), undefined)
  fail = false
  assert.equal((await store.image('m1', 'b@x'))?.cid, 'b@x')
  assert.deepEqual(calls, ['a', 'b', 'b'])
})

test('Bildspeicher: Liste aus getMail wird genutzt, alte Mails fallen bei Speichergrenze weg', async () => {
  let lists = 0
  const store = new MailImageStore(
    {
      list: async () => {
        lists++
        return [{ id: 'a', size: 1 }]
      },
      fetch: async (m) => ({ cid: `${m}@x`, type: 'image/png', data: new Uint8Array(60) })
    },
    100
  )
  store.remember('m1', [{ id: 'a', size: 1 }])
  await store.index('m1')
  assert.equal(lists, 0)
  await store.index('m2')
  assert.equal(lists, 1)
  // 120 Bytes > 100: m1 fällt weg, m2 bleibt
  assert.deepEqual(await store.index('m2'), { a: 'm2@x' })
  let fetched = 0
  const again = new MailImageStore({ list: async () => [], fetch: async () => (fetched++, undefined) })
  assert.deepEqual(await again.index('leer'), {})
  assert.equal(fetched, 0)
})

test('Limiter: vorgeladene Anfragen einer geöffneten Mail rücken nach vorn', async () => {
  const lim = new Limiter(1)
  const order: string[] = []
  const job = (name: string) => async () => {
    await wait(5)
    order.push(name)
  }
  const all = [lim.run(job('busy'), true), lim.run(job('other'), false, 'm2'), lim.run(job('mine'), false, 'm1')]
  lim.promote('m1')
  await Promise.all(all)
  assert.deepEqual(order, ['busy', 'mine', 'other'])
})

test('Bildspeicher: geöffnete Mail holt wartende Vorlade-Anfragen nach vorn', async () => {
  const promoted: string[] = []
  const store = new MailImageStore({
    list: async () => [{ id: 'a', size: 1 }],
    fetch: async () => {
      await wait(10)
      return entry('a@x')
    },
    promote: (id) => promoted.push(id)
  })
  const bg = store.load('m1', false)
  await store.image('m1', 'a@x')
  await bg
  assert.deepEqual(promoted, ['m1'])
})

test('Bildspeicher: geänderter Entwurf liefert kein altes Bild', async () => {
  const data: Record<string, string> = { a: 'logo@x' }
  const store = new MailImageStore({
    list: async () => [],
    fetch: async (_m, id) => (data[id] ? entry(data[id]) : undefined)
  })
  store.remember('d1', [{ id: 'a', size: 1 }])
  assert.equal((await store.image('d1', 'logo@x'))?.cid, 'logo@x')
  // Anhang ersetzt: neue ID, gleiche Content-ID
  delete data.a
  data.b = 'logo@x'
  store.remember('d1', [{ id: 'b', size: 1 }])
  assert.deepEqual(await store.index('d1'), { b: 'logo@x' })
  // Bild entfernt: nichts mehr
  store.remember('d1', [])
  assert.equal(await store.image('d1', 'logo@x'), undefined)
})

test('Bildspeicher: geöffnet, während das Vorladen noch auf die Liste wartet, Bilder mit Vorrang', async () => {
  const prios: boolean[] = []
  const store = new MailImageStore({
    list: async () => {
      await wait(10)
      return [{ id: 'a', size: 1 }]
    },
    fetch: async (_m, _id, high) => {
      prios.push(high)
      return entry('a@x')
    }
  })
  void store.load('m1', false)
  await wait(2)
  assert.equal((await store.image('m1', 'a@x'))?.cid, 'a@x')
  assert.deepEqual(prios, [true])
})

test('Bildspeicher: Bild eines entfernten Anhangs, das noch unterwegs war, kommt nicht an', async () => {
  const store = new MailImageStore({
    list: async () => [],
    fetch: async (_m, id) => {
      if (id === 'old') await wait(30)
      return entry(id === 'old' ? 'alt@x' : 'neu@x')
    }
  })
  store.remember('d1', [{ id: 'old', size: 1 }])
  const first = store.load('d1', true)
  await wait(5)
  // Entwurf geändert, bevor das alte Bild da ist
  store.remember('d1', [{ id: 'new', size: 1 }])
  await first
  assert.equal(await store.image('d1', 'alt@x'), undefined)
  assert.deepEqual(await store.index('d1'), { new: 'neu@x' })
})

test('Bildspeicher: zwischen zwei Durchgängen meldet der Leser kein fehlendes Bild', async () => {
  const store = new MailImageStore({
    list: async () => [],
    fetch: async (_m, id) => {
      await wait(10)
      return entry(`${id}@x`)
    }
  })
  store.remember('d1', [{ id: 'a', size: 1 }])
  void store.load('d1', false)
  // neue Anhangsliste mit b, der Leser fragt nach b, während der erste Durchgang noch a holt
  store.remember('d1', [{ id: 'a', size: 1 }, { id: 'b', size: 1 }])
  assert.equal((await store.image('d1', 'b@x'))?.cid, 'b@x')
})
