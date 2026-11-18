import { BrowserWindow, session, shell, type Session, type WebContents } from 'electron'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { TokenStore, type Family } from './tokens'
import type { AccountStatus, BridgeMessage, CallState, IncomingCall, MediaStreamInfo } from '@shared/types'
import { log } from '../log'

export const TEAMS_START_URL = 'https://teams.microsoft.com/v2/'

const LOGIN_HOSTS = [
  /(^|\.)login\.microsoftonline\.com$/,
  /(^|\.)login\.microsoft\.com$/,
  /(^|\.)login\.live\.com$/,
  /(^|\.)account\.live\.com$/,
  /(^|\.)microsoftonline\.com$/,
  /(^|\.)msauth\.net$/,
  /(^|\.)okta\.com$/,
  /(^|\.)duosecurity\.com$/,
  /^adfs\./,
  /^sts\./,
  /^sso\./
]

const MS_HOSTS = [
  /(^|\.)microsoft\.com$/,
  /(^|\.)cloud\.microsoft$/,
  /(^|\.)office\.com$/,
  /(^|\.)office\.net$/,
  /(^|\.)live\.com$/,
  /(^|\.)skype\.com$/,
  /(^|\.)microsoftonline\.com$/,
  /(^|\.)msauth\.net$/,
  /(^|\.)msftauth\.net$/,
  /(^|\.)sharepoint\.com$/,
  /(^|\.)windows\.net$/
]

