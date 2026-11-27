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
