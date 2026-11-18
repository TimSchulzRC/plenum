import { Popover, PopoverSurface, PopoverTrigger, Tooltip } from '@fluentui/react-components'
import {
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
import type { Message } from '@shared/types'
import { EMOJI_PICKER } from '../lib/html'

export interface ComposerHandle {
  focus(): void
  insertText(t: string): void
  setContent(html: string): void
}

export interface SendPayload {
  html: string
  text: string
  subject?: string
  importance?: 'normal' | 'high' | 'urgent'
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
  const lastTyping = useRef(0)

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
      el.innerHTML = html
      setEmpty(el.innerText.trim() === '')
      el.focus()
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  }))

  const send = async () => {
    const el = editor.current
    if (!el || sending) return
    const text = el.innerText.trim()
    if (!text && !el.querySelector('img')) return
    let html = normalizeHtml(el)
    if (replyTo) {
      const preview = escapeHtml(replyTo.text.slice(0, 200))
      html =
        `<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="${replyTo.id}">` +
        `<strong itemprop="mri" itemid="${replyTo.from}">${escapeHtml(replyTo.fromName)}</strong>` +
        `<span itemprop="time" itemid="${replyTo.id}"></span><p itemprop="preview">${preview}</p></blockquote>` +
        html
    }
    setSending(true)
    try {
      await onSend({ html, text, subject: withSubject && subject.trim() ? subject.trim() : undefined, importance: important ? 'high' : undefined })
      el.innerHTML = ''
      setEmpty(true)
      setSubject('')
      setImportant(false)
      onCancelReply?.()
    } catch (e) {
      alert(`Nachricht konnte nicht gesendet werden: ${(e as Error).message}`)
    } finally {
      setSending(false)
      el.focus()
    }
  }

  return (
    <div className="composer-wrap" style={compact ? { padding: '8px 0 0' } : undefined}>
      <div className="composer">
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
        {withSubject && <input className="subject-input" placeholder="Betreff hinzufügen" value={subject} onChange={(e) => setSubject(e.target.value)} />}
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
            const text = e.clipboardData.getData('text/plain')
            document.execCommand('insertText', false, text)
          }}
        />
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
          <Tooltip content="Als wichtig markieren" relationship="label">
            <button className={`icon-btn ${important ? 'active' : ''}`} onClick={() => setImportant(!important)} style={important ? { color: 'var(--danger)' } : undefined}>
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
          <button className="send-btn" disabled={empty || sending || disabled} onClick={() => void send()} title="Senden (Eingabetaste)">
            {empty ? <Send20Regular /> : <Send20Filled />}
          </button>
        </div>
      </div>
    </div>
  )
})
