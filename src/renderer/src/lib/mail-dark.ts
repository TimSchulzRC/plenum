// Mails sind für hellen Hintergrund gebaut. Im dunklen Theme kehrt die App die Helligkeit jeder
// Farbangabe um (Weiß wird #292929, Schwarz #dbdbdb), Farbton und Sättigung bleiben. Bilder fasst
// sie nicht an. Ein CSS-Filter über die ganze Mail würde auch Bilder und Emojis verfärben.

const NAMED: Record<string, string> = {
  black: '000000',
  windowtext: '000000',
  white: 'ffffff',
  gray: '808080',
  grey: '808080',
  silver: 'c0c0c0',
  red: 'ff0000',
  maroon: '800000',
  darkred: '8b0000',
  orange: 'ffa500',
  yellow: 'ffff00',
  olive: '808000',
  lime: '00ff00',
  green: '008000',
  darkgreen: '006400',
  teal: '008080',
  aqua: '00ffff',
  blue: '0000ff',
  navy: '000080',
  darkblue: '00008b',
  purple: '800080',
  fuchsia: 'ff00ff'
}

const TOKEN = new RegExp(`#[0-9a-f]{3,8}\\b|rgba?\\([^)]*\\)|(?<![\\w.#-])(?:${Object.keys(NAMED).join('|')})(?![\\w-])`, 'gi')

function parse(c: string): [number, number, number, number] | undefined {
  const s = c.trim().toLowerCase()
  let hex = NAMED[s] ?? (s.startsWith('#') ? s.slice(1) : undefined)
  if (hex !== undefined) {
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((x) => x + x).join('')
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(hex)) return undefined
    const n = (i: number) => parseInt(hex!.slice(i, i + 2), 16)
    return [n(0), n(2), n(4), hex.length === 8 ? n(6) / 255 : 1]
  }
  const m = /^rgba?\(([^)]*)\)$/.exec(s)
  if (!m) return undefined
  const parts = m[1].split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 3) return undefined
  const num = (p: string, max: number) => (p.endsWith('%') ? (parseFloat(p) / 100) * max : parseFloat(p))
  const [r, g, b] = parts.slice(0, 3).map((p) => num(p, 255))
  const a = parts[3] === undefined ? 1 : num(parts[3], 1)
  return [r, g, b, a].some(Number.isNaN) ? undefined : [r, g, b, a]
}

export function darkColor(c: string): string | undefined {
  const rgba = parse(c)
  if (!rgba) return undefined
  const [r, g, b] = rgba.slice(0, 3).map((x) => Math.min(255, Math.max(0, x)) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  // HSL zurück mit umgekehrter Helligkeit
  const l2 = 0.16 + 0.7 * (1 - l)
  const c2 = (1 - Math.abs(2 * l2 - 1)) * s
  const x = c2 * (1 - Math.abs((h % 2) - 1))
  const [r1, g1, b1] = h < 1 ? [c2, x, 0] : h < 2 ? [x, c2, 0] : h < 3 ? [0, c2, x] : h < 4 ? [0, x, c2] : h < 5 ? [x, 0, c2] : [c2, 0, x]
  const out = [r1, g1, b1].map((v) => Math.round((v + l2 - c2 / 2) * 255))
  const a = rgba[3]
  return a < 1 ? `rgba(${out.join(', ')}, ${a})` : '#' + out.map((v) => v.toString(16).padStart(2, '0')).join('')
}

// Nur Werte nach einem Doppelpunkt, damit Selektoren wie .red oder Klassennamen heil bleiben
export function darkCss(css: string): string {
  return css.replace(/:([^;{}]*)/g, (_, value: string) => ':' + value.replace(TOKEN, (t) => darkColor(t) ?? t))
}
