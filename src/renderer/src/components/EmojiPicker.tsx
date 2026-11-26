import { Search20Regular } from '@fluentui/react-icons'
import { useMemo, useRef, useState } from 'react'
import { EMOJI_CATEGORIES, type TeamsEmoji } from '../lib/html'

const RECENT_KEY = 'emoji-recent'
const RECENT_MAX = 16
const BY_ID = new Map(EMOJI_CATEGORIES.flatMap((c) => c.items.map((e) => [e.id, e] as const)))

function loadRecent(): TeamsEmoji[] {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(ids) ? ids.map((id) => BY_ID.get(String(id))).filter((e): e is TeamsEmoji => !!e) : []
  } catch {
    return []
  }
}

function remember(id: string): void {
  try {
    const ids = [id, ...loadRecent().map((e) => e.id).filter((x) => x !== id)].slice(0, RECENT_MAX)
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids))
  } catch {
    /* ohne Speicher eben ohne Verlauf */
  }
}

// Alle Emojis aus dem Teams-Katalog, mit Suche (deutsch und englisch) und den zuletzt gewählten oben.
// onPick bekommt die Teams-ID, den Schlüssel der Reaktion.
export function EmojiPicker({ onPick }: { onPick: (id: string) => void }): JSX.Element {
  const [q, setQ] = useState('')
  const [recent] = useState(loadRecent)
  const body = useRef<HTMLDivElement>(null)

  const sections = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length) {
      const hits = EMOJI_CATEGORIES.flatMap((c) => c.items).filter((e) => words.every((w) => e.search.includes(w)))
      return [{ title: hits.length ? 'Suchergebnisse' : 'Nichts gefunden', items: hits }]
    }
    return recent.length ? [{ title: 'Zuletzt verwendet', items: recent }, ...EMOJI_CATEGORIES] : EMOJI_CATEGORIES
  }, [q, recent])

  const pick = (e: TeamsEmoji) => {
    remember(e.id)
    onPick(e.id)
  }

  return (
    <div className="emoji-picker">
      <div className="search-box">
        <Search20Regular />
        <input
          autoFocus
          placeholder="Emoji suchen"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && q.trim() && sections[0].items[0]) pick(sections[0].items[0])
          }}
        />
      </div>
      {!q.trim() && (
        <div className="emoji-tabs">
          {EMOJI_CATEGORIES.map((c, i) => (
            <button
              key={c.title}
              title={c.title}
              onClick={() => body.current?.querySelector(`[data-cat="${i}"]`)?.scrollIntoView({ block: 'start' })}
            >
              {c.items[0]?.emoji}
            </button>
          ))}
        </div>
      )}
      <div className="emoji-body" ref={body}>
        {sections.map((s) => (
          <section key={s.title} data-cat={EMOJI_CATEGORIES.indexOf(s as (typeof EMOJI_CATEGORIES)[number])}>
            <div className="emoji-cat">{s.title}</div>
            <div className="emoji-grid">
              {s.items.map((e) => (
                <button key={e.id} title={e.name} onClick={() => pick(e)}>
                  {e.emoji}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
