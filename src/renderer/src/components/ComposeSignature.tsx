import { Button, Menu, MenuButton, MenuDivider, MenuItemRadio, MenuList, MenuPopover, MenuTrigger, Spinner, Tooltip } from '@fluentui/react-components'
import { Dismiss16Regular } from '@fluentui/react-icons'
import { useLayoutEffect, useRef } from 'react'
import type { MailSignatures } from '@shared/types'
import { cleanSignature } from '../lib/mail-html'
import { findSignature, type SignatureStatus } from '../lib/mail-signatures'

// Signatur dieser einen Mail. name null: ohne Signatur. html ist der Stand im Entwurf, edited: von Hand
// geändert, chosen: selbst gewählt (sonst folgt sie dem Standard aus Outlook).
export interface SignatureChoice {
  accountId: string
  name: string | null
  html: string
  edited: boolean
  chosen: boolean
}

const NONE = ''

// Wofür Outlook die Signatur als Standard nimmt
function defaultLabel(sigs: MailSignatures, name: string): string | undefined {
  const forNew = name === sigs.newDefault
  const forReply = name === sigs.replyDefault
  return forNew && forReply ? 'Standard' : forNew ? 'für neue Mails' : forReply ? 'für Antworten' : undefined
}

// Signatur unter dem Text, so wie sie rausgeht: Auswahl aus den Outlook-Signaturen, mit einem Klick weg,
// und für diese Mail direkt bearbeitbar.
export function ComposeSignature({
  sigs,
  status,
  value,
  onChange,
  onRetry
}: {
  sigs?: MailSignatures
  status: SignatureStatus
  value?: SignatureChoice
  onChange: (v: SignatureChoice) => void
  onRetry: () => void
}): JSX.Element {
  if (!sigs) {
    return (
      <div className="compose-signature">
        <div className="sig-bar">
          {status === 'loading' ? (
            <>
              <Spinner size="extra-tiny" />
              <span>Signatur wird aus Outlook geladen …</span>
            </>
          ) : (
            <>
              <span>Signaturen aus Outlook nicht erreichbar.</span>
              <Button size="small" appearance="transparent" onClick={onRetry}>
                Erneut versuchen
              </Button>
            </>
          )}
        </div>
      </div>
    )
  }
  if (!sigs.list.length) {
    return (
      <div className="compose-signature">
        <div className="sig-bar">In Outlook ist keine Signatur hinterlegt.</div>
      </div>
    )
  }
  const current = value?.name ?? null
  const pick = (name: string | null) => {
    if (!value) return
    const s = findSignature(sigs, name)
    onChange({ ...value, name: s ? s.name : null, html: s ? cleanSignature(s) : '', edited: false, chosen: true })
  }
  // Änderungen verwerfen. Gewählt ist sie dadurch nicht: Der Standard folgt weiter Outlook.
  const reset = () => {
    const s = findSignature(sigs, value?.name)
    if (value && s) onChange({ ...value, html: cleanSignature(s), edited: false })
  }
  return (
    <div className="compose-signature">
      <div className="sig-bar">
        <span>Signatur</span>
        <Menu checkedValues={{ sig: [current ?? NONE] }} onCheckedValueChange={(_e, d) => pick(d.checkedItems[0] || null)}>
          <MenuTrigger disableButtonEnhancement>
            <MenuButton size="small" appearance="subtle" disabled={!value}>
              {current ?? 'Keine'}
            </MenuButton>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {sigs.list.map((s) => (
                <MenuItemRadio key={s.name} name="sig" value={s.name}>
                  {s.name}
                  {defaultLabel(sigs, s.name) && <span className="sig-default"> · {defaultLabel(sigs, s.name)}</span>}
                </MenuItemRadio>
              ))}
              <MenuDivider />
              <MenuItemRadio name="sig" value={NONE}>
                Keine Signatur
              </MenuItemRadio>
            </MenuList>
          </MenuPopover>
        </Menu>
        {status === 'loading' && <Spinner size="extra-tiny" title="Wird mit Outlook abgeglichen" />}
        <div style={{ flex: 1 }} />
        {value?.edited && current && (
          <Button size="small" appearance="transparent" onClick={reset}>
            Zurücksetzen
          </Button>
        )}
        {current && (
          <Tooltip content="Ohne Signatur senden" relationship="label">
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => pick(null)} />
          </Tooltip>
        )}
      </div>
      {value && current && <SignatureEditor key={`${value.accountId}:${current}`} html={value.html} onInput={(html) => onChange({ ...value, html, edited: true })} />}
    </div>
  )
}

// Bearbeitbare Signatur. Was man tippt, bleibt im Feld stehen. Neu gesetzt wird der Inhalt nur, wenn html
// von außen kommt (andere Signatur, Zurücksetzen, neue Fassung aus Outlook).
function SignatureEditor({ html, onInput }: { html: string; onInput: (html: string) => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const shown = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || html === shown.current) return
    el.innerHTML = html
    shown.current = html
  }, [html])
  return (
    <div
      ref={ref}
      className="sig-edit"
      role="textbox"
      aria-multiline="true"
      aria-label="Signatur dieser Mail"
      title="Für diese Mail ändern"
      contentEditable
      suppressContentEditableWarning
      onInput={() => {
        const now = ref.current?.innerHTML ?? ''
        shown.current = now
        onInput(now)
      }}
    />
  )
}
