/* eslint-disable @typescript-eslint/no-explicit-any */
import { BrowserWindow, desktopCapturer, dialog, ipcMain, screen, shell, webContents, type DesktopCapturerSource } from 'electron'
import type { AccountService } from './account'
import type { BackgroundList, BridgeMessage, CallAction, CallDevices, CallParticipant, CallState, IncomingCall, MediaStreamInfo } from '@shared/types'
import { createCallWindow, createIncomingWindow, createPopoutWindow, uiWindows } from './windows'
import { log } from './log'
import { isTeamsUrl } from './engine/hosts'
import { cleanCallName } from '@shared/call-names'

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

export class CallManager {
  state: CallState | null = null
  incoming: IncomingCall | null = null
  streams: MediaStreamInfo[] = []
  callWindow: BrowserWindow | null = null
  incomingWindow: BrowserWindow | null = null
  popouts = new Set<BrowserWindow>()
  private activeAccountId?: string
  private compact = false
  private normalBounds?: Electron.Rectangle
  private closeTimer?: NodeJS.Timeout
  private pendingDisplay?: { cb: (s: any) => void; sources: DesktopCapturerSource[] }
  private probes = new Map<string, (r: unknown) => void>()
  // Solange ein Anruf/Beitritt angestoßen wird, meldet die Seite noch "idle" – das ignorieren wir.
  private pendingUntil = 0
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
          let sources: DesktopCapturerSource[]
          try {
            sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: false })
          } catch (e) {
            // z.B. ohne Berechtigung zur Bildschirmaufnahme. Ohne Antwort hinge die Freigabe in der Web-App.
            log.warn('desktopCapturer.getSources failed', (e as Error).message)
            denyDisplay(cb)
            return
          }
          this.pendingDisplay = { cb, sources }
          const target = this.callWindow && !this.callWindow.isDestroyed() ? this.callWindow : BrowserWindow.getFocusedWindow()
          if (target) {
            if (this.compact) this.setCompact(false)
            target.show()
            target.focus()
          }
          this.broadcast(
            'display-sources',
            sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), kind: s.id.startsWith('screen') ? 'screen' : 'window' }))
          )
        })()
      },
      { useSystemPicker: false }
    )
  }

  pickDisplaySource(id: string | null): void {
    const p = this.pendingDisplay
    this.pendingDisplay = undefined
    if (!p) return
    const src = id ? p.sources.find((s) => s.id === id) : undefined
    if (!src) {
      denyDisplay(p.cb)
      return
    }
    p.cb({ video: src, audio: src.id.startsWith('screen') ? 'loopback' : undefined })
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
      case 'display-media-requested':
        break
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
    if (phase === 'idle' && this.activeAccountId === acct.id && Date.now() < this.pendingUntil) return
    if (phase !== 'idle') this.pendingUntil = 0
    if (phase === 'idle') {
      if (this.activeAccountId === acct.id) {
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
    clearTimeout(this.closeTimer)
    const wasIdle = !this.state
    this.activeAccountId = acct.id
    this.state = { accountId: acct.id, ...raw, participants: cleanParticipants(raw?.participants), conversationId: this.conversationId }
    this.broadcast('call-state', this.state)
    if (wasIdle) this.openCallWindow()
  }

  private onIncoming(acct: AccountService, call: any): void {
    if (call) {
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
    if (mode !== 'decline') this.activeAccountId = acct.id
  }

  action(action: CallAction | 'startVideoCall' | 'startAudioCall', arg?: string, accountId?: string): void {
    const acct = (accountId && this.accounts().find((a) => a.id === accountId)) || this.activeAccount()
    if (!acct) return
    acct.engine.send('engine:cmd', { ch: 'action', action, arg })
  }

  joinMeeting(acct: AccountService, joinUrl: string): void {
    // Zoom- oder Webex-Links aus dem Kalender gehören in den Browser, nicht in die Teams-Web-App
    if (!isTeamsUrl(joinUrl)) {
      if (/^https:/.test(joinUrl)) void shell.openExternal(joinUrl)
      return
    }
    if (this.state && this.activeAccountId) {
      this.openCallWindow()
      return
    }
    this.activeAccountId = acct.id
    this.conversationId = CallManager.threadFromJoinUrl(joinUrl)
    acct.engine.navigate(joinUrl)
    this.openCallWindow()
    this.setPending(acct.id, 'Besprechung wird geöffnet …', false)
  }

  async startCall(acct: AccountService, target: { mris?: string[]; conversationId?: string }, video: boolean): Promise<void> {
    if (this.state) {
      this.openCallWindow()
      return
    }
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
    acct.engine.navigate(`${url}${url.includes('?') ? '&' : '?'}tmAction=${action}`)
    this.openCallWindow()
    this.setPending(acct.id, 'Anruf wird gestartet …', video)
  }

  private resetCall(): void {
    this.conversationId = undefined
    this.state = null
    this.pendingUntil = 0
    this.activeAccountId = undefined
    this.streams = []
    this.broadcast('call-state', null)
  }

  private setPending(accountId: string, title: string, video: boolean): void {
    this.pendingUntil = Date.now() + 45_000
    this.state = { accountId, phase: 'connecting', title, muted: false, cameraOn: video, sharing: false, handRaised: false, participants: [], available: {}, conversationId: this.conversationId }
    this.broadcast('call-state', this.state)
    // Falls nichts passiert, Fenster nach Ablauf wieder schließen
    setTimeout(() => {
      if (this.state?.phase === 'connecting' && Date.now() >= this.pendingUntil) {
        this.state = { ...this.state, error: 'Der Anruf konnte nicht gestartet werden.' }
        this.broadcast('call-state', this.state)
        setTimeout(() => {
          if (this.state?.phase === 'connecting') {
            this.state = null
            this.activeAccountId = undefined
            this.broadcast('call-state', null)
            this.closeCallWindows()
          }
        }, 5000)
      }
    }, 46_000)
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
      if (phase === 'prejoin' || phase === 'connecting') {
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
      this.callWindow = null
      this.compact = false
    })
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
