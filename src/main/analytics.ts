// Nutzungsdaten und Fehlerberichte über PostHog. Was gesendet wird, steht in docs/analytics.md.
//
// - Der Projektschlüssel kommt beim Bauen aus POSTHOG_KEY (Release-Workflow). Ohne Schlüssel,
//   etwa bei `pnpm run dev` oder in Forks, ist alles aus und die Oberfläche fragt nicht.
// - Gesendet wird erst, wenn die Person zugestimmt hat (Einstellung usageData). Bis zur Antwort
//   sammelt die App Ereignisse nur im Speicher und verwirft sie bei „Nein“.
// - Kennung ist eine zufällige ID pro Installation, nie Name, Mailadresse oder Konto.
import { app, net } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PostHog } from 'posthog-node'
import { log } from './log'
import { FEEDBACK_MAX_LENGTH, SessionClock, Throttle, sanitizeProps, scrubText, type AnalyticsProps, type AnalyticsValue, type FeedbackKind } from '@shared/analytics'
import type { AppVariant } from './variant'

// Von electron.vite.config.ts beim Bauen ersetzt
declare const __POSTHOG_KEY__: string
declare const __POSTHOG_HOST__: string

const MAX_PENDING = 500
const SHUTDOWN_TIMEOUT = 2000
// Derselbe Fehler höchstens einmal pro Minute, sonst flutet eine Schleife das Projekt
const ERROR_THROTTLE = 60_000

interface StoredState {
  installId: string
  firstSeenAt: number
  lastVersion?: string
}

interface TrackOptions {
  // Bedienung durch die Person (verlängert die Sitzung). Hintergrundereignisse nicht.
  active?: boolean
  throttle?: { key: string; ms: number }
  set?: Record<string, AnalyticsValue>
  setOnce?: Record<string, AnalyticsValue>
}

export interface ErrorOptions {
  source: string
  handled: boolean
  level?: 'fatal' | 'error' | 'warning'
  props?: AnalyticsProps
}

type Pending =
  | { kind: 'event'; event: string; properties: Record<string, unknown>; timestamp: Date }
  | { kind: 'error'; error: Error; properties: Record<string, unknown>; level: 'fatal' | 'error' | 'warning' }

function osName(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'Mac OS X'
  if (platform === 'win32') return 'Windows'
  if (platform === 'linux') return 'Linux'
  return platform
}

// Kopie des Fehlers ohne Personenbezug in Meldung und Stacktrace
function scrubError(err: unknown): Error {
  const src = err instanceof Error ? err : new Error(typeof err === 'string' ? err : safeString(err))
  const out = new Error(scrubText(src.message, 1000))
  out.name = scrubText(src.name || 'Error', 100)
  out.stack = src.stack ? scrubText(src.stack, 8000) : undefined
  return out
}

