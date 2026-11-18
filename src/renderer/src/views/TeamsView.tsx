import { Button, Spinner } from '@fluentui/react-components'
import { ChevronDown16Regular, ChevronRight16Regular, Compose20Regular, LockClosed12Regular, ArrowReply16Regular } from '@fluentui/react-icons'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Channel, ChannelThread, Message, Team } from '@shared/types'
import { api, onEvent } from '../api'
import { PersonAvatar, TeamAvatar } from '../components/Avatars'
import { Composer } from '../components/Composer'
import { MessageBody, Reactions } from '../components/MessageItem'
import { messageTime } from '../lib/format'
import { personName, useActive, useStore } from '../store'

export function TeamsView(): JSX.Element {
  const { snapshot, selection } = useActive()
  const team = snapshot?.teams.find((t) => t.id === selection.teamId)
  const channel = team?.channels.find((c) => c.id === selection.channelId)
  return (
    <>
      <TeamsList />
      {team && channel ? (
        <ChannelView key={channel.id} team={team} channel={channel} />
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
              <div
                key={c.id}
                className={`channel-row ${c.id === selection.channelId ? 'selected' : ''} ${c.unread ? 'unread' : ''}`}
                onClick={() => useStore.getState().select({ teamId: t.id, channelId: c.id })}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.displayName}</span>
                {c.membershipType === 'private' && <LockClosed12Regular />}
              </div>
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
        <div key={c.id} className={`channel-row ${c.unread ? 'unread' : ''}`} onClick={() => useStore.getState().select({ teamId: team.id, channelId: c.id })}>
          <span style={{ flex: 1, opacity: 0.8 }}>{c.displayName}</span>
          {c.membershipType === 'private' && <LockClosed12Regular />}
        </div>
      ))}
    </>
  )
}

export function ChannelView({ team, channel }: { team: Team; channel: Channel }): JSX.Element {
  const accountId = useStore((s) => s.activeAccountId ?? '')
  const snapshot = useStore((s) => s.snapshots[accountId])
  const me = snapshot?.me
  const [threads, setThreads] = useState<ChannelThread[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [newPost, setNewPost] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const names = useCallback((m: string) => personName(snapshot, m), [snapshot])

  const load = useCallback(async () => {
    try {
      const t = await api.getChannelThreads(accountId, team.id, channel.id)
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
    setLoading(true)
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
      {newPost ? (
        <Composer
          withSubject
          autoFocus
          onCancel={() => setNewPost(false)}
          placeholder="Neuen Beitrag verfassen"
          onSend={async (p) => {
            await api.sendMessage(accountId, channel.id, p.html, { subject: p.subject, importance: p.importance })
            setNewPost(false)
            stick.current = true
            setTimeout(() => void load(), 800)
          }}
        />
      ) : (
        <div className="composer-wrap" style={{ maxWidth: 1000 }}>
          <Button appearance="primary" icon={<Compose20Regular />} onClick={() => setNewPost(true)}>
            Beitrag verfassen
          </Button>
        </div>
      )}
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
  const [allReplies, setAllReplies] = useState<Message[] | null>(null)
  const [replying, setReplying] = useState(false)
  const replies = allReplies ?? thread.replies
  const visible = expanded ? replies : replies.slice(-2)
  const hiddenCount = Math.max(0, (allReplies ? allReplies.length : thread.replyCount) - visible.length)
  const root = thread.root

  const expand = async () => {
    setExpanded(true)
    if (!allReplies) {
      try {
        const r = await api.getThreadReplies(accountId, channelId, thread.id)
        setAllReplies(r.filter((m) => m.id !== thread.id))
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
                <button className="link-btn" onClick={() => void expand()}>
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
                setAllReplies([...(allReplies ?? thread.replies), msg])
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
