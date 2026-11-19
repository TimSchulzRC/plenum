import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// Liest die Einträge einer ICNS-Datei: Typ und Breite des PNGs darin (aus dem IHDR-Block).
function entries(file: string): [string, number][] {
  const buf = readFileSync(file)
  assert.equal(buf.toString('ascii', 0, 4), 'icns')
  assert.equal(buf.readUInt32BE(4), buf.length)
  const out: [string, number][] = []
  for (let at = 8; at < buf.length; ) {
    const type = buf.toString('ascii', at, at + 4)
    const length = buf.readUInt32BE(at + 4)
    const data = buf.subarray(at + 8, at + length)
    assert.equal(data.toString('ascii', 1, 4), 'PNG', `${type} ist kein PNG`)
    out.push([type, data.readUInt32BE(16)])
    at += length
  }
  return out
}

const EXPECTED: [string, number][] = [
  ['icp4', 16], ['ic11', 32], ['icp5', 32], ['ic12', 64], ['ic07', 128],
  ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024],
]

test('Stable- und Nightly-Icon enthalten alle macOS-Größen als PNG in der richtigen Auflösung', () => {
  assert.deepEqual(entries('build/icon.icns'), EXPECTED)
  assert.deepEqual(entries('build/icon-nightly.icns'), EXPECTED)
})

test('Das Dev-Icon für das Dock ist ein 1024er PNG', () => {
  const png = readFileSync('build/icon-dev.png')
  assert.equal(png.toString('ascii', 1, 4), 'PNG')
  assert.equal(png.readUInt32BE(16), 1024)
  assert.equal(png.readUInt32BE(20), 1024)
})
