import { Button, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, Spinner, SplitButton, ToggleButton, Tooltip, type MenuButtonProps } from '@fluentui/react-components'
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
  DocumentHeader20Regular,
  Signature20Regular,
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
  WeatherSunny20Regular,
  Chat20Regular,
  DocumentText20Regular
} from '@fluentui/react-icons'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { AccountInfo, MailAddress, MailAttachment, MailFolder, MailFolderKind, MailImages, MailMessage, MailReplyKind, MailSummary } from '@shared/types'
import { api } from '../api'
import { fmt, listTime, messageTime } from '../lib/format'
import { accountTitle } from '@shared/accounts'
import { accountColor, ipcErrorText } from '../lib/calendar'
import { addressLabel, fileSize, mergeMail, withImages } from '../lib/mail'
import { cachedMail, loadImageIndex, loadMail, prefetchMail, prefetchTop } from '../lib/mail-load'
import { cachedFolders, cachedList, loadFolders as loadFolderList, loadList, noteMailChange, noteUnreadBump, prefetchList, staleFolder } from '../lib/mail-lists'
import { HOVER_DELAY } from '../lib/prefetch'
import { mailDocument, type ChatOptions } from '../lib/mail-html'
import { modelRanges, modelRequest, type SigRange } from '../lib/mail-signature'
import { setMailUnread } from '../lib/mail-unread'
import { useStore } from '../store'
import { useDarkMode } from '../theme'
import { MailCompose, type ComposeState, type SentMail } from '../components/MailCompose'
import { MailAvatar } from '../components/Avatars'

type Sel = { kind: 'all' } | { kind: 'folder'; accountId: string; folderId: string; name: string; folderKind?: MailFolderKind }
// older: über „mehr laden“ geholte ältere Zeilen. Nur die bleiben beim Abgleich der ersten Seite stehen.
type Source = { accountId: string; folderId: string; items: MailSummary[]; next?: string; error?: string; older?: MailSummary[] }
// draft: Entwurf, immer frisch laden
type Open = { accountId: string; id: string; draft?: boolean }

const ICONS: Record<MailFolderKind, JSX.Element> = {
  inbox: <MailInbox20Regular />,
  drafts: <Drafts20Regular />,
  sentitems: <Send20Regular />,
  archive: <Archive20Regular />,
  deleteditems: <Delete20Regular />,
  junkemail: <ShieldError20Regular />
}

