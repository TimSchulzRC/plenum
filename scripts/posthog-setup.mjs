// Richtet das PostHog-Projekt für Teams Everywhere ein: Projekteinstellungen, Dashboards
// „Nutzung“ und „Probleme und Fehler“ mit ihren Insights und eine Warnung bei vielen Fehlern.
// Läuft beliebig oft: Vorhandenes wird aktualisiert, nichts doppelt angelegt.
//
//   POSTHOG_PERSONAL_API_KEY=phx_… node scripts/posthog-setup.mjs
//
// Umgebung:
//   POSTHOG_PERSONAL_API_KEY  persönlicher API-Schlüssel (PostHog › Einstellungen › Personal API keys)
//   POSTHOG_API_HOST          https://eu.posthog.com (Standard) oder https://us.posthog.com
//   POSTHOG_PROJECT_ID        Projekt-ID. Ohne: das Projekt „Teams Everywhere“, sonst wird es angelegt.
//   POSTHOG_ALERT_THRESHOLD   Fehler pro Stunde, ab denen PostHog eine Mail schickt (Standard 20, 0 = keine Warnung)
//
// Was die App sendet, steht in docs/analytics.md.

const KEY = process.env.POSTHOG_PERSONAL_API_KEY
const HOST = (process.env.POSTHOG_API_HOST || 'https://eu.posthog.com').replace(/\/$/, '')
const PROJECT_NAME = 'Teams Everywhere'
const ALERT_THRESHOLD = Number(process.env.POSTHOG_ALERT_THRESHOLD ?? 20)

if (!KEY) {
  console.error('POSTHOG_PERSONAL_API_KEY fehlt')
  process.exit(1)
}

async function api(method, path, body) {
  const res = await fetch(`${HOST}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}: ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 600)}`)
    err.status = res.status
    throw err
  }
  return data
}

async function listAll(path) {
  const out = []
  let next = `${path}${path.includes('?') ? '&' : '?'}limit=200`
  while (next) {
    const page = await api('GET', next.replace(HOST, ''))
    out.push(...(page.results ?? []))
    next = page.next
  }
  return out
}

// ---------- Bausteine für Abfragen ----------

const ev = (event, extra = {}) => ({ kind: 'EventsNode', event, name: event, ...extra })
const prop = (key, value, operator = 'exact') => ({ key, value, operator, type: 'event' })

function trends(series, o = {}) {
  return {
    kind: 'InsightVizNode',
    source: {
      kind: 'TrendsQuery',
      series,
      interval: o.interval ?? 'day',
      dateRange: { date_from: o.from ?? '-30d' },
      filterTestAccounts: true,
      ...(o.breakdown ? { breakdownFilter: { breakdown: o.breakdown, breakdown_type: 'event', breakdown_limit: o.limit ?? 15 } } : {}),
      trendsFilter: {
        display: o.display ?? 'ActionsLineGraph',
        ...(o.formula ? { formula: o.formula } : {}),
        ...(o.aggregationAxisFormat ? { aggregationAxisFormat: o.aggregationAxisFormat } : {}),
        showLegend: o.legend ?? series.length > 1
      }
    }
  }
}

function table(query, from = '-14d') {
  return { kind: 'DataTableNode', source: { kind: 'HogQLQuery', query, filters: { dateRange: { date_from: from }, filterTestAccounts: true } } }
}

// Aktiv genutzt: Fokus auf ein Fenster der App (höchstens alle 30 Minuten gezählt)
const ACTIVE = 'app_focused'

// ---------- Dashboards ----------

