import { Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, Tooltip } from '@fluentui/react-components'
import {
  MoreHorizontal20Regular,
  Copy20Regular,
  Edit20Regular,
  Delete20Regular,
  Document20Regular,
  Call20Regular,
  Video20Regular,
  Important16Filled,
  TextQuote20Regular
} from '@fluentui/react-icons'
import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Message } from '@shared/types'
import { api } from '../api'
import { clock, messageTime } from '../lib/format'
import { reactionEmoji, renderMessageHtml, REACTIONS } from '../lib/html'
import { PersonAvatar } from './Avatars'
import { openImage } from './ImageViewer'

interface Props {
  msg: Message
  accountId: string
  myMri?: string
  myName?: string
  showHeader: boolean
  names: (mri: string) => string
  onReply?: (m: Message) => void
  onEdit?: (m: Message) => void
  onChanged?: () => void
}

export const MessageBody = memo(function MessageBody({ msg, accountId, myName }: { msg: Message; accountId: string; myName?: string }) {
  const html = useMemo(() => renderMessageHtml(msg.html, accountId, myName), [msg.html, accountId, myName])
  if (msg.kind === 'deleted') return <div className="msg-deleted">Diese Nachricht wurde gelöscht.</div>
  return (
    <>
      {msg.subject && <div className="subject">{msg.subject}</div>}
      {msg.importance && (
        <div style={{ color: 'var(--danger-fg)', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
          <Important16Filled /> {msg.importance === 'urgent' ? 'DRINGEND' : 'WICHTIG'}
        </div>
      )}
      {html ? (
        <div
          dangerouslySetInnerHTML={{ __html: html }}
          onClick={(e) => {
            const target = e.target as HTMLElement
            if (target instanceof HTMLImageElement && target.classList.contains('msg-image')) {
              e.preventDefault()
              openImage(target.currentSrc || target.src)
              return
            }
            const a = target.closest('a')
            if (a?.href) {
              e.preventDefault()
              void api.openExternal(a.href)
              return
            }
            const quote = target.closest<HTMLElement>('.quote[data-mid]')
            if (quote) jumpToMessage(quote.dataset['mid'] ?? '')
          }}
          onContextMenu={(e) => {
            const target = e.target as HTMLElement
            if (!(target instanceof HTMLImageElement) || !target.classList.contains('msg-image')) return
            e.preventDefault()
            void api.imageAction(target.currentSrc || target.src, 'menu', e.clientX, e.clientY)
          }}
        />
      ) : msg.kind === 'card' ? (
        <div style={{ color: 'var(--fg-3)', fontStyle: 'italic' }}>Karte (in Teams anzeigen)</div>
      ) : msg.kind === 'unknown' ? (
        <div style={{ color: 'var(--fg-3)', fontStyle: 'italic' }}>Nicht unterstützter Inhalt ({msg.type})</div>
      ) : null}
      {msg.attachments.length > 0 && (
        <div className="attachments">
          {msg.attachments.map((a, i) => (
            <div key={i} className="attachment" onClick={() => a.url && void api.openExternal(a.url)}>
              <Document20Regular />
              <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
            </div>
          ))}
        </div>
      )}
    </>
  )
})

export function Reactions({ msg, accountId, myMri, names, onChanged }: { msg: Message; accountId: string; myMri?: string; names: (m: string) => string; onChanged?: () => void }): JSX.Element | null {
  if (msg.reactions.length === 0) return null
  return (
    <div className="reactions">
      {msg.reactions.map((r) => {
        const mine = !!myMri && r.users.some((u) => u.mri === myMri)
        const who = r.users.map((u) => (u.mri === myMri ? 'Du' : names(u.mri))).join(', ')
        return (
          <Tooltip key={r.key} content={who} relationship="description">
            <button
              className={`reaction ${mine ? 'mine' : ''}`}
              onClick={() => void api.setReaction(accountId, msg.conversationId, msg.id, r.key, !mine).then(() => onChanged?.())}
            >
              <span>{reactionEmoji(r.key)}</span>
              <span>{r.users.length}</span>
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}

// Zur zitierten Nachricht springen und sie kurz hervorheben
function jumpToMessage(id: string): void {
  if (!id) return
  const row = document.querySelector<HTMLElement>(`.msg-row[data-mid="${CSS.escape(id)}"]`)
  if (!row) return
  row.scrollIntoView({ block: 'center', behavior: 'smooth' })
  row.classList.remove('flash')
  void row.offsetWidth
  row.classList.add('flash')
  setTimeout(() => row.classList.remove('flash'), 1600)
}

// Leiste über der Nachricht. Wird so verschoben, dass sie im sichtbaren Chatbereich bleibt:
// seitlich nach innen, und unter die Nachricht, wenn oben kein Platz ist.
function HoverToolbar({ children }: { children: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const box = el?.closest<HTMLElement>('.messages')
    if (!el || !box) return
    el.style.transform = ''
    el.style.top = ''
    el.classList.remove('below')
    const b = box.getBoundingClientRect()
    const pad = 8
    const col = el.closest('.msg-col')
    if (el.getBoundingClientRect().top < b.top + box.clientTop + pad && col && el.parentElement) {
      // Unter die ganze Nachricht samt Reaktionen, 4px Abstand wie oben
      el.classList.add('below')
      el.style.top = `${Math.round(col.getBoundingClientRect().bottom - el.parentElement.getBoundingClientRect().top + 4)}px`
    }
    const r = el.getBoundingClientRect()
    const left = b.left + box.clientLeft + pad
    const right = b.left + box.clientLeft + box.clientWidth - pad
    let dx = 0
    if (r.right > right) dx = right - r.right
    if (r.left + dx < left) dx = left - r.left
    if (dx) el.style.transform = `translateX(${Math.round(dx)}px)`
  })
  return (
    <div ref={ref} className="msg-toolbar">
      {children}
    </div>
  )
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f|\u20e3|[#*0-9]\ufe0f?\u20e3)+$/u
function isEmojiOnly(msg: Message): boolean {
  if (msg.kind !== 'text' || msg.attachments.length || msg.subject) return false
  const t = msg.text.replace(/\s+/g, '')
  if (!t || t.length > 24) return false
  if (/<img(?![^>]*Emoji)/i.test(msg.html) && !/emoticon|Emoji/i.test(msg.html)) return false
  return EMOJI_ONLY.test(t)
}

export const MessageItem = memo(function MessageItem({ msg, accountId, myMri, myName, showHeader, names, onReply, onEdit, onChanged }: Props) {
  const [hover, setHover] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  if (msg.kind === 'system') {
    return msg.systemText ? <div className="msg-system">{msg.systemText}</div> : null
  }
  if (msg.kind === 'call') {
    return (
      <div style={{ display: 'flex' }}>
        <div className="msg-call">
          {/video/i.test(msg.systemText ?? '') ? <Video20Regular /> : <Call20Regular />}
          <span>{msg.systemText}</span>
          <span style={{ color: 'var(--fg-3)' }}>{clock(msg.time)}</span>
        </div>
      </div>
    )
  }
  const mine = msg.isMine
  const canEdit = mine && !!onEdit && msg.kind === 'text'
  const react = (key: string) => {
    const has = msg.reactions.find((r) => r.key === key)?.users.some((u) => u.mri === myMri)
    void api.setReaction(accountId, msg.conversationId, msg.id, key, !has).then(() => onChanged?.())
  }
  const showToolbar = (hover || menuOpen) && msg.kind !== 'deleted' && !msg.pending
  return (
    <div className={`msg-row ${mine ? 'mine' : ''} ${showHeader ? 'first' : ''}`} data-mid={msg.id}>
      {!mine && <div className="msg-avatar">{showHeader && <PersonAvatar mri={msg.from} name={msg.fromName || names(msg.from)} size={32} />}</div>}
      <div className="msg-col" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        {showHeader && (
          <div className="msg-meta">
            {!mine && <b>{msg.fromName || names(msg.from)}</b>}
            <span title={new Date(msg.time).toLocaleString('de-DE')}>{messageTime(msg.time)}</span>
            {msg.pending && <span>Wird gesendet …</span>}
            {msg.failed && <span style={{ color: 'var(--danger-fg)' }}>Fehler beim Senden</span>}
          </div>
        )}
        <div className={`bubble ${msg.importance ? 'important' : ''} ${msg.reactions.length ? 'has-reactions' : ''} ${isEmojiOnly(msg) ? 'emoji-only' : ''}`} style={msg.pending ? { opacity: 0.6 } : undefined}>
          <MessageBody msg={msg} accountId={accountId} myName={myName} />
          {msg.editedTime && msg.kind !== 'deleted' && <span className="edited">Bearbeitet</span>}
          {showToolbar && (
            <HoverToolbar>
              {REACTIONS.map((r) => (
                <button key={r.key} title={r.label} onClick={() => react(r.key)}>
                  {r.emoji}
                </button>
              ))}
              <span className="sep" />
              {canEdit && (
                <Tooltip content="Bearbeiten" relationship="label">
                  <button className="tool" onClick={() => onEdit(msg)}>
                    <Edit20Regular />
                  </button>
                </Tooltip>
              )}
              {onReply && (
                <Tooltip content="Zitieren" relationship="label">
                  <button className="tool" onClick={() => onReply(msg)}>
                    <TextQuote20Regular />
                  </button>
                </Tooltip>
              )}
              <Menu positioning="below-end" open={menuOpen} onOpenChange={(_e, d) => setMenuOpen(d.open)}>
                <MenuTrigger disableButtonEnhancement>
                  <button className="tool" title="Weitere Optionen">
                    <MoreHorizontal20Regular />
                  </button>
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    {onReply && (
                      <MenuItem icon={<TextQuote20Regular />} onClick={() => onReply(msg)}>
                        Zitieren
                      </MenuItem>
                    )}
                    <MenuItem icon={<Copy20Regular />} onClick={() => void navigator.clipboard.writeText(msg.text)}>
                      Text kopieren
                    </MenuItem>
                    {canEdit && (
                      <MenuItem icon={<Edit20Regular />} onClick={() => onEdit(msg)}>
                        Bearbeiten
                      </MenuItem>
                    )}
                    {mine && (
                      <MenuItem
                        icon={<Delete20Regular />}
                        onClick={() => {
                          if (confirm('Nachricht löschen?')) void api.deleteMessage(accountId, msg.conversationId, msg.id).then(() => onChanged?.())
                        }}
                      >
                        Löschen
                      </MenuItem>
                    )}
                  </MenuList>
                </MenuPopover>
              </Menu>
            </HoverToolbar>
          )}
        </div>
        <Reactions msg={msg} accountId={accountId} myMri={myMri} names={names} onChanged={onChanged} />
      </div>
    </div>
  )
})
