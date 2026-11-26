import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  Option,
  Switch,
  Textarea
} from '@fluentui/react-components'
import { useState, type CSSProperties } from 'react'
import type { AccountInfo } from '@shared/types'
import { api } from '../api'
import { calendarAccountName, ipcErrorText, localTime as toMs, parseAttendees } from '../lib/calendar'

export interface EventDraft {
  accountId: string
  start: number
  end: number
}

const pad = (n: number) => String(n).padStart(2, '0')
const dateValue = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const timeValue = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
// Neuer Termin in einem Konto. Mit mehreren Konten wählt man oben, in welchem Kalender er landet.
export function NewEventDialog({
  draft,
  accounts,
  color,
  onClose,
  onCreated
}: {
  draft: EventDraft
  accounts: AccountInfo[]
  color: (id: string) => string
  onClose: () => void
  onCreated: (accountId: string) => void
}): JSX.Element {
  const [accountId, setAccountId] = useState(draft.accountId)
  const [subject, setSubject] = useState('')
  const [allDay, setAllDay] = useState(false)
  const [date, setDate] = useState(dateValue(draft.start))
  const [endDate, setEndDate] = useState(dateValue(draft.start))
  const [startTime, setStartTime] = useState(timeValue(draft.start))
  const [endTime, setEndTime] = useState(timeValue(draft.end))
  const [teams, setTeams] = useState(true)
  const [attendees, setAttendees] = useState('')
  const [location, setLocation] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const account = accounts.find((a) => a.id === accountId)
  const parsed = parseAttendees(attendees)
  const start = allDay ? toMs(date) : toMs(date, startTime)
  // Ganztägig: Ende ist Mitternacht nach dem letzten Tag
  const end = allDay ? toMs(endDate, '00:00', 1) : toMs(date, endTime)
  const problem = !subject.trim()
    ? 'Titel fehlt'
    : !(end > start)
      ? 'Das Ende muss nach dem Beginn liegen'
      : parsed.invalid.length
        ? `Keine E-Mail-Adresse: ${parsed.invalid.join(', ')}`
        : account && account.status !== 'ready'
          ? `${calendarAccountName(account)} ist nicht verbunden`
          : undefined

  const onStartTime = (v: string) => {
    // Dauer beibehalten, wie in Teams
    const dur = toMs(date, endTime) - toMs(date, startTime)
    setStartTime(v)
    if (dur > 0) setEndTime(timeValue(toMs(date, v) + dur))
  }

  const save = async () => {
    if (problem || busy) return
    setBusy(true)
    setError(undefined)
    try {
      await api.createEvent(accountId, {
        subject: subject.trim(),
        start,
        end,
        isAllDay: allDay,
        location: location.trim() || undefined,
        attendees: parsed.valid,
        teamsMeeting: teams,
        body: body.trim() || undefined
      })
      onCreated(accountId)
    } catch (e) {
      setError(ipcErrorText(e))
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && !busy && onClose()}>
      <DialogSurface style={{ maxWidth: 520 }}>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <DialogBody>
            <DialogTitle>Neuer Termin</DialogTitle>
            <DialogContent className="new-event">
              {accounts.length > 1 && (
                <Field label="Kalender">
                  <Dropdown
                    value={account ? calendarAccountName(account) : ''}
                    selectedOptions={[accountId]}
                    onOptionSelect={(_e, d) => d.optionValue && setAccountId(d.optionValue)}
                    button={{ children: <AccountLabel a={account} color={color} /> }}
                  >
                    {accounts.map((a) => (
                      <Option key={a.id} value={a.id} text={calendarAccountName(a)} disabled={a.status !== 'ready'}>
                        <AccountLabel a={a} color={color} />
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              )}
              <Field label="Titel" required>
                <Input autoFocus value={subject} onChange={(_e, d) => setSubject(d.value)} placeholder="Titel hinzufügen" />
              </Field>
              <div className="new-event-row">
                <Field label={allDay ? 'Von' : 'Datum'}>
                  <Input type="date" value={date} onChange={(_e, d) => {
                    setDate(d.value)
                    if (d.value > endDate) setEndDate(d.value)
                  }} />
                </Field>
                {allDay ? (
                  <Field label="Bis">
                    <Input type="date" value={endDate} min={date} onChange={(_e, d) => setEndDate(d.value)} />
                  </Field>
                ) : (
                  <>
                    <Field label="Beginn">
                      <Input type="time" step={300} value={startTime} onChange={(_e, d) => onStartTime(d.value)} />
                    </Field>
                    <Field label="Ende">
                      <Input type="time" step={300} value={endTime} onChange={(_e, d) => setEndTime(d.value)} />
                    </Field>
                  </>
                )}
              </div>
              <div className="new-event-row">
                <Switch
                  label="Ganztägig"
                  checked={allDay}
                  onChange={(_e, d) => {
                    setAllDay(d.checked)
                    // Ganztägig ist meist Urlaub oder ein Hinweis, keine Besprechung
                    if (d.checked) setTeams(false)
                  }}
                />
                <Switch label="Teams-Besprechung" checked={teams} onChange={(_e, d) => setTeams(d.checked)} />
              </div>
              <Field label="Teilnehmer" hint={parsed.valid.length ? `${account ? calendarAccountName(account) : 'Das Konto'} verschickt Einladungen an ${parsed.valid.length === 1 ? '1 Person' : `${parsed.valid.length} Personen`}.` : 'E-Mail-Adressen, durch Komma getrennt. Leer lassen für einen Termin nur für dich.'}>
                <Input value={attendees} onChange={(_e, d) => setAttendees(d.value)} placeholder="name@firma.de, …" />
              </Field>
              <Field label="Ort">
                <Input value={location} onChange={(_e, d) => setLocation(d.value)} placeholder="Ort hinzufügen" />
              </Field>
              <Field label="Beschreibung">
                <Textarea value={body} onChange={(_e, d) => setBody(d.value)} resize="vertical" />
              </Field>
              {error && <div className="new-event-error">{error}</div>}
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={onClose}>
                Abbrechen
              </Button>
              <Button type="submit" appearance="primary" disabled={!!problem || busy} title={problem}>
                {busy ? 'Wird gespeichert …' : parsed.valid.length ? 'Senden' : 'Speichern'}
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  )
}

function AccountLabel({ a, color }: { a?: AccountInfo; color: (id: string) => string }): JSX.Element {
  if (!a) return <span>Konto wählen</span>
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
      <span className="acct-dot" style={{ background: color(a.id) } as CSSProperties} />
      <span>{calendarAccountName(a)}</span>
      {a.upn && <span style={{ color: 'var(--fg-3)', fontSize: 12 }}>{a.upn}</span>}
    </span>
  )
}