const DASHBOARDS = [
  {
    name: 'Teams Everywhere – Nutzung',
    description: 'Wer die App nutzt, wie oft und welche Funktionen. Dev-Builds sind ausgefiltert. Ereignisse: docs/analytics.md im Repo.',
    insights: [
      {
        name: 'Aktive Installationen pro Tag',
        description: 'Genutzt = ein Fenster der App hatte den Fokus. Laufend = die App hat überhaupt etwas gesendet, auch im Hintergrund.',
        query: trends([ev(ACTIVE, { math: 'dau', custom_name: 'Genutzt' }), ev(null, { name: 'Alle Ereignisse', math: 'dau', custom_name: 'Laufend' })], { from: '-30d' })
      },
      {
        name: 'Wöchentlich und monatlich aktive Installationen',
        query: trends([ev(ACTIVE, { math: 'weekly_active', custom_name: 'WAU' }), ev(ACTIVE, { math: 'monthly_active', custom_name: 'MAU' })], { from: '-90d' })
      },
      {
        name: 'Bindung: kommen Installationen wieder?',
        description: 'Anteil der Installationen, die in den Wochen nach dem ersten Start die App wieder nutzen.',
        query: {
          kind: 'InsightVizNode',
          source: {
            kind: 'RetentionQuery',
            dateRange: { date_from: '-56d' },
            filterTestAccounts: true,
            retentionFilter: {
              period: 'Week',
              totalIntervals: 8,
              retentionType: 'retention_first_time',
              targetEntity: { id: 'app_started', name: 'app_started', type: 'events' },
              returningEntity: { id: ACTIVE, name: ACTIVE, type: 'events' }
            }
          }
        }
      },
      {
        name: 'Neu, wiederkehrend, abgesprungen',
        query: { kind: 'InsightVizNode', source: { kind: 'LifecycleQuery', series: [ev(ACTIVE)], interval: 'week', dateRange: { date_from: '-8w' }, filterTestAccounts: true } }
      },
      {
        name: 'Genutzte Ansichten',
        description: 'Wie viele Installationen jede Ansicht in den letzten 30 Tagen geöffnet haben.',
        query: trends([ev('$screen', { math: 'dau' })], { breakdown: '$screen_name', display: 'ActionsBarValue' })
      },
      {
        name: 'Genutzte Funktionen',
        description: 'Installationen, die die Funktion in den letzten 30 Tagen mindestens einmal genutzt haben.',
        query: trends(
          [
            ev('message_sent', { math: 'dau', custom_name: 'Nachricht gesendet' }),
            ev('message_edited', { math: 'dau', custom_name: 'Nachricht bearbeitet' }),
            ev('reaction_added', { math: 'dau', custom_name: 'Reaktion' }),
            ev('chat_created', { math: 'dau', custom_name: 'Chat angelegt' }),
            ev('people_searched', { math: 'dau', custom_name: 'Personensuche' }),
            ev('presence_changed', { math: 'dau', custom_name: 'Status gesetzt' }),
            ev('chat_section_changed', { math: 'dau', custom_name: 'Favoriten/Abschnitte' }),
            ev('call_start_clicked', { math: 'dau', custom_name: 'Anruf gestartet' }),
            ev('meeting_join_clicked', { math: 'dau', custom_name: 'Besprechung beigetreten' }),
            ev('incoming_call_answered', { math: 'dau', custom_name: 'Anruf angenommen' }),
            ev('screen_share_source_picked', { math: 'dau', custom_name: 'Bildschirm geteilt', properties: [prop('kind', ['cancelled'], 'is_not')] }),
            ev('call_background_changed', { math: 'dau', custom_name: 'Hintergrund' }),
            ev('call_video_popped_out', { math: 'dau', custom_name: 'Video ausgekoppelt' }),
            ev('call_compact_view', { math: 'dau', custom_name: 'Kompaktansicht' }),
            ev('image_action', { math: 'dau', custom_name: 'Bild kopiert/gespeichert' }),
            ev('notification_clicked', { math: 'dau', custom_name: 'Mitteilung angeklickt' }),
            ev('mcp_tool_called', { math: 'dau', custom_name: 'MCP (Claude Code, Codex)' }),
            ev('keyboard_shortcut', { math: 'dau', custom_name: 'Tastenkürzel' })
          ],
          { display: 'ActionsBarValue' }
        )
      },
      {
        name: 'Nachrichten pro Tag nach Art der Unterhaltung',
        query: trends([ev('message_sent')], { breakdown: 'conversation_kind', display: 'ActionsAreaGraph' })
      },
      {
        name: 'Anrufe und Besprechungen pro Tag',
        query: trends([ev('call_connected')], { breakdown: 'origin', display: 'ActionsBar' })
      },
      {
        name: 'Anrufdauer im Mittel (Minuten)',
        query: trends([ev('call_ended', { math: 'median', math_property: 'duration_s' })], { formula: 'A / 60', interval: 'week', from: '-90d' })
      },
      {
        name: 'Webansicht statt eigener Oberfläche',
        description: 'Wie oft Leute in die Teams-Webansicht ausweichen. Hinweis auf Funktionen, die in der eigenen Oberfläche fehlen.',
        query: trends(
          [ev('web_view_opened', { custom_name: 'Webansicht geöffnet' }), ev('call_opened_in_web_view', { custom_name: 'Anruf in Teams gezeigt' }), ev('meeting_opened_in_browser', { custom_name: 'Besprechung im Browser' })],
          { display: 'ActionsBar' }
        )
      },
      {
        name: 'Versionen im Einsatz',
        description: 'Aktive Installationen der letzten 7 Tage je Version. Zeigt, wie schnell Updates ankommen.',
        query: trends([ev(ACTIVE, { math: 'dau' })], { breakdown: '$app_version', display: 'ActionsBarValue', from: '-7d' })
      },
      {
        name: 'Stable und Nightly',
        query: trends([ev(ACTIVE, { math: 'dau' })], { breakdown: 'app_channel', display: 'ActionsPie', from: '-30d' })
      },
      {
        name: 'Geänderte Einstellungen',
        query: trends([ev('setting_changed')], { breakdown: 'setting', display: 'ActionsBarValue', from: '-90d' })
      },
      {
        name: 'Konten pro Installation',
        query: trends([ev('app_started', { math: 'dau' })], { breakdown: 'account_count', display: 'ActionsPie', from: '-30d' })
      }
    ]
  },
  {
    name: 'Teams Everywhere – Probleme und Fehler',
    description: 'Fehler, Abstürze, gescheiterte Aufrufe und Feedback. Details zu einzelnen Fehlern: Error tracking. Dev-Builds sind ausgefiltert.',
    insights: [
      {
        name: 'Fehler pro Tag nach Quelle',
        description: 'main = Hauptprozess, renderer = Oberfläche, ipc = Aktion aus der Oberfläche im Hauptprozess, mcp = Werkzeug des MCP-Servers.',
        query: trends([ev('$exception')], { breakdown: 'error_source', display: 'ActionsBar' })
      },
      {
        name: 'Installationen mit Fehlern',
        query: trends([ev('$exception', { math: 'dau', custom_name: 'mit Fehler' }), ev(ACTIVE, { math: 'dau', custom_name: 'aktiv' })], { formula: 'A / B * 100', aggregationAxisFormat: 'percentage' })
      },
      {
        name: 'Häufigste Fehler (14 Tage)',
        query: table(
          `SELECT
  properties.$exception_types AS typ,
  properties.$exception_values AS meldung,
  properties.error_source AS quelle,
  count() AS anzahl,
  count(DISTINCT distinct_id) AS installationen,
  max(timestamp) AS zuletzt
FROM events
WHERE event = '$exception' AND {filters}
GROUP BY typ, meldung, quelle
ORDER BY anzahl DESC
LIMIT 50`
        )
      },
      {
        name: 'Gescheiterte Aufrufe an Teams',
        description: 'api_call_failed je Methode. HTTP-Status 401 = Anmeldung, 404 = nicht gefunden, 429 = gedrosselt, 0 = Endpunkt noch unbekannt.',
        query: trends([ev('api_call_failed')], { breakdown: 'method', display: 'ActionsBarValue', from: '-14d' })
      },
      {
        name: 'Anrufstarts: verbunden, gescheitert, abgebrochen',
        query: trends(
          [
            ev('call_connected', { custom_name: 'Verbunden' }),
            ev('call_start_failed', { custom_name: 'Gescheitert' }),
            ev('call_start_cancelled', { custom_name: 'Abgebrochen' }),
            ev('call_not_joined', { custom_name: 'Nicht beigetreten' })
          ],
          { display: 'ActionsBar' }
        )
      },
      {
        name: 'Anteil gescheiterter Anrufstarts (%)',
        query: trends([ev('call_start_failed'), ev('call_connected')], { formula: 'A / (A + B) * 100', interval: 'week', from: '-90d', aggregationAxisFormat: 'percentage' })
      },
      {
        name: 'Anmeldung und Verbindung',
        description: 'Abgelaufene Anmeldungen, Konten, die länger als 2 Minuten nicht verbinden, und Ladefehler der Teams-Web-App.',
        query: trends(
          [
            ev('sign_in_expired', { custom_name: 'Anmeldung abgelaufen' }),
            ev('account_connect_slow', { custom_name: 'Verbindet nicht' }),
            ev('web_app_load_failed', { custom_name: 'Web-App lädt nicht' }),
            ev('sync_failed', { custom_name: 'Synchronisierung gescheitert' })
          ],
          { display: 'ActionsBar' }
        )
      },
      {
        name: 'Zeit bis verbunden (Sekunden, Median)',
        query: trends([ev('account_connected', { math: 'median', math_property: 'seconds' })], { breakdown: 'after', interval: 'week', from: '-90d' })
      },
      {
        name: 'Abstürze',
        query: trends(
          [ev('ui_crashed', { custom_name: 'Fenster der App' }), ev('web_app_crashed', { custom_name: 'Teams-Web-App' }), ev('child_process_crashed', { custom_name: 'Hilfsprozess' })],
          { display: 'ActionsBar' }
        )
      },
      {
        name: 'Updates',
        query: trends(
          [
            ev('update_available', { math: 'dau', custom_name: 'Update gefunden' }),
            ev('update_downloaded', { math: 'dau', custom_name: 'geladen' }),
            ev('app_updated', { math: 'dau', custom_name: 'installiert' }),
            ev('update_failed', { math: 'dau', custom_name: 'gescheitert', properties: [prop('step', ['check'], 'is_not')] })
          ],
          { display: 'ActionsBar' }
        )
      },
      {
        name: 'Mitteilungen von macOS abgelehnt',
        query: trends([ev('notification_failed', { math: 'dau' })], { breakdown: 'error', display: 'ActionsBarValue' })
      },
      {
        name: 'Feedback',
        description: 'Aus Einstellungen › Feedback.',
        query: table(
          `SELECT
  timestamp AS zeit,
  properties.kind AS art,
  properties.message AS nachricht,
  properties.$app_version AS version,
  properties.app_channel AS kanal
FROM events
WHERE event = 'feedback_sent' AND {filters}
ORDER BY timestamp DESC
LIMIT 200`,
          '-180d'
        )
      }
    ]
  }
]

