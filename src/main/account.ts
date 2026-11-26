/* eslint-disable @typescript-eslint/no-explicit-any */
import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Engine, enginePreloadPath } from './engine/engine'
import { TeamsApi, ApiError, clientMessageId } from './engine/api'
import { amsImageIds, replaceInlineImages } from './engine/ams'
import { contentId, mapAttachment, mapFolder, mapMessage, mapSummary, MAX_ATTACHMENT_BYTES, sortFolders, WELL_KNOWN } from './engine/mail'
import { MailDirectory, mailMatches } from './engine/mail-people'
import {
  conversationKind,
  htmlToText,
  mapActivity,
  mapCallLog,
  mapChatsvcMessage,
  mriFromLink,
  parseHorizon,
  previewText,
  sortChats,
  toMs
} from './engine/parse'
import type {
  AccountInfo,
  AccountSnapshot,
  ActivityItem,
  Availability,
  CalendarEvent,
  NewCalendarEvent,
  MailDraft,
  MailFolder,
  MailFolderKind,
  MailMessage,
  MailPage,
  MailReplyKind,
  CallLogEntry,
  Channel,
  ChannelThread,
  ChatFolder,
  ChatSummary,
  Message,
  MessagePreview,
  Person,
  Presence,
  Team,
  TenantInfo
} from '@shared/types'
import { unreadChats, unreadTeams } from '@shared/badge'
import { log } from './log'
import { analytics } from './analytics'
import { errorSummary } from '@shared/analytics'
import { parseRealtimeFrame } from './engine/realtime'
import { OlderCursors } from './older-cursors'
import { parseTenants } from './tenants'

export interface AccountRecord {
  id: string
  displayName?: string
  upn?: string
  tenantId?: string
  tenantName?: string
  // Gastmandant: läuft als eigenes Konto mit eigener Sitzung, angemeldet über dieses Konto
  parentId?: string
  mri?: string
  createdAt: number
}

export interface NotifyPayload {
  accountId: string
  conversationId: string
  kind: 'chat' | 'channel' | 'activity'
  title: string
  body: string
  senderMri?: string
  teamId?: string
  // Bei kind 'activity': ID des Eintrags im Aktivitäts-Feed
  activityId?: string
}

interface AccountEvents {
  changed: []
  snapshot: [AccountSnapshot]
  'conversation-updated': [string[]]
  // Andere haben in diesen Chats gelesen
  'read-receipts': [string[]]
  presence: [Record<string, Presence>]
  notify: [NotifyPayload]
  typing: [{ conversationId: string; mri: string; name: string }]
  'activity-updated': []
  'record-updated': [AccountRecord]
}

const SYNC_INTERVAL = 12_000
const FULL_SYNC_INTERVAL = 15 * 60_000
const PRESENCE_INTERVAL = 60_000

export class AccountService extends EventEmitter<AccountEvents> {
  readonly engine: Engine
  readonly api: TeamsApi
  chats = new Map<string, ChatSummary>()
  teams: Team[] = []
  folders: ChatFolder[] = []
  folderVersion?: number
  channelIndex = new Map<string, Channel>()
  people = new Map<string, Person>()
  presence = new Map<string, Presence>()
  me?: Person
  activityHorizon = 0
  activityUnread = 0
  private syncStateUrl?: string
  private lastDeltaAt = 0
  private deltaTimer?: NodeJS.Timeout
  private intervalTimer?: NodeJS.Timeout
  private presenceTimer?: NodeJS.Timeout
  private snapshotTimer?: NodeJS.Timeout
  private realtimeTimer?: NodeJS.Timeout
  private receiptTimer?: NodeJS.Timeout
  // Chats mit Echtzeit-Ereignis seit dem letzten deltaSync
  private realtimeConvs = new Set<string>()
  private receiptConvs = new Set<string>()
  private fullSyncAt = 0
  private syncing = false
  private deltaQueue: Promise<void> = Promise.resolve()
  private olderLinks = new OlderCursors()
  private peopleQueue = new Set<string>()
  private unresolvable = new Set<string>()
  private peopleTimer?: NodeJS.Timeout
  private started = false
  private initialSyncDone = false
  private lastActivityId = ''
  // Wann zuletzt eine Chat- oder Kanal-Mitteilung kam, je Unterhaltung. Verhindert, dass dieselbe
  // Nachricht als Erwähnung im Aktivitäts-Feed ein zweites Mal meldet.
  private notifiedAt = new Map<string, number>()
  private csaRetries = 0
  // Gastmandant, dessen Web-App im falschen Mandanten läuft: keine Daten übernehmen
  private wrongTenant = false

  constructor(
    public record: AccountRecord,
    opts: { autoShowLogin: boolean }
  ) {
    super()
    this.engine = new Engine(record.id, enginePreloadPath(), {
      autoShowLogin: opts.autoShowLogin,
      title: [record.displayName || record.upn || 'Microsoft Teams', record.parentId && record.tenantName].filter(Boolean).join(' – '),
      // Nur Gastmandanten bekommen den Mandanten fest vorgegeben, das Hauptkonto startet wie in Teams
      tenantId: record.parentId ? record.tenantId : undefined,
      loginHint: record.parentId ? record.upn : undefined
    })
    this.api = new TeamsApi(this.engine)
    this.loadPeopleCache()
    this.engine.on('status', () => this.emit('changed'))
    this.engine.on('ready', () => {
      this.onReady()
    })
    this.engine.on('realtime', (payload) => this.onRealtime(payload))
  }

  get id(): string {
    return this.record.id
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.engine.start()
  }

  stop(): void {
    clearTimeout(this.deltaTimer)
    clearInterval(this.intervalTimer)
    clearInterval(this.presenceTimer)
    clearTimeout(this.snapshotTimer)
    clearTimeout(this.peopleTimer)
    clearTimeout(this.realtimeTimer)
    clearTimeout(this.receiptTimer)
    this.engine.destroy()
    this.started = false
  }

  info(): AccountInfo {
    return {
      id: this.id,
      label: [this.record.displayName || this.record.upn || 'Neues Konto', this.record.parentId && this.record.tenantName && `(${this.record.tenantName})`].filter(Boolean).join(' '),
      displayName: this.record.displayName,
      upn: this.record.upn,
      tenantId: this.record.tenantId,
      tenantName: this.record.tenantName,
      parentId: this.record.parentId,
      mri: this.record.mri,
      status: this.engine.status,
      statusDetail: this.engine.statusDetail,
      unread: unreadChats(this.chats.values()),
      teamsUnread: unreadTeams(this.teams),
      activityUnread: this.activityUnread,
      presence: this.record.mri ? this.presence.get(this.record.mri) : undefined
    }
  }

  // ---------- Start & Synchronisierung ----------

  // Synchronisierung läuft alle 12 s: ein Ereignis je Art und Konto reicht für eine halbe Stunde
  private trackSyncFailure(kind: 'full' | 'delta', e: unknown): void {
    const status = e instanceof ApiError ? e.status : undefined
    analytics.track('sync_failed', { kind, status, error: errorSummary(e) }, { throttle: { key: `sync-${kind}-${this.id}`, ms: 30 * 60_000 } })
  }

  private onReady(): void {
    const me = this.engine.tokens.me
    // Gastmandant: Die Web-App muss im vorgegebenen Mandanten laufen, sonst zeigte der Block
    // die Chats des Hauptkontos ein zweites Mal
    this.wrongTenant = !!(this.record.parentId && me.tid && this.record.tenantId && me.tid !== this.record.tenantId)
    if (this.wrongTenant) {
      log.warn(`[${this.id}] Web-App läuft nicht im Gastmandanten`)
      this.engine.setStatus('error', `Teams hat ${this.record.tenantName ?? 'den Mandanten'} nicht geöffnet.`)
      return
    }
    if (me.oid) {
      const mri = `8:orgid:${me.oid}`
      const changed = this.record.mri !== mri || this.record.displayName !== me.name || this.record.upn !== me.upn
      this.record = { ...this.record, mri, displayName: me.name || this.record.displayName, upn: me.upn || this.record.upn, tenantId: me.tid || this.record.tenantId }
      this.me = { mri, displayName: me.name || '', upn: me.upn, email: me.upn, objectId: me.oid }
      this.people.set(mri, { ...(this.people.get(mri) ?? {}), ...this.me })
      if (changed) this.emit('record-updated', this.record)
    }
    this.emit('changed')
    void this.fullSync()
    clearInterval(this.intervalTimer)
    this.intervalTimer = setInterval(() => {
      if (Date.now() - this.fullSyncAt > FULL_SYNC_INTERVAL) void this.fullSync()
      else void this.deltaSync()
    }, SYNC_INTERVAL)
    clearInterval(this.presenceTimer)
    this.presenceTimer = setInterval(() => void this.refreshPresence(), PRESENCE_INTERVAL)
  }

