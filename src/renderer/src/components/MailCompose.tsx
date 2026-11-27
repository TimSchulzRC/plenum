import { Button, Dropdown, Field, Input, Option, Textarea } from '@fluentui/react-components'
import { Attach20Regular, Dismiss12Regular, Send20Regular } from '@fluentui/react-icons'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { AccountInfo, MailFile, MailMessage, MailReplyKind } from '@shared/types'
import { api } from '../api'
import { accountTitle } from '@shared/accounts'
import { ipcErrorText, parseAttendees } from '../lib/calendar'
import { addressLabel, fileSize, replyDraft } from '../lib/mail'
import { fmt } from '../lib/format'
import { cleanSignature, signatureForSend } from '../lib/mail-html'
import { defaultSignature, findSignature, useMailSignatures } from '../lib/mail-signatures'
import { ComposeSignature, type SignatureChoice } from './ComposeSignature'

export type ComposeState = { kind: 'new'; accountId: string } | { kind: MailReplyKind; accountId: string; source: MailMessage }
// Was gesendet wurde, damit die Chat-Ansicht die Antwort sofort zeigt
export interface SentMail {
  accountId: string
  to: string[]
  cc: string[]
  text: string
  files: number
  at: number
  // mitgesendete Signatur (HTML)
  signature?: string
}

const TITLES: Record<ComposeState['kind'], string> = { new: 'Neue E-Mail', reply: 'Antworten', replyAll: 'Allen antworten', forward: 'Weiterleiten' }
// Graph nimmt Anhänge direkt nur unter 3 MB, jede Datei in einer eigenen Anfrage
const MAX_BYTES = 3_000_000

function readFile(file: File): Promise<MailFile> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve({ name: file.name, contentType: file.type || 'application/octet-stream', data: String(r.result).replace(/^data:[^,]*,/, '') })
    r.onerror = () => reject(r.error ?? new Error('Datei nicht lesbar'))
    r.readAsDataURL(file)
  })
}

