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
import { channelOf } from './update/releases'
import { appVariant, dataName, displayName } from './variant'
import { dockBadge } from '@shared/badge'
import type { ApiMethods } from '@shared/ipc'
import type { AppSettings, DebugInfo, NavigateRequest } from '@shared/types'

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
const variant = appVariant(app.isPackaged, channelOf(app.getVersion()))
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
let quitting = false
let focusContext: { accountId?: string; conversationId?: string } = {}

function broadcast(event: string, payload: unknown): void {
  for (const w of uiWindows) if (!w.isDestroyed()) w.webContents.send('event', event, payload)
}

function accountList() {
  return [...accounts.values()].map((a) => a.info())
}

let accountsTimer: NodeJS.Timeout | undefined
function emitAccounts(): void {
  clearTimeout(accountsTimer)
  accountsTimer = setTimeout(() => {
    const list = accountList()
    broadcast('accounts', list)
    app.setBadgeCount(dockBadge(list))
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
  const notif = postNotification({
    title: n.title,
    subtitle: multi ? acct?.record.displayName || acct?.record.upn : undefined,
    body: settings.showMessagePreview ? n.body : 'Neue Nachricht',
    silent: !settings.notificationSound
  })
  liveNotifications.add(notif, n)
  notif.on('click', () => {
    liveNotifications.forget(notif)
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
  log.info(`Benachrichtigung angezeigt (${n.kind})`)
}

// Zeigt eine Mitteilung und merkt sich, ob macOS sie angenommen hat
function postNotification(opts: Electron.NotificationConstructorOptions): Notification {
  const notif = new Notification(opts)
  notif.on('show', () => {
    notificationError = undefined
  })
  notif.on('failed', (_e, error) => {
    liveNotifications.forget(notif)
    if (notificationError !== error) log.warn(`Benachrichtigung abgelehnt: ${error}`)
    notificationError = error
  })
  notif.show()
  return notif
}

// Testmitteilung aus den Einstellungen. Löst beim ersten Mal die Rückfrage von macOS aus.
// Die Referenz hält sie in der Mitteilungszentrale, bis die nächste Testmitteilung kommt.
let testNotif: Notification | undefined
function testNotification(): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const notif = postNotification({ title: appName, body: 'So sehen Mitteilungen von neuen Nachrichten aus.', silent: !settings.notificationSound })
    testNotif = notif
    const timer = setTimeout(() => resolve({ ok: !notificationError, error: notificationError }), 5000)
    notif.once('show', () => {
      clearTimeout(timer)
      resolve({ ok: true })
    })
    notif.once('failed', (_e, error) => {
      clearTimeout(timer)
      resolve({ ok: false, error })
    })
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
  if (!a) throw new Error(`Konto ${id} nicht gefunden`)
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
      settings = { ...settings, ...patch }
      store.saveSettings(settings)
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
      // Öffnet Systemeinstellungen › Mitteilungen, bei der installierten App direkt deren Eintrag
      const id = app.isPackaged ? `?id=${BUNDLE_ID}` : ''
      void shell.openExternal(`x-apple.systempreferences:com.apple.Notifications-Settings.extension${id}`)
    },
    closeWindow: () => sender()?.close(),
    setAlwaysOnTop: (on) => {
      sender()?.setAlwaysOnTop(on, 'floating')
    },
    getUpdateState: () => updater.state,
    checkForUpdates: () => updater.check(),
    downloadUpdate: () => void updater.download(),
    installUpdate: () => updater.install()
  }
}

function pushPrefs(): void {
  for (const a of accounts.values()) {
    a.engine.send('engine:cmd', { ch: 'prefs', prefs: { camera: settings.preferredCamera, mic: settings.preferredMic, speaker: settings.preferredSpeaker } })
  }
}

function setupIpc(): void {
  ipcMain.handle('api', async (e, name: keyof ApiMethods, ...args: unknown[]) => {
    const handlers = createHandlers(() => BrowserWindow.fromWebContents(e.sender))
    const fn = handlers[name] as (...a: unknown[]) => unknown
    if (!fn) throw new Error(`Unbekannte Methode ${name}`)
    try {
      return await fn(...args)
    } catch (err) {
      log.warn(`api ${name} failed`, (err as Error).message)
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
// Bei SIGTERM sauber beenden, damit Cookies und Speicher geschrieben werden
process.on('SIGTERM', () => app.quit())
process.on('SIGINT', () => app.quit())

app.on('before-quit', () => {
  quitting = true
  for (const a of accounts.values()) void a.engine.ses.cookies.flushStore().catch(() => undefined)
  for (const a of accounts.values()) a.stop()
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
  if (variant === 'dev') app.dock?.setIcon(join(app.getAppPath(), 'build/icon-dev.png'))
  settings = store.loadSettings()
  nativeTheme.themeSource = settings.theme
  updater = new Updater(
    (state) => broadcast('update-state', state),
    () => app.quit()
  )
  buildMenu()
  setupIpc()
  calls = new CallManager(() => [...accounts.values()], broadcast, () => quitting)
  handleMediaProtocol((id) => accounts.get(id))

  const records = store.loadAccounts()
  for (const r of records) {
    const isActive = r.id === settings.activeAccountId || records.length === 1
    addAccountService(r, isActive)
  }
  showMain()

  // Aktivität an die Web-Apps weitergeben, damit die Präsenz nicht auf "Abwesend" fällt.
  setInterval(() => {
    const idle = powerMonitor.getSystemIdleTime()
    if (idle < 120) for (const a of accounts.values()) a.engine.send('engine:cmd', { ch: 'action', action: 'activity' })
  }, 30_000)
  setTimeout(pushPrefs, 5000)
  updater.start()
})

export { accounts, calls }