  async fullSync(): Promise<void> {
    if (this.syncing || !this.started || this.wrongTenant) return
    this.syncing = true
    try {
      if (this.engine.tokens.has('csa')) {
        const data = await this.api.teamsAndChats()
        if (!this.started) return
        this.applyCsa(data)
      } else {
        log.warn(`[${this.id}] csa noch nicht verfügbar, neuer Versuch in 5 s`)
        if (this.csaRetries++ < 24) setTimeout(() => void this.fullSync(), 5000)
      }
      this.fullSyncAt = Date.now()
      // Basis für inkrementelle Abfragen holen
      await this.deltaSync(true)
      if (!this.started) return
      // Beim ersten Abgleich auch den Namen des Mandanten holen, für die Kopfzeile in der Chatliste
      if (!this.initialSyncDone) void this.listTenants().catch((e: Error) => log.warn(`[${this.id}] Mandanten nicht lesbar`, e.message))
      this.initialSyncDone = true
      void this.refreshPresence()
      void this.refreshActivityCount()
    } catch (e) {
      log.warn(`[${this.id}] fullSync failed`, (e as Error).message)
      this.trackSyncFailure('full', e)
    } finally {
      this.syncing = false
      if (this.started) {
        this.scheduleSnapshot()
        this.emit('changed')
      }
    }
  }

  private applyCsa(data: any): void {
    const myMri = this.record.mri ?? ''
    const pinned = new Set<string>()
    const cf = data?.conversationFolders ?? {}
    if (cf.folderHierarchyVersion) this.folderVersion = cf.folderHierarchyVersion
    const rawFolders: any[] = (cf.conversationFolders ?? []).filter((f: any) => !f.isDeleted)
    for (const f of rawFolders) {
      if (/favorites|pinned/i.test(f.folderType || f.name || '')) {
        for (const it of f.conversationFolderItems ?? []) pinned.add(it.conversationId)
      }
    }
    const order: string[] = cf.conversationFolderOrder ?? []
    rawFolders.sort((a, b) => {
      const ia = order.indexOf(a.id)
      const ib = order.indexOf(b.id)
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
    })
    if (rawFolders.length > 0) {
      this.folders = rawFolders.map((f) => ({
        id: f.id,
        name: f.name,
        type: f.folderType,
        sort: f.sortType,
        expanded: f.isExpanded !== false,
        items: (f.conversationFolderItems ?? []).map((i: any) => i.conversationId)
      }))
    }

    const teams: Team[] = []
    this.channelIndex.clear()
    for (const t of data?.teams ?? []) {
      const channels: Channel[] = (t.channels ?? [])
        .filter((c: any) => !c.isDeleted && c.isMember !== false)
        .map((c: any) => {
          const last = c.lastMessage
          const ch: Channel = {
            id: c.id,
            teamId: t.id,
            displayName: c.isGeneral ? 'Allgemein' : c.displayName,
            isGeneral: !!c.isGeneral,
            unread: c.isMessageRead === false && !!last && last.from !== myMri,
            lastActivity: toMs(last?.originalArrivalTime || last?.composeTime) || undefined,
            isFavorite: c.isFavorite !== false,
            membershipType: c.channelType === 1 ? 'private' : c.channelType === 2 || c.isShared ? 'shared' : 'standard',
            description: c.description || undefined
          }
          this.channelIndex.set(ch.id, ch)
          return ch
        })
        .sort((a: Channel, b: Channel) => (a.isGeneral ? -1 : b.isGeneral ? 1 : a.displayName.localeCompare(b.displayName, 'de')))
      teams.push({
        id: t.id,
        displayName: t.displayName,
        description: t.description || undefined,
        smtpAddress: t.smtpAddress,
        pictureETag: t.pictureETag,
        channels,
        isArchived: !!t.isArchived,
        isFavorite: t.isFavorite,
        hidden: t.isCollapsed === undefined ? false : false,
        unread: channels.some((c) => c.unread && c.isFavorite)
      })
      ;(teams[teams.length - 1] as any).groupId = t.teamSiteInformation?.groupId
    }
    this.teams = teams

    for (const c of data?.chats ?? []) {
      if (c.isConversationDeleted) continue
      let members: string[] = (c.members ?? []).map((m: any) => m.mri).filter((m: string) => m && m !== myMri)
      if (members.length === 0 && /@unq\.gbl\.spaces$/.test(c.id)) members = this.membersFromOneOnOneId(c.id)
      const me = (c.members ?? []).find((m: any) => m.mri === myMri)
      // Teams liefert bei leeren Chats ein lastMessage-Objekt mit lauter null-Feldern
      const last = c.lastMessage && (c.lastMessage.id || c.lastMessage.composeTime) ? c.lastMessage : undefined
      const kind = conversationKind(c.id, null, c)
      const lastTime = toMs(last?.originalArrivalTime || last?.composeTime)
      // Teams sortiert nach der letzten echten Nachricht, Anruf- und Systemereignisse zählen nicht.
      const sortTime = last && countsForSort(last.messageType) ? lastTime : toMs(c.createdAt)
      const prev = this.chats.get(c.id)
      const chat: ChatSummary = {
        id: c.id,
        kind,
        title: '',
        topic: c.title || c.meetingInformation?.subject || undefined,
        members,
        memberCount: (c.members ?? []).length,
        lastMessage: last
          ? {
              id: String(last.id),
              from: last.from || '',
              fromName: last.imDisplayName || '',
              text: previewText(last),
              time: lastTime,
              isMine: last.from === myMri || !!c.isLastMessageFromMe
            }
          : prev?.lastMessage,
        lastActivity: sortTime,
        unread: c.isRead === false && !c.isLastMessageFromMe,
        pinned: pinned.has(c.id),
        muted: !!(c.isMuted || me?.isMuted),
        // Besprechungs-Chats ohne Nachrichten zeigt Teams nicht an
        // Das Feld "hidden" ist bei aktiven Chats oft gesetzt, Teams zeigt sie trotzdem an.
        hidden: c.isEmptyConversation === true && !last,
        meeting: c.meetingInformation
          ? {
              joinUrl: c.meetingInformation.meetingJoinUrl,
              start: toMs(c.meetingInformation.startTime) || undefined,
              end: toMs(c.meetingInformation.endTime) || undefined
            }
          : undefined,
        consumptionHorizon: parseHorizon(c.consumptionHorizon)
      }
      if (last?.from && last.imDisplayName && !this.people.has(last.from)) {
        this.people.set(last.from, { mri: last.from, displayName: last.imDisplayName })
      }
      this.chats.set(c.id, chat)
    }

    for (const f of data?.privateFeeds ?? []) {
      if (f.id === '48:notifications') {
        this.activityHorizon = parseHorizon(f.consumptionHorizon)
      }
      if (f.id === '48:notes' && !this.chats.has('48:notes')) {
        const last = f.lastMessage
        const t = toMs(last?.originalArrivalTime || last?.composeTime)
        this.chats.set('48:notes', {
          id: '48:notes',
          kind: 'self',
          title: '',
          members: [],
          lastMessage: last ? { id: String(last.id), from: myMri, fromName: '', text: previewText(last), time: t, isMine: true } : undefined,
          lastActivity: t,
          unread: false,
          pinned: pinned.has('48:notes')
        })
      }
    }

    for (const u of data?.users ?? []) {
      if (u.mri) this.people.set(u.mri, { ...(this.people.get(u.mri) ?? {}), mri: u.mri, displayName: u.displayName || u.mri, email: u.email, upn: u.userPrincipalName })
    }

    this.queuePeople([...this.chats.values()].flatMap((c) => c.members.slice(0, 8)))
    this.recomputeTitles()
  }

