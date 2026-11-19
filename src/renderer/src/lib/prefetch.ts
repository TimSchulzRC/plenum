import { useEffect, useMemo, useRef } from 'react'
import type { ChannelThread, Message } from '@shared/types'
import { api, onEvent } from '../api'
import { hoverIntent, PrefetchCache } from './cache'

// Wartezeit auf einem Eintrag, bevor vorgeladen wird. Kurz genug, dass der Chat
// beim Klick meist schon da ist, lang genug, dass ein Wischen über die Liste nichts lädt.
export const HOVER_DELAY = 100

export const messageCache = new PrefetchCache<Message[]>({ maxEntries: 40, freshMs: 30_000 })
export const horizonCache = new PrefetchCache<Record<string, number>>({ maxEntries: 40, freshMs: 15_000 })
export const channelCache = new PrefetchCache<ChannelThread[]>({ maxEntries: 20, freshMs: 30_000 })
export const replyCache = new PrefetchCache<Message[]>({ maxEntries: 40, freshMs: 30_000 })

export const cacheKey = (accountId: string, id: string): string => `${accountId}|${id}`

let listening = false
function listen(): void {
  if (listening) return
  listening = true
  // Neue Nachrichten: Daten bleiben für die Anzeige, werden aber beim nächsten Hover neu geholt
  onEvent('conversation-updated', ({ accountId, conversationIds }) => {
    for (const id of conversationIds) {
      const key = cacheKey(accountId, id)
      messageCache.markStale(key)
      horizonCache.markStale(key)
      channelCache.markStale(key)
    }
  })
  onEvent('read-receipts', ({ accountId, conversationIds }) => {
    for (const id of conversationIds) horizonCache.markStale(cacheKey(accountId, id))
  })
}

export function fetchMessages(accountId: string, conversationId: string): Promise<Message[]> {
  listen()
  return messageCache.load(cacheKey(accountId, conversationId), () => api.getMessages(accountId, conversationId))
}

export function fetchHorizons(accountId: string, conversationId: string): Promise<Record<string, number>> {
  listen()
  return horizonCache.load(cacheKey(accountId, conversationId), () => api.getReadHorizons(accountId, conversationId))
}

export function fetchChannel(accountId: string, teamId: string, channelId: string): Promise<ChannelThread[]> {
  listen()
  return channelCache.load(cacheKey(accountId, channelId), () => api.getChannelThreads(accountId, teamId, channelId))
}

export function fetchReplies(accountId: string, channelId: string, rootId: string): Promise<Message[]> {
  return replyCache.load(cacheKey(accountId, `${channelId};${rootId}`), () => api.getThreadReplies(accountId, channelId, rootId))
}

export function receiptsEnabled(chat: { kind: string; members: string[] }): boolean {
  return (chat.kind === 'oneOnOne' || chat.kind === 'group') && chat.members.length > 0 && chat.members.length <= 20
}

export function prefetchChat(accountId: string, chat: { id: string; kind: string; members: string[] }): void {
  if (!accountId) return
  listen()
  const key = cacheKey(accountId, chat.id)
  messageCache.prefetch(key, () => api.getMessages(accountId, chat.id))
  if (receiptsEnabled(chat)) horizonCache.prefetch(key, () => api.getReadHorizons(accountId, chat.id))
}

export function prefetchChannel(accountId: string, teamId: string, channelId: string): void {
  if (!accountId) return
  listen()
  channelCache.prefetch(cacheKey(accountId, channelId), () => api.getChannelThreads(accountId, teamId, channelId))
}

export function prefetchReplies(accountId: string, channelId: string, rootId: string): void {
  if (!accountId) return
  replyCache.prefetch(cacheKey(accountId, `${channelId};${rootId}`), () => api.getThreadReplies(accountId, channelId, rootId))
}

// Maus-Handler für ein Listenelement: lädt nach HOVER_DELAY ms oder sofort beim Drücken
export function useHoverPrefetch(fn: () => void): { onMouseEnter: () => void; onMouseLeave: () => void; onMouseDown: (e: { button: number }) => void } {
  const ref = useRef(fn)
  ref.current = fn
  const h = useMemo(() => hoverIntent(() => ref.current(), HOVER_DELAY), [])
  useEffect(() => h.cancel, [h])
  return useMemo(() => ({ onMouseEnter: h.onMouseEnter, onMouseLeave: h.onMouseLeave, onMouseDown: h.onMouseDown }), [h])
}
