import { Button, Spinner } from '@fluentui/react-components'
import { Video20Filled, Warning20Regular } from '@fluentui/react-icons'
import { useEffect, useState } from 'react'
import { api } from './api'
import { track } from './analytics'
import { UsageDataPrompt } from './components/UsageDataPrompt'
import { ImageViewer } from './components/ImageViewer'
import { Rail } from './components/Rail'
import { UpdateButton } from './components/UpdateButton'
import { showUpdateButton, updateStatusText } from './update'
import { TitleBar, statusText } from './components/TitleBar'
import { duration } from './lib/format'
import { initStore, useActive, useStore, type View } from './store'
import { ActivityView } from './views/ActivityView'
import { CalendarView } from './views/CalendarView'
import { CallsView } from './views/CallsView'
import { ChatView } from './views/ChatView'
import { SettingsView } from './views/SettingsView'
import { TeamsView } from './views/TeamsView'

initStore()

const KEYS: Record<string, View> = { '1': 'activity', '2': 'chat', '3': 'calendar', '4': 'calls' }

export default function MainApp(): JSX.Element {
  const accounts = useStore((s) => s.accounts)
  const view = useStore((s) => s.view)
  const settingsLoaded = useStore((s) => !!s.settings)
  const { account, snapshot } = useActive()

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!e.metaKey) return
      if (KEYS[e.key] && !e.shiftKey) {
        e.preventDefault()
        useStore.getState().setView(KEYS[e.key])
        track('keyboard_shortcut', { shortcut: `cmd+${e.key}` })
      } else if (e.key === 'n' && !e.shiftKey) {
        e.preventDefault()
        useStore.getState().select({ newChat: true }, 'chat')
        track('keyboard_shortcut', { shortcut: 'cmd+n' })
      } else if (e.key === '[') {
        useStore.getState().goBack()
        track('keyboard_shortcut', { shortcut: 'cmd+[' })
      } else if (e.key === ']') {
        useStore.getState().goForward()
        track('keyboard_shortcut', { shortcut: 'cmd+]' })
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  if (!settingsLoaded) return <div className="app" />

  if (accounts.length === 0) return <Welcome />

  let content: JSX.Element
  if (view === 'settings') content = <SettingsView />
  else if (!snapshot) content = <Loading />
  else if (view === 'chat') content = <ChatView />
  else if (view === 'teams') content = <TeamsView />
  else if (view === 'activity') content = <ActivityView />
  else if (view === 'calendar') content = <CalendarView />
  else content = <CallsView />

  return (
    <div className="app">
      <TitleBar />
      <Rail />
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        <CallBanner />
        <UsageDataPrompt />
        {account && account.status === 'login-required' && (
          <div className="banner warn">
            <Warning20Regular />
            <span style={{ flex: 1 }}>
              {account.mri ? `Die Anmeldung für ${account.label} ist abgelaufen.` : 'Bitte melde dich im Microsoft-Fenster an, um Teams zu verbinden.'}
            </span>
            <Button size="small" appearance="primary" onClick={() => void api.showLogin(account.id)}>
              Anmelden
            </Button>
          </div>
        )}
        {account && account.status === 'error' && (
          <div className="banner warn">
            <Warning20Regular />
            <span style={{ flex: 1 }}>{account.statusDetail ?? 'Verbindung zu Teams unterbrochen.'}</span>
            <Button size="small" onClick={() => void api.reloadAccount(account.id)}>
              Neu verbinden
            </Button>
          </div>
        )}
        <div className="workspace" style={{ flex: 1 }}>
          {content}
        </div>
      </div>
      <ImageViewer />
    </div>
  )
}

function Loading(): JSX.Element {
  const { account } = useActive()
  return (
    <div className="main-pane">
      <div className="empty-state">
        {account?.status !== 'login-required' && <Spinner />}
        <div>{account?.status === 'ready' ? 'Daten werden synchronisiert …' : statusText(account?.status ?? 'starting')}</div>
        {account?.status === 'login-required' && (
          <Button appearance="primary" onClick={() => void api.showLogin(account.id)}>
            Anmeldefenster öffnen
          </Button>
        )}
      </div>
    </div>
  )
}

function Welcome(): JSX.Element {
  return (
    <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="drag" style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 48 }} />
      <div style={{ position: 'fixed', left: 8, bottom: 8 }}>
        <WelcomeUpdate />
      </div>
      <div style={{ textAlign: 'center', maxWidth: 440, display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
        <div style={{ width: 72, height: 72, borderRadius: 18, background: 'var(--brand)', color: 'white', fontSize: 38, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>T</div>
        <h1 style={{ margin: 0, fontSize: 26 }}>Willkommen bei Teams</h1>
        <div style={{ color: 'var(--fg-3)', lineHeight: '20px' }}>
          Melde dich mit deinem Geschäfts- oder Schulkonto an. Die Anmeldung läuft direkt bei Microsoft, die App nutzt danach die Teams-Web-App im Hintergrund.
        </div>
        <Button appearance="primary" size="large" onClick={() => void api.addAccount()}>
          Anmelden
        </Button>
        <UsageDataPrompt card />
      </div>
    </div>
  )
}

// Ohne Konto gibt es keine Einstellungsseite. Hier zeigt der Willkommensbildschirm,
// was „Nach Updates suchen …“ ergeben hat.
function WelcomeUpdate(): JSX.Element | null {
  const update = useStore((s) => s.update)
  if (showUpdateButton(update)) return <UpdateButton />
  if (update && ['checking', 'up-to-date', 'error'].includes(update.status)) {
    return <div style={{ padding: 8, fontSize: 12, color: 'var(--fg-3)' }}>{updateStatusText(update)}</div>
  }
  return null
}

function CallBanner(): JSX.Element | null {
  const call = useStore((s) => s.callState)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!call) return
    const t = setInterval(() => tick((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [call])
  if (!call) return null
  return (
    <div className="call-banner" onClick={() => void api.openCallWindow()}>
      <Video20Filled />
      <span className="grow">
        {call.title || 'Anruf'} {call.startedAt ? `· ${duration((Date.now() - call.startedAt) / 1000)}` : ''}
      </span>
      <Button
        size="small"
        appearance="primary"
        style={{ background: 'rgba(255,255,255,0.18)' }}
        onClick={(e) => {
          e.stopPropagation()
          void api.callAction('toggleMute')
        }}
      >
        {call.muted ? 'Stummschaltung aufheben' : 'Stummschalten'}
      </Button>
      <Button
        size="small"
        style={{ background: 'var(--danger)', color: 'white', border: 0 }}
        onClick={(e) => {
          e.stopPropagation()
          void api.callAction('hangup')
        }}
      >
        Verlassen
      </Button>
    </div>
  )
}
