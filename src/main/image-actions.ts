import { app, BrowserWindow, clipboard, ClipboardItem, dialog, Menu, nativeImage, net } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MEDIA_SCHEME } from './media-protocol'
import { imageFileName, parseDataUrl } from './image-file'
import { log } from './log'

// Bilder kommen als tmimg://proxy (über den Hauptprozess mit Tokens geladen), als data:-URL
// (eigene Nachricht, die noch gesendet wird) oder von öffentlichen Hosts wie Giphy.
async function load(src: string): Promise<{ type: string; data: Buffer }> {
  const inline = parseDataUrl(src)
  if (inline) return inline
  if (!src.startsWith(`${MEDIA_SCHEME}://`) && !src.startsWith('https://')) throw new Error('Unbekannte Bildquelle')
  const res = await net.fetch(src)
  if (!res.ok) throw new Error(`Bild nicht abrufbar (${res.status})`)
  return { type: res.headers.get('content-type') ?? 'image/png', data: Buffer.from(await res.arrayBuffer()) }
}

async function copy(win: BrowserWindow, src: string, x: number, y: number): Promise<void> {
  const { data } = await load(src)
  const img = nativeImage.createFromBuffer(data)
  if (!img.isEmpty()) {
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(img.toPNG())], { type: 'image/png' }) })])
    return
  }
  // GIF und WebP kann nativeImage nicht lesen. Chromium hat das Bild aber schon dekodiert.
  const zoom = win.webContents.getZoomFactor()
  win.webContents.copyImageAt(Math.round(x * zoom), Math.round(y * zoom))
}

async function save(win: BrowserWindow, src: string): Promise<void> {
  const { type, data } = await load(src)
  const res = await dialog.showSaveDialog(win, { defaultPath: join(app.getPath('downloads'), imageFileName(type)) })
  if (res.canceled || !res.filePath) return
  await writeFile(res.filePath, data)
}

function report(win: BrowserWindow, what: string, e: unknown): void {
  log.warn(`image ${what} failed`, (e as Error).message)
  void dialog.showMessageBox(win, { type: 'warning', message: `Das Bild konnte nicht ${what} werden.`, detail: (e as Error).message })
}

export async function imageAction(win: BrowserWindow, src: string, action: 'menu' | 'copy' | 'save', x: number, y: number): Promise<void> {
  const run = (a: 'copy' | 'save') =>
    (a === 'copy' ? copy(win, src, x, y) : save(win, src)).catch((e) => report(win, a === 'copy' ? 'kopiert' : 'gespeichert', e))
  if (action !== 'menu') return run(action)
  Menu.buildFromTemplate([
    { label: 'Bild herunterladen …', click: () => void run('save') },
    { label: 'Bild kopieren', click: () => void run('copy') }
  ]).popup({ window: win })
}
