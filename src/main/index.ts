import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, powerMonitor, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { AccountService, type AccountRecord, type NotifyPayload } from './account'
import { CallManager } from './calls'
import { handleMediaProtocol, registerMediaScheme } from './media-protocol'
import { imageAction } from './image-actions'
import { store } from './store'
import { createMainWindow, uiWindows } from './windows'
import { Updater } from './updater'
import { log } from './log'
import { migrateLegacyUserData } from './legacy-data'
import { LiveNotifications } from './live-notifications'
import { appVariant, dataName, displayName } from './variant'
import { analytics } from './analytics'
import { setupCrashReporting, setupUiAnalytics, trackApiCall, trackApiFailure, trackFocus, usageContext, watchAccount } from './usage'
import { dockBadge } from '@shared/badge'
import { McpServer } from './mcp/server'
import { McpProtocol } from './mcp/protocol'
import { createTools, SERVER_INSTRUCTIONS } from './mcp/tools'
import { mcpAccount } from './mcp/source'
import { installMcp } from './mcp/install'
import { saveMcpFile } from './mcp/files'
import { settingsChanges, updateEvents } from '@shared/analytics'
import type { ApiMethods } from '@shared/ipc'
import type { AppSettings, DebugInfo, NavigateRequest, UpdateState } from '@shared/types'

// ---------- Chromium-Schalter (vor app.ready) ----------
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns,MediaSessionService')
app.commandLine.appendSwitch('allow-loopback-in-peer-connection')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
if (process.env.TM_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.TM_DEBUG_PORT)

// Dev läuft mit eigenem Namen und eigenem Datenordner neben der installierten App:
// eigene Konten, Einstellungen, Anmeldungen, Logs und Instanzsperre.
// app.setName muss vor app.ready laufen, Electron leitet daraus auch den Keychain-Eintrag ab.
const variant = appVariant(app.isPackaged, app.getVersion())
const appName = displayName(variant)
app.setName(dataName(variant))

// Bis zur Umbenennung hieß die App „Teams Mac“. Der alte Datenordner enthält
// Konten, Einstellungen und die Anmeldungen (Partitions) und zieht einmalig um.
// TE_USER_DATA_DIR startet die App mit einem eigenen Datenordner, z. B. zum Testen von Updates.
const customUserDataDir = process.env.TE_USER_DATA_DIR
const userDataDir = customUserDataDir || join(app.getPath('appData'), dataName(variant))
const migration = customUserDataDir || variant === 'dev' ? 'none' : migrateLegacyUserData(join(app.getPath('appData'), 'Teams Mac'), userDataDir)
// Läuft „Teams Mac“ noch, startet die App nur kurz mit einem Wegwerf-Ordner, meldet das und beendet sich.
// So entsteht der neue Ordner nicht leer, und der Umzug klappt beim nächsten Start.
app.setPath('userData', migration === 'legacy-running' ? join(app.getPath('temp'), 'teams-everywhere-waiting') : userDataDir)

registerMediaScheme()

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

// build.appId in package.json
const BUNDLE_ID = 'io.github.timschulzrc.teamseverywhere'

let mainWindow: BrowserWindow | null = null
let settings: AppSettings
const accounts = new Map<string, AccountService>()
let calls: CallManager
let updater: Updater
let mcp: McpServer
let quitting = false
let focusContext: { accountId?: string; conversationId?: string } = {}

function broadcast(event: string, payload: unknown): void {
  for (const w of uiWindows) if (!w.isDestroyed()) w.webContents.send('event', event, payload)
}

function accountList() {
  return [...accounts.values()].map((a) => a.info())
}

