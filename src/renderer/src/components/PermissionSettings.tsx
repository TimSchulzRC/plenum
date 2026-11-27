import { Badge, Button } from '@fluentui/react-components'
import { Alert20Regular, Mic20Regular, ShareScreenStart20Regular, Video20Regular } from '@fluentui/react-icons'
import { useEffect, useState, type ComponentType } from 'react'
import type { MediaPermission, PermissionState, PermissionsInfo } from '@shared/types'
import { api } from '../api'

const MEDIA: { kind: MediaPermission; label: string; use: string; icon: ComponentType }[] = [
  { kind: 'microphone', label: 'Mikrofon', use: 'Für Anrufe und Besprechungen.', icon: Mic20Regular },
  { kind: 'camera', label: 'Kamera', use: 'Für Video in Anrufen und Besprechungen.', icon: Video20Regular },
  { kind: 'screen', label: 'Bildschirmaufnahme', use: 'Zum Teilen von Bildschirm oder Fenster.', icon: ShareScreenStart20Regular }
]

// Fehlt eine Freigabe, die macOS kennt? Dann markiert die Seitenleiste den Bereich.
export function permissionMissing(p: PermissionsInfo | null): boolean {
  return !!p && Object.values(p).some((s) => s !== 'granted' && s !== 'unsupported')
}

// Zustand lesen, solange das Einstellungsfenster offen ist (open), und laufend neu, solange
// der Bereich Berechtigungen offen ist (active): Die Rückfrage von macOS und die
// Systemeinstellungen laufen außerhalb der App und melden sich nicht zurück.
export function usePermissions(open: boolean, active: boolean): [PermissionsInfo | null, (p: PermissionsInfo) => void] {
  const [perms, setPerms] = useState<PermissionsInfo | null>(null)
  useEffect(() => {
    if (!open) return
    let alive = true
    const load = () => void api.getPermissions().then((p) => alive && setPerms(p))
    load()
    window.addEventListener('focus', load)
    const timer = active ? setInterval(load, 2000) : undefined
    return () => {
      alive = false
      window.removeEventListener('focus', load)
      clearInterval(timer)
    }
  }, [open, active])
  return [perms, setPerms]
}

function stateBadge(kind: MediaPermission, state: PermissionState): JSX.Element {
  if (state === 'granted')
    return (
      <Badge appearance="tint" color="success" size="small">
        Erlaubt
      </Badge>
    )
  if (state === 'not-determined')
    return (
      <Badge appearance="tint" color="warning" size="small">
        Noch nicht gefragt
      </Badge>
    )
  if (state === 'unsupported')
    return (
      <Badge appearance="tint" color="informative" size="small">
        Keine Freigabe nötig
      </Badge>
    )
  return (
    <Badge appearance="tint" color="danger" size="small">
      {state === 'restricted' ? 'Gesperrt' : kind === 'screen' ? 'Nicht erlaubt' : 'Abgelehnt'}
    </Badge>
  )
}

function stateHint(kind: MediaPermission, state: PermissionState, asked: boolean): string | undefined {
  if (state === 'restricted') return 'Eine Geräteverwaltung oder die Bildschirmzeit sperrt den Zugriff. Nur deren Verwaltung kann ihn freigeben.'
  if (kind === 'screen' && state === 'denied') {
    // macOS meldet hier „nicht erlaubt“, auch wenn es noch nie gefragt hat
    return asked
      ? 'Kam keine Rückfrage, hat macOS schon einmal gefragt. Schalte Plenum in den Systemeinstellungen unter Bildschirmaufnahme ein. macOS bietet danach an, die App neu zu starten, erst dann greift die Freigabe.'
      : '„Anfragen“ trägt Plenum in die Systemeinstellungen ein und fragt beim ersten Mal nach.'
  }
  if (state === 'denied') return 'macOS fragt nicht noch einmal. Schalte Plenum in den Systemeinstellungen ein.'
}

export function PermissionSettings({ perms, onChange }: { perms: PermissionsInfo | null; onChange: (p: PermissionsInfo) => void }): JSX.Element {
  const [busy, setBusy] = useState<MediaPermission>()
  const [asked, setAsked] = useState<Partial<Record<MediaPermission, boolean>>>({})
  // Ergebnis der letzten Testmitteilung bzw. Fehler, den macOS beim Anzeigen gemeldet hat
  const [notifyState, setNotifyState] = useState<{ testing?: boolean; ok?: boolean; error?: string }>({})

  useEffect(() => {
    void api.getNotificationStatus().then((s) => s.error && setNotifyState({ ok: false, error: s.error }))
  }, [])

  const request = async (kind: MediaPermission) => {
    setBusy(kind)
    try {
      onChange(await api.requestPermission(kind))
      setAsked((a) => ({ ...a, [kind]: true }))
    } finally {
      setBusy(undefined)
    }
  }

  const testNotification = async () => {
    setNotifyState({ testing: true })
    const r = await api.testNotification().catch((e: Error) => ({ ok: false, error: e.message }))
    setNotifyState(r)
  }

  return (
    <>
      <section>
        <h2>Anrufe</h2>
        {MEDIA.map(({ kind, label, use, icon: Icon }) => {
          const state = perms?.[kind]
          const hint = state && stateHint(kind, state, !!asked[kind])
          // Mikrofon und Kamera: macOS fragt nur, solange noch nichts entschieden ist.
          // Bildschirmaufnahme: Anfragen geht immer, macOS fragt aber nur beim ersten Mal.
          const canAsk = state === 'not-determined' || (kind === 'screen' && state === 'denied')
          const toSettings = state === 'denied' || state === 'restricted'
          return (
            <div className="row permission" key={kind}>
              <span className="permission-icon">
                <Icon />
              </span>
              <div className="grow">
                <div className="permission-title">
                  {label} {state && stateBadge(kind, state)}
                </div>
                <div className="hint">{hint ?? use}</div>
              </div>
              {canAsk && (
                <Button size="small" appearance="primary" disabled={busy === kind} onClick={() => void request(kind)}>
                  {busy === kind ? 'Wird angefragt …' : kind === 'screen' ? 'Anfragen' : 'Erlauben'}
                </Button>
              )}
              {toSettings && (
                <Button size="small" appearance={canAsk ? 'secondary' : 'primary'} onClick={() => void api.openPermissionSettings(kind)}>
                  Systemeinstellungen
                </Button>
              )}
            </div>
          )
        })}
      </section>

      <section>
        <h2>Mitteilungen</h2>
        <div className="row permission">
          <span className="permission-icon">
            <Alert20Regular />
          </span>
          <div className="grow">
            <div className="permission-title">
              Mitteilungen von macOS{' '}
              {notifyState.ok === false && !notifyState.testing && (
                <Badge appearance="tint" color="danger" size="small">
                  Abgelehnt
                </Badge>
              )}
            </div>
            <div className="hint">
              {notifyState.testing
                ? 'Testmitteilung wird gesendet …'
                : notifyState.ok === false
                  ? `macOS zeigt keine Mitteilungen dieser App an${notifyState.error ? ` (${notifyState.error})` : ''}. Erlaube sie in den Systemeinstellungen unter Mitteilungen.`
                  : notifyState.ok
                    ? 'Testmitteilung gesendet. Kam kein Banner, sind Mitteilungen für diese App in den Systemeinstellungen aus oder ein Fokus ist aktiv.'
                    : 'macOS meldet nicht, ob Mitteilungen erlaubt sind. „Testen“ fragt beim ersten Mal nach und zeigt ein Banner.'}
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
    </>
  )
}
