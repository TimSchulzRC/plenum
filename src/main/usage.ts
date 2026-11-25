// Verbindet App-Ereignisse mit den Nutzungsdaten: Aufrufe der Oberfläche, Kontostatus,
// Fehler und Abstürze. Was genau gesendet wird, steht in docs/analytics.md.
import { app, ipcMain, type BrowserWindow, type WebContents } from 'electron'
import type { AccountService } from './account'
import { analytics } from './analytics'
import { ApiError } from './engine/api'
import { log } from './log'
import { usageFor, type UsageContext } from './usage-events'
import { errorSummary, type AnalyticsProps, type UiErrorReport } from '@shared/analytics'
import type { ApiName } from '@shared/ipc'
import type { AccountStatus } from '@shared/types'

const API_ERROR_THROTTLE = 10 * 60_000
// So lange darf ein Konto brauchen, bis es verbunden ist, bevor das als Problem zählt
const SLOW_CONNECT = 2 * 60_000
const EVENT_NAME = /^\$?[a-z][a-z0-9_]{0,63}$/

export function usageContext(accounts: () => Map<string, AccountService>): UsageContext {
  return {
    conversationKind(accountId, conversationId) {
      const acct = accounts().get(accountId)
      if (!acct) return undefined
      if (acct.channelIndex.has(conversationId)) return 'channel'
      return acct.chats.get(conversationId)?.kind
    }
  }
}

// Erfolgreicher Aufruf aus der Oberfläche
// Nie mit Ausnahme: Nutzungsdaten dürfen das Ergebnis eines Aufrufs nicht ändern.
export function trackApiCall(name: ApiName, args: unknown[], result: unknown, ms: number, ctx: UsageContext): void {
  try {
    const spec = usageFor(name, args as never, ctx)
    if (!spec) return
    if (spec.onlyWithResult && (result === null || result === undefined)) return
    const props: AnalyticsProps = { ...spec.props, ...spec.resultProps?.(result), duration_ms: Math.round(ms) }
    analytics.track(spec.event, props, { active: true, throttle: spec.throttleMs ? { key: spec.event, ms: spec.throttleMs } : undefined })
  } catch (e) {
    log.warn('Nutzungsdaten', (e as Error).message)
  }
}

// Gescheiterter Aufruf. Fehler der Teams-Dienste (HTTP) zählen als Ereignis, alles andere
// ist vermutlich ein Fehler in der App und geht zusätzlich in die Fehlerverfolgung.
// Der Text einer ApiError stammt von der App selbst („chatsvc 404“), andere Meldungen gehen
// nur bereinigt in die Fehlerverfolgung.
export function trackApiFailure(name: ApiName, err: unknown): void {
  if (name === 'debugRaw') return
  try {
    const status = err instanceof ApiError ? err.status : undefined
    const errorType = err instanceof Error ? err.name : typeof err
    analytics.track(
      'api_call_failed',
      { method: name, status, error_type: errorType, error: err instanceof ApiError ? errorSummary(err) : undefined },
      { throttle: { key: `${name}|${status ?? errorType}`, ms: API_ERROR_THROTTLE } }
    )
    if (!(err instanceof ApiError)) analytics.captureError(err, { source: 'ipc', handled: true, props: { method: name } })
  } catch (e) {
    log.warn('Nutzungsdaten', (e as Error).message)
  }
}