// Verfassen im Lesebereich. Neue Mails wählen das Konto, Antworten bleiben im Konto der Mail.
export function MailCompose({
  state,
  accounts,
  color,
  docked,
  onClose,
  onSent
}: {
  state: ComposeState
  accounts: AccountInfo[]
  color: (id: string) => string
  // Unten im Lesebereich unter dem Verlauf: ohne Betreff und ohne Vorschau der Mail, die steht darüber
  docked?: boolean
  onClose: () => void
  onSent: (sent: SentMail) => void
}): JSX.Element {
  const source = state.kind === 'new' ? undefined : state.source
  const [accountId, setAccountId] = useState(state.accountId)
  const account = accounts.find((a) => a.id === accountId)
  const initial = useMemo(
    () => (source && state.kind !== 'new' ? replyDraft(source, state.kind, account?.upn ? [account.upn] : []) : { to: [], cc: [], subject: '' }),
    // Nur beim Öffnen vorschlagen, spätere Eingaben bleiben
    []
  )
  const [to, setTo] = useState(initial.to.join(', '))
  const [cc, setCc] = useState(initial.cc.join(', '))
  const [showCc, setShowCc] = useState(initial.cc.length > 0)
  const [subject, setSubject] = useState(initial.subject)
  const [text, setText] = useState('')
  const [files, setFiles] = useState<(MailFile & { size: number })[]>([])
  const [busy, setBusy] = useState(false)
  // Dateien werden noch eingelesen: so lange kein Senden, sonst fehlten sie in der Mail
  const [reading, setReading] = useState(0)
  const [error, setError] = useState<string>()
  const picker = useRef<HTMLInputElement>(null)
  // Signatur aus Outlook: der Standard für neue Mails oder für Antworten, für diese Mail änderbar
  const reply = state.kind !== 'new'
  const { sigs, status: sigStatus, retry: retrySigs } = useMailSignatures(accountId, account?.status === 'ready')
  const [sig, setSig] = useState<SignatureChoice>()
  useEffect(() => {
    if (!sigs) {
      // Anderes Konto, dessen Signaturen noch nicht da sind: Die des alten Kontos gilt nicht mehr
      if (sig && sig.accountId !== accountId) setSig(undefined)
      return
    }
    // Erstes Laden, anderes Konto oder noch nichts gewählt: Standard des Kontos, auch wenn er sich
    // beim Abgleich mit Outlook ändert
    if (!sig || sig.accountId !== accountId || (!sig.chosen && !sig.edited)) {
      const d = defaultSignature(sigs, reply)
      const html = d ? cleanSignature(d) : ''
      if (!sig || sig.accountId !== accountId || sig.name !== (d?.name ?? null) || sig.html !== html) {
        setSig({ accountId, name: d?.name ?? null, html, edited: false, chosen: false })
      }
      return
    }
    // In Outlook gelöscht: weg, auch wenn man sie geändert hat. Die Leiste zeigt sie dann nicht mehr.
    const s = findSignature(sigs, sig.name)
    if (!s) {
      if (sig.name) setSig({ ...sig, name: null, html: '', edited: false })
      return
    }
    // Neue Fassung aus Outlook übernehmen, solange man sie nicht geändert hat
    if (sig.edited) return
    const html = cleanSignature(s)
    if (html !== sig.html) setSig({ ...sig, html })
    // Nach Zurücksetzen gilt wieder der aktuelle Standard, auch wenn er sich beim Bearbeiten geändert hat
  }, [sigs, accountId, sig?.chosen, sig?.edited])
  // Noch nie geladen: kurz warten, sonst ginge die erste Mail ohne Signatur raus
  const sigPending = !sigs && sigStatus === 'loading' && account?.status === 'ready'

  const toList = parseAttendees(to)
  const ccList = parseAttendees(cc)
  const big = files.find((f) => f.size > MAX_BYTES)
  const problem = !toList.valid.length && !ccList.valid.length
    ? 'Empfänger fehlt'
    : toList.invalid.length || ccList.invalid.length
      ? `Keine E-Mail-Adresse: ${[...toList.invalid, ...ccList.invalid].join(', ')}`
      : big
        ? `${big.name} ist größer als 3 MB`
        : reading
          ? 'Dateien werden noch gelesen'
          : sigPending
            ? 'Signatur wird noch geladen'
          : account && account.status !== 'ready'
          ? `${accountTitle(account).name} ist nicht verbunden`
          : undefined

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return
    const all = [...list]
    const tooBig = all.filter((f) => f.size > MAX_BYTES)
    if (tooBig.length) setError(`Größer als 3 MB, nicht angehängt: ${tooBig.map((f) => f.name).join(', ')}`)
    const ok = all.filter((f) => f.size <= MAX_BYTES)
    if (!ok.length) return
    setReading((n) => n + 1)
    try {
      const read = await Promise.all(ok.map(async (f) => ({ ...(await readFile(f)), size: f.size })))
      setFiles((cur) => [...cur, ...read])
    } catch (e) {
      setError(ipcErrorText(e))
    } finally {
      setReading((n) => n - 1)
    }
  }

  const send = async () => {
    if (problem || busy) return
    setBusy(true)
    setError(undefined)
    try {
      // Nur was unter dem Text zu sehen ist: Signatur dieses Kontos
      const sigHtml = sig?.name && sig.accountId === accountId ? cleanSignature({ html: sig.html, text: '' }) : ''
      const sent = sigHtml ? signatureForSend(sigHtml) : undefined
      const draft = {
        to: toList.valid,
        cc: ccList.valid,
        subject,
        text,
        signature: sent?.html,
        attachments: [...files.map(({ name, contentType, data }) => ({ name, contentType, data })), ...(sent?.files ?? [])]
      }
      await api.sendMail(accountId, draft, source && state.kind !== 'new' ? { id: source.id, kind: state.kind } : undefined)
      onSent({ accountId, to: draft.to, cc: draft.cc, text, files: files.length, at: Date.now(), signature: sigHtml || undefined })
    } catch (e) {
      setError(ipcErrorText(e))
      setBusy(false)
    }
  }

  return (
    <form
      className={`mail-compose${docked ? ' docked' : ''}`}
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          void send()
        }
      }}
    >
      <div className="mail-actions">
        <Button type="submit" size="small" appearance="primary" icon={<Send20Regular />} disabled={!!problem || busy} title={problem ?? '⌘ Enter'}>
          {busy ? 'Wird gesendet …' : 'Senden'}
        </Button>
        <Button size="small" icon={<Attach20Regular />} disabled={busy} onClick={() => picker.current?.click()}>
          Datei anhängen
        </Button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void addFiles(e.currentTarget.files)
            e.currentTarget.value = ''
          }}
        />
        <div style={{ flex: 1 }} />
        <span className="compose-title">{TITLES[state.kind]}</span>
        <Button size="small" appearance="subtle" disabled={busy} onClick={onClose}>
          Verwerfen
        </Button>
      </div>
      <div className="compose-fields">
        {state.kind === 'new' && accounts.length > 1 ? (
          <Field label="Von" orientation="horizontal">
            <Dropdown
              value={account ? accountTitle(account).name : ''}
              selectedOptions={[accountId]}
              onOptionSelect={(_e, d) => d.optionValue && setAccountId(d.optionValue)}
              button={{ children: <From a={account} color={color} /> }}
            >
              {accounts.map((a) => (
                <Option key={a.id} value={a.id} text={accountTitle(a).name} disabled={a.status !== 'ready'}>
                  <From a={a} color={color} />
                </Option>
              ))}
            </Dropdown>
          </Field>
        ) : (
          accounts.length > 1 && (
            <Field label="Von" orientation="horizontal">
              <div className="compose-from">
                <From a={account} color={color} />
              </div>
            </Field>
          )
        )}
        <Field label="An" orientation="horizontal">
          <Input
            autoFocus={state.kind === 'new' || state.kind === 'forward'}
            value={to}
            onChange={(_e, d) => setTo(d.value)}
            placeholder="name@firma.de, …"
            contentAfter={
              !showCc ? (
                <button type="button" className="link-btn" onClick={() => setShowCc(true)}>
                  Cc
                </button>
              ) : undefined
            }
          />
        </Field>
        {showCc && (
          <Field label="Cc" orientation="horizontal">
            <Input value={cc} onChange={(_e, d) => setCc(d.value)} />
          </Field>
        )}
        {!docked && (
          <Field label="Betreff" orientation="horizontal">
            <Input value={subject} readOnly={state.kind !== 'new'} onChange={(_e, d) => setSubject(d.value)} placeholder="Betreff hinzufügen" />
          </Field>
        )}
        {files.length > 0 && (
          <div className="mail-attachments">
            {files.map((f, i) => (
              <span key={i} className="mail-attachment chip-file">
                <span className="att-name">{f.name}</span>
                <span className="att-size">{fileSize(f.size)}</span>
                <button type="button" className="icon-btn" title="Entfernen" onClick={() => setFiles(files.filter((_x, j) => j !== i))}>
                  <Dismiss12Regular />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="compose-body">
        <Textarea
          className="compose-text"
          autoFocus={state.kind === 'reply' || state.kind === 'replyAll'}
          value={text}
          onChange={(_e, d) => setText(d.value)}
          placeholder={source ? (docked ? 'Deine Antwort. Der bisherige Verlauf kommt automatisch darunter.' : 'Deine Nachricht. Die ursprüngliche Mail hängt die App darunter.') : 'Deine Nachricht'}
          resize="none"
        />
      </div>
      <ComposeSignature sigs={sigs} status={sigStatus} value={sig} onChange={setSig} onRetry={retrySigs} />
      {error && <div className="mail-error">{error}</div>}
      {source && !docked && (
        <div className="compose-quote">
          <div>
            <b>Von:</b> {addressLabel(source.from)} · {fmt(source.received, 'dd.MM.yyyy HH:mm')}
          </div>
          <div>
            <b>Betreff:</b> {source.subject}
          </div>
          <div className="quote-preview">{source.preview}</div>
        </div>
      )}
    </form>
  )
}

function From({ a, color }: { a?: AccountInfo; color: (id: string) => string }): JSX.Element {
  if (!a) return <span>Konto wählen</span>
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
      <span className="acct-dot" style={{ background: color(a.id) } as CSSProperties} />
      <span>{accountTitle(a).name}</span>
      {a.upn && <span style={{ color: 'var(--fg-3)', fontSize: 12 }}>{a.upn}</span>}
    </span>
  )
}
