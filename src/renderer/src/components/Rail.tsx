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
import type { ComponentType } from 'react'
import { useActive, useStore, type View } from '../store'

interface Item {
  view: View
  label: string
  icon: ComponentType
  active: ComponentType
}

const ITEMS: Item[] = [
  { view: 'activity', label: 'Aktivität', icon: Alert24Regular, active: Alert24Filled },
  { view: 'chat', label: 'Chat', icon: Chat24Regular, active: Chat24Filled },
  { view: 'calendar', label: 'Kalender', icon: CalendarLtr24Regular, active: CalendarLtr24Filled },
  { view: 'calls', label: 'Anrufe', icon: Call24Regular, active: Call24Filled }
]

export function Rail(): JSX.Element {
  const view = useStore((s) => s.view)
  const { account, snapshot } = useActive()
  const teamsUnread = snapshot?.teams.filter((t) => t.unread).length ?? 0
  const badges: Partial<Record<View, number>> = {
    activity: account?.activityUnread ?? 0,
    chat: (account?.unread ?? 0) + teamsUnread
  }
  return (
    <nav className="rail">
      {ITEMS.map((it) => {
        const Icon = view === it.view ? it.active : it.icon
        const badge = badges[it.view] ?? 0
        return (
          <button key={it.view} className={`rail-item ${view === it.view ? 'active' : ''}`} onClick={() => useStore.getState().setView(it.view)}>
            <Icon />
            <span>{it.label}</span>
            {badge > 0 && <span className="rail-badge">{badge > 99 ? '99+' : badge}</span>}
          </button>
        )
      })}
      <div className="rail-spacer" />
      <button className={`rail-item ${view === 'settings' ? 'active' : ''}`} onClick={() => useStore.getState().setView('settings')} style={{ marginBottom: 8 }}>
        {view === 'settings' ? <Settings24Filled /> : <Settings24Regular />}
        <span>Einstellungen</span>
      </button>
    </nav>
  )
}
