// Was das Anruffenster zeigt. Ohne React, damit es sich testen lässt.
import type { CallParticipant, CallState } from '@shared/types'
import type { BridgeStream } from './bridge'

// Die Engine benennt die eigene Bildschirmfreigabe so (siehe engine-main.ts).
export const OWN_SCREEN_LABEL = 'Deine Bildschirmfreigabe'

export interface TileModel {
  key: string
  stream?: BridgeStream
  participant?: CallParticipant
  label: string
  kind: 'camera' | 'screen' | 'self'
}

function participantFor(label: string, participants: CallParticipant[]): CallParticipant | undefined {
  const l = label.toLowerCase()
  return participants.find((p) => p.name.toLowerCase() === l) ?? participants.find((p) => l.startsWith(p.name.toLowerCase()))
}

// Kacheln mit Avatar für Teilnehmer ohne Video, bis die Galerie so viele Kacheln hat
const MAX_TILES = 16
const STRIP_TILES = 8

export interface StageModel {
  self?: BridgeStream
  tiles: TileModel[]
  main?: BridgeStream
  strip: TileModel[]
}

export function stageModel(state: CallState, streams: BridgeStream[], view: 'gallery' | 'speaker', pinned: string | null): StageModel {
  const self = streams.find((s) => s.kind === 'self')
  const remoteScreens = streams.filter((s) => s.kind === 'screen' && s.label !== OWN_SCREEN_LABEL)
  const cameras = streams.filter((s) => s.kind === 'camera')

  const tiles: TileModel[] = cameras.map((s) => ({ key: s.streamId, stream: s, label: s.label, kind: 'camera', participant: participantFor(s.label, state.participants) }))
  // Alle ohne eigene Videokachel bekommen eine Avatar-Kachel. Wer laut Teams Video hat, wird nur
  // ausgelassen, solange es Videos gibt, die keinem Namen zugeordnet sind (sonst doppelt).
  const matched = new Set(tiles.map((t) => t.participant?.id).filter(Boolean))
  const unnamedVideo = tiles.some((t) => !t.participant)
  const placeholders = state.participants.filter((p) => !p.isMe && !matched.has(p.id) && !(p.hasVideo && unnamedVideo))
  for (const p of placeholders.slice(0, Math.max(0, MAX_TILES - tiles.length))) tiles.push({ key: `p:${p.id}`, participant: p, label: p.name, kind: 'camera' })

  const pinnedStream = pinned ? streams.find((s) => s.streamId === pinned) : undefined
  const speaking = cameras.find((c) => c.speaking) ?? cameras[0]
  const main: BridgeStream | undefined = pinnedStream ?? remoteScreens[0] ?? (view === 'speaker' ? speaking : undefined)
  const strip = main ? tiles.filter((t) => t.stream?.streamId !== main.streamId).slice(0, STRIP_TILES) : []
  return { self, tiles, main, strip }
}

export function compactMain(streams: BridgeStream[]): BridgeStream | undefined {
  return (
    streams.find((s) => s.kind === 'screen' && s.label !== OWN_SCREEN_LABEL) ??
    streams.find((s) => s.kind === 'camera' && s.speaking) ??
    streams.find((s) => s.kind === 'camera') ??
    streams.find((s) => s.kind === 'self')
  )
}

// Streams, die das Fenster gerade zeigt. Nur diese muss die Engine für die Brücke kodieren.
export function shownStreams(state: CallState | null, streams: BridgeStream[], view: 'gallery' | 'speaker', pinned: string | null, compact: boolean): string[] {
  const ids = new Set<string>()
  if (compact) {
    const m = compactMain(streams)
    if (m) ids.add(m.streamId)
    return [...ids]
  }
  const self = streams.find((s) => s.kind === 'self')
  if (!state) return []
  if (state.phase === 'prejoin') {
    if (self && state.cameraOn) ids.add(self.streamId)
    return [...ids]
  }
  if (state.phase !== 'in-call') return []
  const m = stageModel(state, streams, view, pinned)
  if (m.self && state.cameraOn) ids.add(m.self.streamId)
  if (m.main) {
    ids.add(m.main.streamId)
    for (const t of m.strip) if (t.stream) ids.add(t.stream.streamId)
  } else {
    for (const t of m.tiles) if (t.stream) ids.add(t.stream.streamId)
  }
  return [...ids]
}

