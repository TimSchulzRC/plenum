import { Popover, PopoverSurface, PopoverTrigger, Tooltip } from '@fluentui/react-components'
import {
  Attach20Regular,
  Dismiss12Regular,
  Document20Regular,
  Emoji20Regular,
  Send20Filled,
  Send20Regular,
  TextBold20Regular,
  TextItalic20Regular,
  TextUnderline20Regular,
  Important20Regular,
  Dismiss16Regular,
  Delete20Regular,
  TextBulletListLtr20Regular
} from '@fluentui/react-icons'
import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import type { ChatFile, Message } from '@shared/types'
import { EMOJI_PICKER } from '../lib/html'
import { fileSize } from '../lib/mail'

export interface ComposerHandle {
  focus(): void
  insertText(t: string): void
  setContent(html: string): void
  // Bilder landen im Text, alle anderen Dateien als Anhang
  addFiles(files: File[], at?: { x: number; y: number }): void
}

export interface SendPayload {
  html: string
  text: string
  subject?: string
  importance?: 'normal' | 'high' | 'urgent'
  files: ChatFile[]
}

interface Props {
  placeholder?: string
  onSend: (p: SendPayload) => Promise<void> | void
  onTyping?: () => void
  replyTo?: Message | null
  onCancelReply?: () => void
  withSubject?: boolean
  compact?: boolean
  autoFocus?: boolean
  disabled?: boolean
  onCancel?: () => void
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'])
const MAX_IMAGE_BYTES = 25 * 1024 * 1024

// Teams selbst lässt viel größere Dateien zu. Die Bytes gehen hier aber einmal komplett durch den
// Speicher und über IPC, darum eine Grenze, die das noch verträgt.
const MAX_FILE_BYTES = 250 * 1024 * 1024

type PendingFile = ChatFile & { key: number; size: number }

const isImage = (f: File) => IMAGE_TYPES.has(f.type)

// Dateien aus der Zwischenablage. Bilder nur, wenn sie das Kopierte selbst sind: Word und Excel legen
// neben dem Text ein Bild der Auswahl ab, dann soll der Text ankommen. Andere Dateien (aus dem
// Finder kopiert) kommen immer als Anhang.
function clipboardFiles(data: DataTransfer): File[] {
  const files = [...data.files]
  const others = files.filter((f) => !isImage(f))
  const images = files.filter(isImage)
  if (images.length === 0 || data.types.includes('text/rtf')) return others
  const html = data.getData('text/html')
  if (html && !/<img\b/i.test(html)) return others
  return files
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error('Datei nicht lesbar'))
    r.readAsDataURL(file)
  })
}

// Anzeigegröße im Chat, wie Teams sie mitschickt: höchstens 400 × 300, Seitenverhältnis bleibt
async function imageTag(file: File): Promise<string> {
  const url = await readDataUrl(file)
  const img = new Image()
  img.src = url
  await img.decode().catch(() => undefined)
  const w = img.naturalWidth
  const h = img.naturalHeight
  const scale = w && h ? Math.min(1, 400 / w, 300 / h) : 1
  const size = w && h ? ` width="${Math.max(1, Math.round(w * scale))}" height="${Math.max(1, Math.round(h * scale))}"` : ''
  return `<img src="${url}"${size}>`
}

