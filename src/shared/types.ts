// Gemeinsame Typen für Hauptprozess, Preloads und Oberfläche.

export type AccountStatus = 'starting' | 'login-required' | 'connecting' | 'ready' | 'error'

export interface AccountInfo {
  id: string
  label: string
  displayName?: string
  upn?: string
  tenantId?: string
  tenantName?: string
  mri?: string
  status: AccountStatus
  statusDetail?: string
  // Chats mit Punkt in der Chatliste
  unread: number
  // Teams mit ungelesenem Kanalbeitrag
  teamsUnread: number
  activityUnread: number
  presence?: Presence
}

export type Availability =
  | 'Available'
  | 'AvailableIdle'
  | 'Busy'
  | 'BusyIdle'
  | 'DoNotDisturb'
  | 'BeRightBack'
  | 'Away'
  | 'Offline'
  | 'PresenceUnknown'

export interface Presence {
  availability: Availability
  activity?: string
  statusMessage?: string
  outOfOffice?: boolean
}

export interface Person {
  mri: string
  displayName: string
  email?: string
  upn?: string
  jobTitle?: string
  department?: string
  objectId?: string
  type?: 'user' | 'bot' | 'phone' | 'guest'
}

export type ConversationKind = 'oneOnOne' | 'group' | 'meeting' | 'channel' | 'self' | 'system'

export interface MessagePreview {
  id: string
  from: string
  fromName: string
  text: string
  time: number
  isMine: boolean
}

export interface ChatSummary {
  id: string
  kind: ConversationKind
  title: string
  topic?: string
  members: string[]
  memberNames?: Record<string, string>
  memberCount?: number
  lastMessage?: MessagePreview
  lastActivity: number
  unread: boolean
  pinned?: boolean
  muted?: boolean
  hidden?: boolean
  teamId?: string
  meeting?: { joinUrl?: string; start?: number; end?: number }
  consumptionHorizon?: number
}

export interface Reaction {
  key: string
  users: { mri: string; time: number }[]
}

export interface Attachment {
  kind: 'file' | 'image' | 'link'
  name: string
  url?: string
  fileType?: string
  size?: number
  previewUrl?: string
}

export type MessageKind = 'text' | 'system' | 'call' | 'deleted' | 'card' | 'unknown'

export interface Message {
  id: string
  conversationId: string
  clientMessageId?: string
  type: string
  kind: MessageKind
  from: string
  fromName: string
  isMine: boolean
  time: number
  editedTime?: number
  html: string
  text: string
  subject?: string
  importance?: 'normal' | 'high' | 'urgent'
  reactions: Reaction[]
  attachments: Attachment[]
  parentId?: string
  systemText?: string
  pending?: boolean
  failed?: boolean
}

export interface Channel {
  id: string
  teamId: string
  displayName: string
  isGeneral: boolean
  unread: boolean
  lastActivity?: number
  isFavorite?: boolean
  membershipType?: 'standard' | 'private' | 'shared'
  description?: string
}

export interface Team {
  id: string
  displayName: string
  description?: string
  smtpAddress?: string
  pictureETag?: string
  channels: Channel[]
  isArchived?: boolean
  isFavorite?: boolean
  hidden?: boolean
  unread: boolean
}

export interface ChannelThread {
  id: string
  root: Message
  replies: Message[]
  replyCount: number
  lastActivity: number
}

export interface CalendarEvent {
  id: string
  subject: string
  start: number
  end: number
  isAllDay: boolean
  location?: string
  organizer?: string
  organizerEmail?: string
  joinUrl?: string
  isOnlineMeeting: boolean
  isCancelled?: boolean
  showAs?: string
  myResponse?: string
  threadId?: string
  isPrivate?: boolean
}

export type ActivityType = 'mention' | 'reply' | 'reaction' | 'call' | 'meeting' | 'membership' | 'like' | 'other'

export interface ActivityItem {
  id: string
  type: ActivityType
  rawType: string
  time: number
  actor?: string
  actorName?: string
  title: string
  preview: string
  location?: string
  conversationId?: string
  messageId?: string
  teamId?: string
  read: boolean
}

export interface CallLogEntry {
  id: string
  time: number
  direction: 'incoming' | 'outgoing'
  state: 'accepted' | 'missed' | 'declined' | 'unknown'
  durationSec?: number
  peerMri?: string
  peerName?: string
  callType?: string
  threadId?: string
  isVideo?: boolean
}

export interface ChatFolder {
  id: string
  name: string
  type: string
  sort: string
  items: string[]
  expanded?: boolean
}

