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
  Radio,
  RadioGroup,
  Switch,
  Textarea
} from '@fluentui/react-components'
import { useState, type CSSProperties } from 'react'
import type { AccountInfo } from '@shared/types'
import { api } from '../api'
import { accountTitle } from '@shared/accounts'
import { ipcErrorText, localTime as toMs, parseAttendees, planEvents, type OtherAccountsMode } from '../lib/calendar'

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
const name = (a?: AccountInfo) => (a ? accountTitle(a).name : 'Konto')
const names = (list: (AccountInfo | undefined)[]) => list.map(name).join(', ')

// Neuer Termin. Mit mehreren Konten wählt man oben, in welchen Kalendern er landet. Das zuerst gewählte
// Konto legt ihn an und verschickt Einladungen, die weiteren bekommen einen Blocker oder eine Einladung.
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
  onCreated: (accountIds: string[]) => void
}): JSX.Element {
  // In der Reihenfolge der Auswahl, das erste ist der Organisator
  const [accountIds, setAccountIds] = useState(draft.accountId ? [draft.accountId] : [])
  const [others, setOthers] = useState<OtherAccountsMode>('block')
  // Schon angelegt: Scheitert ein Konto, legt der nächste Versuch nur die übrigen an
  const [done, setDone] = useState<string[]>([])
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

  const chosen = accountIds.map((id) => accounts.find((a) => a.id === id))
  const account = chosen[0]
  const extra = chosen.slice(1)
  const notReady = chosen.filter((a) => a && a.status !== 'ready' && !done.includes(a.id))
  const noAddress = others === 'invite' ? extra.filter((a) => !a?.upn) : []
  const parsed = parseAttendees(attendees)
  const invites = parsed.valid.length + (others === 'invite' ? extra.length : 0)
  const start = allDay ? toMs(date) : toMs(date, startTime)
  // Ganztägig: Ende ist Mitternacht nach dem letzten Tag
  // Ende 00:00 heißt Mitternacht am Ende des Tages, etwa nach Ziehen bis zum unteren Rand
  const endAt = (t: string) => toMs(date, t, t === '00:00' ? 1 : 0)
  const end = allDay ? toMs(endDate, '00:00', 1) : endAt(endTime)
  const problem = !subject.trim()
    ? 'Titel fehlt'
    : !(end > start)
      ? 'Das Ende muss nach dem Beginn liegen'
      : parsed.invalid.length
        ? `Keine E-Mail-Adresse: ${parsed.invalid.join(', ')}`
        : !account
          ? 'Kein Kalender gewählt'
          : notReady.length
            ? `${names(notReady)} ${notReady.length === 1 ? 'ist' : 'sind'} nicht verbunden`
            : noAddress.length
              ? `Für ${names(noAddress)} ist keine Adresse bekannt, nur ein Blocker ist möglich`
              : undefined

  const onStartTime = (v: string) => {
    // Dauer beibehalten, wie in Teams
    const dur = endAt(endTime) - toMs(date, startTime)
    setStartTime(v)
    if (dur > 0) setEndTime(timeValue(toMs(date, v) + dur))
  }

  // Kalender wählen: neu gewählte hinten anhängen, damit der Organisator bleibt. Einer bleibt immer.
  const pick = (selected: string[]) => {
    const next = [...accountIds.filter((id) => selected.includes(id)), ...selected.filter((id) => !accountIds.includes(id))]
    if (next.length) setAccountIds(next)
  }

  const save = async () => {
    if (problem || busy) return
    setBusy(true)
    setError(undefined)
    const created = [...done]
    try {
      const plan = planEvents(
        {
          subject: subject.trim(),
          start,
          end,
          isAllDay: allDay,
          location: location.trim() || undefined,
          attendees: parsed.valid,
          teamsMeeting: teams,
          body: body.trim() || undefined
        },
        accountIds,
        others,
        (id) => accounts.find((a) => a.id === id)?.upn
      )
      // Nacheinander: Der Organisator zuerst, damit ein Blocker nie ohne den eigentlichen Termin entsteht
      for (const p of plan) {
        if (created.includes(p.accountId)) continue
        await api.createEvent(p.accountId, p.event)
        created.push(p.accountId)
      }
      onCreated(accountIds)
    } catch (e) {
      setDone(created)
      const ok = created.map((id) => accounts.find((a) => a.id === id))
      setError(ok.length ? `In ${names(ok)} angelegt. ${ipcErrorText(e)}` : ipcErrorText(e))
      setBusy(false)
    }
  }

  // Nach einem Teilerfolg sind die Felder fest, sonst stimmten die Kalender nicht mehr überein
  const locked = busy || done.length > 0
  // Schließen nach einem Teilerfolg lädt den Kalender trotzdem neu
  const close = () => (done.length ? onCreated(done) : onClose())

  return (
    <Dialog open onOpenChange={(_e, d) => !d.open && !busy && close()}>
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
                <Field
                  label="Kalender"
                  hint={
                    extra.length
                      ? others === 'invite'
                        ? `${name(account)} legt den Termin an und lädt ${names(extra)} ein.`
                        : `${name(account)} legt den Termin an. ${names(extra)} ${extra.length === 1 ? 'bekommt' : 'bekommen'} einen Blocker ohne Teilnehmer.`
                      : 'Mehrere Kalender möglich.'
                  }
                >
                  <Dropdown
                    multiselect
                    disabled={locked}
                    value={names(chosen)}
                    selectedOptions={accountIds}
                    onOptionSelect={(_e, d) => pick(d.selectedOptions)}
                    button={{ children: chosen.length === 1 ? <AccountLabel a={account} color={color} /> : <AccountsLabel list={chosen} color={color} /> }}
                  >
                    {accounts.map((a) => (
                      <Option key={a.id} value={a.id} text={accountTitle(a).name} disabled={a.status !== 'ready' && !accountIds.includes(a.id)}>
                        <AccountLabel a={a} color={color} />
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              )}
              {extra.length > 0 && (
                <Field label={extra.length === 1 ? `Im Kalender von ${name(extra[0])}` : 'In den weiteren Kalendern'}>
                  <RadioGroup layout="horizontal" value={others} disabled={locked} onChange={(_e, d) => setOthers(d.value as OtherAccountsMode)}>
                    <Radio value="block" label="Nur blocken" />
                    <Radio value="invite" label="Einladen" />
                  </RadioGroup>
                </Field>
              )}
              <Field label="Titel" required>
                <Input disabled={locked} autoFocus value={subject} onChange={(_e, d) => setSubject(d.value)} placeholder="Titel hinzufügen" />
              </Field>
              <div className="new-event-row">
                <Field label={allDay ? 'Von' : 'Datum'}>
                  <Input disabled={locked} type="date" value={date} onChange={(_e, d) => {
                    setDate(d.value)
                    if (d.value > endDate) setEndDate(d.value)
                  }} />
                </Field>
                {allDay ? (
                  <Field label="Bis">
                    <Input disabled={locked} type="date" value={endDate} min={date} onChange={(_e, d) => setEndDate(d.value)} />
                  </Field>
                ) : (
                  <>
                    <Field label="Beginn">
                      <Input disabled={locked} type="time" step={300} value={startTime} onChange={(_e, d) => onStartTime(d.value)} />
                    </Field>
                    <Field label="Ende">
                      <Input disabled={locked} type="time" step={300} value={endTime} onChange={(_e, d) => setEndTime(d.value)} />
                    </Field>
                  </>
                )}
              </div>
              <div className="new-event-row">
                <Switch
                  disabled={locked}
                  label="Ganztägig"
                  checked={allDay}
                  onChange={(_e, d) => {
                    setAllDay(d.checked)
                    // Ganztägig ist meist Urlaub oder ein Hinweis, keine Besprechung
                    if (d.checked) setTeams(false)
                  }}
                />
                <Switch disabled={locked} label="Teams-Besprechung" checked={teams} onChange={(_e, d) => setTeams(d.checked)} />
              </div>
              <Field label="Teilnehmer" hint={parsed.valid.length ? `${account ? accountTitle(account).name : 'Das Konto'} verschickt Einladungen an ${parsed.valid.length === 1 ? '1 Person' : `${parsed.valid.length} Personen`}.` : 'E-Mail-Adressen, durch Komma getrennt. Leer lassen für einen Termin nur für dich.'}>
                <Input disabled={locked} value={attendees} onChange={(_e, d) => setAttendees(d.value)} placeholder="name@firma.de, …" />
              </Field>
              <Field label="Ort">
                <Input disabled={locked} value={location} onChange={(_e, d) => setLocation(d.value)} placeholder="Ort hinzufügen" />
              </Field>
              <Field label="Beschreibung">
                <Textarea disabled={locked} value={body} onChange={(_e, d) => setBody(d.value)} resize="vertical" />
              </Field>
              {error && <div className="new-event-error">{error}</div>}
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={close}>
                Abbrechen
              </Button>
              <Button type="submit" appearance="primary" disabled={!!problem || busy} title={problem} style={{ whiteSpace: 'nowrap' }}>
                {busy ? 'Wird gespeichert …' : done.length ? 'Erneut versuchen' : invites ? 'Senden' : 'Speichern'}
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
      <span>{accountTitle(a).name}</span>
      {a.upn && <span style={{ color: 'var(--fg-3)', fontSize: 12 }}>{a.upn}</span>}
    </span>
  )
}

// Mehrere Kalender im Auswahlfeld: Punkte in den Kontofarben und die Namen
function AccountsLabel({ list, color }: { list: (AccountInfo | undefined)[]; color: (id: string) => string }): JSX.Element {
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
      <span style={{ display: 'inline-flex', gap: 3 }}>
        {list.map((a) => a && <span key={a.id} className="acct-dot" style={{ background: color(a.id) } as CSSProperties} />)}
      </span>
      <span>{names(list)}</span>
    </span>
  )
}
