// Mitteilungen zeigen das App-Icon, das Notification Center beim ersten Bedarf geladen hat.
// Finder und Dock laden es nach einem Update neu (siehe INSTALL_SCRIPT in updater.ts),
// Notification Center aber erst, wenn der Prozess neu startet, also meist beim nächsten Anmelden.
// Ändert sich das Icon im Bundle, startet die App Notification Center deshalb einmal neu.
// launchd startet den Prozess sofort wieder. Offene Banner verschwinden dabei, die Einträge
// in der Mitteilungszentrale bleiben.
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from './log'

const MARKER = 'notification-icon.txt'

export function refreshNotificationIcon(): void {
  if (process.platform !== 'darwin' || !app.isPackaged) return
  let hash: string
  try {
    // electron-builder legt mac.icon immer als icon.icns ins Bundle
    hash = createHash('sha256').update(readFileSync(join(process.resourcesPath, 'icon.icns'))).digest('hex')
  } catch {
    return
  }
  const marker = join(app.getPath('userData'), MARKER)
  let seen = ''
  try {
    seen = readFileSync(marker, 'utf8').trim()
  } catch {
    // Erster Start mit dieser Prüfung. Notification Center kann noch ein altes Icon haben.
  }
  if (seen === hash) return
  execFile('/usr/bin/killall', ['NotificationCenter'], (err) => {
    if (err) log.warn(`Notification Center ließ sich nicht neu starten: ${err.message}`)
    else log.info('App-Icon geändert, Notification Center neu gestartet')
    try {
      writeFileSync(marker, hash)
    } catch (e) {
      log.warn(`Icon-Stand für Mitteilungen nicht gespeichert: ${String(e)}`)
    }
  })
}
