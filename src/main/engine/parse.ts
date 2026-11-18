/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
  ActivityItem,
  ActivityType,
  Attachment,
  CallLogEntry,
  ChatSummary,
  ConversationKind,
  Message,
  MessageKind,
  Reaction
} from '@shared/types'

export function mriFromLink(from: string | undefined): string {
  if (!from) return ''
  const i = from.lastIndexOf('/contacts/')
  if (i >= 0) return decodeURIComponent(from.slice(i + 10))
  const j = from.lastIndexOf('/')
  return j >= 0 && !from.startsWith('8:') ? from.slice(j + 1) : from
}

export function toMs(v: unknown): number {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return v
  const s = String(v)
  if (/^\d+$/.test(s)) return Number(s)
  const t = Date.parse(s)
  return Number.isNaN(t) ? 0 : t
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
export function htmlToText(html: string): string {
  if (!html) return ''
  return html
    .replace(/<(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<img[^>]*\balt="([^"]*)"[^>]*>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isNaN(n) ? m : String.fromCodePoint(n)
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function parseJsonProp(v: unknown): any {
  if (v == null) return undefined
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return undefined
  }
}

function xmlValue(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'))
  return m ? m[1] : undefined
}

export function messageKind(type: string, deleted: boolean): MessageKind {
  if (deleted) return 'deleted'
  if (/^(Text|RichText\/Html|RichText|RichText\/Media_GenericFile|RichText\/UriObject)$/i.test(type)) return 'text'
  if (/^RichText\/Media_Card/i.test(type)) return 'card'
  if (/^Event\/Call/i.test(type) || /CallRecording|CallTranscript/i.test(type)) return 'call'
  if (/^ThreadActivity\//i.test(type)) return 'system'
  return 'unknown'
}

export type NameLookup = (mri: string) => string | undefined

export function systemText(type: string, content: string, names: NameLookup): string {
  const name = (m?: string) => (m ? names(m.trim()) || 'Jemand' : 'Jemand')
  const initiator = xmlValue(content, 'initiator')
  const targets = [...content.matchAll(/<target>([\s\S]*?)<\/target>/gi)].map((m) => m[1])
  switch (type) {
    case 'ThreadActivity/AddMember': {
      const who = targets.map((t) => name(t)).join(', ')
      return initiator ? `${name(initiator)} hat ${who} zum Chat hinzugefügt.` : `${who} wurde hinzugefügt.`
    }
    case 'ThreadActivity/DeleteMember': {
      const who = targets.map((t) => name(t)).join(', ')
      if (initiator && targets.length === 1 && targets[0] === initiator) return `${who} hat den Chat verlassen.`
      return `${name(initiator)} hat ${who} aus dem Chat entfernt.`
    }
    case 'ThreadActivity/MemberJoined':
      return `${targets.map((t) => name(t)).join(', ') || 'Jemand'} ist beigetreten.`
    case 'ThreadActivity/MemberLeft':
      return `${targets.map((t) => name(t)).join(', ') || 'Jemand'} hat den Chat verlassen.`
    case 'ThreadActivity/TopicUpdate':
      return `${name(initiator)} hat den Chatnamen in „${htmlToText(xmlValue(content, 'value') ?? '')}“ geändert.`
    case 'ThreadActivity/PictureUpdate':
      return `${name(initiator)} hat das Gruppenbild geändert.`
    case 'ThreadActivity/HistoryDisclosedUpdate':
      return `${name(initiator)} hat den Chatverlauf freigegeben.`
    case 'ThreadActivity/TabUpdated':
      return 'Eine Registerkarte wurde geändert.'
    default:
      return ''
  }
}

function callText(type: string, content: string): string {
  if (/CallRecording/i.test(type)) return 'Aufzeichnung verfügbar'
  if (/CallTranscript/i.test(type)) return 'Transkript verfügbar'
  if (/<ended\/?>|type="ended"/i.test(content)) {
    const d = xmlValue(content, 'duration')
    const sec = d ? Number(d) : NaN
    if (!Number.isNaN(sec) && sec > 0) {
      const h = Math.floor(sec / 3600)
      const m = Math.floor((sec % 3600) / 60)
      const s = Math.floor(sec % 60)
      return `Anruf beendet · ${h ? h + ' h ' : ''}${m ? m + ' min ' : ''}${s} s`
    }
    return 'Anruf beendet'
  }
  if (/missed|verpasst/i.test(content)) return 'Verpasster Anruf'
  if (/type="started"|<started/i.test(content)) return 'Besprechung gestartet'
  return 'Anruf'
}

function parseReactions(props: any): Reaction[] {
  const em = parseJsonProp(props?.emotions)
  if (!Array.isArray(em)) return []
  return em
    .map((e: any) => ({
      key: String(e.key),
      users: (Array.isArray(e.users) ? e.users : []).map((u: any) => ({ mri: String(u.mri), time: toMs(u.time) }))
    }))
    .filter((r: Reaction) => r.users.length > 0)
}

function parseAttachments(props: any): Attachment[] {
  const out: Attachment[] = []
  const files = parseJsonProp(props?.files)
  if (Array.isArray(files)) {
    for (const f of files) {
      out.push({
        kind: 'file',
        name: f.fileName || f.title || f.fileInfo?.fileName || 'Datei',
        url: f.fileInfo?.fileUrl || f.objectUrl || f.fileInfo?.shareUrl || f.baseUrl,
        fileType: f.fileType || f.type,
        size: f.fileInfo?.fileSize
      })
    }
  }
  return out
}

export function mapChatsvcMessage(raw: any, myMri: string, names: NameLookup): Message {
  const type: string = raw.messagetype || raw.messageType || 'Text'
  const props = raw.properties || {}
  const deleted = !!(props.deletetime || props.deleteTime) || (raw.content === '' && /RichText|Text/.test(type) && !!props.deletetime)
  const from = mriFromLink(raw.from)
  const kind = messageKind(type, deleted)
  const content: string = raw.content ?? ''
  const isHtml = /Html|RichText/i.test(type) || /^<\w/.test(content)
  const html = kind === 'text' || kind === 'card' || kind === 'unknown' ? (isHtml ? content : escapeHtml(content)) : ''
  let parentId: string | undefined
  const link: string = raw.conversationLink || raw.conversationlink || ''
  const pm = link.match(/;messageid=(\d+)/)
  if (pm) parentId = pm[1]
  if (raw.parentMessageId) parentId = String(raw.parentMessageId)
  const time = toMs(raw.composetime || raw.composeTime || raw.originalarrivaltime || raw.originalArrivalTime || raw.id)
  const msg: Message = {
    id: String(raw.id),
    conversationId: String(raw.conversationid || raw.conversationId || raw.containerId || '').replace(/;messageid=\d+$/, ''),
    clientMessageId: raw.clientmessageid || raw.clientMessageId,
    type,
    kind,
    from,
    fromName: raw.imdisplayname || raw.imDisplayName || names(from) || '',
    isMine: !!myMri && from === myMri,
    time,
    editedTime: toMs(props.edittime || props.editTime) || undefined,
    html,
    text: kind === 'text' || kind === 'card' ? htmlToText(content) : '',
    subject: props.subject || undefined,
    importance: props.importance === 'high' ? 'high' : props.importance === 'urgent' ? 'urgent' : undefined,
    reactions: parseReactions(props),
    attachments: parseAttachments(props),
    parentId
  }
  if (kind === 'system') msg.systemText = systemText(type, content, names)
  if (kind === 'call') msg.systemText = callText(type, content)
  if (kind === 'card') {
    const cards = parseJsonProp(props.cards)
    if (Array.isArray(cards) && cards.length > 0 && !msg.text) msg.text = 'Karte'
  }
  return msg
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
}

export function previewText(raw: any): string {
  if (!raw) return ''
  const type: string = raw.messagetype || raw.messageType || ''
  const content: string = raw.content || ''
  if (/^ThreadActivity/i.test(type)) return ''
  if (/^Event\/Call/i.test(type)) return callText(type, content)
  if (/Media_Card/i.test(type)) return 'Karte gesendet'
  const t = htmlToText(content)
  if (!t && /<img/i.test(content)) return 'Bild'
  return t.replace(/\s+/g, ' ').slice(0, 200)
}

export function conversationKind(id: string, tp: any, csa?: any): ConversationKind {
  const pt = String(tp?.productThreadType || '')
  const tt = String(tp?.threadType || csa?.threadType || '')
  if (id.startsWith('48:')) return id === '48:notes' ? 'self' : 'system'
  if (id.includes('@unq.gbl.spaces') || pt === 'OneToOneChat' || csa?.isOneOnOne) return 'oneOnOne'
  if (id.includes('meeting_') || pt === 'Meeting' || csa?.chatType === 'meeting' || tt === 'meeting') return 'meeting'
  if (id.includes('@thread.tacv2') || id.includes('@thread.skype') || /Channel|Space|Topic/i.test(pt) || tt === 'space' || tt === 'topic')
    return 'channel'
  return 'group'
}

// Horizon-Format: "<lastReadMessageId>;<timestamp>;<clientMessageId>"
export function parseHorizon(v: unknown): number {
  if (!v) return 0
  if (typeof v === 'object') {
    const o = v as any
    return toMs(o.originalArrivalTime ?? o.timeStamp ?? 0)
  }
  const first = String(v).split(';')[0]
  return toMs(first)
}

export function mapActivity(raw: any, names: NameLookup): ActivityItem | null {
  const props = raw.properties || {}
  const act = parseJsonProp(props.activity)
  if (!act) return null
  const rawType: string = act.activityType || 'other'
  const sub: string = act.activitySubtype || ''
  const typeMap: Record<string, ActivityType> = {
    mention: 'mention',
    mentionInChat: 'mention',
    teamMention: 'mention',
    channelMention: 'mention',
    tagMention: 'mention',
    reply: 'reply',
    replyToReply: 'reply',
    threadReply: 'reply',
    follow: 'reply',
    reaction: 'reaction',
    reactionInChat: 'reaction',
    like: 'like',
    call: 'call',
    missedCall: 'call',
    callRecording: 'call',
    meetingStarted: 'meeting',
    meetingRecording: 'meeting',
    msGraph: 'other',
    teamMembershipChange: 'membership',
    memberAdded: 'membership',
    addedToTeam: 'membership'
  }
  const type = typeMap[rawType] || 'other'
  const actorName = act.sourceUserImDisplayName || names(act.sourceUserId) || act.sourceAppDisplayName || ''
  const reactionEmoji: Record<string, string> = { like: '👍', heart: '❤️', laugh: '😆', surprised: '😮', sad: '😢', angry: '😡' }
  let title = ''
  switch (rawType) {
    case 'mention':
    case 'mentionInChat':
      title = sub === 'channel' ? 'hat einen Kanal erwähnt' : sub === 'team' ? 'hat ein Team erwähnt' : sub === 'tag' ? 'hat ein Tag erwähnt' : 'hat dich erwähnt'
      break
    case 'reply':
    case 'threadReply':
      title = 'hat auf deinen Beitrag geantwortet'
      break
    case 'replyToReply':
      title = 'hat in einer Unterhaltung geantwortet'
      break
    case 'follow':
      title = sub === 'channelNewMessage' ? 'hat in einem Kanal gepostet, dem du folgst' : 'hat in einer gefolgten Unterhaltung geschrieben'
      break
    case 'reaction':
    case 'reactionInChat':
      title = `hat mit ${reactionEmoji[sub] ?? '👍'} reagiert`
      break
    case 'call':
    case 'missedCall':
      title = sub === 'missedCall' || rawType === 'missedCall' ? 'Verpasster Anruf' : 'Anruf'
      break
    case 'msGraph':
      title = /meeting/i.test(sub) ? 'hat eine Besprechung aktualisiert' : act.sourceAppDisplayName ? `über ${act.sourceAppDisplayName}` : 'Benachrichtigung'
      break
    case 'teamMembershipChange':
    case 'memberAdded':
    case 'addedToTeam':
      title = 'hat dich zu einem Team hinzugefügt'
      break
    default:
      title = 'Neue Aktivität'
  }
  const ctx = act.activityContext || {}
  return {
    id: String(raw.id),
    type,
    rawType,
    time: toMs(act.activityTimestamp || raw.originalarrivaltime || raw.composetime),
    actor: act.sourceUserId,
    actorName,
    title,
    preview: htmlToText(act.messagePreview || ctx.parentMessagePreview || ''),
    location: act.sourceThreadTopic || formatLocation(ctx.location),
    conversationId: act.sourceThreadId,
    messageId: act.sourceReplyChainId ? String(act.sourceReplyChainId) : act.sourceMessageId ? String(act.sourceMessageId) : undefined,
    teamId: ctx.teamId,
    read: false
  }
}

// Kontext-Ort ist bei Besprechungs-Updates ein JSON mit <DateTimeRange>
function formatLocation(v: unknown): string | undefined {
  if (!v) return undefined
  const str = typeof v === 'string' ? v : JSON.stringify(v)
  const start = str.match(/<StartDateTime>([^<]+)<\/StartDateTime>/)
  const end = str.match(/<EndDateTime>([^<]+)<\/EndDateTime>/)
  if (start) {
    const s = new Date(start[1])
    const e = end ? new Date(end[1]) : undefined
    const day = s.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' })
    const t = (d: Date) => d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
    return e ? `${day}, ${t(s)} – ${t(e)}` : `${day}, ${t(s)}`
  }
  if (/^[{[]/.test(str.trim())) return undefined
  return str
}

export function mapCallLog(raw: any, myMri: string): CallLogEntry | null {
  const props = raw.properties || {}
  const cl = parseJsonProp(props['call-log'] || props.callLog)
  if (!cl) return null
  const dir = cl.callDirection === 'incoming' ? 'incoming' : 'outgoing'
  const peer = dir === 'incoming' ? cl.originatorParticipant || { id: cl.originator } : cl.targetParticipant || { id: cl.target }
  const start = toMs(cl.startTime)
  const connect = toMs(cl.connectTime)
  const end = toMs(cl.endTime)
  const state = /accepted/i.test(cl.callState) ? 'accepted' : /missed/i.test(cl.callState) ? 'missed' : /declined/i.test(cl.callState) ? 'declined' : 'unknown'
  return {
    id: String(raw.id),
    time: start || toMs(raw.originalarrivaltime),
    direction: dir,
    state,
    durationSec: connect && end ? Math.round((end - connect) / 1000) : undefined,
    peerMri: peer?.id && peer.id !== myMri ? peer.id : undefined,
    peerName: peer?.displayName,
    callType: cl.callType,
    threadId: cl.threadId
  }
}

export function sortChats(chats: ChatSummary[]): ChatSummary[] {
  return chats.sort((a, b) => b.lastActivity - a.lastActivity)
}
