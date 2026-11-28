import { Spinner } from '@fluentui/react-components'
import { useEffect, useMemo, useState } from 'react'
import { mergeByTime, type FromAccount } from '@shared/accounts'
import type { ActivityItem } from '@shared/types'
import { api, onEvent } from '../api'
import { AccountGroups, AccountTag, GroupToggle, NotLoaded, useAccounts, useGrouped } from '../components/AccountGroups'
import { PersonAvatar } from '../components/Avatars'
import { ConversationView } from '../components/ConversationView'
import { ipcErrorText } from '../lib/calendar'
import { listTime } from '../lib/format'
import { prefetchChannel, prefetchChat, useHoverPrefetch } from '../lib/prefetch'
import { useStore } from '../store'

const ICON: Record<string, { sym: string; color: string }> = {
  mention: { sym: '@', color: '#c4314b' },
  reply: { sym: '↩', color: '#5b5fc7' },
  reaction: { sym: '♥', color: '#e3008c' },
  like: { sym: '👍', color: '#5b5fc7' },
  call: { sym: '☎', color: '#c4314b' },
  meeting: { sym: '▶', color: '#5b5fc7' },
  membership: { sym: '+', color: '#13a10e' },
  other: { sym: '•', color: '#616161' }
}

type Loaded = { items?: ActivityItem[]; error?: string }
type Entry = FromAccount<ActivityItem>

// Aktivität aller Konten und Gastmandanten in einer Liste, neueste zuerst. Mit mehreren Konten trägt
// jeder Eintrag sein Konto, auf Wunsch steht jedes Konto in einem eigenen Block.
export function ActivityView(): JSX.Element {
  const { accounts, multi, color, byId } = useAccounts()
  const grouped = useGrouped('groupActivityByAccount')
  const activeId = useStore((s) => s.activeAccountId)
  const activityId = useStore((s) => (s.activeAccountId ? s.selection[s.activeAccountId]?.activityId : undefined))
  const [lists, setLists] = useState<Record<string, Loaded>>({})
  const readyKey = accounts
    .filter((a) => a.status === 'ready')
    .map((a) => a.id)
    .join(',')

  useEffect(() => {
    const ids = readyKey.split(',').filter(Boolean)
    let alive = true
    const load = (id: string) =>
      api
        .getActivity(id)
        .then((items) => alive && setLists((l) => ({ ...l, [id]: { items } })))
        .catch((e: unknown) => alive && setLists((l) => ({ ...l, [id]: { ...l[id], error: ipcErrorText(e) } })))
    for (const id of ids) void load(id)
    const off = onEvent('activity-updated', (e) => ids.includes(e.accountId) && void load(e.accountId))
    // Angesehen heißt gelesen, wie in Teams. Nur Konten mit ungelesenen Einträgen.
    const t = setTimeout(() => {
      for (const a of useStore.getState().accounts) if (ids.includes(a.id) && a.activityUnread > 0) void api.markActivityRead(a.id).catch(() => undefined)
    }, 2500)
    return () => {
      alive = false
      off()
      clearTimeout(t)
    }
  }, [readyKey])

  const entries = useMemo(() => mergeByTime(accounts.map((a) => ({ accountId: a.id, items: lists[a.id]?.items ?? [] }))), [accounts, lists])
  const selected = activityId ? entries.find((e) => e.accountId === activeId && e.item.id === activityId) : undefined
  const conv = selected?.item.conversationId
  const snapshot = useStore((s) => (selected ? s.snapshots[selected.accountId] : undefined))
  const chat = conv ? snapshot?.chats.find((c) => c.id === conv) : undefined
  const channelTeam = conv ? snapshot?.teams.find((t) => t.channels.some((c) => c.id === conv)) : undefined

  // Öffnet den Eintrag im Konto, zu dem er gehört. Kanäle öffnen in der Chat-Ansicht.
  const open = (e: Entry) => {
    const id = e.item.conversationId
    const team = id ? useStore.getState().snapshots[e.accountId]?.teams.find((t) => t.channels.some((c) => c.id === id)) : undefined
    if (team) {
      useStore.getState().open(e.accountId, { activityId: e.item.id, chatId: undefined, newChat: false, teamId: team.id, channelId: id, focusMessageId: e.item.messageId }, 'chat')
    } else useStore.getState().open(e.accountId, { activityId: e.item.id })
  }

  const row = (e: Entry, tag: boolean) => (
    <ActivityRow
      key={`${e.accountId}|${e.item.id}`}
      entry={e}
      selected={e === selected}
      tag={tag ? <AccountTag account={byId(e.accountId)} color={color(e.accountId)} /> : undefined}
      onSelect={() => open(e)}
    />
  )

  const loading = !!readyKey && !accounts.some((a) => lists[a.id]?.items || lists[a.id]?.error)
  // Konten ohne Liste: noch nicht verbunden oder Abruf gescheitert. Gruppiert steht das im Kopf bzw. im Block.
  const missing = accounts.filter((a) => !lists[a.id]?.items && (a.status !== 'ready' || lists[a.id]?.error))

  return (
    <>
      <div className="list-pane">
        <div className="list-header">
          <h1>Aktivität</h1>
          <GroupToggle setting="groupActivityByAccount" />
        </div>
        <div className={`list-scroll ${grouped ? 'multi' : ''}`}>
          {grouped ? (
            <AccountGroups accounts={accounts} storageKey="activity.closed" count={(a) => a.activityUnread}>
              {(a) => {
                const l = lists[a.id]
                const items = entries.filter((e) => e.accountId === a.id)
                if (items.length) return items.map((e) => row(e, false))
                if (l?.error) return <div className="group-note">Nicht geladen: {l.error}</div>
                if (a.status !== 'ready') return null
                if (!l) return <div className="group-note">Wird geladen …</div>
                return <div className="group-note">Keine neuen Aktivitäten.</div>
              }}
            </AccountGroups>
          ) : (
            <>
              {missing.length > 0 && !loading && <NotLoaded accounts={missing} lists={lists} what="Aktivitäten nicht geladen" />}
              {loading && (
                <div style={{ padding: 30, display: 'flex', justifyContent: 'center' }}>
                  <Spinner size="small" />
                </div>
              )}
              {!loading && entries.length === 0 && missing.length < accounts.length && <div className="group-note">Keine neuen Aktivitäten.</div>}
              {entries.map((e) => row(e, multi))}
            </>
          )}
        </div>
      </div>
      {chat && selected ? (
        <ConversationView key={`${selected.accountId}|${chat.id}`} chat={chat} />
      ) : (
        <div className="main-pane">
          <div className="empty-state">
            {selected && channelTeam ? <div>Wird im Kanal geöffnet …</div> : selected ? <div>{selected.item.preview}</div> : <div>Wähle eine Aktivität aus.</div>}
          </div>
        </div>
      )}
    </>
  )
}

