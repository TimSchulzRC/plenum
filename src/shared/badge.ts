// Ungelesen-Zähler. Leiste, Kontomenü und Dock-Symbol zählen alle mit diesen Funktionen,
// damit die Zahl am App-Symbol der Summe der Punkte in der App entspricht.
import type { ChatSummary, Team } from './types'

// Chats mit Punkt in der Chatliste: stummgeschaltete und ausgeblendete zeigen keinen.
export function unreadChats(chats: Iterable<ChatSummary>): number {
  let n = 0
  for (const c of chats) if (c.unread && !c.muted && !c.hidden) n++
  return n
}

// Teams mit ungelesenem Beitrag in einem angezeigten Kanal (Team.unread)
export function unreadTeams(teams: Iterable<Team>): number {
  let n = 0
  for (const t of teams) if (t.unread) n++
  return n
}

export interface UnreadCounts {
  unread: number
  teamsUnread: number
  activityUnread: number
}

// Zahl am Chat-Symbol der Leiste
export function chatBadge(a: UnreadCounts): number {
  return a.unread + a.teamsUnread
}

// Alle Punkte eines Kontos: Aktivität plus Chat
export function accountBadge(a: UnreadCounts): number {
  return a.activityUnread + chatBadge(a)
}

// Zahl am Dock-Symbol: alle Konten zusammen
export function dockBadge(accounts: Iterable<UnreadCounts>): number {
  let n = 0
  for (const a of accounts) n += accountBadge(a)
  return n
}
