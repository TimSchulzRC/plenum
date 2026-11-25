import { Spinner } from '@fluentui/react-components'
import { ChevronDown16Regular, ChevronRight16Regular, LockClosed12Regular, ArrowReply16Regular } from '@fluentui/react-icons'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Channel, ChannelThread, Message, Team } from '@shared/types'
import { api, onEvent } from '../api'
import { PersonAvatar, TeamAvatar } from '../components/Avatars'
import { Composer } from '../components/Composer'
import { MessageBody, Reactions } from '../components/MessageItem'
import { messageTime } from '../lib/format'
import { cacheKey, channelCache, fetchChannel, fetchReplies, prefetchChannel, replyCache, prefetchReplies, useHoverPrefetch } from '../lib/prefetch'
import { personName, useActive, useStore } from '../store'

export function TeamsView(): JSX.Element {
  const { snapshot, selection } = useActive()
  const team = snapshot?.teams.find((t) => t.id === selection.teamId)
  const channel = team?.channels.find((c) => c.id === selection.channelId)
  return (
    <>
      <TeamsList />
      {team && channel ? (
        <ChannelView key={`${snapshot?.accountId}|${channel.id}`} team={team} channel={channel} />
      ) : (
        <div className="main-pane">
          <div className="empty-state">
            <h2>Teams</h2>
            <div>Wähle links einen Kanal aus.</div>
          </div>
        </div>
      )}
    </>
  )
}

function TeamsList(): JSX.Element {
  const { snapshot, selection } = useActive()
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const teams = (snapshot?.teams ?? []).filter((t) => !t.isArchived)
  const archived = (snapshot?.teams ?? []).filter((t) => t.isArchived)

  useEffect(() => {
    if (selection.teamId) setOpen((o) => ({ ...o, [selection.teamId!]: true }))
  }, [selection.teamId])

  const renderTeam = (t: Team) => {
    const isOpen = open[t.id] ?? t.id === selection.teamId
    return (
      <div key={t.id}>
        <div className="team-row" onClick={() => setOpen({ ...open, [t.id]: !isOpen })}>
          {isOpen ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
          <TeamAvatar team={t} size={28} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: t.unread ? 700 : 600 }}>{t.displayName}</span>
        </div>
        {isOpen &&
          t.channels
            .filter((c) => c.isFavorite || c.id === selection.channelId || c.isGeneral)
            .map((c) => (
              <TeamChannelRow key={c.id} team={t} channel={c} selected={c.id === selection.channelId} />
            ))}
        {isOpen && t.channels.some((c) => !c.isFavorite && !c.isGeneral && c.id !== selection.channelId) && (
          <HiddenChannels team={t} selected={selection.channelId} />
        )}
      </div>
    )
  }

  return (
    <div className="list-pane">
      <div className="list-header">
        <h1>Teams</h1>
      </div>
      <div className="list-scroll">
        {!snapshot && <div style={{ padding: 20, color: 'var(--fg-3)' }}>Teams werden geladen …</div>}
        {snapshot && teams.length === 0 && <div style={{ padding: 20, color: 'var(--fg-3)', fontSize: 13 }}>Du bist in keinem Team.</div>}
        {teams.map(renderTeam)}
        {archived.length > 0 && <div className="section-title">Archiviert</div>}
        {archived.map(renderTeam)}
      </div>
    </div>
  )
}

function HiddenChannels({ team, selected }: { team: Team; selected?: string }): JSX.Element {
  const [show, setShow] = useState(false)
  const hidden = team.channels.filter((c) => !c.isFavorite && !c.isGeneral && c.id !== selected)
  if (!show)
    return (
      <div className="channel-row" style={{ color: 'var(--fg-3)', fontSize: 13 }} onClick={() => setShow(true)}>
        {hidden.length} ausgeblendete Kanäle
      </div>
    )
  return (
    <>
      {hidden.map((c) => (
        <TeamChannelRow key={c.id} team={team} channel={c} dim />
      ))}
    </>
  )
}

