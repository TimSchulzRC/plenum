import { Button, Popover, PopoverSurface, Spinner, ToggleButton } from '@fluentui/react-components'
import { ChevronLeft20Regular, ChevronRight20Regular, Video20Regular, Chat20Regular, Location16Regular, Person16Regular, CalendarToday20Regular } from '@fluentui/react-icons'
import { addDays, startOfWeek, startOfDay, isSameDay } from 'date-fns'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CalendarEvent } from '@shared/types'
import { api } from '../api'
import { clock, fmt } from '../lib/format'
import { useActive, useStore } from '../store'

const HOUR = 48

export function CalendarView(): JSX.Element {
  const { account, snapshot } = useActive()
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }))
  const [workWeek, setWorkWeek] = useState(true)
  const [events, setEvents] = useState<CalendarEvent[] | null>(null)
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState<{ ev: CalendarEvent; el: HTMLElement } | null>(null)
  const [now, setNow] = useState(Date.now())
  const wrap = useRef<HTMLDivElement>(null)
  const days = workWeek ? 5 : 7
  const dayList = useMemo(() => Array.from({ length: days }, (_, i) => addDays(anchor, i)), [anchor, days])

  useEffect(() => {
    if (!account) return
    let alive = true
    setEvents(null)
    setError(undefined)
    const load = () =>
      api
        .getCalendar(account.id, anchor.getTime(), addDays(anchor, 7).getTime())
        .then((e) => alive && setEvents(e))
        .catch((e: Error) => alive && setError(e.message))
    void load()
    const t = setInterval(() => {
      setNow(Date.now())
      void load()
    }, 60_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [account?.id, anchor])

  useEffect(() => {
    if (wrap.current) wrap.current.scrollTop = HOUR * 7.5
  }, [account?.id])

  const cols = `56px repeat(${days}, 1fr)`
  const allDay = (events ?? []).filter((e) => e.isAllDay)
  const timed = (events ?? []).filter((e) => !e.isAllDay)

  const layout = (day: Date) => {
    const evs = timed.filter((e) => isSameDay(new Date(e.start), day)).sort((a, b) => a.start - b.start || b.end - a.end)
    // Überlappungen nebeneinander anordnen
    const placed: { ev: CalendarEvent; col: number; cols: number }[] = []
    let group: typeof placed = []
    let groupEnd = 0
    const flush = () => {
      const n = Math.max(1, ...group.map((g) => g.col + 1))
      for (const g of group) g.cols = n
      group = []
    }
    for (const ev of evs) {
      if (ev.start >= groupEnd) flush()
      const used = new Set(group.filter((g) => g.ev.end > ev.start).map((g) => g.col))
      let col = 0
      while (used.has(col)) col++
      const p = { ev, col, cols: 1 }
      group.push(p)
      placed.push(p)
      groupEnd = Math.max(groupEnd, ev.end)
    }
    flush()
    return placed
  }

  const openChat = (ev: CalendarEvent) => {
    const chat = snapshot?.chats.find((c) => c.id === ev.threadId || (ev.joinUrl && c.meeting?.joinUrl === ev.joinUrl))
    if (chat) useStore.getState().select({ chatId: chat.id, newChat: false }, 'chat')
  }

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
      </div>
      {error ? (
        <div className="empty-state">
          <h2>Kalender nicht verfügbar</h2>
          <div style={{ maxWidth: 520 }}>{error}</div>
          <div style={{ fontSize: 12 }}>Der Kalender wird über die Teams-Web-App geladen. Öffne ihn dort einmal, damit die App die nötige Berechtigung mitliest.</div>
          {account && (
            <Button onClick={() => void api.showEngine(account.id)}>Teams-Webansicht öffnen</Button>
          )}
        </div>
      ) : (
        <>
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
                    .filter((e) => e.start < addDays(d, 1).getTime() && e.end > d.getTime())
                    .map((e) => (
                      <div key={e.id} className="ev" title={e.subject}>
                        {e.subject}
                      </div>
                    ))}
                </div>
              ))}
            </div>
          )}
          <div className="cal-grid-wrap" ref={wrap}>
            {!events && (
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
                const dayStart = startOfDay(d).getTime()
                return (
                  <div key={d.getTime()} className="cal-day">
                    {Array.from({ length: 24 }, (_, h) => (
                      <div key={h} className="cal-slot" />
                    ))}
                    {isSameDay(d, new Date(now)) && <div className="cal-now" style={{ top: ((now - dayStart) / 3600_000) * HOUR }} />}
                    {layout(d).map(({ ev, col, cols: n }) => {
                      const top = ((ev.start - dayStart) / 3600_000) * HOUR
                      const height = Math.max(20, ((ev.end - ev.start) / 3600_000) * HOUR - 2)
                      return (
                        <div
                          key={ev.id}
                          className={`cal-event ${ev.isCancelled ? 'cancelled' : ''} ${ev.showAs === 'free' || ev.showAs === 'Free' ? 'free' : ''}`}
                          style={{ top, height, left: `calc(${(col / n) * 100}% + 2px)`, width: `calc(${100 / n}% - 6px)`, right: 'auto' }}
                          onClick={(e) => setOpen({ ev, el: e.currentTarget })}
                        >
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
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>{open.ev.subject}</div>
            <div style={{ fontSize: 13, color: 'var(--fg-2)', marginBottom: 8 }}>
              {fmt(open.ev.start, 'EEEE, d. MMMM')} · {clock(open.ev.start)} – {clock(open.ev.end)}
            </div>
            {open.ev.location && (
              <div style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                <Location16Regular /> {open.ev.location}
              </div>
            )}
            {open.ev.organizer && (
              <div style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
                <Person16Regular /> {open.ev.organizer}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              {open.ev.joinUrl && account && (
                <Button
                  appearance="primary"
                  icon={<Video20Regular />}
                  onClick={() => {
                    void api.joinMeeting(account.id, open.ev.joinUrl!, { video: true, audio: true })
                    setOpen(null)
                  }}
                >
                  Teilnehmen
                </Button>
              )}
              {(open.ev.threadId || open.ev.joinUrl) && (
                <Button
                  icon={<Chat20Regular />}
                  onClick={() => {
                    openChat(open.ev)
                    setOpen(null)
                  }}
                >
                  Chat
                </Button>
              )}
            </div>
          </PopoverSurface>
        </Popover>
      )}
    </div>
  )
}