// ---------- Ablauf ----------

async function findProject() {
  const me = await api('GET', '/api/users/@me/')
  if (process.env.POSTHOG_PROJECT_ID) return { me, project: await api('GET', `/api/projects/${process.env.POSTHOG_PROJECT_ID}/`) }
  const orgId = me.organization?.id
  const projects = await listAll(`/api/organizations/${orgId}/projects/`)
  const found = projects.find((p) => p.name === PROJECT_NAME)
  if (found) return { me, project: await api('GET', `/api/projects/${found.id}/`) }
  // Neue Organisation nur für die App: das leere Standardprojekt übernehmen statt ein zweites anzulegen
  if (projects.length === 1 && projects[0].name === 'Default project') {
    const only = await api('GET', `/api/projects/${projects[0].id}/`)
    if (!only.ingested_event) {
      console.log(`Benenne „Default project“ in „${PROJECT_NAME}“ um …`)
      await api('PATCH', `/api/projects/${only.id}/`, { name: PROJECT_NAME })
      return { me, project: await api('GET', `/api/projects/${only.id}/`) }
    }
  }
  console.log(`Lege Projekt „${PROJECT_NAME}“ an …`)
  const created = await api('POST', `/api/organizations/${orgId}/projects/`, { name: PROJECT_NAME })
  return { me, project: await api('GET', `/api/projects/${created.id}/`) }
}

