import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SessionClock, Throttle, sanitizeProps, scrubText, settingsChanges, updateEvents, uuidv7 } from '../src/shared/analytics.ts'
import type { AppSettings, UpdateState } from '../src/shared/types.ts'

test('Fehlertexte verlieren Mailadressen, Personen, Unterhaltungen und Tokens', () => {
  const raw = [
    'send failed for max.mustermann@firma.de in 19:abc123def@thread.v2',
    'member 8:orgid:2f1c9e7a-1111-4222-8333-944455556666 not found',
    'GET https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations/19%3Ameeting_xyz%40thread.v2/messages?startTime=1&token=abc',
    'Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl',
    'at load (/Users/tim/Projekte/teams-everywhere/out/main/index.js:12:34)'
  ].join('\n')
  const out = scrubText(raw)
  assert.doesNotMatch(out, /mustermann|firma\.de/)
  assert.doesNotMatch(out, /abc123def|meeting_xyz/)
  assert.doesNotMatch(out, /2f1c9e7a/)
  assert.doesNotMatch(out, /eyJhbGci|token=abc/)
  assert.doesNotMatch(out, /\/Users\/tim\//)
  assert.match(out, /<email>/)
  assert.match(out, /<conversation>/)
  assert.match(out, /<user>/)
  assert.match(out, /Bearer <token>/)
  // Zeile und Spalte im Stacktrace bleiben lesbar, sonst ist der Fehler nicht zu finden
  assert.match(out, /index\.js:12:34/)
  assert.match(out, /https:\/\/emea\.ng\.msg\.teams\.microsoft\.com\/v1\/users\/ME\/conversations\/<conversation>\/messages\?<query>/)
})

test('JSON.parse-Fehler verlieren die zitierte Eingabe', () => {
  for (const input of ['Hallo Max, wie geht es?', 'Hallo "Max"', 'Hallo "Max" \\', '<html><body>Max Mustermann hat geschrieben … sehr langer Text, der abgeschnitten wird']) {
    let message = ''
    try {
      JSON.parse(input)
    } catch (e) {
      message = (e as Error).message
    }
    const out = scrubText(message)
    assert.doesNotMatch(out, /Max/)
    assert.match(out, /"<text>"/)
  }
})

test('Zitierte Pfade aus fs-Fehlern fallen weg, Stackframes bleiben', () => {
  const out = scrubText("ENAMETOOLONG: name too long, open '/Users/max/Library/Application Support/Teams Everywhere/mcp/Angebot Müller GmbH.pdf'\n    at saveMcpFile (/Applications/Teams Everywhere.app/Contents/Resources/app.asar/out/main/index.js:120:7)")
  assert.doesNotMatch(out, /Angebot|Müller/)
  assert.match(out, /open '<path>'/)
  assert.match(out, /app\.asar\/out\/main\/index\.js:120:7/)
})

test('Texte werden gekürzt', () => {
  assert.equal(scrubText('x'.repeat(10) + ' ' + 'y'.repeat(10), 5), 'xxxxx…')
})

test('Eigenschaften: nur einfache Werte, Texte bereinigt', () => {
  const out = sanitizeProps({ a: 'mail an a@b.de', n: 3, ok: true, none: null, skip: undefined, inf: Infinity, obj: { x: 1 } as never })
  assert.deepEqual(out, { a: 'mail an <email>', n: 3, ok: true, none: null, inf: null })
})

test('UUID v7 trägt die Zeit und die Version', () => {
  const id = uuidv7(Date.UTC(2026, 10, 25, 12, 0, 0))
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  const ms = parseInt(id.replace(/-/g, '').slice(0, 12), 16)
  assert.equal(ms, Date.UTC(2026, 10, 25, 12, 0, 0))
})

test('Sitzung endet nach 30 Minuten ohne Bedienung, Hintergrundereignisse verlängern sie nicht', () => {
  const clock = new SessionClock(30 * 60_000)
  const t0 = 1_000_000
  const a = clock.current(t0, true)
  assert.equal(clock.current(t0 + 10 * 60_000, false), a)
  assert.equal(clock.current(t0 + 29 * 60_000, true), a)
  // Hintergrund nach langer Pause: noch dieselbe Sitzung
  assert.equal(clock.current(t0 + 80 * 60_000, false), a)
  // Bedienung nach mehr als 30 Minuten: neue Sitzung
  const b = clock.current(t0 + 80 * 60_000, true)
  assert.notEqual(b, a)
})

test('Throttle lässt je Schlüssel ein Ereignis pro Zeitraum durch', () => {
  const th = new Throttle()
  assert.equal(th.allow('k', 1000, 0), true)
  assert.equal(th.allow('k', 1000, 500), false)
  assert.equal(th.allow('other', 1000, 500), true)
  assert.equal(th.allow('k', 1000, 1000), true)
})

const settings: AppSettings = { theme: 'system', notifications: true, notificationSound: true, showMessagePreview: true, runAllAccounts: true, compactChatList: false }

test('Einstellungen: Gerätenamen gehen nicht mit', () => {
  const events = settingsChanges(settings, { ...settings, theme: 'dark', notificationSound: false, preferredMic: 'AirPods von Max', activeAccountId: 'abc' })
  assert.deepEqual(events, [
    { event: 'setting_changed', props: { setting: 'theme', value: 'dark' } },
    { event: 'setting_changed', props: { setting: 'notificationSound', value: false } },
    { event: 'setting_changed', props: { setting: 'preferredMic', value: 'chosen' } }
  ])
  assert.doesNotMatch(JSON.stringify(events), /AirPods|abc/)
})

const update: UpdateState = {
  status: 'idle',
  currentVersion: '0.1.0',
  channel: 'nightly',
  availableVersion: null,
  downloadedVersion: null,
  releaseUrl: null,
  downloadPercent: null,
  errorContext: null,
  message: null,
  lastChecked: null
}

test('Update-Ablauf: jeder Schritt einmal', () => {
  const checking = { ...update, status: 'checking' as const }
  const available = { ...update, status: 'available' as const, availableVersion: '0.1.1' }
  const downloading = { ...available, status: 'downloading' as const, downloadPercent: 10 }
  const downloading2 = { ...downloading, downloadPercent: 50 }
  const downloaded = { ...downloading2, status: 'downloaded' as const, downloadedVersion: '0.1.1' }
  const installing = { ...downloaded, status: 'installing' as const }
  const names = [
    ...updateEvents(update, checking),
    ...updateEvents(checking, available),
    ...updateEvents(available, available),
    ...updateEvents(available, downloading),
    ...updateEvents(downloading, downloading2),
    ...updateEvents(downloading2, downloaded),
    ...updateEvents(downloaded, installing)
  ].map((e) => e.event)
  assert.deepEqual(names, ['update_available', 'update_download_started', 'update_downloaded', 'update_install_started'])
})

test('Update-Fehler mit Schritt', () => {
  const failed = { ...update, status: 'error' as const, errorContext: 'download' as const, message: 'Download fehlgeschlagen: 404' }
  assert.deepEqual(updateEvents({ ...update, status: 'downloading' }, failed), [{ event: 'update_failed', props: { step: 'download', error: 'Download fehlgeschlagen: 404' } }])
  assert.deepEqual(updateEvents(failed, failed), [])
})