let accountsTimer: NodeJS.Timeout | undefined
let lastBadge = -1
function emitAccounts(): void {
  clearTimeout(accountsTimer)
  accountsTimer = setTimeout(() => {
    const list = accountList()
    broadcast('accounts', list)
    const badge = dockBadge(list)
    if (badge !== lastBadge) log.info(`Dock-Zahl: ${badge}`)
    lastBadge = badge
    app.setBadgeCount(badge)
    // Gelesene Unterhaltungen: Mitteilung aus der Mitteilungszentrale nehmen, wie der Punkt am Dock
    liveNotifications.closeRead((k) => accounts.get(k.accountId)?.isUnread(k) ?? false)
  }, 150)
}

function saveRecords(): void {
  store.saveAccounts([...accounts.values()].map((a) => a.record))
}

function addAccountService(rec: AccountRecord, autoShowLogin: boolean): AccountService {
  const acct = new AccountService(rec, { autoShowLogin })
  accounts.set(rec.id, acct)
  calls?.setupSession(acct)
  watchAccount(acct)
  acct.on('changed', emitAccounts)
  acct.on('record-updated', () => {
    saveRecords()
    emitAccounts()
  })
  acct.on('snapshot', (s) => broadcast('snapshot', s))
  acct.on('conversation-updated', (ids) => broadcast('conversation-updated', { accountId: rec.id, conversationIds: ids }))
  acct.on('read-receipts', (ids) => broadcast('read-receipts', { accountId: rec.id, conversationIds: ids }))
  acct.on('presence', (p) => broadcast('presence', { accountId: rec.id, presence: p }))
  acct.on('typing', (t) => broadcast('typing', { accountId: rec.id, ...t }))
  acct.on('activity-updated', () => broadcast('activity-updated', { accountId: rec.id }))
  acct.on('notify', (n) => showNotification(n))
  acct.start()
  return acct
}

const liveNotifications = new LiveNotifications<Notification>()
// Letzter Fehler von macOS beim Anzeigen, z. B. wenn Mitteilungen für die App aus sind
let notificationError: string | undefined

function showNotification(n: NotifyPayload): void {
  if (!settings.notifications) return
  const focused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()
  if (focused && focusContext.accountId === n.accountId && focusContext.conversationId === n.conversationId) return
  const acct = accounts.get(n.accountId)
  const multi = accounts.size > 1
  const presence = acct?.record.mri ? acct.presence.get(acct.record.mri) : undefined
  if (presence?.availability === 'DoNotDisturb') return
  const notif = createNotification({
    title: n.title,
    subtitle: multi ? acct?.record.displayName || acct?.record.upn : undefined,
    body: settings.showMessagePreview ? n.body : 'Neue Nachricht',
    silent: !settings.notificationSound
  })
  liveNotifications.add(notif, n)
  notif.on('click', () => {
    liveNotifications.forget(notif)
    analytics.track('notification_clicked', { kind: n.kind }, { active: true })
    showMain()
    const nav: NavigateRequest = {
      accountId: n.accountId,
      view: n.kind === 'channel' ? 'teams' : n.kind === 'activity' ? 'activity' : 'chat',
      conversationId: n.conversationId,
      teamId: n.teamId
    }
    broadcast('navigate', nav)
  })
  notif.on('close', () => liveNotifications.forget(notif))
  notif.show()
  log.info(`Benachrichtigung angezeigt (${n.kind})`)
}

// Legt eine Mitteilung an und merkt sich, ob macOS sie angenommen hat. show() ruft der Aufrufer,
// nachdem er seine eigenen Listener angehängt hat.
function createNotification(opts: Electron.NotificationConstructorOptions): Notification {
  const notif = new Notification(opts)
  notif.on('show', () => {
    notificationError = undefined
  })
  notif.on('failed', (_e, error) => {
    liveNotifications.forget(notif)
    if (notificationError !== error) {
      log.warn(`Benachrichtigung abgelehnt: ${error}`)
      analytics.track('notification_failed', { error })
    }
    notificationError = error
  })
  return notif
}

