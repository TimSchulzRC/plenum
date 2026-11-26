import { Button, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, Popover, PopoverSurface, Spinner, SplitButton, ToggleButton, type MenuButtonProps } from '@fluentui/react-components'
import {
  Add20Regular,
  ChevronLeft20Regular,
  ChevronRight20Regular,
  Video20Regular,
  Chat20Regular,
  Location16Regular,
  Person16Regular,
  CalendarToday20Regular,
  CalendarLtr16Regular
} from '@fluentui/react-icons'
import { addDays, startOfWeek, isSameDay } from 'date-fns'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import type { AccountInfo, CalendarEvent } from '@shared/types'
import { api } from '../api'
import { clock, fmt } from '../lib/format'
import { accountTitle } from '@shared/accounts'
import { accountColor, allDayOn, findMeetingChat, ipcErrorText, mergeCalendars, wallHours, type MergedEvent } from '../lib/calendar'
import { useStore } from '../store'
import { NewEventDialog, type EventDraft } from '../components/NewEventDialog'

const HOUR = 48
const HIDDEN_KEY = 'calendar.hiddenAccounts'

type Merged = MergedEvent<CalendarEvent>
type Result = { events?: CalendarEvent[]; error?: string }

function loadHidden(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

// Ein Kalender für alle Konten. Jedes Konto hat eine Farbe, Termine, zu denen mehrere Konten
// eingeladen sind, stehen nur einmal da. Neue Termine landen im gewählten Konto.
export function CalendarView(): JSX.Element {
  // Gastmandanten haben im fremden Mandanten kein Postfach und damit keinen Kalender. Besprechungen
  // dort landen im Kalender des Kontos, zu dem der Gastzugang gehört.
  const all = useStore((s) => s.accounts)
  const accounts = useMemo(() => all.filter((a) => !a.parentId), [all])
  // Ist gerade ein Gastmandant aktiv, zählt sein Konto
  const activeAccountId = useStore((s) => s.accounts.find((a) => a.id === s.activeAccountId)?.parentId ?? s.activeAccountId)
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }))
  const [workWeek, setWorkWeek] = useState(true)
  const [results, setResults] = useState<Record<string, Result>>({})
  const [hidden, setHidden] = useState<string[]>(loadHidden)
  const [open, setOpen] = useState<{ m: Merged; el: HTMLElement } | null>(null)
  const [draft, setDraft] = useState<EventDraft | null>(null)
  const [reload, setReload] = useState(0)
  const [now, setNow] = useState(Date.now())
  const wrap = useRef<HTMLDivElement>(null)
  const days = workWeek ? 5 : 7
  const dayList = useMemo(() => Array.from({ length: days }, (_, i) => addDays(anchor, i)), [anchor, days])

  const ids = useMemo(() => accounts.map((a) => a.id), [accounts])
  const multi = accounts.length > 1
  const color = (id: string) => accountColor(ids, id)
  const byId = (id: string) => accounts.find((a) => a.id === id)
  // Neu laden, wenn ein Konto dazukommt oder fertig verbunden ist
  const statusKey = accounts.map((a) => `${a.id}:${a.status}`).join(',')

  // Neue Woche: alte Termine weg. Bei Statuswechseln bleiben sie stehen, bis die neuen da sind.
  useEffect(() => setResults({}), [anchor])

  useEffect(() => {
    let alive = true
    const load = () => {
      for (const a of useStore.getState().accounts.filter((x) => !x.parentId)) {
        api
          .getCalendar(a.id, anchor.getTime(), addDays(anchor, 7).getTime())
          .then((events) => alive && setResults((r) => ({ ...r, [a.id]: { events } })))
          .catch((e) => alive && setResults((r) => ({ ...r, [a.id]: { ...r[a.id], error: ipcErrorText(e) } })))
      }
    }
    load()
    const t = setInterval(() => {
      setNow(Date.now())
      load()
    }, 60_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [statusKey, anchor, reload])

  useEffect(() => {
    if (wrap.current) wrap.current.scrollTop = HOUR * 7.5
  }, [])

  const toggle = (id: string) => {
    const next = hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id]
    setHidden(next)
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }

  const visible = accounts.filter((a) => !multi || !hidden.includes(a.id))
  const visibleKey = visible.map((a) => a.id).join(',')
  const merged = useMemo(
    () => mergeCalendars(visibleKey.split(',').filter(Boolean).map((id) => ({ accountId: id, events: results[id]?.events ?? [] }))),
    [results, visibleKey]
  )
  const loading = visible.some((a) => !results[a.id])
  const failed = visible.filter((a) => results[a.id]?.error && !results[a.id]?.events)
  const allFailed = visible.length > 0 && failed.length === visible.length

  const cols = `56px repeat(${days}, 1fr)`
  const allDay = merged.filter((m) => m.event.isAllDay)
  const timed = merged.filter((m) => !m.event.isAllDay)

  const layout = (day: Date) => {
    const evs = timed.filter((m) => isSameDay(new Date(m.event.start), day))
    // Überlappungen nebeneinander anordnen
    const placed: { m: Merged; col: number; cols: number }[] = []
    let group: typeof placed = []
    let groupEnd = 0
    const flush = () => {
      const n = Math.max(1, ...group.map((g) => g.col + 1))
      for (const g of group) g.cols = n
      group = []
    }
    for (const m of evs) {
      if (m.event.start >= groupEnd) flush()
      const used = new Set(group.filter((g) => g.m.event.end > m.event.start).map((g) => g.col))
      let col = 0
      while (used.has(col)) col++
      const p = { m, col, cols: 1 }
      group.push(p)
      placed.push(p)
      groupEnd = Math.max(groupEnd, m.event.end)
    }
    flush()
    return placed
  }

  // Konto für Teilnehmen und Chat: das aktive, wenn es eingeladen ist, sonst das erste
  const preferred = (m: Merged) => m.sources.find((s) => s.accountId === activeAccountId) ?? m.sources[0]

  const openChat = (target: { accountId: string; chatId: string }) => {
    // Konto und Chat in einem Schritt, damit „Zurück“ direkt in den Kalender führt
    useStore.getState().open(target.accountId, { chatId: target.chatId, newChat: false }, 'chat')
    setOpen(null)
  }

  // Hat die Kopie eines Kontos keinen Link, gilt der einer anderen Kopie derselben Besprechung
  const joinUrlFor = (m: Merged, accountId: string) =>
    m.sources.find((s) => s.accountId === accountId)?.event.joinUrl || m.sources.find((s) => s.event.joinUrl)?.event.joinUrl

  const join = (m: Merged, accountId: string) => {
    const url = joinUrlFor(m, accountId)
    if (url) void api.joinMeeting(accountId, url, { video: true, audio: true })
    setOpen(null)
  }

  const defaultAccount = () => {
    const ready = accounts.filter((a) => a.status === 'ready')
    return (ready.find((a) => a.id === activeAccountId) ?? ready[0] ?? accounts.find((a) => a.id === activeAccountId) ?? accounts[0])?.id
  }

  const newEvent = (start?: number) => {
    const s = start ?? nextHalfHour()
    // Der Dialog hat ein Datum für Beginn und Ende: ab 23:30 endet der Vorschlag um 23:55
    const lastSlot = new Date(s).setHours(23, 55, 0, 0)
    setDraft({ accountId: defaultAccount() ?? '', start: s, end: Math.min(s + 30 * 60_000, lastSlot) })
  }

  // Doppelklick in eine freie Stelle: Termin ab der angeklickten halben Stunde
  const slotDoubleClick = (day: Date, e: MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains('cal-slot')) return
    const rect = e.currentTarget.getBoundingClientRect()
    const half = Math.max(0, Math.min(47, Math.floor(((e.clientY - rect.top) / HOUR) * 2)))
    const d = new Date(day)
    d.setHours(Math.floor(half / 2), (half % 2) * 30, 0, 0)
    newEvent(d.getTime())
  }

  const eventStyle = (m: Merged): CSSProperties => ({ ['--acct' as string]: color(preferred(m).accountId) })

  const dots = (m: Merged) =>
    multi && (
      <span className="acct-dots" aria-hidden>
        {m.sources.map((s) => (
          <span key={s.accountId} style={{ background: color(s.accountId) }} />
        ))}
      </span>
    )

  return (
    <div className="calendar">
      <div className="cal-toolbar">
        <h1>Kalender</h1>
        <Button size="small" icon={<CalendarToday20Regular />} onClick={() => setAnchor(startOfWeek(new Date(), { weekStartsOn: 1 }))}>
          Heute
        </Button>
        <button className="icon-btn" onClick={() => setAnchor(addDays(anchor, -7))} title="Vorherige Woche">
          <ChevronLeft20Regular />
        </button>
        <button className="icon-btn" onClick={() => setAnchor(addDays(anchor, 7))} title="Nächste Woche">
          <ChevronRight20Regular />
        </button>
        <span className="cal-range">
          {fmt(dayList[0].getTime(), 'd. MMMM')} – {fmt(dayList[days - 1].getTime(), 'd. MMMM yyyy')}
        </span>
        <div style={{ flex: 1 }} />
        <ToggleButton size="small" checked={workWeek} onClick={() => setWorkWeek(!workWeek)}>
          Arbeitswoche
        </ToggleButton>
        <Button size="small" appearance="primary" icon={<Add20Regular />} disabled={!accounts.length} onClick={() => newEvent()}>
          Neuer Termin
        </Button>
      </div>
      {multi && (
        <div className="cal-accounts" role="group" aria-label="Kalender der Konten">
          {accounts.map((a) => {
            const on = !hidden.includes(a.id)
            const r = results[a.id]
            return (
              <button
                key={a.id}
                className={`cal-acct ${on ? 'on' : ''}`}
                style={{ ['--acct' as string]: color(a.id) } as CSSProperties}
                aria-pressed={on}
                title={`${a.upn ?? a.label}${r?.error ? `: ${r.error}` : on ? ' ausblenden' : ' einblenden'}`}
                onClick={() => toggle(a.id)}
              >
                <span className="dot" />
                {accountTitle(a).name}
                {on && r?.error && !r.events && <span className="warn">!</span>}
              </button>
            )
          })}
        </div>
      )}
      {allFailed ? (
        <div className="empty-state">
          <h2>Kalender nicht verfügbar</h2>
          {failed.map((a) => (
            <div key={a.id} style={{ maxWidth: 520 }}>
              {multi ? `${accountTitle(a).name}: ` : ''}
              {results[a.id]?.error}
            </div>
          ))}
          <div style={{ fontSize: 12 }}>Der Kalender wird über die Teams-Web-App geladen. Öffne ihn dort einmal, damit die App die nötige Berechtigung mitliest.</div>
          {failed.map((a) => (
            <Button key={a.id} onClick={() => void api.showEngine(a.id)}>
              Teams-Webansicht öffnen{multi ? ` (${accountTitle(a).name})` : ''}
            </Button>
          ))}
        </div>
      ) : (
        <>
          {failed.length > 0 && (
            <div className="banner cal-banner">
              <span className="grow">Nicht geladen: {failed.map((a) => accountTitle(a).name).join(', ')}. Die übrigen Konten sind zu sehen.</span>
              <Button size="small" onClick={() => setReload((n) => n + 1)}>
                Erneut versuchen
              </Button>
            </div>
          )}
          <div className="cal-head" style={{ gridTemplateColumns: cols }}>
            <div />
            {dayList.map((d) => (
              <div key={d.getTime()} className={isSameDay(d, new Date()) ? 'today' : ''}>
                <div className="day-num">{fmt(d.getTime(), 'd')}</div>
                <div>{fmt(d.getTime(), 'EEEE')}</div>
              </div>
            ))}
          </div>
          {allDay.length > 0 && (
            <div className="allday" style={{ gridTemplateColumns: cols }}>
              <div style={{ fontSize: 11, color: 'var(--fg-3)', padding: 4 }}>Ganztägig</div>
              {dayList.map((d) => (
                <div key={d.getTime()}>
                  {allDay
                    .filter((m) => allDayOn(m.event, d))
                    .map((m) => (
                      <div key={m.key} className={`ev ${multi ? 'acct' : ''}`} style={eventStyle(m)} title={m.event.subject} onClick={(e) => setOpen({ m, el: e.currentTarget })}>
                        {dots(m)}
                        {m.event.subject}
                      </div>
                    ))}
                </div>
              ))}
            </div>
          )}
          <div className="cal-grid-wrap" ref={wrap}>
            {loading && merged.length === 0 && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', justifyContent: 'center', paddingTop: 60, zIndex: 5 }}>
                <Spinner size="small" />
              </div>
            )}
            <div className="cal-body" style={{ gridTemplateColumns: cols }}>
              <div className="cal-hours">
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="cal-hour">
                    {h === 0 ? '' : `${String(h).padStart(2, '0')}:00`}
                  </div>
                ))}
              </div>
              {dayList.map((d) => {
                return (
                  <div key={d.getTime()} className="cal-day" onDoubleClick={(e) => slotDoubleClick(d, e)}>
                    {Array.from({ length: 24 }, (_, h) => (
                      <div key={h} className="cal-slot" />
                    ))}
                    {isSameDay(d, new Date(now)) && <div className="cal-now" style={{ top: wallHours(now) * HOUR }} />}
                    {layout(d).map(({ m, col, cols: n }) => {
                      const ev = m.event
                      const top = wallHours(ev.start) * HOUR
                      const height = Math.max(20, ((ev.end - ev.start) / 3600_000) * HOUR - 2)
                      return (
                        <div
                          key={m.key}
                          className={`cal-event ${multi ? 'acct' : ''} ${ev.isCancelled ? 'cancelled' : ''} ${ev.showAs === 'free' || ev.showAs === 'Free' ? 'free' : ''}`}
                          style={{ ...eventStyle(m), top, height, left: `calc(${(col / n) * 100}% + 2px)`, width: `calc(${100 / n}% - 6px)`, right: 'auto' }}
                          onClick={(e) => setOpen({ m, el: e.currentTarget })}
                        >
                          {dots(m)}
                          <div className="ev-title">{ev.subject}</div>
                          {height > 34 && (
                            <div style={{ color: 'var(--fg-3)' }}>
                              {clock(ev.start)} – {clock(ev.end)}
                              {ev.location ? ` · ${ev.location}` : ''}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
      {open && (
        <Popover open onOpenChange={(_e, d) => !d.open && setOpen(null)} positioning={{ target: open.el, position: 'after' }} withArrow>
          <PopoverSurface style={{ width: 360 }}>
            <EventDetails m={open.m} multi={multi} byId={byId} color={color} />
            <div style={{ display: 'flex', gap: 8 }}>
              {open.m.sources.some((s) => s.event.joinUrl) && <JoinButton m={open.m} preferred={preferred(open.m).accountId} byId={byId} onJoin={(id) => join(open.m, id)} />}
              <ChatButton m={open.m} preferred={preferred(open.m).accountId} onOpen={openChat} />
            </div>
          </PopoverSurface>
        </Popover>
      )}
      {draft && (
        <NewEventDialog
          draft={draft}
          accounts={accounts}
          color={color}
          onClose={() => setDraft(null)}
          onCreated={(accountId) => {
            setDraft(null)
            if (hidden.includes(accountId)) toggle(accountId)
            setReload((n) => n + 1)
          }}
        />
      )}
    </div>
  )
}

function EventDetails({ m, multi, byId, color }: { m: Merged; multi: boolean; byId: (id: string) => AccountInfo | undefined; color: (id: string) => string }): JSX.Element {
  const ev = m.event
  return (
    <>
      <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>{ev.subject}</div>
      <div style={{ fontSize: 13, color: 'var(--fg-2)', marginBottom: 8 }}>
        {ev.isAllDay ? fmt(ev.start, 'EEEE, d. MMMM') : `${fmt(ev.start, 'EEEE, d. MMMM')} · ${clock(ev.start)} – ${clock(ev.end)}`}
      </div>
      {ev.location && (
        <div style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
          <Location16Regular /> {ev.location}
        </div>
      )}
      {ev.organizer && (
        <div style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
          <Person16Regular /> {ev.organizer}
        </div>
      )}
      {multi && (
        <div style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 4 }}>
          <CalendarLtr16Regular style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            {m.sources.map((s) => (
              <div key={s.accountId} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className="acct-dot" style={{ background: color(s.accountId) }} />
                {name(byId(s.accountId))}
              </div>
            ))}
          </div>
        </div>
      )}
      <div style={{ height: 6 }} />
    </>
  )
}

// Besprechungschat: im bevorzugten Konto, sonst in einem anderen eingeladenen, sonst in deren Gastmandanten.
// Hört auf die Snapshots, damit der Knopf erscheint, sobald ein Chat nachgeladen ist.
function ChatButton({ m, preferred, onOpen }: { m: Merged; preferred: string; onOpen: (target: { accountId: string; chatId: string }) => void }): JSX.Element | null {
  const snapshots = useStore((s) => s.snapshots)
  const accounts = useStore((s) => s.accounts)
  const target = findMeetingChat(
    m.sources,
    preferred,
    (id) => accounts.filter((a) => a.parentId === id).map((a) => a.id),
    (id) => snapshots[id]?.chats
  )
  if (!target) return null
  return (
    <Button icon={<Chat20Regular />} onClick={() => onOpen(target)}>
      Chat
    </Button>
  )
}

// Mit mehreren eingeladenen Konten lässt sich wählen, mit welchem man teilnimmt.
function JoinButton({
  m,
  preferred,
  byId,
  onJoin
}: {
  m: Merged
  preferred: string
  byId: (id: string) => AccountInfo | undefined
  onJoin: (accountId: string) => void
}): JSX.Element {
  const main = m.sources.find((s) => s.accountId === preferred) ?? m.sources[0]
  if (m.sources.length < 2) {
    return (
      <Button appearance="primary" icon={<Video20Regular />} onClick={() => onJoin(main.accountId)}>
        Teilnehmen
      </Button>
    )
  }
  return (
    <Menu positioning="below-start">
      <MenuTrigger disableButtonEnhancement>
        {(triggerProps: MenuButtonProps) => (
          <SplitButton appearance="primary" icon={<Video20Regular />} menuButton={triggerProps} primaryActionButton={{ onClick: () => onJoin(main.accountId) }}>
            Teilnehmen
          </SplitButton>
        )}
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {m.sources.map((s) => (
            <MenuItem key={s.accountId} onClick={() => onJoin(s.accountId)}>
              Mit {name(byId(s.accountId))} teilnehmen
            </MenuItem>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  )
}

const name = (a?: AccountInfo) => (a ? accountTitle(a).name : 'Konto')

function nextHalfHour(): number {
  const d = new Date()
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60)
  return d.getTime()
}
