import { Input, Spinner, Tooltip } from '@fluentui/react-components'
import { Call20Regular, Video20Regular, CallInbound16Regular, CallOutbound16Regular, CallMissed16Regular, Search20Regular } from '@fluentui/react-icons'
import { useEffect, useState } from 'react'
import type { CallLogEntry, Person } from '@shared/types'
import { api } from '../api'
import { PersonAvatar } from '../components/Avatars'
import { duration, listTime, clock } from '../lib/format'
import { useActive } from '../store'

export function CallsView(): JSX.Element {
  const { account } = useActive()
  const [history, setHistory] = useState<CallLogEntry[] | null>(null)
  const [error, setError] = useState<string>()
  const [q, setQ] = useState('')
  const [people, setPeople] = useState<Person[]>([])

  useEffect(() => {
    if (!account) return
    setHistory(null)
    api
      .getCallHistory(account.id)
      .then(setHistory)
      .catch((e: Error) => setError(e.message))
  }, [account?.id])

  useEffect(() => {
    if (!account || q.trim().length < 2) return setPeople([])
    const t = setTimeout(() => void api.searchPeople(account.id, q).then(setPeople), 220)
    return () => clearTimeout(t)
  }, [q, account])

  const call = (mri: string, video: boolean) => account && void api.startCall(account.id, { mris: [mri] }, video)

  return (
    <>
      <div className="list-pane">
        <div className="list-header">
          <h1>Anrufe</h1>
        </div>
        <div style={{ padding: '0 16px 8px' }}>
          <Input contentBefore={<Search20Regular />} placeholder="Name eingeben" value={q} onChange={(_e, d) => setQ(d.value)} style={{ width: '100%' }} />
        </div>
        <div className="list-scroll">
          {people.map((p) => (
            <div key={p.mri} className="person-row">
              <PersonAvatar mri={p.mri} name={p.displayName} size={32} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="p-name">{p.displayName}</div>
                <div className="p-sub">{p.jobTitle}</div>
              </div>
              <Tooltip content="Videoanruf" relationship="label">
                <button className="icon-btn" onClick={() => call(p.mri, true)}>
                  <Video20Regular />
                </button>
              </Tooltip>
              <Tooltip content="Audioanruf" relationship="label">
                <button className="icon-btn" onClick={() => call(p.mri, false)}>
                  <Call20Regular />
                </button>
              </Tooltip>
            </div>
          ))}
          {q.trim().length < 2 && <div style={{ padding: '8px 12px', color: 'var(--fg-3)', fontSize: 13 }}>Suche eine Person, um sie anzurufen.</div>}
        </div>
      </div>
      <div className="main-pane">
        <div className="pane-header">
          <div className="title grow">Verlauf</div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 16px' }}>
          {!history && !error && (
            <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}>
              <Spinner size="small" />
            </div>
          )}
          {error && <div className="empty-state">Anrufverlauf nicht verfügbar: {error}</div>}
          {history?.length === 0 && <div className="empty-state">Noch keine Anrufe.</div>}
          {history?.map((h) => {
            const missed = h.state === 'missed' || h.state === 'declined'
            return (
              <div key={h.id} className="person-row" style={{ padding: '8px 12px' }}>
                <PersonAvatar mri={h.peerMri} name={h.peerName || 'Unbekannt'} size={32} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="p-name" style={{ color: missed ? 'var(--danger)' : undefined }}>{h.peerName || 'Unbekannt'}</div>
                  <div className="p-sub" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {missed ? <CallMissed16Regular /> : h.direction === 'incoming' ? <CallInbound16Regular /> : <CallOutbound16Regular />}
                    {missed ? 'Verpasst' : h.direction === 'incoming' ? 'Eingehend' : 'Ausgehend'}
                    {h.durationSec ? ` · ${duration(h.durationSec)}` : ''}
                  </div>
                </div>
                <span style={{ fontSize: 12, color: 'var(--fg-3)', width: 90, textAlign: 'right' }}>
                  {listTime(h.time)} {listTime(h.time).includes(':') ? '' : clock(h.time)}
                </span>
                {h.peerMri && (
                  <>
                    <button className="icon-btn" title="Videoanruf" onClick={() => call(h.peerMri!, true)}>
                      <Video20Regular />
                    </button>
                    <button className="icon-btn" title="Audioanruf" onClick={() => call(h.peerMri!, false)}>
                      <Call20Regular />
                    </button>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}
