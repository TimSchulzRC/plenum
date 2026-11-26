import DOMPurify from 'dompurify'
import { needsProxy, proxyUrl } from './media'
import { messageTime } from './format'
import catalog from './teams-emoji.json'

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

// Teams-HTML in sicheres, darstellbares HTML umwandeln.
export function renderMessageHtml(html: string, accountId: string, myName?: string): string {
  if (!html) return ''
  let s = html
  // Erwähnungen
  s = s.replace(/<at\b[^>]*>([\s\S]*?)<\/at>/gi, (_m, inner: string) => `<span class="mention">${inner}</span>`)
  // Neue Emoji-Syntax <emoji alt="👍">
  s = s.replace(/<emoji\b[^>]*\balt="([^"]*)"[^>]*>(?:<\/emoji>)?/gi, '$1')
  // Code-Blöcke
  s = s.replace(/<codeblock\b[^>]*>/gi, '<pre>').replace(/<\/codeblock>/gi, '</pre>')
  // Emoticons: Bild durch Unicode-Alt-Text ersetzen, wenn vorhanden
  s = s.replace(/<span[^>]*class="animated-emoticon[^"]*"[^>]*>\s*<img[^>]*\balt="([^"]+)"[^>]*>\s*<\/span>/gi, '$1')

  const clean = DOMPurify.sanitize(s, {
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select'],
    FORBID_ATTR: ['style', 'id', 'onerror', 'onload'],
    ADD_ATTR: ['target', 'itemtype', 'itemid', 'itemprop', 'itemscope'],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true
  }) as DocumentFragment

  clean.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') ?? ''
    if (isEmojiImage(img)) {
      img.classList.add('emoji')
      return
    }
    if (needsProxy(src)) img.setAttribute('src', proxyUrl(accountId, src))
    img.setAttribute('loading', 'lazy')
    fitImage(img, Number(img.getAttribute('width')), Number(img.getAttribute('height')))
    img.classList.add('msg-image')
  })
  // Nur eigene Klassen behalten
  const OWN = new Set(['mention', 'emoji', 'msg-image'])
  clean.querySelectorAll('[class]').forEach((el) => {
    const keep = [...el.classList].filter((c) => OWN.has(c))
    if (keep.length) el.setAttribute('class', keep.join(' '))
    else el.removeAttribute('class')
  })
  if (myName) {
    const first = myName.split(/[\s,]+/)[0]?.toLowerCase()
    clean.querySelectorAll('.mention').forEach((el) => {
      const t = (el.textContent ?? '').toLowerCase()
      if (t && (myName.toLowerCase().startsWith(t) || t === first)) el.classList.add('me')
    })
  }
  formatQuotes(clean)
  const wrapper = document.createElement('div')
  wrapper.appendChild(clean)
  return wrapper.innerHTML
}

// Bilder im Chat höchstens 400 × 300. Die Größe steht als width/height am Bild, damit die
// Sprechblase sie kennt: Ein max-width in Prozent zählt für ihre Breite nicht, sie würde
// sonst so breit wie das Originalbild. Ohne Angabe setzt MessageBody sie nach dem Laden.
export function fitImage(img: HTMLImageElement, w: number, h: number): void {
  if (!(w > 0 && h > 0)) {
    img.removeAttribute('width')
    img.removeAttribute('height')
    return
  }
  const scale = Math.min(1, 400 / w, 300 / h)
  img.setAttribute('width', String(Math.max(1, Math.round(w * scale))))
  img.setAttribute('height', String(Math.max(1, Math.round(h * scale))))
}

function isEmojiImage(img: Element): boolean {
  const src = img.getAttribute('src') ?? ''
  return /Emoji/i.test(img.getAttribute('itemtype') ?? '') || /emoticon|personal-expressions|\/emoji/i.test(src)
}

// Nachricht besteht nur aus Bildern, ohne Text: Dann zeigt der Chat sie ohne Sprechblase.
export function isImageOnly(html: string): boolean {
  // <emoji alt="👍"> hat keinen Textinhalt, wird beim Anzeigen aber zu Text
  if (!/<img\b/i.test(html) || /<emoji\b/i.test(html)) return false
  const doc = new DOMParser().parseFromString(html, 'text/html')
  if ((doc.body.textContent ?? '').replace(/[\s\u00a0\u200b]/g, '') !== '') return false
  const imgs = [...doc.body.querySelectorAll('img')]
  return imgs.length > 0 && imgs.every((i) => !isEmojiImage(i))
}

