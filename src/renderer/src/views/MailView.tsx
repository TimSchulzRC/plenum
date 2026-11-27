import { Button, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, Spinner, SplitButton, Tooltip, type MenuButtonProps } from '@fluentui/react-components'
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
  CheckmarkCircle16Regular,
  FolderOpen16Regular,
  MoreHorizontal16Regular,
  Open16Regular,
  Save16Regular,
  Important16Filled,
  Flag16Filled,
  MailInboxAll20Regular,
  ArrowSync20Regular,
  ShieldError20Regular,
  WeatherMoon20Regular,
  WeatherSunny20Regular
} from '@fluentui/react-icons'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { AccountInfo, MailAddress, MailAttachment, MailFolder, MailFolderKind, MailMessage, MailReplyKind, MailSummary } from '@shared/types'
import { api } from '../api'
import { fmt, listTime } from '../lib/format'
import { accountTitle } from '@shared/accounts'
import { accountColor, ipcErrorText } from '../lib/calendar'
import { addressLabel, fileSize, mergeMail } from '../lib/mail'
import { mailDocument } from '../lib/mail-html'
import { setMailUnread } from '../lib/mail-unread'
import { useStore } from '../store'
import { useDarkMode } from '../theme'
import { MailCompose, type ComposeState } from '../components/MailCompose'
import { MailAvatar } from '../components/Avatars'

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
  const [reload, setReload] = useState(0)

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
  }, [wantedKey, reload])

  const items = useMemo(() => mergeMail((sources ?? []).map((s) => s.items)), [sources])
  const errors = (sources ?? []).filter((s) => s.error)
  const hasMore = (sources ?? []).some((s) => s.next)

  // Ältere Mails nachladen. Jede Seite landet nur in ihrer Quelle, und nur, wenn die noch denselben
  // Cursor hat: Nach einem Ordnerwechsel oder Neuladen fällt die Antwort weg, und zwischendurch
  // gelesene oder gelöschte Mails bleiben, wie sie sind.
  const loadMore = async () => {
    if (!sources || loadingMore) return
    setLoadingMore(true)
    await Promise.all(
      sources
        .filter((s) => s.next)
        .map(async ({ accountId, folderId, next: cursor }) => {
          const same = (s: Source) => s.accountId === accountId && s.folderId === folderId && s.next === cursor
          try {
            const p = await api.listMail(accountId, folderId, cursor)
            setSources((prev) => prev && prev.map((s) => (same(s) ? { ...s, items: [...s.items, ...p.items.filter((i) => !s.items.some((x) => x.id === i.id))], next: p.next, error: undefined } : s)))
          } catch (e) {
            setSources((prev) => prev && prev.map((s) => (same(s) ? { ...s, error: ipcErrorText(e) } : s)))
          }
        })
    )
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
            <button className="icon-btn" onClick={() => (loadFolders(), setReload((n) => n + 1))}>
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
                    <span>{accountTitle(a).name}</span>
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
                <MailAvatar accountId={m.accountId} address={showTo ? m.to[0] : m.from} name={who} />
                <div className="mail-main">
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
            onUnread={async (m) => {
              await api.setMailRead(m.accountId, m.id, false)
              patchItem(m, { isRead: false })
              bumpUnread(m.accountId, 1)
              setOpen(null)
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

const name = (a?: AccountInfo) => (a ? accountTitle(a).name : 'Konto')

function Recipients({ label, list, accountId }: { label: string; list: MailAddress[]; accountId: string }): JSX.Element {
  return (
    <div className="mail-to mail-recipients">
      <span>{label}</span>
      {list.map((a, i) => (
        <span key={`${a.address}|${i}`} className="mail-person" title={a.address}>
          <MailAvatar accountId={accountId} address={a} size={20} />
          {addressLabel(a)}
        </span>
      ))}
    </div>
  )
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path

// Anhänge einer Mail. Klick auf den Namen öffnet, der Pfeil lädt direkt in den Download-Ordner.
// „Speichern unter …“ gibt es im Menü (… oder Rechtsklick), ab zwei Anhängen auch für alle.
function MailAttachments({ m, onError }: { m: MailMessage; onError: (e?: string) => void }): JSX.Element {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [saved, setSaved] = useState<{ text: string; path: string } | null>(null)

  const run = async (key: string, fn: () => Promise<{ text: string; path: string } | null>) => {
    onError(undefined)
    setPending((p) => new Set(p).add(key))
    try {
      const r = await fn()
      if (r) setSaved(r)
    } catch (e) {
      onError(ipcErrorText(e))
    } finally {
      setPending((p) => {
        const n = new Set(p)
        n.delete(key)
        return n
      })
    }
  }

  const open = (a: MailAttachment) => void api.openMailAttachment(m.accountId, m.id, a.id, 'open').catch((e) => onError(ipcErrorText(e)))
  const save = (a: MailAttachment, mode: 'download' | 'saveAs') =>
    void run(a.id, async () => {
      const path = await api.openMailAttachment(m.accountId, m.id, a.id, mode)
      if (!path) return null
      return { text: mode === 'download' ? `„${fileName(path)}“ in Downloads gespeichert` : `„${fileName(path)}“ gespeichert`, path }
    })
  const saveAll = (target: 'downloads' | 'choose') =>
    void run('all', async () => {
      const r = await api.saveMailAttachments(
        m.accountId,
        m.id,
        m.attachments.map((a) => a.id),
        target
      )
      if (!r) return null
      const n = r.paths.length
      const where = r.inDownloads ? 'Downloads' : `„${fileName(r.folder)}“`
      let text = `${n === 1 ? '1 Anhang' : `${n} Anhänge`} in ${where} gespeichert`
      if (r.skipped) text += `, ${r.skipped} nicht gespeichert`
      return { text, path: r.paths[0] }
    })

  const items = (a: MailAttachment) => (
    <MenuList>
      <MenuItem icon={<Open16Regular />} onClick={() => open(a)}>
        Öffnen
      </MenuItem>
      <MenuItem icon={<ArrowDownload16Regular />} onClick={() => save(a, 'download')}>
        In Downloads speichern
      </MenuItem>
      <MenuItem icon={<Save16Regular />} onClick={() => save(a, 'saveAs')}>
        Speichern unter …
      </MenuItem>
    </MenuList>
  )

  return (
    <>
      <div className="mail-attachments">
        {m.attachments.map((a) => (
          <Menu key={a.id} openOnContext positioning="below-start">
            <MenuTrigger disableButtonEnhancement>
              <div className="mail-attachment">
                <button className="open" title={`${a.name} öffnen`} onClick={() => open(a)}>
                  {/^image\//.test(a.contentType ?? '') ? <Image20Regular /> : <Document20Regular />}
                  <span className="att-name">{a.name}</span>
                  <span className="att-size">{fileSize(a.size)}</span>
                </button>
                <Tooltip content="In Downloads speichern" relationship="label">
                  <button className="icon-btn" disabled={pending.has(a.id)} onClick={() => save(a, 'download')}>
                    {pending.has(a.id) ? <Spinner size="extra-tiny" /> : <ArrowDownload16Regular />}
                  </button>
                </Tooltip>
                <Menu positioning="below-end">
                  <MenuTrigger disableButtonEnhancement>
                    <Tooltip content="Weitere Optionen" relationship="label">
                      <button className="icon-btn">
                        <MoreHorizontal16Regular />
                      </button>
                    </Tooltip>
                  </MenuTrigger>
                  <MenuPopover>{items(a)}</MenuPopover>
                </Menu>
              </div>
            </MenuTrigger>
            <MenuPopover>{items(a)}</MenuPopover>
          </Menu>
        ))}
        {m.attachments.length > 1 && (
          <Menu positioning="below-start">
            <MenuTrigger disableButtonEnhancement>
              {(triggerProps: MenuButtonProps) => (
                <SplitButton
                  className="mail-save-all"
                  size="small"
                  icon={pending.has('all') ? <Spinner size="extra-tiny" /> : <ArrowDownload16Regular />}
                  menuButton={triggerProps}
                  primaryActionButton={{ onClick: () => saveAll('downloads'), disabled: pending.has('all') }}
                >
                  Alle herunterladen
                </SplitButton>
              )}
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem icon={<FolderOpen16Regular />} disabled={pending.has('all')} onClick={() => saveAll('choose')}>
                  Alle speichern unter …
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        )}
      </div>
      {saved && (
        <div className="mail-saved">
          <CheckmarkCircle16Regular />
          <span className="text">{saved.text}</span>
          <Button size="small" appearance="transparent" onClick={() => void api.showSavedFile(saved.path)}>
            Im Ordner zeigen
          </Button>
        </div>
      )}
    </>
  )
}

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
  onUnread: (m: MailMessage) => Promise<void>
  onDelete: (m: MailMessage) => Promise<void>
}): JSX.Element {
  const [m, setM] = useState<MailMessage | null>(null)
  const [error, setError] = useState<string>()
  const [remote, setRemote] = useState(false)
  const [busy, setBusy] = useState(false)
  // Im dunklen Theme dunkel, einzeln auf hell umschaltbar, falls eine Mail umgekehrt schlecht aussieht
  const darkTheme = useDarkMode()
  const [light, setLight] = useState(false)
  const dark = darkTheme && !light
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

  const doc = useMemo(() => (m ? mailDocument(m, remote, dark) : null), [m, remote, dark])

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
        {darkTheme && (
          <Tooltip content={light ? 'Dunkel anzeigen' : 'Hell anzeigen'} relationship="label">
            <Button size="small" appearance="subtle" icon={light ? <WeatherMoon20Regular /> : <WeatherSunny20Regular />} onClick={() => setLight(!light)} />
          </Tooltip>
        )}
        <Tooltip content="Als ungelesen markieren" relationship="label">
          <Button size="small" appearance="subtle" icon={<MailUnread20Regular />} disabled={busy} onClick={() => void run(() => onUnread(m))} />
        </Tooltip>
        <Tooltip content="Löschen" relationship="label">
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={busy} onClick={() => void run(() => onDelete(m))} />
        </Tooltip>
      </div>
      <div className="mail-head">
        <h2>{m.subject}</h2>
        <div className="mail-sender">
          <MailAvatar accountId={m.accountId} address={m.from} name="(Unbekannt)" size={40} />
          <div className="mail-people">
            <div className="mail-from">
              <span className="who">{m.from ? `${m.from.name ?? ''} <${m.from.address}>`.trim() : '(Unbekannt)'}</span>
              <span className="when">{fmt(m.received, 'EEE dd.MM.yyyy HH:mm')}</span>
            </div>
            {m.to.length > 0 && <Recipients label="An:" list={m.to} accountId={m.accountId} />}
            {m.cc.length > 0 && <Recipients label="Cc:" list={m.cc} accountId={m.accountId} />}
            {multi && account && (
              <div className="mail-to" title={account.upn}>
                <span className="acct-dot" style={{ background: color(account.id) } as CSSProperties} /> {accountTitle(account).name}
              </div>
            )}
          </div>
        </div>
        {m.attachments.length > 0 && <MailAttachments m={m} onError={setError} />}
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
      <iframe ref={frame} className={`mail-body ${dark ? 'dark' : ''}`} title="Inhalt der Mail" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={doc.html} />
    </div>
  )
}
