import { Input, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, Tooltip } from '@fluentui/react-components'
import {
  ChevronDown16Regular,
  ChevronRight16Regular,
  Compose20Regular,
  Filter20Regular,
  AlertOff16Regular,
  Dismiss16Regular,
  LockClosed12Regular,
  Video16Filled
} from '@fluentui/react-icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Channel, ChatFolder, ChatSummary, Person, Team } from '@shared/types'
import { api } from '../api'
import { ChatAvatar, PersonAvatar, TeamAvatar } from '../components/Avatars'
import { Composer } from '../components/Composer'
import { ConversationView } from '../components/ConversationView'
import { listTime } from '../lib/format'
import { prefetchChannel, prefetchChat, useHoverPrefetch } from '../lib/prefetch'
import { useActive, useStore } from '../store'
import { ChannelView } from './TeamsView'

type Filter = 'all' | 'unread' | 'meetings' | 'chats'

export function ChatView(): JSX.Element {
  const { snapshot, selection } = useActive()
  const chat = snapshot?.chats.find((c) => c.id === selection.chatId)
  const team = !chat && selection.channelId ? snapshot?.teams.find((t) => t.channels.some((c) => c.id === selection.channelId)) : undefined
  const channel = team?.channels.find((c) => c.id === selection.channelId)
  return (
    <>
      <ChatList />
      {selection.newChat ? (
        <NewChat />
      ) : chat ? (
        <ConversationView key={`${snapshot?.accountId}|${chat.id}`} chat={chat} />
      ) : team && channel ? (
        <ChannelView key={`${snapshot?.accountId}|${channel.id}`} team={team} channel={channel} />
      ) : (
        <div className="main-pane">
          <div className="empty-state">
            <h2>Willkommen</h2>
            <div>Wähle links einen Chat aus oder starte einen neuen.</div>
          </div>
        </div>
      )}
    </>
  )
}

type Row = { type: 'chat'; chat: ChatSummary } | { type: 'channel'; team: Team; channel: Channel }

const SYSTEM_FOLDERS = new Set(['QuickViews', 'RecentChats', 'MeetingChats', 'TeamsAndChannels', 'MutedChats', 'EngageCommunities'])

