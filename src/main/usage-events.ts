// Welche Aufrufe der Oberfläche als Nutzungsereignis zählen und mit welchen Eigenschaften.
// Ohne Electron-Abhängigkeiten, damit `pnpm test` die Zuordnung prüfen kann.
// Eigenschaften enthalten nie Inhalte, Namen, Adressen oder IDs von Unterhaltungen.
import type { ApiMethods, ApiName } from '../shared/ipc'
import type { AnalyticsProps } from '../shared/analytics'

export interface UsageContext {
  // Art der Unterhaltung (oneOnOne, group, meeting, channel …), ohne deren ID
  conversationKind(accountId: string, conversationId: string): string | undefined
}

export interface UsageSpec {
  event: string
  props?: AnalyticsProps
  // Häufige Aufrufe wie die Personensuche beim Tippen: höchstens ein Ereignis je Zeitraum
  throttleMs?: number
  // Ereignis nur, wenn der Aufruf ein Ergebnis hatte (z. B. kein abgebrochener Dateidialog)
  onlyWithResult?: boolean
  // Eigenschaften aus dem Ergebnis, z. B. ob die Testmitteilung ankam
  resultProps?: (result: unknown) => AnalyticsProps
}

type Args<K extends ApiName> = Parameters<ApiMethods[K]>
type Mapper<K extends ApiName> = (args: Args<K>, ctx: UsageContext) => UsageSpec | null

// Nachrichten: nur, was drin ist, nie der Inhalt
export function messageFeatures(html: string): AnalyticsProps {
  return {
    has_images: /<img\b/i.test(html),
    has_quote: /schema\.skype\.com\/Reply/i.test(html),
    has_code: /<(pre|code)\b/i.test(html),
    has_list: /<(ul|ol)\b/i.test(html),
    has_link: /<a\b/i.test(html)
  }
}

// Bildschirm- oder Fensterfreigabe: die ID sagt, welche Art gewählt wurde
export function displaySourceKind(id: string | null): 'screen' | 'window' | 'cancelled' {
  if (!id) return 'cancelled'
  return id.startsWith('screen') ? 'screen' : 'window'
}

// Reaktionen heißen in Teams like, heart, laugh … oder tragen den Emoji-Code. Alles andere fällt weg.
function reactionKey(key: string): string {
  return /^[\w-]{1,40}$/.test(key) ? key : 'other'
}

const MAPPERS: { [K in ApiName]?: Mapper<K> } = {
  addAccount: () => ({ event: 'account_add_started' }),
  removeAccount: () => ({ event: 'account_removed' }),
  showLogin: () => ({ event: 'sign_in_window_opened' }),
  showEngine: () => ({ event: 'web_view_opened' }),
  reloadAccount: () => ({ event: 'account_reconnect_clicked' }),
  getDebugInfo: () => ({ event: 'connection_details_opened' }),

  sendMessage: ([accountId, conversationId, html, opts], ctx) => ({
    event: 'message_sent',
    props: {
      conversation_kind: ctx.conversationKind(accountId, conversationId),
      is_thread_reply: !!opts?.replyToId,
      has_subject: !!opts?.subject,
      importance: opts?.importance ?? 'normal',
      ...messageFeatures(html)
    }
  }),
  editMessage: ([accountId, conversationId], ctx) => ({ event: 'message_edited', props: { conversation_kind: ctx.conversationKind(accountId, conversationId) } }),
  deleteMessage: ([accountId, conversationId], ctx) => ({ event: 'message_deleted', props: { conversation_kind: ctx.conversationKind(accountId, conversationId) } }),
  setReaction: ([accountId, conversationId, , key, on], ctx) => ({
    event: on ? 'reaction_added' : 'reaction_removed',
    props: { reaction: reactionKey(key), conversation_kind: ctx.conversationKind(accountId, conversationId) }
  }),
  searchPeople: () => ({ event: 'people_searched', throttleMs: 60_000 }),
  setMyPresence: ([, availability]) => ({ event: 'presence_changed', props: { availability } }),
  createChat: ([, mris, topic]) => ({ event: 'chat_created', props: { members: mris.length, has_topic: !!topic } }),
  openChatWith: () => ({ event: 'chat_opened_from_call' }),
  reorderFolder: () => ({ event: 'chat_section_changed', props: { action: 'reorder' } }),
  addToFolder: () => ({ event: 'chat_section_changed', props: { action: 'add' } }),
  removeFromFolder: () => ({ event: 'chat_section_changed', props: { action: 'remove' } }),
  markActivityRead: () => ({ event: 'activity_marked_read' }),
  createEvent: ([, ev]) => ({
    event: 'calendar_event_created',
    props: { all_day: ev.isAllDay, teams_meeting: ev.teamsMeeting, attendees: ev.attendees.length, has_location: !!ev.location, has_body: !!ev.body }
  }),

  joinMeeting: () => ({ event: 'meeting_join_clicked' }),
  startCall: ([, target, video]) => ({
    event: 'call_start_clicked',
    props: { video, target: target.conversationId ? 'chat' : 'people', people: target.mris?.length }
  }),
  callAction: ([action, arg]) => ({ event: 'call_action', props: { action, reaction: action === 'react' && arg ? reactionKey(arg) : undefined } }),
  answerIncoming: ([, mode]) => ({ event: 'incoming_call_answered', props: { mode } }),
  popoutStream: () => ({ event: 'call_video_popped_out' }),
  setCallCompact: ([compact]) => ({ event: 'call_compact_view', props: { on: compact } }),
  showCallInTeams: () => ({ event: 'call_opened_in_web_view' }),
  pickDisplaySource: ([sourceId]) => ({ event: 'screen_share_source_picked', props: { kind: displaySourceKind(sourceId) } }),
  openScreenCaptureSettings: () => ({ event: 'screen_capture_settings_opened' }),
  setBackground: () => ({ event: 'call_background_changed' }),
  addBackground: () => ({ event: 'call_background_uploaded', onlyWithResult: true }),
  setCallDevice: ([kind]) => ({ event: 'call_device_changed', props: { kind } }),

  testNotification: () => ({
    event: 'notification_tested',
    resultProps: (r) => {
      const res = r as { ok?: boolean; error?: string } | undefined
      return { ok: !!res?.ok, error: res?.error }
    }
  }),
  setMcpEnabled: ([on]) => ({ event: 'mcp_toggled', props: { on } }),
  installMcp: ([client]) => ({
    event: 'mcp_install_clicked',
    props: { client },
    resultProps: (r) => ({ ok: !!(r as { ok?: boolean } | undefined)?.ok })
  }),
  resetMcpToken: () => ({ event: 'mcp_token_reset' }),
  imageAction: ([, action]) => (action === 'menu' ? null : { event: 'image_action', props: { action } }),
  openNotificationSettings: () => ({ event: 'notification_settings_opened' }),
  checkForUpdates: () => ({ event: 'update_check_clicked' }),
  downloadUpdate: () => ({ event: 'update_download_clicked' }),
  installUpdate: () => ({ event: 'update_install_clicked' })
}

export function usageFor<K extends ApiName>(name: K, args: Args<K>, ctx: UsageContext): UsageSpec | null {
  const mapper = MAPPERS[name] as Mapper<K> | undefined
  return mapper ? mapper(args, ctx) : null
}
