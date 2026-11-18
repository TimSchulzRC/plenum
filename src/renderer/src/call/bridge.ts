// Empfängerseite der Medienbrücke: Die versteckte Teams-Web-App schickt die
// Video-Tracks eines Anrufs per lokaler WebRTC-Verbindung an dieses Fenster.
import { useEffect, useRef, useState } from 'react'
import type { BridgeMessage, CallState, MediaStreamInfo } from '@shared/types'
import { onEvent } from '../api'

export interface BridgeStream extends MediaStreamInfo {
  media: MediaStream | null
}

const OFFER_TIMEOUT = 4000
const UNCOVERED_GRACE = 3000
const FAILED_RETRY = 1500

class Receiver {
  private pc: RTCPeerConnection | null = null
  private mids: Record<string, string> = {}
  private midStreams = new Map<string, MediaStream>()
  private infos: MediaStreamInfo[] = []
  private pendingIce: RTCIceCandidateInit[] = []
  private queue: Promise<void> = Promise.resolve()
  private gotOffer = false
  private offerTimer?: ReturnType<typeof setTimeout>
  private uncoveredTimer?: ReturnType<typeof setTimeout>
  private retryTimer?: ReturnType<typeof setTimeout>
  private disposed = false
  private offs: (() => void)[] = []
  private lastCall: CallState | null | undefined = undefined

  constructor(
    private readonly want: 'all' | string[],
    private readonly onUpdate: (streams: BridgeStream[], connected: boolean) => void
  ) {}

  start(): void {
    this.offs.push(onEvent('bridge', (m) => this.onMessage(m)))
    this.offs.push(
      onEvent('call-state', (s) => {
        // Anruf beginnt (null -> aktiv): neu abonnieren, die Engine hat jetzt Tracks.
        if (s && !this.lastCall && this.lastCall !== undefined) this.subscribe()
        this.lastCall = s
      })
    )
    this.subscribe()
  }

  dispose(): void {
    this.disposed = true
    for (const off of this.offs) off()
    this.offs = []
    this.clearTimers()
    window.teams.bridgeSend({ type: 'unsubscribe', receiverId: 0 })
    this.closePc()
  }

  private clearTimers(): void {
    clearTimeout(this.offerTimer)
    clearTimeout(this.uncoveredTimer)
    clearTimeout(this.retryTimer)
  }

  private closePc(): void {
    if (this.pc) {
      this.pc.onicecandidate = null
      this.pc.ontrack = null
      this.pc.onconnectionstatechange = null
      this.pc.close()
    }
    this.pc = null
    this.mids = {}
    this.midStreams.clear()
    this.pendingIce = []
  }

