import { app, BrowserWindow, dialog, shell } from 'electron'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

export type AttachmentFile = { name: string; data: Uint8Array }

function safeName(name: string): string {
  return name.replace(/[^\p{L}\p{N} ._()-]/gu, '_').replace(/^\.+/, '').slice(0, 150) || 'anhang'
}

// Pfade, die die App selbst gespeichert hat. Nur diese darf der Renderer im Dateimanager zeigen.
const saved = new Set<string>()

// Schreibt die Datei, ohne etwas zu überschreiben: gibt es „Bericht.pdf“ schon, wird es
// „Bericht (1).pdf“, wie beim Browser-Download.
async function writeNew(dir: string, name: string, data: Uint8Array): Promise<string> {
  const file = safeName(name)
  const ext = extname(file)
  const stem = file.slice(0, file.length - ext.length)
  for (let i = 0; ; i++) {
    const path = join(dir, i === 0 ? file : `${stem} (${i})${ext}`)
    try {
      await writeFile(path, data, { flag: 'wx' })
      saved.add(path)
      return path
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i >= 999) throw e
    }
  }
}

// Anhang öffnen: in einen eigenen Temp-Ordner schreiben (nur für den Nutzer lesbar) und mit der
// Standard-App öffnen. Herunterladen: direkt in den Download-Ordner. Speichern unter: Dialog.
// Gibt den gespeicherten Pfad zurück (null bei Öffnen oder Abbruch).
export async function deliverAttachment(win: BrowserWindow | null, file: AttachmentFile, mode: 'open' | 'download' | 'saveAs'): Promise<string | null> {
  if (mode === 'download') return writeNew(app.getPath('downloads'), file.name, file.data)
  if (mode === 'saveAs') {
    const opts = { defaultPath: join(app.getPath('downloads'), safeName(file.name)) }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return null
    await writeFile(res.filePath, file.data)
    saved.add(res.filePath)
    return res.filePath
  }
  const base = join(app.getPath('temp'), 'Plenum Mail')
  await mkdir(base, { recursive: true, mode: 0o700 })
  const dir = await mkdtemp(join(base, 'anhang-'))
  const path = join(dir, safeName(file.name))
  await writeFile(path, file.data, { mode: 0o600 })
  const err = await shell.openPath(path)
  if (err) throw new Error(err)
  return null
}

// Ordner für „Alle speichern unter …“ wählen, Vorschlag ist der Download-Ordner.
export async function chooseFolder(win: BrowserWindow | null): Promise<string | null> {
  const opts = {
    title: 'Anhänge speichern in',
    buttonLabel: 'Hier speichern',
    defaultPath: app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
  }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
}

// Mehrere Anhänge in einen Ordner schreiben, ohne vorhandene Dateien zu überschreiben.
export async function saveAttachmentsTo(dir: string, files: AttachmentFile[]): Promise<string[]> {
  const paths: string[] = []
  for (const f of files) paths.push(await writeNew(dir, f.name, f.data))
  return paths
}

export function downloadsDir(): string {
  return app.getPath('downloads')
}

export function showSavedFile(path: string): void {
  if (saved.has(path)) shell.showItemInFolder(path)
}
