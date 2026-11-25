import { app } from 'electron'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Dateien, die read_file lädt, landen im Temp-Ordner des Systems, je Abruf in einem eigenen Unterordner.
// So kann der Agent sie mit seinen eigenen Werkzeugen lesen (PDF, Office, Bilder).
export async function saveMcpFile(name: string, data: Uint8Array): Promise<string> {
  const safe = name.replace(/[^\p{L}\p{N} ._()-]/gu, '_').replace(/^\.+/, '').slice(0, 150) || 'datei'
  const base = join(app.getPath('temp'), 'Teams Everywhere MCP')
  await mkdir(base, { recursive: true, mode: 0o700 })
  // Eigener Ordner je Abruf, nur für den Nutzer lesbar
  const dir = await mkdtemp(join(base, 'datei-'))
  const path = join(dir, safe)
  await writeFile(path, data, { mode: 0o600 })
  return path
}
