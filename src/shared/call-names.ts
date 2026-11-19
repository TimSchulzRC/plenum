// Teilnehmernamen im Anruf. Die Engine liest sie aus den aria-labels der Teams-Kacheln,
// und Teams hängt dort Zustände, Rollen und Hinweise an, etwa
// "Boettcher External unfamiliar, Has control of production tools, Context menu is available".
import type { Person } from './types'

// Teile eines aria-labels (durch Komma getrennt), die kein Name sind
const STATE_PART = new RegExp(
  '^(?:' +
    [
      'muted',
      'unmuted',
      'stummgeschaltet',
      'nicht stummgeschaltet',
      'stummschaltung aufgehoben',
      'speaking',
      'spricht',
      'pinned',
      'angeheftet',
      'spotlighted',
      'im fokus',
      'hand raised',
      'raised hand',
      'hand gehoben',
      'presenting',
      'präsentiert',
      'organi[sz]er',
      'organisator(?:in)?',
      'presenter',
      'referent(?:in)?',
      'attendee',
      'guest',
      'gast',
      'external',
      'extern',
      'unverified',
      'unfamiliar',
      'nicht verifiziert',
      'fill frame',
      'fit to frame',
      'an rahmen anpassen',
      'rahmen füllen',
      'myself video',
      'mein video'
    ].join('|') +
    ')$' +
    // Ganze Sätze, die Teams anhängt
    '|context ?menu|kontextmenü|production tools|produktionstools|^(?:has|hat|is|ist) |^video |^kamera |^camera |background|hintergrund',
  'i'
)

// Hinweise, die Teams direkt an den Namen hängt ("Boettcher External unfamiliar", "Anna Berg (Gast)").
// Ohne Klammern nur englische Wörter, damit Nachnamen wie "Gast" erhalten bleiben.
const NAME_SUFFIX = /\s+(?:\((?:external|extern|unfamiliar|unverified|nicht verifiziert|guest|gast)\)|external|unfamiliar|unverified)$/i
const EXTERNAL_HINT = /^(external|extern|unfamiliar|unverified|nicht verifiziert|guest|gast)$/i

const SCREEN_SUFFIX = ' (Bildschirm)'

export interface CleanName {
  name: string
  external: boolean
}

export function cleanCallName(raw: string): CleanName {
  let text = (raw ?? '').trim()
  let suffix = ''
  if (text.endsWith(SCREEN_SUFFIX)) {
    suffix = SCREEN_SUFFIX
    text = text.slice(0, -SCREEN_SUFFIX.length).trim()
  }
  const parts = text.split(/,\s*/).map((p) => p.trim()).filter(Boolean)
  let external = false
  const kept: string[] = []
  let done = false
  for (const part of parts) {
    if (STATE_PART.test(part)) {
      if (EXTERNAL_HINT.test(part)) external = true
      // Alles nach dem ersten Zustand ist kein Name mehr, außer der Name stand gar nicht vorn
      if (kept.length) done = true
      continue
    }
    if (done || kept.length === 3) continue
    let p = part
    for (let m = p.match(NAME_SUFFIX); m && m.index! > 0; m = p.match(NAME_SUFFIX)) {
      external = true
      p = p.slice(0, m.index).trim()
    }
    kept.push(p)
  }
  const name = kept.join(', ')
  if (!name) return { name: raw.trim(), external }
  return { name: name + suffix, external }
}

// Vergleichsform: "Schulz, Tim" und "Tim Schulz" sind gleich
function nameKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)/g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean)
    .sort()
    .join(' ')
}

// Gastkonto im eigenen Verzeichnis (UPN wie "anna_firma.de#EXT#@tenant.onmicrosoft.com")
function isGuest(p: Person): boolean {
  return p.type === 'guest' || /#EXT#/i.test(p.upn ?? '')
}

// Aus Suchergebnissen die Person heraussuchen, die zum Namen im Anruf passt.
// Bei mehreren Personen gleichen Namens ist unklar, wer gemeint ist: dann keine.
// Externe Teilnehmer passen nur zu Gastkonten, nie zu einem internen Namensvetter.
export function matchPerson(name: string, people: Person[], external = false): Person | undefined {
  const key = nameKey(name)
  if (!key) return undefined
  const hits = new Map(people.filter((p) => nameKey(p.displayName ?? '') === key && (!external || isGuest(p))).map((p) => [p.mri, p]))
  return hits.size === 1 ? [...hits.values()][0] : undefined
}

// Suchanfragen für einen Namen: "Schulz, Tim" auch als "Tim Schulz"
export function nameQueries(name: string): string[] {
  const n = name.trim()
  const m = n.match(/^([^,]+),\s*([^,]+)$/)
  return m ? [n, `${m[2]} ${m[1]}`] : [n]
}
