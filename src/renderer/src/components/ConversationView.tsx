import { Button, Popover, PopoverSurface, PopoverTrigger, Spinner, Tooltip } from '@fluentui/react-components'
import { Call20Regular, Video20Regular, People20Regular, Edit16Regular, Dismiss16Regular, Eye12Regular, CheckmarkCircle12Regular } from '@fluentui/react-icons'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChatSummary, Message } from '@shared/types'
import { api, onEvent } from '../api'
import { dayLabel, sameDay } from '../lib/format'
import { cacheKey, fetchHorizons, fetchMessages, horizonCache, messageCache, receiptsEnabled as hasReceipts } from '../lib/prefetch'
import { personName, useStore } from '../store'
import { ChatAvatar, PersonAvatar, presenceLabel } from './Avatars'
import { Composer, type ComposerHandle, type SendPayload } from './Composer'
import { MessageItem } from './MessageItem'

function merge(prev: Message[], next: Message[]): Message[] {
  const byId = new Map<string, Message>()
  for (const m of prev) byId.set(m.id, m)
  for (const m of next) {
    // Optimistische Nachricht durch echte ersetzen
    if (m.clientMessageId) {
      for (const [k, p] of byId) if (p.pending && p.clientMessageId === m.clientMessageId) byId.delete(k)
    }
    byId.set(m.id, m)
  }
  return [...byId.values()].sort((a, b) => a.time - b.time || Number(a.id) - Number(b.id))
}

