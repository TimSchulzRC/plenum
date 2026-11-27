import { Button, Menu, MenuButton, MenuDivider, MenuItemRadio, MenuList, MenuPopover, MenuTrigger, Spinner, Tooltip } from '@fluentui/react-components'
import { Dismiss16Regular } from '@fluentui/react-icons'
import { useLayoutEffect, useRef, useState } from 'react'
import type { MailSignatures } from '@shared/types'
import { cleanSignature, darkSignature, lightSignature, pastedSignatureHtml } from '../lib/mail-html'
import { useDarkMode } from '../theme'
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

// Eingefügte Bilder werden eingebettete Anhänge, wie das Logo
const MAX_IMAGE = 2_000_000
const dataUrl = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error('Bild nicht lesbar'))
    r.readAsDataURL(f)
  })

// Bearbeitbare Signatur. Was man tippt, bleibt im Feld stehen. Neu gesetzt wird der Inhalt nur, wenn html
// von außen kommt (andere Signatur, Zurücksetzen, neue Fassung aus Outlook) oder das Theme wechselt. Im
// dunklen Theme zeigt das Feld die umgerechneten Farben, html bleibt die helle Fassung, die rausgeht.
function SignatureEditor({ html, onInput }: { html: string; onInput: (html: string) => void }): JSX.Element {
  const dark = useDarkMode()
  const ref = useRef<HTMLDivElement>(null)
  // Was das Feld gerade zeigt: helle Fassung und in welchem Theme
  const shown = useRef<{ html: string; dark: boolean }>(undefined)
  const [blurs, setBlurs] = useState(0)
  // Hintergrund passend zu den Farben im Feld, auch solange ein Theme-Wechsel noch wartet
  const [painted, setPainted] = useState(dark)
  useLayoutEffect(() => {
    const el = ref.current
    const cur = shown.current
    if (!el || (html === cur?.html && dark === cur.dark)) return
    // Nur das Theme wechselt, während man tippt: erst beim Verlassen umstellen, sonst springt der Cursor
    if (cur && html === cur.html && document.activeElement === el) return
    el.innerHTML = dark ? darkSignature(html) : html
    shown.current = { html, dark }
    setPainted(dark)
  }, [html, dark, blurs])
  // Eingefügtes ohne eigene Farben und Stile (pastedSignatureHtml): Es übernimmt die Formatierung der Zeile,
  // sonst verdrehte das Umrechnen zwischen dunkel und hell seine Farben. Links und Bilder bleiben.
  const insert = async (data: DataTransfer) => {
    const html = data.getData('text/html')
    const image = [...data.files].find((f) => /^image\//.test(f.type) && f.size <= MAX_IMAGE)
    const clean = html ? pastedSignatureHtml(html) : image ? `<img src="${await dataUrl(image)}">` : ''
    if (clean) insertHtml(clean)
    else document.execCommand('insertText', false, data.getData('text/plain'))
  }
  // Selbst einfügen statt execCommand('insertHTML'): Chromium gäbe dem Eingefügten Schrift und Größe des
  // Felds als Stil mit, die gingen mit raus
  const insertHtml = (html: string) => {
    const el = ref.current
    const sel = getSelection()
    if (!el || !sel?.rangeCount || !el.contains(sel.getRangeAt(0).commonAncestorContainer)) return
    const range = sel.getRangeAt(0)
    range.deleteContents()
    const frag = range.createContextualFragment(html)
    const last = frag.lastChild
    range.insertNode(frag)
    if (last) {
      range.setStartAfter(last)
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  // Verschieben innerhalb der Signatur macht der Browser selbst, ihr Inhalt ist schon passend
  const dragging = useRef(false)
  return (
    <div
      ref={ref}
      className={`sig-edit${painted ? ' dark' : ''}`}
      role="textbox"
      aria-multiline="true"
      aria-label="Signatur dieser Mail"
      title="Für diese Mail ändern"
      contentEditable
      suppressContentEditableWarning
      onBlur={() => setBlurs((n) => n + 1)}
      onPaste={(e) => {
        e.preventDefault()
        void insert(e.clipboardData)
      }}
      onDragStart={() => (dragging.current = true)}
      onDragEnd={() => (dragging.current = false)}
      onDrop={(e) => {
        if (dragging.current) return
        e.preventDefault()
        const range = document.caretRangeFromPoint(e.clientX, e.clientY)
        if (range) {
          getSelection()?.removeAllRanges()
          getSelection()?.addRange(range)
        }
        void insert(e.dataTransfer)
      }}
      onInput={() => {
        const raw = ref.current?.innerHTML ?? ''
        // Zurückrechnen nach dem Theme, in dem das Feld gerade zu sehen ist
        const wasDark = shown.current?.dark ?? dark
        const now = wasDark ? lightSignature(raw) : raw
        shown.current = { html: now, dark: wasDark }
        onInput(now)
      }}
    />
  )
}
