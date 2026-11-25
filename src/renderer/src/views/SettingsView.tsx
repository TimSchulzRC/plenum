import { Button, Dropdown, Option, Radio, RadioGroup, Switch, Badge, Textarea } from '@fluentui/react-components'
import { useEffect, useState } from 'react'
import { FEEDBACK_MAX_LENGTH, type FeedbackKind } from '@shared/analytics'
import type { AppSettings, DebugInfo } from '@shared/types'
import { api } from '../api'
import { USAGE_DATA_DOC } from '../analytics'
import { PersonAvatar } from '../components/Avatars'
import { McpSettings } from '../components/McpSettings'
import { statusText } from '../components/TitleBar'
import { confirmInstall, resolveUpdateAction, updateLastChecked, updateStatusText } from '../update'
import { useStore } from '../store'

export function SettingsView(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const accounts = useStore((s) => s.accounts)
  const update = useStore((s) => s.update)
  const inCall = useStore((s) => s.callState !== null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [debug, setDebug] = useState<DebugInfo | null>(null)
  // Ergebnis der letzten Testmitteilung bzw. Fehler, den macOS beim Anzeigen gemeldet hat
  const [notifyState, setNotifyState] = useState<{ testing?: boolean; ok?: boolean; error?: string }>({})
  const [analyticsInfo, setAnalyticsInfo] = useState<{ available: boolean; installId?: string } | null>(null)

  const set = (patch: Partial<AppSettings>) => void api.setSettings(patch)

  const loadDevices = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).catch(() => navigator.mediaDevices.getUserMedia({ audio: true }))
      s.getTracks().forEach((t) => t.stop())
    } catch {
      /* ohne Freigabe nur IDs */
    }
    setDevices(await navigator.mediaDevices.enumerateDevices())
  }

  useEffect(() => {
    void navigator.mediaDevices.enumerateDevices().then(setDevices)
    void api.getNotificationStatus().then((s) => s.error && setNotifyState({ ok: false, error: s.error }))
    void api.getAnalyticsInfo().then(setAnalyticsInfo)
  }, [])

  const testNotification = async () => {
    setNotifyState({ testing: true })
    const r = await api.testNotification().catch((e: Error) => ({ ok: false, error: e.message }))
    setNotifyState(r)
  }

  if (!settings) return <div className="settings" />

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
    <div className="settings">
      <h1>Einstellungen</h1>
      <section>
        <h2>Konten</h2>
        {accounts.map((a) => (
          <div className="row" key={a.id}>
            <PersonAvatar mri={a.mri} name={a.label} size={36} accountId={a.id} />
            <div className="grow">
              <div style={{ fontWeight: 600 }}>{a.label}</div>
              <div className="hint">
                {a.upn} · <Badge appearance="tint" color={a.status === 'ready' ? 'success' : a.status === 'error' ? 'danger' : 'warning'} size="small">{statusText(a.status)}</Badge>
                {a.statusDetail ? ` ${a.statusDetail}` : ''}
              </div>
            </div>
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
            <Button
              size="small"
              onClick={() => {
                if (confirm(`${a.label} abmelden und entfernen?`)) void api.removeAccount(a.id)
              }}
            >
              Entfernen
            </Button>
          </div>
        ))}
        <div className="row">
          <Button appearance="primary" onClick={() => void api.addAccount()}>
            Konto hinzufügen
          </Button>
          <div className="hint">Jedes Konto läuft in einer eigenen, getrennten Sitzung der Teams-Web-App.</div>
        </div>
      </section>

      <section>
        <h2>Darstellung</h2>
        <RadioGroup layout="horizontal" value={settings.theme} onChange={(_e, d) => set({ theme: d.value as AppSettings['theme'] })}>
          <Radio value="system" label="Wie System" />
          <Radio value="light" label="Hell" />
          <Radio value="dark" label="Dunkel" />
        </RadioGroup>
        <div className="row">
          <div className="grow">Nachrichtenvorschau in der Chatliste</div>
          <Switch checked={!!settings.chatPreviews} onChange={(_e, d) => set({ chatPreviews: d.checked })} />
        </div>
      </section>

      <section>
        <h2>Benachrichtigungen</h2>
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
          <div className="grow">
            Mitteilungen von macOS
            <div className="hint">
              {notifyState.testing
                ? 'Testmitteilung wird gesendet …'
                : notifyState.ok === false
                  ? `macOS zeigt keine Mitteilungen dieser App an${notifyState.error ? ` (${notifyState.error})` : ''}. Erlaube sie in den Systemeinstellungen unter Mitteilungen.`
                  : notifyState.ok
                    ? 'Testmitteilung gesendet. Kam kein Banner, sind Mitteilungen für diese App in den Systemeinstellungen aus oder ein Fokus ist aktiv.'
                    : 'Banner, Ton und Mitteilungszentrale stellst du in den Systemeinstellungen ein.'}
            </div>
          </div>
          <Button size="small" disabled={notifyState.testing} onClick={() => void testNotification()}>
            Testen
          </Button>
          <Button size="small" appearance={notifyState.ok === false ? 'primary' : 'secondary'} onClick={() => void api.openNotificationSettings()}>
            Systemeinstellungen
          </Button>
        </div>
      </section>

      <section>
        <h2>Geräte</h2>
        <div className="hint" style={{ marginBottom: 6 }}>
          Diese Auswahl gilt für Anrufe und Besprechungen. „Standard“ übernimmt die Einstellung aus Teams.{' '}
          <Button size="small" appearance="transparent" onClick={() => void loadDevices()}>
            Geräte erkennen
          </Button>
        </div>
        {deviceSelect('Kamera', 'videoinput', 'preferredCamera')}
        {deviceSelect('Mikrofon', 'audioinput', 'preferredMic')}
        {deviceSelect('Lautsprecher', 'audiooutput', 'preferredSpeaker')}
      </section>

      {update && (
        <section>
          <h2>Updates</h2>
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
      )}

      <McpSettings />

      {analyticsInfo?.available && (
        <section>
          <h2>Datenschutz</h2>
          <div className="row">
            <div className="grow">
              Anonyme Nutzungsdaten und Fehlerberichte senden
              <div className="hint">
                Zeigt, welche Funktionen genutzt werden und wo Fehler auftreten. Nachrichten, Namen, Mailadressen und Kontodaten gehen nie mit.{' '}
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
            <Switch checked={settings.usageData === true} onChange={(_e, d) => void api.setUsageData(d.checked, 'settings')} />
          </div>
          {settings.usageData === true && analyticsInfo.installId && (
            <div className="row">
              <div className="grow">
                Anonyme ID dieser Installation
                <div className="hint">Nenne sie bei einem Fehlerbericht, dann lassen sich die passenden Fehlermeldungen finden.</div>
              </div>
              <code className="selectable" style={{ fontSize: 12 }}>
                {analyticsInfo.installId}
              </code>
            </div>
          )}
        </section>
      )}

      {analyticsInfo?.available && <FeedbackSection />}

      <section>
        <h2>Diagnose</h2>
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
    </div>
  )
}

const FEEDBACK_KINDS: { value: FeedbackKind; label: string }[] = [
  { value: 'bug', label: 'Problem' },
  { value: 'idea', label: 'Idee' },
  { value: 'other', label: 'Sonstiges' }
]

const ISSUES_URL = 'https://github.com/TimSchulzRC/teams-everywhere/issues/new/choose'

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
      <h2>Feedback</h2>
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
