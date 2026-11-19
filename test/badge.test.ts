import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountBadge, chatBadge, dockBadge, unreadChats, unreadTeams } from '../src/shared/badge.ts'
import type { ChatSummary, Team } from '../src/shared/types.ts'

const chat = (id: string, extra: Partial<ChatSummary> = {}): ChatSummary => ({ id, kind: 'group', title: id, members: [], lastActivity: 0, unread: true, ...extra })
const team = (id: string, unread: boolean): Team => ({ id, displayName: id, channels: [], unread })

test('stummgeschaltete und ausgeblendete Chats zählen nicht', () => {
  assert.equal(unreadChats([chat('a'), chat('b', { muted: true }), chat('c', { hidden: true }), chat('d', { unread: false })]), 1)
})

test('Teams zählen einmal, egal wie viele Kanäle ungelesen sind', () => {
  assert.equal(unreadTeams([team('a', true), team('b', false), team('c', true)]), 2)
})

test('Dock-Symbol zeigt die Summe der Punkte in der Leiste aller Konten', () => {
  const work = { unread: 2, teamsUnread: 1, activityUnread: 3 }
  const other = { unread: 0, teamsUnread: 4, activityUnread: 0 }
  assert.equal(chatBadge(work), 3)
  assert.equal(accountBadge(work), 6)
  // vorher fehlten die Teams: 2 + 3 + 0 + 0 = 5 statt 10
  assert.equal(dockBadge([work, other]), 10)
})