function ActivityRow({ entry, selected, tag, onSelect }: { entry: Entry; selected: boolean; tag?: JSX.Element; onSelect: () => void }): JSX.Element {
  const { accountId, item: it } = entry
  // Unterhaltung vorladen, auf die die Aktivität zeigt
  const hover = useHoverPrefetch(() => {
    const id = it.conversationId
    const snapshot = useStore.getState().snapshots[accountId]
    if (!snapshot || !id) return
    const chat = snapshot.chats.find((c) => c.id === id)
    if (chat) return prefetchChat(accountId, chat)
    const team = snapshot.teams.find((t) => t.channels.some((c) => c.id === id))
    if (team) prefetchChannel(accountId, team.id, id)
  })
  const ic = ICON[it.type] ?? ICON.other
  return (
    <div className={`activity-item ${selected ? 'selected' : ''} ${it.read ? '' : 'unread'}`} onClick={onSelect} {...hover}>
      <PersonAvatar mri={it.actor} name={it.actorName || '?'} size={40} showPresence={false} accountId={accountId} />
      <span className="activity-icon" style={{ background: ic.color }}>
        {ic.sym}
      </span>
      <div className="a-body">
        <div style={{ display: 'flex', gap: 6 }}>
          <div className="a-title" style={{ flex: 1 }}>
            {it.actorName} {it.title}
          </div>
          <span className="a-time">{listTime(it.time)}</span>
        </div>
        {(tag || it.location) && (
          <div className="a-loc">
            {tag}
            {tag && it.location && <span className="a-sep">·</span>}
            {it.location}
          </div>
        )}
        <div className="a-prev">{it.preview}</div>
      </div>
    </div>
  )
}
