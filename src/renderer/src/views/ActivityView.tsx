import { Spinner } from '@fluentui/react-components'
import { useEffect, useState } from 'react'
import type { ActivityItem } from '@shared/types'
import { api, onEvent } from '../api'
import { PersonAvatar } from '../components/Avatars'
import { ConversationView } from '../components/ConversationView'
import { listTime } from '../lib/format'
import { prefetchChannel, prefetchChat, useHoverPrefetch } from '../lib/prefetch'
import { useActive, useStore } from '../store'

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

export function ActivityView(): JSX.Element {
  const { account, snapshot, selection } = useActive()
  const [items, setItems] = useState<ActivityItem[] | null>(null)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!account) return
    let alive = true
    const load = () =>
      api
        .getActivity(account.id)
        .then((r) => alive && (setItems(r), setError(undefined)))
        .catch((e: Error) => alive && setError(e.message))
    void load()
    const off = onEvent('activity-updated', (e) => e.accountId === account.id && void load())
    const t = setTimeout(() => void api.markActivityRead(account.id).catch(() => undefined), 2500)
    return () => {
      alive = false
      off()
      clearTimeout(t)
    }
  }, [account?.id])

  const selected = items?.find((i) => i.id === selection.activityId)
  const chat = selected?.conversationId ? snapshot?.chats.find((c) => c.id === selected.conversationId) : undefined
  const channelTeam = selected?.conversationId ? snapshot?.teams.find((t) => t.channels.some((c) => c.id === selected.conversationId)) : undefined

  return (
    <>
      <div className="list-pane">
        <div className="list-header">
          <h1>Aktivität</h1>
        </div>
        <div className="list-scroll">
          {!items && !error && (
            <div style={{ padding: 30, display: 'flex', justifyContent: 'center' }}>
              <Spinner size="small" />
            </div>
          )}
          {error && <div style={{ padding: 20, color: 'var(--fg-3)', fontSize: 13 }}>Aktivitäten konnten nicht geladen werden: {error}</div>}
          {items?.length === 0 && <div style={{ padding: 20, color: 'var(--fg-3)', fontSize: 13 }}>Keine neuen Aktivitäten.</div>}
          {items?.map((it) => {
            const ic = ICON[it.type] ?? ICON.other
            return (
              <ActivityRow
                key={it.id}
                item={it}
                className={`activity-item ${it.id === selection.activityId ? 'selected' : ''} ${it.read ? '' : 'unread'}`}
                onClick={() => {
                  useStore.getState().select({ activityId: it.id })
                  const isChannel = snapshot?.teams.some((t) => t.channels.some((c) => c.id === it.conversationId))
                  if (isChannel) {
                    const team = snapshot?.teams.find((t) => t.channels.some((c) => c.id === it.conversationId))
                    useStore.getState().select({ chatId: undefined, newChat: false, teamId: team?.id, channelId: it.conversationId, focusMessageId: it.messageId }, 'chat')
                  }
                }}
              >
                <PersonAvatar mri={it.actor} name={it.actorName || '?'} size={40} showPresence={false} />
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
                  {it.location && <div className="a-loc">{it.location}</div>}
                  <div className="a-prev">{it.preview}</div>
                </div>
              </ActivityRow>
            )
          })}
        </div>
      </div>
      {chat ? (
        <ConversationView key={`${account?.id}|${chat.id}`} chat={chat} />
      ) : (
        <div className="main-pane">
          <div className="empty-state">
            {selected && channelTeam ? <div>Wird im Kanal geöffnet …</div> : selected ? <div>{selected.preview}</div> : <div>Wähle eine Aktivität aus.</div>}
          </div>
        </div>
      )}
    </>
  )
}

// Vorladen der Unterhaltung, auf die eine Aktivität zeigt
function ActivityRow({ item, children, ...props }: { item: ActivityItem; className: string; onClick: () => void; children: React.ReactNode }): JSX.Element {
  const { account, snapshot } = useActive()
  const hover = useHoverPrefetch(() => {
    const id = item.conversationId
    if (!account || !snapshot || !id) return
    const chat = snapshot.chats.find((c) => c.id === id)
    if (chat) return prefetchChat(account.id, chat)
    const team = snapshot.teams.find((t) => t.channels.some((c) => c.id === id))
    if (team) prefetchChannel(account.id, team.id, id)
  })
  return (
    <div {...props} {...hover}>
      {children}
    </div>
  )
}
