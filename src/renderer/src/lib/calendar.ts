// Ganztägige Termine haben kein Zeitpunkt-Datum, sondern Kalendertage. Graph und Outlook liefern sie
// mit outlook.timezone="UTC" als Mitternacht UTC. In Berlin wäre das 01:00 bis 01:00 am Folgetag,
// der Termin stünde dann an zwei Tagen. Liegt der Wert genau auf Mitternacht UTC, zählt deshalb das
// UTC-Datum, sonst das lokale.
function calendarDay(ms: number): number {
  const d = new Date(ms)
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function allDayOn(ev: { start: number; end: number }, day: Date): boolean {
  const d = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
  const first = calendarDay(ev.start)
  // Ende ist exklusiv (Mitternacht des Folgetags). Ein Termin ohne Dauer belegt trotzdem seinen Tag.
  const end = Math.max(calendarDay(ev.end), first + 1)
  return first <= d && d < end
}

// Stunden seit Mitternacht nach der Uhr an der Wand. An Tagen mit Zeitumstellung hat der Tag 23 oder
// 25 Stunden, das Raster aber immer 24 Zeilen. Gerechnet in Millisekunden seit Mitternacht stünden
// Termine nach der Umstellung eine Stunde daneben.
export function wallHours(ms: number): number {
  const d = new Date(ms)
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600
}
