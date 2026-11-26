import assert from 'node:assert/strict'
import { test } from 'node:test'
import { displayResponse } from '../src/main/display-response.ts'

test('beim ganzen Bildschirm geht der Systemton mit', () => {
  const src = { id: 'screen:1:0' }
  assert.deepEqual(displayResponse(src), { video: src, audio: 'loopback' })
})

test('bei Fenstern fehlt der Schlüssel audio ganz', () => {
  // Electron wirft bei { audio: undefined }, sobald die Seite Ton anfragt
  assert.deepEqual(Object.keys(displayResponse({ id: 'window:4194306:2' })), ['video'])
})
