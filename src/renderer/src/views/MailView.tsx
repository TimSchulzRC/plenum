import { Button, Spinner, Tooltip } from '@fluentui/react-components'
import {
  Archive20Regular,
  ArrowForward20Regular,
  ArrowReply20Regular,
  ArrowReplyAll20Regular,
  Attach16Regular,
  ChevronDown16Regular,
  ChevronRight16Regular,
  Delete20Regular,
  Document20Regular,
  Drafts20Regular,
  Folder20Regular,
  Image20Regular,
  Mail20Regular,
  MailInbox20Regular,
  MailUnread20Regular,
  Compose20Regular,
  Send20Regular,
  Warning20Regular,
  ArrowDownload16Regular,
  Important16Filled,
  Flag16Filled,
  MailInboxAll20Regular,
  ArrowSync20Regular,
  ShieldError20Regular
} from '@fluentui/react-icons'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { AccountInfo, MailFolder, MailFolderKind, MailMessage, MailReplyKind, MailSummary } from '@shared/types'
import { api } from '../api'
import { fmt, listTime } from '../lib/format'
import { accountColor, calendarAccountName, ipcErrorText } from '../lib/calendar'
import { addressLabel, fileSize, mergeMail } from '../lib/mail'
import { mailDocument } from '../lib/mail-html'
import { setMailUnread } from '../lib/mail-unread'
import { useStore } from '../store'
import { MailCompose, type ComposeState } from '../components/MailCompose'

type Sel = { kind: 'all' } | { kind: 'folder'; accountId: string; folderId: string; name: string; folderKind?: MailFolderKind }
type Source = { accountId: string; folderId: string; items: MailSummary[]; next?: string; error?: string }
type Open = { accountId: string; id: string }

const ICONS: Record<MailFolderKind, JSX.Element> = {
  inbox: <MailInbox20Regular />,
  drafts: <Drafts20Regular />,
  sentitems: <Send20Regular />,
  archive: <Archive20Regular />,
  deleteditems: <Delete20Regular />,
  junkemail: <ShieldError20Regular />
}

const key = (m: { accountId: string; id: string }) => `${m.accountId}|${m.id}`