  private createPc(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' })
    pc.onicecandidate = (e) => {
      window.teams.bridgeSend({ type: 'ice', receiverId: 0, from: 'receiver', candidate: e.candidate ? e.candidate.toJSON() : null })
    }
    pc.ontrack = (e) => {
      const mid = e.transceiver?.mid
      if (mid && !this.midStreams.has(mid)) this.midStreams.set(mid, new MediaStream([e.track]))
      this.publish()
    }
    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return
      if (pc.connectionState === 'failed') this.scheduleRetry(1000)
      this.publish()
    }
    return pc
  }

  subscribe(): void {
    if (this.disposed) return
    this.clearTimers()
    this.closePc()
    this.pc = this.createPc()
    this.gotOffer = false
    this.queue = Promise.resolve()
    window.teams.bridgeSend({ type: 'subscribe', receiverId: 0, streams: this.want })
    this.offerTimer = setTimeout(() => {
      if (!this.gotOffer) this.subscribe()
    }, OFFER_TIMEOUT)
    this.publish()
  }

  private scheduleRetry(ms: number): void {
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => this.subscribe(), ms)
  }

  private onMessage(msg: BridgeMessage): void {
    if (this.disposed) return
    switch (msg.type) {
      case 'streams':
        this.infos = msg.streams
        this.checkCoverage()
        this.publish()
        break
      case 'offer':
        this.gotOffer = true
        clearTimeout(this.offerTimer)
        this.enqueue(() => this.handleOffer(msg.sdp, msg.mids))
        break
      case 'map':
        this.mids = { ...msg.mids }
        this.checkCoverage()
        this.publish()
        break
      case 'ice':
        if (msg.from !== 'engine') return
        this.enqueue(() => this.handleIce(msg.candidate))
        break
      case 'failed':
        this.scheduleRetry(FAILED_RETRY)
        break
      default:
        break
    }
  }

  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn).catch((e) => console.warn('[bridge]', e))
  }

  private async handleOffer(sdp: string, mids: Record<string, string>): Promise<void> {
    const pc = this.pc
    if (!pc) return
    await pc.setRemoteDescription({ type: 'offer', sdp })
    this.mids = { ...mids }
    // Für jeden Video-Transceiver einen stabilen MediaStream halten
    for (const t of pc.getTransceivers()) {
      if (t.mid && t.receiver.track.kind === 'video' && !this.midStreams.has(t.mid)) {
        this.midStreams.set(t.mid, new MediaStream([t.receiver.track]))
      }
    }
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    window.teams.bridgeSend({ type: 'answer', receiverId: 0, sdp: pc.localDescription?.sdp ?? answer.sdp ?? '' })
    for (const c of this.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => undefined)
    this.checkCoverage()
    this.publish()
  }

  private async handleIce(candidate: RTCIceCandidateInit | null): Promise<void> {
    const pc = this.pc
    if (!pc || !candidate) return
    if (!pc.remoteDescription) {
      this.pendingIce.push(candidate)
      return
    }
    await pc.addIceCandidate(candidate).catch(() => undefined)
  }

  private wanted(info: MediaStreamInfo): boolean {
    return this.want === 'all' || this.want.includes(info.streamId)
  }

  // Liefert die Engine Streams, die wir nicht zugeordnet bekommen, wurde sie wohl neu geladen.
  private checkCoverage(): void {
    const covered = new Set(Object.values(this.mids))
    const uncovered = this.infos.some((i) => this.wanted(i) && !covered.has(i.streamId))
    if (!uncovered) {
      clearTimeout(this.uncoveredTimer)
      this.uncoveredTimer = undefined
      return
    }
    if (this.uncoveredTimer) return
    this.uncoveredTimer = setTimeout(() => {
      this.uncoveredTimer = undefined
      const nowCovered = new Set(Object.values(this.mids))
      if (this.infos.some((i) => this.wanted(i) && !nowCovered.has(i.streamId))) this.subscribe()
    }, UNCOVERED_GRACE)
  }

  private publish(): void {
    if (this.disposed) return
    const midByStream = new Map<string, string>()
    for (const [mid, sid] of Object.entries(this.mids)) midByStream.set(sid, mid)
    const out: BridgeStream[] = []
    const seen = new Set<string>()
    for (const info of this.infos) {
      if (!this.wanted(info)) continue
      const mid = midByStream.get(info.streamId)
      out.push({ ...info, media: (mid && this.midStreams.get(mid)) || null })
      seen.add(info.streamId)
    }
    // Zugeordnete Streams, zu denen (noch) keine Beschreibung vorliegt
    for (const [sid, mid] of midByStream) {
      if (seen.has(sid)) continue
      if (this.want !== 'all' && !this.want.includes(sid)) continue
      out.push({ streamId: sid, label: 'Teilnehmer', kind: 'camera', media: this.midStreams.get(mid) ?? null })
    }
    this.onUpdate(out, this.pc?.connectionState === 'connected')
  }
}

export function useBridge(streams: 'all' | string[]): { streams: BridgeStream[]; connected: boolean } {
  const [state, setState] = useState<{ streams: BridgeStream[]; connected: boolean }>({ streams: [], connected: false })
  const key = streams === 'all' ? 'all' : streams.join('|')
  const wantRef = useRef(streams)
  wantRef.current = streams

  useEffect(() => {
    const r = new Receiver(wantRef.current, (s, connected) => setState({ streams: s, connected }))
    r.start()
    return () => r.dispose()
  }, [key])

  return state
}