export function chromeUserAgent(): string {
  const major = (process.versions.chrome || '156').split('.')[0]
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

export interface EngineEvents {
  status: [AccountStatus, string | undefined]
  ready: []
  realtime: [string]
  'endpoint-changed': [Family]
  'call-state': [CallState | null]
  'incoming-call': [IncomingCall | null]
  bridge: [BridgeMessage]
  streams: [MediaStreamInfo[]]
}

export class Engine extends EventEmitter<EngineEvents> {
  readonly ses: Session
  win: BrowserWindow | null = null
  readonly tokens = new TokenStore()
  status: AccountStatus = 'starting'
  statusDetail?: string
  private shownForLogin = false
  private quitting = false
  private readyTimer?: NodeJS.Timeout
  private lastUrl = ''
  private debuggerAttached = false
  wsFrames = 0
  lastBodies = new Map<string, string>()

  constructor(
    readonly accountId: string,
    readonly preloadPath: string,
    private readonly opts: { autoShowLogin: boolean; title: string }
  ) {
    super()
    this.ses = session.fromPartition(`persist:acct-${accountId}`)
    this.setupSession()
    this.tokens.onChange = (f) => {
      this.emit('endpoint-changed', f)
      this.checkReady()
    }
  }

  get webContents(): WebContents | undefined {
    return this.win && !this.win.isDestroyed() ? this.win.webContents : undefined
  }

  private setupSession(): void {
    const ses = this.ses
    ses.setUserAgent(chromeUserAgent(), 'de-DE,de,en-US,en')

    ses.webRequest.onBeforeSendHeaders({ urls: ['https://*/*', 'wss://*/*'] }, (details, cb) => {
      try {
        this.tokens.capture(details.url, details.method, details.requestHeaders as Record<string, string>)
      } catch (e) {
        log.warn('capture failed', e)
      }
      cb({ requestHeaders: details.requestHeaders })
    })

    // Diagnose: Request-Bodies bestimmter Aufrufe der Web-App mitschreiben
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*forceavailability*', '*://*/*/me/endpoints/*', '*://*/*conversationFolder*', '*://*/*folders*'] }, (d, cb) => {
      try {
        const bytes = d.uploadData?.[0]?.bytes
        if (bytes) this.lastBodies.set(`${d.method} ${d.url.split('?')[0]}`, Buffer.from(bytes).toString('utf8').slice(0, 500))
      } catch {
        /* ignore */
      }
      cb({})
    })

    // Sitzungs-Cookies der Microsoft-Anmeldung dauerhaft speichern, damit man nach einem
    // Neustart angemeldet bleibt (entspricht "Angemeldet bleiben").
    ses.cookies.on('changed', (_e, cookie, _cause, removed) => {
      if (removed || !cookie.session || !cookie.domain) return
      if (!/(login\.microsoftonline\.com|login\.microsoft\.com|login\.live\.com)$/.test(cookie.domain.replace(/^\./, ''))) return
      const host = cookie.domain.replace(/^\./, '')
      void ses.cookies
        .set({
          url: `https://${host}${cookie.path ?? '/'}`,
          name: cookie.name,
          value: cookie.value,
          domain: cookie.hostOnly ? undefined : cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          expirationDate: Date.now() / 1000 + 30 * 24 * 3600
        })
        .catch(() => undefined)
    })

    ses.setPermissionRequestHandler((_wc, permission, cb) => {
      // Benachrichtigungen zeigt unsere App selbst an.
      if (permission === 'notifications') return cb(false)
      cb(['media', 'mediaKeySystem', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'display-capture', 'speaker-selection', 'idle-detection', 'window-management'].includes(permission))
    })
    ses.setPermissionCheckHandler((_wc, permission) => {
      if (permission === 'notifications') return false
      return true
    })
  }

  start(): void {
    if (this.win && !this.win.isDestroyed()) return
    this.setStatus('starting')
    const win = new BrowserWindow({
      show: false,
      width: 1366,
      height: 900,
      minWidth: 800,
      minHeight: 600,
      title: this.opts.title,
      backgroundColor: '#ffffff',
      webPreferences: {
        session: this.ses,
        preload: this.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
        nodeIntegrationInSubFrames: false
      }
    })
    this.win = win
    win.on('close', (e) => {
      if (this.quitting) return
      // Fenster nur verstecken, die Web-App läuft weiter.
      e.preventDefault()
      win.hide()
      this.shownForLogin = false
    })
    win.on('closed', () => {
      this.win = null
    })

    const wc = win.webContents
    wc.setAudioMuted(false)
    wc.setWindowOpenHandler(({ url, frameName, features }) => {
      log.info(`[${this.accountId}] window.open ${url.slice(0, 160)} name=${frameName} features=${features}`)
      try {
        const host = new URL(url).hostname
        if (LOGIN_HOSTS.some((r) => r.test(host)) || url.startsWith('about:blank')) {
          return {
            action: 'allow',
            overrideBrowserWindowOptions: { width: 520, height: 680, webPreferences: { session: this.ses } }
          }
        }
      } catch {
        /* ignore */
      }
      if (/^https?:/.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (e, url) => {
      if (!/^https?:/.test(url)) {
        // msteams:// usw. nicht an das System weitergeben
        e.preventDefault()
        return
      }
      try {
        const host = new URL(url).hostname
        if (!MS_HOSTS.some((r) => r.test(host)) && !LOGIN_HOSTS.some((r) => r.test(host))) {
          e.preventDefault()
          void shell.openExternal(url)
        }
      } catch {
        /* ignore */
      }
    })
    wc.on('did-navigate', (_e, url) => this.onNavigate(url))
    wc.on('did-navigate-in-page', (_e, url) => this.onNavigate(url))
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (!isMain || code === -3) return
      log.warn(`[${this.accountId}] load failed ${code} ${desc} ${url}`)
      this.setStatus('error', `Teams konnte nicht geladen werden (${desc}).`)
      setTimeout(() => this.reload(), 15000)
    })
    wc.on('render-process-gone', (_e, details) => {
      log.warn(`[${this.accountId}] renderer gone`, details.reason)
      this.setStatus('error', 'Die Teams-Web-App ist abgestürzt, sie wird neu geladen.')
      setTimeout(() => this.reload(), 3000)
    })
    wc.on('console-message', (e) => {
      const msg = (e as unknown as { message?: string }).message ?? ''
      if (msg.startsWith('[tm]')) log.info(`[engine ${this.accountId}] ${msg}`)
    })
    this.attachDebugger(wc)
    void win.loadURL(TEAMS_START_URL)
  }

  private attachDebugger(wc: WebContents): void {
    try {
      wc.debugger.attach('1.3')
      this.debuggerAttached = true
    } catch (e) {
      log.warn('debugger attach failed', e)
      return
    }
    const dbg = wc.debugger
    const enableNetwork = (sessionId?: string) =>
      dbg.sendCommand('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, sessionId).catch(() => undefined)
    void enableNetwork()
    void dbg
      .sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
      .catch(() => undefined)
    dbg.on('message', (_e, method, params, sessionId) => {
      if (method === 'Target.attachedToTarget') {
        const sid = (params as { sessionId: string }).sessionId
        void enableNetwork(sid)
        void dbg.sendCommand('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => undefined)
        return
      }
      if (method === 'Network.webSocketFrameReceived') {
        this.wsFrames++
        const payload = (params as { response?: { payloadData?: string } }).response?.payloadData ?? ''
        this.emit('realtime', payload)
      }
      void sessionId
    })
    dbg.on('detach', () => {
      this.debuggerAttached = false
    })
  }

  private onNavigate(url: string): void {
    // Die Microsoft-Startseite für Links versucht die Desktop-App zu öffnen und bleibt dann leer.
    if (/\/dl\/launcher\/launcher\.html/.test(url)) {
      const inner = new URL(url).searchParams.get('url')
      if (inner) {
        void this.win?.loadURL(`https://teams.microsoft.com${inner.startsWith('/') ? '' : '/'}${inner}`)
        return
      }
    }
    if (!/launcher/.test(url)) this.lastUrl = url
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {
      return
    }
    if (LOGIN_HOSTS.some((r) => r.test(host))) {
      this.setStatus('login-required', 'Anmeldung bei Microsoft erforderlich')
      if (this.opts.autoShowLogin || this.shownForLogin) this.showForLogin()
      return
    }
    if (/teams\.(microsoft\.com|cloud\.microsoft|live\.com)$/.test(host)) {
      if (this.status === 'login-required' || this.status === 'starting') this.setStatus('connecting')
      this.checkReady()
    }
  }

  private readyFallback?: NodeJS.Timeout

  private checkReady(): void {
    if (this.status === 'ready') return
    // Ohne CSA fehlen Teams, Ordner und die meisten Chats – darauf kurz warten.
    if (this.tokens.has('chatsvc') && !this.tokens.has('csa') && !this.readyFallback) {
      this.readyFallback = setTimeout(() => {
        this.readyFallback = undefined
        if (this.status !== 'ready' && this.tokens.has('chatsvc')) this.forceReady()
      }, 20000)
    }
    if (this.tokens.has('chatsvc') && this.tokens.has('csa')) {
      clearTimeout(this.readyFallback)
      this.readyFallback = undefined
      clearTimeout(this.readyTimer)
      // Kurz warten, damit die Web-App die übrigen Tokens holen kann.
      this.readyTimer = setTimeout(() => {
        this.setStatus('ready')
        if (this.shownForLogin && this.win && !this.win.isDestroyed()) {
          this.win.hide()
          this.shownForLogin = false
        }
        // Anmelde-Cookies sofort auf die Platte schreiben
        void this.ses.cookies.flushStore().catch(() => undefined)
        this.emit('ready')
      }, 1500)
    }
  }

  private forceReady(): void {
    this.setStatus('ready')
    if (this.shownForLogin && this.win && !this.win.isDestroyed()) {
      this.win.hide()
      this.shownForLogin = false
    }
    this.emit('ready')
  }

  setStatus(s: AccountStatus, detail?: string): void {
    if (this.status === s && this.statusDetail === detail) return
    this.status = s
    this.statusDetail = detail
    this.emit('status', s, detail)
  }

  showForLogin(): void {
    if (!this.win || this.win.isDestroyed()) this.start()
    this.shownForLogin = true
    this.win?.setTitle(`${this.opts.title} – Anmeldung`)
    this.win?.show()
    this.win?.focus()
  }

  showWindow(): void {
    if (!this.win || this.win.isDestroyed()) this.start()
    this.win?.show()
    this.win?.focus()
  }

  hideWindow(): void {
    this.win?.hide()
  }

  reload(): void {
    if (!this.win || this.win.isDestroyed()) return this.start()
    this.setStatus('starting')
    void this.win.loadURL(TEAMS_START_URL)
  }

  navigate(url: string): void {
    if (!this.win || this.win.isDestroyed()) this.start()
    void this.win?.loadURL(toSpaRoute(url))
  }

  get currentUrl(): string {
    return this.lastUrl
  }

  // Befehl an das Engine-Preload (Anrufsteuerung, Medienbrücke).
  send(channel: string, payload: unknown): void {
    this.webContents?.send(channel, payload)
  }

  async evaluate<T = unknown>(code: string): Promise<T | undefined> {
    const wc = this.webContents
    if (!wc) return undefined
    try {
      return (await wc.executeJavaScript(code, true)) as T
    } catch (e) {
      log.warn('evaluate failed', e)
      return undefined
    }
  }

  // HTTP-Aufruf mit den Auth-Headern der Web-App über den Netzwerk-Stack dieser Partition.
  async request(family: Family, url: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: boolean } = {}): Promise<Response> {
    const headers: Record<string, string> = { ...this.tokens.headersFor(family), ...(init.headers ?? {}) }
    let body: string | undefined
    if (init.body !== undefined) {
      body = typeof init.body === 'string' && init.raw ? init.body : JSON.stringify(init.body)
      if (!headers['content-type']) headers['content-type'] = 'application/json'
    }
    if (!headers['accept']) headers['accept'] = 'application/json'
    const origin = this.webOrigin()
    headers['origin'] = origin
    headers['referer'] = origin + '/'
    return this.ses.fetch(url, { method: init.method ?? 'GET', headers, body, credentials: 'include' } as RequestInit)
  }

  webOrigin(): string {
    try {
      const u = new URL(this.lastUrl)
      if (/teams\.(microsoft\.com|cloud\.microsoft)$/.test(u.hostname)) return u.origin
    } catch {
      /* ignore */
    }
    return 'https://teams.microsoft.com'
  }

  // Datei in ein <input type=file> der Web-App legen (z.B. eigenes Hintergrundbild).
  async setFileInput(selector: string, path: string): Promise<boolean> {
    const wc = this.webContents
    if (!wc || !this.debuggerAttached) return false
    const dbg = wc.debugger
    const doc = (await dbg.sendCommand('DOM.getDocument', { depth: 0 })) as { root: { nodeId: number } }
    const found = (await dbg.sendCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector })) as { nodeId: number }
    if (!found.nodeId) return false
    await dbg.sendCommand('DOM.setFileInputFiles', { files: [path], nodeId: found.nodeId })
    return true
  }

  destroy(): void {
    this.quitting = true
    clearTimeout(this.readyTimer)
    if (this.debuggerAttached) {
      try {
        this.win?.webContents.debugger.detach()
      } catch {
        /* ignore */
      }
    }
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }

  async clearData(): Promise<void> {
    await this.ses.clearStorageData()
    await this.ses.clearCache()
  }
}

// https://teams.microsoft.com/l/meetup-join/... -> https://teams.microsoft.com/_#/l/meetup-join/...
// So öffnet die Web-App den Link direkt, ohne Umweg über die Startseite für die Desktop-App.
export function toSpaRoute(url: string): string {
  try {
    const u = new URL(url)
    if (/^\/l\//.test(u.pathname) && /teams\.(microsoft\.com|cloud\.microsoft|live\.com)$/.test(u.hostname)) {
      return `https://teams.microsoft.com/_#${u.pathname}${u.search}`
    }
  } catch {
    /* ignore */
  }
  return url
}

export function enginePreloadPath(): string {
  return join(__dirname, '../preload/engine.js')
}