function safeString(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

class Analytics {
  readonly key = (typeof __POSTHOG_KEY__ === 'string' ? __POSTHOG_KEY__ : '').trim()
  readonly host = (typeof __POSTHOG_HOST__ === 'string' && __POSTHOG_HOST__.trim()) || 'https://eu.i.posthog.com'
  private client: PostHog | null = null
  private consent: boolean | undefined
  private pending: Pending[] = []
  private state: StoredState | null = null
  private session = new SessionClock()
  private throttle = new Throttle()
  private base: Record<string, AnalyticsValue> = {}
  private dynamic: () => AnalyticsProps = () => ({})
  private lastClientError = ''
  private shutDown = false

  get available(): boolean {
    return this.key.length > 0
  }

  get installId(): string | undefined {
    return this.available ? this.state?.installId : undefined
  }

  // Nach app.ready. Liefert, ob die App zum ersten Mal läuft und von welcher Version sie kommt.
  init(opts: { variant: AppVariant; consent: boolean | undefined; dynamic: () => AnalyticsProps }): { firstLaunch: boolean; updatedFrom?: string } {
    this.consent = opts.consent
    this.dynamic = opts.dynamic
    const version = app.getVersion()
    this.base = {
      $app_name: 'Teams Everywhere',
      $app_version: version,
      app_channel: opts.variant,
      $os: osName(process.platform),
      $os_version: process.getSystemVersion(),
      $device_type: 'Desktop',
      arch: process.arch,
      electron_version: process.versions.electron,
      locale: app.getLocale()
    }
    // Ohne Schlüssel keine ID und keine Datei
    if (!this.available) return { firstLaunch: false }
    const file = join(app.getPath('userData'), 'analytics.json')
    let stored: Partial<StoredState> = {}
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object') stored = parsed as Partial<StoredState>
    } catch {
      /* erster Start */
    }
    const known = typeof stored.installId === 'string' && stored.installId.length > 0
    const firstLaunch = !known
    const updatedFrom = typeof stored.lastVersion === 'string' && stored.lastVersion !== version ? stored.lastVersion : undefined
    this.state = {
      installId: known ? (stored.installId as string) : randomUUID(),
      firstSeenAt: typeof stored.firstSeenAt === 'number' ? stored.firstSeenAt : Date.now(),
      lastVersion: version
    }
    try {
      writeFileSync(file, JSON.stringify(this.state, null, 2))
    } catch (e) {
      log.warn('analytics.json nicht geschrieben', (e as Error).message)
    }
    if (this.available) log.info(`Nutzungsdaten: ${this.consent === true ? 'an' : this.consent === false ? 'aus' : 'noch nicht gefragt'}`)
    return { firstLaunch, updatedFrom }
  }

  setConsent(on: boolean, source: string): void {
    if (!this.available || this.consent === on) return
    this.consent = on
    log.info(`Nutzungsdaten ${on ? 'eingeschaltet' : 'ausgeschaltet'} (${source})`)
    if (!on) {
      // Auch was schon in der Warteschlange von PostHog liegt, geht nicht mehr raus.
      // disable() verwirft sie, shutdown() räumt danach die Zeitgeber ab.
      this.pending = []
      const client = this.client
      this.client = null
      if (client) void client.disable().then(() => client.shutdown(0)).catch(() => undefined)
      return
    }
    const queued = this.pending
    this.pending = []
    for (const p of queued) this.send(p)
    this.track('usage_data_enabled', { source }, { active: true })
  }

  track(event: string, props?: AnalyticsProps, opts: TrackOptions = {}): void {
    if (!this.available || this.consent === false || this.shutDown) return
    if (opts.throttle && !this.throttle.allow(opts.throttle.key, opts.throttle.ms)) return
    const now = Date.now()
    const properties: Record<string, unknown> = {
      ...this.base,
      ...sanitizeProps(this.dynamic()),
      ...sanitizeProps(props),
      $session_id: this.session.current(now, opts.active ?? false)
    }
    if (opts.set) properties.$set = sanitizeProps(opts.set)
    if (opts.setOnce) properties.$set_once = sanitizeProps(opts.setOnce)
    this.enqueue({ kind: 'event', event, properties, timestamp: new Date(now) })
  }

  captureError(err: unknown, opts: ErrorOptions): void {
    if (!this.available || this.consent === false || this.shutDown) return
    const error = scrubError(err)
    if (!this.throttle.allow(`${opts.source}|${error.name}|${error.message.slice(0, 120)}`, ERROR_THROTTLE)) return
    const properties: Record<string, unknown> = {
      ...this.base,
      ...sanitizeProps(this.dynamic()),
      ...sanitizeProps(opts.props),
      error_source: opts.source,
      handled: opts.handled,
      $session_id: this.session.current(Date.now(), false)
    }
    this.enqueue({ kind: 'error', error, properties, level: opts.level ?? (opts.handled ? 'error' : 'fatal') })
  }

  // Feedback aus den Einstellungen. Geht auch ohne Zustimmung zu Nutzungsdaten, weil die Person
  // es selbst abschickt. Dann mit einer Wegwerf-ID, damit es nicht mit früheren Daten verknüpft ist.
  async sendFeedback(kind: FeedbackKind, message: string): Promise<void> {
    if (!this.available) throw new Error('Feedback ist in dieser Ausgabe nicht aktiv')
    const text = message.trim().slice(0, FEEDBACK_MAX_LENGTH)
    if (!text) throw new Error('Leeres Feedback')
    // Eigener Client: unabhängig von Zustimmung und Warteschlange der Nutzungsdaten.
    // captureImmediate meldet Fehler nur über das error-Ereignis, nicht über das Promise.
    const client = this.createClient()
    let failed = false
    client.on('error', () => (failed = true))
    const consented = this.consent === true
    try {
      await client.captureImmediate({
        distinctId: consented && this.state ? this.state.installId : randomUUID(),
        event: 'feedback_sent',
        properties: {
          ...this.base,
          ...(consented ? { $session_id: this.session.current(Date.now(), true) } : {}),
          kind: ['bug', 'idea', 'other'].includes(kind) ? kind : 'other',
          message: text,
          message_length: text.length,
          usage_data: consented
        },
        options: consented ? undefined : { process_person_profile: false }
      })
    } finally {
      await client.shutdown(1000).catch(() => undefined)
    }
    if (failed) throw new Error('PostHog ist gerade nicht erreichbar')
  }

  // Ob beim Beenden noch etwas zu senden sein kann
  get needsDrain(): boolean {
    return this.client !== null
  }

  // Beim Beenden: Warteschlange senden, höchstens SHUTDOWN_TIMEOUT lang
  async shutdown(): Promise<void> {
    this.shutDown = true
    const client = this.client
    this.client = null
    if (client) await client.shutdown(SHUTDOWN_TIMEOUT).catch(() => undefined)
  }

  private enqueue(p: Pending): void {
    if (this.consent === true) return this.send(p)
    // Noch nicht gefragt: im Speicher halten, bis die Antwort kommt
    if (this.pending.length >= MAX_PENDING) this.pending.shift()
    this.pending.push(p)
  }

  private send(p: Pending): void {
    if (!this.state) return
    try {
      const client = this.ensureClient()
      if (p.kind === 'event') client.capture({ distinctId: this.state.installId, event: p.event, properties: p.properties, timestamp: p.timestamp })
      else client.captureException(p.error, { distinctId: this.state.installId, properties: p.properties, level: p.level })
    } catch (e) {
      log.warn('Nutzungsdaten nicht gesendet', (e as Error).message)
    }
  }

  private ensureClient(): PostHog {
    if (this.client) return this.client
    const client = this.createClient()
    client.on('error', (err: unknown) => {
      const msg = err instanceof Error ? err.message : safeString(err)
      if (msg !== this.lastClientError) log.warn('PostHog', scrubText(msg, 300))
      this.lastClientError = msg
    })
    this.client = client
    return client
  }

  private createClient(): PostHog {
    return new PostHog(this.key, {
      host: this.host,
      flushAt: 20,
      flushInterval: 10_000,
      // Desktop-App, keine Server-Ereignisse: PostHog zeigt dann Betriebssystem und Gerät normal an
      isServer: false,
      // Über den Netzwerk-Stack von Chromium, damit Proxy-Einstellungen des Systems gelten
      fetch: (url, options) => net.fetch(url, options as RequestInit)
    })
  }
}

export const analytics = new Analytics()
