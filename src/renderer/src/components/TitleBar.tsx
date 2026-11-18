import {
  Menu,
  MenuDivider,
  MenuGroupHeader,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  CounterBadge,
  Tooltip
} from '@fluentui/react-components'
import {
  ArrowLeft20Regular,
  ArrowRight20Regular,
  Search20Regular,
  MoreHorizontal20Regular,
  Settings20Regular,
  PersonAdd20Regular,
  SignOut20Regular,
  ArrowSync20Regular,
  Window20Regular,
  Checkmark16Regular
} from '@fluentui/react-icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Availability, Person } from '@shared/types'
import { api } from '../api'
import { useActive, useStore } from '../store'
import { ChatAvatar, PersonAvatar, presenceLabel } from './Avatars'

const STATUS: { value: Availability | 'Reset'; label: string; color: string }[] = [
  { value: 'Available', label: 'Verfügbar', color: '#6bb700' },
  { value: 'Busy', label: 'Beschäftigt', color: '#c4314b' },
  { value: 'DoNotDisturb', label: 'Nicht stören', color: '#c4314b' },
  { value: 'BeRightBack', label: 'Bin gleich zurück', color: '#f8d22a' },
  { value: 'Away', label: 'Als abwesend anzeigen', color: '#f8d22a' },
  { value: 'Offline', label: 'Als offline anzeigen', color: '#8a8a8a' },
  { value: 'Reset', label: 'Status zurücksetzen', color: 'transparent' }
]

export function TitleBar(): JSX.Element {
  const { account, snapshot } = useActive()
  const accounts = useStore((s) => s.accounts)
  const back = useStore((s) => s.back.length)
  const fwd = useStore((s) => s.forward.length)
  const myPresence = account?.mri ? snapshot?.presence[account.mri] : undefined

  return (
    <div className="titlebar">
      <div className="nav-arrows">
        <button className="icon-btn" disabled={!back} onClick={() => useStore.getState().goBack()} title="Zurück">
          <ArrowLeft20Regular />
        </button>
        <button className="icon-btn" disabled={!fwd} onClick={() => useStore.getState().goForward()} title="Vorwärts">
          <ArrowRight20Regular />
        </button>
      </div>
      <div className="search">
        <GlobalSearch />
      </div>
      <div className="right">
        <Menu positioning="below-end">
          <MenuTrigger disableButtonEnhancement>
            <button className="icon-btn" title="Einstellungen und mehr">
              <MoreHorizontal20Regular />
            </button>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItem icon={<Settings20Regular />} onClick={() => useStore.getState().setView('settings')}>
                Einstellungen
              </MenuItem>
              {account && (
                <MenuItem icon={<ArrowSync20Regular />} onClick={() => void api.refresh(account.id)}>
                  Daten neu laden
                </MenuItem>
              )}
              {account && (
                <MenuItem icon={<Window20Regular />} onClick={() => void api.showEngine(account.id)}>
                  Teams-Webansicht anzeigen
                </MenuItem>
              )}
            </MenuList>
          </MenuPopover>
        </Menu>
        <Menu positioning="below-end">
          <MenuTrigger disableButtonEnhancement>
            <button className="icon-btn" style={{ width: 36, height: 36, position: 'relative' }} title={account?.label}>
              {account ? <PersonAvatar mri={account.mri} name={account.label} size={28} /> : <PersonAdd20Regular />}
              {accounts.some((a) => a.id !== account?.id && a.unread + a.activityUnread > 0) && (
                <span style={{ position: 'absolute', top: 2, left: 2, width: 8, height: 8, borderRadius: 4, background: 'var(--danger)' }} />
              )}
            </button>
          </MenuTrigger>
          <MenuPopover style={{ minWidth: 300 }}>
            <MenuList>
              {account && (
                <>
                  <div style={{ display: 'flex', gap: 12, padding: '10px 12px', alignItems: 'center' }}>
                    <PersonAvatar mri={account.mri} name={account.label} size={48} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700 }}>{account.displayName ?? account.label}</div>
                      <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>{account.upn}</div>
                      <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>{presenceLabel(myPresence) || statusText(account.status)}</div>
                    </div>
                  </div>
                  <MenuDivider />
                  <MenuGroupHeader>Status festlegen</MenuGroupHeader>
                  {STATUS.map((s) => (
                    <MenuItem
                      key={s.value}
                      icon={<span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 5, background: s.color, border: s.value === 'Offline' ? '1px solid #8a8a8a' : undefined }} />}
                      onClick={() => void api.setMyPresence(account.id, s.value)}
                    >
                      {s.label}
                    </MenuItem>
                  ))}
                  <MenuDivider />
                </>
              )}
              <MenuGroupHeader>Konten</MenuGroupHeader>
              {accounts.map((a) => (
                <MenuItem
                  key={a.id}
                  icon={<PersonAvatar mri={a.mri} name={a.label} size={24} accountId={a.id} />}
                  secondaryContent={a.unread + a.activityUnread > 0 ? <CounterBadge count={a.unread + a.activityUnread} size="small" color="danger" /> : a.id === account?.id ? <Checkmark16Regular /> : undefined}
                  onClick={() => useStore.getState().setActiveAccount(a.id)}
                >
                  <div>
                    <div>{a.label}</div>
                    {a.status !== 'ready' && <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>{statusText(a.status)}</div>}
                  </div>
                </MenuItem>
              ))}
              <MenuItem icon={<PersonAdd20Regular />} onClick={() => void api.addAccount()}>
                Weiteres Konto hinzufügen
              </MenuItem>
              {account && (
                <MenuItem
                  icon={<SignOut20Regular />}
                  onClick={() => {
                    if (confirm(`${account.label} abmelden und aus der App entfernen?`)) void api.removeAccount(account.id)
                  }}
                >
                  Abmelden
                </MenuItem>
              )}
            </MenuList>
          </MenuPopover>
        </Menu>
      </div>
    </div>
  )
}

