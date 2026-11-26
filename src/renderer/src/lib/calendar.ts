// Ganztägige Termine haben kein Zeitpunkt-Datum, sondern Kalendertage. Graph und Outlook liefern sie
// mit outlook.timezone="UTC" als Mitternacht UTC. In Berlin wäre das 01:00 bis 01:00 am Folgetag,
// der Termin stünde dann an zwei Tagen. Liegt der Wert genau auf Mitternacht UTC, zählt deshalb das
// UTC-Datum, sonst das lokale.
function calendarDay(ms: number): number {
  const d = new Date(ms)
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function allDayOn(ev: { start: number; end: number }, day: Date): boolean {
  const d = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
  const first = calendarDay(ev.start)
  // Ende ist exklusiv (Mitternacht des Folgetags). Ein Termin ohne Dauer belegt trotzdem seinen Tag.
  const end = Math.max(calendarDay(ev.end), first + 1)
  return first <= d && d < end
}

// Stunden seit Mitternacht nach der Uhr an der Wand. An Tagen mit Zeitumstellung hat der Tag 23 oder
// 25 Stunden, das Raster aber immer 24 Zeilen. Gerechnet in Millisekunden seit Mitternacht stünden
// Termine nach der Umstellung eine Stunde daneben.
export function wallHours(ms: number): number {
  const d = new Date(ms)
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600
}

// ---------- Ein Kalender für alle Konten ----------

// Minimale Form eines Termins, damit die Tests ohne die App-Typen auskommen.
export interface MergeableEvent {
  id: string
  start: number
  end: number
  iCalUId?: string
  joinUrl?: string
  isCancelled?: boolean
}

export interface EventSource<E> {
  accountId: string
  event: E
}

// Ein Termin im gemeinsamen Kalender. Bist du mit mehreren Konten eingeladen (z. B. Firmen- und
// Kundenkonto), steht derselbe Termin in jedem dieser Kalender. Er erscheint dann nur einmal, mit
// allen Konten in sources. Das erste Konto in der Kontenreihenfolge ist das Hauptkonto.
export interface MergedEvent<E> {
  key: string
  event: E
  sources: EventSource<E>[]
}

// Gleicher Termin in zwei Kalendern: gleiche iCal-UID (alle Eingeladenen sehen dieselbe) oder, wenn
// eine Quelle keine liefert, gleicher Teilnahmelink. Beginn und Ende gehören dazu, weil Serientermine
// je nach Quelle für alle Vorkommen dieselbe UID und denselben Link haben.
function matchKeys(e: MergeableEvent): string[] {
  const keys: string[] = []
  const when = `${e.start}|${e.end}`
  if (e.iCalUId) keys.push(`uid:${e.iCalUId.toLowerCase()}|${when}`)
  if (e.joinUrl) keys.push(`join:${normalizeJoinUrl(e.joinUrl)}|${when}`)
  return keys
}

// Teilnahmelink ohne Abfrageteil: Kalender und Chat liefern denselben Link mit unterschiedlichem context
export function normalizeJoinUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname.toLowerCase()}${decodeURIComponent(u.pathname).replace(/\/+$/, '')}`
  } catch {
    return url.trim()
  }
}

export function mergeCalendars<E extends MergeableEvent>(lists: { accountId: string; events: E[] }[]): MergedEvent<E>[] {
  const merged: MergedEvent<E>[] = []
  const byKey = new Map<string, MergedEvent<E>>()
  for (const { accountId, events } of lists) {
    for (const event of events) {
      const keys = matchKeys(event)
      const hit = keys.map((k) => byKey.get(k)).find((m) => m && !m.sources.some((s) => s.accountId === accountId))
      if (hit) {
        hit.sources.push({ accountId, event })
        // Abgesagt ist der Termin erst, wenn er es in allen Kalendern ist
        if (hit.event.isCancelled && !event.isCancelled) hit.event = event
        for (const k of keys) if (!byKey.has(k)) byKey.set(k, hit)
        continue
      }
      const m: MergedEvent<E> = { key: `${accountId}|${event.id}`, event, sources: [{ accountId, event }] }
      merged.push(m)
      for (const k of keys) if (!byKey.has(k)) byKey.set(k, m)
    }
  }
  return merged.sort((a, b) => a.event.start - b.event.start || b.event.end - a.event.end)
}

// Farbe je Konto, nach der Reihenfolge der Konten. Das erste Konto behält die Markenfarbe, damit der
// Kalender mit nur einem Konto aussieht wie bisher. Töne aus der Fluent-Palette, lesbar hell und dunkel.
export const ACCOUNT_COLORS = ['#5b5fc7', '#038387', '#ca5010', '#c239b3', '#0078d4', '#498205', '#8764b8', '#d13438']

export function accountColor(accountIds: string[], accountId: string): string {
  const i = accountIds.indexOf(accountId)
  return ACCOUNT_COLORS[(i < 0 ? 0 : i) % ACCOUNT_COLORS.length]
}

// Teilnehmerfeld im Dialog „Neuer Termin“: Adressen getrennt durch Komma, Semikolon oder Leerzeichen.
// Kopierte Einträge wie „Name <name@firma.de>“ zählen mit ihrer Adresse.
export function parseAttendees(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = []
  const invalid: string[] = []
  // „Name <adresse>“ zuerst auf die Adresse kürzen, dann trennen
  const parts = text.replace(/[^,;<>]*<([^>]*)>/g, ' $1 ').split(/[,;\s]+/)
  for (const addr of parts) {
    if (!addr) continue
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
      if (!valid.some((v) => v.toLowerCase() === addr.toLowerCase())) valid.push(addr)
    } else invalid.push(addr)
  }
  return { valid, invalid }
}

// Besprechungschat zu einem Termin: zuerst im bevorzugten Konto, dann in den anderen eingeladenen.
// Kennt keines den Chat, suchen deren Gastmandanten mit. Lädt ein fremder Mandant dich als Gast ein,
// steht die Einladung im Kalender deines Kontos, den Chat gibt es aber womöglich nur im Gastmandanten.
export function findMeetingChat(
  sources: { accountId: string; event: { threadId?: string; joinUrl?: string } }[],
  preferred: string,
  guestsOf: (accountId: string) => string[],
  chatsOf: (accountId: string) => { id: string; meeting?: { joinUrl?: string } }[] | undefined
): { accountId: string; chatId: string } | undefined {
  const ordered = [...sources.filter((s) => s.accountId === preferred), ...sources.filter((s) => s.accountId !== preferred)]
  const candidates = [...ordered, ...ordered.flatMap((s) => guestsOf(s.accountId).map((accountId) => ({ accountId, event: s.event })))]
  for (const { accountId, event } of candidates) {
    const link = event.joinUrl && normalizeJoinUrl(event.joinUrl)
    const chat = chatsOf(accountId)?.find((c) => (event.threadId && c.id === event.threadId) || (link && c.meeting?.joinUrl && normalizeJoinUrl(c.meeting.joinUrl) === link))
    if (chat) return { accountId, chatId: chat.id }
  }
  return undefined
}

// Electron setzt „Error invoking remote method 'api': Error: “ vor jede Meldung aus dem Hauptprozess
export function ipcErrorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')
}

// Datum ("2026-11-26") und Uhrzeit ("14:30") aus Formularfeldern als Ortszeit. days zählt Kalendertage
// weiter, nicht 24 Stunden, sonst endet ein ganztägiger Termin am Tag der Zeitumstellung am selben Datum.
export function localTime(date: string, time = '00:00', days = 0): number {
  const [y, m, d] = date.split('-').map(Number)
  const [h, min] = time.split(':').map(Number)
  return new Date(y, (m || 1) - 1, (d || 1) + days, h || 0, min || 0).getTime()
}