// Zitate (Teams „Antworten“): Kopf mit Name und Zeit, Vorschautext, Sprungziel
function formatQuotes(root: DocumentFragment): void {
  root.querySelectorAll('blockquote[itemtype*="schema.skype.com/Reply"]').forEach((q) => {
    const id = q.getAttribute('itemid') ?? ''
    const nameEl = q.querySelector('[itemprop="mri"]')
    const timeEl = q.querySelector('[itemprop="time"]')
    const name = nameEl?.textContent?.trim() ?? ''
    const ts = Number(timeEl?.getAttribute('itemid') || id)
    nameEl?.remove()
    timeEl?.remove()
    const head = document.createElement('div')
    head.className = 'quote-head'
    const b = document.createElement('b')
    b.textContent = name
    head.appendChild(b)
    if (ts > 1e12) {
      const t = document.createElement('span')
      t.textContent = messageTime(ts)
      head.appendChild(t)
    }
    q.prepend(head)
    q.querySelectorAll('[itemprop="preview"]').forEach((p) => p.classList.add('quote-text'))
    q.classList.add('quote')
    if (/^\d+$/.test(id)) q.setAttribute('data-mid', id)
  })
}

export function textToHtml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc
    .split('\n')
    .map((l) => `<p>${linkify(l) || '&nbsp;'}</p>`)
    .join('')
}

function linkify(s: string): string {
  return s.replace(/\bhttps?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`)
}

export const REACTIONS: { key: string; emoji: string; label: string }[] = [
  { key: 'like', emoji: '👍', label: 'Gefällt mir' },
  { key: 'heart', emoji: '❤️', label: 'Herz' },
  { key: 'laugh', emoji: '😆', label: 'Lachen' },
  { key: 'surprised', emoji: '😮', label: 'Überrascht' },
  { key: 'sad', emoji: '🙁', label: 'Traurig' },
  { key: 'angry', emoji: '😠', label: 'Wütend' }
]

// Ältere Schlüssel, die im Teams-Katalog fehlen
const EXTRA: Record<string, string> = {
  thinking: '🤔',
  pray: '🙏',
  tada: '🎉',
  rocket: '🚀',
  eyes: '👀'
}

export interface TeamsEmoji {
  id: string
  emoji: string
  name: string
  search: string
}

// Emoji-Katalog von Teams (scripts/teams-emoji.mjs). Die ID ist der Schlüssel der Reaktion.
export const EMOJI_CATEGORIES: { title: string; items: TeamsEmoji[] }[] = catalog.categories.map((c) => ({
  title: c.title,
  items: c.items.map(([id, emoji, name, search]) => ({ id, emoji, name, search }))
}))

const CATALOG = new Map<string, string>(Object.entries(catalog.aliases))
for (const c of EMOJI_CATEGORIES) for (const e of c.items) CATALOG.set(e.id, e.emoji)

// Hautton 1–5 hängt Teams als "-tone3" an die ID
function withTone(emoji: string, tone: number): string {
  const [first, ...rest] = [...emoji]
  if (rest[0] === '\ufe0f') rest.shift()
  return first + String.fromCodePoint(0x1f3fa + tone) + rest.join('')
}

export function reactionEmoji(key: string): string {
  const r = REACTIONS.find((x) => x.key === key)
  if (r) return r.emoji
  const known = CATALOG.get(key) ?? EXTRA[key]
  if (known) return known
  const tone = key.match(/^(.+?)-tone-?([1-5])$/)
  if (tone) {
    const base = CATALOG.get(tone[1])
    if (base) return withTone(base, Number(tone[2]))
  }
  // Unbekannte Schlüssel wie "1f44d_thumbsup" oder "1f600-1f3fb_..." tragen den Code selbst
  const m = key.match(/^([0-9a-f]{4,6}(?:[-_][0-9a-f]{4,6})*)(?:_|$)/i)
  if (m) {
    try {
      return m[1]
        .split(/[-_]/)
        .filter((p) => /^[0-9a-f]{4,6}$/i.test(p))
        .map((p) => String.fromCodePoint(parseInt(p, 16)))
        .join('')
    } catch {
      /* ignore */
    }
  }
  return '👍'
}

export const EMOJI_PICKER = [
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🙂', '😉', '😊', '😇', '🥰', '😍', '😘', '😋', '😜',
  '🤪', '🤔', '🤨', '😐', '🙄', '😏', '😬', '😴', '😎', '🤓', '😕', '😟', '😮', '😲', '😢', '😭',
  '😱', '😡', '🤯', '🥳', '👍', '👎', '👏', '🙌', '🙏', '💪', '👋', '🤝', '✌️', '👌', '🤞', '👀',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🔥', '✨', '🎉', '🎂', '☕', '🍺', '🚀', '✅', '❌', '⚠️'
]
