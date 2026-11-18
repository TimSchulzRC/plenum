// Texte und Aktionen für den Update-Button, angelehnt an T3 Code.
import type { UpdateState } from '@shared/types'

export type UpdateAction = 'download' | 'install' | 'none'

export function resolveUpdateAction(u: UpdateState): UpdateAction {
  if (u.downloadedVersion && (u.status === 'downloaded' || (u.status === 'error' && u.errorContext === 'install'))) return 'install'
  if (u.status === 'available') return 'download'
  if (u.status === 'error' && u.errorContext === 'download' && u.availableVersion) return 'download'
  return 'none'
}

export function showUpdateButton(u: UpdateState | null): boolean {
  return !!u && (resolveUpdateAction(u) !== 'none' || u.status === 'downloading' || u.status === 'installing')
}

export function updateTooltip(u: UpdateState): string {
  if (u.status === 'error' && u.errorContext === 'download' && u.message) return `${u.message}. Klicken für neuen Versuch.`
  if (u.status === 'error' && u.errorContext === 'install' && u.message) return `${u.message}. Klicken für neuen Versuch.`
  if (u.status === 'available') return `Version ${u.availableVersion} ist verfügbar. Klicken zum Herunterladen.`
  if (u.status === 'downloading') return `Update wird geladen (${u.downloadPercent ?? 0} %)`
  if (u.status === 'downloaded') return `Version ${u.downloadedVersion} ist geladen. Klicken, um neu zu starten und zu installieren.`
  if (u.status === 'installing') return 'Update wird installiert …'
  return 'Teams Everywhere ist aktuell.'
}

export function updateStatusText(u: UpdateState): string {
  switch (u.status) {
    case 'disabled':
      return u.message ?? 'Updates sind nicht verfügbar.'
    case 'idle':
      return 'Noch nicht geprüft.'
    case 'checking':
      return 'Suche nach Updates …'
    case 'up-to-date':
      return 'Teams Everywhere ist aktuell.'
    case 'available':
      return `Version ${u.availableVersion} ist verfügbar.`
    case 'downloading':
      return `Version ${u.availableVersion} wird geladen (${u.downloadPercent ?? 0} %).`
    case 'downloaded':
      return `Version ${u.downloadedVersion} ist bereit. Ein Neustart installiert sie.`
    case 'installing':
      return 'Update wird installiert, die App startet gleich neu.'
    case 'error':
      return u.message ?? 'Beim Update ist ein Fehler aufgetreten.'
  }
}

export function updateLastChecked(u: UpdateState): string | null {
  if (!u.lastChecked) return null
  return `Zuletzt geprüft um ${new Date(u.lastChecked).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr`
}

// Während eines Anrufs fragt die App vor dem Neustart nach.
export function confirmInstall(u: UpdateState, inCall: boolean): boolean {
  if (!inCall) return true
  return window.confirm(`Teams Everywhere startet neu, um Version ${u.downloadedVersion} zu installieren. Der laufende Anruf wird dabei beendet. Jetzt neu starten?`)
}