  private applyFolderResponse(cf: any): void {
    if (!cf?.conversationFolders) return
    if (cf.folderHierarchyVersion) this.folderVersion = cf.folderHierarchyVersion
    const order: string[] = cf.conversationFolderOrder ?? this.folders.map((f) => f.id)
    const raw: any[] = cf.conversationFolders.filter((f: any) => !f.isDeleted)
    raw.sort((a, b) => {
      const ia = order.indexOf(a.id)
      const ib = order.indexOf(b.id)
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
    })
    this.folders = raw.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.folderType,
      sort: f.sortType,
      expanded: f.isExpanded !== false,
      items: (f.conversationFolderItems ?? []).map((i: any) => i.conversationId)
    }))
    const fav = this.folders.find((f) => f.type === 'Favorites')
    for (const c of this.chats.values()) c.pinned = !!fav?.items.includes(c.id)
    this.scheduleSnapshot()
  }

  // Ordner-Aktionen wie die Web-App (ReorderItems, AddItem, RemoveItem)
  async folderActions(actions: Record<string, unknown>[]): Promise<void> {
    const send = () =>
      this.api.folderActions({
        folderHierarchyVersion: this.folderVersion,
        supportsAdditionalSystemGeneratedFolders: true,
        supportsSliceItems: true,
        actions
      })
    let res: any
    try {
      res = await send()
    } catch (e) {
      // Version veraltet: Ordner neu laden und einmal wiederholen
      if (e instanceof ApiError && (e.status === 412 || e.status === 409)) {
        const data = await this.api.teamsAndChats()
        this.applyFolderResponse(data?.conversationFolders)
        res = await send()
      } else throw e
    }
    this.applyFolderResponse(res)
  }

  private convToChat(conv: any, prev?: ChatSummary): ChatSummary | null {
    const id: string = conv.id
    const myMri = this.record.mri ?? ''
    const tp = conv.threadProperties ?? {}
    const kind = conversationKind(id, tp)
    if (kind === 'system') return null
    const lm = conv.lastMessage
    const hasMsg = lm && lm.id && !/^Control\//.test(lm.messagetype || '')
    const from = hasMsg ? mriFromLink(lm.from) : ''
    const time = hasMsg ? toMs(lm.originalarrivaltime || lm.composetime) : 0
    const horizon = parseHorizon(conv.properties?.consumptionhorizon)
    const lastMessage: MessagePreview | undefined = hasMsg
      ? { id: String(lm.id), from, fromName: lm.imdisplayname || this.people.get(from)?.displayName || '', text: previewText(lm), time, isMine: from === myMri }
      : prev?.lastMessage
    const lastId = lastMessage ? Number(lastMessage.id) : 0
    const unread = !!lastMessage && !lastMessage.isMine && (horizon ? lastId > horizon : (prev?.unread ?? false)) && !/^ThreadActivity/.test(lm?.messagetype || '')
    return {
      id,
      kind,
      title: prev?.title ?? '',
      topic: tp.topic ? htmlToText(tp.topic) : prev?.topic,
      members: prev?.members ?? [],
      memberCount: tp.membercount ? Number(tp.membercount) : prev?.memberCount,
      lastMessage,
      lastActivity: hasMsg && countsForSort(lm.messagetype) ? Math.max(time, prev?.lastActivity ?? 0) : prev?.lastActivity ?? toMs(tp.createdat),
      unread,
      pinned: prev?.pinned,
      muted: prev?.muted,
      // Anrufereignisse machen einen leeren Besprechungs-Chat sichtbar (wie in Teams), Systemmeldungen nicht
      hidden: prev
        ? prev.hidden && !(hasMsg && !/^(ThreadActivity\/|Control\/)/i.test(lm.messagetype || ''))
        : !hasMsg && kind !== 'oneOnOne' && kind !== 'self',
      meeting: prev?.meeting,
      consumptionHorizon: horizon || prev?.consumptionHorizon
    }
  }

  // Abfragen nacheinander: Überholt eine ältere Antwort eine neuere, setzt sie lastMessage und
  // syncStateUrl zurück, und die nächste Abfrage meldet dieselbe Nachricht noch einmal.
  deltaSync(initial = false): Promise<void> {
    const run = this.deltaQueue.then(() => this.runDeltaSync(initial))
    this.deltaQueue = run.catch(() => undefined)
    return run
  }

  private async runDeltaSync(initial: boolean): Promise<void> {
    // Nach stop() (Konto entfernt) keine Abfragen und Benachrichtigungen mehr
    if (!this.started || this.wrongTenant || !this.engine.tokens.has('chatsvc')) return
    const touched = [...this.realtimeConvs]
    this.realtimeConvs.clear()
    let data: any
    try {
      if (this.syncStateUrl && !initial) {
        data = await this.api.conversationsByUrl(this.syncStateUrl)
      } else {
        const since = initial ? Date.now() - 14 * 24 * 3600_000 : Math.max(1, this.lastDeltaAt - 120_000)
        data = await this.api.conversations(since, initial ? 200 : 100)
      }
    } catch (e) {
      if (e instanceof ApiError && (e.status === 400 || e.status === 404)) this.syncStateUrl = undefined
      log.warn(`[${this.id}] deltaSync failed`, (e as Error).message)
      this.trackSyncFailure('delta', e)
      if (this.started && touched.length > 0) this.emit('conversation-updated', touched)
      return
    }
    // Konto während der Abfrage entfernt
    if (!this.started) return
    this.lastDeltaAt = Date.now()
    if (data?._metadata?.syncState) this.syncStateUrl = data._metadata.syncState
    const changed: string[] = []
    let activityChanged = false
    for (const conv of data?.conversations ?? []) {
      const id: string = conv.id
      if (id === '48:notifications') {
        const newest = String(conv.lastMessage?.id ?? '')
        if (newest && newest !== this.lastActivityId) {
          const previous = this.lastActivityId
          this.lastActivityId = newest
          activityChanged = true
          if (previous && this.initialSyncDone) void this.notifyActivity(previous)
        }
        // Auf einem anderen Gerät gelesen: Der Zähler muss neu gerechnet werden, sonst bleibt der Punkt am Dock
        const h = parseHorizon(conv.properties?.consumptionhorizon)
        if (h && h !== this.activityHorizon) {
          this.activityHorizon = h
          activityChanged = true
        }
        continue
      }
      if (id.startsWith('48:') && id !== '48:notes') continue
      const channel = this.channelIndex.get(id)
      if (channel) {
        const lm = conv.lastMessage
        const t = toMs(lm?.originalarrivaltime || lm?.composetime)
        const from = mriFromLink(lm?.from)
        if (t && t > (channel.lastActivity ?? 0)) {
          const isNew = !!channel.lastActivity && this.initialSyncDone && !initial
          channel.lastActivity = t
          if (from !== this.record.mri) {
            const horizon = parseHorizon(conv.properties?.consumptionhorizon)
            channel.unread = !horizon || Number(lm.id) > horizon
          }
          changed.push(id)
          if (isNew && from !== this.record.mri && channel.isFavorite && !/^(ThreadActivity|Control)/.test(lm?.messagetype || '')) {
            const team = this.teams.find((tm) => tm.id === channel.teamId)
            this.notifiedAt.set(id, Date.now())
            this.emit('notify', {
              accountId: this.id,
              conversationId: id,
              kind: 'channel',
              teamId: channel.teamId,
              title: `${lm.imdisplayname || 'Neuer Beitrag'} in ${team?.displayName ?? ''} > ${channel.displayName}`,
              body: previewText(lm),
              senderMri: from
            })
          }
        } else if (channel.unread && lm?.id) {
          // Keine neue Nachricht, aber auf einem anderen Gerät gelesen: Punkt und Dock-Zahl sofort anpassen
          const horizon = parseHorizon(conv.properties?.consumptionhorizon)
          if (horizon && Number(lm.id) <= horizon) {
            channel.unread = false
            changed.push(id)
          }
        }
        for (const tm of this.teams) tm.unread = tm.channels.some((c) => c.unread && c.isFavorite)
        continue
      }
      const prev = this.chats.get(id)
      const next = this.convToChat(conv, prev)
      if (!next) continue
      const isNewMessage = !!next.lastMessage && next.lastMessage.id !== prev?.lastMessage?.id
      this.chats.set(id, next)
      if (!prev || isNewMessage || prev.unread !== next.unread || prev.topic !== next.topic) changed.push(id)
      if (!prev && next.members.length === 0) {
        if (next.kind === 'oneOnOne') {
          next.members = this.membersFromOneOnOneId(id)
          this.queuePeople(next.members)
        } else if (next.kind === 'group') this.enqueueMembers(id)
      }
      if (isNewMessage && !initial && this.initialSyncDone && next.unread && !next.muted && next.lastMessage && !next.lastMessage.isMine) {
        const lm = next.lastMessage
        const sender = lm.fromName || this.people.get(lm.from)?.displayName || 'Neue Nachricht'
        this.notifiedAt.set(id, Date.now())
        this.emit('notify', {
          accountId: this.id,
          conversationId: id,
          kind: 'chat',
          title: next.kind === 'oneOnOne' ? sender : `${sender} in ${next.title || 'Gruppenchat'}`,
          body: lm.text || 'Neue Nachricht',
          senderMri: lm.from
        })
      }
    }
    if (changed.length > 0) {
      this.recomputeTitles()
      this.emit('conversation-updated', changed)
      this.scheduleSnapshot()
      this.emit('changed')
    }
    // Echtzeit-Ereignisse ohne neue letzte Nachricht (Bearbeitung, Reaktion): nur die Ansicht neu laden
    const extra = touched.filter((id) => !changed.includes(id))
    if (extra.length > 0) this.emit('conversation-updated', extra)
    if (activityChanged) {
      void this.refreshActivityCount()
      this.emit('activity-updated')
    }
  }

  private onRealtime(payload: string): void {
    if (!payload || payload.length < 10) return
    const events = parseRealtimeFrame(payload)
    if (!events) return this.onRealtimeText(payload)
    let sync = false
    for (const ev of events) {
      if (ev.kind === 'typing') {
        if (ev.conversationId && ev.from && ev.from !== this.record.mri && !ev.clear) {
          this.emit('typing', { conversationId: ev.conversationId, mri: ev.from, name: ev.name ?? '' })
        }
        continue
      }
      // Lesebestätigung eines anderen: nur den Lesestand dieses Chats neu holen.
      // Der eigene Lesestand (z. B. vom Handy) ändert dagegen "ungelesen" in der Chatliste.
      if (ev.kind === 'read-receipt' && ev.conversationId && ev.from !== this.record.mri) {
        this.receiptConvs.add(ev.conversationId)
        // Leser unbekannt: es könnte auch der eigene Lesestand sein
        if (!ev.from) sync = true
        continue
      }
      // Bearbeitet, Reaktion, gelöscht: Die letzte Nachricht bleibt dieselbe, deltaSync meldet den Chat
      // deshalb nicht. Die offene Ansicht soll trotzdem neu laden.
      if (ev.conversationId && (ev.kind === 'new-message' || ev.kind === 'message-update' || ev.kind === 'thread-update')) {
        this.realtimeConvs.add(ev.conversationId)
      }
      sync = true
    }
    if (this.receiptConvs.size > 0) {
      clearTimeout(this.receiptTimer)
      this.receiptTimer = setTimeout(() => {
        const ids = [...this.receiptConvs]
        this.receiptConvs.clear()
        if (this.started && ids.length > 0) this.emit('read-receipts', ids)
      }, 250)
    }
    if (sync) {
      clearTimeout(this.realtimeTimer)
      this.realtimeTimer = setTimeout(() => void this.deltaSync(), 350)
    }
  }

  // Rückfall, wenn ein Frame kein lesbarer Trouter-Frame ist
  private onRealtimeText(payload: string): void {
    if (/Control\/Typing|ClearTyping/.test(payload)) {
      const m = payload.match(/conversations\\?\/((?:19|8):[^/"\\]+)/)
      const f = payload.match(/contacts\\?\/(8:[^/"\\]+)/)
      const n = payload.match(/imdisplayname\\?"\s*:\s*\\?"([^"\\]+)/)
      if (m && f && f[1] !== this.record.mri && !/ClearTyping/.test(payload)) {
        this.emit('typing', { conversationId: decodeURIComponent(m[1]), mri: f[1], name: n?.[1] ?? '' })
      }
      return
    }
    if (!/NewMessage|ConversationUpdate|ThreadUpdate|MessageUpdate|messaging|conversations/i.test(payload)) return
    clearTimeout(this.realtimeTimer)
    this.realtimeTimer = setTimeout(() => void this.deltaSync(), 350)
  }

  private recomputeTitles(): void {
    const myMri = this.record.mri
    for (const c of this.chats.values()) {
      c.title = this.titleFor(c, myMri)
      const names: Record<string, string> = {}
      for (const m of c.members.slice(0, 20)) {
        const p = this.people.get(m)
        if (p) names[m] = p.displayName
      }
      c.memberNames = names
      if (c.lastMessage && !c.lastMessage.fromName) c.lastMessage.fromName = this.people.get(c.lastMessage.from)?.displayName ?? ''
    }
  }

  private titleFor(c: ChatSummary, myMri?: string): string {
    if (c.topic) return c.topic
    if (c.id === '48:notes') return this.me ? `${this.me.displayName} (Du)` : 'Notizen (Du)'
    const others = c.members.filter((m) => m !== myMri)
    if (others.length === 0) return this.me ? `${this.me.displayName} (du)` : 'Chat'
    const names = others.map((m) => this.people.get(m)?.displayName || fallbackName(m)).filter(Boolean) as string[]
    if (c.kind === 'oneOnOne') return names[0] || (c.lastMessage && !c.lastMessage.isMine ? c.lastMessage.fromName : '') || 'Unbekannt'
    if (names.length === 0) return 'Gruppenchat'
    const first = names.map((n) => (others.length > 2 ? n.split(/[\s,]+/)[0] : n))
    const shown = first.slice(0, 4).join(', ')
    return others.length > 4 ? `${shown} +${others.length - 4}` : shown
  }

  // 1:1-IDs enthalten beide Objekt-IDs: 19:<oidA>_<oidB>@unq.gbl.spaces
  private membersFromOneOnOneId(id: string): string[] {
    const m = id.match(/^19:([0-9a-f-]{36})_([0-9a-f-]{36})@unq\.gbl\.spaces$/i)
    if (!m) return []
    const mine = this.record.mri?.replace('8:orgid:', '')
    const other = m[1] === mine ? m[2] : m[1]
    return other === mine ? [] : [`8:orgid:${other}`]
  }

  // Mitglieder nacheinander laden, sonst bremst Teams mit HTTP 429
  private membersQueue: string[] = []
  private membersRunning = false
  private enqueueMembers(id: string): void {
    if (!this.membersQueue.includes(id)) this.membersQueue.push(id)
    void this.runMembersQueue()
  }
  private async runMembersQueue(): Promise<void> {
    if (this.membersRunning) return
    this.membersRunning = true
    try {
      while (this.membersQueue.length) {
        const id = this.membersQueue.shift()!
        await this.loadMembers(id)
        await new Promise((r) => setTimeout(r, 800))
      }
    } finally {
      this.membersRunning = false
    }
  }

  private async loadMembers(conversationId: string): Promise<void> {
    try {
      const t = await this.api.thread(conversationId)
      const members: string[] = (t.members ?? []).map((m: any) => m.id).filter((m: string) => m && m !== this.record.mri)
      const chat = this.chats.get(conversationId)
      if (chat) {
        chat.members = members
        if (t.properties?.topic) chat.topic = htmlToText(t.properties.topic)
        this.queuePeople(members)
        this.recomputeTitles()
        this.scheduleSnapshot()
      }
    } catch {
      /* ignore */
    }
  }

  // ---------- Personen ----------

  private queuePeople(mris: string[]): void {
    let added = false
    for (const m of mris) {
      if (!m || !m.startsWith('8:') || this.unresolvable.has(m)) continue
      const p = this.people.get(m)
      if (p && p.displayName && p.displayName !== m && (p as any).full) continue
      this.peopleQueue.add(m)
      added = true
    }
    if (added) {
      clearTimeout(this.peopleTimer)
      this.peopleTimer = setTimeout(() => void this.flushPeople(), 200)
    }
  }

  private async flushPeople(): Promise<void> {
    if (!this.engine.tokens.has('mt')) {
      this.peopleTimer = setTimeout(() => void this.flushPeople(), 3000)
      return
    }
    const all = [...this.peopleQueue]
    this.peopleQueue.clear()
    for (let i = 0; i < all.length; i += 100) {
      const chunk = all.slice(i, i + 100)
      try {
        const res = await this.api.fetchShortProfiles(chunk)
        for (const u of res?.value ?? []) {
          if (!u.mri) continue
          const p: Person & { full?: boolean } = {
            mri: u.mri,
            displayName: u.displayName || [u.givenName, u.surname].filter(Boolean).join(' ') || u.email || u.mri,
            email: u.email,
            upn: u.userPrincipalName,
            jobTitle: u.jobTitle,
            department: u.department,
            objectId: u.objectId,
            type: u.userType === 'Guest' ? 'guest' : u.type === 'Bot' ? 'bot' : 'user',
            full: true
          }
          this.people.set(u.mri, p)
        }
      } catch (e) {
        log.warn(`[${this.id}] fetchShortProfile failed`, (e as Error).message)
      }
      // Externe Personen (andere Organisationen) liefert nur fetchFederated
      const missing = chunk.filter((m) => !(this.people.get(m) as any)?.full)
      if (missing.length) {
        try {
          const res = await this.api.fetchFederated(missing)
          for (const u of res?.value ?? []) {
            const mri = u.mri || missing.find((m) => m.endsWith(u.objectId ?? '__'))
            if (!mri) continue
            this.people.set(mri, {
              mri,
              displayName: u.displayName || [u.givenName, u.surname].filter(Boolean).join(' ') || u.email || mri,
              email: u.email,
              upn: u.userPrincipalName,
              jobTitle: u.jobTitle,
              objectId: u.objectId,
              type: 'guest',
              full: true
            } as Person & { full: boolean })
          }
        } catch {
          /* ignorieren */
        }
        for (const m of missing) if (!(this.people.get(m) as any)?.full) this.unresolvable.add(m)
      }
    }
    this.recomputeTitles()
    this.scheduleSnapshot()
    this.savePeopleCache()
  }

  private peopleCacheFile(): string {
    const dir = join(app.getPath('userData'), 'cache')
    mkdirSync(dir, { recursive: true })
    return join(dir, `people-${this.id}.json`)
  }

  private loadPeopleCache(): void {
    try {
      const arr = JSON.parse(readFileSync(this.peopleCacheFile(), 'utf8')) as Person[]
      for (const p of arr) this.people.set(p.mri, p)
    } catch {
      /* noch kein Cache */
    }
  }

  private savePeopleCache(): void {
    try {
      writeFileSync(this.peopleCacheFile(), JSON.stringify([...this.people.values()]))
    } catch {
      /* ignore */
    }
  }

  // Mandanten des Kontos, wie sie der Mandantenwechsel der Web-App anzeigt
  async listTenants(): Promise<TenantInfo[]> {
    const raw = await this.api.json('mt', `${this.api.base('mt')}/beta/users/tenantsv2?invalidate=${Date.now()}`)
    const tenants = parseTenants(raw, this.record.tenantId)
    // Name des eigenen Mandanten für die Kopfzeile in der Chatliste merken
    const own = tenants.find((t) => t.current)
    if (own?.tenantName && own.tenantName !== this.record.tenantName) {
      this.record = { ...this.record, tenantName: own.tenantName }
      this.emit('record-updated', this.record)
    }
    return tenants
  }

  async getPeople(mris: string[]): Promise<Person[]> {
    const missing = mris.filter((m) => m.startsWith('8:') && !(this.people.get(m) as any)?.full)
    if (missing.length && this.engine.tokens.has('mt')) {
      this.peopleQueue = new Set([...this.peopleQueue, ...missing])
      await this.flushPeople()
    }
    return mris.map((m) => this.people.get(m) ?? { mri: m, displayName: m })
  }

  async searchPeople(query: string): Promise<Person[]> {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const results = new Map<string, Person>()
    const local = [...this.people.values()].filter(
      (p) => p.mri !== this.record.mri && (p.displayName?.toLowerCase().includes(q) || p.email?.toLowerCase().includes(q))
    )
    for (const p of local.slice(0, 8)) results.set(p.mri, p)
    try {
      const res = await this.api.searchSubstrate(query)
      for (const g of res?.Groups ?? []) {
        for (const s of g.Suggestions ?? []) {
          const oid = s.ExternalDirectoryObjectId || s.ObjectId
          const mri = s.MRI || (oid ? `8:orgid:${oid}` : undefined)
          if (!mri || mri === this.record.mri) continue
          const p: Person = {
            mri,
            displayName: s.DisplayName || s.Text,
            email: s.EmailAddresses?.[0] || s.UserPrincipalName,
            upn: s.UserPrincipalName,
            jobTitle: s.JobTitle,
            department: s.Department,
            objectId: oid
          }
          results.set(mri, p)
          if (!this.people.has(mri)) this.people.set(mri, p)
        }
      }
    } catch {
      try {
        const res = await this.api.searchUsersMt(query)
        for (const u of res?.value ?? res ?? []) {
          if (!u.mri || u.mri === this.record.mri) continue
          results.set(u.mri, { mri: u.mri, displayName: u.displayName, email: u.email, upn: u.userPrincipalName, jobTitle: u.jobTitle, objectId: u.objectId })
        }
      } catch (e) {
        log.warn(`[${this.id}] people search failed`, (e as Error).message)
      }
    }
    return [...results.values()].slice(0, 20)
  }

  // ---------- Präsenz ----------

  presenceTargets(): string[] {
    const set = new Set<string>()
    if (this.record.mri) set.add(this.record.mri)
    const recent = sortChats([...this.chats.values()]).slice(0, 80)
    for (const c of recent) for (const m of c.members.slice(0, c.kind === 'oneOnOne' ? 1 : 6)) if (m.startsWith('8:orgid:')) set.add(m)
    return [...set]
  }

  async refreshPresence(extra: string[] = []): Promise<void> {
    const targets = [...new Set([...this.presenceTargets(), ...extra])]
    if (targets.length === 0) return
    const updates: Record<string, Presence> = {}
    for (let i = 0; i < targets.length; i += 100) {
      try {
        const res = await this.api.getPresence(targets.slice(i, i + 100))
        for (const r of Array.isArray(res) ? res : res?.value ?? []) {
          const p = r.presence ?? {}
          const pres: Presence = {
            availability: (p.availability || 'PresenceUnknown') as Availability,
            activity: p.activity,
            statusMessage: p.note?.message ? htmlToText(p.note.message) : undefined,
            outOfOffice: !!p.calendarData?.isOutOfOffice
          }
          this.presence.set(r.mri, pres)
          updates[r.mri] = pres
        }
      } catch (e) {
        log.warn(`[${this.id}] presence failed`, (e as Error).message)
        break
      }
    }
    if (Object.keys(updates).length) {
      this.emit('presence', updates)
      this.emit('changed')
    }
  }

  async getPresence(mris: string[]): Promise<Record<string, Presence>> {
    const missing = mris.filter((m) => !this.presence.has(m))
    if (missing.length) await this.refreshPresence(missing)
    const out: Record<string, Presence> = {}
    for (const m of mris) {
      const p = this.presence.get(m)
      if (p) out[m] = p
    }
    return out
  }

  async setMyPresence(availability: Availability | 'Reset'): Promise<void> {
    await this.api.forceAvailability(availability === 'Reset' ? null : availability)
    setTimeout(() => void this.refreshPresence(), 800)
  }

  // ---------- Snapshot ----------

  scheduleSnapshot(): void {
    clearTimeout(this.snapshotTimer)
    this.snapshotTimer = setTimeout(() => this.emit('snapshot', this.snapshot()), 250)
  }

  snapshot(): AccountSnapshot {
    const people: Record<string, Person> = {}
    for (const [k, v] of this.people) people[k] = { mri: v.mri, displayName: v.displayName, email: v.email, upn: v.upn, jobTitle: v.jobTitle, department: v.department, objectId: v.objectId }
    const presence: Record<string, Presence> = {}
    for (const [k, v] of this.presence) presence[k] = v
    return {
      accountId: this.id,
      me: this.me,
      // Kanal-Unterhaltungen ohne Team (z.B. verlassene Teams) nicht anzeigen
      chats: sortChats([...this.chats.values()].filter((c) => c.kind !== 'channel')),
      teams: this.teams,
      folders: this.folders,
      people,
      presence,
      syncedAt: Date.now()
    }
  }

  // ---------- Nachrichten ----------

  private names = (mri: string): string | undefined => this.people.get(mri)?.displayName

  async getMessages(conversationId: string, before?: number): Promise<Message[]> {
    const myMri = this.record.mri ?? ''
    const toMessages = (r: any): Message[] =>
      (r?.messages ?? []).filter((m: any) => !/^Control\//.test(m.messagetype || '')).map((m: any) => mapChatsvcMessage(m, myMri, this.names))
    let res: any
    let msgs: Message[]
    if (before) {
      const link = this.olderLinks.get(conversationId, before)
      if (!link) return []
      res = await this.api.messagesByUrl(link)
      msgs = toMessages(res)
    } else {
      res = await this.api.messages(conversationId, 60)
      msgs = toMessages(res)
    }
    const back = res?._metadata?.backwardLink
    if (back && msgs.length) this.olderLinks.set(conversationId, Math.min(...msgs.map((m) => m.time)), back)
    const unknown = [...new Set(msgs.map((m) => m.from).filter((f) => f && !this.people.has(f)))]
    if (unknown.length) this.queuePeople(unknown)
    for (const m of msgs) {
      if (m.from && m.fromName && !this.people.has(m.from)) this.people.set(m.from, { mri: m.from, displayName: m.fromName })
    }
    return msgs.sort((a, b) => a.time - b.time || Number(a.id) - Number(b.id))
  }

  async getChannelThreads(teamId: string, channelId: string): Promise<ChannelThread[]> {
    const myMri = this.record.mri ?? ''
    try {
      const res = await this.api.channelPosts(teamId, channelId, 30)
      const chains: any[] = res?.replyChains ?? []
      const threads: ChannelThread[] = []
      for (const ch of chains) {
        const msgs: Message[] = (ch.messages ?? [])
          .filter((m: any) => !/^Control\//.test(m.messageType || m.messagetype || ''))
          .map((m: any) => mapChatsvcMessage({ ...m, conversationId: channelId }, myMri, this.names))
          .sort((a: Message, b: Message) => a.time - b.time)
        const rootId = String(ch.id ?? msgs[0]?.parentId ?? msgs[0]?.id)
        const root = msgs.find((m) => m.id === rootId) ?? msgs[0]
        if (!root) continue
        const replies = msgs.filter((m) => m !== root)
        threads.push({ id: rootId, root, replies, replyCount: Math.max(replies.length, Number(ch.replyCount ?? 0) || 0), lastActivity: msgs[msgs.length - 1]?.time ?? root.time })
      }
      if (threads.length > 0) return threads.sort((a, b) => a.lastActivity - b.lastActivity)
    } catch (e) {
      log.warn(`[${this.id}] csa channel failed, fallback chatsvc`, (e as Error).message)
    }
    const res = await this.api.messages(channelId, 200)
    const msgs: Message[] = (res?.messages ?? [])
      .filter((m: any) => !/^Control\//.test(m.messagetype || ''))
      .map((m: any) => mapChatsvcMessage(m, myMri, this.names))
    const byRoot = new Map<string, Message[]>()
    for (const m of msgs) {
      const root = m.parentId ?? m.id
      if (!byRoot.has(root)) byRoot.set(root, [])
      byRoot.get(root)!.push(m)
    }
    const threads: ChannelThread[] = []
    for (const [rootId, list] of byRoot) {
      list.sort((a, b) => a.time - b.time)
      const root = list.find((m) => m.id === rootId) ?? list[0]
      const replies = list.filter((m) => m !== root)
      threads.push({ id: rootId, root, replies, replyCount: replies.length, lastActivity: list[list.length - 1].time })
    }
    return threads.sort((a, b) => a.lastActivity - b.lastActivity)
  }

  async getThreadReplies(channelId: string, rootId: string): Promise<Message[]> {
    const res = await this.api.messages(`${channelId};messageid=${rootId}`, 200)
    const myMri = this.record.mri ?? ''
    return (res?.messages ?? [])
      .filter((m: any) => !/^Control\//.test(m.messagetype || ''))
      .map((m: any) => mapChatsvcMessage(m, myMri, this.names))
      .sort((a: Message, b: Message) => a.time - b.time)
  }

  async sendMessage(conversationId: string, html: string, opts: { replyToId?: string; subject?: string; importance?: 'normal' | 'high' | 'urgent' } = {}): Promise<Message> {
    const cmid = clientMessageId()
    const target = opts.replyToId ? `${conversationId};messageid=${opts.replyToId}` : conversationId
    // Eingefügte Bilder kommen als data:-URL aus dem Eingabefeld und gehen vorher zu Teams
    const images = await replaceInlineImages(html, (data, mime) => this.api.uploadImage(conversationId, data, mime))
    html = images.html
    const body = {
      content: html,
      messagetype: 'RichText/Html',
      contenttype: 'text',
      amsreferences: images.ids,
      clientmessageid: cmid,
      imdisplayname: this.me?.displayName ?? this.record.displayName ?? '',
      properties: { importance: opts.importance && opts.importance !== 'normal' ? opts.importance : '', subject: opts.subject ?? '' }
    }
    const res = await this.api.sendMessage(target, body)
    const id = String(res?.OriginalArrivalTime ?? Date.now())
    const chat = this.chats.get(conversationId)
    const msg: Message = {
      id,
      conversationId,
      clientMessageId: cmid,
      type: 'RichText/Html',
      kind: 'text',
      from: this.record.mri ?? '',
      fromName: body.imdisplayname,
      isMine: true,
      time: Number(id) || Date.now(),
      html,
      text: htmlToText(html),
      subject: opts.subject || undefined,
      importance: opts.importance === 'normal' ? undefined : opts.importance,
      reactions: [],
      attachments: [],
      parentId: opts.replyToId
    }
    if (chat) {
      chat.lastMessage = { id, from: msg.from, fromName: msg.fromName, text: msg.text.slice(0, 200), time: msg.time, isMine: true }
      chat.lastActivity = msg.time
      chat.unread = false
      chat.hidden = false
      this.scheduleSnapshot()
    }
    setTimeout(() => void this.deltaSync(), 1500)
    return msg
  }

  async editMessage(conversationId: string, messageId: string, html: string): Promise<void> {
    const images = await replaceInlineImages(html, (data, mime) => this.api.uploadImage(conversationId, data, mime))
    await this.api.editMessage(conversationId, messageId, {
      content: images.html,
      messagetype: 'RichText/Html',
      contenttype: 'text',
      amsreferences: amsImageIds(images.html),
      imdisplayname: this.me?.displayName ?? ''
    })
  }

  async deleteMessage(conversationId: string, messageId: string): Promise<void> {
    await this.api.deleteMessage(conversationId, messageId)
  }

  async setReaction(conversationId: string, messageId: string, key: string, on: boolean): Promise<void> {
    await this.api.setEmotion(conversationId, messageId, key, on)
  }

  async markRead(conversationId: string, messageId: string): Promise<void> {
    const chat = this.chats.get(conversationId)
    const channel = this.channelIndex.get(conversationId)
    const already = chat ? !chat.unread && (chat.consumptionHorizon ?? 0) >= Number(messageId) : channel ? !channel.unread : false
    if (already) return
    await this.api.setConsumptionHorizon(conversationId, `${messageId};${Date.now()};${messageId}`)
    if (chat) {
      chat.unread = false
      chat.consumptionHorizon = Number(messageId)
    }
    if (channel) {
      channel.unread = false
      for (const tm of this.teams) tm.unread = tm.channels.some((c) => c.unread && c.isFavorite)
    }
    this.scheduleSnapshot()
    this.emit('changed')
  }

  // Lesestand der anderen Teilnehmer (Nachrichten-ID bis zu der gelesen wurde)
  async getReadHorizons(conversationId: string): Promise<Record<string, number>> {
    const res = await this.api.consumptionHorizons(conversationId)
    const out: Record<string, number> = {}
    for (const h of res?.consumptionhorizons ?? []) {
      if (!h.id || h.id === this.record.mri) continue
      out[h.id] = parseHorizon(h.consumptionhorizon)
    }
    return out
  }

  async sendTyping(conversationId: string): Promise<void> {
    await this.api.sendMessage(conversationId, { content: '', messagetype: 'Control/Typing', contenttype: 'Application/Message' }).catch(() => undefined)
  }

  async createChat(mris: string[], topic?: string): Promise<string> {
    const me = this.record.mri
    if (!me) throw new Error('Eigenes Konto noch nicht bekannt')
    if (mris.length === 1 && !topic) {
      const existing = [...this.chats.values()].find((c) => c.kind === 'oneOnOne' && c.members.length === 1 && c.members[0] === mris[0])
      if (existing) return existing.id
    }
    const members = [me, ...mris].map((id) => ({ id, role: 'Admin' }))
    const props: Record<string, unknown> =
      mris.length === 1 && !topic
        ? { threadType: 'chat', fixedRoster: true, uniquerosterthread: true, chatFilesIndexId: '2' }
        : { threadType: 'chat', fixedRoster: false, uniquerosterthread: false, chatFilesIndexId: '2', ...(topic ? { topic } : {}) }
    const res = await this.api.createThread(members, props)
    if (!res.ok) throw new ApiError(res.status, `Chat konnte nicht erstellt werden (${res.status})`, await res.text().catch(() => ''))
    const loc = res.headers.get('location') || ''
    const m = loc.match(/threads\/([^/?]+)/)
    let id = m ? decodeURIComponent(m[1]) : ''
    if (!id) {
      const j = await res.json().catch(() => ({}))
      id = j?.threadResource?.id || j?.id || ''
    }
    if (!id) throw new Error('Chat-ID unbekannt')
    if (!this.chats.has(id)) {
      this.chats.set(id, {
        id,
        kind: mris.length === 1 && !topic ? 'oneOnOne' : 'group',
        title: '',
        topic,
        members: mris,
        lastActivity: Date.now(),
        unread: false
      })
      this.queuePeople(mris)
      this.recomputeTitles()
      this.scheduleSnapshot()
    }
    return id
  }

  // ---------- Kalender, Aktivität, Anrufe ----------

  async getCalendar(start: number, end: number): Promise<CalendarEvent[]> {
    const { source, data } = await this.api.calendarView(new Date(start).toISOString(), new Date(end).toISOString())
    const items: any[] = data?.value ?? data?.events ?? (Array.isArray(data) ? data : [])
    return items
      .map((e: any): CalendarEvent => {
        if (source === 'graph' || source === 'outlook') {
          const s = e.start?.dateTime ?? e.Start?.DateTime
          const en = e.end?.dateTime ?? e.End?.DateTime
          return {
            id: e.id ?? e.Id,
            subject: e.subject ?? e.Subject ?? '(Kein Titel)',
            start: Date.parse(s + (/[zZ]|[+-]\d\d:\d\d$/.test(s) ? '' : 'Z')),
            end: Date.parse(en + (/[zZ]|[+-]\d\d:\d\d$/.test(en) ? '' : 'Z')),
            isAllDay: !!(e.isAllDay ?? e.IsAllDay),
            location: e.location?.displayName ?? e.Location?.DisplayName,
            organizer: e.organizer?.emailAddress?.name ?? e.Organizer?.EmailAddress?.Name,
            organizerEmail: e.organizer?.emailAddress?.address,
            joinUrl: e.onlineMeeting?.joinUrl ?? e.OnlineMeeting?.JoinUrl ?? e.onlineMeetingUrl ?? undefined,
            isOnlineMeeting: !!(e.isOnlineMeeting ?? e.IsOnlineMeeting),
            isCancelled: !!(e.isCancelled ?? e.IsCancelled),
            showAs: e.showAs ?? e.ShowAs,
            myResponse: e.responseStatus?.response,
            isPrivate: (e.sensitivity ?? '') === 'private',
            iCalUId: e.iCalUId ?? e.ICalUId ?? undefined
          }
        }
        return {
          id: e.objectId ?? e.id ?? e.iCalUID ?? String(Math.random()),
          subject: e.subject ?? '(Kein Titel)',
          start: toMs(e.startTime ?? e.start),
          end: toMs(e.endTime ?? e.end),
          isAllDay: !!(e.isAllDayEvent ?? e.isAllDay),
          location: e.location ?? undefined,
          organizer: e.organizerName ?? undefined,
          organizerEmail: e.organizerAddress ?? undefined,
          joinUrl: e.skypeTeamsMeetingUrl || e.onlineMeetingUrl || e.joinUrl || undefined,
          isOnlineMeeting: !!(e.isOnlineMeeting || e.skypeTeamsMeetingUrl),
          isCancelled: !!e.isCancelled,
          showAs: e.showAs,
          myResponse: e.myResponseType ?? e.responseType,
          threadId: e.skypeTeamsData ? safeThreadId(e.skypeTeamsData) : undefined,
          isPrivate: !!e.isPrivate,
          iCalUId: e.iCalUID ?? e.iCalUId ?? e.icalUid ?? undefined
        }
      })
      .filter((e) => e.start && e.end)
      .sort((a, b) => a.start - b.start)
  }

  async createEvent(ev: NewCalendarEvent): Promise<void> {
    if (!ev.subject.trim()) throw new Error('Titel fehlt')
    if (!(ev.end > ev.start)) throw new Error('Das Ende muss nach dem Beginn liegen')
    const { source } = await this.api.createEvent(ev)
    log.info(`[calendar] Termin angelegt über ${source}`)
  }

  // ---------- E-Mail ----------

  // Profilbilder zu Absendern und Empfängern: Adresse → MRI, dann wie in Chats (media-protocol.ts)
  private mailPeople = new MailDirectory((list) => this.lookupMailAddresses(list))

  // Erst unter den Personen aus Chats suchen, das klappt auch, wenn Teams gerade nicht antwortet
  mriForMailAddress(address: string): Promise<string | undefined> {
    const a = address.trim().toLowerCase()
    const known = mailMatches([a], [this.me, ...this.people.values()]).get(a)
    return known ? Promise.resolve(known) : this.mailPeople.resolve(a)
  }

  private async lookupMailAddresses(list: string[]): Promise<Map<string, string>> {
    const res = await this.api.fetchShortProfilesByMail(list)
    return mailMatches(list, res?.value ?? [])
  }

  // Welche Ordner-ID zu welchem Standardordner gehört, ändert sich nicht: einmal je Sitzung fragen
  // Die Abfragen laufen nacheinander: Exchange drosselt schon bei wenigen gleichzeitigen Anfragen je
  // Postfach (429, im Live-Test bei sieben). Was dabei scheitert, fragt der nächste Abruf erneut,
  // was es nicht gibt (404, z. B. kein Archiv), nicht mehr. Die Zuordnung ändert sich nicht.
  private mailKinds = new Map<string, MailFolderKind>()
  private mailKindsDone = new Set<MailFolderKind>()
  // Gleichzeitige Abrufe (Neu laden während des Zwei-Minuten-Abrufs) teilen sich einen
  private mailFoldersRun?: Promise<MailFolder[]>

  private async resolveMailKinds(): Promise<void> {
    for (const k of WELL_KNOWN) {
      if (this.mailKindsDone.has(k)) continue
      try {
        const f = await this.api.mailWellKnown(k)
        this.mailKinds.set(String(f.id), k)
        this.mailKindsDone.add(k)
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) this.mailKindsDone.add(k)
      }
    }
  }

  getMailFolders(): Promise<MailFolder[]> {
    this.mailFoldersRun ??= (async () => {
      const list = await this.api.mailFolders()
      await this.resolveMailKinds()
      const items: any[] = list?.value ?? []
      return sortFolders(items.map((f) => mapFolder(f, this.mailKinds.get(String(f.id)))))
    })().finally(() => {
      this.mailFoldersRun = undefined
    })
    return this.mailFoldersRun
  }

  // null, solange die Web-App noch keinen Token für Mail angefordert hat (kein Fehler, nur noch nichts da)
  async getMailUnread(): Promise<number | null> {
    if (!this.api.hasMailToken()) return null
    const f = await this.api.mailWellKnown('inbox')
    return Number(f?.unreadItemCount) || 0
  }

  async listMail(folderId: string, next?: string): Promise<MailPage> {
    const res = await this.api.mailMessages(folderId, next)
    const items: any[] = res?.value ?? []
    return { items: items.map((m) => mapSummary(m, this.id)), next: res?.['@odata.nextLink'] || undefined }
  }

  async getMail(id: string): Promise<MailMessage> {
    const [m, att] = await Promise.all([this.api.mailMessage(id), listAttachments(this.api, id)])
    const attachments = att.map(mapAttachment)
    const body = String(m?.body?.content ?? '')
    // Eingebettete Bilder (cid:…) als data:-URL, zusammen höchstens 8 MB. Was das HTML nicht
    // einbettet, bleibt in der Anhangsliste.
    const inlineImages: Record<string, string> = {}
    const embedded = new Set<string>()
    let budget = 8 * 1024 * 1024
    for (const a of attachments.filter((x) => x.isInline).slice(0, 20)) {
      if (a.size > budget) continue
      try {
        const full = await this.api.mailAttachment(id, a.id)
        const cid = contentId(full?.contentId)
        if (!cid || typeof full?.contentBytes !== 'string' || !body.includes(`cid:${cid}`)) continue
        inlineImages[cid] = `data:${full.contentType || 'application/octet-stream'};base64,${full.contentBytes}`
        embedded.add(a.id)
        budget -= a.size
      } catch (e) {
        log.warn('[mail] Eingebettetes Bild nicht geladen', (e as Error).message)
      }
    }
    return mapMessage(m, this.id, attachments.filter((a) => !embedded.has(a.id)), inlineImages)
  }

  async getMailAttachment(id: string, attachmentId: string): Promise<{ name: string; data: Uint8Array }> {
    const a = await this.api.mailAttachment(id, attachmentId)
    if (typeof a?.contentBytes !== 'string') throw new Error('Diesen Anhang kann die App nicht öffnen (keine Datei, z. B. eine angehängte Mail oder ein Link)')
    return { name: a.name || 'Anhang', data: Buffer.from(a.contentBytes, 'base64') }
  }

  async setMailRead(id: string, isRead: boolean): Promise<void> {
    await this.api.setMailRead(id, isRead)
  }

  async deleteMail(id: string): Promise<void> {
    await this.api.moveMail(id, 'deleteditems')
  }

  async sendMail(draft: MailDraft, reply?: { id: string; kind: MailReplyKind }): Promise<void> {
    if (!draft.to.length && !draft.cc.length) throw new Error('Mindestens ein Empfänger fehlt')
    const big = draft.attachments.find((f) => Buffer.from(f.data, 'base64').length > MAX_ATTACHMENT_BYTES)
    if (big) throw new Error(`${big.name} ist größer als 3 MB`)
    const draftId = await this.api.createMailDraft(draft, reply)
    for (const f of draft.attachments) await this.api.addMailAttachment(draftId, f)
    const { source } = await this.api.sendMailDraft(draftId)
    log.info(`[mail] gesendet über ${source}`)
  }

  async getActivity(): Promise<ActivityItem[]> {
    const res = await this.api.messages('48:notifications', 60)
    const items = (res?.messages ?? []).map((m: any) => mapActivity(m, this.names)).filter(Boolean) as ActivityItem[]
    for (const it of items) it.read = Number(it.id) <= this.activityHorizon
    this.activityUnread = items.filter((i) => !i.read).length
    this.emit('changed')
    return items.sort((a, b) => b.time - a.time)
  }

  private async refreshActivityCount(): Promise<void> {
    try {
      await this.getActivity()
    } catch {
      /* ignore */
    }
  }

  // Mitteilungen für neue Erwähnungen und Antworten im Aktivitäts-Feed (wie Teams).
  // In einem Chat meldet schon die Chat-Mitteilung die Nachricht, außer der Chat ist stummgeschaltet:
  // Erwähnungen kommen dann trotzdem durch.
  private async notifyActivity(previousId: string): Promise<void> {
    try {
      const items = await this.getActivity()
      if (!this.started) return
      const fresh = items.filter((it) => !it.read && Number(it.id) > Number(previousId) && (it.type === 'mention' || it.type === 'reply'))
      for (const it of fresh.slice(0, 3).reverse()) {
        const conv = it.conversationId ?? ''
        const chat = this.chats.get(conv)
        if (chat && !(chat.muted && it.type === 'mention')) continue
        if (!chat && !this.channelIndex.has(conv)) continue
        if (Date.now() - (this.notifiedAt.get(conv) ?? 0) < 120_000) continue
        this.emit('notify', {
          accountId: this.id,
          conversationId: conv,
          kind: 'activity',
          teamId: it.teamId,
          activityId: it.id,
          title: `${it.actorName || 'Jemand'} ${it.title}`,
          body: it.preview || it.location || '',
          senderMri: it.actor
        })
      }
    } catch {
      /* ignore */
    }
  }

  // Ist die Unterhaltung (bzw. der Aktivitätseintrag) einer Mitteilung noch ungelesen?
  isUnread(key: { conversationId: string; kind: NotifyPayload['kind']; activityId?: string }): boolean {
    if (key.kind === 'activity') return !!key.activityId && Number(key.activityId) > this.activityHorizon
    if (key.kind === 'channel') return !!this.channelIndex.get(key.conversationId)?.unread
    return !!this.chats.get(key.conversationId)?.unread
  }

  async markActivityRead(): Promise<void> {
    const res = await this.api.messages('48:notifications', 1)
    const newest = res?.messages?.[0]?.id
    if (!newest) return
    await this.api.setConsumptionHorizon('48:notifications', `${newest};${Date.now()};${newest}`)
    this.activityHorizon = Number(newest)
    this.activityUnread = 0
    this.emit('changed')
  }

  async getCallHistory(): Promise<CallLogEntry[]> {
    const res = await this.api.messages('48:calllogs', 60)
    const myMri = this.record.mri ?? ''
    const entries = (res?.messages ?? []).map((m: any) => mapCallLog(m, myMri)).filter(Boolean) as CallLogEntry[]
    const unknown = entries.map((e) => e.peerMri).filter((m): m is string => !!m && !this.people.has(m))
    if (unknown.length) await this.getPeople(unknown)
    for (const e of entries) if (!e.peerName && e.peerMri) e.peerName = this.people.get(e.peerMri)?.displayName
    return entries.sort((a, b) => b.time - a.time)
  }
}

function countsForSort(type: string | undefined): boolean {
  return !!type && !/^(Event\/Call|ThreadActivity\/|Control\/)/i.test(type)
}

function fallbackName(mri: string): string | undefined {
  if (mri.startsWith('4:')) return mri.slice(2)
  if (mri.startsWith('28:')) return 'App'
  return undefined
}

function safeThreadId(data: unknown): string | undefined {
  try {
    const d = typeof data === 'string' ? JSON.parse(data) : data
    return (d as any)?.threadId
  } catch {
    return undefined
  }
}

async function listAttachments(api: TeamsApi, id: string): Promise<any[]> {
  try {
    const res = await api.mailAttachments(id)
    return res?.value ?? []
  } catch (e) {
    log.warn('[mail] Anhänge nicht geladen', (e as Error).message)
    return []
  }
}