// Testmitteilung aus den Einstellungen. Löst beim ersten Mal die Rückfrage von macOS aus.
// Die Referenz hält sie in der Mitteilungszentrale, bis die nächste Testmitteilung kommt.
let testNotif: Notification | undefined
function testNotification(): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const notif = createNotification({ title: appName, body: 'So sehen Mitteilungen von neuen Nachrichten aus.', silent: !settings.notificationSound })
    testNotif = notif
    // Ohne Rückmeldung von Electron gilt der Test als nicht bestätigt
    const timer = setTimeout(() => resolve({ ok: false, error: 'keine Rückmeldung von macOS' }), 5000)
    notif.once('show', () => {
      clearTimeout(timer)
      resolve({ ok: true })
    })
    notif.once('failed', (_e, error) => {
      clearTimeout(timer)
      resolve({ ok: false, error })
    })
    notif.show()
  })
}

function showMain(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow()
    mainWindow.on('close', (e) => {
      if (!quitting) {
        e.preventDefault()
        mainWindow?.hide()
      }
    })
  }
  mainWindow.show()
  mainWindow.focus()
}

function get(id: string): AccountService {
  const a = accounts.get(id)
  if (!a) {
    // Die ID nur ins Log, die Meldung geht auch in die Fehlerberichte
    log.warn(`Konto ${id} nicht gefunden`)
    throw new Error('Konto nicht gefunden')
  }
  return a
}

// ---------- IPC-API ----------
type Handler<K extends keyof ApiMethods> = (
  ...args: Parameters<ApiMethods[K]>
) => ReturnType<ApiMethods[K]> | Promise<ReturnType<ApiMethods[K]>>

