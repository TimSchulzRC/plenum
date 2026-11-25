// Nutzungsdaten und Fehlerberichte (PostHog). Reine Logik ohne Electron, damit `pnpm test`
// sie direkt prüfen kann. Was die App sendet, steht in docs/analytics.md.
import type { AppSettings, UpdateState } from './types'

export type AnalyticsValue = string | number | boolean | null
export type AnalyticsProps = Record<string, AnalyticsValue | undefined>

export interface TrackedEvent {
  event: string
  props?: AnalyticsProps
}

// Fehler aus der Oberfläche, über IPC an den Hauptprozess
export interface UiErrorReport {
  name: string
  message: string
  stack?: string
  // Wo der Fehler auftrat, z. B. window.onerror oder react
  mechanism: string
  handled: boolean
  route: string
}

export type FeedbackKind = 'bug' | 'idea' | 'other'

export const FEEDBACK_MAX_LENGTH = 2000

// ---------- Personenbezogenes entfernen ----------

const REPLACEMENTS: [RegExp, string][] = [
  // Query und Fragment einer URL können Namen, IDs und Tokens tragen
  [/(\b(?:https?|wss?|file):\/\/[^\s?#"'<>]*)[?#][^\s"'<>)]*/gi, '$1?<query>'],
  // Tokens vor allem anderen, sie enthalten sonst Teile, die wie Mailadressen oder IDs aussehen
  [/\bBearer\s+[^\s"',;]+/gi, 'Bearer <token>'],
  [/\b(skypetoken|authorization|authentication|x-skypetoken)([=:]\s*)(?!Bearer\b)[^\s"',;]+/gi, '$1$2<token>'],
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, '<token>'],
  // Teams-Unterhaltungen: 19:…@thread.v2, 19:meeting_…@thread.v2, auch URL-kodiert
  [/\b19:[^\s"'<>/?#]+@[\w.]+/gi, '<conversation>'],
  [/\b19%3a[^\s"'<>/?#]+?%40[\w.]+/gi, '<conversation>'],
  // Personen: 8:orgid:<guid>, 8:live:<name>, 28:<guid> (Bots), 4:+49… (Telefon).
  // Eng gefasst, damit Zeilen und Spalten in Stacktraces (index.js:8:12) bleiben.
  [/\b8:[a-z]+:[^\s"'<>/?#,;]+/gi, '<user>'],
  [/\b(?:28|29|48):[0-9a-f-]{20,}/gi, '<user>'],
  [/\b4:\+?\d{6,}/g, '<user>'],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>'],
  [/[A-Z0-9._%+-]+%40[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
  // Benutzerordner in Pfaden, auch in Stacktraces
  [/(\/Users\/|\/home\/|[A-Z]:\\Users\\)[^/\\\s"'<>]+/g, '$1<user>'],
  // JSON.parse zitiert die Eingabe unverändert, auch mit Anführungszeichen darin:
  // Unexpected token 'H', "Hallo "Max"" is not valid JSON
  [/"[\s\S]*?"(?:\.\.\.)?(?= is not valid JSON)/g, '"<text>"'],
  // Lange Zeichenfolgen ohne Punkt sind fast immer Schlüssel oder Tokens
  [/\b[A-Za-z0-9+_-]{40,}={0,2}/g, '<secret>']
]

export function scrubText(text: string, max = 2000): string {
  let out = text
  for (const [re, by] of REPLACEMENTS) out = out.replace(re, by)
  return out.length > max ? `${out.slice(0, max)}…` : out
}

// Nur einfache Werte, Texte bereinigt und gekürzt. undefined fällt weg.
export function sanitizeProps(props: AnalyticsProps | undefined, maxText = 300): Record<string, AnalyticsValue> {
  const out: Record<string, AnalyticsValue> = {}
  if (!props) return out
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue
    if (typeof v === 'string') out[k] = scrubText(v, maxText)
    else if (typeof v === 'number') out[k] = Number.isFinite(v) ? v : null
    else if (typeof v === 'boolean' || v === null) out[k] = v
  }
  return out
}

// Fehlertext ohne Personenbezug, auf einen Satz gekürzt
export function errorSummary(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return scrubText(msg, 200)
}

// ---------- Sitzungen ----------

// UUID v7: PostHog liest daraus den Beginn der Sitzung.
export function uuidv7(now = Date.now()): string {
  const b = new Uint8Array(16)
  globalThis.crypto.getRandomValues(b)
  let ts = now
  for (let i = 5; i >= 0; i--) {
    b[i] = ts % 256
    ts = Math.floor(ts / 256)
  }
  b[6] = (b[6] & 0x0f) | 0x70
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// Eine Sitzung endet nach 30 Minuten ohne Bedienung. Ereignisse aus dem Hintergrund
// (Synchronisierung, Update-Suche) hängen an der laufenden Sitzung und verlängern sie nicht.
export class SessionClock {
  private id?: string
  private lastActive = 0
  private readonly idleMs: number

  constructor(idleMs = 30 * 60_000) {
    this.idleMs = idleMs
  }

  current(now: number, active: boolean): string {
    if (!this.id || (active && now - this.lastActive > this.idleMs)) {
      this.id = uuidv7(now)
      this.lastActive = now
    }
    if (active) this.lastActive = now
    return this.id
  }
}

// Höchstens ein Ereignis je Schlüssel und Zeitraum, z. B. bei Fehlern, die sich alle 12 s wiederholen
export class Throttle {
  private last = new Map<string, number>()

  allow(key: string, ms: number, now = Date.now()): boolean {
    const prev = this.last.get(key)
    if (prev !== undefined && now - prev < ms) return false
    this.last.set(key, now)
    return true
  }
}

// ---------- Ereignisse aus Zustandsänderungen ----------

const BOOLEAN_SETTINGS = ['notifications', 'notificationSound', 'showMessagePreview', 'runAllAccounts', 'compactChatList', 'chatPreviews'] as const
const DEVICE_SETTINGS = ['preferredCamera', 'preferredMic', 'preferredSpeaker'] as const

// Geänderte Einstellungen. Gerätenamen („AirPods von …“) gehen nicht mit, nur ob eins gewählt ist.
export function settingsChanges(prev: AppSettings, next: AppSettings): TrackedEvent[] {
  const out: TrackedEvent[] = []
  const add = (setting: string, value: AnalyticsValue) => out.push({ event: 'setting_changed', props: { setting, value } })
  if (prev.theme !== next.theme) add('theme', next.theme)
  if (prev.callVideoFit !== next.callVideoFit) add('callVideoFit', next.callVideoFit ?? 'contain')
  for (const k of BOOLEAN_SETTINGS) if (!!prev[k] !== !!next[k]) add(k, !!next[k])
  for (const k of DEVICE_SETTINGS) if ((prev[k] ?? '') !== (next[k] ?? '')) add(k, next[k] ? 'chosen' : 'default')
  return out
}

// Update-Ablauf aus zwei Zuständen des Updaters
export function updateEvents(prev: UpdateState, next: UpdateState): TrackedEvent[] {
  const out: TrackedEvent[] = []
  const entered = (s: UpdateState['status']) => next.status === s && prev.status !== s
  if (next.status === 'available' && (prev.status !== 'available' || prev.availableVersion !== next.availableVersion)) {
    out.push({ event: 'update_available', props: { available_version: next.availableVersion } })
  }
  if (entered('downloading')) out.push({ event: 'update_download_started', props: { available_version: next.availableVersion } })
  if (entered('downloaded')) out.push({ event: 'update_downloaded', props: { available_version: next.downloadedVersion } })
  if (entered('installing')) out.push({ event: 'update_install_started', props: { available_version: next.downloadedVersion } })
  if (next.status === 'error' && (prev.status !== 'error' || prev.message !== next.message)) {
    out.push({ event: 'update_failed', props: { step: next.errorContext, error: next.message ?? undefined } })
  }
  return out
}
