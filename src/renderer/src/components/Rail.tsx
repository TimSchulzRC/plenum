import {
  Alert24Filled,
  Alert24Regular,
  Chat24Filled,
  Chat24Regular,
  CalendarLtr24Filled,
  CalendarLtr24Regular,
  Call24Filled,
  Call24Regular,
  Settings24Regular,
  Settings24Filled
} from '@fluentui/react-icons'
import { Tooltip } from '@fluentui/react-components'
import type { ComponentType } from 'react'
import { chatBadge } from '@shared/badge'
import { useActive, useStore, type View } from '../store'
import { UpdateButton } from './UpdateButton'

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
  { view: 'calendar', label: 'Kalender', shortcut: '⌘ 3', icon: CalendarLtr24Regular, active: CalendarLtr24Filled },
  { view: 'calls', label: 'Anrufe', shortcut: '⌘ 4', icon: Call24Regular, active: Call24Filled }
]

export function Rail(): JSX.Element {
  const view = useStore((s) => s.view)
  const accounts = useStore((s) => s.accounts)
  const { account } = useActive()
  const badges: Partial<Record<View, number>> = {
    activity: account?.activityUnread ?? 0,
    // Die Chatliste zeigt alle Konten, also zählt der Chat-Knopf auch alle
    chat: accounts.reduce((n, a) => n + chatBadge(a), 0)
  }
  return (
    <nav className="rail">
      {ITEMS.map((it) => {
        const Icon = view === it.view ? it.active : it.icon
        const badge = badges[it.view] ?? 0
        const name = `${it.label} (${it.shortcut})`
        return (
          <Tooltip key={it.view} content={name} relationship="inaccessible" positioning="after">
            <button
              className={`rail-item ${view === it.view ? 'active' : ''}`}
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
        <button className={`rail-item ${view === 'settings' ? 'active' : ''}`} onClick={() => useStore.getState().setView('settings')} style={{ marginBottom: 8 }}>
          {view === 'settings' ? <Settings24Filled /> : <Settings24Regular />}
        </button>
      </Tooltip>
    </nav>
  )
}
