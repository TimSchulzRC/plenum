// Listen über alle Konten (Chat, Aktivität, Anrufe): Kopf je Konto, Kontomarke an einer Zeile
// und der Schalter, der Aktivität und Anrufe nach Konto gruppiert.
import { Avatar, Tooltip } from '@fluentui/react-components'
import { ChevronDown16Regular, ChevronRight16Regular, GroupList20Regular, Warning20Regular } from '@fluentui/react-icons'
import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { accountTitle, colorOrder, orderAccounts } from '@shared/accounts'
import type { AccountInfo } from '@shared/types'
import { api } from '../api'
import { accountColor } from '../lib/calendar'
import { AccountScope, useStore } from '../store'
import { PersonAvatar } from './Avatars'
import { statusText } from './TitleBar'

export const HEAD_HEIGHT = 36
// Abstand zwischen den Köpfen, auch wenn sie oben oder unten kleben (passt zu .acct-head in styles.css)
export const HEAD_GAP = 6
export const HEAD_STEP = HEAD_HEIGHT + HEAD_GAP

export interface AccountList {
  // Konten und Gastmandanten in der Reihenfolge der Chatliste
  accounts: AccountInfo[]
  multi: boolean
  color(id: string): string
  byId(id: string): AccountInfo | undefined
}

export function useAccounts(): AccountList {
  const all = useStore((s) => s.accounts)
  return useMemo(() => {
    const accounts = orderAccounts(all)
    const ids = colorOrder(accounts)
    return { accounts, multi: accounts.length > 1, color: (id) => accountColor(ids, id), byId: (id) => accounts.find((a) => a.id === id) }
  }, [all])
}

export function AccountHead({ account, unread: count, open, style, onToggle }: { account: AccountInfo; unread: number; open: boolean; style: CSSProperties; onToggle: () => void }): JSX.Element {
  const { name, sub } = accountTitle(account)
  return (
    <button className="acct-head" style={style} onClick={onToggle} aria-expanded={open} title={[name, sub].filter(Boolean).join(' · ')}>
      {account.parentId ? <Avatar shape="square" size={20} name={name} color="colorful" /> : <PersonAvatar mri={account.mri} name={account.label} size={20} accountId={account.id} showPresence={false} />}
      <span className="acct-name">{name}</span>
      <span className="acct-sub">{sub}</span>
      {account.status !== 'ready' ? <span className="acct-state">{statusText(account.status)}</span> : count > 0 && <span className="acct-count">{count > 99 ? '99+' : count}</span>}
      {/* Pfeil rechts, damit der Kontokopf nicht wie ein Abschnitt (Favoriten, Chats) aussieht */}
      {open ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
    </button>
  )
}

// Zu welchem Konto ein Eintrag gehört: Punkt in der Kontofarbe (wie in Mail und Kalender) und Name
export function AccountTag({ account, color }: { account?: AccountInfo; color: string }): JSX.Element | null {
  if (!account) return null
  const { name, sub } = accountTitle(account)
  return (
    <span className="acct-tag" title={[name, sub].filter(Boolean).join(' · ')}>
      <span className="acct-dot" style={{ background: color }} />
      <span className="acct-tag-name">{name}</span>
    </span>
  )
}

// Konten ohne Liste: noch nicht verbunden oder Abruf gescheitert. what: Satzanfang für ein einzelnes Konto.
export function NotLoaded({ accounts, lists, what }: { accounts: AccountInfo[]; lists: Record<string, { error?: string } | undefined>; what: string }): JSX.Element {
  const multi = useStore((s) => s.accounts.length > 1)
  const why = (a: AccountInfo) => lists[a.id]?.error ?? statusText(a.status)
  return (
    <div className="banner list-banner">
      <Warning20Regular />
      <span className="grow">{multi ? `Nicht geladen: ${accounts.map((a) => `${accountTitle(a).name} (${why(a)})`).join(', ')}` : `${what}: ${why(accounts[0])}`}</span>
    </div>
  )
}

export type GroupSetting = 'groupActivityByAccount' | 'groupCallsByAccount'

export function useGrouped(setting: GroupSetting): boolean {
  return useStore((s) => s.accounts.length > 1 && !!s.settings?.[setting])
}

// Nur mit mehreren Konten. Die Einstellung zählt in den Nutzungsdaten (setting_changed).
export function GroupToggle({ setting }: { setting: GroupSetting }): JSX.Element | null {
  const multi = useStore((s) => s.accounts.length > 1)
  const on = useStore((s) => !!s.settings?.[setting])
  if (!multi) return null
  return (
    <Tooltip content="Nach Konto gruppieren" relationship="label">
      <button className={`icon-btn ${on ? 'active' : ''}`} aria-pressed={on} onClick={() => void api.setSettings({ [setting]: !on })}>
        <GroupList20Regular />
      </button>
    </Tooltip>
  )
}

function loadClosed(key: string): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}

// Ein Block je Konto, aufgeklappt bis man ihn zuklappt. Die Köpfe kleben oben und unten wie in der
// Chatliste, so bleiben alle Konten sichtbar. Der Scrollbereich braucht die Klasse multi.
export function AccountGroups({
  accounts,
  storageKey,
  count,
  children
}: {
  accounts: AccountInfo[]
  storageKey: string
  count?: (a: AccountInfo) => number
  children: (a: AccountInfo) => ReactNode
}): JSX.Element {
  const [closed, setClosed] = useState<Record<string, boolean>>(() => loadClosed(storageKey))
  const bodies = useRef<Record<string, HTMLDivElement | null>>({})
  const toggle = (id: string, index: number) => {
    const opening = !!closed[id]
    const next = { ...closed, [id]: !opening }
    setClosed(next)
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      /* nur Komfort */
    }
    if (!opening) return
    // Aufgeklappten Block nach oben holen, auch wenn sein Kopf gerade unten klebt
    requestAnimationFrame(() => {
      const body = bodies.current[id]
      const scroller = body?.parentElement
      if (body && scroller) scroller.scrollTop = body.offsetTop - index * HEAD_STEP - HEAD_HEIGHT
    })
  }
  return (
    <>
      {accounts.map((a, i) => {
        const open = !closed[a.id]
        return (
          <AccountScope.Provider key={a.id} value={a.id}>
            <AccountHead
              account={a}
              unread={count?.(a) ?? 0}
              open={open}
              style={{ top: i * HEAD_STEP, bottom: (accounts.length - 1 - i) * HEAD_STEP, zIndex: 2 + i }}
              onToggle={() => toggle(a.id, i)}
            />
            <div ref={(el) => void (bodies.current[a.id] = el)}>{open && children(a)}</div>
          </AccountScope.Provider>
        )
      })}
    </>
  )
}