export function useMessages(accountId: string, conversationId: string) {
  const key = cacheKey(accountId, conversationId)
  // Vorgeladene Nachrichten sofort zeigen, im Hintergrund auffrischen
  const [msgs, setMsgs] = useState<Message[]>(() => messageCache.peek(key) ?? [])
  const [loading, setLoading] = useState(() => !messageCache.peek(key))
  const [error, setError] = useState<string>()
  const [hasOlder, setHasOlder] = useState(true)
  const loadingOlder = useRef(false)
  const idRef = useRef(conversationId)
  idRef.current = conversationId
  const seq = useRef(0)

  const reload = useCallback(async () => {
    // Eine überholte Antwort (z. B. vom Hover vor einer neuen Nachricht) nicht mehr anwenden
    const mine = ++seq.current
    const current = () => idRef.current === conversationId && seq.current === mine
    try {
      // Teilt sich eine laufende Vorab-Anfrage vom Hover
      const list = await fetchMessages(accountId, conversationId)
      if (!current()) return
      setMsgs((prev) => merge(prev, list))
      setError(undefined)
    } catch (e) {
      if (current()) setError((e as Error).message)
    } finally {
      if (current()) setLoading(false)
    }
  }, [accountId, conversationId])

  const loadOlder = useCallback(async () => {
    if (loadingOlder.current || !hasOlder) return
    loadingOlder.current = true
    try {
      const oldest = msgs[0]?.time ?? Date.now()
      const list = await api.getMessages(accountId, conversationId, oldest)
      if (list.length === 0) setHasOlder(false)
      else setMsgs((prev) => merge(prev, list))
    } finally {
      loadingOlder.current = false
    }
  }, [accountId, conversationId, msgs, hasOlder])

  useEffect(() => {
    const key = cacheKey(accountId, conversationId)
    const cached = messageCache.peek(key)
    setMsgs(cached ?? [])
    setLoading(!cached)
    setHasOlder(true)
    // Gerade vorgeladen und seitdem nichts Neues: nicht sofort noch einmal holen
    if (!messageCache.isFresh(key)) void reload()
    const off = onEvent('conversation-updated', (e) => {
      if (e.accountId === accountId && e.conversationIds.includes(conversationId)) void reload()
    })
    const t = setInterval(() => void reload(), 30_000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [accountId, conversationId, reload])

  // Aktuellen Stand merken, damit ein erneutes Öffnen ohne Laden auskommt
  useEffect(() => {
    const key = cacheKey(accountId, conversationId)
    // Die eben aus dem Cache gezeigten Daten nicht als frisch neu eintragen
    if (msgs === messageCache.peek(key)) return
    const done = msgs.filter((m) => !m.pending && !m.failed)
    if (done.length) messageCache.set(key, done)
  }, [msgs, accountId, conversationId])

  return { msgs, setMsgs, loading, error, reload, loadOlder, hasOlder }
}

export function ConversationView({ chat }: { chat: ChatSummary }): JSX.Element {
  const accountId = useStore((s) => s.activeAccountId ?? '')
  const snapshot = useStore((s) => s.snapshots[accountId])
  const me = snapshot?.me
  const typing = useStore((s) => s.typing[`${accountId}|${chat.id}`])
  const callState = useStore((s) => s.callState)
  const { msgs, setMsgs, loading, error, reload, loadOlder } = useMessages(accountId, chat.id)
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const [editing, setEditing] = useState<Message | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const prevHeight = useRef(0)
  const composer = useRef<ComposerHandle>(null)
  const [, force] = useState(0)

  const names = useCallback((mri: string) => personName(snapshot, mri), [snapshot])
  const [horizons, setHorizons] = useState<Record<string, number> | null>(() => horizonCache.peek(cacheKey(accountId, chat.id)) ?? null)
  const receiptsEnabled = hasReceipts(chat)

  // Lesebestätigungen laden und regelmäßig auffrischen
  useEffect(() => {
    if (!receiptsEnabled) return
    let alive = true
    const load = () =>
      fetchHorizons(accountId, chat.id)
        .then((h) => alive && setHorizons(h))
        .catch(() => undefined)
    const key = cacheKey(accountId, chat.id)
    if (horizonCache.isFresh(key)) setHorizons(horizonCache.peek(key) ?? null)
    else void load()
    const t = setInterval(load, 15_000)
    const off = onEvent('conversation-updated', (e) => {
      if (e.accountId === accountId && e.conversationIds.includes(chat.id)) void load()
    })
    return () => {
      alive = false
      clearInterval(t)
      off()
    }
  }, [accountId, chat.id, receiptsEnabled])

  useEffect(() => {
    window.teams.setFocusContext({ accountId, conversationId: chat.id })
    stick.current = true
    setReplyTo(null)
    setEditing(null)
    setTimeout(() => composer.current?.focus(), 50)
    return () => window.teams.setFocusContext({})
  }, [accountId, chat.id])

  // Typing-Anzeige nach Ablauf ausblenden
  useEffect(() => {
    if (!typing) return
    const t = setTimeout(() => force((x) => x + 1), Math.max(0, typing.until - Date.now()) + 50)
    return () => clearTimeout(t)
  }, [typing])

  // Gelesen markieren
  useEffect(() => {
    const last = [...msgs].reverse().find((m) => !m.pending)
    if (!last || last.isMine) return
    const mark = () => {
      if (document.hasFocus()) void api.markRead(accountId, chat.id, last.id).catch(() => undefined)
    }
    mark()
    window.addEventListener('focus', mark)
    return () => window.removeEventListener('focus', mark)
  }, [msgs, accountId, chat.id])

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (stick.current) el.scrollTop = el.scrollHeight
    else if (prevHeight.current && el.scrollHeight > prevHeight.current && el.scrollTop < 200) {
      el.scrollTop += el.scrollHeight - prevHeight.current
    }
    prevHeight.current = el.scrollHeight
  }, [msgs])

  // Bilder laden erst nach dem Rendern und haben keine feste Größe. Wächst der Inhalt,
  // während die Ansicht unten klebt, wieder ans Ende scrollen.
  useEffect(() => {
    const el = scroller.current
    const inner = el?.firstElementChild
    if (!el || !inner) return
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(inner)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (el.scrollTop < 120 && !loading) {
      prevHeight.current = el.scrollHeight
      void loadOlder()
    }
  }

  const send = async (p: SendPayload) => {
    if (editing) {
      await api.editMessage(accountId, chat.id, editing.id, p.html)
      setEditing(null)
      void reload()
      return
    }
    const temp: Message = {
      id: `pending-${Date.now()}`,
      conversationId: chat.id,
      clientMessageId: undefined,
      type: 'RichText/Html',
      kind: 'text',
      from: me?.mri ?? '',
      fromName: me?.displayName ?? '',
      isMine: true,
      time: Date.now(),
      html: p.html,
      text: p.text,
      importance: p.importance,
      reactions: [],
      attachments: [],
      pending: true
    }
    stick.current = true
    setMsgs((prev) => [...prev, temp])
    try {
      const real = await api.sendMessage(accountId, chat.id, p.html, { importance: p.importance })
      setMsgs((prev) => merge(prev.filter((m) => m.id !== temp.id), [real]))
    } catch (e) {
      // Der Composer bekommt den Text zurück. Bliebe die Blase stehen, gäbe es beim erneuten Senden zwei.
      setMsgs((prev) => prev.filter((m) => m.id !== temp.id))
      throw e
    }
  }

  const other = chat.kind === 'oneOnOne' ? chat.members[0] : undefined
  const otherPresence = other ? snapshot?.presence[other] : undefined
  const otherPerson = other ? snapshot?.people[other] : undefined
  const inThisCall = !!callState

  const lastMineId = useMemo(() => [...msgs].reverse().find((m) => m.isMine && !m.pending && m.kind === 'text')?.id, [msgs])
  const receipt = useMemo(() => {
    if (!receiptsEnabled || !lastMineId || !horizons) return null
    const others = chat.members
    const id = Number(lastMineId)
    const seen = others.filter((m) => (horizons[m] ?? 0) >= id)
    if (seen.length === 0) return { seen: false, text: 'Gesendet' }
    if (others.length === 1 || seen.length === others.length) return { seen: true, text: 'Gesehen' }
    return { seen: true, text: `Gesehen von ${seen.length}` }
  }, [receiptsEnabled, lastMineId, horizons, chat.members])

  const rows = useMemo(() => {
    const out: JSX.Element[] = []
    let prev: Message | undefined
    for (const m of msgs) {
      if (!prev || !sameDay(prev.time, m.time)) out.push(<div key={`d-${m.id}`} className="day-sep">{dayLabel(m.time)}</div>)
      const showHeader =
        !prev || prev.from !== m.from || m.time - prev.time > 5 * 60_000 || prev.kind !== 'text' || !sameDay(prev.time, m.time) || !!m.subject
      out.push(
        <MessageItem
          key={m.id}
          msg={m}
          accountId={accountId}
          myMri={me?.mri}
          myName={me?.displayName}
          showHeader={showHeader}
          names={names}
          onReply={(x) => {
            setReplyTo(x)
            composer.current?.focus()
          }}
          onEdit={(x) => {
            setEditing(x)
            composer.current?.setContent(x.html)
          }}
          onChanged={() => void reload()}
        />
      )
      if (m.id === lastMineId && receipt) {
        out.push(
          <div key={`rcpt-${m.id}`} className={`read-receipt ${receipt.seen ? 'seen' : ''}`} title={receipt.seen ? 'Gelesen' : 'Zugestellt'}>
            {receipt.seen ? <Eye12Regular /> : <CheckmarkCircle12Regular />}
            <span>{receipt.text}</span>
          </div>
        )
      }
      prev = m
    }
    return out
  }, [msgs, accountId, me, names, reload, lastMineId, receipt])

  return (
    <div className="main-pane">
      <div className="pane-header">
        <ChatAvatar chat={chat} size={32} />
        <div className="grow" style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
          <div style={{ minWidth: 0 }}>
            <div className="title">{chat.title}</div>
            {chat.kind === 'oneOnOne' && (otherPresence || otherPerson?.jobTitle) && (
              <div className="subtitle">{[presenceLabel(otherPresence), otherPresence?.statusMessage || otherPerson?.jobTitle].filter(Boolean).join(' · ')}</div>
            )}
          </div>
          <div className="tabs">
            <button className="tab active">Chat</button>
          </div>
        </div>
        {chat.kind === 'meeting' && chat.meeting?.joinUrl && (
          <Button appearance="primary" size="small" icon={<Video20Regular />} onClick={() => void api.joinMeeting(accountId, chat.meeting!.joinUrl!, { video: true, audio: true })}>
            Teilnehmen
          </Button>
        )}
        {chat.kind !== 'meeting' && chat.kind !== 'self' && (
          <>
            <Tooltip content="Videoanruf" relationship="label">
              <button className="icon-btn" disabled={inThisCall} onClick={() => void api.startCall(accountId, chat.kind === 'oneOnOne' ? { mris: chat.members } : { conversationId: chat.id }, true)}>
                <Video20Regular />
              </button>
            </Tooltip>
            <Tooltip content="Audioanruf" relationship="label">
              <button className="icon-btn" disabled={inThisCall} onClick={() => void api.startCall(accountId, chat.kind === 'oneOnOne' ? { mris: chat.members } : { conversationId: chat.id }, false)}>
                <Call20Regular />
              </button>
            </Tooltip>
          </>
        )}
        {chat.kind !== 'oneOnOne' && chat.members.length > 0 && (
          <Popover positioning="below-end" withArrow>
            <PopoverTrigger disableButtonEnhancement>
              <button className="icon-btn" style={{ width: 'auto', padding: '0 8px', gap: 4 }} title="Teilnehmer">
                <People20Regular />
                <span style={{ fontSize: 13 }}>{chat.memberCount ?? chat.members.length + 1}</span>
              </button>
            </PopoverTrigger>
            <PopoverSurface style={{ width: 300, maxHeight: 420, overflowY: 'auto', padding: 8 }}>
              <div style={{ fontWeight: 600, padding: '4px 8px 8px' }}>Personen ({chat.members.length + 1})</div>
              {me && (
                <div className="person-row">
                  <PersonAvatar mri={me.mri} name={me.displayName} size={28} />
                  <div className="p-name">{me.displayName} (du)</div>
                </div>
              )}
              {chat.members.map((m) => (
                <div key={m} className="person-row">
                  <PersonAvatar mri={m} name={names(m)} size={28} />
                  <div>
                    <div className="p-name">{names(m)}</div>
                    <div className="p-sub">{snapshot?.people[m]?.jobTitle}</div>
                  </div>
                </div>
              ))}
            </PopoverSurface>
          </Popover>
        )}
      </div>
      <div className="messages" ref={scroller} onScroll={onScroll}>
        <div className="messages-inner">
          {loading && msgs.length === 0 && (
            <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}>
              <Spinner size="small" />
            </div>
          )}
          {error && msgs.length === 0 && <div className="empty-state">Nachrichten konnten nicht geladen werden: {error}</div>}
          {!loading && msgs.length === 0 && !error && (
            <div className="empty-state" style={{ paddingTop: 80 }}>
              <ChatAvatar chat={chat} size={48} />
              <h2>{chat.title}</h2>
              <div>Noch keine Nachrichten. Schreib die erste.</div>
            </div>
          )}
          {rows}
        </div>
      </div>
      <div className="typing">{typing && typing.until > Date.now() ? `${typing.name || 'Jemand'} schreibt …` : ''}</div>
      {editing && (
        <div className="composer-wrap" style={{ paddingBottom: 0 }}>
          <div className="banner" style={{ borderRadius: 6 }}>
            <Edit16Regular /> <span style={{ flex: 1 }}>Nachricht bearbeiten</span>
            <button
              className="icon-btn"
              style={{ width: 24, height: 24 }}
              onClick={() => {
                setEditing(null)
                composer.current?.setContent('')
              }}
            >
              <Dismiss16Regular />
            </button>
          </div>
        </div>
      )}
      <Composer
        ref={composer}
        onSend={send}
        onTyping={() => void api.sendTyping(accountId, chat.id)}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
      />
    </div>
  )
}
