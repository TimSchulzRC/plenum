// Anfragen zum Anlegen eines Termins. Ohne Electron-Abhängigkeit, damit die Tests sie direkt laden.
import type { NewCalendarEvent } from '@shared/types'

const pad = (n: number) => String(n).padStart(2, '0')

// Zeitpunkt als UTC ohne Zeitzonenangabe, dazu timeZone "UTC"
function utc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '')
}

// Ganztägig zählen Kalendertage, nicht Zeitpunkte: Mitternacht des lokalen Tages, ebenfalls mit "UTC".
// So steht der Termin bei jedem Empfänger an genau diesen Tagen.
function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00:00`
}

function when(ev: NewCalendarEvent, ms: number): string {
  return ev.isAllDay ? localDay(ms) : utc(ms)
}

// Microsoft Graph, POST /v1.0/me/events
export function graphEventBody(ev: NewCalendarEvent): Record<string, unknown> {
  return {
    subject: ev.subject,
    ...(ev.body ? { body: { contentType: 'text', content: ev.body } } : {}),
    start: { dateTime: when(ev, ev.start), timeZone: 'UTC' },
    end: { dateTime: when(ev, ev.end), timeZone: 'UTC' },
    isAllDay: ev.isAllDay,
    ...(ev.location ? { location: { displayName: ev.location } } : {}),
    attendees: ev.attendees.map((address) => ({ emailAddress: { address }, type: 'required' })),
    ...(ev.teamsMeeting ? { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } : {})
  }
}

// Outlook REST v2.0, POST /api/v2.0/me/events: dieselben Felder in PascalCase
export function outlookEventBody(ev: NewCalendarEvent): Record<string, unknown> {
  return {
    Subject: ev.subject,
    ...(ev.body ? { Body: { ContentType: 'Text', Content: ev.body } } : {}),
    Start: { DateTime: when(ev, ev.start), TimeZone: 'UTC' },
    End: { DateTime: when(ev, ev.end), TimeZone: 'UTC' },
    IsAllDay: ev.isAllDay,
    ...(ev.location ? { Location: { DisplayName: ev.location } } : {}),
    Attendees: ev.attendees.map((Address) => ({ EmailAddress: { Address }, Type: 'Required' })),
    ...(ev.teamsMeeting ? { IsOnlineMeeting: true, OnlineMeetingProvider: 'TeamsForBusiness' } : {})
  }
}

// Ein Weg zum Anlegen darf nur dann zum nächsten weiterreichen, wenn sicher nichts angelegt wurde:
// kein Token oder Endpunkt (0), keine Berechtigung (401, 403), unbekannter Pfad (404, 405).
// Bei Zeitüberschreitung oder Serverfehler könnte der Termin trotzdem entstanden sein.
export function mayTryNextWriter(status: number): boolean {
  return status === 0 || status === 401 || status === 403 || status === 404 || status === 405
}

export const NO_CALENDAR_TOKEN =
  'Termin nicht angelegt: Die Teams-Web-App hat für dieses Konto noch keinen Kalenderzugriff angefordert. Versuche es in ein paar Minuten erneut.'

// Texte für die Fehlermeldungen von firstWriter, je nachdem, was angelegt oder verschickt wird
export interface WriteTexts {
  noToken: string
  failed: string
  unclear: string
}

export const EVENT_TEXTS: WriteTexts = {
  noToken: NO_CALENDAR_TOKEN,
  failed: 'Termin nicht angelegt',
  unclear: 'Unklar, ob der Termin angelegt wurde ({errors}). Sieh im Kalender nach, bevor du es noch einmal versuchst.'
}

// Die Wege der Reihe nach versuchen. Fehler ohne HTTP-Status (Netz, Zeitüberschreitung) beenden die Reihe.
export async function firstWriter<T>(tries: [string, () => Promise<T>][], texts: WriteTexts = EVENT_TEXTS): Promise<{ source: string; data: T }> {
  const errors: string[] = []
  let status = 0
  for (const [name, run] of tries) {
    try {
      return { source: name, data: await run() }
    } catch (e) {
      status = typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : -1
      errors.push(`${name}: ${(e as Error).message}`)
      if (!mayTryNextWriter(status)) break
    }
  }
  // status: der des letzten Versuchs, damit der Fehler als Dienstfehler (ApiError) zählt
  // Netzfehler, Zeitüberschreitung, Serverfehler: Der Schreibvorgang kann trotzdem geklappt haben
  const unclear = status === -1 || status === 408 || status >= 500
  const list = errors.join('; ')
  const message = !errors.length ? texts.noToken : unclear ? texts.unclear.replace('{errors}', list) : `${texts.failed} (${list})`
  throw Object.assign(new Error(message), { status })
}
