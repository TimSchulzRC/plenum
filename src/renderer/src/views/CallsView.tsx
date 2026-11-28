import { Input, Spinner, Tooltip } from '@fluentui/react-components'
import { Call20Regular, Video20Regular, CallInbound16Regular, CallOutbound16Regular, CallMissed16Regular, Search20Regular } from '@fluentui/react-icons'
import { useEffect, useMemo, useState } from 'react'
import { mergeByTime, type FromAccount } from '@shared/accounts'
import type { CallLogEntry, Person } from '@shared/types'
import { api } from '../api'
import { AccountGroups, AccountTag, GroupToggle, NotLoaded, useAccounts, useGrouped } from '../components/AccountGroups'
import { PersonAvatar } from '../components/Avatars'
import { ipcErrorText } from '../lib/calendar'
import { duration, listTime, clock } from '../lib/format'

type Loaded = { items?: CallLogEntry[]; error?: string }
type Entry = FromAccount<CallLogEntry>

const call = (accountId: string, mri: string, video: boolean) => void api.startCall(accountId, { mris: [mri] }, video)

// Anrufverlauf aller Konten und Gastmandanten, neueste zuerst. Zurückrufen geht über das Konto des
// Eintrags. Die Personensuche fragt alle verbundenen Konten, jeder Treffer ruft über sein Konto an.
export function CallsView(): JSX.Element {
  const { accounts, multi, color, byId } = useAccounts()
  const grouped = useGrouped('groupCallsByAccount')
  const [lists, setLists] = useState<Record<string, Loaded>>({})
  const [q, setQ] = useState('')
  const [people, setPeople] = useState<FromAccount<Person>[]>([])
  const readyKey = accounts
    .filter((a) => a.status === 'ready')
    .map((a) => a.id)
    .join(',')

  useEffect(() => {
    let alive = true
    for (const id of readyKey.split(',').filter(Boolean)) {
      api
        .getCallHistory(id)
        .then((items) => alive && setLists((l) => ({ ...l, [id]: { items } })))
        .catch((e: unknown) => alive && setLists((l) => ({ ...l, [id]: { ...l[id], error: ipcErrorText(e) } })))
    }
    return () => {
      alive = false
    }
  }, [readyKey])

  useEffect(() => {
    const ids = readyKey.split(',').filter(Boolean)
    if (q.trim().length < 2 || !ids.length) return setPeople([])
    let alive = true
    const t = setTimeout(
      () =>
        void Promise.all(
          ids.map((id) =>
            api
              .searchPeople(id, q)
              .then((r) => r.map((item) => ({ accountId: id, item })))
              .catch(() => [] as FromAccount<Person>[])
          )
        ).then((r) => alive && setPeople(r.flat())),
      220
    )
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [q, readyKey])

  const entries = useMemo(() => mergeByTime(accounts.map((a) => ({ accountId: a.id, items: lists[a.id]?.items ?? [] }))), [accounts, lists])
  const tagFor = (accountId: string) => <AccountTag account={byId(accountId)} color={color(accountId)} />
  const loading = !!readyKey && !accounts.some((a) => lists[a.id]?.items || lists[a.id]?.error)
  const missing = accounts.filter((a) => !lists[a.id]?.items && (a.status !== 'ready' || lists[a.id]?.error))

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
          {people.map(({ accountId, item: p }) => (
            <div key={`${accountId}|${p.mri}`} className="person-row">
              <PersonAvatar mri={p.mri} name={p.displayName} size={32} accountId={accountId} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="p-name">{p.displayName}</div>
                <div className="p-sub">
                  {multi && tagFor(accountId)}
                  {multi && p.jobTitle && <span className="a-sep">·</span>}
                  {p.jobTitle}
                </div>
              </div>
              <Tooltip content="Videoanruf" relationship="label">
                <button className="icon-btn" onClick={() => call(accountId, p.mri, true)}>
                  <Video20Regular />
                </button>
              </Tooltip>
              <Tooltip content="Audioanruf" relationship="label">
                <button className="icon-btn" onClick={() => call(accountId, p.mri, false)}>
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
          <GroupToggle setting="groupCallsByAccount" />
        </div>
        <div className={`calls-scroll ${grouped ? 'multi' : ''}`}>
          {grouped ? (
            <AccountGroups accounts={accounts} storageKey="calls.closed">
              {(a) => {
                const l = lists[a.id]
                const items = entries.filter((e) => e.accountId === a.id)
                if (items.length) return items.map((e) => <CallRow key={`${e.accountId}|${e.item.id}`} entry={e} />)
                if (l?.error) return <div className="group-note">Anrufverlauf nicht verfügbar: {l.error}</div>
                if (a.status !== 'ready') return null
                if (!l) return <div className="group-note">Wird geladen …</div>
                return <div className="group-note">Noch keine Anrufe.</div>
              }}
            </AccountGroups>
          ) : (
            <>
              {missing.length > 0 && !loading && <NotLoaded accounts={missing} lists={lists} what="Anrufverlauf nicht verfügbar" />}
              {loading && (
                <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}>
                  <Spinner size="small" />
                </div>
              )}
              {!loading && entries.length === 0 && missing.length < accounts.length && <div className="empty-state">Noch keine Anrufe.</div>}
              {entries.map((e) => (
                <CallRow key={`${e.accountId}|${e.item.id}`} entry={e} tag={multi ? tagFor(e.accountId) : undefined} />
              ))}
            </>
          )}
        </div>
      </div>
    </>
  )
}

function CallRow({ entry, tag }: { entry: Entry; tag?: JSX.Element }): JSX.Element {
  const { accountId, item: h } = entry
  const missed = h.state === 'missed' || h.state === 'declined'
  return (
    <div className="person-row" style={{ padding: '8px 12px' }}>
      <PersonAvatar mri={h.peerMri} name={h.peerName || 'Unbekannt'} size={32} accountId={accountId} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="p-name" style={{ color: missed ? 'var(--danger-fg)' : undefined }}>
          {h.peerName || 'Unbekannt'}
        </div>
        <div className="p-sub" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {missed ? <CallMissed16Regular /> : h.direction === 'incoming' ? <CallInbound16Regular /> : <CallOutbound16Regular />}
          {missed ? 'Verpasst' : h.direction === 'incoming' ? 'Eingehend' : 'Ausgehend'}
          {h.durationSec ? ` · ${duration(h.durationSec)}` : ''}
        </div>
      </div>
      {tag && <span className="call-acct">{tag}</span>}
      <span style={{ fontSize: 12, color: 'var(--fg-3)', width: 90, textAlign: 'right' }}>
        {listTime(h.time)} {listTime(h.time).includes(':') ? '' : clock(h.time)}
      </span>
      {h.peerMri && (
        <>
          <button className="icon-btn" title="Videoanruf" onClick={() => call(accountId, h.peerMri!, true)}>
            <Video20Regular />
          </button>
          <button className="icon-btn" title="Audioanruf" onClick={() => call(accountId, h.peerMri!, false)}>
            <Call20Regular />
          </button>
        </>
      )}
    </div>
  )
}
