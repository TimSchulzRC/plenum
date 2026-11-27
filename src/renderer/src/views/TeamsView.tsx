import { Spinner, Tooltip } from '@fluentui/react-components'
import { ChevronDown16Regular, ChevronRight16Regular, Dismiss20Regular, LockClosed12Regular } from '@fluentui/react-icons'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject, type UIEvent } from 'react'
import type { Channel, ChannelThread, Message, Team } from '@shared/types'
import { api, onEvent } from '../api'
import { AccountChip, PersonAvatar, TeamAvatar } from '../components/Avatars'
import { Composer, type ComposerHandle } from '../components/Composer'
import { MessageItem } from '../components/MessageItem'
import { dayLabel, listTime, sameDay } from '../lib/format'
import { cacheKey, channelCache, fetchChannel, fetchReplies, prefetchChannel, replyCache, prefetchReplies, useHoverPrefetch } from '../lib/prefetch'
import { conversationVisible, personName, setConversationFocus, useActive, useStore } from '../store'

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
  // Wie in Teams öffnet ein Beitrag seinen Thread rechts neben dem Kanal
  const [openId, setOpenId] = useState<string>()
  const threadComposer = useRef<ComposerHandle>(null)
  const names = useCallback((m: string) => personName(snapshot, m), [snapshot])
  // Wie ein Chat: Beiträge nach ihrer Zeit, neue Antworten schieben einen Beitrag nicht nach unten
  const posts = useMemo(() => [...threads].sort((a, b) => a.root.time - b.root.time), [threads])
  const open = openId ? threads.find((t) => t.id === openId) : undefined
  const { scroller, stick, onScroll } = useStickToBottom(posts)

  const load = useCallback(async () => {
    try {
      // Teilt sich eine laufende Vorab-Anfrage vom Hover
      const t = await fetchChannel(accountId, team.id, channel.id)
      setThreads(t)
      setError(undefined)
      const last = t[t.length - 1]
      const lastMsg = last ? (last.replies[last.replies.length - 1] ?? last.root) : undefined
      if (lastMsg && conversationVisible()) void api.markRead(accountId, channel.id, lastMsg.id).catch(() => undefined)
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
    setConversationFocus({ accountId, conversationId: channel.id })
    const off = onEvent('conversation-updated', (e) => {
      if (e.accountId === accountId && e.conversationIds.includes(channel.id)) void load()
    })
    const t = setInterval(() => void load(), 45_000)
    return () => {
      off()
      clearInterval(t)
      setConversationFocus({})
    }
  }, [accountId, channel.id, load])

  const openThread = (id: string) => {
    setOpenId(id)
    setTimeout(() => threadComposer.current?.focus(), 50)
  }

  const rows: JSX.Element[] = []
  let prev: ChannelThread | undefined
  for (const t of posts) {
    if (!prev || !sameDay(prev.root.time, t.root.time)) rows.push(<div key={`d-${t.id}`} className="day-sep">{dayLabel(t.root.time)}</div>)
    rows.push(
      <ChannelPost
        key={t.id}
        thread={t}
        accountId={accountId}
        channelId={channel.id}
        myMri={me?.mri}
        myName={me?.displayName}
        names={names}
        open={t.id === openId}
        onOpen={() => openThread(t.id)}
        onChanged={() => void load()}
      />
    )
    prev = t
  }

  return (
    <>
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
            <AccountChip />
          </div>
        </div>
        <div className="messages" ref={scroller} onScroll={onScroll}>
          <div className="messages-inner">
            {loading && threads.length === 0 && (
              <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}>
                <Spinner size="small" />
              </div>
            )}
            {error && threads.length === 0 && <div className="empty-state">Beiträge konnten nicht geladen werden: {error}</div>}
            {!loading && !error && threads.length === 0 && <div className="empty-state">Noch keine Beiträge in diesem Kanal.</div>}
            {rows}
          </div>
        </div>
        <Composer
          withSubject
          placeholder={`Nachricht in ${channel.displayName}`}
          onSend={async (p) => {
            await api.sendMessage(accountId, channel.id, p.html, { subject: p.subject, importance: p.importance, files: p.files })
            stick.current = true
            setTimeout(() => void load(), 800)
          }}
        />
      </div>
      {open && (
        <ThreadPane
          key={open.id}
          thread={open}
          accountId={accountId}
          channelId={channel.id}
          myMri={me?.mri}
          myName={me?.displayName}
          names={names}
          composer={threadComposer}
          onClose={() => setOpenId(undefined)}
          onChanged={() => void load()}
        />
      )}
    </>
  )
}

interface ThreadProps {
  thread: ChannelThread
  accountId: string
  channelId: string
  myMri?: string
  myName?: string
  names: (m: string) => string
  onChanged: () => void
}