const key = (m: { accountId: string; id: string }) => `${m.accountId}|${m.id}`
// Den Posteingang über seinen festen Namen laden, wie „Alle Posteingänge“ und das Vorladen: eine Liste im Speicher
const folderKey = (f: MailFolder) => (f.kind === 'inbox' ? 'inbox' : f.id)

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
  // Konten im Posteingang: verbundene und solche mit gespeicherter Liste. Verbindet sich ein Konto kurz
  // neu, bleiben seine Mails stehen, statt dass die ganze Liste neu lädt.
  const inboxKey = accounts
    .filter((a) => a.status === 'ready' || cachedList(a.id, 'inbox'))
    .map((a) => a.id)
    .join(',')

  // Gespeicherte Ordner sofort, abgeglichen wird danach
  const [folders, setFolders] = useState<Record<string, { list?: MailFolder[]; error?: string }>>(() =>
    Object.fromEntries(ids.flatMap((id) => (cachedFolders(id) ? [[id, { list: cachedFolders(id) }]] : [])))
  )
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [sel, setSel] = useState<Sel>(() =>
    accounts.length > 1 ? { kind: 'all' } : { kind: 'folder', accountId: accounts[0]?.id ?? '', folderId: 'inbox', name: 'Posteingang', folderKind: 'inbox' }
  )
  const [sources, setSources] = useState<Source[] | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [open, setOpen] = useState<Open | null>(null)
  const [compose, setCompose] = useState<ComposeState | null>(null)
  const [reload, setReload] = useState(0)

  // Ordner aller Konten, beim Öffnen (ein frischer gespeicherter Stand reicht) und alle zwei Minuten.
  // Fehlgeschlagene alle 5 s noch einmal, eine Minute lang (Mail-Token kommt nach dem Start oft später).
  const folderLoads = useRef<(force: boolean) => void>(() => undefined)
  useEffect(() => {
    let alive = true
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const tries = new Map<string, number>()
    const loadOne = (id: string, force: boolean) => {
      loadFolderList(id, force)
        .then((list) => {
          if (!alive) return
          clearTimeout(timers.get(id))
          timers.delete(id)
          tries.delete(id)
          setFolders((f) => ({ ...f, [id]: { list } }))
          const inbox = list.find((x) => x.kind === 'inbox')
          if (inbox) setMailUnread(id, inbox.unread)
        })
        .catch((e) => {
          if (!alive) return
          setFolders((f) => ({ ...f, [id]: { ...f[id], error: ipcErrorText(e) } }))
          const n = tries.get(id) ?? 0
          if (timers.has(id) || n >= 12) return
          tries.set(id, n + 1)
          timers.set(
            id,
            setTimeout(() => {
              timers.delete(id)
              loadOne(id, true)
            }, 5000)
          )
        })
    }
    const all = (force: boolean) => readyKey.split(',').filter(Boolean).forEach((id) => loadOne(id, force))
    folderLoads.current = all
    all(false)
    const t = setInterval(() => all(true), 120_000)
    return () => {
      alive = false
      clearInterval(t)
      timers.forEach(clearTimeout)
    }
  }, [readyKey])
  const loadFolders = (force = false) => folderLoads.current(force)

  const wanted = useMemo<{ accountId: string; folderId: string }[]>(() => {
    if (sel.kind === 'all') return inboxKey.split(',').filter(Boolean).map((accountId) => ({ accountId, folderId: 'inbox' }))
    return [{ accountId: sel.accountId, folderId: sel.folderId }]
  }, [sel, inboxKey])
  const wantedKey = wanted.map((w) => `${w.accountId}:${w.folderId}`).join(',')

  // Liste laden. Gespeicherte Listen stehen sofort da, dann der aktuelle Stand (ein frischer gespeicherter
  // reicht). Jedes Konto erscheint, sobald es da ist, ein langsames hält die anderen nicht auf. Alle 60
  // Sekunden die erste Seite neu, schon nachgeladene ältere Mails bleiben. Nicht verbundene Konten zeigen
  // nur ihren gespeicherten Stand. Fehlgeschlagene alle 5 s noch einmal, eine Minute lang: Nach dem Start
  // fehlt oft noch der Mail-Token der Web-App.
  const lastReload = useRef(reload)
  const [pending, setPending] = useState(0)
  useEffect(() => {
    let alive = true
    const ready = new Set(readyKey.split(',').filter(Boolean))
    const same = (a: { accountId: string; folderId: string }, b: { accountId: string; folderId: string }) => a.accountId === b.accountId && a.folderId === b.folderId
    const stored = wanted.flatMap((w): Source[] => {
      const p = cachedList(w.accountId, w.folderId)
      return p ? [{ ...w, items: p.items, next: p.next }] : []
    })
    // Ohne Konto gibt es nichts zu laden: gleich „Kein Konto verbunden“ statt Ladekreis
    setSources(stored.length || !wanted.length ? stored : null)
    const put = (f: Source) =>
      setSources((prev) => {
        const list = prev ?? []
        const old = list.find((x) => same(x, f))
        let merged = f
        if (old && f.error) merged = old.items.length ? old : f
        // Die erste Seite ersetzt die alte. Was „mehr laden“ geholt hat, bleibt dahinter stehen, solange es
        // älter ist als die neue erste Seite. Ohne Folgeseite ist das der ganze Ordner, dann nichts.
        // Endet die neue erste Seite woanders als die alte (neue Mails haben Zeilen nach hinten geschoben),
        // klaffte zwischen ihr und den älteren eine Lücke: dann von der neuen ersten Seite aus weiterblättern.
        else if (old?.older?.length && f.next) {
          const first = old.items.filter((i) => !old.older?.some((x) => x.id === i.id))
          if (first.at(-1)?.id === f.items.at(-1)?.id) {
            const keep = old.older.filter((i) => !f.items.some((x) => x.id === i.id))
            merged = { ...f, items: [...f.items, ...keep], older: keep, next: old.next }
          }
        }
        return old ? list.map((x) => (x === old ? merged : x)) : [...list, merged]
      })
    // Jede Quelle für sich: Eine fehlgeschlagene kommt nach 5 s wieder dran, ohne auf langsame zu warten.
    // Ein Timer je Quelle, nach Erfolg zählt sie wieder von vorn.
    const retries = new Map<string, number>()
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const loadOne = async (w: (typeof wanted)[number], force: boolean, initial: boolean) => {
      if (!ready.has(w.accountId)) {
        if (!stored.some((x) => same(x, w))) put({ ...w, items: [], error: 'Nicht verbunden' })
        return
      }
      const k = `${w.accountId}|${w.folderId}`
      try {
        const p = await loadList(w.accountId, w.folderId, force)
        if (!alive) return
        put({ ...w, items: p.items, next: p.next })
        retries.delete(k)
        clearTimeout(timers.get(k))
        timers.delete(k)
      } catch (e) {
        if (!alive) return
        put({ ...w, items: [], error: ipcErrorText(e) })
        const n = retries.get(k) ?? 0
        if (!timers.has(k) && n < 12) {
          retries.set(k, n + 1)
          timers.set(
            k,
            setTimeout(() => {
              timers.delete(k)
              void loadOne(w, true, false)
            }, 5000)
          )
        }
      } finally {
        if (alive && initial) setPending((n) => Math.max(0, n - 1))
      }
    }
    const load = (force: boolean, initial = false) => {
      if (initial) setPending(wanted.filter((w) => ready.has(w.accountId)).length)
      for (const w of wanted) void loadOne(w, force, initial)
    }
    // Neu laden (Knopf) holt immer den aktuellen Stand
    load(reload !== lastReload.current, true)
    lastReload.current = reload
    const t = setInterval(() => load(true), 60_000)
    return () => {
      alive = false
      clearInterval(t)
      timers.forEach(clearTimeout)
    }
    // wantedKey fasst wanted zusammen, wanted selbst ändert sich bei jedem Render
  }, [wantedKey, reload, readyKey])

  const items = useMemo(() => mergeMail((sources ?? []).map((s) => s.items)), [sources])
  // Die obersten Mails vorladen (ohne Bilder), dann öffnen sie sofort
  const topKey = items.slice(0, 3).map(key).join(',')
  useEffect(() => {
    if (topKey) void prefetchTop(items.slice(0, 3))
    // topKey fasst die drei obersten zusammen
  }, [topKey])
  // Beim Überfahren einer Mail in der Liste: nach kurzer Pause vorladen, beim Drücken sofort
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const folderTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(
    () => () => {
      clearTimeout(hoverTimer.current)
      clearTimeout(folderTimer.current)
    },
    []
  )
  // Beim Überfahren eines Ordners seine Liste vorladen, beim Drücken sofort
  const hoverFolder = (fn: () => unknown) => ({
    onMouseEnter: () => {
      clearTimeout(folderTimer.current)
      folderTimer.current = setTimeout(fn, HOVER_DELAY)
    },
    onMouseLeave: () => clearTimeout(folderTimer.current),
    onMouseDown: () => {
      clearTimeout(folderTimer.current)
      fn()
    }
  })
  const hoverProps = (x: MailSummary) => ({
    onMouseEnter: () => {
      clearTimeout(hoverTimer.current)
      hoverTimer.current = setTimeout(() => prefetchMail(x), HOVER_DELAY)
    },
    onMouseLeave: () => clearTimeout(hoverTimer.current),
    onMouseDown: (e: { button: number }) => {
      if (e.button !== 0) return
      clearTimeout(hoverTimer.current)
      prefetchMail(x)
    }
  })
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
            setSources(
              (prev) =>
                prev &&
                prev.map((s) => {
                  if (!same(s)) return s
                  const add = p.items.filter((i) => !s.items.some((x) => x.id === i.id))
                  return { ...s, items: [...s.items, ...add], older: [...(s.older ?? []), ...add], next: p.next, error: undefined }
                })
            )
          } catch (e) {
            setSources((prev) => prev && prev.map((s) => (same(s) ? { ...s, error: ipcErrorText(e) } : s)))
          }
        })
    )
    setLoadingMore(false)
  }

  // Auch im Speicher und gegen Antworten, die noch unterwegs sind (noteMailChange)
  const patchItem = (m: Open, patch: Partial<MailSummary>, pending = false) => {
    const settle = noteMailChange(m.accountId, m.id, { patch }, pending)
    const fn = (items: MailSummary[]) => items.map((i) => (i.id === m.id ? { ...i, ...patch } : i))
    setSources((prev) => prev && prev.map((s) => (s.accountId !== m.accountId ? s : { ...s, items: fn(s.items), older: s.older && fn(s.older) })))
    return settle
  }

  const removeItem = (m: Open) => {
    noteMailChange(m.accountId, m.id, { deleted: true })
    const fn = (items: MailSummary[]) => items.filter((i) => i.id !== m.id)
    setSources((prev) => prev && prev.map((s) => (s.accountId !== m.accountId ? s : { ...s, items: fn(s.items), older: s.older && fn(s.older) })))
  }

  // Nach Senden oder Löschen: Gesendete bzw. Gelöschte neu laden, gleich, wenn der Ordner jetzt offen ist
  // (auch wenn man während des Sendens dorthin gewechselt hat)
  const selRef = useRef(sel)
  selRef.current = sel
  const refreshFolder = (accountId: string, kind: MailFolderKind) => {
    const id = staleFolder(accountId, kind)
    const cur = selRef.current
    if (cur.kind === 'folder' && cur.accountId === accountId && cur.folderId === id) setReload((n) => n + 1)
    setTimeout(() => loadFolders(true), 1500)
  }

  // Ungelesen-Zahl im Ordner und an der Seitenleiste sofort anpassen, der nächste Abruf bestätigt sie
  // pending: Die Änderung auf dem Server läuft noch, die zurückgegebene Funktion meldet ihr Ende
  const bumpUnread = (accountId: string, delta: number, pending = false) => {
    const folderId = sel.kind === 'folder' ? sel.folderId : 'inbox'
    const bump = (cur: MailFolder[]) => cur.map((x) => (x.id === folderId || (folderId === 'inbox' && x.kind === 'inbox') ? { ...x, unread: Math.max(0, x.unread + delta) } : x))
    const settle = noteUnreadBump(accountId, folderId, delta, pending)
    setFolders((f) => {
      const cur = f[accountId]?.list
      if (!cur) return f
      const list = bump(cur)
      const inbox = list.find((x) => x.kind === 'inbox')
      if (inbox) setMailUnread(accountId, inbox.unread)
      return { ...f, [accountId]: { list } }
    })
    return settle
  }

  const openMail = (m: MailSummary) => {
    setCompose(null)
    setOpen({ accountId: m.accountId, id: m.id, draft: m.isDraft || undefined })
    if (!m.isRead && !m.isDraft) {
      const done = [patchItem(m, { isRead: true }, true), bumpUnread(m.accountId, -1, true)]
      void api
        .setMailRead(m.accountId, m.id, true)
        .catch(() => {
          patchItem(m, { isRead: false })
          bumpUnread(m.accountId, 1)
        })
        .finally(() => {
          done.forEach((f) => f())
          // Jetzt kennt der Server die Änderung: Zahlen der Ordner frisch holen
          loadFolders(true)
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
            <button className="icon-btn" onClick={() => (loadFolders(true), setReload((n) => n + 1))}>
              <ArrowSync20Regular />
            </button>
          </Tooltip>
        </div>
        <div className="list-scroll">
          {multi && (
            <button
              className={`folder-row ${sel.kind === 'all' ? 'selected' : ''}`}
              onClick={() => selectFolder({ kind: 'all' })}
              {...hoverFolder(() => readyKey.split(',').filter(Boolean).forEach((id) => prefetchList(id, 'inbox')))}
            >
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
                          onClick={() => selectFolder({ kind: 'folder', accountId: a.id, folderId: folderKey(folder), name: folder.name, folderKind: folder.kind })}
                          {...hoverFolder(() => a.status === 'ready' && prefetchList(a.id, folderKey(folder)))}
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
          {(!sources || (!items.length && pending > 0)) && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
              <Spinner size="small" />
            </div>
          )}
          {sources && !items.length && !errors.length && !pending && (
            <div className="folder-note" style={{ padding: 24, textAlign: 'center' }}>
              {wanted.length ? 'Keine Mails' : 'Kein Konto verbunden'}
            </div>
          )}
          {items.map((m) => {
            const selected = !!open && open.accountId === m.accountId && open.id === m.id
            const who = showTo ? m.to.map(addressLabel).join(', ') || '(Keine Empfänger)' : addressLabel(m.from) || '(Unbekannt)'
            return (
              <div key={key(m)} className={`mail-item ${m.isRead ? '' : 'unread'} ${selected ? 'selected' : ''}`} onClick={() => openMail(m)} {...hoverProps(m)}>
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
            onSent={(x) => {
              setCompose(null)
              refreshFolder(x.accountId, 'sentitems')
            }}
          />
        ) : open ? (
          <MailReader
            key={key(open)}
            target={open}
            account={byId(open.accountId)}
            multi={multi}
            color={color}
            accounts={accounts}
            onSent={() => refreshFolder(open.accountId, 'sentitems')}
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
              refreshFolder(m.accountId, 'deleteditems')
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

// Ergebnis des Sprachmodells je Mail, damit Umschalten und erneutes Öffnen nicht noch einmal fragen
const modelCache = new Map<string, SigRange[]>()
// Antworten, die in dieser Sitzung auf eine Mail gesendet wurden. Sie stehen nicht in der Mail selbst,
// die Chat-Ansicht zeigt sie trotzdem unter dem Verlauf.
const sentCache = new Map<string, SentMail[]>()

// Signaturen ausblenden: einmal eingestellt, gilt für alle Mails. Standard ist an.
const HIDE_SIG_KEY = 'mail.hideSignatures'
// Kopfzeilen zitierter Nachrichten einklappen: eigener Schalter, ebenfalls Standard an
const HIDE_HEAD_KEY = 'mail.hideHeaders'
// Verlauf als Chat statt als Mail, Standard an
const CHAT_KEY = 'mail.chat'
function loadHidden(key: string): boolean {
  try {
    return localStorage.getItem(key) !== '0'
  } catch {
    return true
  }
}
function saveHidden(key: string, hidden: boolean): void {
  try {
    localStorage.setItem(key, hidden ? '1' : '0')
  } catch {
    /* ignore */
  }
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
  accounts,
  multi,
  color,
  onSent,
  onUnread,
  onDelete
}: {
  target: Open
  account?: AccountInfo
  accounts: AccountInfo[]
  multi: boolean
  color: (id: string) => string
  onSent: () => void
  onUnread: (m: MailMessage) => Promise<void>
  onDelete: (m: MailMessage) => Promise<void>
}): JSX.Element {
  // Erst der Text, dann die eingebetteten Bilder. Eine schon geladene Mail steht sofort.
  const [base, setBase] = useState<MailMessage | null>(() => (target.draft ? null : (cachedMail(target.accountId, target.id) ?? null)))
  // Welche Inline-Anhänge eingebettet sind: nur für die Anhangsliste, das Dokument lädt die Bilder selbst
  const [images, setImages] = useState<MailImages | undefined>()
  const m = useMemo(() => (base ? withImages(base, images) : null), [base, images])
  const [error, setError] = useState<string>()
  const [remote, setRemote] = useState(false)
  const [hideSig, setHideSig] = useState(() => loadHidden(HIDE_SIG_KEY))
  const [hideHead, setHideHead] = useState(() => loadHidden(HIDE_HEAD_KEY))
  const [chat, setChat] = useState(() => loadHidden(CHAT_KEY))
  // Antwort unten im Lesebereich, der Verlauf bleibt darüber sichtbar
  const [reply, setReply] = useState<MailReplyKind | null>(null)
  const [sent, setSent] = useState<SentMail[]>(() => sentCache.get(key(target)) ?? [])
  const [busy, setBusy] = useState(false)
  // Im dunklen Theme dunkel, einzeln auf hell umschaltbar, falls eine Mail umgekehrt schlecht aussieht
  const darkTheme = useDarkMode()
  const [light, setLight] = useState(false)
  const dark = darkTheme && !light
  const frame = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    let alive = true
    loadMail(target.accountId, target.id, { fresh: target.draft })
      .then((x) => {
        if (!alive) return
        setBase(x)
        // Fehlen Bilder, zeigt die Liste die Inline-Anhänge als Dateien
        return loadImageIndex(x).then(
          (i) => alive && setImages(i),
          () => alive && setImages({ images: {}, cids: {} })
        )
      })
      .catch((e) => alive && setError(ipcErrorText(e)))
    return () => {
      alive = false
    }
  }, [target.accountId, target.id, target.draft])

  // Signaturen, die nur das Sprachmodell fand (Teile ohne Regel-Treffer). Die Zeilennummern gelten
  // nur für dieselbe Aufteilung: Mit externen Bildern kommen Zeilen dazu, deshalb je remote getrennt.
  // Ist das Modell in den Einstellungen aus, gelten auch frühere Ergebnisse nicht.
  const modelOn = useStore((s) => s.settings?.mailSignatureModel !== false)
  const modelKey = `${target.accountId}|${target.id}|${remote ? 'remote' : 'local'}`
  const [, setModelTick] = useState(0)
  const modelSig = modelOn ? modelCache.get(modelKey) : undefined
  // Eigene Nachrichten erkennt die Chat-Ansicht an Adresse oder Name eines der Konten
  const chatOptions = useMemo((): ChatOptions | undefined => {
    if (!base || !chat) return undefined
    const who = (a?: MailAddress) => (a ? addressLabel(a) + (a.name ? ` <${a.address}>` : '') : '(Unbekannt)')
    return {
      me: accounts.map((a) => ({ name: a.displayName, address: a.upn })),
      topTime: messageTime(base.received),
      formatTime: messageTime,
      topHeader: [
        `Von: ${who(base.from)}`,
        ...(base.to.length ? [`An: ${base.to.map(who).join('; ')}`] : []),
        ...(base.cc.length ? [`Cc: ${base.cc.map(who).join('; ')}`] : []),
        `Gesendet: ${fmt(base.received, 'EEEE, d. MMMM yyyy HH:mm')}`,
        `Betreff: ${base.subject}`
      ],
      sent: sent.map((x) => {
        const from = accounts.find((a) => a.id === x.accountId)
        return {
          name: from?.displayName || from?.upn || 'Du',
          text: x.text,
          time: messageTime(x.at),
          files: x.files,
          signature: x.signature,
          header: [
            `Von: ${from?.upn ?? ''}`,
            `An: ${x.to.join('; ')}`,
            ...(x.cc.length ? [`Cc: ${x.cc.join('; ')}`] : []),
            `Gesendet: ${fmt(x.at, 'EEEE, d. MMMM yyyy HH:mm')}`
          ]
        }
      })
    }
  }, [m, chat, accounts, sent])
  const doc = useMemo(
    // Mit der Mail ohne Bilder: Sie stehen als tmimg-Adressen im Dokument, die Anhangsliste ändert es nicht
    () => (base ? mailDocument(base, remote, dark, { hide: hideSig, hideHeaders: hideHead, extra: modelSig, chat: chatOptions }) : null),
    [base, remote, dark, hideSig, hideHead, modelSig, chatOptions]
  )

  useEffect(() => {
    // Mit der Mail ohne Bilder: Die Zeilen sind dieselben, und das Nachladen fragt nicht noch einmal
    if (!base || !(hideSig || chat) || !modelOn || modelCache.has(modelKey)) return
    const open = mailDocument(base, remote).unresolved
    const req = modelRequest(open)
    if (!req.parts.length) return
    let alive = true
    api
      .findSignaturesWithModel(req.parts)
      .then((starts) => {
        if (!starts) return
        modelCache.set(modelKey, modelRanges(starts, req, open))
        if (alive) setModelTick((n) => n + 1)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [base, hideSig, chat, modelOn, modelKey, remote])

  const toggleSignatures = () => {
    setHideSig(!hideSig)
    saveHidden(HIDE_SIG_KEY, !hideSig)
  }
  const toggleHeaders = () => {
    setHideHead(!hideHead)
    saveHidden(HIDE_HEAD_KEY, !hideHead)
  }
  const toggleChat = () => {
    setChat(!chat)
    saveHidden(CHAT_KEY, !chat)
  }
  const startReply = (kind: MailReplyKind) => setReply(kind)

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
        <Button size="small" icon={<ArrowReply20Regular />} disabled={busy || !!reply} onClick={() => startReply('reply')}>
          Antworten
        </Button>
        <Button size="small" icon={<ArrowReplyAll20Regular />} disabled={busy || !!reply} onClick={() => startReply('replyAll')}>
          Allen antworten
        </Button>
        <Button size="small" icon={<ArrowForward20Regular />} disabled={busy || !!reply} onClick={() => startReply('forward')}>
          Weiterleiten
        </Button>
        <div style={{ flex: 1 }} />
        <Tooltip content={chat ? 'Als Mail anzeigen' : 'Als Chat anzeigen'} relationship="label">
          <Button size="small" appearance="subtle" icon={chat ? <DocumentText20Regular /> : <Chat20Regular />} onClick={toggleChat} />
        </Tooltip>
        {!chat && doc.headers > 0 && (
          <Tooltip
            content={`Kopfzeilen der zitierten Nachrichten (Von, Gesendet, An, Betreff) ${hideHead ? 'ausgeblendet. Klicken zeigt sie.' : 'sichtbar. Klicken blendet sie aus.'}`}
            relationship="label"
          >
            <ToggleButton size="small" appearance="subtle" icon={<DocumentHeader20Regular />} checked={hideHead} onClick={toggleHeaders} />
          </Tooltip>
        )}
        {!chat && doc.signatures > 0 && (
          <Tooltip
            content={`${doc.signatures === 1 ? '1 Signatur' : `${doc.signatures} Signaturen`} ${hideSig ? 'ausgeblendet. Klicken zeigt sie.' : 'sichtbar. Klicken blendet sie aus.'}`}
            relationship="label"
          >
            <ToggleButton size="small" appearance="subtle" icon={<Signature20Regular />} checked={hideSig} onClick={toggleSignatures}>
              {doc.signatures}
            </ToggleButton>
          </Tooltip>
        )}
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
        {chat ? (
          (multi && account) || doc.messages > 1 ? (
            <div className="mail-to">
              {multi && account && (
                <span title={account.upn}>
                  <span className="acct-dot" style={{ background: color(account.id) } as CSSProperties} /> {accountTitle(account).name}
                </span>
              )}
              {multi && account && doc.messages > 1 && <span> · </span>}
              {doc.messages > 1 && <span>{doc.messages} Nachrichten</span>}
            </div>
          ) : null
        ) : (
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
        )}
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
      <iframe
        ref={frame}
        className={`mail-body ${dark ? 'dark' : ''} ${chat ? 'chat' : ''}`}
        title="Inhalt der Mail"
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        srcDoc={doc.html}
      />
      {reply ? (
        <MailCompose
          key={reply}
          docked
          state={{ kind: reply, accountId: m.accountId, source: m }}
          accounts={accounts}
          color={color}
          onClose={() => setReply(null)}
          onSent={(x) => {
            setReply(null)
            const list = [...sent, x]
            sentCache.set(key(target), list)
            setSent(list)
            onSent()
          }}
        />
      ) : (
        <div className="reply-bar">
          <button className="reply-start" disabled={busy} onClick={() => startReply('reply')}>
            <ArrowReply20Regular />
            <span>{`Antworten an ${m.from ? addressLabel(m.from) : 'Absender'} …`}</span>
          </button>
          {m.to.length + m.cc.length > 1 && (
            <Tooltip content="Allen antworten" relationship="label">
              <Button appearance="subtle" icon={<ArrowReplyAll20Regular />} disabled={busy} onClick={() => startReply('replyAll')} />
            </Tooltip>
          )}
        </div>
      )}
    </div>
  )
}
