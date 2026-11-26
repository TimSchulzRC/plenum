import type {
  AccountInfo,
  AccountSnapshot,
  ActivityItem,
  AppSettings,
  BridgeMessage,
  CalendarEvent,
  CallAction,
  CallLogEntry,
  CallState,
  ChannelThread,
  DebugInfo,
  IncomingCall,
  Message,
  NavigateRequest,
  Person,
  Presence,
  Availability,
  BackgroundList,
  CallDevices,
  TenantInfo,
  UpdateState
} from './types'
import type { McpClient, McpInfo } from './mcp'
import type { AnalyticsProps, FeedbackKind, UiErrorReport } from './analytics'

// Methoden, die die Oberfläche über ipcRenderer.invoke('api', name, ...args) aufruft.
export interface ApiMethods {
  listAccounts(): AccountInfo[]
  addAccount(): string
  removeAccount(accountId: string): void
  // Mandanten, zu denen das Konto gehört (Heimatmandant und Gastzugänge)
  listTenants(accountId: string): TenantInfo[]
  // Gastmandant als eigenen Block in der Chatliste anzeigen, angemeldet über dieses Konto
  addTenant(accountId: string, tenantId: string, tenantName?: string): string
  showLogin(accountId: string): void
  showEngine(accountId: string): void
  reloadAccount(accountId: string): void
  getDebugInfo(accountId: string): DebugInfo
  debugRaw(accountId: string, family: string, url: string, method?: string, body?: unknown): unknown

  getSnapshot(accountId: string): AccountSnapshot | null
  refresh(accountId: string): void
  getMessages(accountId: string, conversationId: string, before?: number): Message[]
  getChannelThreads(accountId: string, teamId: string, channelId: string, before?: number): ChannelThread[]
  getThreadReplies(accountId: string, channelId: string, rootId: string): Message[]
  sendMessage(
    accountId: string,
    conversationId: string,
    html: string,
    opts?: { replyToId?: string; subject?: string; importance?: 'normal' | 'high' | 'urgent' }
  ): Message
  editMessage(accountId: string, conversationId: string, messageId: string, html: string): void
  deleteMessage(accountId: string, conversationId: string, messageId: string): void
  setReaction(accountId: string, conversationId: string, messageId: string, key: string, on: boolean): void
  markRead(accountId: string, conversationId: string, messageId: string): void
  getReadHorizons(accountId: string, conversationId: string): Record<string, number>
  sendTyping(accountId: string, conversationId: string): void
  searchPeople(accountId: string, query: string): Person[]
  getPeople(accountId: string, mris: string[]): Person[]
  getPresence(accountId: string, mris: string[]): Record<string, Presence>
  setMyPresence(accountId: string, availability: Availability | 'Reset'): void
  createChat(accountId: string, mris: string[], topic?: string): string
  // Chat mit der Person im Hauptfenster öffnen (z.B. aus der Profilkarte im Anruf)
  openChatWith(accountId: string, mri: string): void
  reorderFolder(accountId: string, folderId: string, order: string[]): void
  addToFolder(accountId: string, folderId: string, itemId: string, index?: number): void
  removeFromFolder(accountId: string, folderId: string, itemId: string): void
  getCalendar(accountId: string, start: number, end: number): CalendarEvent[]
  getActivity(accountId: string): ActivityItem[]
  markActivityRead(accountId: string): void
  getCallHistory(accountId: string): CallLogEntry[]

  joinMeeting(accountId: string, joinUrl: string, opts: { video: boolean; audio: boolean }): void
  startCall(accountId: string, target: { mris?: string[]; conversationId?: string }, video: boolean): void
  callAction(action: CallAction, arg?: string): void
  getCallState(): CallState | null
  getIncomingCall(): IncomingCall | null
  answerIncoming(call: IncomingCall, mode: 'video' | 'audio' | 'decline'): void
  openCallWindow(): void
  openCallChat(): void
  popoutStream(streamId: string, label: string): void
  setCallCompact(compact: boolean): void
  showCallInTeams(): void
  pickDisplaySource(sourceId: string | null): void
  // macOS: Systemeinstellungen › Bildschirmaufnahme öffnen
  openScreenCaptureSettings(): void
  getBackgrounds(): BackgroundList
  setBackground(id: string): void
  addBackground(): BackgroundList | null
  closeBackgrounds(): void
  getCallDevices(): CallDevices
  setCallDevice(kind: 'camera' | 'mic' | 'speaker' | 'noise', id: string): void

  getSettings(): AppSettings
  setSettings(patch: Partial<AppSettings>): AppSettings
  openExternal(url: string): void
  // Bild aus dem Chat: Kontextmenü zeigen, kopieren oder speichern. x/y: Mausposition im Fenster.
  imageAction(src: string, action: 'menu' | 'copy' | 'save', x: number, y: number): void
  setBadge(count: number): void
  // Systemmitteilungen: Zustand, Testmitteilung, Systemeinstellungen öffnen
  getNotificationStatus(): { supported: boolean; error?: string }
  testNotification(): { ok: boolean; error?: string }
  openNotificationSettings(): void
  closeWindow(): void
  setAlwaysOnTop(on: boolean): void

  getUpdateState(): UpdateState
  checkForUpdates(): UpdateState
  downloadUpdate(): void
  installUpdate(): void

  // Lokaler MCP-Server für Claude Code und Codex
  getMcpInfo(): McpInfo
  setMcpEnabled(on: boolean): McpInfo
  resetMcpToken(): McpInfo
  installMcp(client: McpClient): { ok: boolean; message: string }

  // Nutzungsdaten und Feedback (PostHog). available: die App wurde mit Projektschlüssel gebaut.
  getAnalyticsInfo(): { available: boolean; installId?: string }
  sendFeedback(kind: FeedbackKind, message: string): void
}

export type ApiName = keyof ApiMethods

// Ereignisse vom Hauptprozess an die Oberfläche.
export interface EventMap {
  accounts: AccountInfo[]
  snapshot: AccountSnapshot
  'conversation-updated': { accountId: string; conversationIds: string[] }
  'read-receipts': { accountId: string; conversationIds: string[] }
  presence: { accountId: string; presence: Record<string, Presence> }
  'call-state': CallState | null
  'incoming-call': IncomingCall | null
  bridge: BridgeMessage
  navigate: NavigateRequest
  settings: AppSettings
  'display-sources': { id: string; name: string; thumbnail: string; kind: 'screen' | 'window' }[]
  // Teams hat eine Quelle angefragt, die Liste lädt noch
  'display-sources-loading': true
  // Kurzer Hinweis im Anruffenster, z.B. wenn Teams das Teilen nicht startet
  'call-notice': string
  typing: { accountId: string; conversationId: string; mri: string; name: string }
  'activity-updated': { accountId: string }
  'update-state': UpdateState
  mcp: McpInfo
}

export type EventName = keyof EventMap

export interface TeamsBridge {
  invoke<K extends ApiName>(
    name: K,
    ...args: Parameters<ApiMethods[K]>
  ): Promise<ReturnType<ApiMethods[K]>>
  on<K extends EventName>(event: K, cb: (payload: EventMap[K]) => void): () => void
  bridgeSend(msg: BridgeMessage): void
  // Nutzungsereignis und Fehler der Oberfläche, ohne Antwort
  track(event: string, props?: AnalyticsProps): void
  reportError(report: UiErrorReport): void
  webContentsId: number
  platform: string
  route: string
}