// Beitrag im Kanal: Nachricht wie im Chat, darunter wer geantwortet hat, wie oft und wann zuletzt
function ChannelPost({ thread, accountId, channelId, myMri, myName, names, open, onOpen, onChanged }: ThreadProps & { open: boolean; onOpen: () => void }): JSX.Element {
  const hover = useHoverPrefetch(() => prefetchReplies(accountId, channelId, thread.id))
  const count = Math.max(thread.replyCount, thread.replies.length)
  const lastReply = thread.replies[thread.replies.length - 1]?.time ?? thread.lastActivity
  // Die letzten drei, die geantwortet haben, die jüngste Antwort zuerst
  const people = [...new Set([...thread.replies].reverse().map((m) => m.from))].slice(0, 3)
  const byMri = new Map(thread.replies.map((m) => [m.from, m.fromName]))
  return (
    <div className={`channel-post ${open ? 'open' : ''} ${thread.root.isMine ? 'mine' : ''}`}>
      <MessageItem msg={thread.root} accountId={accountId} myMri={myMri} myName={myName} showHeader names={names} onThread={onOpen} onChanged={onChanged} />
      {count > 0 && (
        <div className="thread-summary-row">
          <button className="thread-summary" onClick={onOpen} {...hover}>
            {people.length > 0 && (
              <span className="thread-avatars">
                {people.map((m) => (
                  <PersonAvatar key={m} mri={m} name={byMri.get(m) || names(m)} size={20} showPresence={false} />
                ))}
              </span>
            )}
            <span className="thread-count">
              {count} {count === 1 ? 'Antwort' : 'Antworten'}
            </span>
            <span>Letzte Antwort {listTime(lastReply)}</span>
          </button>
        </div>
      )}
    </div>
  )
}

function ThreadPane({ thread, accountId, channelId, myMri, myName, names, composer, onClose, onChanged }: ThreadProps & { composer: RefObject<ComposerHandle | null>; onClose: () => void }): JSX.Element {
  const key = cacheKey(accountId, `${channelId};${thread.id}`)
  // Alle Antworten vom Server. Die Vorschau im Beitrag enthält nur die letzten.
  const [fetched, setFetched] = useState<Message[] | undefined>(() => replyCache.peek(key))
  // Selbst gesendete Antworten, bis sie vom Server kommen
  const [sent, setSent] = useState<Message[]>([])
  const first = useRef(true)

  // Beim Öffnen und bei jedem neuen Stand des Kanals neu laden, damit Antworten,
  // Reaktionen und Änderungen auch außerhalb der Vorschau ankommen
  useEffect(() => {
    let alive = true
    if (!first.current) replyCache.markStale(key)
    first.current = false
    fetchReplies(accountId, channelId, thread.id)
      .then((r) => alive && setFetched(r))
      .catch(() => alive && setFetched((f) => f ?? []))
    return () => {
      alive = false
    }
  }, [accountId, channelId, thread, key])

  const replies = useMemo(() => {
    const byId = new Map<string, Message>()
    for (const m of [...sent, ...thread.replies, ...(fetched ?? [])]) if (m.id !== thread.id) byId.set(m.id, m)
    return [...byId.values()].sort((a, b) => a.time - b.time)
  }, [sent, thread.replies, thread.id, fetched])
  const count = Math.max(thread.replyCount, replies.length)
  const root = thread.root
  const { scroller, stick, onScroll } = useStickToBottom(replies)

  const rows: JSX.Element[] = []
  let prev: Message | undefined
  for (const m of replies) {
    const showHeader = !prev || prev.from !== m.from || m.time - prev.time > 5 * 60_000 || prev.kind !== 'text' || !sameDay(prev.time, m.time)
    rows.push(<MessageItem key={m.id} msg={m} accountId={accountId} myMri={myMri} myName={myName} showHeader={showHeader} names={names} onChanged={onChanged} />)
    prev = m
  }

  return (
    <div className="thread-pane">
      <div className="pane-header">
        <div className="grow thread-title">
          <span>Thread</span>
          <ChevronRight16Regular />
          <b>{root.subject || root.text || 'Beitrag'}</b>
        </div>
        <Tooltip content="Thread schließen" relationship="label">
          <button className="icon-btn" onClick={onClose}>
            <Dismiss20Regular />
          </button>
        </Tooltip>
      </div>
      <div className="messages" ref={scroller} onScroll={onScroll}>
        <div className="messages-inner">
          <MessageItem msg={root} accountId={accountId} myMri={myMri} myName={myName} showHeader names={names} onChanged={onChanged} />
          {count > 0 && (
            <div className="thread-divider">
              {count} {count === 1 ? 'Antwort' : 'Antworten'}
            </div>
          )}
          {!fetched && count > replies.length && (
            <div style={{ padding: 12, display: 'flex', justifyContent: 'center' }}>
              <Spinner size="tiny" />
            </div>
          )}
          {rows}
        </div>
      </div>
      <Composer
        ref={composer}
        placeholder="Im Thread antworten"
        onSend={async (p) => {
          const msg = await api.sendMessage(accountId, channelId, p.html, { replyToId: thread.id, importance: p.importance, files: p.files })
          stick.current = true
          setSent((s) => [...s, msg])
          setTimeout(onChanged, 1000)
        }}
      />
    </div>
  )
}

// Hält eine Liste unten, solange niemand hochgescrollt hat. Auch wenn sie schmaler wird
// (Thread geht auf) oder Bilder nachladen.
function useStickToBottom(content: unknown) {
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useLayoutEffect(() => {
    if (stick.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [content])
  useEffect(() => {
    const el = scroller.current
    const inner = el?.firstElementChild
    if (!el || !inner) return
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(el)
    ro.observe(inner)
    return () => ro.disconnect()
  }, [])
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }
  return { scroller, stick, onScroll }
}
