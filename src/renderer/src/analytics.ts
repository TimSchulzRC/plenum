// Nutzungsereignisse und Fehler der Oberfläche. Der Hauptprozess sendet sie, wenn die App einen
// Projektschlüssel hat, und entfernt Personenbezogenes. Siehe docs/analytics.md.
import type { AnalyticsProps } from '@shared/analytics'
import { routeInfo } from './api'

export const USAGE_DATA_DOC = 'https://github.com/TimSchulzRC/teams-everywhere/blob/main/docs/analytics.md'

export function track(event: string, props?: AnalyticsProps): void {
  try {
    window.teams.track(event, props)
  } catch {
    /* Nutzungsdaten dürfen die Oberfläche nie stören */
  }
}

export function reportError(error: unknown, mechanism: string, handled: boolean): void {
  try {
    const e = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Unbekannter Fehler')
    window.teams.reportError({ name: e.name, message: e.message, stack: e.stack, mechanism, handled, route: routeInfo().path })
  } catch {
    /* ignorieren */
  }
}

// Harmlose Meldungen von Chromium, kein Fehler der App
const IGNORED = [/ResizeObserver loop/i]

let installed = false
export function installErrorReporting(): void {
  if (installed) return
  installed = true
  window.addEventListener('error', (e) => {
    if (!e.error && !e.message) return
    if (IGNORED.some((re) => re.test(String(e.message)))) return
    reportError(e.error ?? new Error(e.message), 'onerror', false)
  })
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason, 'onunhandledrejection', false))
}

// Fehler, die React meldet: unbehandelt (der Baum wird abgebaut, das Fenster bleibt leer)
// oder von einer Fehlergrenze abgefangen. console.error bleibt wie ohne eigene Behandlung.
export const reactErrorHandlers = {
  onUncaughtError(error: unknown) {
    console.error(error)
    reportError(error, 'react-uncaught', false)
  },
  onCaughtError(error: unknown) {
    console.error(error)
    reportError(error, 'react-caught', true)
  }
}
