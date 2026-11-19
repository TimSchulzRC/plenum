import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shownStreams, stageModel } from '../src/renderer/src/call/layout.ts'
import type { BridgeStream } from '../src/renderer/src/call/bridge.ts'
import type { CallParticipant, CallState } from '../src/shared/types.ts'

function call(participants: CallParticipant[], extra: Partial<CallState> = {}): CallState {
  return { accountId: 'a', phase: 'in-call', title: 'Sync', muted: false, cameraOn: true, sharing: false, handRaised: false, participants, available: {}, ...extra }
}
function cam(id: string, label: string, kind: BridgeStream['kind'] = 'camera'): BridgeStream {
  return { streamId: id, label, kind, media: null }
}

test('Teilnehmer ohne Video bekommen eine Kachel, auch wenn Teams sie nicht als stumm meldet', () => {
  const state = call([
    { id: 'Müller, Anna', name: 'Müller, Anna', hasVideo: true },
    { id: 'Wolf, Hanna', name: 'Wolf, Hanna' },
    { id: 'Neumann, Ida', name: 'Neumann, Ida' },
    { id: '__self', name: 'Schulz, Tim', isMe: true }
  ])
  const m = stageModel(state, [cam('t1', 'Müller, Anna'), cam('s', 'Du', 'self')], 'gallery', null)
  assert.deepEqual(
    m.tiles.map((t) => t.label),
    ['Müller, Anna', 'Wolf, Hanna', 'Neumann, Ida']
  )
})

test('Wer laut Teams Video hat, aber keinen Stream liefert, erscheint als Avatar', () => {
  const state = call([
    { id: 'Müller, Anna', name: 'Müller, Anna', hasVideo: true },
    { id: 'Weber, Clara', name: 'Weber, Clara', hasVideo: true }
  ])
  const m = stageModel(state, [cam('t1', 'Müller, Anna')], 'gallery', null)
  assert.deepEqual(
    m.tiles.map((t) => t.label),
    ['Müller, Anna', 'Weber, Clara']
  )
})

test('Kein doppelter Avatar, solange ein Video keinem Namen zugeordnet ist', () => {
  const state = call([{ id: 'Weber, Clara', name: 'Weber, Clara', hasVideo: true }, { id: 'Wolf, Hanna', name: 'Wolf, Hanna' }])
  const m = stageModel(state, [cam('t1', 'Teilnehmer')], 'gallery', null)
  assert.deepEqual(
    m.tiles.map((t) => t.label),
    ['Teilnehmer', 'Wolf, Hanna']
  )
})

test('Kompaktansicht überträgt nur das eine sichtbare Video', () => {
  const streams = [cam('t1', 'Müller, Anna'), cam('t2', 'Schmidt, Ben'), cam('s', 'Du', 'self')]
  const state = call([])
  assert.deepEqual(shownStreams(state, streams, 'gallery', null, true), ['t1'])
  assert.deepEqual(shownStreams(state, streams, 'gallery', null, false).sort(), ['s', 't1', 't2'])
})

test('Eigene Kamera wird nur übertragen, wenn sie an ist', () => {
  const streams = [cam('t1', 'Müller, Anna'), cam('s', 'Du', 'self')]
  assert.deepEqual(shownStreams(call([], { cameraOn: false }), streams, 'gallery', null, false), ['t1'])
  assert.deepEqual(shownStreams(call([], { phase: 'prejoin', cameraOn: true }), streams, 'gallery', null, false), ['s'])
  assert.deepEqual(shownStreams(call([], { phase: 'lobby' }), streams, 'gallery', null, false), [])
})

test('Bei Bildschirmfreigabe: Freigabe plus höchstens acht Videos im Streifen', () => {
  const streams = [cam('screen', 'Müller, Anna (Bildschirm)', 'screen'), ...Array.from({ length: 10 }, (_, i) => cam(`t${i}`, `Person ${i}`))]
  const shown = shownStreams(call([], { cameraOn: false }), streams, 'gallery', null, false)
  assert.equal(shown.length, 9)
  assert.ok(shown.includes('screen'))
})
