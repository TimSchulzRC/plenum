// Holt den Emoji-Katalog von Teams und schreibt ihn kompakt nach
// src/renderer/src/lib/teams-emoji.json. Die ID eines Eintrags ist zugleich der Schlüssel,
// den Teams für eine Reaktion speichert (like, cwl, 1f389_partypopper …). Nur mit diesen IDs
// zeigen der offizielle Client und wir dieselbe Reaktion.
//
// Aufruf: pnpm run teams-emoji. Danach die geänderte JSON-Datei mit einchecken.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'https://statics.teams.cdn.office.net/evergreen-assets/personal-expressions/v1/metadata/a098bcb732fd7dd80ce11c12ad15767f'

async function load(locale) {
  const res = await fetch(`${BASE}/${locale}.json`)
  if (!res.ok) throw new Error(`${locale}: HTTP ${res.status}`)
  return (await res.json()).categories
}

const [de, en] = await Promise.all([load('de-de'), load('en-us')])
const english = new Map(en.flatMap((c) => c.emoticons).map((e) => [e.id, e]))

const words = (list) => (list ?? []).map((w) => String(w).trim().toLowerCase()).filter(Boolean)

const seen = new Set()
const categories = []
// IDs, die dasselbe Zeichen wie ein Eintrag im Picker haben (like und yes sind beide 👍).
// Der Picker zeigt jedes Zeichen nur einmal, Reaktionen anderer kommen aber mit jeder ID.
const aliases = {}
for (const cat of de) {
  const items = []
  for (const e of cat.emoticons) {
    if (!e.unicode) continue
    if (seen.has(e.unicode)) {
      aliases[e.id] = e.unicode
      continue
    }
    seen.add(e.unicode)
    const en = english.get(e.id)
    const search = [...new Set([...words(e.description?.split(/\s+/)), ...words(e.keywords), ...words(en?.description?.split(/\s+/)), ...words(en?.keywords)])]
    items.push([e.id, e.unicode, e.description ?? en?.description ?? e.id, search.join(' ')])
  }
  categories.push({ title: cat.title, items })
}

const out = join(root, 'src/renderer/src/lib/teams-emoji.json')
writeFileSync(out, JSON.stringify({ categories, aliases }) + '\n')
console.log(`${categories.reduce((n, c) => n + c.items.length, 0)} Emojis, ${Object.keys(aliases).length} Aliase → ${out}`)