export function statusText(s: string): string {
  switch (s) {
    case 'ready':
      return 'Verbunden'
    case 'login-required':
      return 'Anmeldung erforderlich'
    case 'connecting':
      return 'Verbindung wird hergestellt …'
    case 'starting':
      return 'Wird gestartet …'
    case 'error':
      return 'Fehler'
    default:
      return s
  }
}

function GlobalSearch(): JSX.Element {
  const { account, snapshot } = useActive()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [people, setPeople] = useState<Person[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.metaKey && (e.key === 'e' || e.key === 'f') && !e.shiftKey) {
        e.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  useEffect(() => {
    if (!account || q.trim().length < 2) {
      setPeople([])
      return
    }
    const t = setTimeout(() => {
      void api.searchPeople(account.id, q).then(setPeople).catch(() => setPeople([]))
    }, 250)
    return () => clearTimeout(t)
  }, [q, account])

  const chats = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s || !snapshot) return []
    return snapshot.chats.filter((c) => c.title.toLowerCase().includes(s)).slice(0, 8)
  }, [q, snapshot])

  const channels = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s || !snapshot) return []
    return snapshot.teams
      .flatMap((t) => t.channels.map((c) => ({ team: t, channel: c })))
      .filter(({ team, channel }) => channel.displayName.toLowerCase().includes(s) || team.displayName.toLowerCase().includes(s))
      .slice(0, 6)
  }, [q, snapshot])

  const close = () => {
    setOpen(false)
    setQ('')
    inputRef.current?.blur()
  }

  const openPerson = async (p: Person) => {
    if (!account) return
    close()
    const id = await api.createChat(account.id, [p.mri])
    useStore.getState().select({ chatId: id, newChat: false }, 'chat')
  }

  return (
    <div style={{ position: 'relative', width: '100%', display: 'flex', justifyContent: 'center' }}>
      <div className="search-box">
        <Search20Regular />
        <input
          ref={inputRef}
          placeholder="Suchen (⌘E)"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close()
            if (e.key === 'Enter') {
              if (chats[0]) {
                useStore.getState().select({ chatId: chats[0].id, newChat: false }, 'chat')
                close()
              } else if (people[0]) void openPerson(people[0])
            }
          }}
        />
      </div>
      {open && q.trim().length > 0 && (chats.length > 0 || people.length > 0 || channels.length > 0) && (
        <div className="search-results" onMouseDown={(e) => e.preventDefault()}>
          {chats.length > 0 && <div className="group-title">Chats</div>}
          {chats.map((c) => (
            <div
              key={c.id}
              className="person-row"
              onClick={() => {
                useStore.getState().select({ chatId: c.id, newChat: false }, 'chat')
                close()
              }}
            >
              <ChatAvatar chat={c} size={28} />
              <div className="p-name">{c.title}</div>
            </div>
          ))}
          {channels.length > 0 && <div className="group-title">Kanäle</div>}
          {channels.map(({ team, channel }) => (
            <div
              key={channel.id}
              className="person-row"
              onClick={() => {
                useStore.getState().select({ chatId: undefined, newChat: false, teamId: team.id, channelId: channel.id }, 'chat')
                close()
              }}
            >
              <div>
                <div className="p-name">{channel.displayName}</div>
                <div className="p-sub">{team.displayName}</div>
              </div>
            </div>
          ))}
          {people.length > 0 && <div className="group-title">Personen</div>}
          {people.map((p) => (
            <div key={p.mri} className="person-row" onClick={() => void openPerson(p)}>
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

export function Tip({ content, children }: { content: string; children: JSX.Element }): JSX.Element {
  return (
    <Tooltip content={content} relationship="label" withArrow>
      {children}
    </Tooltip>
  )
}
