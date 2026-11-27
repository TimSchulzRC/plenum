// Läuft vor `pnpm run dev` und `pnpm start`. Im Dev-Modus läuft die App als Electron.app aus
// node_modules. Name, Bundle-ID und Icon nimmt macOS aus deren Info.plist und Resources,
// app.setName und app.dock.setIcon ändern daran nichts. Das Skript macht daraus
// „Plenum (dev)“ mit eigener Bundle-ID und dem Dev-Icon:
// - Dock, Finder und Mitteilungen zeigen das Dev-Icon, schon bevor die App läuft.
// - macOS fragt die Mitteilungen für Dev getrennt von der installierten App ab.
// Danach signiert es das Bundle ad hoc neu. Ohne gültige Signatur lehnt macOS die
// Mitteilungen ab (UNErrorDomain error 1). Die Hilfsprozesse findet Electron weiter über
// „Electron Helper.app“.
import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'Plenum (dev)'
const BUNDLE_ID = 'io.github.timschulzrc.teamseverywhere.dev'
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

if (process.platform === 'darwin') {
  // Das npm-Paket electron exportiert den Pfad zur Binary in Electron.app/Contents/MacOS.
  const binary = createRequire(import.meta.url)('electron')
  const contents = join(binary, '..', '..')
  const bundle = join(contents, '..')
  const plist = join(contents, 'Info.plist')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')

  const read = (key) => {
    try {
      return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', plist], { encoding: 'utf8' }).trim()
    } catch {
      return undefined
    }
  }
  let changed = false
  for (const [key, value] of [['CFBundleName', NAME], ['CFBundleDisplayName', NAME], ['CFBundleIdentifier', BUNDLE_ID]]) {
    if (read(key) === value) continue
    execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, plist])
    changed = true
  }
  const icon = join(contents, 'Resources', read('CFBundleIconFile') || 'electron.icns')
  const devIcon = join(root, 'build/icon-dev.icns')
  if (!readFileSync(icon).equals(readFileSync(devIcon))) {
    copyFileSync(devIcon, icon)
    changed = true
  }
  let signed = true
  try {
    execFileSync('/usr/bin/codesign', ['--verify', bundle], { stdio: 'ignore' })
  } catch {
    signed = false
  }
  if (changed || !signed) {
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'ignore' })
    // Dock und Finder sollen das neue Icon sofort zeigen, nicht das zwischengespeicherte
    execFileSync(LSREGISTER, ['-f', bundle], { stdio: 'ignore' })
    console.log(`${NAME}: Bundle angepasst und ad hoc signiert`)
  }
}
