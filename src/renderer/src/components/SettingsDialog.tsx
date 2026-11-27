import { Avatar, Button, Dropdown, Option, Radio, RadioGroup, Switch, Badge, Textarea } from '@fluentui/react-components'
import {
  Alert20Regular,
  ArrowLeft20Regular,
  ArrowSync20Regular,
  Headset20Regular,
  LockClosed20Regular,
  PaintBrush20Regular,
  PersonCircle20Regular,
  PersonFeedback20Regular,
  PlugConnected20Regular,
  ShieldCheckmark20Regular,
  Wrench20Regular
} from '@fluentui/react-icons'
import { Fragment, useEffect, useRef, useState, type ComponentType } from 'react'
import { FEEDBACK_MAX_LENGTH, type FeedbackKind } from '@shared/analytics'
import type { AccountInfo, AppSettings, DebugInfo, SettingsPage, TenantInfo } from '@shared/types'
import { api } from '../api'
import { USAGE_DATA_DOC } from '../analytics'
import { PersonAvatar } from './Avatars'
import { McpSettings } from './McpSettings'
import { PermissionSettings, permissionMissing, usePermissions } from './PermissionSettings'
import { statusText } from './TitleBar'
import { confirmInstall, resolveUpdateAction, updateLastChecked, updateStatusText } from '../update'
import { useStore } from '../store'

interface PageInfo {
  id: SettingsPage
  label: string
  icon: ComponentType
  // Kurze Erklärung unter der Überschrift
  intro?: string
}

const GROUPS: { label: string; pages: PageInfo[] }[] = [
  {
    label: 'Allgemein',
    pages: [
      { id: 'accounts', label: 'Konten', icon: PersonCircle20Regular, intro: 'Jedes Konto und jeder Gastmandant läuft in einer eigenen, getrennten Sitzung der Teams-Web-App.' },
      { id: 'appearance', label: 'Darstellung', icon: PaintBrush20Regular },
      { id: 'notifications', label: 'Benachrichtigungen', icon: Alert20Regular }
    ]
  },
  {
    label: 'Anrufe',
    pages: [
      { id: 'devices', label: 'Geräte', icon: Headset20Regular, intro: 'Diese Auswahl gilt für Anrufe und Besprechungen. „Standard“ übernimmt die Einstellung aus Teams.' },
      {
        id: 'permissions',
        label: 'Berechtigungen',
        icon: ShieldCheckmark20Regular,
        intro: 'Erteile die Freigaben hier vorab, dann fragt macOS nicht erst mitten im ersten Anruf nach.'
      }
    ]
  },
  {
    label: 'App',
    pages: [
      { id: 'updates', label: 'Updates', icon: ArrowSync20Regular },
      {
        id: 'mcp',
        label: 'Claude Code und Codex',
        icon: PlugConnected20Regular,
        intro: 'Claude Code, Codex und andere MCP-Clients auf diesem Gerät lesen darüber Chats, Kanäle, geteilte Dateien, Anrufverlauf, Aktivität, Kalender und E-Mails aller Konten. Sie können nichts senden oder ändern.'
      },
      { id: 'privacy', label: 'Datenschutz', icon: LockClosed20Regular },
      { id: 'feedback', label: 'Feedback', icon: PersonFeedback20Regular },
      { id: 'diagnostics', label: 'Diagnose', icon: Wrench20Regular }
    ]
  }
]

