/* eslint-disable @typescript-eslint/no-explicit-any */
// Läuft in der "Main World" der Teams-Web-App. Die Funktion wird per toString()
// serialisiert, darf also keine Imports oder Variablen außerhalb nutzen.

export function engineMainWorld(): void {
  const w = window as any
  if (w.__tmInstalled) return
  w.__tmInstalled = true

  const post = (msg: any): void => {
    document.dispatchEvent(new CustomEvent('__tm_to_iso', { detail: JSON.stringify(msg) }))
  }
  // Teams löscht beim Beitritt zu Besprechungen offenbar fremde Zeitgeber. Eigene IDs schützen.
  const nativeSetInterval = window.setInterval.bind(window)
  const nativeSetTimeout = window.setTimeout.bind(window)
  const nativeClearInterval = window.clearInterval.bind(window)
  const nativeClearTimeout = window.clearTimeout.bind(window)
  const ownTimers = new Set<number>()
  const protectedClear = (native: (id?: number) => void) =>
    function (id?: number) {
      if (id != null && ownTimers.has(Number(id))) return
      return native(id)
    }
  try {
    window.clearInterval = protectedClear(nativeClearInterval) as typeof window.clearInterval
    window.clearTimeout = protectedClear(nativeClearTimeout) as typeof window.clearTimeout
  } catch {
    /* ignore */
  }
  const ownInterval = (fn: () => void, ms: number): number => {
    const id = nativeSetInterval(fn, ms) as unknown as number
    ownTimers.add(id)
    return id
  }
  const ownTimeout = (fn: (v?: unknown) => void, ms: number): number => {
    const id = nativeSetTimeout(() => {
      ownTimers.delete(id)
      fn()
    }, ms) as unknown as number
    ownTimers.add(id)
    return id
  }
  const origLog = console.log.bind(console)
  const log = (...a: any[]): void => origLog('[tm]', ...a)

  // ---------- Anmeldeseiten: Passkeys/WebAuthn ----------
  // Electron hat auf macOS keine WebAuthn-Oberfläche (Touch ID, Passkeys). Ohne diesen Patch
  // wartet die Microsoft-Seite endlos auf ein Sicherheitsfenster. Wir lassen die Abfrage sofort
  // scheitern, damit Microsoft die übrigen Anmeldemethoden anbietet.
  if (!/(^|\.)teams\.(microsoft\.com|cloud\.microsoft|live\.com)$/.test(location.hostname)) {
    try {
      const fail = () => Promise.reject(new DOMException('Passkeys werden in dieser App nicht unterstützt.', 'NotAllowedError'))
      const creds = navigator.credentials as any
      if (creds) {
        const origGet = creds.get?.bind(creds)
        creds.get = (opts: any) => (opts && opts.publicKey ? fail() : origGet ? origGet(opts) : fail())
        const origCreate = creds.create?.bind(creds)
        creds.create = (opts: any) => (opts && opts.publicKey ? fail() : origCreate ? origCreate(opts) : fail())
      }
      const PKC = w.PublicKeyCredential
      if (PKC) {
        PKC.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false)
        PKC.isConditionalMediationAvailable = () => Promise.resolve(false)
        if (PKC.getClientCapabilities) PKC.getClientCapabilities = () => Promise.resolve({})
      }
    } catch (e) {
      log('webauthn patch failed', String(e))
    }
    log('login page', location.hostname)
    return
  }

  // ---------- Seite gilt immer als sichtbar und fokussiert ----------
  try {
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => false })
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'visible' })
    Object.defineProperty(Document.prototype, 'webkitHidden', { configurable: true, get: () => false })
    Object.defineProperty(Document.prototype, 'webkitVisibilityState', { configurable: true, get: () => 'visible' })
    Document.prototype.hasFocus = function () {
      return true
    }
    for (const t of ['visibilitychange', 'webkitvisibilitychange']) {
      document.addEventListener(t, (e) => e.stopImmediatePropagation(), true)
      window.addEventListener(t, (e) => e.stopImmediatePropagation(), true)
    }
    window.addEventListener(
      'blur',
      (e) => {
        if (e.target === window) e.stopImmediatePropagation()
      },
      true
    )
  } catch (e) {
    log('visibility patch failed', String(e))
  }

  // ---------- Medien-Hooks ----------
  const OrigPC: typeof RTCPeerConnection = w.RTCPeerConnection
  const localTracks = new Map<string, { track: MediaStreamTrack; kind: 'camera' | 'mic' | 'screen' }>()
  const remoteTracks = new Map<string, { track: MediaStreamTrack; at: number }>()
  const teamsPcs = new Set<RTCPeerConnection>()
  const prefs: { camera?: string; mic?: string; speaker?: string } = {}
  // Zählt Aufrufe von getDisplayMedia. So sieht "Teilen", ob Teams nach dem Klick eine Quelle anfragt.
  let displayRequests = 0

  function withDevice(c: any, id: string | undefined): any {
    if (!id || !c) return c
    if (c === true) return { deviceId: { ideal: id } }
    if (typeof c === 'object' && !c.deviceId) return { ...c, deviceId: { ideal: id } }
    return c
  }

  try {
    const proto = MediaDevices.prototype as any
    const origGUM = proto.getUserMedia
    proto.getUserMedia = async function (constraints: any) {
      let c = constraints
      try {
        // Einstellungen speichern Gerätenamen, weil Geräte-IDs je Herkunft verschieden sind.
        const devs = prefs.mic || prefs.camera ? await navigator.mediaDevices.enumerateDevices() : []
        const byLabel = (label: string | undefined, kind: MediaDeviceKind) => (label ? devs.find((d) => d.kind === kind && d.label === label)?.deviceId : undefined)
        c = {
          ...constraints,
          audio: withDevice(constraints?.audio, byLabel(prefs.mic, 'audioinput')),
          video: withDevice(constraints?.video, byLabel(prefs.camera, 'videoinput'))
        }
      } catch {
        c = constraints
      }
      let s: MediaStream
      try {
        s = await origGUM.call(this, c)
      } catch (e) {
        if (c !== constraints) s = await origGUM.call(this, constraints)
        else throw e
      }
      for (const t of s.getTracks()) {
        localTracks.set(t.id, { track: t, kind: t.kind === 'video' ? 'camera' : 'mic' })
        t.addEventListener('ended', () => scheduleScan())
      }
      scheduleScan()
      return s
    }
    const origGDM = proto.getDisplayMedia
    if (origGDM) {
      proto.getDisplayMedia = async function (constraints: any) {
        displayRequests++
        post({ ch: 'display-media-requested' })
        let s: MediaStream
        try {
          s = await origGDM.call(this, constraints)
        } catch (e) {
          // NotAllowedError heißt meist: Auswahl abgebrochen oder keine Quellen
          log('getDisplayMedia failed', (e as Error)?.name || String(e))
          throw e
        }
        for (const t of s.getVideoTracks()) {
          localTracks.set(t.id, { track: t, kind: 'screen' })
          t.addEventListener('ended', () => scheduleScan())
        }
        scheduleScan()
        return s
      }
    }
  } catch (e) {
    log('media hook failed', String(e))
  }

  try {
    class TMPeerConnection extends OrigPC {
      constructor(...args: any[]) {
        super(...(args as [RTCConfiguration?]))
        teamsPcs.add(this)
        this.addEventListener('track', (ev: RTCTrackEvent) => {
          remoteTracks.set(ev.track.id, { track: ev.track, at: Date.now() })
          ev.track.addEventListener('ended', () => {
            remoteTracks.delete(ev.track.id)
            scheduleScan()
          })
          scheduleScan()
        })
        this.addEventListener('connectionstatechange', () => {
          if (this.connectionState === 'closed' || this.connectionState === 'failed') teamsPcs.delete(this)
        })
      }
    }
    w.RTCPeerConnection = TMPeerConnection
    w.webkitRTCPeerConnection = TMPeerConnection
  } catch (e) {
    log('pc hook failed', String(e))
  }

  // Lautsprecher-Auswahl
  try {
    const origPlay = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      const el = this as any
      if (prefs.speaker && typeof el.setSinkId === 'function') {
        void navigator.mediaDevices.enumerateDevices().then((devs) => {
          const id = devs.find((d) => d.kind === 'audiooutput' && d.label === prefs.speaker)?.deviceId
          if (id && el.sinkId !== id) el.setSinkId(id).catch(() => undefined)
        })
      }
      return origPlay.call(this)
    }
  } catch {
    /* ignore */
  }

  // ---------- DOM-Hilfen ----------
  const RX = (s: string) => new RegExp(s, 'i')
  function visible(el: Element | null): el is HTMLElement {
    if (!el) return false
    const r = (el as HTMLElement).getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none'
  }
  function q(selectors: string[]): HTMLElement | null {
    for (const s of selectors) {
      try {
        const all = document.querySelectorAll<HTMLElement>(s)
        for (const el of Array.from(all)) if (visible(el)) return el
      } catch {
        /* ungültiger Selektor */
      }
    }
    return null
  }
  function labelOf(el: Element | null): string {
    if (!el) return ''
    return (
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('data-tooltip') ||
      (el as HTMLElement).innerText ||
      ''
    ).trim()
  }
  function attrLabel(el: Element): string {
    return (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-tooltip') || '').trim()
  }
  function byLabel(rx: RegExp, root: ParentNode = document, tag = 'button,[role="button"],[role="menuitem"],[role="menuitemcheckbox"]'): HTMLElement | null {
    // Ohne ^ und $ ist ein Treffer im innerText immer auch einer im textContent. textContent kostet
    // kein Layout und siebt fast alle Knöpfe aus, bevor Sichtbarkeit und innerText geprüft werden.
    const loose = !/^\^|\$$/.test(rx.source)
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(tag))) {
      const attr = attrLabel(el)
      if (attr) {
        if (rx.test(attr) && visible(el)) return el
        continue
      }
      if (loose && !rx.test(el.textContent || '')) continue
      if (visible(el) && rx.test((el.innerText || '').trim())) return el
    }
    return null
  }
  async function waitFor<T>(fn: () => T | null, timeout: number): Promise<T | null> {
    const t0 = Date.now()
    for (;;) {
      const r = fn()
      if (r) return r
      if (Date.now() - t0 > timeout) return null
      await new Promise((res) => ownTimeout(res, 250))
    }
  }
  // Nur ein einfacher Klick: zusätzliche Zeiger-Ereignisse lösen manche Teams-Knöpfe doppelt aus.
  function click(el: HTMLElement | null): boolean {
    if (!el) return false
    try {
      el.focus({ preventScroll: true })
    } catch {
      /* ignore */
    }
    el.click()
    return true
  }

  const SEL = {
    hangup: ['#hangup-button', '#hangup-main-btn', '[data-tid="hangup-main-btn"]', '[data-tid="call-hangup"]', '[data-tid="hangup-button"]', '[data-tid="call-control-hangup"]'],
    mic: ['#microphone-button', '[data-tid="microphone-button"]', '[data-tid="call-control-mic"]'],
    camera: ['#video-button', '[data-tid="video-button"]', '[data-tid="call-control-camera"]'],
    share: ['#share-button', '[data-tid="share-button"]', '[data-tid="call-control-share"]'],
    raiseHand: ['#raisehands-button', '[data-tid="raisehands-button"]', '[data-tid="raise-hand-button"]'],
    chat: ['#chat-button', '[data-tid="chat-button"]'],
    roster: ['#roster-button', '[data-tid="roster-button"]', '#people-button'],
    react: ['#reaction-menu-button', '[data-tid^="reaction-menu-button"]'],
    joinNow: ['[data-tid="prejoin-join-button"]', '#prejoin-join-button'],
    prejoinMic: ['[data-tid="toggle-mute"]', '#preJoinAudioButton', '[data-tid="prejoin-mic-toggle"]'],
    prejoinCam: ['[data-tid="toggle-video"]', '#preJoinVideoButton', '[data-tid="prejoin-video-toggle"]'],
    joinOnWeb: ['[data-tid="joinOnWeb"]', '#joinOnWeb']
  }
  const LBL = {
    hangup: RX('^(leave|verlassen|hang up|auflegen|anruf beenden|end call)'),
    unmute: RX('(unmute|stummschaltung.*aufheben|mikrofon einschalten|turn on mic)'),
    mute: RX('^(mute|stummschalten|mikrofon (aus|stumm))'),
    camOn: RX('(turn camera on|kamera einschalten|start video|video starten)'),
    camOff: RX('(turn camera off|kamera ausschalten|stop video|video beenden)'),
    stopShare: RX('(stop sharing|stop presenting|freigabe beenden|präsentation beenden|teilen beenden)'),
    joinNow: RX('^(join now|jetzt teilnehmen|teilnehmen|join)$'),
    acceptVideo: RX('(accept with video|mit video annehmen|video annehmen)'),
    acceptAudio: RX('(accept with audio|mit audio annehmen|audio annehmen|^accept$|^annehmen$)'),
    decline: RX('(decline|ablehnen)'),
    lowerHand: RX('^(lower|lower hand|hand senken|senken)'),
    lobby: RX('(someone in the meeting should let you in|jemand in der besprechung sollte sie|wartebereich|lobby)'),
    continueBrowser: RX('(continue on this browser|in diesem browser fortfahren|auf diesem browser fortfahren|use the web app instead|stattdessen.*web)'),
    audioCall: RX('^(audio call|audioanruf|anrufen|call)$')
  }

  function micMuted(btn: HTMLElement | null): boolean {
    if (!btn) return false
    const st = (btn.getAttribute('data-state') || '').toLowerCase()
    if (st) return /off|mute/.test(st) && !/unmute/.test(st) ? true : st === 'mic' ? false : /off/.test(st)
    const l = labelOf(btn)
    if (LBL.unmute.test(l)) return true
    if (LBL.mute.test(l)) return false
    const pressed = btn.getAttribute('aria-pressed') ?? btn.getAttribute('aria-checked')
    if (pressed != null) return pressed === 'false'
    return false
  }
  function cameraOn(btn: HTMLElement | null): boolean {
    if (!btn) return false
    const st = (btn.getAttribute('data-state') || '').toLowerCase()
    if (st) return !/off/.test(st)
    const l = labelOf(btn)
    if (LBL.camOn.test(l)) return false
    if (LBL.camOff.test(l)) return true
    const pressed = btn.getAttribute('aria-pressed') ?? btn.getAttribute('aria-checked')
    if (pressed != null) return pressed === 'true'
    return false
  }

  // ---------- Video-Quellen ----------
  // Teams-Kacheln haben aria-labels wie "Schulz, Tim, Muted, video is on, Fill frame, Has context menu"
  // oder "Myself video, Schulz, Tim, Unmuted, ...".
  const STATE_TOKEN = /^(muted|unmuted|stummgeschaltet|nicht stummgeschaltet|stummschaltung aufgehoben|video is on|video is off|video ist (an|aus)|kamera (an|aus)|fill frame|fit to frame|an rahmen anpassen|rahmen füllen|has context menu|hat kontextmenü|speaking|spricht|pinned|angeheftet|spotlighted|im fokus|hand raised|hand gehoben|raised hand|presenting|präsentiert|organizer|organisator|guest|gast|external|extern|unverified|.*background.*)$/i
  interface TileInfo {
    name: string
    self: boolean
    muted?: boolean
    speaking?: boolean
    hand?: boolean
    screen?: boolean
  }
  function parseTileLabel(al: string): TileInfo | null {
    if (!al || al.length > 300) return null
    const parts = al.split(/,\s*/).map((x) => x.trim()).filter(Boolean)
    let self = false
    if (/^(myself video|mein video|my video|dein video)$/i.test(parts[0] ?? '')) {
      self = true
      parts.shift()
    }
    const lower = al.toLowerCase()
    const hasState = /(muted|unmuted|stumm|video is|kamera|fill frame|fit to frame|context menu|kontextmenü)/.test(lower)
    if (!self && !hasState) return null
    const nameParts = parts.filter((x) => !STATE_TOKEN.test(x))
    return {
      name: nameParts.slice(0, 3).join(', '),
      self,
      muted: /(^|, )(muted|stummgeschaltet)(,|$)/i.test(al),
      speaking: /(speaking|spricht)/i.test(al),
      hand: /(hand raised|hand gehoben|raised hand)/i.test(al),
      screen: /(screen|bildschirm|content|inhalt|presenting|präsentiert)/i.test(lower) && !/video is on/.test(lower)
    }
  }
  // Teams v2 trägt den Anzeigenamen stabil im data-tid: <div data-tid="video-item-container-Name">
  // mit <div data-stream-type="Video|ScreenSharing" data-tid="Name"> darin. Das gilt auch für
  // Teilnehmer ohne Video, deren Kachel kein Mute-Label haben muss.
  const CONTAINER_PREFIX = 'video-item-container-'
  const STREAM_SEL = '[data-stream-type][data-tid]'
  const CONTAINER_SEL = `[data-tid^="${CONTAINER_PREFIX}"]`
  function plausibleName(n: string): boolean {
    if (!n || n.length > 120) return false
    // Technische Kennungen wie "voice-level-stream-outline" oder "videoTile" sind keine Namen
    return !/^(?:[a-z0-9]+(?:[-_][a-z0-9]+)+|[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+|\d+)$/.test(n)
  }
  interface TeamsTile {
    name: string
    screen: boolean
    self: boolean
    container: Element
  }
  function teamsTile(el: Element): TeamsTile | null {
    // Liegt el in einem Stream, zählt dieser. Für eine ganze Kachel den Kamera-Stream nehmen.
    const own = el.closest(STREAM_SEL)
    const wrapper = own ?? el.querySelector('[data-stream-type="Video"][data-tid]') ?? el.querySelector(STREAM_SEL)
    const container = el.closest(CONTAINER_SEL) ?? wrapper?.closest(CONTAINER_SEL) ?? wrapper
    if (!container) return null
    let name = wrapper?.getAttribute('data-tid')?.trim() || ''
    if (!plausibleName(name)) {
      // Hinter dem Präfix steht immer der Anzeigename, auch wenn er wie eine Kennung aussieht
      const tid = container.getAttribute('data-tid') || ''
      name = tid.startsWith(CONTAINER_PREFIX) ? tid.slice(CONTAINER_PREFIX.length).trim() : ''
      if (name.length > 120) name = ''
    }
    if (!name) return null
    const self = !!(container.closest('[data-tid="myself-video"]') || container.querySelector('[data-tid="myself-video"]'))
    return { name, screen: own?.getAttribute('data-stream-type') === 'ScreenSharing', self, container }
  }

  function tileFor(v: Element): { el: Element; info: TileInfo } | null {
    let n: Element | null = v
    for (let i = 0; i < 14 && n; i++) {
      n = n.parentElement
      if (!n) break
      const tid = n.getAttribute('data-tid') || ''
      if (tid === 'myself-video') return { el: n, info: { ...(parseTileLabel(n.getAttribute('aria-label') || '') ?? { name: '' }), self: true } }
      const info = parseTileLabel(n.getAttribute('aria-label') || '')
      if (info) return { el: n, info }
    }
    return null
  }
  function guessKind(v: HTMLVideoElement): 'camera' | 'screen' {
    let n: Element | null = v
    for (let i = 0; i < 10 && n; i++) {
      const s = ((n.getAttribute('data-tid') || '') + ' ' + (n.getAttribute('data-cid') || '') + ' ' + (n.id || '')).toLowerCase()
      if (/screen|content|share|vbss|presentation|ppt/.test(s)) return 'screen'
      n = n.parentElement
    }
    return 'camera'
  }

  interface Src {
    id: string
    track: MediaStreamTrack
    label: string
    kind: 'camera' | 'screen' | 'self'
    width?: number
    height?: number
    speaking?: boolean
  }
  let sources = new Map<string, Src>()
  let lastSourcesJson = ''

  function collectSources(): Map<string, Src> {
    const out = new Map<string, Src>()
    let haveSelf = false
    for (const v of Array.from(document.querySelectorAll('video'))) {
      const s = (v as HTMLVideoElement).srcObject
      if (!(s instanceof MediaStream)) continue
      const vt = s.getVideoTracks().find((t) => t.readyState === 'live')
      if (!vt || out.has(vt.id)) continue
      const local = localTracks.get(vt.id)
      const tile = tileFor(v)
      const tt = teamsTile(v)
      if (tt && tile) {
        tile.info.name = tt.name
        if (tt.screen) tile.info.screen = true
        if (tt.self) tile.info.self = true
      }
      let kind: Src['kind']
      let label: string
      if (local?.kind === 'screen') {
        kind = 'screen'
        label = 'Deine Bildschirmfreigabe'
      } else if (local || tile?.info.self || tt?.self) {
        if (haveSelf) continue
        kind = 'self'
        label = 'Du'
        haveSelf = true
      } else {
        const name = tile?.info.name || tt?.name
        kind = tile?.info.screen || tt?.screen ? 'screen' : guessKind(v as HTMLVideoElement)
        label = name || 'Teilnehmer'
        if (kind === 'screen' && name) label = `${name} (Bildschirm)`
      }
      out.set(vt.id, { id: vt.id, track: vt, label, kind, width: (v as HTMLVideoElement).videoWidth, height: (v as HTMLVideoElement).videoHeight, speaking: tile?.info.speaking })
    }
    // Eigene Freigabe/Kamera auch ohne Vorschau-Element
    for (const [id, l] of localTracks) {
      if (l.kind === 'mic' || l.track.readyState !== 'live' || out.has(id) || !l.track.enabled) continue
      if (l.kind === 'camera' && haveSelf) continue
      if (l.kind === 'camera') haveSelf = true
      out.set(id, { id, track: l.track, label: l.kind === 'screen' ? 'Deine Bildschirmfreigabe' : 'Du', kind: l.kind === 'screen' ? 'screen' : 'self' })
    }
    // Entfernte Video-Tracks, die Teams nicht in <video> rendert
    if (out.size === 0 || ![...out.values()].some((s) => s.kind !== 'self')) {
      let i = 1
      for (const [id, r] of remoteTracks) {
        if (r.track.kind !== 'video' || r.track.readyState !== 'live' || r.track.muted || out.has(id)) continue
        out.set(id, { id, track: r.track, label: `Teilnehmer ${i++}`, kind: 'camera' })
      }
    }
    return out
  }

  let scanTimer: any = null
  function scheduleScan(): void {
    if (scanTimer) return
    scanTimer = ownTimeout(() => {
      scanTimer = null
      scan()
    }, 150)
  }

  function scan(): void {
    sources = collectSources()
    const info = [...sources.values()].map((s) => ({ streamId: s.id, label: s.label, kind: s.kind, width: s.width, height: s.height, speaking: s.speaking }))
    const json = JSON.stringify(info)
    if (json !== lastSourcesJson) {
      lastSourcesJson = json
      post({ ch: 'streams', streams: info })
    }
    for (const r of receivers.values()) syncReceiver(r)
  }

  // ---------- Medienbrücke ----------
  interface Receiver {
    id: number
    pc: RTCPeerConnection
    want: 'all' | Set<string>
    senders: Map<string, RTCRtpSender>
    free: RTCRtpSender[]
    negotiating: boolean
    again: boolean
  }
  const receivers = new Map<number, Receiver>()

  function sendMap(r: Receiver): void {
    const mids: Record<string, string> = {}
    for (const t of r.pc.getTransceivers()) {
      if (!t.mid) continue
      for (const [sid, s] of r.senders) if (s === t.sender) mids[t.mid] = sid
    }
    post({ ch: 'bridge', msg: { type: 'map', receiverId: r.id, mids } })
  }

  // H.264 vor VP8: macOS kodiert und dekodiert H.264 in Hardware (VideoToolbox), VP8 nur in
  // Software. Jeder Stream wird für die Brücke neu kodiert, das war der größte CPU-Posten im Anruf.
  let codecOrder: RTCRtpCodec[] | null | undefined
  function preferredCodecs(): RTCRtpCodec[] | null {
    if (codecOrder !== undefined) return codecOrder
    codecOrder = null
    try {
      const codecs = RTCRtpSender.getCapabilities('video')?.codecs ?? []
      const rank = (c: RTCRtpCodec): number => {
        if (c.mimeType.toLowerCase() !== 'video/h264' || !/packetization-mode=1/.test(c.sdpFmtpLine ?? '')) return 2
        // Constrained Baseline können alle Hardware-Encoder
        return /profile-level-id=42e0/i.test(c.sdpFmtpLine ?? '') ? 0 : 1
      }
      if (codecs.some((c) => rank(c) < 2)) codecOrder = [...codecs].sort((a, b) => rank(a) - rank(b))
    } catch (e) {
      log('codec capabilities failed', String(e))
    }
    return codecOrder
  }
  const codecSet = new WeakSet<RTCRtpTransceiver>()
  function preferCodecs(pc: RTCPeerConnection): void {
    const codecs = preferredCodecs()
    if (!codecs) return
    for (const t of pc.getTransceivers()) {
      if (codecSet.has(t)) continue
      codecSet.add(t)
      try {
        t.setCodecPreferences(codecs)
      } catch (e) {
        log('setCodecPreferences failed', String(e))
      }
    }
  }

  // Einmal je Verbindung ins Log: welcher Codec und Encoder tatsächlich läuft
  function logEncoders(r: Receiver): void {
    ownTimeout(() => {
      if (r.pc.connectionState !== 'connected') return
      void r.pc
        .getStats()
        .then((stats) => {
          const out: string[] = []
          stats.forEach((s: any) => {
            if (s.type !== 'outbound-rtp' || s.kind !== 'video' || !s.frameWidth) return
            const codec = (stats.get(s.codecId) as any)?.mimeType?.replace('video/', '') ?? '?'
            out.push(`${codec} ${s.encoderImplementation ?? '?'}${s.powerEfficientEncoder ? ' (hw)' : ''} ${s.frameWidth}x${s.frameHeight}@${Math.round(s.framesPerSecond ?? 0)} ${s.qualityLimitationReason ?? ''}`.trim())
          })
          if (out.length) post({ ch: 'log', text: `bridge ${r.id} encoders: ${out.join(' | ')}` })
        })
        .catch(() => undefined)
    }, 10_000)
  }

  function tuneSender(sender: RTCRtpSender, kind: string): void {
    try {
      const p = sender.getParameters()
      if (!p.encodings || p.encodings.length === 0) p.encodings = [{}]
      p.encodings[0].maxBitrate = kind === 'screen' ? 12_000_000 : 4_000_000
      ;(p as any).degradationPreference = kind === 'screen' ? 'maintain-resolution' : 'balanced'
      sender.setParameters(p).catch(() => undefined)
    } catch {
      /* ignore */
    }
  }

  function syncReceiver(r: Receiver): void {
    if (r.pc.signalingState === 'closed') return
    const wanted = [...sources.values()].filter((s) => r.want === 'all' || r.want.has(s.id))
    const wantedIds = new Set(wanted.map((s) => s.id))
    let changed = false
    let needNeg = false
    for (const [sid, sender] of [...r.senders]) {
      if (!wantedIds.has(sid)) {
        r.senders.delete(sid)
        sender.replaceTrack(null).catch(() => undefined)
        r.free.push(sender)
        changed = true
      }
    }
    for (const s of wanted) {
      if (r.senders.has(s.id)) continue
      const reuse = r.free.shift()
      if (reuse) {
        reuse.replaceTrack(s.track).catch(() => undefined)
        r.senders.set(s.id, reuse)
        tuneSender(reuse, s.kind)
      } else {
        const sender = r.pc.addTrack(s.track)
        r.senders.set(s.id, sender)
        tuneSender(sender, s.kind)
        needNeg = true
      }
      changed = true
    }
    if (needNeg) void negotiate(r)
    else if (changed) sendMap(r)
  }

  async function negotiate(r: Receiver): Promise<void> {
    if (r.negotiating) {
      r.again = true
      return
    }
    r.negotiating = true
    r.again = false
    try {
      preferCodecs(r.pc)
      const offer = await r.pc.createOffer()
      await r.pc.setLocalDescription(offer)
      const mids: Record<string, string> = {}
      for (const t of r.pc.getTransceivers()) {
        if (!t.mid) continue
        for (const [sid, s] of r.senders) if (s === t.sender) mids[t.mid] = sid
      }
      post({ ch: 'bridge', msg: { type: 'offer', receiverId: r.id, sdp: r.pc.localDescription?.sdp, mids } })
    } catch (e) {
      log('negotiate failed', String(e))
      r.negotiating = false
    }
  }

  function boostSdp(sdp: string): string {
    // Startbitrate anheben, damit das Bild auf der lokalen Strecke sofort scharf ist.
    const lines = sdp.split('\r\n')
    const out: string[] = []
    const fmtpDone = new Set<string>()
    const videoPts = new Set<string>()
    let inVideo = false
    for (const l of lines) {
      if (l.startsWith('m=')) inVideo = l.startsWith('m=video')
      if (inVideo && l.startsWith('a=rtpmap:')) {
        const m = l.match(/^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)/i)
        if (m) videoPts.add(m[1])
      }
    }
    for (const l of lines) {
      const m = l.match(/^a=fmtp:(\d+) (.*)$/)
      if (m && videoPts.has(m[1]) && !/x-google-start-bitrate/.test(l)) {
        out.push(`${l};x-google-start-bitrate=4000;x-google-min-bitrate=1500;x-google-max-bitrate=15000`)
        fmtpDone.add(m[1])
        continue
      }
      out.push(l)
      const rm = l.match(/^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)/i)
      if (rm && !sdp.includes(`a=fmtp:${rm[1]} `)) {
        out.push(`a=fmtp:${rm[1]} x-google-start-bitrate=4000;x-google-min-bitrate=1500;x-google-max-bitrate=15000`)
      }
    }
    return out.join('\r\n')
  }

  async function onBridge(msg: any): Promise<void> {
    if (msg.type === 'subscribe') {
      const old = receivers.get(msg.receiverId)
      if (old) old.pc.close()
      const pc = new OrigPC({ iceServers: [], bundlePolicy: 'max-bundle' })
      const r: Receiver = {
        id: msg.receiverId,
        pc,
        want: msg.streams === 'all' ? 'all' : new Set<string>(msg.streams),
        senders: new Map(),
        free: [],
        negotiating: false,
        again: false
      }
      receivers.set(r.id, r)
      pc.onicecandidate = (e) => post({ ch: 'bridge', msg: { type: 'ice', receiverId: r.id, from: 'engine', candidate: e.candidate ? e.candidate.toJSON() : null } })
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') logEncoders(r)
        if (pc.connectionState === 'failed') {
          log('bridge failed', r.id)
          pc.close()
          receivers.delete(r.id)
          post({ ch: 'bridge', msg: { type: 'failed', receiverId: r.id } })
        }
      }
      scan()
      if (r.senders.size === 0) {
        // Auch ohne Video eine Verbindung aufbauen, damit spätere Tracks per replaceTrack laufen.
        pc.addTransceiver('video', { direction: 'sendonly' })
        const t = pc.getTransceivers()[0]
        r.free.push(t.sender)
        void negotiate(r)
      }
      post({ ch: 'streams', streams: [...sources.values()].map((s) => ({ streamId: s.id, label: s.label, kind: s.kind, width: s.width, height: s.height })) })
      return
    }
    const r = receivers.get(msg.receiverId)
    if (!r) return
    if (msg.type === 'unsubscribe') {
      r.pc.close()
      receivers.delete(r.id)
      return
    }
    if (msg.type === 'want') {
      // Nur kodieren, was das Fenster gerade zeigt (z. B. in der Kompaktansicht nur ein Video)
      r.want = msg.streams === 'all' ? 'all' : new Set<string>(msg.streams)
      syncReceiver(r)
      return
    }
    if (msg.type === 'answer') {
      try {
        await r.pc.setRemoteDescription({ type: 'answer', sdp: boostSdp(msg.sdp) })
      } catch (e) {
        log('answer failed', String(e))
      }
      r.negotiating = false
      sendMap(r)
      if (r.again) void negotiate(r)
      return
    }
    if (msg.type === 'ice' && msg.from === 'receiver') {
      try {
        if (msg.candidate) await r.pc.addIceCandidate(msg.candidate)
      } catch {
        /* ignore */
      }
    }
  }

  // ---------- Anrufzustand ----------
  let lastStateJson = ''
  let lastStatePost = 0
  let lastIncomingJson = ''
  let inCallSince = 0
  let callStart = 0

  // Eingehende Anrufe: nur Hinweise mit Anrufbezug. "Accept" gibt es auch bei Chat-Anfragen
  // (data-tid="accept-chat") und Besprechungseinladungen.
  function findIncoming(): any {
    const accepts = Array.from(document.querySelectorAll<HTMLElement>('button,[role="button"]')).filter((b) => {
      const tid = b.getAttribute('data-tid') || ''
      if (tid === 'accept-chat') return false
      // textContent enthält jeden Buchstaben aus innerText, kostet aber kein Layout
      if (!/accept/i.test(tid) && !/(accept|annehmen)/i.test(`${attrLabel(b)} ${b.textContent || ''}`)) return false
      if (!visible(b) || b.closest('[data-tid="accept-block-container"]')) return false
      return /(accept|annehmen)/i.test(labelOf(b)) || /accept/i.test(tid)
    })
    for (const accept of accepts) {
      let box: HTMLElement | null = accept
      for (let i = 0; i < 8 && box; i++) {
        box = box.parentElement
        if (box && byLabel(LBL.decline, box)) break
      }
      if (!box || !byLabel(LBL.decline, box)) continue
      const ctx = `${box.innerText || ''} ${accept.getAttribute('data-tid') || ''} ${box.getAttribute('data-tid') || ''} ${labelOf(accept)}`
      if (!/(call|anruf|calling|ruft|incoming|eingehend|video|audio)/i.test(ctx)) continue
      if (/(meeting invitation|einladung|accept the invite|tentative|mit vorbehalt)/i.test(ctx)) continue
      // Den Hinweis nach oben erweitern, bis Text außer den Knöpfen sichtbar ist (Anrufername)
      const skip = RX('^(accept|annehmen|decline|ablehnen|accept with video|accept with audio|decline call|mit video annehmen|mit audio annehmen|anruf ablehnen)$')
      const linesOf = (el: HTMLElement) =>
        (el.innerText || '')
          .split('\n')
          .map((x) => x.trim())
          .filter((x) => x && !skip.test(x))
      let root: HTMLElement = box
      for (let i = 0; i < 6 && linesOf(root).length === 0 && root.parentElement; i++) root = root.parentElement
      const lines = linesOf(root)
      const labelText = [root.getAttribute('aria-label') || '', ...lines].join(' ')
      const nameFromLabel = labelText.match(/(?:call from|anruf von|incoming (?:video |audio )?call from)\s+([^,.\n]+)/i)?.[1]
      const generic = RX('^(incoming|eingehend|video call|audio call|videoanruf|audioanruf|anruf|call|is calling|ruft an)')
      const name = (nameFromLabel || lines.find((t) => !generic.test(t) && t.length > 1 && t.length < 80) || 'Unbekannt').trim()
      const isVideo = /video call|videoanruf|incoming video/i.test(labelText)
      return { id: name, callerName: name, isVideo, detail: lines.slice(0, 3).join(' · ') }
    }
    return null
  }

  function callTitle(): string {
    const t = q(['[data-tid="call-title"]', '#call-title', '[data-tid="meeting-title"]', '[data-tid="calling-title"]', '[data-tid="call-header-title"]'])
    if (t && t.innerText.trim()) return t.innerText.trim()
    const segs = document.title
      .replace(/^\(\d+\)\s*/, '')
      .split(/\s+\|\s+/)
      .map((x) => x.replace(/\s*\((external|extern)[^)]*\)\s*$/i, '').trim())
      .filter((x) => x && !/^(microsoft teams|teams|calendar|kalender|chat|activity|aktivität|calls|anrufe|meeting join|besprechung beitreten|onedrive|copilot)$/i.test(x))
    return segs[segs.length - 1] || ''
  }

  function liveVideo(root: Element): { live: boolean; local: boolean } {
    const r = { live: false, local: false }
    for (const v of Array.from(root.querySelectorAll('video'))) {
      const s = (v as HTMLVideoElement).srcObject
      if (!(s instanceof MediaStream)) continue
      for (const t of s.getVideoTracks()) {
        if (t.readyState !== 'live' || t.muted) continue
        r.live = true
        if (localTracks.has(t.id)) r.local = true
      }
    }
    return r
  }

  function participants(): any[] {
    const out: any[] = []
    const seen = new Set<string>()
    const push = (p: any): void => {
      const key = p.isMe ? '__self' : p.name.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      out.push({ ...p, id: p.isMe ? '__self' : p.name })
    }
    const handled = new Set<Element>()
    // 1. Teams-v2-Kacheln über data-tid: findet auch Teilnehmer ohne Video und ohne Mute-Label
    for (const el of Array.from(document.querySelectorAll(`${CONTAINER_SEL},${STREAM_SEL}`))) {
      const tt = teamsTile(el)
      if (!tt || tt.screen || !visible(tt.container)) continue
      handled.add(tt.container)
      const al = tt.container.getAttribute('aria-label') || ''
      const info = parseTileLabel(al)
      const vid = liveVideo(tt.container)
      push({
        name: tt.name,
        isMe: tt.self || !!info?.self || vid.local,
        muted: info?.muted,
        speaking: info?.speaking,
        handRaised: info?.hand,
        hasVideo: /video is on|video ist an|kamera an/i.test(al) || vid.live
      })
      if (out.length > 60) return out
    }
    // 2. Ältere Oberflächen: Kacheln nur über ihr aria-label
    for (const el of Array.from(document.querySelectorAll('[aria-label]')).slice(0, 4000)) {
      const al = el.getAttribute('aria-label') || ''
      if (al.length > 300 || !/(muted|unmuted|stumm)/i.test(al)) continue
      const tile = el.closest(CONTAINER_SEL) ?? el.closest(STREAM_SEL) ?? el.querySelector(CONTAINER_SEL) ?? el.querySelector(STREAM_SEL)
      if (tile && handled.has(tile)) continue
      const info = parseTileLabel(al)
      if (!info || !info.name || !visible(el)) continue
      push({
        name: info.name || 'Du',
        isMe: info.self,
        muted: info.muted,
        speaking: info.speaking,
        handRaised: info.hand,
        hasVideo: /video is on|video ist an|kamera an/i.test(al)
      })
      if (out.length > 60) break
    }
    return out
  }

  function callDurationStart(): number | undefined {
    const d = q(['[data-tid="call-duration"]'])
    const txt = d?.innerText?.trim()
    if (!txt) return undefined
    const parts = txt.split(':').map(Number)
    if (parts.some((n) => Number.isNaN(n))) return undefined
    const sec = parts.reduce((a, n) => a * 60 + n, 0)
    return Date.now() - sec * 1000
  }

  function selfHandRaised(raise: HTMLElement | null): boolean {
    if (raise && (raise.getAttribute('aria-pressed') === 'true' || LBL.lowerHand.test(labelOf(raise)))) return true
    const self = document.querySelector('[data-tid="myself-video"]')
    if (self && /hand raised|hand gehoben/i.test(self.getAttribute('aria-label') || '')) return true
    return !!document.querySelector('[data-tid="myself-video"] [data-tid="raise-hand-stream-outline"]')
  }

  function computeState(): any {
    // Nur eindeutige Kennungen: "Join"/"Leave" gibt es auch in Chat-Köpfen und Menüs.
    const hangup = q(SEL.hangup)
    const joinNow = q(SEL.joinNow)
    let phase = 'idle'
    if (hangup) {
      // document.body.innerText setzt das ganze Teams-DOM in Text um. Aus der Besprechung geht es
      // nicht zurück in den Wartebereich. Nach 10 s ohne Wartebereich-Text ist der Einlass sicher.
      const admitted = inCallSince > 0 && Date.now() - inCallSince > 10_000
      const bodyText = admitted || !document.body ? '' : document.body.innerText.slice(0, 4000)
      phase = LBL.lobby.test(bodyText) ? 'lobby' : 'in-call'
    } else if (joinNow) phase = 'prejoin'
    if (phase !== 'in-call') inCallSince = 0
    else if (!inCallSince) inCallSince = Date.now()
    if (phase === 'in-call') {
      const ds = callDurationStart()
      if (ds && (!callStart || Math.abs(ds - callStart) > 3000)) callStart = ds
      else if (!callStart) callStart = Date.now()
    }
    if (phase === 'idle' || phase === 'prejoin') callStart = 0

    const mic = phase === 'prejoin' ? q(SEL.prejoinMic) || q(SEL.mic) : q(SEL.mic)
    const cam = phase === 'prejoin' ? q(SEL.prejoinCam) || q(SEL.camera) : q(SEL.camera)
    const share = q(SEL.share)
    const stopShare = byLabel(LBL.stopShare)
    const raise = q(SEL.raiseHand)
    const anyScreen = [...localTracks.values()].some((l) => l.kind === 'screen' && l.track.readyState === 'live')
    return {
      phase,
      title: phase === 'idle' ? '' : callTitle(),
      startedAt: callStart || undefined,
      muted: micMuted(mic),
      cameraOn: cameraOn(cam),
      sharing: !!stopShare || anyScreen,
      handRaised: selfHandRaised(raise),
      participants: phase === 'in-call' ? participants() : [],
      available: {
        toggleMute: !!mic,
        toggleCamera: !!cam,
        hangup: !!hangup,
        // Teams sperrt "Teilen", bis ein 1:1-Anruf verbunden ist
        share: !!share && !disabled(share),
        stopShare: !!stopShare || anyScreen,
        raiseHand: !!raise,
        join: !!joinNow,
        toggleChat: !!q(SEL.chat),
        toggleRoster: !!q(SEL.roster),
        react: !!q(SEL.react)
      }
    }
  }

  function tick(): void {
    try {
      // Weiterleitungsseite "Im Browser fortfahren" automatisch bestätigen
      const cont = q(SEL.joinOnWeb) || (location.pathname.includes('launcher') ? byLabel(LBL.continueBrowser) : null)
      if (cont) click(cont)

      const st = computeState()
      const json = JSON.stringify(st)
      // Bei Änderung sofort, sonst alle paar Sekunden zum Abgleich senden
      if (json !== lastStateJson || Date.now() - lastStatePost > 4000) {
        lastStateJson = json
        lastStatePost = Date.now()
        post({ ch: 'call-state', state: st })
      }
      const inc = findIncoming()
      const ij = JSON.stringify(inc)
      if (ij !== lastIncomingJson) {
        lastIncomingJson = ij
        post({ ch: 'incoming-call', call: inc })
      }
      scan()
      w.__tmTickOk = (w.__tmTickOk || 0) + 1
    } catch (e) {
      w.__tmTickErr = String((e as Error)?.stack || e).slice(0, 600)
      w.__tmTickErrCount = (w.__tmTickErrCount || 0) + 1
      post({ ch: 'log', text: 'tick failed: ' + w.__tmTickErr })
    }
  }
  w.__tmTick = tick
  ownInterval(() => {
    const t0 = performance.now()
    tick()
    const ms = performance.now() - t0
    w.__tmTickMs = Math.max(w.__tmTickMs || 0, ms)
    w.__tmTickRuns = (w.__tmTickRuns || 0) + 1
  }, 700)

  // ---------- Befehle ----------
  // Zählt abgebrochene Anrufstarts. Ein Start, der beim Warten eine neue Zahl sieht, gibt auf.
  let startSeq = 0

  // Für das Log: welche Anrufknöpfe Teams gerade zeigt. Nur technische Kennungen: Kacheln tragen
  // den Namen im data-tid, Telefon-Einträge die Nummer.
  function callButtonIds(): string {
    const ids = new Set<string>()
    for (const el of Array.from(document.querySelectorAll('[data-tid]'))) {
      const tid = el.getAttribute('data-tid') || ''
      if (tid.length > 60 || !/^[a-z][a-z0-9-]*$/i.test(tid) || /\d{3}/.test(tid) || tid.startsWith(CONTAINER_PREFIX)) continue
      if (/call|video|audio|share/i.test(tid) && visible(el)) ids.add(tid)
      if (ids.size >= 20) break
    }
    return [...ids].join(' ') || '-'
  }

  // Anrufknöpfe im Chatkopf (aus dem Code der Teams-Web-App, Stand November 2026). Standard ist ein
  // Hauptknopf für die zuletzt gewählte Anrufart, daneben ein Menü mit "Videoanruf" und "Audioanruf".
  // Je nach Feature-Flag zeigt Teams beide Arten auch direkt im Kopf oder als geteilten Knopf.
  const CALL_DIRECT = {
    video: ['[data-tid="default-chat-call-video-button"]', '[data-tid="chat-call-video-button"]', '[data-tid="dropdown-video-call-btn"]'],
    audio: ['[data-tid="default-chat-call-audio-button"]', '[data-tid="chat-call-audio-button"]', '[data-tid="dropdown-audio-call-primary-btn"]', '[data-tid="dropdown-audio-call-btn"]']
  }
  const CALL_MORE = ['[data-tid="dropdown-calling-toggle-more-options-btn"]']
  const CALL_ITEM_LABEL = { video: RX('^(video call|videoanruf)$'), audio: RX('^(audio call|audioanruf)$') }
  function disabled(el: Element): boolean {
    return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true'
  }
  function usable(selectors: string[]): HTMLElement | null {
    for (const s of selectors) for (const el of Array.from(document.querySelectorAll<HTMLElement>(s))) if (!disabled(el) && visible(el)) return el
    return null
  }
  // Eintrag im geöffneten Anrufmenü. Nur im Menü suchen: Seitenweit trifft die Beschriftung auch
  // anderes, das mit "Videoanruf" beginnt.
  function callMenuItem(kind: 'video' | 'audio'): HTMLElement | null {
    for (const menu of Array.from(document.querySelectorAll('[role="menu"]'))) {
      if (!visible(menu)) continue
      for (const s of CALL_DIRECT[kind]) {
        const el = menu.querySelector<HTMLElement>(s)
        if (el && visible(el)) return el
      }
      const el = byLabel(CALL_ITEM_LABEL[kind], menu, '[role="menuitem"]')
      if (el) return el
    }
    return null
  }

  async function startCall(video: boolean, seq: number): Promise<void> {
    const kind = video ? 'video' : 'audio'
    const t0 = Date.now()
    const wanted = () => seq === startSeq
    const step = (what: string) => log(`start call: ${what} after ${Date.now() - t0} ms`)
    const fail = (why: string, reason?: string) => {
      log(`${why} after ${Date.now() - t0} ms, buttons: ${callButtonIds()}`)
      post({ ch: 'call-start-failed', reason })
    }
    // Teams braucht nach dem Laden einige Sekunden, bis der Chatkopf steht. Bis dahin auf einen
    // direkten Knopf für diese Anrufart oder auf das Anrufmenü warten, beides nur, wenn es klickbar ist.
    // Bisher galt der direkte Videoknopf nur in den ersten 0,5 s, und Audio fand nach einem
    // Videoanruf keinen Knopf mehr, weil Teams dann den Videoknopf als Hauptknopf zeigt.
    const byText = (): HTMLElement | null => {
      const el = video ? null : byLabel(LBL.audioCall)
      return el && !disabled(el) ? el : null
    }
    const first = await waitFor(() => (wanted() ? usable(CALL_DIRECT[kind]) || byText() || usable(CALL_MORE) : document.body), 30000)
    if (!wanted()) return
    if (!first) return fail(`${kind} call button not found`)
    let target = first
    if (first.matches(CALL_MORE[0])) {
      step('call menu')
      click(first)
      const item = await waitFor(() => (wanted() ? callMenuItem(kind) : document.body), 4000)
      if (!wanted()) return
      if (!item) return fail(`${kind} call menu item not found`)
      // Direkt nach dem Laden sperrt Teams "Videoanruf", bis es weiß, ob Video geht. Ein Klick auf den
      // gesperrten Eintrag verpufft ohne Fehler, so hing der Start bisher. Deshalb warten, bis er frei ist.
      const enabledItem = (): HTMLElement | null => {
        const el = callMenuItem(kind)
        return el && !disabled(el) ? el : null
      }
      const ready = await waitFor(() => (wanted() ? enabledItem() : document.body), 10000)
      if (!wanted()) return
      if (!ready) {
        // Teams schreibt den Grund ins aria-label, z.B. "Keine verfügbare Kamera gefunden". Ohne Grund
        // steht dort nur "Videoanruf".
        const label = attrLabel(callMenuItem(kind) ?? item).slice(0, 120)
        await closeFlyouts()
        return fail(`${kind} call menu item disabled (${label})`, CALL_ITEM_LABEL[kind].test(label) ? undefined : label)
      }
      target = ready
    }
    step(`${kind} call ${target.getAttribute('data-tid') || 'button'}`)
    click(target)
    // Nur fürs Log: erscheint der Anrufbildschirm?
    const shown = await waitFor(() => q(SEL.hangup), 15000)
    if (wanted()) log(shown ? `start call: call screen after ${Date.now() - t0} ms` : `start call: no call screen 15 s after click, buttons: ${callButtonIds()}`)
  }

  // ---------- Bildschirm teilen ----------
  // "Teilen" in Teams öffnet nur ein Menü im versteckten Fenster. Erst dessen Eintrag "Bildschirm,
  // Fenster oder Registerkarte" fragt mit getDisplayMedia eine Quelle an, die man dann im
  // Anruffenster wählt. Deshalb klickt die Engine den Eintrag selbst.
  const SHARE_ENTRY_SEL = ['[data-tid="share-screen-window-or-tab"]', '[data-tid="share-tray-picker-screen"]']
  const SHARE_ENTRY = RX('^((share a )?screen, window,? (or|and) tab|bildschirm, fenster oder registerkarte|geben sie einen bildschirm)')
  function shareEntry(): HTMLElement | null {
    const tray = Array.from(document.querySelectorAll('[data-tid="share-popup"],[data-tid="share-tray"],[data-tid="share-tray-picker"]')).find(visible)
    return usable(SHARE_ENTRY_SEL) || (tray ? byLabel(SHARE_ENTRY, tray, 'button,[role="button"],[role="menuitem"]') : null)
  }
  let shareRun = 0
  async function share(): Promise<boolean> {
    const btn = q(SEL.share)
    if (!btn) return false
    const run = ++shareRun
    const before = displayRequests
    const t0 = Date.now()
    const asked = () => displayRequests !== before
    const done = () => asked() || run !== shareRun
    const failed = (why: string) => {
      log(`share: ${why} after ${Date.now() - t0} ms, dialogs: ${document.getElementsByClassName('ui-dialog').length}, buttons: ${callButtonIds()}`)
      post({ ch: 'share-failed', reason: why.split(' ')[0] })
    }
    // Teams sperrt "Teilen", solange der Anruf nicht verbunden ist (1:1-Anruf klingelt noch)
    if (disabled(btn)) {
      failed('disabled')
      return true
    }
    // Ein zweiter Klick schlösse das Menü wieder
    if (btn.getAttribute('aria-expanded') !== 'true') click(btn)
    const entry = await waitFor(() => (done() ? document.body : shareEntry()), 3000)
    if (run !== shareRun) return true
    if (!asked()) {
      if (!entry) {
        failed('no_tray')
        return true
      }
      log(`share: tray entry ${entry.getAttribute('data-tid') || 'by label'} after ${Date.now() - t0} ms`)
      click(entry)
      await waitFor(() => (done() ? document.body : null), 5000)
      if (run !== shareRun) return true
    }
    if (asked()) log(`share: display requested after ${Date.now() - t0} ms`)
    else failed('no_request')
    return true
  }

  function doAction(action: string, arg?: string): boolean {
    switch (action) {
      case 'toggleMute': {
        const st = computeState()
        const b = st.phase === 'prejoin' ? q(SEL.prejoinMic) || q(SEL.mic) : q(SEL.mic) || byLabel(LBL.mute) || byLabel(LBL.unmute)
        if (b) return click(b)
        // Fallback: Mikrofon-Track direkt schalten
        for (const l of localTracks.values()) if (l.kind === 'mic') l.track.enabled = !l.track.enabled
        return true
      }
      case 'toggleCamera': {
        const st = computeState()
        const b = st.phase === 'prejoin' ? q(SEL.prejoinCam) || q(SEL.camera) : q(SEL.camera) || byLabel(LBL.camOn) || byLabel(LBL.camOff)
        return click(b)
      }
      case 'hangup':
        return click(q(SEL.hangup))
      case 'share':
        if (!q(SEL.share)) return false
        void share()
        return true
      case 'stopShare': {
        const b = byLabel(LBL.stopShare)
        if (b) return click(b)
        for (const l of localTracks.values()) if (l.kind === 'screen') l.track.stop()
        return true
      }
      case 'raiseHand':
        return click(q(SEL.raiseHand))
      case 'cancelJoin':
        // Einen noch laufenden Anrufstart abbrechen, sonst klickt er später doch noch auf "Anrufen"
        startSeq++
        // Den Knopf nur über die Beschriftung suchen, wenn die Vorschau offen ist, sonst trifft er fremde Dialoge
        return click(q(['[data-tid="prejoin-cancel-button"]']) || (q(SEL.joinNow) ? byLabel(RX('^(cancel|abbrechen)$')) : null))
      case 'join':
        return click(q(SEL.joinNow))
      case 'toggleChat':
        return click(q(SEL.chat))
      case 'toggleRoster':
        return click(q(SEL.roster))
      case 'react': {
        const b = q(SEL.react)
        if (!b) return false
        click(b)
        if (arg) {
          ownTimeout(() => {
            const rx = RX(arg)
            const target = byLabel(rx)
            if (target) click(target)
          }, 400)
        }
        return true
      }
      case 'acceptVideo': {
        const b = byLabel(LBL.acceptVideo) || byLabel(LBL.acceptAudio)
        return click(b)
      }
      case 'acceptAudio': {
        const b = byLabel(LBL.acceptAudio) || byLabel(RX('(accept|annehmen)'))
        return click(b)
      }
      case 'decline':
        return click(byLabel(LBL.decline))
      case 'startVideoCall':
      case 'startAudioCall':
        void startCall(action === 'startVideoCall', startSeq)
        return true
      case 'activity': {
        const x = 200 + Math.random() * 400
        const y = 200 + Math.random() * 300
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }))
        document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y }))
        return true
      }
    }
    return false
  }

  // ---------- Hintergründe und Geräte (Abfrage mit Antwort) ----------
  const esc = (v: string) => (window.CSS && CSS.escape ? CSS.escape(v) : v.replace(/"/g, '\\"'))
  const isPressed = (el: Element) => el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true'
  const BG_SEL = '[data-tid^="background-effect-"],[data-tid="background-standard-blur"]'

  async function closeFlyouts(): Promise<void> {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
    await new Promise((r) => ownTimeout(r, 150))
  }

  async function openEffectsPanel(): Promise<HTMLElement | null> {
    // Bereits sichtbar (Vorschau-Seitenleiste oder Effekt-Panel im Anruf)?
    if (q([BG_SEL]) && document.querySelectorAll(BG_SEL).length > 4) return document.body
    const prejoinBtn = q(['[data-tid="button-custom-video-backgrounds"]'])
    if (prejoinBtn && !prejoinBtn.hasAttribute('disabled') && prejoinBtn.getAttribute('aria-disabled') !== 'true') {
      click(prejoinBtn)
    } else {
      const cfg = q(['#video-button-configure', '[data-tid="video-button-configure"]'])
      if (!cfg) return null
      click(cfg)
      const more = await waitFor(() => q(['[data-tid="video-flyout-more-effects-button"]']), 3000)
      if (more) click(more)
    }
    const ok = await waitFor(() => (document.querySelectorAll(BG_SEL).length > 4 ? document.body : null), 5000)
    return ok
  }

  async function thumbOf(btn: Element): Promise<string | undefined> {
    const img = btn.querySelector('img')
    const src = img?.getAttribute('src') || ''
    if (!src) return undefined
    if (/^https:/.test(src)) return src
    try {
      if (img && !img.complete) await Promise.race([new Promise((r) => img.addEventListener('load', r, { once: true })), new Promise((r) => ownTimeout(r, 1500))])
      const c = document.createElement('canvas')
      const w = 192
      const h = Math.round((w * (img!.naturalHeight || 108)) / (img!.naturalWidth || 192))
      c.width = w
      c.height = h
      c.getContext('2d')!.drawImage(img!, 0, 0, w, h)
      return c.toDataURL('image/jpeg', 0.75)
    } catch {
      return undefined
    }
  }

  async function listBackgrounds(): Promise<any> {
    const panel = await openEffectsPanel()
    if (!panel) return { items: [], canUpload: false, error: 'Hintergründe sind erst verfügbar, wenn die Kamera eingeschaltet ist.' }
    await waitFor(() => q([BG_SEL]), 3000)
    const seen = new Set<string>()
    const items: any[] = []
    for (const b of Array.from(document.querySelectorAll(BG_SEL))) {
      const tid = b.getAttribute('data-tid') || ''
      if (seen.has(tid) || !visible(b)) continue
      seen.add(tid)
      const label = (b.getAttribute('aria-label') || '').replace(/\s*background effect$/i, '').replace(/\s*Hintergrundeffekt$/i, '')
      items.push({
        id: tid,
        label: tid === 'background-effect-none' ? 'Keiner' : tid === 'background-standard-blur' ? 'Weichzeichnen' : label,
        kind: tid === 'background-effect-none' ? 'none' : tid === 'background-standard-blur' ? 'blur' : 'image',
        selected: isPressed(b),
        thumbnail: await thumbOf(b)
      })
    }
    return { items, canUpload: !!document.querySelector('input[type=file][accept*=".png"]') }
  }

  async function setBackground(id: string): Promise<any> {
    if (!q([`[data-tid="${esc(id)}"]`])) await openEffectsPanel()
    const btn = await waitFor(() => q([`[data-tid="${esc(id)}"]`]), 3000)
    if (!btn) throw new Error('Hintergrund nicht gefunden')
    click(btn)
    const apply = await waitFor(() => {
      const a = q(['[data-tid="video-apply"]'])
      return a && !a.hasAttribute('disabled') && a.getAttribute('aria-disabled') !== 'true' ? a : null
    }, 1500)
    if (apply) click(apply)
    return true
  }

  async function closeBackgrounds(): Promise<any> {
    const c = q(['[data-tid="video-effects-and-settings-panel"] [data-tid="rail-header-close-button"]', '[data-tid="calling-right-side-panel"] [data-tid="rail-header-close-button"]', '[data-tid="rail-header-close-button"]'])
    if (c) click(c)
    else await closeFlyouts()
    return true
  }

  async function withFlyout<T>(selectors: string[], fn: () => Promise<T> | T, readySel?: string): Promise<T | null> {
    const btn = q(selectors)
    if (!btn) return null
    click(btn)
    if (readySel) await waitFor(() => Array.from(document.querySelectorAll(readySel)).find(visible) ?? null, 3000)
    else await new Promise((r) => ownTimeout(r, 900))
    try {
      return await fn()
    } finally {
      click(btn)
      await new Promise((r) => ownTimeout(r, 150))
    }
  }

  const VIDEO_CFG = ['#video-button-configure', '[data-tid="video-button-configure"]', '[data-tid="video-flyout-open-button"]']
  const AUDIO_CFG = ['#audio-button-configure', '[data-tid="audio-button-configure"]']

  async function listDevices(): Promise<any> {
    const inPrejoin = !!q(SEL.joinNow)
    if (inPrejoin) {
      // Vorschau: Mikrofon und Lautsprecher haben eigene Auswahlmenüs
      const menuOptions = async (tid: string) => {
        const b = q([`[data-tid="${tid}"]`])
        if (!b) return []
        click(b)
        await waitFor(() => Array.from(document.querySelectorAll('[role="option"]')).find(visible) ?? null, 2500)
        const list = Array.from(document.querySelectorAll('[role="option"]'))
          .filter(visible)
          .map((e) => ({ id: (e as HTMLElement).innerText.trim(), label: (e as HTMLElement).innerText.trim(), selected: isPressed(e) }))
        await closeFlyouts()
        return list
      }
      const mics = await menuOptions('selected-microphone-display')
      const speakers = await menuOptions('selected-speaker-display')
      let cameras: any[] = []
      const btn = q(['[data-tid="video-flyout-open-button"]'])
      if (btn) {
        click(btn)
        const box = await waitFor(() => q(['[data-tid="calling-right-side-panel"] [role="listbox"]']), 2500)
        if (box) cameras = Array.from(box.querySelectorAll('[role="option"]')).map((e) => ({ id: 'opt:' + (e as HTMLElement).innerText.trim(), label: (e as HTMLElement).innerText.trim(), selected: isPressed(e) }))
        await closeBackgrounds()
      }
      return { cameras, mics, speakers }
    }
    const cameras =
      (await withFlyout(VIDEO_CFG, () =>
        Array.from(document.querySelectorAll('[id^="camera:"], [data-tid^="camera:"]'))
          .filter(visible)
          .map((e) => ({ id: e.id || e.getAttribute('data-tid'), label: (e.getAttribute('aria-label') || (e as HTMLElement).innerText || '').trim(), selected: isPressed(e) })),
        '[id^="camera:"], [data-tid^="camera:"]'
      )) ?? []
    const audio =
      (await withFlyout(AUDIO_CFG, () => {
        const opts = (tid: string) =>
          Array.from(document.querySelectorAll(`[data-tid="${tid}"] [role="option"]`)).map((e) => ({ id: (e as HTMLElement).innerText.trim(), label: (e as HTMLElement).innerText.trim(), selected: isPressed(e) }))
        const ns = document.querySelector('[data-tid="background-suppression-switch"]') as HTMLInputElement | null
        return { speakers: opts('speaker-settings'), mics: opts('microphone-settings'), noiseSuppression: ns ? ns.checked || ns.getAttribute('aria-checked') === 'true' : undefined }
      })) ?? { speakers: [], mics: [] }
    return { cameras, ...audio }
  }

  async function selectDevice(kind: string, id: string): Promise<any> {
    if (kind === 'camera' && id.startsWith('opt:')) {
      const btn = q(['[data-tid="video-flyout-open-button"]'])
      if (btn) click(btn)
      const label = id.slice(4)
      const opt = await waitFor(() => Array.from(document.querySelectorAll('[data-tid="calling-right-side-panel"] [role="option"]')).find((e) => (e as HTMLElement).innerText.trim() === label) as HTMLElement | undefined ?? null, 3000)
      click(opt)
      await closeBackgrounds()
      return true
    }
    if (kind === 'camera') {
      return withFlyout(VIDEO_CFG, () => click(document.getElementById(id) ?? q([`[data-tid="${esc(id)}"]`])), '[id^="camera:"], [data-tid^="camera:"]')
    }
    if (kind === 'noise') {
      return withFlyout(AUDIO_CFG, () => click(q(['[data-tid="background-suppression-switch"]'])))
    }
    if (q(SEL.joinNow) && (kind === 'mic' || kind === 'speaker')) {
      const b = q([kind === 'mic' ? '[data-tid="selected-microphone-display"]' : '[data-tid="selected-speaker-display"]'])
      if (!b) return false
      click(b)
      const opt = await waitFor(() => (Array.from(document.querySelectorAll('[role="option"]')).find((e) => visible(e) && (e as HTMLElement).innerText.trim() === id) as HTMLElement | undefined) ?? null, 2500)
      const ok = click(opt)
      await closeFlyouts()
      return ok
    }
    const list = kind === 'speaker' ? 'speaker-settings' : 'microphone-settings'
    return withFlyout(AUDIO_CFG, () => {
      const opt = Array.from(document.querySelectorAll(`[data-tid="${list}"] [role="option"]`)).find((e) => (e as HTMLElement).innerText.trim() === id) as HTMLElement | undefined
      return click(opt ?? null)
    })
  }

  const RPC: Record<string, (a: any) => Promise<any>> = {
    listBackgrounds: () => listBackgrounds(),
    setBackground: (a) => setBackground(a.id),
    closeBackgrounds: () => closeBackgrounds(),
    openBackgrounds: async () => !!(await openEffectsPanel()),
    listDevices: () => listDevices(),
    selectDevice: (a) => selectDevice(a.kind, a.id)
  }

  // Diagnose für die Entwicklung: Struktur der Anruf-Oberfläche
  w.__tmProbe = function () {
    const btns = Array.from(document.querySelectorAll('button,[role="button"]'))
      .filter(visible)
      .slice(0, 200)
      .map((b) => ({ id: b.id, tid: b.getAttribute('data-tid'), label: labelOf(b).slice(0, 60), state: b.getAttribute('data-state'), pressed: b.getAttribute('aria-pressed') }))
    const vids = Array.from(document.querySelectorAll('video')).map((v) => {
      const chain: string[] = []
      let n: Element | null = v
      for (let i = 0; i < 10 && n; i++) {
        chain.push(`${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}[tid=${n.getAttribute('data-tid') || ''}][cid=${n.getAttribute('data-cid') || ''}][al=${(n.getAttribute('aria-label') || '').slice(0, 50)}]`)
        n = n.parentElement
      }
      const s = (v as HTMLVideoElement).srcObject as MediaStream | null
      return { w: (v as HTMLVideoElement).videoWidth, h: (v as HTMLVideoElement).videoHeight, tracks: s ? s.getTracks().map((t) => `${t.kind}:${t.readyState}:${t.id.slice(0, 8)}`) : [], chain }
    })
    return { url: location.href, title: document.title, state: computeState(), buttons: btns, videos: vids, sources: [...sources.values()].map((s) => ({ id: s.id, label: s.label, kind: s.kind })), localTracks: [...localTracks.values()].map((l) => l.kind + ':' + l.track.readyState), remoteTracks: remoteTracks.size, receivers: receivers.size }
  }

  document.addEventListener('__tm_to_main', (e: Event) => {
    let msg: any
    try {
      msg = JSON.parse((e as CustomEvent).detail)
    } catch {
      return
    }
    if (msg.ch === 'action') {
      const ok = doAction(msg.action, msg.arg)
      if (!ok) log('action not possible', msg.action)
      ownTimeout(tick, 120)
    } else if (msg.ch === 'bridge') {
      void onBridge(msg.msg)
    } else if (msg.ch === 'prefs') {
      Object.assign(prefs, msg.prefs || {})
    } else if (msg.ch === 'rpc') {
      const fn = RPC[msg.method]
      if (!fn) return post({ ch: 'rpc-result', id: msg.id, error: `Unbekannt: ${msg.method}` })
      fn(msg.args || {})
        .then((result) => post({ ch: 'rpc-result', id: msg.id, result }))
        .catch((e) => post({ ch: 'rpc-result', id: msg.id, error: String(e?.message || e) }))
    } else if (msg.ch === 'probe') {
      post({ ch: 'probe', result: w.__tmProbe() })
    }
  })

  // Befehl aus dem Link (z.B. Anruf starten), sobald die Seite bereit ist
  const linkAction = location.href.match(/[?&#]tmAction=(startAudioCall|startVideoCall)/)
  if (linkAction && /teams\.cloud\.microsoft|teams\.microsoft\.com/.test(location.hostname)) {
    const seq = startSeq
    ownTimeout(() => void startCall(linkAction[1] === 'startVideoCall', seq), 1500)
  }

  log('engine hooks installed', location.href)
}
