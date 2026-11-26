import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignatureModel } from '../src/main/signature-model.ts'

// Fake-Helfer als Node-Skript: zählt Starts in einer Datei, verhält sich je nach Modus
function helper(dir: string, mode: 'ok' | 'hang' | 'exit' | 'unavailable'): { bin: string; starts: () => number } {
  const count = join(dir, `${mode}.count`)
  writeFileSync(count, '0')
  const bin = join(dir, `${mode}.mjs`)
  writeFileSync(
    bin,
    `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
writeFileSync(${JSON.stringify(count)}, String(Number(readFileSync(${JSON.stringify(count)}, 'utf8')) + 1))
const mode = ${JSON.stringify(mode)}
console.log(JSON.stringify({ ready: true, available: mode !== 'unavailable', reason: mode === 'unavailable' ? 'deviceNotEligible' : undefined }))
if (mode === 'exit') process.exit(3)
createInterface({ input: process.stdin }).on('line', (l) => {
  const req = JSON.parse(l)
  if (mode === 'ok') console.log(JSON.stringify({ id: req.id, starts: req.parts.map((p) => p.first + 1) }))
})
`
  )
  chmodSync(bin, 0o755)
  return { bin, starts: () => Number(readFileSync(count, 'utf8')) }
}

const quiet = { info: () => {}, warn: () => {} }
const parts = [{ first: 1, lines: ['a', 'b', 'c', 'd'] }]
const opts = { log: quiet, platform: 'darwin', helloTimeout: 2000, base: 300, perPart: 0 }

test('Helfer antwortet, bleibt geladen und beantwortet Anfragen nacheinander', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sig-'))
  const h = helper(dir, 'ok')
  const m = new SignatureModel(h.bin, opts)
  assert.equal(await m.available(), true)
  const [a, b] = await Promise.all([m.find(parts), m.find([{ first: 5, lines: ['x'] }, { first: 2, lines: ['y'] }])])
  assert.deepEqual(a, [2])
  assert.deepEqual(b, [6, 3])
  assert.equal(h.starts(), 1)
  m.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('Hängt der Helfer, gibt es null, und die nächste Anfrage startet einen neuen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sig-'))
  const h = helper(dir, 'hang')
  const m = new SignatureModel(h.bin, opts)
  assert.equal(await m.find(parts), null)
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(await m.find(parts), null)
  assert.equal(h.starts(), 2)
  // Nach drei Fehlschlägen bleibt es bei den Regeln, kein neuer Start
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(await m.find(parts), null)
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(await m.find(parts), null)
  assert.equal(h.starts(), 3)
  m.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('Beendet sich der Helfer, stürzt nichts ab (EPIPE), die Anfrage liefert null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sig-'))
  const h = helper(dir, 'exit')
  const m = new SignatureModel(h.bin, opts)
  const results = await Promise.all([m.find(parts), m.find(parts)])
  assert.deepEqual(results, [null, null])
  m.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('Ohne Apple Intelligence: null und kein neuer Start bei jeder Mail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sig-'))
  const h = helper(dir, 'unavailable')
  const m = new SignatureModel(h.bin, opts)
  assert.equal(await m.available(), false)
  assert.equal(await m.find(parts), null)
  assert.equal(await m.find(parts), null)
  assert.equal(h.starts(), 1)
  rmSync(dir, { recursive: true, force: true })
})

test('Nicht auf macOS oder ohne Helfer: sofort null', async () => {
  assert.equal(await new SignatureModel('/gibt/es/nicht', opts).find(parts), null)
  assert.equal(await new SignatureModel(process.execPath, { ...opts, platform: 'linux' }).find(parts), null)
})

test('Helfer nicht ausführbar (EACCES): null, kein Hängen, kein Neustart bei jeder Mail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sig-'))
  const bin = join(dir, 'kein-programm')
  writeFileSync(bin, 'nur Text')
  chmodSync(bin, 0o644)
  const m = new SignatureModel(bin, opts)
  assert.equal(await m.find(parts), null)
  assert.equal(await m.available(), false)
  assert.equal(await m.find(parts), null)
  rmSync(dir, { recursive: true, force: true })
})