// Anmeldung und Verbindung eines Kontos: wie lange es dauert, wann die Anmeldung abläuft,
// ob es hängen bleibt.
export function watchAccount(acct: AccountService): void {
  let last: AccountStatus = acct.engine.status
  let since = Date.now()
  let signingIn = false
  let everReady = false
  let slowTimer: NodeJS.Timeout | undefined
  const armSlow = () => {
    clearTimeout(slowTimer)
    slowTimer = setTimeout(() => {
      const s = acct.engine.status
      if (s !== 'ready' && s !== 'login-required') analytics.track('account_connect_slow', { status: s, seconds: Math.round((Date.now() - since) / 1000) })
    }, SLOW_CONNECT)
  }
  armSlow()
  acct.engine.on('status', (s) => {
    if (s === last) return
    const prev = last
    last = s
    if (s === 'starting') {
      since = Date.now()
      armSlow()
    } else if (s === 'login-required') {
      clearTimeout(slowTimer)
      // Ein Konto mit bekannter Identität war schon angemeldet: die Sitzung ist abgelaufen
      const expired = !!acct.record.mri
      analytics.track(expired ? 'sign_in_expired' : 'sign_in_required', {}, { throttle: { key: `signin-${acct.id}`, ms: 10 * 60_000 } })
      signingIn = true
    } else if (s === 'connecting' && prev === 'login-required') {
      since = Date.now()
      armSlow()
    } else if (s === 'ready') {
      clearTimeout(slowTimer)
      analytics.track('account_connected', {
        seconds: Math.round((Date.now() - since) / 1000),
        after: signingIn ? 'sign_in' : everReady ? 'reconnect' : 'start',
        first_sign_in: !acct.record.mri,
        // Ohne CSA fehlen Teams, Kanäle und Ordner
        complete: acct.engine.tokens.has('csa')
      })
      everReady = true
      signingIn = false
    }
  })
}

// Ereignisse und Fehler aus den eigenen Fenstern
export function setupUiAnalytics(isUi: (wc: WebContents) => boolean): void {
  ipcMain.on('analytics:track', (e, event: unknown, props: unknown) => {
    if (!isUi(e.sender) || typeof event !== 'string' || !EVENT_NAME.test(event)) return
    analytics.track(event, props && typeof props === 'object' ? (props as AnalyticsProps) : undefined, { active: true })
  })
  ipcMain.on('analytics:error', (e, report: UiErrorReport) => {
    if (!isUi(e.sender) || !report || typeof report !== 'object') return
    const err = new Error(String(report.message ?? ''))
    err.name = String(report.name || 'Error')
    err.stack = typeof report.stack === 'string' ? report.stack : undefined
    const mechanism = String(report.mechanism ?? '')
    // Nur ein Fehler, an dem React den ganzen Baum abbaut, lässt das Fenster leer zurück
    const level = mechanism === 'react-uncaught' ? 'fatal' : report.handled ? 'warning' : 'error'
    analytics.captureError(err, { source: 'renderer', handled: !!report.handled, level, props: { mechanism, route: String(report.route ?? '') } })
  })
}

// Abstürze und unbehandelte Fehler im Hauptprozess und in den Kindprozessen.
// uncaughtExceptionMonitor ändert nichts am Verhalten von Electron (Fehlerdialog).
// Unbehandelte Promises beendet Electron nicht, sie landen nur als Warnung im Log, das bleibt so.
export function setupCrashReporting(isUi: (wc: WebContents) => boolean): void {
  process.on('uncaughtExceptionMonitor', (err) => {
    analytics.captureError(err, { source: 'main', handled: false, level: 'fatal' })
  })
  process.on('unhandledRejection', (reason) => {
    log.warn('Unbehandelte Ablehnung', reason instanceof Error ? reason.stack || reason.message : String(reason))
    analytics.captureError(reason, { source: 'main', handled: false, level: 'error', props: { mechanism: 'unhandledrejection' } })
  })
  app.on('render-process-gone', (_e, wc, details) => {
    if (details.reason === 'clean-exit') return
    // Abstürze der Teams-Web-App meldet die Engine selbst (web_app_crashed)
    if (!isUi(wc)) return
    analytics.track('ui_crashed', { reason: details.reason, exit_code: details.exitCode, route: routeOf(wc) })
  })
  app.on('child-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || details.reason === 'killed') return
    analytics.track('child_process_crashed', { type: details.type, reason: details.reason, exit_code: details.exitCode, service: details.serviceName })
  })
}

function routeOf(wc: WebContents): string {
  try {
    return new URL(wc.getURL()).hash.replace(/^#/, '').split('?')[0] || ''
  } catch {
    return ''
  }
}

// Fokus auf ein eigenes Fenster zählt als Nutzung, höchstens alle 30 Minuten
export function trackFocus(win: BrowserWindow, isUi: (wc: WebContents) => boolean): void {
  if (!isUi(win.webContents)) return
  analytics.track('app_focused', { route: routeOf(win.webContents) }, { active: true, throttle: { key: 'focus', ms: 30 * 60_000 } })
}