function TeamChannelRow({ team, channel, selected, dim }: { team: Team; channel: Channel; selected?: boolean; dim?: boolean }): JSX.Element {
  const accountId = useStore((s) => s.activeAccountId ?? '')
  const hover = useHoverPrefetch(() => prefetchChannel(accountId, team.id, channel.id))
  return (
    <div
      className={`channel-row ${selected ? 'selected' : ''} ${channel.unread ? 'unread' : ''}`}
      onClick={() => useStore.getState().select({ teamId: team.id, channelId: channel.id })}
      {...hover}
    >
      <span style={dim ? { flex: 1, opacity: 0.8 } : { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{channel.displayName}</span>
      {channel.membershipType === 'private' && <LockClosed12Regular />}
    </div>
  )
}

export function ChannelView({ team, channel }: { team: Team; channel: Channel }): JSX.Element {
  const accountId = useStore((s) => s.activeAccountId ?? '')
  const snapshot = useStore((s) => s.snapshots[accountId])
  const me = snapshot?.me
  const [threads, setThreads] = useState<ChannelThread[]>(() => channelCache.peek(cacheKey(accountId, channel.id)) ?? [])
  const [loading, setLoading] = useState(() => !channelCache.peek(cacheKey(accountId, channel.id)))
  const [error, setError] = useState<string>()
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const names = useCallback((m: string) => personName(snapshot, m), [snapshot])

  const load = useCallback(async () => {
    try {
      // Teilt sich eine laufende Vorab-Anfrage vom Hover
      const t = await fetchChannel(accountId, team.id, channel.id)
      setThreads(t)
      setError(undefined)
      const last = t[t.length - 1]
      const lastMsg = last ? (last.replies[last.replies.length - 1] ?? last.root) : undefined
      if (lastMsg && document.hasFocus()) void api.markRead(accountId, channel.id, lastMsg.id).catch(() => undefined)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [accountId, team.id, channel.id])

  useEffect(() => {
    setLoading(!channelCache.peek(cacheKey(accountId, channel.id)))
    stick.current = true
    void load()
    window.teams.setFocusContext({ accountId, conversationId: channel.id })
    const off = onEvent('conversation-updated', (e) => {
      if (e.accountId === accountId && e.conversationIds.includes(channel.id)) void load()
    })
    const t = setInterval(() => void load(), 45_000)
    return () => {
      off()
      clearInterval(t)
      window.teams.setFocusContext({})
    }
  }, [accountId, channel.id, load])

  useLayoutEffect(() => {
    if (stick.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [threads])

  return (
    <div className="main-pane channel">
      <div className="pane-header">
        <TeamAvatar team={team} size={32} />
        <div className="grow" style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
          <div style={{ minWidth: 0 }}>
            <div className="title">{channel.displayName}</div>
            <div className="subtitle">{team.displayName}</div>
          </div>
          <div className="tabs">
            <button className="tab active">Beiträge</button>
          </div>
        </div>
      </div>
      <div
        className="posts"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {loading && threads.length === 0 && (
          <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}>
            <Spinner size="small" />
          </div>
        )}
        {error && threads.length === 0 && <div className="empty-state">Beiträge konnten nicht geladen werden: {error}</div>}
        {!loading && !error && threads.length === 0 && <div className="empty-state">Noch keine Beiträge in diesem Kanal.</div>}
        {threads.map((t) => (
          <Post key={t.id} thread={t} accountId={accountId} channelId={channel.id} myMri={me?.mri} myName={me?.displayName} names={names} onChanged={() => void load()} />
        ))}
      </div>
      <Composer
        withSubject
        placeholder="Neuen Beitrag verfassen"
        onSend={async (p) => {
          await api.sendMessage(accountId, channel.id, p.html, { subject: p.subject, importance: p.importance })
          stick.current = true
          setTimeout(() => void load(), 800)
        }}
      />
    </div>
  )
}

function Post({
  thread,
  accountId,
  channelId,
  myMri,
  myName,
  names,
  onChanged
}: {
  thread: ChannelThread
  accountId: string
  channelId: string
  myMri?: string
  myName?: string
  names: (m: string) => string
  onChanged: () => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  // Nachgeladene und selbst gesendete Antworten. Sie ergänzen die Vorschau aus dem Server-Stand,
  // statt sie zu ersetzen, sonst kämen neue Antworten anderer nicht mehr an.
  const [extra, setExtra] = useState<Message[]>([])
  const [loadedAll, setLoadedAll] = useState(false)
  const [replying, setReplying] = useState(false)
  const replies = useMemo(() => {
    const byId = new Map<string, Message>()
    for (const m of [...extra, ...thread.replies]) byId.set(m.id, m)
    return [...byId.values()].sort((a, b) => a.time - b.time)
  }, [extra, thread.replies])
  const visible = expanded ? replies : replies.slice(-2)
  const hiddenCount = Math.max(0, (loadedAll ? replies.length : Math.max(thread.replyCount, replies.length)) - visible.length)
  const root = thread.root
  const hoverMore = useHoverPrefetch(() => prefetchReplies(accountId, channelId, thread.id))

  const expand = async () => {
    setExpanded(true)
    if (!loadedAll) {
      // Vorgeladene Antworten sofort zeigen, dann auffrischen
      const cached = replyCache.peek(cacheKey(accountId, `${channelId};${thread.id}`))
      if (cached) setExtra((prev) => [...prev, ...cached.filter((m) => m.id !== thread.id)])
      try {
        const r = await fetchReplies(accountId, channelId, thread.id)
        setExtra((prev) => [...prev, ...r.filter((m) => m.id !== thread.id)])
        setLoadedAll(true)
      } catch {
        /* Fallback: vorhandene Antworten */
      }
    }
  }

  return (
    <div className="post">
      <div className="post-card">
        <div className="post-root">
          <PersonAvatar mri={root.from} name={root.fromName || names(root.from)} size={32} />
          <div className="post-content">
            <div className="msg-meta" style={{ marginLeft: 0 }}>
              <b>{root.fromName || names(root.from)}</b>
              <span>{messageTime(root.time)}</span>
              {root.editedTime && <span>Bearbeitet</span>}
            </div>
            {root.kind === 'system' ? <div className="msg-system" style={{ justifyContent: 'flex-start' }}>{root.systemText}</div> : <div className="bubble"><MessageBody msg={root} accountId={accountId} myName={myName} /></div>}
            <Reactions msg={root} accountId={accountId} myMri={myMri} names={names} onChanged={onChanged} />
          </div>
        </div>
        {(replies.length > 0 || hiddenCount > 0) && (
          <div className="post-replies">
            {hiddenCount > 0 && !expanded && (
              <div style={{ padding: '6px 16px 0 60px' }}>
                <button className="link-btn" onClick={() => void expand()} {...hoverMore}>
                  {hiddenCount} {hiddenCount === 1 ? 'weitere Antwort' : 'weitere Antworten'}
                </button>
              </div>
            )}
            {visible.map((m) => (
              <div key={m.id} className="post-reply">
                <PersonAvatar mri={m.from} name={m.fromName || names(m.from)} size={24} />
                <div className="post-content">
                  <div className="msg-meta" style={{ marginLeft: 0 }}>
                    <b>{m.fromName || names(m.from)}</b>
                    <span>{messageTime(m.time)}</span>
                  </div>
                  <div className="bubble">
                    <MessageBody msg={m} accountId={accountId} myName={myName} />
                  </div>
                  <Reactions msg={m} accountId={accountId} myMri={myMri} names={names} onChanged={onChanged} />
                </div>
              </div>
            ))}
          </div>
        )}
        {replying ? (
          <div style={{ padding: '0 12px 12px 48px', borderTop: '1px solid var(--border)' }}>
            <Composer
              compact
              autoFocus
              onCancel={() => setReplying(false)}
              placeholder="Antworten"
              onSend={async (p) => {
                const msg = await api.sendMessage(accountId, channelId, p.html, { replyToId: thread.id, importance: p.importance })
                setExtra((prev) => [...prev, msg])
                setReplying(false)
                setTimeout(onChanged, 1000)
              }}
            />
          </div>
        ) : (
          <div className="post-footer">
            <button className="link-btn" onClick={() => setReplying(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <ArrowReply16Regular /> Antworten
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