function createHandlers(sender: () => BrowserWindow | null): { [K in keyof ApiMethods]: Handler<K> } {
  return {
    listAccounts: () => accountList(),
    addAccount: () => {
      const rec: AccountRecord = { id: randomUUID().slice(0, 8), createdAt: Date.now() }
      const acct = addAccountService(rec, true)
      saveRecords()
      acct.engine.showForLogin()
      emitAccounts()
      return rec.id
    },
    removeAccount: async (id) => {
      const a = accounts.get(id)
      if (!a) return
      await a.engine.clearData().catch(() => undefined)
      a.stop()
      accounts.delete(id)
      saveRecords()
      emitAccounts()
    },
    showLogin: (id) => get(id).engine.showForLogin(),
    showEngine: (id) => get(id).engine.showWindow(),
    reloadAccount: (id) => get(id).engine.reload(),
    getDebugInfo: (id): DebugInfo => {
      const a = get(id)
      const endpoints: Record<string, string> = {}
      for (const [f, t] of a.engine.tokens.templates) endpoints[f] = t.base
      return {
        accountId: id,
        endpoints,
        tokens: [...a.engine.tokens.bearers.entries()].map(([aud, t]) => ({ family: aud, audience: aud, expires: t.exp })),
        url: a.engine.currentUrl,
        seen: [...[...a.engine.lastBodies.entries()].map(([k, v]) => ['BODY ' + k + ' ' + v, { at: Date.now(), count: 0, method: '' }] as const), ...a.engine.tokens.seen.entries()].sort((x, y) => y[1].at - x[1].at).slice(0, 200).map(([k, v]) => `${k} (${v.count})`)
      }
    },
    debugRaw: async (id, family, url, method, body) => {
      if (!process.env.TM_DEBUG_PORT) throw new Error('Nur im Entwicklungsmodus')
      const a = get(id)
      return a.api.json(family as Parameters<typeof a.api.json>[0], url.replace(/^(chatsvc|csa|mt):/, (_m, f: string) => a.api.base(f as 'chatsvc')), { method, body })
    },
    getSnapshot: (id) => {
      const a = accounts.get(id)
      return a ? a.snapshot() : null
    },
    refresh: (id) => void get(id).fullSync(),
    getMessages: (id, conv, before) => get(id).getMessages(conv, before),
    getChannelThreads: (id, teamId, channelId) => get(id).getChannelThreads(teamId, channelId),
    getThreadReplies: (id, channelId, rootId) => get(id).getThreadReplies(channelId, rootId),
    sendMessage: (id, conv, html, opts) => get(id).sendMessage(conv, html, opts),
    editMessage: (id, conv, mid, html) => get(id).editMessage(conv, mid, html),
    deleteMessage: (id, conv, mid) => get(id).deleteMessage(conv, mid),
    setReaction: (id, conv, mid, key, on) => get(id).setReaction(conv, mid, key, on),
    markRead: (id, conv, mid) => get(id).markRead(conv, mid),
    getReadHorizons: (id, conv) => get(id).getReadHorizons(conv),
    sendTyping: (id, conv) => get(id).sendTyping(conv),
    searchPeople: (id, q) => get(id).searchPeople(q),
    getPeople: (id, mris) => get(id).getPeople(mris),
    getPresence: (id, mris) => get(id).getPresence(mris),
    setMyPresence: (id, av) => get(id).setMyPresence(av),
    createChat: (id, mris, topic) => get(id).createChat(mris, topic),
    openChatWith: async (id, mri) => {
      const conversationId = await get(id).createChat([mri])
      showMain()
      broadcast('navigate', { accountId: id, view: 'chat', conversationId })
    },
    reorderFolder: (id, folderId, order) => get(id).folderActions([{ action: 'ReorderItems', folderId, newItemsOrder: order }]),
    addToFolder: (id, folderId, itemId, index) => get(id).folderActions([{ action: 'AddItem', folderId, itemId, itemIndex: index ?? 0 }]),
    removeFromFolder: (id, folderId, itemId) => get(id).folderActions([{ action: 'RemoveItem', folderId, itemId }]),
    getCalendar: (id, s, e) => get(id).getCalendar(s, e),
    getActivity: (id) => get(id).getActivity(),
    markActivityRead: (id) => get(id).markActivityRead(),
    getCallHistory: (id) => get(id).getCallHistory(),
    joinMeeting: (id, url) => calls.joinMeeting(get(id), url),
    startCall: (id, target, video) => calls.startCall(get(id), target, video),
    callAction: (action, arg) => calls.action(action, arg),
    getCallState: () => calls.state,
    getIncomingCall: () => calls.incoming,
    answerIncoming: (call, mode) => calls.answer(call, mode),
    openCallWindow: () => calls.openCallWindow(),
    openCallChat: () =>
      calls.openCallChat((accountId, conversationId) => {
        showMain()
        broadcast('navigate', { accountId, view: 'chat', conversationId })
      }),
    popoutStream: (streamId, label) => calls.popout(streamId, label),
    setCallCompact: (on) => calls.setCompact(on),
    showCallInTeams: () => calls.showInTeams(),
    pickDisplaySource: (sid) => calls.pickDisplaySource(sid),
    getBackgrounds: () => calls.getBackgrounds(),
    setBackground: (bid) => calls.setBackground(bid),
    addBackground: () => calls.addBackground(sender()),
    closeBackgrounds: () => calls.closeBackgrounds(),
    getCallDevices: () => calls.getDevices(),
    setCallDevice: (kind, did) => calls.setDevice(kind, did),
    getSettings: () => settings,
    setSettings: (patch) => {
      const prev = settings
      settings = { ...settings, ...patch }
      store.saveSettings(settings)
      for (const c of settingsChanges(prev, settings)) analytics.track(c.event, c.props, { active: true })
      if (patch.activeAccountId && patch.activeAccountId !== prev.activeAccountId && accounts.size > 1) {
        analytics.track('account_switched', {}, { active: true })
      }
      if (patch.theme) nativeTheme.themeSource = settings.theme
      broadcast('settings', settings)
      pushPrefs()
      return settings
    },
    openExternal: (url) => {
      if (/^(https?|mailto|tel):/.test(url)) void shell.openExternal(url)
    },
    imageAction: (src, action, x, y) => {
      const win = sender()
      if (win) return imageAction(win, src, action, x, y)
    },
    setBadge: (n) => {
      app.setBadgeCount(n)
    },
    getNotificationStatus: () => ({ supported: Notification.isSupported(), error: notificationError }),
    testNotification: () => testNotification(),
    openNotificationSettings: () => {
      // Öffnet Systemeinstellungen › Mitteilungen direkt beim Eintrag der App
      // Dev läuft mit eigener Bundle-ID, siehe scripts/dev-app.mjs und .github/workflows/pr-build.yml
      const id = variant === 'dev' ? `${BUNDLE_ID}.dev` : BUNDLE_ID
      void shell.openExternal(`x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${id}`)
    },
    closeWindow: () => sender()?.close(),
    setAlwaysOnTop: (on) => {
      sender()?.setAlwaysOnTop(on, 'floating')
    },
    getUpdateState: () => updater.state,
    checkForUpdates: () => updater.check(),
    downloadUpdate: () => void updater.download(),
    installUpdate: () => updater.install(),
    getMcpInfo: () => mcp.info(),
    setMcpEnabled: (on) => mcp.setEnabled(on),
    resetMcpToken: () => mcp.resetToken(),
    installMcp: (client) => {
      const info = mcp.info()
      if (!info.url) return { ok: false, message: 'Der MCP-Server ist aus.' }
      return installMcp(client, info.name, info.url)
    },
    getAnalyticsInfo: () => ({ available: analytics.available, installId: analytics.installId }),
    sendFeedback: (kind, message) => analytics.sendFeedback(kind, message)
  }
}

