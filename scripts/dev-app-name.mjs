// Läuft vor `pnpm run dev` und `pnpm start`. Im Dev-Modus läuft die App als Electron.app
// aus node_modules. Den Namen in der Menüleiste nimmt macOS aus deren Info.plist,
// app.setName ändert ihn nicht. Das Skript trägt dort
// „Teams Everywhere (dev)“ ein, damit Dev und installierte App nicht gleich aussehen.
// Die Hilfsprozesse findet Electron weiter über „Electron Helper.app“.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const NAME = 'Teams Everywhere (dev)'

if (process.platform === 'darwin') {
  // Das npm-Paket electron exportiert den Pfad zur Binary in Electron.app/Contents/MacOS.
  const binary = createRequire(import.meta.url)('electron')
  const plist = join(binary, '..', '..', 'Info.plist')
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    execFileSync('/usr/bin/plutil', ['-replace', key, '-string', NAME, plist])
  }
}