export interface AccountSnapshot {
  accountId: string
  me?: Person
  chats: ChatSummary[]
  teams: Team[]
  folders: ChatFolder[]
  people: Record<string, Person>
  presence: Record<string, Presence>
  syncedAt: number
}

// ---------- Anrufe ----------

export type CallPhase = 'idle' | 'prejoin' | 'connecting' | 'in-call' | 'lobby' | 'ended'

export interface CallParticipant {
  id: string
  name: string
  muted?: boolean
  speaking?: boolean
  handRaised?: boolean
  isMe?: boolean
  hasVideo?: boolean
  streamId?: string
  // Teams kennzeichnet die Person als extern, Gast oder nicht verifiziert
  external?: boolean
}

export interface CallState {
  accountId: string
  phase: CallPhase
  title: string
  startedAt?: number
  muted: boolean
  cameraOn: boolean
  sharing: boolean
  handRaised: boolean
  participants: CallParticipant[]
  available: Partial<Record<CallAction, boolean>>
  conversationId?: string
  error?: string
}

export type CallAction =
  | 'toggleMute'
  | 'toggleCamera'
  | 'hangup'
  | 'share'
  | 'stopShare'
  | 'raiseHand'
  | 'join'
  | 'toggleChat'
  | 'toggleRoster'
  | 'react'
  | 'cancelJoin'

export interface IncomingCall {
  accountId: string
  id: string
  callerName: string
  callerMri?: string
  isVideo: boolean
  detail?: string
}

export interface MediaStreamInfo {
  streamId: string
  label: string
  kind: 'camera' | 'screen' | 'self'
  width?: number
  height?: number
  speaking?: boolean
  // Teams kennzeichnet die Person hinter dem Stream als extern (aus dem Namen gelesen)
  external?: boolean
}

export type BridgeMessage =
  | { type: 'subscribe'; receiverId: number; streams: string[] | 'all' }
  | { type: 'unsubscribe'; receiverId: number }
  // Empfänger zeigt nur diese Streams an, die Engine kodiert nur sie
  | { type: 'want'; receiverId: number; streams: string[] | 'all' }
  | { type: 'offer'; receiverId: number; sdp: string; mids: Record<string, string> }
  | { type: 'answer'; receiverId: number; sdp: string }
  | { type: 'ice'; receiverId: number; candidate: RTCIceCandidateInit | null; from: 'engine' | 'receiver' }
  | { type: 'streams'; streams: MediaStreamInfo[] }
  // Zuordnung Transceiver-MID -> Stream-ID (nach Aushandlung oder replaceTrack)
  | { type: 'map'; receiverId: number; mids: Record<string, string> }
  // Engine hat die Verbindung verloren, Empfänger soll neu abonnieren
  | { type: 'failed'; receiverId: number }

export interface BackgroundOption {
  id: string
  label: string
  kind: 'none' | 'blur' | 'image'
  selected: boolean
  thumbnail?: string
}

export interface BackgroundList {
  items: BackgroundOption[]
  canUpload: boolean
  error?: string
}

export interface DeviceOption {
  id: string
  label: string
  selected: boolean
}

export interface CallDevices {
  cameras: DeviceOption[]
  mics: DeviceOption[]
  speakers: DeviceOption[]
  noiseSuppression?: boolean
}

export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  notifications: boolean
  notificationSound: boolean
  showMessagePreview: boolean
  activeAccountId?: string
  runAllAccounts: boolean
  compactChatList: boolean
  chatPreviews?: boolean
  preferredCamera?: string
  preferredMic?: string
  preferredSpeaker?: string
  // Videos im Anruf: ganzes Bild zeigen (contain) oder die Kachel füllen (cover)
  callVideoFit?: 'contain' | 'cover'
  // Anonyme Nutzungsdaten und Fehlerberichte senden. undefined: noch nicht gefragt.
  usageData?: boolean
}

export interface NavigateRequest {
  accountId: string
  view: 'chat' | 'teams' | 'activity' | 'calendar' | 'calls' | 'settings'
  conversationId?: string
  teamId?: string
  messageId?: string
}

export interface DebugInfo {
  accountId: string
  endpoints: Record<string, string>
  tokens: { family: string; audience?: string; expires?: number }[]
  url?: string
  seen?: string[]
}

export type UpdateStatus = 'disabled' | 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  // Dev: pnpm run dev oder ein PR-Build, beide ohne Updates.
  channel: 'nightly' | 'stable' | 'dev'
  availableVersion: string | null
  downloadedVersion: string | null
  releaseUrl: string | null
  downloadPercent: number | null
  // Bei status 'error': in welchem Schritt der Fehler auftrat.
  errorContext: 'check' | 'download' | 'install' | null
  message: string | null
  lastChecked: number | null
}
