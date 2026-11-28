import {
  Alert24Filled,
  Alert24Regular,
  Chat24Filled,
  Chat24Regular,
  CalendarLtr24Filled,
  CalendarLtr24Regular,
  Call24Filled,
  Call24Regular,
  Mail24Filled,
  Mail24Regular,
  Settings24Regular,
  Settings24Filled
} from '@fluentui/react-icons'
import { Tooltip } from '@fluentui/react-components'
import type { ComponentType } from 'react'
import { chatBadge } from '@shared/badge'
import { useStore, type View } from '../store'
import { UpdateButton } from './UpdateButton'
import { useMailUnread, useMailUnreadPolling } from '../lib/mail-unread'

interface Item {
  view: View
  label: string
  shortcut: string
  icon: ComponentType
  active: ComponentType
}

const ITEMS: Item[] = [
  { view: 'activity', label: 'Aktivität', shortcut: '⌘ 1', icon: Alert24Regular, active: Alert24Filled },
  { view: 'chat', label: 'Chat', shortcut: '⌘ 2', icon: Chat24Regular, active: Chat24Filled },
  { view: 'mail', label: 'E-Mail', shortcut: '⌘ 3', icon: Mail24Regular, active: Mail24Filled },
  { view: 'calendar', label: 'Kalender', shortcut: '⌘ 4', icon: CalendarLtr24Regular, active: CalendarLtr24Filled },
  { view: 'calls', label: 'Anrufe', shortcut: '⌘ 5', icon: Call24Regular, active: Call24Filled }
]

export function Rail(): JSX.Element {
  const view = useStore((s) => s.view)
  const settingsOpen = useStore((s) => s.settingsPage !== null)
  const accounts = useStore((s) => s.accounts)
  useMailUnreadPolling()
  const mail = useMailUnread((s) => Object.values(s.counts).reduce((n, c) => n + c, 0))
  // Chatliste und Aktivität zeigen alle Konten, also zählen ihre Knöpfe auch alle
  const badges: Partial<Record<View, number>> = {
    mail,
    activity: accounts.reduce((n, a) => n + a.activityUnread, 0),
    chat: accounts.reduce((n, a) => n + chatBadge(a), 0)
  }
  return (
    <nav className="rail">
      {ITEMS.map((it) => {
        const active = view === it.view && !settingsOpen
        const Icon = active ? it.active : it.icon
        const badge = badges[it.view] ?? 0
        const name = `${it.label} (${it.shortcut})`
        return (
          <Tooltip key={it.view} content={name} relationship="inaccessible" positioning="after">
            <button
              className={`rail-item ${active ? 'active' : ''}`}
              aria-label={badge > 0 ? `${name}, ${badge} ungelesen` : name}
              onClick={() => useStore.getState().setView(it.view)}
            >
              <Icon />
              {badge > 0 && <span className="rail-badge">{badge > 99 ? '99+' : badge}</span>}
            </button>
          </Tooltip>
        )
      })}
      <div className="rail-spacer" />
      <UpdateButton />
      <Tooltip content="Einstellungen (⌘ ,)" relationship="label" positioning="after">
        <button
          className={`rail-item ${settingsOpen ? 'active' : ''}`}
          onClick={() => (settingsOpen ? useStore.getState().closeSettings() : useStore.getState().openSettings())}
          style={{ marginBottom: 8 }}
        >
          {settingsOpen ? <Settings24Filled /> : <Settings24Regular />}
        </button>
      </Tooltip>
    </nav>
  )
}
