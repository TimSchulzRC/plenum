// Übernahme von Datenordner und App-Bundle aus der Zeit vor der Umbenennung in Plenum
// (vorher „Teams Everywhere“, davor „Teams Mac“).
// Ohne Electron-Abhängigkeiten, damit `pnpm test` die Logik prüfen kann.
import { existsSync, readlinkSync, renameSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export type LegacyMigration = 'none' | 'migrated' | 'legacy-running' | 'failed'

// Chromium legt im Datenordner den Symlink SingletonLock -> "<Rechnername>-<PID>" an.
export function legacyAppRunning(dir: string): boolean {
  let target: string
  try {
    target = readlinkSync(join(dir, 'SingletonLock'))
  } catch {
    return false
  }
  const pid = Number(target.slice(target.lastIndexOf('-') + 1))
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: Der Prozess existiert, gehört aber einem anderen Nutzer.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Verschiebt den alten Ordner einmalig an den neuen Ort. Läuft die alte App noch,
// bleibt alles, wie es ist, sonst würde ihr der Ordner unter den Füßen weggezogen.
export function migrateLegacyUserData(legacyDir: string, targetDir: string): LegacyMigration {
  if (existsSync(targetDir) || !existsSync(legacyDir)) return 'none'
  if (legacyAppRunning(legacyDir)) return 'legacy-running'
  try {
    renameSync(legacyDir, targetDir)
    return 'migrated'
  } catch {
    return 'failed'
  }
}

// Das erste Update auf Plenum installiert noch der Updater von Teams Everywhere. Er legt die
// neue Version unter den alten Pfad, etwa /Applications/Teams Everywhere.app. Liefert für so ein
// Bundle den Pfad mit dem neuen Namen, falls dort noch nichts liegt. Andere Namen, etwa von Hand
// umbenannte Apps, bleiben, wie sie sind.
const LEGACY_BUNDLES = ['Teams Everywhere.app', 'Teams Everywhere (nightly).app']

export function renamedBundlePath(bundle: string, name: string): string | null {
  if (!LEGACY_BUNDLES.includes(basename(bundle))) return null
  const target = join(dirname(bundle), `${name}.app`)
  return existsSync(target) ? null : target
}