// Einstellungen als Fenster über der App: links die Bereiche, rechts der gewählte.
// Escape, „Zurück“ oder ein Klick daneben schließen es.
export function SettingsDialog(): JSX.Element | null {
  const page = useStore((s) => s.settingsPage)
  const update = useStore((s) => s.update)
  const [analyticsInfo, setAnalyticsInfo] = useState<{ available: boolean; installId?: string } | null>(null)
  const [perms, setPerms] = usePermissions(page !== null, page === 'permissions')
  const dialogRef = useRef<HTMLDivElement>(null)
  const open = page !== null

  useEffect(() => {
    if (!open) return
    void api.getAnalyticsInfo().then(setAnalyticsInfo)
    const prevFocus = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      // Offene Dropdowns schließen sich mit Escape selbst und markieren das Ereignis
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        useStore.getState().closeSettings()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      prevFocus?.focus?.()
    }
  }, [open])

  if (!page) return null

  const hidden = (id: SettingsPage) => (id === 'updates' && !update) || ((id === 'privacy' || id === 'feedback') && !analyticsInfo?.available)
  const groups = GROUPS.map((g) => ({ ...g, pages: g.pages.filter((p) => !hidden(p.id)) }))
  const all = groups.flatMap((g) => g.pages)
  const current = all.find((p) => p.id === page) ?? all[0]
  const close = () => useStore.getState().closeSettings()

  return (
    <div
      className="settings-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="settings-dialog" role="dialog" aria-modal="true" aria-label="Einstellungen" tabIndex={-1} ref={dialogRef}>
        <nav className="settings-nav">
          <button className="settings-back" onClick={close}>
            <ArrowLeft20Regular />
            Zurück
          </button>
          {groups.map((g) => (
            <Fragment key={g.label}>
              <div className="settings-nav-group">{g.label}</div>
              {g.pages.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  className={`settings-nav-item ${id === current.id ? 'active' : ''}`}
                  aria-current={id === current.id ? 'page' : undefined}
                  onClick={() => useStore.getState().openSettings(id)}
                >
                  <Icon />
                  <span className="grow">{label}</span>
                  {id === 'permissions' && permissionMissing(perms) && <span className="settings-nav-dot" title="Eine Freigabe fehlt" />}
                </button>
              ))}
            </Fragment>
          ))}
          {update && <div className="settings-nav-foot">Plenum {update.currentVersion}</div>}
        </nav>
        <div className="settings" key={current.id}>
          <h1>{current.label}</h1>
          {current.intro && <p className="settings-intro">{current.intro}</p>}
          {current.id === 'accounts' && <AccountsPage />}
          {current.id === 'appearance' && <AppearancePage />}
          {current.id === 'notifications' && <NotificationsPage />}
          {current.id === 'devices' && <DevicesPage />}
          {current.id === 'permissions' && <PermissionSettings perms={perms} onChange={setPerms} />}
          {current.id === 'updates' && <UpdatesPage />}
          {current.id === 'mcp' && <McpSettings />}
          {current.id === 'privacy' && analyticsInfo && <PrivacyPage installId={analyticsInfo.installId} />}
          {current.id === 'feedback' && <FeedbackSection />}
          {current.id === 'diagnostics' && <DiagnosticsPage />}
        </div>
      </div>
    </div>
  )
}

function useSet(): (patch: Partial<AppSettings>) => void {
  return (patch) => void api.setSettings(patch)
}

function AccountsPage(): JSX.Element {
  const accounts = useStore((s) => s.accounts)
  return (
    <section>
      {accounts
        .filter((a) => !a.parentId || !accounts.some((p) => p.id === a.parentId))
        .map((a) => (
          <Fragment key={a.id}>
            <div className="row">
              <PersonAvatar mri={a.mri} name={a.label} size={36} accountId={a.id} />
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{a.label}</div>
                <div className="hint">
                  {a.upn} · <AccountStatusBadge account={a} />
                </div>
              </div>
              <AccountButtons account={a} />
            </div>
            {!a.parentId && <Tenants account={a} />}
          </Fragment>
        ))}
      <div className="row">
        <Button appearance="primary" onClick={() => void api.addAccount()}>
          Konto hinzufügen
        </Button>
      </div>
    </section>
  )
}

function AppearancePage(): JSX.Element | null {
  const settings = useStore((s) => s.settings)
  const set = useSet()
  if (!settings) return null
  return (
    <section>
      <div className="row">
        <div className="grow">Farbschema</div>
        <RadioGroup layout="horizontal" value={settings.theme} onChange={(_e, d) => set({ theme: d.value as AppSettings['theme'] })}>
          <Radio value="system" label="Wie System" />
          <Radio value="light" label="Hell" />
          <Radio value="dark" label="Dunkel" />
        </RadioGroup>
      </div>
      <div className="row">
        <div className="grow">Nachrichtenvorschau in der Chatliste</div>
        <Switch checked={!!settings.chatPreviews} onChange={(_e, d) => set({ chatPreviews: d.checked })} />
      </div>
    </section>
  )
}

