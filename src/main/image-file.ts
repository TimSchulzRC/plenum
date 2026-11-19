// Hilfen für "Bild kopieren/herunterladen" ohne Electron-Abhängigkeit, damit die Tests sie laden können.

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif'
}

export function imageExtension(type: string): string {
  return EXT[type.split(';')[0].trim().toLowerCase()] ?? 'png'
}

// "Bild 2026-11-19 14.05.33.png", wie macOS Bildschirmfotos benennt
export function imageFileName(type: string, at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const day = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`
  const time = `${p(at.getHours())}.${p(at.getMinutes())}.${p(at.getSeconds())}`
  return `Bild ${day} ${time}.${imageExtension(type)}`
}

export function parseDataUrl(src: string): { type: string; data: Buffer } | null {
  const m = src.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]*)$/i)
  if (!m) return null
  return { type: m[1].toLowerCase(), data: Buffer.from(m[2].replace(/\s+/g, ''), 'base64') }
}