// Lokaler MCP-Server: Claude Code, Codex & Co. lesen darüber Chats, Dateien, Anrufe und Kalender aller Konten.
// Stable und Nightly teilen sich Daten und Port, Dev hat beides getrennt und läuft daneben.
function startMcp(): void {
  // Nutzungsdaten: nur welches Werkzeug, nie Argumente oder Ergebnisse, je Werkzeug höchstens alle 10 Minuten
  const tools = createTools({
    accounts: () => [...accounts.values()].map(mcpAccount),
    saveFile: (name, data) => saveMcpFile(name, data)
  }).map((t) => ({
    ...t,
    run: (args: Record<string, unknown>) => {
      analytics.track('mcp_tool_called', { tool: t.name }, { throttle: { key: `mcp-${t.name}`, ms: 10 * 60_000 } })
      return t.run(args)
    }
  }))
  const protocol = new McpProtocol(
    { name: variant === 'dev' ? 'teams-everywhere-dev' : 'teams-everywhere', title: appName, version: app.getVersion(), instructions: SERVER_INSTRUCTIONS },
    tools,
    (tool, err) => {
      log.warn(`[mcp] ${tool} fehlgeschlagen`, err.message)
      // Meldungen aus Werkzeugen können Dateinamen oder Inhalte tragen. In die Fehlerberichte gehen
      // nur Werkzeug, Fehlerart, ein Code wie ENOENT und die Stackframes, nie die Meldung.
      const code = (err as NodeJS.ErrnoException).code
      const safe = new Error(`MCP-Werkzeug ${tool} fehlgeschlagen${typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? ` (${code})` : ''}`)
      safe.name = err.name
      const frames = (err.stack ?? '').split('\n').filter((l) => /^\s+at /.test(l))
      safe.stack = [`${safe.name}: ${safe.message}`, ...frames].join('\n')
      analytics.captureError(safe, { source: 'mcp', handled: true, props: { tool } })
    }
  )
  mcp = new McpServer({
    file: join(app.getPath('userData'), 'mcp.json'),
    defaultPort: variant === 'dev' ? 47312 : 47311,
    name: variant === 'dev' ? 'teams-everywhere-dev' : 'teams-everywhere',
    protocol,
    onChange: (info) => broadcast('mcp', info),
    log: (level, msg) => log[level](msg)
  })
  void mcp.start()
}