function NotificationsPage(): JSX.Element | null {
  const settings = useStore((s) => s.settings)
  const set = useSet()
  if (!settings) return null
  return (
    <section>
      <div className="row">
        <div className="grow">Benachrichtigungen anzeigen</div>
        <Switch checked={settings.notifications} onChange={(_e, d) => set({ notifications: d.checked })} />
      </div>
      <div className="row">
        <div className="grow">Ton abspielen</div>
        <Switch checked={settings.notificationSound} onChange={(_e, d) => set({ notificationSound: d.checked })} />
      </div>
      <div className="row">
        <div className="grow">Nachrichtenvorschau anzeigen</div>
        <Switch checked={settings.showMessagePreview} onChange={(_e, d) => set({ showMessagePreview: d.checked })} />
      </div>
      <div className="row">
        <div className="grow hint">Ob macOS die Mitteilungen dieser App anzeigt, prüfst du unter Berechtigungen.</div>
        <Button size="small" onClick={() => useStore.getState().openSettings('permissions')}>
          Berechtigungen
        </Button>
      </div>
    </section>
  )
}

function DevicesPage(): JSX.Element | null {
  const settings = useStore((s) => s.settings)
  const set = useSet()
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])

  useEffect(() => {
    void navigator.mediaDevices.enumerateDevices().then(setDevices)
  }, [])

  const loadDevices = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).catch(() => navigator.mediaDevices.getUserMedia({ audio: true }))
      s.getTracks().forEach((t) => t.stop())
    } catch {
      /* ohne Freigabe nur IDs */
    }
    setDevices(await navigator.mediaDevices.enumerateDevices())
  }

  if (!settings) return null

  const byKind = (k: MediaDeviceKind) => devices.filter((d) => d.kind === k && d.deviceId !== 'default' && d.label)
  const deviceSelect = (label: string, kind: MediaDeviceKind, key: 'preferredCamera' | 'preferredMic' | 'preferredSpeaker') => (
    <div className="row">
      <div className="grow">{label}</div>
      <Dropdown
        style={{ minWidth: 280 }}
        value={settings[key] || 'Standard (wie in Teams)'}
        selectedOptions={[settings[key] ?? '']}
        onOptionSelect={(_e, d) => set({ [key]: d.optionValue || undefined })}
      >
        <Option value="">Standard (wie in Teams)</Option>
        {byKind(kind).map((d) => (
          <Option key={d.deviceId} value={d.label}>
            {d.label}
          </Option>
        ))}
      </Dropdown>
    </div>
  )

  return (
    <section>
      {deviceSelect('Kamera', 'videoinput', 'preferredCamera')}
      {deviceSelect('Mikrofon', 'audioinput', 'preferredMic')}
      {deviceSelect('Lautsprecher', 'audiooutput', 'preferredSpeaker')}
      <div className="row">
        <div className="grow hint">Fehlen Geräte in der Liste, lies sie neu ein. Ohne Freigabe für Mikrofon und Kamera kennt die App ihre Namen nicht.</div>
        <Button size="small" onClick={() => void loadDevices()}>
          Geräte erkennen
        </Button>
      </div>
    </section>
  )
}

function UpdatesPage(): JSX.Element | null {
  const update = useStore((s) => s.update)
  const inCall = useStore((s) => s.callState !== null)
  if (!update) return null
  return (
    <section>
      <div className="row">
        <div className="grow">
          <div>
            Version {update.currentVersion} · {update.channel === 'nightly' ? 'Nightly' : update.channel === 'dev' ? 'Dev' : 'Stable'}
          </div>
          <div className="hint">
            {updateStatusText(update)}
            {updateLastChecked(update) ? ` · ${updateLastChecked(update)}` : ''}
          </div>
        </div>
        {update.releaseUrl && (
          <Button size="small" appearance="transparent" onClick={() => void api.openExternal(update.releaseUrl!)}>
            Release-Notes
          </Button>
        )}
        {resolveUpdateAction(update) === 'download' && (
          <Button size="small" appearance="primary" onClick={() => void api.downloadUpdate()}>
            Herunterladen
          </Button>
        )}
        {resolveUpdateAction(update) === 'install' && (
          <Button size="small" appearance="primary" onClick={() => confirmInstall(update, inCall) && void api.installUpdate()}>
            Neu starten und installieren
          </Button>
        )}
        <Button
          size="small"
          disabled={['disabled', 'checking', 'downloading', 'downloaded', 'installing'].includes(update.status)}
          onClick={() => void api.checkForUpdates()}
        >
          Nach Updates suchen
        </Button>
      </div>
    </section>
  )
}

