/* eslint-disable @typescript-eslint/no-explicit-any */
import { BrowserWindow, desktopCapturer, dialog, ipcMain, screen, shell, systemPreferences, webContents, type DesktopCapturerSource } from 'electron'
import type { AccountService } from './account'
import type { BackgroundList, BridgeMessage, CallAction, CallDevices, CallParticipant, CallState, IncomingCall, MediaStreamInfo } from '@shared/types'
import { createCallWindow, createIncomingWindow, createPopoutWindow, uiWindows } from './windows'
import { log } from './log'
import { analytics } from './analytics'
import { isTeamsUrl } from './engine/hosts'
import { cleanCallName } from '@shared/call-names'
import { displayResponse } from './display-response'

type Broadcast = (event: string, payload: unknown) => void

// Electron 45 wirft bei cb({}) "Video was requested, but no video stream was provided".
// Mit null lehnt es die Anfrage ab, und getDisplayMedia() in der Web-App scheitert sauber.
function denyDisplay(cb: (s: any) => void): void {
  cb(null)
}

// Namen aus den aria-labels bereinigen. Gleiche Personen nach der Bereinigung nur einmal.
function cleanParticipants(list: CallParticipant[] | undefined): CallParticipant[] {
  const out: CallParticipant[] = []
  for (const p of list ?? []) {
    const { name, external } = cleanCallName(p.name)
    const id = p.isMe ? p.id : name
    const prev = out.find((x) => x.id.toLowerCase() === id.toLowerCase())
    if (prev) {
      // Dieselbe Person aus zwei Quellen der Seite: Hinweis auf extern nicht verlieren
      prev.external ||= external
      continue
    }
    out.push({ ...p, id, name, external: external || p.external })
  }
  return out
}

// Hinweise im Anruffenster, wenn Teams nach "Teilen" keine Quelle anfragt
const SHARE_FAILED: Record<string, string> = {
  disabled: 'Teilen geht erst, wenn der Anruf verbunden ist.',
  no_tray: 'Teams hat das Teilen-Menü nicht geöffnet. Versuch es gleich noch einmal.',
  source: 'Diese Quelle ließ sich nicht teilen. Nimm ein anderes Fenster oder den ganzen Bildschirm.',
  unknown: 'Teams hat das Teilen nicht gestartet. Versuch es gleich noch einmal.'
}

type CallOrigin = 'meeting' | 'call' | 'incoming' | 'web_view'

// Ein Anruf von Start bis Ende, nur für die Nutzungsdaten
interface CallStats {
  origin: CallOrigin
  requestedAt: number
  connectedAt?: number
  lastPhase: string
  maxParticipants: number
  sharedScreen: boolean
  cameraUsed: boolean
  lobby: boolean
  // Start gescheitert oder abgebrochen, schon gemeldet
  reported: boolean
}

export class CallManager {
  state: CallState | null = null
  incoming: IncomingCall | null = null
  streams: MediaStreamInfo[] = []
  callWindow: BrowserWindow | null = null
  incomingWindow: BrowserWindow | null = null
  popouts = new Set<BrowserWindow>()
  private activeAccountId?: string
  private compact = false

  // Läuft oder startet gerade ein Anruf in diesem Konto (auch ein angenommener, bevor Teams ihn meldet)?
  // Dann darf seine Web-App nicht neu laden.
  busy(accountId: string): boolean {
    return this.activeAccountId === accountId
  }
  private normalBounds?: Electron.Rectangle
  private closeTimer?: NodeJS.Timeout
  private pendingDisplay?: { cb: (s: any) => void; sources: DesktopCapturerSource[] }
  private loadingDisplay?: { cb: (s: any) => void }
  private probes = new Map<string, (r: unknown) => void>()
  // Zählt Anrufstarts, damit alte Zeitgeber einen neueren Start nicht beenden
  private pendingSeq = 0
  // Nach einem abgebrochenen Start: Klickt die Web-App doch noch auf "Anrufen", sofort wieder auflegen
  private cancelled?: { accountId: string; until: number }
  private stats?: CallStats
  // Zuletzt angenommener eingehender Anruf: verschwindet ein anderer, war er verpasst
  private answeredIncoming?: string
  private rpcSeq = 0
  private rpcPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