// E-Mail aller Konten. Links Ordner je Konto (bei mehreren Konten oben „Alle Posteingänge“),
// in der Mitte die Liste, rechts Lesebereich oder Verfassen.
export function MailView(): JSX.Element {
  const all = useStore((s) => s.accounts)
  // Gastmandanten haben im fremden Mandanten kein Postfach
  const accounts = useMemo(() => all.filter((a) => !a.parentId), [all])
  const ids = useMemo(() => accounts.map((a) => a.id), [accounts])
  const multi = accounts.length > 1
  const activeAccountId = useStore((s) => s.accounts.find((a) => a.id === s.activeAccountId)?.parentId ?? s.activeAccountId)
  const color = useCallback((id: string) => accountColor(ids, id), [ids])
  const byId = useCallback((id: string) => accounts.find((a) => a.id === id), [accounts])
  const readyKey = accounts.filter((a) => a.status === 'ready').map((a) => a.id).join(',')

  const [folders, setFolders] = useState<Record<string, { list?: MailFolder[]; error?: string }>>({})
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [sel, setSel] = useState<Sel>(() =>
    accounts.length > 1 ? { kind: 'all' } : { kind: 'folder', accountId: accounts[0]?.id ?? '', folderId: 'inbox', name: 'Posteingang', folderKind: 'inbox' }
  )
  const [sources, setSources] = useState<Source[] | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [open, setOpen] = useState<Open | null>(null)
  const [compose, setCompose] = useState<ComposeState | null>(null)

  // Ordner aller Konten, beim Öffnen und alle zwei Minuten
  const loadFolders = useCallback(() => {
    for (const id of readyKey.split(',').filter(Boolean)) {
      api
        .getMailFolders(id)
        .then((list) => {
          setFolders((f) => ({ ...f, [id]: { list } }))
          const inbox = list.find((x) => x.kind === 'inbox')
          if (inbox) setMailUnread(id, inbox.unread)
        })
        .catch((e) => setFolders((f) => ({ ...f, [id]: { ...f[id], error: ipcErrorText(e) } })))
    }
  }, [readyKey])

  useEffect(() => {
    loadFolders()
    const t = setInterval(loadFolders, 120_000)
    return () => clearInterval(t)
  }, [loadFolders])

  const wanted = useMemo<{ accountId: string; folderId: string }[]>(() => {
    if (sel.kind === 'all') return readyKey.split(',').filter(Boolean).map((accountId) => ({ accountId, folderId: 'inbox' }))
    return [{ accountId: sel.accountId, folderId: sel.folderId }]
  }, [sel, readyKey])
  const wantedKey = wanted.map((w) => `${w.accountId}:${w.folderId}`).join(',')

  // Liste laden. Alle 60 Sekunden die erste Seite neu, schon nachgeladene ältere Mails bleiben.
  useEffect(() => {
    let alive = true
    setSources(null)
    const load = (refresh: boolean) =>
      Promise.all(
        wanted.map((w) =>
          api
            .listMail(w.accountId, w.folderId)
            .then((p): Source => ({ ...w, items: p.items, next: p.next }))
            .catch((e): Source => ({ ...w, items: [], error: ipcErrorText(e) }))
        )
      ).then((fresh) => {
        if (!alive) return
        setSources((prev) => {
          if (!refresh || !prev) return fresh
          return fresh.map((f) => {
            const old = prev.find((p) => p.accountId === f.accountId && p.folderId === f.folderId)
            if (!old || f.error) return old ?? f
            const oldest = Math.min(...f.items.map((i) => i.received))
            const rest = old.items.filter((i) => i.received < oldest && !f.items.some((x) => x.id === i.id))
            return { ...f, items: [...f.items, ...rest], next: rest.length ? old.next : f.next }
          })
        })
      })
    void load(false)
    const t = setInterval(() => void load(true), 60_000)
    return () => {
      alive = false
      clearInterval(t)
    }
    // wantedKey fasst wanted zusammen, wanted selbst ändert sich bei jedem Render
  }, [wantedKey])

  const items = useMemo(() => mergeMail((sources ?? []).map((s) => s.items)), [sources])
  const errors = (sources ?? []).filter((s) => s.error)
  const hasMore = (sources ?? []).some((s) => s.next)

  const loadMore = async () => {
    if (!sources || loadingMore) return
    setLoadingMore(true)
    const next = await Promise.all(
      sources.map(async (s) => {
        if (!s.next) return s
        try {
          const p = await api.listMail(s.accountId, s.folderId, s.next)
          return { ...s, items: [...s.items, ...p.items.filter((i) => !s.items.some((x) => x.id === i.id))], next: p.next }
        } catch (e) {
          return { ...s, error: ipcErrorText(e) }
        }
      })
    )
    setSources(next)
    setLoadingMore(false)
  }

  const patchItem = (m: Open, patch: Partial<MailSummary>) =>
    setSources((prev) => prev && prev.map((s) => (s.accountId !== m.accountId ? s : { ...s, items: s.items.map((i) => (i.id === m.id ? { ...i, ...patch } : i)) })))

  const removeItem = (m: Open) =>
    setSources((prev) => prev && prev.map((s) => (s.accountId !== m.accountId ? s : { ...s, items: s.items.filter((i) => i.id !== m.id) })))

  // Ungelesen-Zahl im Ordner und an der Seitenleiste sofort anpassen, der nächste Abruf bestätigt sie
  const bumpUnread = (accountId: string, delta: number) => {
    setFolders((f) => {
      const cur = f[accountId]?.list
      if (!cur) return f
      const folderId = sel.kind === 'folder' ? sel.folderId : 'inbox'
      const list = cur.map((x) => (x.id === folderId || (folderId === 'inbox' && x.kind === 'inbox') ? { ...x, unread: Math.max(0, x.unread + delta) } : x))
      const inbox = list.find((x) => x.kind === 'inbox')
      if (inbox) setMailUnread(accountId, inbox.unread)
      return { ...f, [accountId]: { list } }
    })
  }

  const openMail = (m: MailSummary) => {
    setCompose(null)
    setOpen({ accountId: m.accountId, id: m.id })
    if (!m.isRead && !m.isDraft) {
      patchItem(m, { isRead: true })
      bumpUnread(m.accountId, -1)
      void api.setMailRead(m.accountId, m.id, true).catch(() => {
        patchItem(m, { isRead: false })
        bumpUnread(m.accountId, 1)
      })
    }
  }

  const selectFolder = (next: Sel) => {
    setSel(next)
    setOpen(null)
  }

  const defaultAccount = () =>
    (accounts.find((a) => a.id === activeAccountId && a.status === 'ready') ?? accounts.find((a) => a.status === 'ready') ?? accounts[0])?.id ?? ''

  const listTitle = sel.kind === 'all' ? 'Alle Posteingänge' : sel.name
  const showTo = sel.kind === 'folder' && (sel.folderKind === 'sentitems' || sel.folderKind === 'drafts')

  if (!accounts.length) {
    return (
      <div className="main-pane">
        <div className="empty-state">
          <h2>Kein Postfach</h2>
          <div>Gastzugänge haben kein eigenes Postfach.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="mail">
      <div className="list-pane mail-folders">
        <div className="list-header">
          <h1>E-Mail</h1>
          <Tooltip content="Neue E-Mail" relationship="label">
            <button className="icon-btn" onClick={() => (setOpen(null), setCompose({ kind: 'new', accountId: defaultAccount() }))}>
              <Compose20Regular />
            </button>
          </Tooltip>
          <Tooltip content="Neu laden" relationship="label">
            <button className="icon-btn" onClick={() => (loadFolders(), setSel({ ...sel }))}>
              <ArrowSync20Regular />
            </button>
          </Tooltip>
        </div>
        <div className="list-scroll">
          {multi && (
            <button className={`folder-row ${sel.kind === 'all' ? 'selected' : ''}`} onClick={() => selectFolder({ kind: 'all' })}>
              <MailInboxAll20Regular />
              <span className="name">Alle Posteingänge</span>
              <Count n={accounts.reduce((n, a) => n + (folders[a.id]?.list?.find((f) => f.kind === 'inbox')?.unread ?? 0), 0)} />
            </button>
          )}
          {accounts.map((a) => {
            const f = folders[a.id]
            const isCollapsed = collapsed.includes(a.id)
            return (
              <div key={a.id}>
                {multi && (
                  <button
                    className="section-title"
                    title={a.upn}
                    onClick={() => setCollapsed(isCollapsed ? collapsed.filter((c) => c !== a.id) : [...collapsed, a.id])}
                  >
                    {isCollapsed ? <ChevronRight16Regular /> : <ChevronDown16Regular />}
                    <span className="acct-dot" style={{ background: color(a.id) }} />
                    <span>{calendarAccountName(a)}</span>
                  </button>
                )}
                {!isCollapsed && (
                  <>
                    {a.status !== 'ready' && <div className="folder-note">Nicht verbunden</div>}
                    {f?.error && !f.list && <div className="folder-note" title={f.error}>Ordner nicht geladen</div>}
                    {!f && a.status === 'ready' && <div className="folder-note">Lädt …</div>}
                    {f?.list?.map((folder) => {
                      const selected =
                        sel.kind === 'folder' && sel.accountId === a.id && (sel.folderId === folder.id || (sel.folderId === 'inbox' && folder.kind === 'inbox'))
                      return (
                        <button
                          key={folder.id}
                          className={`folder-row ${selected ? 'selected' : ''}`}
                          onClick={() => selectFolder({ kind: 'folder', accountId: a.id, folderId: folder.id, name: folder.name, folderKind: folder.kind })}
                        >
                          {folder.kind ? ICONS[folder.kind] : <Folder20Regular />}
                          <span className="name">{folder.name}</span>
                          <Count n={folder.kind === 'drafts' || folder.kind === 'sentitems' || folder.kind === 'deleteditems' ? 0 : folder.unread} />
                        </button>
                      )
                    })}
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>
      <div className="mail-list">
        <div className="pane-header">
          <span className="title">{listTitle}</span>
          {sel.kind === 'folder' && multi && (
            <span className="mail-acct" title={byId(sel.accountId)?.upn}>
              <span className="acct-dot" style={{ background: color(sel.accountId) }} />
              {name(byId(sel.accountId))}
            </span>
          )}
        </div>
        {errors.length > 0 && (
          <div className="banner mail-banner">
            <Warning20Regular />
            <span className="grow">Nicht geladen: {errors.map((e) => `${name(byId(e.accountId))} (${e.error})`).join(', ')}</span>
          </div>
        )}
        <div
          className="list-scroll mail-scroll"
          onScroll={(e) => {
            const el = e.currentTarget
            if (hasMore && !loadingMore && el.scrollTop + el.clientHeight > el.scrollHeight - 300) void loadMore()
          }}
        >
          {!sources && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
              <Spinner size="small" />
            </div>
          )}
          {sources && !items.length && !errors.length && (
            <div className="folder-note" style={{ padding: 24, textAlign: 'center' }}>
              {wanted.length ? 'Keine Mails' : 'Kein Konto verbunden'}
            </div>
          )}
          {items.map((m) => {
            const selected = !!open && open.accountId === m.accountId && open.id === m.id
            const who = showTo ? m.to.map(addressLabel).join(', ') || '(Keine Empfänger)' : addressLabel(m.from) || '(Unbekannt)'
            return (
              <div key={key(m)} className={`mail-item ${m.isRead ? '' : 'unread'} ${selected ? 'selected' : ''}`} onClick={() => openMail(m)}>
                {multi && sel.kind === 'all' && <span className="acct-bar" style={{ background: color(m.accountId) }} />}
                <div className="row1">
                  <span className="name">{m.isDraft ? <span className="draft">[Entwurf] </span> : null}{who}</span>
                  <span className="time">{listTime(m.received)}</span>
                </div>
                <div className="row2">
                  <span className="subject">{m.subject}</span>
                  {m.importance === 'high' && <Important16Filled className="imp" />}
                  {m.flagged && <Flag16Filled className="flag" />}
                  {m.hasAttachments && <Attach16Regular />}
                </div>
                <div className="preview">{m.preview || ' '}</div>
              </div>
            )
          })}
          {loadingMore && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 12 }}>
              <Spinner size="tiny" />
            </div>
          )}
        </div>
      </div>
      <div className="mail-reader">
        {compose ? (
          <MailCompose
            state={compose}
            accounts={accounts}
            color={color}
            onClose={() => setCompose(null)}
            onSent={() => {
              setCompose(null)
              setTimeout(loadFolders, 1500)
            }}
          />
        ) : open ? (
          <MailReader
            key={key(open)}
            target={open}
            account={byId(open.accountId)}
            multi={multi}
            color={color}
            onReply={(m, kind) => setCompose({ kind, accountId: m.accountId, source: m })}
            onUnread={(m) => {
              patchItem(m, { isRead: false })
              bumpUnread(m.accountId, 1)
              setOpen(null)
              void api.setMailRead(m.accountId, m.id, false).catch(() => {})
            }}
            onDelete={async (m) => {
              await api.deleteMail(m.accountId, m.id)
              removeItem(m)
              if (!m.isRead) bumpUnread(m.accountId, -1)
              setOpen(null)
            }}
          />
        ) : (
          <div className="empty-state">
            <Mail20Regular style={{ width: 40, height: 40 }} />
            <div>Wähle eine Mail aus</div>
          </div>
        )}
      </div>
    </div>
  )
}

function Count({ n }: { n: number }): JSX.Element | null {
  return n > 0 ? <span className="folder-count">{n > 999 ? '999+' : n}</span> : null
}

const name = (a?: AccountInfo) => (a ? calendarAccountName(a) : 'Konto')

function MailReader({
  target,
  account,
  multi,
  color,
  onReply,
  onUnread,
  onDelete
}: {
  target: Open
  account?: AccountInfo
  multi: boolean
  color: (id: string) => string
  onReply: (m: MailMessage, kind: MailReplyKind) => void
  onUnread: (m: MailMessage) => void
  onDelete: (m: MailMessage) => Promise<void>
}): JSX.Element {
  const [m, setM] = useState<MailMessage | null>(null)
  const [error, setError] = useState<string>()
  const [remote, setRemote] = useState(false)
  const [busy, setBusy] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    let alive = true
    api
      .getMail(target.accountId, target.id)
      .then((x) => alive && setM(x))
      .catch((e) => alive && setError(ipcErrorText(e)))
    return () => {
      alive = false
    }
  }, [target.accountId, target.id])

  const doc = useMemo(() => (m ? mailDocument(m, remote) : null), [m, remote])

  if (error && !m) {
    return (
      <div className="empty-state">
        <h2>Mail nicht geladen</h2>
        <div style={{ maxWidth: 480 }}>{error}</div>
      </div>
    )
  }
  if (!m || !doc) {
    return (
      <div className="empty-state">
        <Spinner size="small" />
      </div>
    )
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
    } catch (e) {
      setError(ipcErrorText(e))
      setBusy(false)
    }
  }

  const attachment = (id: string, mode: 'open' | 'save') =>
    void api.openMailAttachment(m.accountId, m.id, id, mode).catch((e) => setError(ipcErrorText(e)))

  return (
    <div className="mail-read">
      <div className="mail-actions">
        <Button size="small" icon={<ArrowReply20Regular />} disabled={busy} onClick={() => onReply(m, 'reply')}>
          Antworten
        </Button>
        <Button size="small" icon={<ArrowReplyAll20Regular />} disabled={busy} onClick={() => onReply(m, 'replyAll')}>
          Allen antworten
        </Button>
        <Button size="small" icon={<ArrowForward20Regular />} disabled={busy} onClick={() => onReply(m, 'forward')}>
          Weiterleiten
        </Button>
        <div style={{ flex: 1 }} />
        <Tooltip content="Als ungelesen markieren" relationship="label">
          <Button size="small" appearance="subtle" icon={<MailUnread20Regular />} disabled={busy} onClick={() => onUnread(m)} />
        </Tooltip>
        <Tooltip content="Löschen" relationship="label">
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={busy} onClick={() => void run(() => onDelete(m))} />
        </Tooltip>
      </div>
      <div className="mail-head">
        <h2>{m.subject}</h2>
        <div className="mail-from">
          <span className="who">{m.from ? `${m.from.name ?? ''} <${m.from.address}>`.trim() : '(Unbekannt)'}</span>
          <span className="when">{fmt(m.received, 'EEE dd.MM.yyyy HH:mm')}</span>
        </div>
        {m.to.length > 0 && <div className="mail-to">An: {m.to.map(addressLabel).join('; ')}</div>}
        {m.cc.length > 0 && <div className="mail-to">Cc: {m.cc.map(addressLabel).join('; ')}</div>}
        {multi && account && (
          <div className="mail-to" title={account.upn}>
            <span className="acct-dot" style={{ background: color(account.id) } as CSSProperties} /> {calendarAccountName(account)}
          </div>
        )}
        {m.attachments.length > 0 && (
          <div className="mail-attachments">
            {m.attachments.map((a) => (
              <div key={a.id} className="mail-attachment">
                <button className="open" title={`${a.name} öffnen`} onClick={() => attachment(a.id, 'open')}>
                  {/^image\//.test(a.contentType ?? '') ? <Image20Regular /> : <Document20Regular />}
                  <span className="att-name">{a.name}</span>
                  <span className="att-size">{fileSize(a.size)}</span>
                </button>
                <Tooltip content="Speichern unter …" relationship="label">
                  <button className="icon-btn" onClick={() => attachment(a.id, 'save')}>
                    <ArrowDownload16Regular />
                  </button>
                </Tooltip>
              </div>
            ))}
          </div>
        )}
        {doc.blocked > 0 && !remote && (
          <div className="mail-blocked">
            <Image20Regular />
            <span className="grow">Externe Bilder sind blockiert, damit der Absender nicht sieht, ob und wann du die Mail liest.</span>
            <Button size="small" onClick={() => setRemote(true)}>
              Bilder anzeigen
            </Button>
          </div>
        )}
        {error && <div className="mail-error">{error}</div>}
      </div>
      <iframe ref={frame} className="mail-body" title="Inhalt der Mail" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={doc.html} />
    </div>
  )
}