function PrivacyPage({ installId }: { installId?: string }): JSX.Element {
  return (
    <section>
      <div className="row">
        <div className="grow">
          Anonyme Nutzungsdaten und Fehlerberichte
          <div className="hint">
            Die App sendet, welche Funktionen genutzt werden und wo Fehler auftreten. Nachrichten, Namen, Mailadressen und Kontodaten gehen nie mit.{' '}
            <a
              href={USAGE_DATA_DOC}
              onClick={(e) => {
                e.preventDefault()
                void api.openExternal(USAGE_DATA_DOC)
              }}
            >
              Was genau gesendet wird
            </a>
          </div>
        </div>
      </div>
      {installId && (
        <div className="row">
          <div className="grow">
            Anonyme ID dieser Installation
            <div className="hint">Nenne sie bei einem Fehlerbericht, dann lassen sich die passenden Fehlermeldungen finden.</div>
          </div>
          <code className="selectable" style={{ fontSize: 12 }}>
            {installId}
          </code>
        </div>
      )}
    </section>
  )
}

function DiagnosticsPage(): JSX.Element {
  const accounts = useStore((s) => s.accounts)
  const [debug, setDebug] = useState<DebugInfo | null>(null)
  return (
    <section>
      {accounts.length === 0 && <div className="row hint">Noch kein Konto verbunden.</div>}
      {accounts.map((a) => (
        <div key={a.id} className="row" style={{ alignItems: 'flex-start' }}>
          <div className="grow">
            <div>{a.label}</div>
            {debug?.accountId === a.id && (
              <pre className="selectable" style={{ fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--fg-3)' }}>
                {JSON.stringify({ url: debug.url, endpoints: debug.endpoints, tokens: debug.tokens.map((t) => `${t.audience} bis ${t.expires ? new Date(t.expires).toLocaleTimeString('de-DE') : '?'}`) }, null, 2)}
              </pre>
            )}
          </div>
          <Button size="small" onClick={() => void api.getDebugInfo(a.id).then(setDebug)}>
            Verbindungsdetails
          </Button>
        </div>
      ))}
    </section>
  )
}

const FEEDBACK_KINDS: { value: FeedbackKind; label: string }[] = [
  { value: 'bug', label: 'Problem' },
  { value: 'idea', label: 'Idee' },
  { value: 'other', label: 'Sonstiges' }
]

const ISSUES_URL = 'https://github.com/TimSchulzRC/plenum/issues/new/choose'

// Problem melden oder Idee schicken, ohne GitHub-Konto. Geht als Ereignis an PostHog.
function FeedbackSection(): JSX.Element {
  const [kind, setKind] = useState<FeedbackKind>('bug')
  const [text, setText] = useState('')
  const [state, setState] = useState<{ sending?: boolean; sent?: boolean; error?: string }>({})

  const send = async () => {
    setState({ sending: true })
    try {
      await api.sendFeedback(kind, text)
      setText('')
      setState({ sent: true })
    } catch (e) {
      // Electron setzt „Error invoking remote method 'api': Error: “ vor die Meldung
      setState({ error: (e as Error).message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '') })
    }
  }

  return (
    <section>
      <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
        <RadioGroup layout="horizontal" value={kind} onChange={(_e, d) => setKind(d.value as FeedbackKind)}>
          {FEEDBACK_KINDS.map((k) => (
            <Radio key={k.value} value={k.value} label={k.label} />
          ))}
        </RadioGroup>
        <Textarea
          value={text}
          maxLength={FEEDBACK_MAX_LENGTH}
          resize="vertical"
          rows={4}
          placeholder={kind === 'bug' ? 'Was ist passiert, und was hast du erwartet?' : kind === 'idea' ? 'Was fehlt dir, oder was würde dir die Arbeit leichter machen?' : 'Was möchtest du loswerden?'}
          onChange={(_e, d) => {
            setText(d.value)
            if (state.sent || state.error) setState({})
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="hint grow">
            {state.sent
              ? 'Danke, dein Feedback ist angekommen.'
              : state.error
                ? `Senden fehlgeschlagen: ${state.error}`
                : 'Mit dem Text gehen App-Version und macOS-Version mit. Schreib bitte keine vertraulichen Inhalte hinein.'}{' '}
            {!state.sent && (
              <a
                href={ISSUES_URL}
                onClick={(e) => {
                  e.preventDefault()
                  void api.openExternal(ISSUES_URL)
                }}
              >
                Lieber als GitHub-Issue
              </a>
            )}
          </div>
          <Button appearance="primary" disabled={!text.trim() || state.sending} onClick={() => void send()}>
            {state.sending ? 'Wird gesendet …' : 'Senden'}
          </Button>
        </div>
      </div>
    </section>
  )
}

function AccountStatusBadge({ account: a }: { account: AccountInfo }): JSX.Element {
  return (
    <>
      <Badge appearance="tint" color={a.status === 'ready' ? 'success' : a.status === 'error' ? 'danger' : 'warning'} size="small">
        {statusText(a.status)}
      </Badge>
      {a.statusDetail ? ` ${a.statusDetail}` : ''}
    </>
  )
}

function AccountButtons({ account: a }: { account: AccountInfo }): JSX.Element {
  return (
    <>
      {a.status === 'login-required' && (
        <Button size="small" appearance="primary" onClick={() => void api.showLogin(a.id)}>
          Anmelden
        </Button>
      )}
      <Button size="small" onClick={() => void api.reloadAccount(a.id)}>
        Neu verbinden
      </Button>
      <Button size="small" onClick={() => void api.showEngine(a.id)}>
        Webansicht
      </Button>
      {!a.parentId && (
        <Button
          size="small"
          onClick={() => {
            if (confirm(`${a.label} abmelden und entfernen?`)) void api.removeAccount(a.id)
          }}
        >
          Entfernen
        </Button>
      )}
    </>
  )
}

// Gastmandanten eines Kontos. Eingeschaltete laufen als eigener Block in der Chatliste,
// jeder mit einer eigenen, versteckten Teams-Web-App (Arbeitsspeicher wie ein Browser-Tab).
function Tenants({ account }: { account: AccountInfo }): JSX.Element | null {
  const accounts = useStore((s) => s.accounts)
  const [tenants, setTenants] = useState<TenantInfo[] | null>(null)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const ready = account.status === 'ready'

  useEffect(() => {
    if (!ready) return
    let alive = true
    void api
      .listTenants(account.id)
      .then((t) => {
        if (!alive) return
        setTenants(t)
        setError(undefined)
      })
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [account.id, ready])

  const children = accounts.filter((c) => c.parentId === account.id)
  // Eingeschaltete Mandanten bleiben sichtbar, auch wenn die Liste gerade nicht ladbar ist
  const rows: TenantInfo[] = [
    ...(tenants ?? []).filter((t) => !t.current),
    ...children.filter((c) => !tenants?.some((t) => t.tenantId === c.tenantId)).map((c) => ({ tenantId: c.tenantId ?? c.id, tenantName: c.tenantName, guest: true, current: false, hidden: false }))
  ]
  if (rows.length === 0 && !error) return null
  return (
    <div className="tenant-list">
      <div className="hint" style={{ marginBottom: 4 }}>
        {error ? `Mandanten konnten nicht geladen werden (${error}).` : 'Weitere Mandanten, in denen du Gast bist. Eingeschaltete erscheinen als eigener Block in der Chatliste.'}
      </div>
      {rows.map((t) => {
        const child = children.find((c) => c.tenantId === t.tenantId)
        const name = t.tenantName || t.tenantId
        return (
          <div className="row" key={t.tenantId}>
            <Avatar shape="square" size={24} name={name} color="colorful" />
            <div className="grow">
              <div>{name}</div>
              <div className="hint">
                {[t.guest ? 'Gast' : 'Mitglied', t.hidden && 'in Teams ausgeblendet'].filter(Boolean).join(' · ')}
                {child && (
                  <>
                    {' · '}
                    <AccountStatusBadge account={child} />
                  </>
                )}
              </div>
            </div>
            {child && <AccountButtons account={child} />}
            <Switch
              label="In der Chatliste"
              labelPosition="before"
              checked={!!child}
              disabled={busy === t.tenantId}
              onChange={(_e, d) => {
                setBusy(t.tenantId)
                const done = () => setBusy(undefined)
                if (d.checked) void api.addTenant(account.id, t.tenantId, t.tenantName).catch((e: Error) => alert(e.message)).finally(done)
                else if (child) void Promise.resolve(api.removeAccount(child.id)).finally(done)
                else done()
              }}
            />
          </div>
        )
      })}
    </div>
  )
}
