// Übernahme des Datenordners aus der Zeit, als die App „Teams Mac“ hieß.
// Ohne Electron-Abhängigkeiten, damit `pnpm test` die Logik prüfen kann.
import { existsSync, readlinkSync, renameSync } from 'node:fs'
import { join } from 'node:path'

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