  constructor(
    private readonly accounts: () => AccountService[],
    private readonly broadcast: Broadcast,
    private readonly isQuitting: () => boolean = () => false
  ) {
    ipcMain.on('engine:msg', (e, msg) => this.onEngineMessage(e.sender.id, msg))
    ipcMain.on('bridge:send', (e, msg: BridgeMessage) => this.onReceiverMessage(e.sender.id, msg))
  }

  setupSession(acct: AccountService): void {
    acct.engine.ses.setDisplayMediaRequestHandler(
      (_req, cb) => {
        void (async () => {
          // Eine ältere Anfrage ohne Antwort zuerst ablehnen. Sonst wartet die Web-App ewig auf sie.
          this.denyPendingDisplay()
          const t0 = Date.now()
          // Die Quellen zu lesen dauert ein paar Sekunden. So lange zeigt die Auswahl, dass sie lädt.
          // Wer währenddessen abbricht, lehnt die Anfrage sofort ab (denyPendingDisplay).
          const req = { cb }
          this.loadingDisplay = req
          const target = this.callWindow && !this.callWindow.isDestroyed() ? this.callWindow : BrowserWindow.getFocusedWindow()
          if (target) {
            if (this.compact) this.setCompact(false)
            target.show()
            target.focus()
          }
          this.broadcast('display-sources-loading', true)
          // Ohne Freigabe in den Systemeinstellungen liefert macOS keine Quellen. Die Auswahl zeigt dann
          // einen Hinweis. getSources trotzdem aufrufen: Erst das fragt beim ersten Mal nach der
          // Berechtigung und trägt die App in die Liste ein. Vorher meldet macOS schon "denied".
          const access = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted'
          log.info('display media requested, screen access', access)
          let sources: DesktopCapturerSource[] = []
          try {
            sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: false })
            log.info(`display sources: ${sources.length} after ${Date.now() - t0} ms`)
          } catch (e) {
            // Electron lehnt hier mit einem String ab, nicht mit einem Error
            log.warn('desktopCapturer.getSources failed', e instanceof Error ? e.message : String(e))
          }
          if (!sources.length) analytics.track('screen_share_failed', { reason: access === 'granted' ? 'sources' : 'permission' })
          // Während des Ladens abgebrochen, das Anruffenster geschlossen oder eine neue Anfrage: schon abgelehnt
          if (this.loadingDisplay !== req) return
          this.loadingDisplay = undefined
          this.pendingDisplay = { cb, sources }
          this.broadcast(
            'display-sources',
            sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), kind: s.id.startsWith('screen') ? 'screen' : 'window' }))
          )
        })()
      },
      { useSystemPicker: false }
    )
  }

  private denyPendingDisplay(): void {
    const l = this.loadingDisplay
    this.loadingDisplay = undefined
    if (l) denyDisplay(l.cb)
    const p = this.pendingDisplay
    this.pendingDisplay = undefined
    if (p) denyDisplay(p.cb)
  }

  pickDisplaySource(id: string | null): void {
    const p = this.pendingDisplay
    this.pendingDisplay = undefined
    if (!p) {
      // Abbrechen, solange die Quellen noch laden
      this.denyPendingDisplay()
      return
    }
    const src = id ? p.sources.find((s) => s.id === id) : undefined
    if (!src) {
      denyDisplay(p.cb)
      return
    }
    try {
      p.cb(displayResponse(src))
    } catch (e) {
      // Electron hat die Anfrage dann schon abgelehnt, getDisplayMedia scheitert in Teams
      log.warn(`display source ${src.id.startsWith('screen') ? 'screen' : 'window'} rejected`, e instanceof Error ? e.message : String(e))
      analytics.track('screen_share_failed', { reason: 'source' })
      this.broadcast('call-notice', SHARE_FAILED.source)
    }
  }

  private accountByWc(id: number): AccountService | undefined {
    return this.accounts().find((a) => a.engine.webContents?.id === id)
  }

  private activeAccount(): AccountService | undefined {
    if (this.activeAccountId) return this.accounts().find((a) => a.id === this.activeAccountId)
    return undefined
  }

  private onEngineMessage(wcId: number, msg: any): void {
    const acct = this.accountByWc(wcId)
    if (!acct || !msg) return
    switch (msg.ch) {
      case 'call-state':
        this.onCallState(acct, msg.state)
        break
      case 'incoming-call':
        this.onIncoming(acct, msg.call)
        break
      case 'streams':
        if (this.activeAccountId === acct.id || !this.activeAccountId) {
          const streams = (msg.streams as MediaStreamInfo[]).map((s) => {
            const { name, external } = cleanCallName(s.label)
            return { ...s, label: name, external }
          })
          this.streams = streams
          this.broadcast('bridge', { type: 'streams', streams })
        }
        break
      case 'bridge': {
        const m = msg.msg as BridgeMessage & { receiverId: number }
        const wc = webContents.fromId(m.receiverId)
        if (wc && !wc.isDestroyed()) wc.send('event', 'bridge', m)
        break
      }
      case 'probe': {
        const cb = this.probes.get(acct.id)
        this.probes.delete(acct.id)
        cb?.(msg.result)
        break
      }
      case 'call-start-failed':
        // reason: Text, mit dem Teams die Anrufart sperrt, z.B. "Keine verfügbare Kamera gefunden"
        if (this.activeAccountId === acct.id && this.state?.phase === 'connecting') this.failPending('web_app', typeof msg.reason === 'string' ? msg.reason.slice(0, 120) : undefined)
        break
      case 'display-media-requested':
        break
      case 'share-failed': {
        // Teams hat nach "Teilen" keine Quelle angefragt
        const reason = typeof msg.reason === 'string' ? msg.reason : 'unknown'
        analytics.track('screen_share_failed', { reason })
        if (this.activeAccountId === acct.id) this.broadcast('call-notice', SHARE_FAILED[reason] ?? SHARE_FAILED.unknown)
        break
      }
      case 'log':
        log.info(`[engine ${acct.id}] ${String(msg.text).slice(0, 800)}`)
        break
      case 'rpc-result': {
        const p = this.rpcPending.get(msg.id)
        if (!p) break
        this.rpcPending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(msg.error))
        else p.resolve(msg.result)
        break
      }
    }
  }

  private conversationId?: string

  // Thread-ID aus einem Besprechungslink lesen
  static threadFromJoinUrl(url: string): string | undefined {
    const m = decodeURIComponent(url).match(/(19:meeting_[^/@]+@thread\.v2)/)
    return m?.[1]
  }

  openCallChat(openMain: (accountId: string, conversationId: string) => void): void {
    const acct = this.activeAccount()
    if (acct && this.conversationId) openMain(acct.id, this.conversationId)
    else this.action('toggleChat')
  }

  private onCallState(acct: AccountService, raw: any): void {
    const phase = raw?.phase ?? 'idle'
    // Solange ein Anruf/Beitritt angestoßen wird, meldet die Seite noch "idle". Ob der Start scheitert,
    // entscheiden setPending und failPending.
    if (phase === 'idle' && this.activeAccountId === acct.id && this.state?.phase === 'connecting') return
    if (phase === 'idle') {
      if (this.activeAccountId === acct.id) {
        // Ein angenommener Anruf meldet „idle“, bis Teams verbunden hat: dann noch kein Ende
        if (this.state) this.finishStats()
        this.denyPendingDisplay()
        this.activeAccountId = undefined
        this.conversationId = undefined
        this.state = null
        this.streams = []
        this.broadcast('call-state', null)
        clearTimeout(this.closeTimer)
        this.closeTimer = setTimeout(() => this.closeCallWindows(), 1200)
      }
      return
    }
    if (this.activeAccountId && this.activeAccountId !== acct.id) return
    if (!this.state && this.cancelled?.accountId === acct.id && Date.now() < this.cancelled.until) {
      log.info('call started after cancel, leaving', phase)
      acct.engine.send('engine:cmd', { ch: 'action', action: phase === 'prejoin' ? 'cancelJoin' : 'hangup' })
      return
    }
    clearTimeout(this.closeTimer)
    const wasIdle = !this.state
    this.activeAccountId = acct.id
    const state: CallState = { accountId: acct.id, ...raw, participants: cleanParticipants(raw?.participants), conversationId: this.conversationId }
    this.state = state
    this.updateStats(state)
    this.broadcast('call-state', state)
    if (wasIdle) this.openCallWindow()
  }

  private onIncoming(acct: AccountService, call: any): void {
    if (call) {
      if (this.incoming?.id !== call.id) analytics.track('incoming_call_received', { video: !!call.isVideo })
      this.incoming = { accountId: acct.id, ...call }
      if (!this.incomingWindow || this.incomingWindow.isDestroyed()) {
        const win = createIncomingWindow()
        this.incomingWindow = win
        win.on('closed', () => (this.incomingWindow = null))
        // Das Fenster lädt erst nach dem Broadcast – Zustand nach dem Laden erneut senden.
        win.webContents.once('did-finish-load', () => {
          if (!win.isDestroyed()) win.webContents.send('event', 'incoming-call', this.incoming)
        })
      } else {
        this.incomingWindow.showInactive()
      }
      this.broadcast('incoming-call', this.incoming)
    } else if (this.incoming && this.incoming.accountId === acct.id) {
      if (this.incoming.id !== this.answeredIncoming) analytics.track('incoming_call_missed', { video: !!this.incoming.isVideo })
      // Die ID ist der Name des Anrufers: gilt nur für dieses Klingeln
      this.answeredIncoming = undefined
      this.incoming = null
      this.broadcast('incoming-call', null)
      if (this.incomingWindow && !this.incomingWindow.isDestroyed()) this.incomingWindow.close()
    }
  }

  private onReceiverMessage(receiverId: number, msg: BridgeMessage): void {
    const acct = this.activeAccount() ?? this.accounts().find((a) => a.engine.status === 'ready')
    if (!acct) return
    acct.engine.send('engine:cmd', { ch: 'bridge', msg: { ...msg, receiverId } })
  }

  answer(call: IncomingCall, mode: 'video' | 'audio' | 'decline'): void {
    const acct = this.accounts().find((a) => a.id === call.accountId)
    if (!acct) return
    const action = mode === 'video' ? 'acceptVideo' : mode === 'audio' ? 'acceptAudio' : 'decline'
    acct.engine.send('engine:cmd', { ch: 'action', action })
    this.answeredIncoming = call.id
    if (mode !== 'decline') {
      this.cancelled = undefined
      this.activeAccountId = acct.id
      this.beginStats('incoming')
      // Verbindet Teams den angenommenen Anruf nicht, zählt er als nicht beigetreten
      const st = this.stats
      setTimeout(() => {
        if (this.stats === st && !st?.connectedAt && !this.state) this.finishStats()
      }, 60_000)
    }
  }

  action(action: CallAction | 'startVideoCall' | 'startAudioCall', arg?: string, accountId?: string): void {
    // Solange der Anruf erst gestartet wird, gibt es in der Web-App noch nichts zum Auflegen
    if ((action === 'hangup' || action === 'cancelJoin') && !accountId && (!this.state || this.state.phase === 'connecting')) {
      this.cancelPending(true)
      return
    }
    const acct = (accountId && this.accounts().find((a) => a.id === accountId)) || this.activeAccount()
    if (!acct) return
    acct.engine.send('engine:cmd', { ch: 'action', action, arg })
  }

  joinMeeting(acct: AccountService, joinUrl: string): void {
    // Zoom- oder Webex-Links aus dem Kalender gehören in den Browser, nicht in die Teams-Web-App
    if (!isTeamsUrl(joinUrl)) {
      if (/^https:/.test(joinUrl)) void shell.openExternal(joinUrl)
      analytics.track('meeting_opened_in_browser', {}, { active: true })
      return
    }
    if (this.state && this.activeAccountId) {
      this.openCallWindow()
      return
    }
    this.cancelled = undefined
    this.activeAccountId = acct.id
    this.conversationId = CallManager.threadFromJoinUrl(joinUrl)
    acct.engine.navigate(joinUrl)
    this.beginStats('meeting')
    this.openCallWindow()
    this.setPending(acct.id, 'Besprechung wird geöffnet …', false)
  }

  async startCall(acct: AccountService, target: { mris?: string[]; conversationId?: string }, video: boolean): Promise<void> {
    if (this.state) {
      this.openCallWindow()
      return
    }
    this.cancelled = undefined
    this.activeAccountId = acct.id
    this.conversationId = target.conversationId
    const origin = acct.engine.webOrigin()
    let url: string
    if (target.conversationId) {
      url = `${origin}/l/chat/${encodeURIComponent(target.conversationId)}/0?tenantId=${acct.record.tenantId ?? ''}`
    } else {
      const mris = target.mris ?? []
      // Vorhandenen 1:1-Chat bevorzugen
      const existing = mris.length === 1 ? [...acct.chats.values()].find((c) => c.kind === 'oneOnOne' && c.members[0] === mris[0]) : undefined
      if (existing) url = `${origin}/l/chat/${encodeURIComponent(existing.id)}/0?tenantId=${acct.record.tenantId ?? ''}`
      else {
        const people = await acct.getPeople(mris)
        const users = people.map((p) => p.upn || p.email || p.mri).join(',')
        url = `${origin}/l/chat/0/0?users=${encodeURIComponent(users)}`
      }
    }
    // Der Befehl reist im Link mit: Teams leitet beim Laden um, die endgültige Seite führt ihn aus.
    const action = video ? 'startVideoCall' : 'startAudioCall'
    log.info('call start', video ? 'video' : 'audio')
    acct.engine.navigate(`${url}${url.includes('?') ? '&' : '?'}tmAction=${action}`)
    this.beginStats('call')
    this.openCallWindow()
    this.setPending(acct.id, 'Anruf wird gestartet …', video)
  }

  private resetCall(): void {
    this.finishStats()
    this.denyPendingDisplay()
    this.conversationId = undefined
    this.state = null
    this.activeAccountId = undefined
    this.streams = []
    this.broadcast('call-state', null)
  }

  private setPending(accountId: string, title: string, video: boolean): void {
    const seq = ++this.pendingSeq
    this.state = { accountId, phase: 'connecting', title, muted: false, cameraOn: video, sharing: false, handRaised: false, participants: [], available: {}, conversationId: this.conversationId }
    this.broadcast('call-state', this.state)
    // Falls nichts passiert, Fehler zeigen und das Fenster schließen
    setTimeout(() => {
      if (seq === this.pendingSeq && this.state?.phase === 'connecting' && !this.state.error) this.failPending('timeout')
    }, 46_000)
  }

  // Start gescheitert: Fehler kurz zeigen, dann wie "Verlassen"
  private failPending(reason: 'timeout' | 'web_app', detail?: string): void {
    if (!this.state) return
    if (this.stats && !this.stats.reported) {
      analytics.track('call_start_failed', { origin: this.stats.origin, reason, seconds: Math.round((Date.now() - this.stats.requestedAt) / 1000) })
      this.stats.reported = true
    }
    const seq = this.pendingSeq
    this.state = { ...this.state, error: detail ? `Der Anruf konnte nicht gestartet werden. Teams meldet: ${detail}` : 'Der Anruf konnte nicht gestartet werden.' }
    this.broadcast('call-state', this.state)
    setTimeout(() => {
      if (seq === this.pendingSeq && this.state?.phase === 'connecting') this.cancelPending(true)
    }, 5000)
  }

  // Anruf, der noch nicht verbunden ist, abbrechen. Die Web-App bricht ihren Start ab.
  private cancelPending(closeWindow: boolean): void {
    if (this.stats && !this.stats.reported) {
      analytics.track('call_start_cancelled', { origin: this.stats.origin, seconds: Math.round((Date.now() - this.stats.requestedAt) / 1000) }, { active: true })
      this.stats.reported = true
    }
    const acct = this.activeAccount()
    if (acct) {
      acct.engine.send('engine:cmd', { ch: 'action', action: 'cancelJoin' })
      this.cancelled = { accountId: acct.id, until: Date.now() + 45_000 }
    }
    log.info('call start cancelled')
    this.pendingSeq++
    this.resetCall()
    if (closeWindow) this.closeCallWindows()
  }

  openCallWindow(): void {
    if (this.callWindow && !this.callWindow.isDestroyed()) {
      this.callWindow.show()
      this.callWindow.focus()
      return
    }
    this.compact = false
    this.callWindow = createCallWindow()
    const win = this.callWindow
    win.on('close', (e) => {
      const phase = this.state?.phase
      if (!phase || phase === 'idle' || phase === 'ended') return
      // Beim Beenden der App nicht nachfragen: preventDefault würde das Beenden abbrechen,
      // nachdem die Konten schon gestoppt sind.
      if (this.isQuitting()) return
      if (phase === 'connecting') {
        this.cancelPending(false)
        return
      }
      if (phase === 'prejoin') {
        this.action('cancelJoin')
        this.resetCall()
        return
      }
      // Laufender Anruf: wie in Teams nachfragen
      e.preventDefault()
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question',
        buttons: ['Verlassen', 'Kompaktansicht', 'Abbrechen'],
        defaultId: 1,
        cancelId: 2,
        message: 'Besprechung verlassen?',
        detail: 'Du kannst die Besprechung verlassen oder sie in einem kleinen Fenster weiterlaufen lassen.'
      })
      analytics.track('call_window_close_prompt', { choice: ['leave', 'compact', 'cancel'][choice] ?? 'cancel' }, { active: true })
      if (choice === 0) {
        this.action('hangup')
        setTimeout(() => {
          this.resetCall()
          if (!win.isDestroyed()) win.destroy()
        }, 800)
      } else if (choice === 1) {
        this.setCompact(true)
      }
    })
    this.callWindow.on('closed', () => {
      // Die Quellenauswahl lebt in diesem Fenster
      this.denyPendingDisplay()
      this.callWindow = null
      this.compact = false
    })
  }

  // ---------- Nutzungsdaten ----------

  private beginStats(origin: CallOrigin): void {
    // Ein angenommener Anruf, der nie verbunden hat, zählt vor dem nächsten als nicht beigetreten
    if (this.stats) this.finishStats()
    this.stats = { origin, requestedAt: Date.now(), lastPhase: 'connecting', maxParticipants: 0, sharedScreen: false, cameraUsed: false, lobby: false, reported: false }
  }

  private updateStats(state: CallState): void {
    // Anruf, den die Web-App selbst gestartet hat (z. B. in der Webansicht)
    if (!this.stats) this.beginStats('web_view')
    const st = this.stats!
    // Fürs Log: wie lange jeder Schritt vom Klick bis zum Anruf dauert
    if (st.lastPhase !== state.phase) log.info(`call phase ${state.phase} after ${((Date.now() - st.requestedAt) / 1000).toFixed(1)} s (${st.origin})`)
    st.lastPhase = state.phase
    st.maxParticipants = Math.max(st.maxParticipants, state.participants.length)
    st.sharedScreen ||= state.sharing
    st.cameraUsed ||= state.cameraOn
    if (state.phase === 'lobby') st.lobby = true
    if (state.phase === 'in-call' && !st.connectedAt) {
      st.connectedAt = Date.now()
      analytics.track('call_connected', {
        origin: st.origin,
        seconds_to_connect: Math.round((st.connectedAt - st.requestedAt) / 1000),
        waited_in_lobby: st.lobby,
        camera_on: state.cameraOn,
        participants: state.participants.length
      })
    }
  }

  private finishStats(): void {
    const st = this.stats
    this.stats = undefined
    if (!st) return
    if (st.connectedAt) {
      analytics.track('call_ended', {
        origin: st.origin,
        duration_s: Math.round((Date.now() - st.connectedAt) / 1000),
        max_participants: st.maxParticipants,
        shared_screen: st.sharedScreen,
        camera_used: st.cameraUsed
      })
    } else if (!st.reported) {
      // Vorschau geschlossen, im Wartebereich aufgegeben oder vor dem Verbinden beendet
      analytics.track('call_not_joined', { origin: st.origin, last_phase: st.lastPhase, seconds: Math.round((Date.now() - st.requestedAt) / 1000) })
    }
  }

  setCompact(on: boolean): void {
    const win = this.callWindow
    if (!win || win.isDestroyed() || on === this.compact) return
    this.compact = on
    if (on) {
      this.normalBounds = win.getBounds()
      const area = screen.getDisplayMatching(this.normalBounds).workArea
      win.setAlwaysOnTop(true, 'floating')
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      win.setBounds({ width: 360, height: 230, x: area.x + area.width - 376, y: area.y + area.height - 246 }, true)
    } else {
      win.setAlwaysOnTop(false)
      win.setVisibleOnAllWorkspaces(false)
      if (this.normalBounds) win.setBounds(this.normalBounds, true)
    }
    win.webContents.send('event', 'call-compact', on)
  }

  popout(streamId: string, label: string): void {
    const win = createPopoutWindow(streamId, label)
    this.popouts.add(win)
    win.on('closed', () => this.popouts.delete(win))
  }

  showInTeams(): void {
    this.activeAccount()?.engine.showWindow()
  }

  private closeCallWindows(): void {
    if (this.state) return
    if (this.callWindow && !this.callWindow.isDestroyed()) this.callWindow.destroy()
    for (const p of this.popouts) if (!p.isDestroyed()) p.close()
    this.popouts.clear()
    // Engine nach dem Anruf zurück auf die Startseite, damit der nächste Anruf sauber startet
    const acct = this.accounts().find((a) => !a.engine.currentUrl.includes('/v2/'))
    void acct
  }

  // Anfrage an das Skript in der Web-App mit Antwort
  rpc<T>(method: string, args: Record<string, unknown> = {}, timeout = 15000): Promise<T> {
    const acct = this.activeAccount() ?? this.accounts().find((a) => a.engine.status === 'ready')
    if (!acct) return Promise.reject(new Error('Kein aktives Konto'))
    const id = ++this.rpcSeq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rpcPending.delete(id)
        reject(new Error('Zeitüberschreitung'))
      }, timeout)
      this.rpcPending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      acct.engine.send('engine:cmd', { ch: 'rpc', id, method, args })
    })
  }

  getBackgrounds(): Promise<BackgroundList> {
    return this.rpc<BackgroundList>('listBackgrounds', {}, 20000)
  }

  async setBackground(id: string): Promise<void> {
    await this.rpc('setBackground', { id })
  }

  async addBackground(parent?: BrowserWindow | null): Promise<BackgroundList | null> {
    const res = parent
      ? await dialog.showOpenDialog(parent, { title: 'Eigenen Hintergrund hinzufügen', properties: ['openFile'], filters: [{ name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'bmp'] }] })
      : await dialog.showOpenDialog({ title: 'Eigenen Hintergrund hinzufügen', properties: ['openFile'], filters: [{ name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'bmp'] }] })
    if (res.canceled || !res.filePaths[0]) return null
    const acct = this.activeAccount()
    if (!acct) return null
    await this.rpc('openBackgrounds')
    const ok = await acct.engine.setFileInput('input[type=file][accept*=".png"]', res.filePaths[0])
    if (!ok) throw new Error('Hochladen in Teams nicht möglich')
    await new Promise((r) => setTimeout(r, 2500))
    return this.getBackgrounds()
  }

  async closeBackgrounds(): Promise<void> {
    await this.rpc('closeBackgrounds').catch(() => undefined)
  }

  getDevices(): Promise<CallDevices> {
    return this.rpc<CallDevices>('listDevices', {}, 10000)
  }

  async setDevice(kind: string, id: string): Promise<void> {
    await this.rpc('selectDevice', { kind, id })
  }

  probe(acct: AccountService): Promise<unknown> {
    return new Promise((resolve) => {
      this.probes.set(acct.id, resolve)
      acct.engine.send('engine:cmd', { ch: 'probe' })
      setTimeout(() => {
        if (this.probes.has(acct.id)) {
          this.probes.delete(acct.id)
          resolve(null)
        }
      }, 3000)
    })
  }

  isUiWindow(win: BrowserWindow): boolean {
    return uiWindows.has(win)
  }

  logState(): void {
    log.info('call state', this.state?.phase, this.streams.length)
  }
}