function normalizeHtml(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement
  // Zeilen aus <div> werden zu <p>
  clone.querySelectorAll('div').forEach((d) => {
    const p = document.createElement('p')
    p.innerHTML = d.innerHTML
    d.replaceWith(p)
  })
  let html = clone.innerHTML.trim()
  html = html.replace(/(<br\s*\/?>\s*)+$/i, '')
  if (!/^<(p|ul|ol|blockquote|pre)/i.test(html)) {
    // Text vor dem ersten Block in <p> fassen
    const firstBlock = html.search(/<(p|ul|ol|blockquote|pre)\b/i)
    if (firstBlock === -1) html = `<p>${html}</p>`
    else html = `<p>${html.slice(0, firstBlock)}</p>${html.slice(firstBlock)}`
  }
  // Links klickbar machen
  html = html.replace(/(^|[\s>])(https?:\/\/[^\s<]+)/g, (_m, pre: string, url: string) => `${pre}<a href="${url}">${url}</a>`)
  return html
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { placeholder = 'Nachricht eingeben', onSend, onTyping, replyTo, onCancelReply, withSubject, compact, autoFocus, disabled, onCancel },
  ref
) {
  const editor = useRef<HTMLDivElement>(null)
  const [empty, setEmpty] = useState(true)
  const [subject, setSubject] = useState('')
  const [important, setImportant] = useState(false)
  const [sending, setSending] = useState(false)
  const [showFormat, setShowFormat] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [files, setFilesState] = useState<PendingFile[]>([])
  // Senden liest die Anhänge direkt nach dem Einlesen, bevor React neu gezeichnet hat
  const filesRef = useRef<PendingFile[]>([])
  const setFiles = (next: PendingFile[] | ((cur: PendingFile[]) => PendingFile[])) => {
    filesRef.current = typeof next === 'function' ? next(filesRef.current) : next
    setFilesState(filesRef.current)
  }
  const picker = useRef<HTMLInputElement>(null)
  const fileKey = useRef(0)
  const lastTyping = useRef(0)
  // Bilder werden erst gelesen, dann eingefügt. Enter direkt danach wartet darauf.
  const inserting = useRef<Promise<void>>(Promise.resolve())
  // Zählt hoch, wenn setContent den Entwurf ersetzt. Ein wartendes Senden bricht dann ab.
  const draftId = useRef(0)

  const addImages = (files: File[], at?: { x: number; y: number }) => {
    const draft = draftId.current
    inserting.current = inserting.current.then(() => insertImages(files, draft, at)).catch((e: Error) => alert(`Bild konnte nicht eingefügt werden: ${e.message}`))
  }

  // Dateien als Anhang einlesen. Senden wartet darauf wie auf eingefügte Bilder.
  const attachFiles = (list: File[]) => {
    if (disabled || list.length === 0) return
    const draft = draftId.current
    const tooBig = list.filter((f) => f.size > MAX_FILE_BYTES)
    if (tooBig.length) alert(`${tooBig.map((f) => f.name).join(', ')}: Dateien dürfen hier höchstens 250 MB groß sein.`)
    const empty = list.filter((f) => f.size === 0)
    if (empty.length) alert(`${empty.map((f) => f.name).join(', ')}: Die Datei ist leer.`)
    const ok = list.filter((f) => f.size > 0 && f.size <= MAX_FILE_BYTES)
    if (ok.length === 0) return
    inserting.current = inserting.current
      .then(async () => {
        const read = await Promise.all(
          ok.map(async (f) => ({ key: ++fileKey.current, name: f.name || 'Datei', contentType: f.type || 'application/octet-stream', size: f.size, data: new Uint8Array(await f.arrayBuffer()) }))
        )
        if (draft !== draftId.current) return
        setFiles((cur) => [...cur, ...read])
      })
      .catch((e: Error) => alert(`Datei konnte nicht angehängt werden: ${e.message}`))
  }

  const addFiles = (list: File[], at?: { x: number; y: number }) => {
    const images = list.filter(isImage)
    if (images.length) addImages(images, at)
    attachFiles(list.filter((f) => !isImage(f)))
  }

  // Bilder an der Schreibmarke einfügen, bei Drag & Drop an der Stelle, wo sie abgelegt wurden
  const insertImages = async (files: File[], draft: number, at?: { x: number; y: number }) => {
    const el = editor.current
    if (!el || disabled || files.length === 0 || draft !== draftId.current) return
    const tooBig = files.filter((f) => f.size > MAX_IMAGE_BYTES)
    if (tooBig.length) alert(`${tooBig.map((f) => f.name || 'Bild').join(', ')}: Bilder dürfen höchstens 25 MB groß sein.`)
    const ok = files.filter((f) => f.size <= MAX_IMAGE_BYTES)
    if (ok.length === 0) return
    const tags = await Promise.all(ok.map(imageTag))
    // Inzwischen wird eine andere Nachricht bearbeitet: Das Bild gehörte zum alten Entwurf
    if (draft !== draftId.current) return
    el.focus()
    const sel = window.getSelection()
    const dropAt = at ? document.caretRangeFromPoint(at.x, at.y) : null
    if (dropAt && el.contains(dropAt.startContainer)) {
      sel?.removeAllRanges()
      sel?.addRange(dropAt)
    } else if (!sel || sel.rangeCount === 0 || !el.contains(sel.getRangeAt(0).startContainer)) {
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
    document.execCommand('insertHTML', false, tags.join(''))
    setEmpty(false)
  }

  useImperativeHandle(ref, () => ({
    focus: () => editor.current?.focus(),
    insertText: (t: string) => {
      editor.current?.focus()
      document.execCommand('insertText', false, t)
      setEmpty(false)
    },
    setContent: (html: string) => {
      const el = editor.current
      if (!el) return
      draftId.current++
      el.innerHTML = html
      setFiles([])
      setEmpty(el.innerText.trim() === '')
      el.focus()
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    },
    addFiles
  }))

  const send = async () => {
    const draftAtEnter = draftId.current
    await inserting.current
    if (draftAtEnter !== draftId.current) return
    const el = editor.current
    if (!el || sending) return
    const text = el.innerText.trim()
    const attached = filesRef.current
    if (!text && !el.querySelector('img') && attached.length === 0) return
    let html = text || el.querySelector('img') ? normalizeHtml(el) : ''
    if (replyTo) {
      const preview = escapeHtml(replyTo.text.slice(0, 200))
      html =
        `<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="${replyTo.id}">` +
        `<strong itemprop="mri" itemid="${replyTo.from}">${escapeHtml(replyTo.fromName)}</strong>` +
        `<span itemprop="time" itemid="${replyTo.id}"></span><p itemprop="preview">${preview}</p></blockquote>` +
        html
    }
    setSending(true)
    // Sofort leeren: Was während des Sendens getippt wird, gehört zur nächsten Nachricht.
    const draft = el.innerHTML
    const draftSubject = subject
    el.innerHTML = ''
    setEmpty(true)
    setSubject('')
    setFiles([])
    try {
      await onSend({
        html,
        text,
        subject: withSubject && showFormat && draftSubject.trim() ? draftSubject.trim() : undefined,
        importance: important ? 'high' : undefined,
        files: attached.map(({ name, contentType, data }) => ({ name, contentType, data }))
      })
      setImportant(false)
      onCancelReply?.()
    } catch (e) {
      // Entwurf zurückholen, vor dem, was inzwischen getippt wurde
      const typed = el.innerText.trim() || el.querySelector('img') ? el.innerHTML : ''
      el.innerHTML = typed ? `${draft}<br>${typed}` : draft
      setFiles((cur) => [...attached, ...cur])
      setEmpty(false)
      setSubject((s) => s || draftSubject)
      alert(`Nachricht konnte nicht gesendet werden: ${(e as Error).message}`)
    } finally {
      setSending(false)
      el.focus()
    }
  }

  return (
    <div className="composer-wrap" style={compact ? { padding: '8px 0 0' } : undefined}>
      <div
        className={`composer ${dropping ? 'drop' : ''}`}
        onDragOver={(e) => {
          if (disabled || !e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDropping(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
        }}
        onDrop={(e) => {
          setDropping(false)
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          e.stopPropagation()
          addFiles([...e.dataTransfer.files], { x: e.clientX, y: e.clientY })
        }}
      >
        {replyTo && (
          <div className="reply-to">
            <div style={{ flex: 1, minWidth: 0 }}>
              <b>{replyTo.fromName}</b>
              <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{replyTo.text}</div>
            </div>
            <button className="icon-btn" style={{ width: 20, height: 20 }} onClick={onCancelReply}>
              <Dismiss16Regular />
            </button>
          </div>
        )}
        {/* Wie in Teams: Der Betreff erscheint erst mit der Formatierung */}
        {withSubject && showFormat && <input className="subject-input" placeholder="Betreff hinzufügen" value={subject} onChange={(e) => setSubject(e.target.value)} />}
        <div
          ref={editor}
          className="editor"
          contentEditable={!disabled}
          suppressContentEditableWarning
          data-placeholder={placeholder}
          autoFocus={autoFocus}
          onInput={() => {
            const el = editor.current
            const isEmpty = !el || (el.innerText.trim() === '' && !el.querySelector('img'))
            if (isEmpty && el) el.innerHTML = ''
            setEmpty(isEmpty)
            if (onTyping && Date.now() - lastTyping.current > 4000) {
              lastTyping.current = Date.now()
              onTyping()
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            } else if (e.metaKey && e.key === 'b') {
              e.preventDefault()
              document.execCommand('bold')
            } else if (e.metaKey && e.key === 'i') {
              e.preventDefault()
              document.execCommand('italic')
            } else if (e.metaKey && e.key === 'u') {
              e.preventDefault()
              document.execCommand('underline')
            } else if (e.key === 'Escape' && replyTo) {
              onCancelReply?.()
            } else if (e.key === 'Escape' && onCancel && empty) {
              onCancel()
            }
          }}
          onPaste={(e) => {
            e.preventDefault()
            const pasted = clipboardFiles(e.clipboardData)
            if (pasted.length) {
              addFiles(pasted)
              return
            }
            const text = e.clipboardData.getData('text/plain')
            document.execCommand('insertText', false, text)
          }}
        />
        {files.length > 0 && (
          <div className="composer-files">
            {files.map((f) => (
              <span key={f.key} className="mail-attachment chip-file">
                <Document20Regular className="file-icon" />
                <span className="att-name" title={f.name}>
                  {f.name}
                </span>
                <span className="att-size">{fileSize(f.size)}</span>
                <button type="button" className="icon-btn" title="Entfernen" onClick={() => setFiles((cur) => cur.filter((x) => x.key !== f.key))}>
                  <Dismiss12Regular />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="tools">
          <Tooltip content="Formatieren" relationship="label">
            <button className={`icon-btn ${showFormat ? 'active' : ''}`} onClick={() => setShowFormat(!showFormat)}>
              <TextBold20Regular />
            </button>
          </Tooltip>
          {showFormat && (
            <>
              <button className="icon-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => document.execCommand('italic')} title="Kursiv">
                <TextItalic20Regular />
              </button>
              <button className="icon-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => document.execCommand('underline')} title="Unterstrichen">
                <TextUnderline20Regular />
              </button>
              <button className="icon-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => document.execCommand('insertUnorderedList')} title="Aufzählung">
                <TextBulletListLtr20Regular />
              </button>
            </>
          )}
          <Popover positioning="above-start" withArrow>
            <PopoverTrigger disableButtonEnhancement>
              <button className="icon-btn" title="Emoji">
                <Emoji20Regular />
              </button>
            </PopoverTrigger>
            <PopoverSurface style={{ padding: 0 }}>
              <div className="emoji-grid">
                {EMOJI_PICKER.map((em) => (
                  <button
                    key={em}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      editor.current?.focus()
                      document.execCommand('insertText', false, em)
                      setEmpty(false)
                    }}
                  >
                    {em}
                  </button>
                ))}
              </div>
            </PopoverSurface>
          </Popover>
          <Tooltip content="Datei anhängen" relationship="label">
            <button className="icon-btn" disabled={disabled} onClick={() => picker.current?.click()}>
              <Attach20Regular />
            </button>
          </Tooltip>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles([...(e.currentTarget.files ?? [])])
              e.currentTarget.value = ''
              editor.current?.focus()
            }}
          />
          <Tooltip content="Als wichtig markieren" relationship="label">
            <button className={`icon-btn ${important ? 'active' : ''}`} onClick={() => setImportant(!important)} style={important ? { color: 'var(--danger-fg)' } : undefined}>
              <Important20Regular />
            </button>
          </Tooltip>
          <div className="grow" />
          {onCancel && (
            <Tooltip content="Verwerfen" relationship="label">
              <button className="icon-btn" onClick={onCancel}>
                <Delete20Regular />
              </button>
            </Tooltip>
          )}
          <button className="send-btn" disabled={(empty && files.length === 0) || sending || disabled} onClick={() => void send()} title="Senden (Eingabetaste)">
            {empty && files.length === 0 ? <Send20Regular /> : <Send20Filled />}
          </button>
        </div>
      </div>
    </div>
  )
})