function ChatList(): JSX.Element {
  const { snapshot, selection } = useActive()
  const compact = useStore((s) => !s.settings?.chatPreviews)
  const [filterOpen, setFilterOpen] = useState(false)
  const [text, setText] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [openTeams, setOpenTeams] = useState<Record<string, boolean>>({})
  const [limit, setLimit] = useState(150)

  const channelIndex = useMemo(() => {
    const m = new Map<string, { team: Team; channel: Channel }>()
    for (const t of snapshot?.teams ?? []) for (const c of t.channels) m.set(c.id, { team: t, channel: c })
    return m
  }, [snapshot?.teams])

  const q = text.trim().toLowerCase()
  const matches = (r: Row): boolean => {
    if (r.type === 'channel') {
      if (filter === 'unread') return r.channel.unread
      if (filter === 'meetings') return false
      return !q || r.channel.displayName.toLowerCase().includes(q) || r.team.displayName.toLowerCase().includes(q)
    }
    const c = r.chat
    if (q && !c.title.toLowerCase().includes(q)) return false
    if (filter === 'unread') return c.unread
    if (filter === 'meetings') return c.kind === 'meeting'
    if (filter === 'chats') return c.kind !== 'meeting'
    return true
  }

  const sections = useMemo(() => {
    const out: { key: string; title: string; rows: Row[]; teams?: boolean; folder?: ChatFolder }[] = []
    if (!snapshot) return out
    const chats = new Map(snapshot.chats.map((c) => [c.id, c]))
    const used = new Set<string>()
    const rowFor = (id: string): Row | null => {
      const c = chats.get(id)
      if (c) return { type: 'chat', chat: c }
      const ch = channelIndex.get(id)
      if (ch) return { type: 'channel', ...ch }
      return null
    }
    const folders = snapshot.folders ?? []
    const custom = folders.filter((f) => f.type === 'Favorites' || !SYSTEM_FOLDERS.has(f.type))
    for (const f of custom) {
      let rows = f.items.map(rowFor).filter((r): r is Row => !!r)
      if (/MostRecent/i.test(f.sort)) rows = rows.sort((a, b) => lastOf(b) - lastOf(a))
      else if (/Alphabet/i.test(f.sort)) rows = rows.sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'de'))
      for (const id of f.items) used.add(id)
      out.push({ key: f.id, title: f.type === 'Favorites' ? 'Favoriten' : f.name, rows, folder: f })
    }
    if (folders.length === 0) {
      const pinned = snapshot.chats.filter((c) => c.pinned)
      pinned.forEach((c) => used.add(c.id))
      if (pinned.length) out.push({ key: 'pinned', title: 'Angeheftet', rows: pinned.map((c) => ({ type: 'chat', chat: c })) })
    }
    const recent = snapshot.chats
      .filter((c) => !used.has(c.id) && c.kind !== 'channel' && c.kind !== 'system' && (!c.hidden || c.id === selection.chatId))
      .map((c): Row => ({ type: 'chat', chat: c }))
    out.push({ key: 'recent', title: 'Chats', rows: recent })
    out.push({ key: 'teams', title: 'Teams und Kanäle', rows: [], teams: true })
    return out
  }, [snapshot, channelIndex, selection.chatId])

  // Auswahl auf den ersten Eintrag setzen, wenn noch keiner gewählt ist
  useEffect(() => {
    if (selection.chatId || selection.channelId || selection.newChat) return
    const first = sections.flatMap((s) => s.rows)[0]
    if (first?.type === 'chat') useStore.getState().select({ chatId: first.chat.id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.accountId, sections.length])

  const selectRow = (r: Row) => {
    if (r.type === 'chat') useStore.getState().select({ chatId: r.chat.id, channelId: undefined, teamId: undefined, newChat: false })
    else useStore.getState().select({ chatId: undefined, teamId: r.team.id, channelId: r.channel.id, newChat: false })
  }

  const accountId = snapshot?.accountId ?? ''
  const favorites = snapshot?.folders?.find((f) => f.type === 'Favorites')
  const [drag, setDrag] = useState<{ id: string; from?: string } | null>(null)
  const [dropAt, setDropAt] = useState<{ folderId: string; index: number } | null>(null)

  // Ordner sofort lokal anpassen, damit die Liste ohne Verzögerung umspringt
  const patchFolders = (fn: (folders: ChatFolder[]) => ChatFolder[]) => {
    if (!snapshot) return
    useStore.setState((st) => {
      const snap = st.snapshots[accountId]
      if (!snap) return {}
      return { snapshots: { ...st.snapshots, [accountId]: { ...snap, folders: fn(snap.folders.map((f) => ({ ...f, items: [...f.items] }))) } } }
    })
  }
  const run = (p: Promise<unknown>) => p.catch((e: Error) => alert(`Teams hat die Änderung abgelehnt: ${e.message}`))

  const moveInFolder = (folder: ChatFolder, id: string, index: number) => {
    const order = folder.items.filter((x) => x !== id)
    const at = Math.max(0, Math.min(index, order.length))
    order.splice(at, 0, id)
    patchFolders((fs) => fs.map((f) => (f.id === folder.id ? { ...f, items: order } : f)))
    void run(api.reorderFolder(accountId, folder.id, order))
  }
  const addToFolder = (folder: ChatFolder, id: string, index: number) => {
    patchFolders((fs) => fs.map((f) => (f.id === folder.id ? { ...f, items: [...f.items.slice(0, index), id, ...f.items.slice(index)] } : f)))
    void run(api.addToFolder(accountId, folder.id, id, index))
  }
  const removeFromFolder = (folder: ChatFolder, id: string) => {
    patchFolders((fs) => fs.map((f) => (f.id === folder.id ? { ...f, items: f.items.filter((x) => x !== id) } : f)))
    void run(api.removeFromFolder(accountId, folder.id, id))
  }

  const rowId = (r: Row) => (r.type === 'chat' ? r.chat.id : r.channel.id)

  const renderRow = (r: Row, sec: { folder?: ChatFolder; key: string }) => {
    const id = rowId(r)
    const folder = sec.folder
    const ordered = !!folder && /UserDefined/i.test(folder.sort)
    const idx = folder ? folder.items.indexOf(id) : -1
    const inFav = !!favorites?.items.includes(id)
    const row =
      r.type === 'chat' ? (
        <ChatRow chat={r.chat} compact={compact} selected={r.chat.id === selection.chatId && !selection.newChat} onSelect={() => selectRow(r)} />
      ) : (
        <ChannelRow team={r.team} channel={r.channel} showTeam selected={r.channel.id === selection.channelId && !selection.chatId} onSelect={() => selectRow(r)} />
      )
    const showLineBefore = dropAt && folder && dropAt.folderId === folder.id && dropAt.index === idx
    const showLineAfter = dropAt && folder && dropAt.folderId === folder.id && dropAt.index === idx + 1 && idx === folder.items.length - 1
    return (
      <Menu key={id} openOnContext positioning="below-start">
        <MenuTrigger disableButtonEnhancement>
          <div
            draggable
            className={`drag-row ${drag?.id === id ? 'dragging' : ''}`}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', id)
              setDrag({ id, from: folder?.id })
            }}
            onDragEnd={() => {
              setDrag(null)
              setDropAt(null)
            }}
            onDragOver={(e) => {
              if (!drag || !folder || !ordered) return
              e.preventDefault()
              const rect = e.currentTarget.getBoundingClientRect()
              const after = e.clientY > rect.top + rect.height / 2
              const index = idx + (after ? 1 : 0)
              if (dropAt?.folderId !== folder.id || dropAt.index !== index) setDropAt({ folderId: folder.id, index })
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (!drag || !folder || !dropAt) return
              if (drag.from === folder.id) {
                const cur = folder.items.indexOf(drag.id)
                moveInFolder(folder, drag.id, dropAt.index > cur ? dropAt.index - 1 : dropAt.index)
              } else if (!folder.items.includes(drag.id)) addToFolder(folder, drag.id, dropAt.index)
              setDrag(null)
              setDropAt(null)
            }}
          >
            {showLineBefore && <div className="drop-line" />}
            {row}
            {showLineAfter && <div className="drop-line" />}
          </div>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            {r.type === 'chat' && r.chat.unread && r.chat.lastMessage && (
              <MenuItem onClick={() => void api.markRead(accountId, r.chat.id, r.chat.lastMessage!.id)}>Als gelesen markieren</MenuItem>
            )}
            {favorites && !inFav && <MenuItem onClick={() => addToFolder(favorites, id, favorites.items.length)}>Zu Favoriten hinzufügen</MenuItem>}
            {favorites && inFav && <MenuItem onClick={() => removeFromFolder(favorites, id)}>Aus Favoriten entfernen</MenuItem>}
            {folder && ordered && idx > 0 && <MenuItem onClick={() => moveInFolder(folder, id, idx - 1)}>Nach oben</MenuItem>}
            {folder && ordered && idx >= 0 && idx < folder.items.length - 1 && <MenuItem onClick={() => moveInFolder(folder, id, idx + 1)}>Nach unten</MenuItem>}
            {folder && folder.type !== 'Favorites' && <MenuItem onClick={() => removeFromFolder(folder, id)}>Aus Abschnitt „{folder.name}“ entfernen</MenuItem>}
          </MenuList>
        </MenuPopover>
      </Menu>
    )
  }

  const teamsSection = () => {
    if (filter === 'meetings' || filter === 'chats') return null
    const teams = (snapshot?.teams ?? []).filter(
      (t) =>
        !t.isArchived &&
        (filter !== 'unread' || t.channels.some((c) => c.unread)) &&
        (!q || t.displayName.toLowerCase().includes(q) || t.channels.some((c) => c.displayName.toLowerCase().includes(q)))
    )
    return teams
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'de'))
      .map((t) => {
        const open = openTeams[t.id] ?? (q.length > 0 || t.channels.some((c) => c.id === selection.channelId))
        const channels = t.channels.filter((c) => (filter === 'unread' ? c.unread : true) && (!q || c.displayName.toLowerCase().includes(q) || t.displayName.toLowerCase().includes(q)))
        return (
          <div key={t.id}>
            <div className={`list-item compact ${t.unread ? 'unread' : ''}`} onClick={() => setOpenTeams({ ...openTeams, [t.id]: !open })}>
              <span style={{ width: 16, display: 'inline-flex', color: 'var(--fg-3)' }}>{open ? <ChevronDown16Regular /> : <ChevronRight16Regular />}</span>
              <TeamAvatar team={t} size={24} />
              <div className="body">
                <span className="name">{t.displayName}</span>
              </div>
            </div>
            {open &&
              channels.map((c) => (
                <ChannelRow key={c.id} team={t} channel={c} indent selected={c.id === selection.channelId && !selection.chatId} onSelect={() => selectRow({ type: 'channel', team: t, channel: c })} />
              ))}
          </div>
        )
      })
  }

  return (
    <div className="list-pane">
      <div className="list-header">
        <h1>Chat</h1>
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <button className={`icon-btn ${filter !== 'all' ? 'active' : ''}`} title="Filtern">
              <Filter20Regular />
            </button>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItem onClick={() => setFilterOpen(true)}>Nach Name filtern</MenuItem>
              <MenuItem onClick={() => setFilter('all')}>Alle</MenuItem>
              <MenuItem onClick={() => setFilter('unread')}>Ungelesen</MenuItem>
              <MenuItem onClick={() => setFilter('chats')}>Chats</MenuItem>
              <MenuItem onClick={() => setFilter('meetings')}>Besprechungen</MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
        <Tooltip content="Neuer Chat (⌘N)" relationship="label">
          <button className="icon-btn" onClick={() => useStore.getState().select({ newChat: true, chatId: undefined, channelId: undefined }, 'chat')}>
            <Compose20Regular />
          </button>
        </Tooltip>
      </div>
      {(filterOpen || filter !== 'all') && (
        <div style={{ padding: '0 16px 8px', display: 'flex', gap: 6, alignItems: 'center' }}>
          <Input
            size="small"
            autoFocus
            placeholder="Nach Name filtern"
            value={text}
            onChange={(_e, d) => setText(d.value)}
            style={{ flex: 1 }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setText('')
                setFilterOpen(false)
                setFilter('all')
              }
            }}
          />
          <button
            className="icon-btn"
            onClick={() => {
              setText('')
              setFilterOpen(false)
              setFilter('all')
            }}
          >
            <Dismiss16Regular />
          </button>
        </div>
      )}
      <div
        className="list-scroll"
        onScroll={(e) => {
          const el = e.currentTarget
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) setLimit((l) => l + 150)
        }}
      >
        {!snapshot && <div style={{ padding: 20, color: 'var(--fg-3)' }}>Chats werden geladen …</div>}
        {sections.map((sec) => {
          const rows = sec.rows.filter(matches)
          if (!sec.teams && rows.length === 0) return null
          const isCollapsed = collapsed[sec.key]
          return (
            <div key={sec.key}>
              <button className="section-title" onClick={() => setCollapsed({ ...collapsed, [sec.key]: !isCollapsed })}>
                {isCollapsed ? <ChevronRight16Regular /> : <ChevronDown16Regular />}
                {sec.title}
              </button>
              {!isCollapsed && (sec.teams ? teamsSection() : rows.slice(0, sec.key === 'recent' ? limit : undefined).map((r) => renderRow(r, sec)))}
              {!isCollapsed && sec.folder && /UserDefined/i.test(sec.folder.sort) && drag && !sec.folder.items.includes(drag.id) && (
                <div
                  className="drop-zone"
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDropAt({ folderId: sec.folder!.id, index: sec.folder!.items.length })
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    addToFolder(sec.folder!, drag.id, sec.folder!.items.length)
                    setDrag(null)
                    setDropAt(null)
                  }}
                >
                  Hierher ziehen, um zu „{sec.title}“ hinzuzufügen
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function lastOf(r: Row): number {
  return r.type === 'chat' ? r.chat.lastMessage?.time ?? r.chat.lastActivity : r.channel.lastActivity ?? 0
}
function nameOf(r: Row): string {
  return r.type === 'chat' ? r.chat.title : r.channel.displayName
}

function ChatRow({ chat, selected, compact, onSelect }: { chat: ChatSummary; selected: boolean; compact: boolean; onSelect: () => void }): JSX.Element {
  const inCall = useStore((s) => !!s.callState && s.callState.title !== '' && (s.callState.conversationId === chat.id || (chat.kind === 'meeting' && s.callState.title === chat.title)))
  const accountId = useStore((s) => s.activeAccountId ?? '')
  const hover = useHoverPrefetch(() => !selected && prefetchChat(accountId, chat))
  const lm = chat.lastMessage
  let preview = lm?.text ?? ''
  if (lm && preview) {
    if (lm.isMine) preview = `Du: ${preview}`
    else if (chat.kind !== 'oneOnOne' && lm.fromName) preview = `${lm.fromName.split(/[\s,]+/)[0]}: ${preview}`
  }
  return (
    <div className={`list-item ${compact ? 'compact' : ''} ${selected ? 'selected' : ''} ${chat.unread && !chat.muted ? 'unread' : ''}`} onClick={onSelect} {...hover}>
      <span style={{ width: compact ? 16 : 0 }} />
      <ChatAvatar chat={chat} size={compact ? 24 : 32} />
      <div className="body">
        <div className="row1">
          <span className="name">{chat.title}</span>
          {chat.muted && <AlertOff16Regular style={{ color: 'var(--fg-4)', flexShrink: 0 }} />}
          {inCall && <Video16Filled style={{ color: 'var(--brand-fg)', flexShrink: 0 }} />}
          {!compact && <span className="time">{listTime(lm?.time ?? chat.lastActivity)}</span>}
        </div>
        {!compact && <div className="preview">{preview || (chat.kind === 'meeting' ? 'Besprechung' : '\u00a0')}</div>}
      </div>
      {chat.unread && !chat.muted && <span className="dot" />}
    </div>
  )
}

function ChannelRow({ team, channel, selected, onSelect, showTeam, indent }: { team: Team; channel: Channel; selected: boolean; onSelect: () => void; showTeam?: boolean; indent?: boolean }): JSX.Element {
  const accountId = useStore((s) => s.activeAccountId ?? '')
  const hover = useHoverPrefetch(() => !selected && prefetchChannel(accountId, team.id, channel.id))
  return (
    <div className={`list-item compact ${selected ? 'selected' : ''} ${channel.unread ? 'unread' : ''}`} onClick={onSelect} title={`${team.displayName} › ${channel.displayName}`} {...hover}>
      <span style={{ width: indent ? 44 : 16 }} />
      {showTeam && <TeamAvatar team={team} size={24} />}
      <div className="body">
        <div className="row1">
          <span className="name" style={{ flex: '0 1 auto' }}>{channel.displayName}</span>
          {channel.membershipType === 'private' && <LockClosed12Regular style={{ color: 'var(--fg-3)', flexShrink: 0 }} />}
        </div>
      </div>
      {channel.unread && <span className="dot" />}
    </div>
  )
}

function NewChat(): JSX.Element {
  const { account, snapshot } = useActive()
  const [picked, setPicked] = useState<Person[]>([])
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Person[]>([])
  const [active, setActive] = useState(0)
  const [topic, setTopic] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!account || q.trim().length < 2) {
      setResults([])
      return
    }
    const t = setTimeout(() => void api.searchPeople(account.id, q).then((r) => setResults(r.filter((p) => !picked.some((x) => x.mri === p.mri)))), 220)
    return () => clearTimeout(t)
  }, [q, account, picked])

  const pick = (p: Person) => {
    setPicked([...picked, p])
    setQ('')
    setResults([])
    setActive(0)
    inputRef.current?.focus()
  }

  // Vorhandenen Chat mit genau diesen Personen anzeigen
  const existing = useMemo(() => {
    if (picked.length !== 1 || !snapshot) return undefined
    return snapshot.chats.find((c) => c.kind === 'oneOnOne' && c.members[0] === picked[0].mri)
  }, [picked, snapshot])

  if (existing) {
    return (
      <div className="main-pane" style={{ position: 'relative' }}>
        <ToBar picked={picked} setPicked={setPicked} q={q} setQ={setQ} inputRef={inputRef} results={results} active={active} setActive={setActive} pick={pick} />
        <ConversationView key={`${account?.id}|${existing.id}`} chat={existing} />
      </div>
    )
  }

  return (
    <div className="main-pane" style={{ position: 'relative' }}>
      <ToBar picked={picked} setPicked={setPicked} q={q} setQ={setQ} inputRef={inputRef} results={results} active={active} setActive={setActive} pick={pick} />
      {picked.length > 1 && (
        <div style={{ padding: '8px 20px', borderBottom: '1px solid var(--border)' }}>
          <Input placeholder="Gruppenname (optional)" value={topic} onChange={(_e, d) => setTopic(d.value)} style={{ width: 360 }} />
        </div>
      )}
      <div className="empty-state">
        {picked.length === 0 ? <div>Gib oben Namen oder E-Mail-Adressen ein, um einen neuen Chat zu beginnen.</div> : <div>Neue Unterhaltung mit {picked.map((p) => p.displayName).join(', ')}</div>}
      </div>
      <Composer
        disabled={!account || picked.length === 0}
        placeholder="Neue Nachricht eingeben"
        onSend={async (p) => {
          if (!account) return
          const id = await api.createChat(account.id, picked.map((x) => x.mri), picked.length > 1 && topic.trim() ? topic.trim() : undefined)
          await api.sendMessage(account.id, id, p.html, { importance: p.importance })
          useStore.getState().select({ chatId: id, newChat: false }, 'chat')
          void api.refresh(account.id)
        }}
      />
    </div>
  )
}

function ToBar(props: {
  picked: Person[]
  setPicked: (p: Person[]) => void
  q: string
  setQ: (s: string) => void
  inputRef: React.RefObject<HTMLInputElement | null>
  results: Person[]
  active: number
  setActive: (n: number) => void
  pick: (p: Person) => void
}): JSX.Element {
  const { picked, setPicked, q, setQ, inputRef, results, active, setActive, pick } = props
  return (
    <div className="pane-header" style={{ height: 'auto', minHeight: 56, flexWrap: 'wrap', paddingTop: 8, paddingBottom: 8, position: 'relative' }}>
      <span style={{ color: 'var(--fg-3)' }}>An:</span>
      {picked.map((p) => (
        <span key={p.mri} className="chip">
          {p.displayName}
          <button onClick={() => setPicked(picked.filter((x) => x.mri !== p.mri))}>
            <Dismiss16Regular />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={picked.length ? '' : 'Namen, E-Mail-Adresse oder Gruppe eingeben'}
        style={{ flex: 1, minWidth: 200, border: 0, outline: 'none', background: 'transparent', font: 'inherit', color: 'var(--fg)' }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive(Math.min(active + 1, results.length - 1))
          if (e.key === 'ArrowUp') setActive(Math.max(active - 1, 0))
          if (e.key === 'Enter' && results[active]) pick(results[active])
          if (e.key === 'Backspace' && !q && picked.length) setPicked(picked.slice(0, -1))
        }}
      />
      {results.length > 0 && (
        <div className="search-results" style={{ top: '100%', left: 60, transform: 'none', width: 420 }}>
          {results.map((p, i) => (
            <div key={p.mri} className={`person-row ${i === active ? 'active' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)}>
              <PersonAvatar mri={p.mri} name={p.displayName} size={28} />
              <div>
                <div className="p-name">{p.displayName}</div>
                <div className="p-sub">{[p.jobTitle, p.email].filter(Boolean).join(' · ')}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
