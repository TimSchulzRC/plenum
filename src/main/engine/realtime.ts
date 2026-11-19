/* eslint-disable @typescript-eslint/no-explicit-any */
// Liest Trouter-Frames der Web-App ("3:::{...}" mit einem JSON-Body je Ereignis).
// Ohne Abhängigkeiten, damit node --test die Datei direkt laden kann.

export type RealtimeKind =
  | 'typing'
  | 'read-receipt'
  | 'new-message'
  | 'message-update'
  | 'thread-update'
  | 'conversation-update'
  | 'thread-activity'
  | 'other'

export interface RealtimeEvent {
  kind: RealtimeKind
  conversationId?: string
  // Absender (bei Tippen und Lesebestätigungen)
  from?: string
  name?: string
  clear?: boolean
}

// Konversations-ID aus conversationLink, to oder id
// (".../v1/users/ME/conversations/19%3Aabc%40thread.v2/messages/123" -> "19:abc@thread.v2")
export function conversationOf(resource: any): string | undefined {
  const link = String(resource?.conversationLink || resource?.to || resource?.id || '')
  if (!link) return undefined
  const m = /(?:conversations|threads)\/([^;/?]+)/.exec(link)
  const id = decode(m ? m[1] : link.split(';')[0])
  return /^\d+:/.test(id) ? id : undefined
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function classify(resourceType: string, messageType: string): RealtimeKind {
  switch (resourceType) {
    case 'NewMessage':
      if (/^Control\/(Clear)?Typing/i.test(messageType)) return 'typing'
      if (/^ThreadActivity\/MemberConsumptionHorizonUpdate/i.test(messageType)) return 'read-receipt'
      if (/^ThreadActivity\//i.test(messageType)) return 'thread-activity'
      if (/^Control\//i.test(messageType)) return 'other'
      return 'new-message'
    case 'MessageUpdate':
      return 'message-update'
    case 'ThreadUpdate':
      return 'thread-update'
    case 'ConversationUpdate':
      return 'conversation-update'
    default:
      return 'other'
  }
}

function eventOf(body: any): RealtimeEvent | null {
  if (!body || typeof body !== 'object' || typeof body.resourceType !== 'string') return null
  const resource = body.resource ?? {}
  const messageType = String(resource.messagetype ?? resource.messageType ?? '')
  const kind = classify(body.resourceType, messageType)
  const ev: RealtimeEvent = { kind, conversationId: conversationOf(resource) ?? conversationOf({ id: body.resourceLink }) }
  if (kind === 'typing') {
    const f = /contacts\/(\d+:[^/?]+)/.exec(String(resource.from ?? ''))
    if (f) ev.from = decode(f[1])
    if (typeof resource.imdisplayname === 'string') ev.name = resource.imdisplayname
    ev.clear = /ClearTyping/i.test(messageType)
  }
  // Lesebestätigung: content ist JSON mit dem Leser, {"user":"8:orgid:…","consumptionhorizon":"…"}
  if (kind === 'read-receipt') {
    try {
      const c = typeof resource.content === 'string' ? JSON.parse(resource.content) : resource.content
      if (typeof c?.user === 'string' && c.user) ev.from = c.user
    } catch {
      /* ignore */
    }
  }
  return ev
}

// null: kein lesbarer Trouter-Frame, der Aufrufer fällt auf die einfache Textsuche zurück.
export function parseRealtimeFrame(payload: string): RealtimeEvent[] | null {
  const m = /^3:[^:]*:[^:]*:([\s\S]*)$/.exec(payload)
  if (!m) return null
  let req: any
  try {
    req = JSON.parse(m[1])
  } catch {
    return null
  }
  let body: any = req?.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      return null
    }
  }
  if (!body || typeof body !== 'object') return null
  const list: any[] = Array.isArray(body.eventMessages) ? body.eventMessages : [body]
  const out: RealtimeEvent[] = []
  for (const b of list) {
    const ev = eventOf(b)
    if (ev) out.push(ev)
  }
  return out.length > 0 ? out : null
}
