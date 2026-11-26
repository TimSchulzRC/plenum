import { app, BrowserWindow, dialog, shell } from 'electron'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

function safeName(name: string): string {
  return name.replace(/[^\p{L}\p{N} ._()-]/gu, '_').replace(/^\.+/, '').slice(0, 150) || 'anhang'
}

// Anhang öffnen: in einen eigenen Temp-Ordner schreiben (nur für den Nutzer lesbar) und mit der
// Standard-App öffnen. Speichern: Dialog, Vorschlag im Download-Ordner.
export async function deliverAttachment(win: BrowserWindow | null, name: string, data: Uint8Array, mode: 'open' | 'save'): Promise<void> {
  if (mode === 'save') {
    const opts = { defaultPath: join(app.getPath('downloads'), safeName(name)) }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return
    await writeFile(res.filePath, data)
    return
  }
  const base = join(app.getPath('temp'), 'Teams Everywhere Mail')
  await mkdir(base, { recursive: true, mode: 0o700 })
  const dir = await mkdtemp(join(base, 'anhang-'))
  const path = join(dir, safeName(name))
  await writeFile(path, data, { mode: 0o600 })
  const err = await shell.openPath(path)
  if (err) throw new Error(err)
}
