import { desktopCapturer, shell, systemPreferences } from 'electron'
import type { MediaPermission, PermissionState, PermissionsInfo } from '../shared/types'
import { log } from './log'

const KINDS: MediaPermission[] = ['microphone', 'camera', 'screen']

// Bereiche unter Systemeinstellungen › Datenschutz & Sicherheit
const PANES: Record<MediaPermission, string> = {
  microphone: 'Privacy_Microphone',
  camera: 'Privacy_Camera',
  screen: 'Privacy_ScreenCapture'
}

function status(kind: MediaPermission): PermissionState {
  if (process.platform !== 'darwin') return 'unsupported'
  const s = systemPreferences.getMediaAccessStatus(kind)
  return s === 'unknown' ? 'unsupported' : s
}

export function permissions(): PermissionsInfo {
  return Object.fromEntries(KINDS.map((k) => [k, status(k)])) as PermissionsInfo
}

// Fragt vorab, damit macOS nicht erst im ersten Anruf nachfragt. macOS fragt je Freigabe nur einmal,
// danach geht es nur noch über die Systemeinstellungen.
export async function requestPermission(kind: MediaPermission): Promise<PermissionsInfo> {
  if (process.platform === 'darwin') {
    if (kind === 'screen') {
      // Für die Bildschirmaufnahme gibt es keine Rückfrage-API. Quellen zu lesen fragt beim ersten Mal
      // nach und trägt die App in die Liste der Systemeinstellungen ein.
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }).catch((e: unknown) => {
        log.warn('desktopCapturer.getSources failed', e instanceof Error ? e.message : String(e))
      })
    } else {
      await systemPreferences.askForMediaAccess(kind)
    }
  }
  const result = permissions()
  log.info(`permission ${kind} requested: ${result[kind]}`)
  return result
}

export function openPermissionSettings(kind: MediaPermission): void {
  if (process.platform === 'darwin') void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PANES[kind]}`)
}