function pushPrefs(): void {
  for (const a of accounts.values()) {
    a.engine.send('engine:cmd', { ch: 'prefs', prefs: { camera: settings.preferredCamera, mic: settings.preferredMic, speaker: settings.preferredSpeaker } })
  }
}

const usage = usageContext(() => accounts)
const isUiContents = (wc: Electron.WebContents) => [...uiWindows].some((w) => !w.isDestroyed() && w.webContents === wc)

function setupIpc(): void {
  setupUiAnalytics(isUiContents)
  ipcMain.handle('api', async (e, name: keyof ApiMethods, ...args: unknown[]) => {
    const handlers = createHandlers(() => BrowserWindow.fromWebContents(e.sender))
    const fn = handlers[name] as (...a: unknown[]) => unknown
    if (!fn) throw new Error(`Unbekannte Methode ${name}`)
    const started = Date.now()
    try {
      const result = await fn(...args)
      trackApiCall(name, args, result, Date.now() - started, usage)
      return result
    } catch (err) {
      log.warn(`api ${name} failed`, (err as Error).message)
      trackApiFailure(name, err)
      throw err
    }
  })
  ipcMain.on('focus-context', (_e, ctx: { accountId?: string; conversationId?: string }) => {
    focusContext = ctx
  })
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: appName,
      submenu: [
        { role: 'about', label: `Über ${appName}` },
        {
          label: 'Nach Updates suchen …',
          click: () => {
            showMain()
            broadcast('navigate', { accountId: settings.activeAccountId ?? '', view: 'settings' })
            void updater.check()
          }
        },
        { type: 'separator' },
        {
          label: 'Einstellungen …',
          accelerator: 'Cmd+,',
          click: () => {
            showMain()
            broadcast('navigate', { accountId: settings.activeAccountId ?? '', view: 'settings' })
          }
        },
        { type: 'separator' },
        { role: 'hide', label: `${appName} ausblenden` },
        { role: 'hideOthers', label: 'Andere ausblenden' },
        { role: 'unhide', label: 'Alle einblenden' },
        { type: 'separator' },
        { role: 'quit', label: `${appName} beenden` }
      ]
    },
    {
      label: 'Bearbeiten',
      submenu: [
        { role: 'undo', label: 'Widerrufen' },
        { role: 'redo', label: 'Wiederholen' },
        { type: 'separator' },
        { role: 'cut', label: 'Ausschneiden' },
        { role: 'copy', label: 'Kopieren' },
        { role: 'paste', label: 'Einsetzen' },
        { role: 'selectAll', label: 'Alles auswählen' }
      ]
    },
    {
      label: 'Darstellung',
      submenu: [
        { role: 'reload', label: 'Neu laden' },
        { role: 'toggleDevTools', label: 'Entwicklerwerkzeuge' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Originalgröße' },
        { role: 'zoomIn', label: 'Vergrößern' },
        { role: 'zoomOut', label: 'Verkleinern' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Vollbild' }
      ]
    },
    {
      label: 'Fenster',
      submenu: [
        { role: 'minimize', label: 'Im Dock ablegen' },
        { role: 'zoom', label: 'Zoomen' },
        { label: appName, accelerator: 'Cmd+0', click: () => showMain() },
        { type: 'separator' },
        { role: 'front', label: 'Alle nach vorne bringen' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.on('second-instance', () => showMain())
app.on('activate', () => showMain())
app.on('browser-window-focus', (_e, win) => trackFocus(win, isUiContents))
// Bei SIGTERM sauber beenden, damit Cookies und Speicher geschrieben werden
process.on('SIGTERM', () => app.quit())
process.on('SIGINT', () => app.quit())

app.on('before-quit', () => {
  // Nach dem Senden der Nutzungsdaten ruft will-quit app.quit() ein zweites Mal
  if (quitting) return
  quitting = true
  for (const a of accounts.values()) void a.engine.ses.cookies.flushStore().catch(() => undefined)
  for (const a of accounts.values()) a.stop()
  void mcp?.stop()
})
// Wartende Nutzungsdaten noch senden, höchstens zwei Sekunden lang. Ohne PostHog-Client
// (kein Schlüssel) beendet sich die App wie bisher in einem Durchgang.
let analyticsDrain: 'idle' | 'running' | 'done' = 'idle'
app.on('will-quit', (e) => {
  if (analyticsDrain === 'done' || (analyticsDrain === 'idle' && !analytics.needsDrain)) return
  e.preventDefault()
  if (analyticsDrain === 'running') return
  analyticsDrain = 'running'
  // Ist nichts mehr zu senden, löst shutdown() noch während dieses Ereignisses auf. Ein app.quit()
  // an dieser Stelle ignoriert Electron, weil es das Beenden gerade erst abbricht. Deshalb erst
  // in der nächsten Runde der Ereignisschleife.
  void analytics.shutdown().finally(() => {
    analyticsDrain = 'done'
    setImmediate(() => app.quit())
  })
})
app.on('window-all-closed', () => {
  /* App bleibt aktiv wie Teams */
})

void app.whenReady().then(() => {
  if (migration === 'legacy-running') {
    dialog.showMessageBoxSync({
      type: 'warning',
      message: 'Bitte beende zuerst „Teams Mac“',
      detail: 'Teams Everywhere übernimmt beim ersten Start die Konten und Anmeldungen aus „Teams Mac“. Das geht nur, solange die alte App nicht läuft. Beende „Teams Mac“ und starte Teams Everywhere dann erneut.'
    })
    app.quit()
    return
  }
  app.setAboutPanelOptions({ applicationName: appName, applicationVersion: app.getVersion() })
  // Dev läuft als Electron.app aus node_modules und hätte sonst deren Icon. Das Dev-Icon
  // zeigen Dock, App-Umschalter und Über-Fenster. Erzeugt von `pnpm run icons`.
  // PR-Builds bringen das Dev-Icon im Bundle mit.
  if (variant === 'dev' && !app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), 'build/icon-dev.png'))
  settings = store.loadSettings()
  nativeTheme.themeSource = settings.theme
  const launch = analytics.init({ variant, dynamic: () => ({ account_count: accounts.size }) })
  setupCrashReporting(isUiContents)
  let lastUpdate: UpdateState | undefined
  updater = new Updater(
    (state) => {
      if (lastUpdate) for (const ev of updateEvents(lastUpdate, state)) analytics.track(ev.event, ev.props)
      lastUpdate = state
      broadcast('update-state', state)
    },
    () => app.quit()
  )
  lastUpdate = updater.state
  buildMenu()
  setupIpc()
  calls = new CallManager(() => [...accounts.values()], broadcast, () => quitting)
  handleMediaProtocol((id) => accounts.get(id))

  const records = store.loadAccounts()
  for (const r of records) {
    const isActive = r.id === settings.activeAccountId || records.length === 1
    addAccountService(r, isActive)
  }
  startMcp()
  showMain()

  if (launch.updatedFrom) analytics.track('app_updated', { from_version: launch.updatedFrom })
  analytics.track(
    'app_started',
    { launch_ms: Math.round(process.uptime() * 1000), first_launch: launch.firstLaunch, updated_from: launch.updatedFrom, notifications: settings.notifications },
    {
      active: true,
      set: { app_version: app.getVersion(), app_channel: variant, os_version: process.getSystemVersion(), arch: process.arch, account_count: accounts.size },
      setOnce: { first_version: app.getVersion() }
    }
  )

  // Aktivität an die Web-Apps weitergeben, damit die Präsenz nicht auf "Abwesend" fällt.
  setInterval(() => {
    const idle = powerMonitor.getSystemIdleTime()
    if (idle < 120) for (const a of accounts.values()) a.engine.send('engine:cmd', { ch: 'action', action: 'activity' })
  }, 30_000)
  setTimeout(pushPrefs, 5000)
  updater.start()
})

export { accounts, calls }
