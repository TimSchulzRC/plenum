import { format, isSameDay, isSameYear, isToday, isYesterday, differenceInCalendarDays } from 'date-fns'
import { de } from 'date-fns/locale'

export function listTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  if (isToday(d)) return format(d, 'HH:mm')
  if (isYesterday(d)) return 'Gestern'
  if (differenceInCalendarDays(new Date(), d) < 7) return format(d, 'EEEE', { locale: de })
  if (isSameYear(d, new Date())) return format(d, 'd.M.', { locale: de })
  return format(d, 'd.M.yy', { locale: de })
}

export function messageTime(ms: number): string {
  const d = new Date(ms)
  if (isToday(d)) return format(d, 'HH:mm')
  if (isYesterday(d)) return `Gestern ${format(d, 'HH:mm')}`
  if (isSameYear(d, new Date())) return format(d, 'd.M. HH:mm', { locale: de })
  return format(d, 'd.M.yyyy HH:mm', { locale: de })
}

export function dayLabel(ms: number): string {
  const d = new Date(ms)
  if (isToday(d)) return 'Heute'
  if (isYesterday(d)) return 'Gestern'
  if (isSameYear(d, new Date())) return format(d, 'EEEE, d. MMMM', { locale: de })
  return format(d, 'EEEE, d. MMMM yyyy', { locale: de })
}

export function sameDay(a: number, b: number): boolean {
  return isSameDay(new Date(a), new Date(b))
}

export function clock(ms: number): string {
  return format(new Date(ms), 'HH:mm')
}

export function fmt(ms: number, pattern: string): string {
  return format(new Date(ms), pattern, { locale: de })
}

export function duration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

export function initials(name: string): string {
  const parts = name.replace(/\(.*?\)/g, '').trim().split(/[\s,]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (name.includes(',') && parts.length >= 2) return (parts[1][0] + parts[0][0]).toUpperCase()
  return ((parts[0][0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}
