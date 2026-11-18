import { BrowserWindow, nativeTheme, screen, shell } from 'electron'
import { join } from 'node:path'

export const uiWindows = new Set<BrowserWindow>()

function loadRoute(win: BrowserWindow, route: string): void {
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (dev) void win.loadURL(`${dev}#${route}`)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: route })
}

function bg(): string {
  return nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#f5f5f5'
}

export function createUiWindow(route: string, opts: Electron.BrowserWindowConstructorOptions = {}): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    backgroundColor: bg(),
    ...opts,
    webPreferences: {
      preload: join(__dirname, '../preload/ui.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: true,
      ...(opts.webPreferences ?? {})
    }
  })
  uiWindows.add(win)
  win.on('closed', () => uiWindows.delete(win))
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const dev = process.env['ELECTRON_RENDERER_URL']
    if ((dev && url.startsWith(dev)) || url.startsWith('file:')) return
    e.preventDefault()
    if (/^https?:/.test(url)) void shell.openExternal(url)
  })
  win.once('ready-to-show', () => {
    if (opts.show !== false) win.show()
  })
  loadRoute(win, route)
  return win
}

export function createMainWindow(): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  return createUiWindow('/main', {
    width: Math.min(1440, Math.round(width * 0.85)),
    height: Math.min(940, Math.round(height * 0.88)),
    minWidth: 860,
    minHeight: 560,
    title: 'Microsoft Teams',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    // Leiste und Titelzeile durchscheinend wie in macOS-Apps
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000'
  })
}

export function createCallWindow(): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  return createUiWindow('/call', {
    width: Math.min(1280, Math.round(width * 0.75)),
    height: Math.min(820, Math.round(height * 0.8)),
    minWidth: 320,
    minHeight: 200,
    title: 'Besprechung',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 18 },
    backgroundColor: '#141414'
  })
}

export function createPopoutWindow(streamId: string, label: string): BrowserWindow {
  return createUiWindow(`/popout?stream=${encodeURIComponent(streamId)}&label=${encodeURIComponent(label)}`, {
    width: 640,
    height: 400,
    minWidth: 200,
    minHeight: 120,
    title: label,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#000000'
  })
}

export function createIncomingWindow(): BrowserWindow {
  const area = screen.getPrimaryDisplay().workArea
  const w = 380
  const h = 176
  return createUiWindow('/incoming', {
    width: w,
    height: h,
    x: area.x + area.width - w - 16,
    y: area.y + 16,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    hasShadow: true,
    transparent: true,
    backgroundColor: '#00000000',
    title: 'Eingehender Anruf'
  })
}