async function configureProject(project) {
  // Dev-Builds (`pnpm run dev`, PR-Builds) zählen als Testkonten und fallen aus den Dashboards.
  // Vorhandene Filter, etwa die Kohorte interner Nutzer, bleiben.
  const devFilter = { key: 'app_channel', value: ['dev'], operator: 'is_not', type: 'event' }
  const filters = project.test_account_filters ?? []
  const hasDev = filters.some((f) => f.type === 'event' && f.key === 'app_channel' && f.operator === 'is_not' && [f.value].flat().includes('dev'))
  await api('PATCH', `/api/environments/${project.id}/`, {
    // IP-Adressen nicht speichern
    anonymize_ips: true,
    // Tage in deutscher Zeit zählen
    timezone: 'Europe/Berlin',
    test_account_filters: hasDev ? filters : [...filters, devFilter],
    test_account_filters_default_checked: true,
    // Die App nutzt nur eigene Ereignisse, keine Aufzeichnungen
    session_recording_opt_in: false,
    autocapture_opt_out: true,
    capture_console_log_opt_in: false,
    capture_performance_opt_in: false
  })
}

async function validate(id, insight) {
  const source = insight.query.source
  try {
    await api('POST', `/api/environments/${id}/query/`, { query: source })
    return true
  } catch (e) {
    console.warn(`  ! Abfrage „${insight.name}“ abgelehnt: ${e.message}`)
    return false
  }
}

async function upsertDashboard(id, def, existingDashboards, existingInsights) {
  let dash = existingDashboards.find((d) => d.name === def.name && !d.deleted)
  if (dash) {
    dash = await api('PATCH', `/api/environments/${id}/dashboards/${dash.id}/`, { description: def.description, pinned: true })
    console.log(`Dashboard aktualisiert: ${def.name}`)
  } else {
    dash = await api('POST', `/api/environments/${id}/dashboards/`, { name: def.name, description: def.description, pinned: true })
    console.log(`Dashboard angelegt: ${def.name}`)
  }
  const ids = {}
  for (const ins of def.insights) {
    const ok = await validate(id, ins)
    if (!ok) continue
    const prev = existingInsights.find((i) => i.name === ins.name && !i.deleted && (i.dashboards ?? []).includes(dash.id))
    const body = { name: ins.name, description: ins.description ?? '', query: ins.query, tags: ['teams-everywhere'], saved: true }
    let saved
    if (prev) {
      saved = await api('PATCH', `/api/environments/${id}/insights/${prev.id}/`, body)
      console.log(`  Insight aktualisiert: ${ins.name}`)
    } else {
      saved = await api('POST', `/api/environments/${id}/insights/`, { ...body, dashboards: [dash.id] })
      console.log(`  Insight angelegt: ${ins.name}`)
    }
    ids[ins.name] = saved.id
  }
  return { dash, ids }
}

// Mail an die einrichtende Person, wenn die Fehler pro Stunde über der Schwelle liegen
async function upsertAlert(id, insightId, userId) {
  if (!ALERT_THRESHOLD || !insightId) return
  const name = `Viele Fehler in Teams Everywhere (über ${ALERT_THRESHOLD} pro Stunde)`
  const body = {
    name,
    insight: insightId,
    subscribed_users: [userId],
    enabled: true,
    calculation_interval: 'hourly',
    condition: { type: 'absolute_value' },
    threshold: { configuration: { type: 'absolute', bounds: { upper: ALERT_THRESHOLD } } },
    config: { type: 'TrendsAlertConfig', series_index: 0 }
  }
  try {
    const alerts = await listAll(`/api/environments/${id}/alerts/`)
    const prev = alerts.find((a) => a.name?.startsWith('Viele Fehler in Teams Everywhere'))
    if (prev) await api('PATCH', `/api/environments/${id}/alerts/${prev.id}/`, body)
    else await api('POST', `/api/environments/${id}/alerts/`, body)
    console.log(`Warnung ${prev ? 'aktualisiert' : 'angelegt'}: ${name}`)
  } catch (e) {
    console.warn(`Warnung nicht angelegt: ${e.message}`)
  }
}

const { me, project } = await findProject()
const id = project.id
console.log(`Projekt: ${project.name} (${id})`)
await configureProject(project)
console.log('Projekteinstellungen gesetzt: IP-Adressen anonym, Zeitzone Berlin, Dev-Builds als Testkonten, keine Aufzeichnungen')

const dashboards = await listAll(`/api/environments/${id}/dashboards/`)
const insights = await listAll(`/api/environments/${id}/insights/?saved=true`)
const results = []
for (const def of DASHBOARDS) results.push(await upsertDashboard(id, def, dashboards, insights))

// Stündliche Fehler für die Warnung: eigenes Insight, nicht auf einem Dashboard
const hourly = { name: 'Fehler pro Stunde (Warnung)', query: trends([ev('$exception')], { interval: 'hour', from: '-24h' }) }
let hourlyId
if (await validate(id, hourly)) {
  const prev = insights.find((i) => i.name === hourly.name && !i.deleted)
  const body = { name: hourly.name, query: hourly.query, tags: ['teams-everywhere'], saved: true }
  hourlyId = prev ? (await api('PATCH', `/api/environments/${id}/insights/${prev.id}/`, body)).id : (await api('POST', `/api/environments/${id}/insights/`, body)).id
}
await upsertAlert(id, hourlyId, me.id)

const ingest = HOST.includes('://eu.') ? 'https://eu.i.posthog.com' : HOST.includes('://us.') ? 'https://us.i.posthog.com' : HOST
console.log('\nFertig.')
for (const r of results) console.log(`  ${r.dash.name}: ${HOST}/project/${id}/dashboard/${r.dash.id}`)
console.log(`\nFür den Build (Repository-Variablen, siehe docs/analytics.md):\n  POSTHOG_KEY=${project.api_token}\n  POSTHOG_HOST=${ingest}`)
