import { createContext, useContext } from 'react'
import { create } from 'zustand'
import type { AccountInfo, AccountSnapshot, AppSettings, CallState, Presence, SettingsPage, UpdateState } from '@shared/types'
import { api, onEvent } from './api'
import { groupedByAccount } from '@shared/analytics'
import { track } from './analytics'

export type View = 'activity' | 'chat' | 'teams' | 'mail' | 'calendar' | 'calls'

export interface Selection {
  chatId?: string
  newChat?: boolean
  teamId?: string
  channelId?: string
  activityId?: string
  focusMessageId?: string
}

interface NavEntry {
  accountId?: string
  view: View
  sel: Selection
}

interface MainState {
  accounts: AccountInfo[]
  activeAccountId?: string
  snapshots: Record<string, AccountSnapshot>
  view: View
  selection: Record<string, Selection>
  callState: CallState | null
  settings?: AppSettings
  // Offener Bereich des Einstellungsfensters, null: Fenster zu
  settingsPage: SettingsPage | null
  update: UpdateState | null
  typing: Record<string, { name: string; until: number }>
  back: NavEntry[]
  forward: NavEntry[]
  setView(v: View): void
  select(sel: Selection, view?: View): void
  // Unterhaltung eines anderen Kontos öffnen: Konto und Auswahl in einem Schritt
  open(accountId: string, sel: Selection, view?: View): void
  setActiveAccount(id: string): void
  goBack(): void
  goForward(): void
  // Ohne Bereich öffnet der zuletzt gezeigte
  openSettings(page?: SettingsPage): void
  closeSettings(): void
}

let lastSettingsPage: SettingsPage = 'accounts'

function current(s: MainState): NavEntry {
  return { accountId: s.activeAccountId, view: s.view, sel: s.activeAccountId ? s.selection[s.activeAccountId] ?? {} : {} }
}

export const useStore = create<MainState>((set, get) => ({
  accounts: [],
  snapshots: {},
  view: 'chat',
  selection: {},
  callState: null,
  settingsPage: null,
  update: null,
  typing: {},
  back: [],
  forward: [],
  // Ansicht wechseln schließt das Einstellungsfenster. select und open nicht: Die Chatliste
  // wählt beim Laden selbst einen Chat aus, das soll offene Einstellungen nicht zuklappen.
  setView: (v) => {
    const s = get()
    if (s.view === v) return set({ settingsPage: null })
    set({ view: v, settingsPage: null, back: [...s.back.slice(-50), current(s)], forward: [] })
  },
  select: (sel, view) => {
    const s = get()
    const id = s.activeAccountId
    if (!id) return
    set({
      selection: { ...s.selection, [id]: { ...(s.selection[id] ?? {}), ...sel } },
      view: view ?? s.view,
      back: [...s.back.slice(-50), current(s)],
      forward: []
    })
  },
  open: (accountId, sel, view) => {
    const s = get()
    if (s.activeAccountId === accountId) return s.select(sel, view)
    set({
      activeAccountId: accountId,
      selection: { ...s.selection, [accountId]: { ...(s.selection[accountId] ?? {}), ...sel } },
      view: view ?? s.view,
      back: [...s.back.slice(-50), current(s)],
      forward: []
    })
    void api.setSettings({ activeAccountId: accountId })
  },
  setActiveAccount: (id) => {
    const s = get()
    if (s.activeAccountId === id) return
    set({ activeAccountId: id, back: [...s.back.slice(-50), current(s)], forward: [] })
    void api.setSettings({ activeAccountId: id })
    if (!s.snapshots[id]) void api.getSnapshot(id).then((snap) => snap && useStore.setState((st) => ({ snapshots: { ...st.snapshots, [id]: snap } })))
  },
  goBack: () => {
    const s = get()
    const prev = s.back[s.back.length - 1]
    if (!prev) return
    set({
      back: s.back.slice(0, -1),
      forward: [...s.forward, current(s)],
      view: prev.view,
      settingsPage: null,
      activeAccountId: prev.accountId ?? s.activeAccountId,
      selection: prev.accountId ? { ...s.selection, [prev.accountId]: prev.sel } : s.selection
    })
  },
  goForward: () => {
    const s = get()
    const next = s.forward[s.forward.length - 1]
    if (!next) return
    set({
      forward: s.forward.slice(0, -1),
      back: [...s.back, current(s)],
      view: next.view,
      settingsPage: null,
      activeAccountId: next.accountId ?? s.activeAccountId,
      selection: next.accountId ? { ...s.selection, [next.accountId]: next.sel } : s.selection
    })
  },
  openSettings: (page) => {
    lastSettingsPage = page ?? lastSettingsPage
    set({ settingsPage: lastSettingsPage })
  },
  closeSettings: () => set({ settingsPage: null })
}))

// Die Unterhaltung hinter dem Einstellungsfenster gilt als nicht sichtbar: Sie markiert nichts
// als gelesen, und ihre Mitteilungen kommen wieder. Früher ersetzte die Einstellungsseite sie ganz.
let focusContext: { accountId?: string; conversationId?: string } = {}
export function setConversationFocus(ctx: { accountId?: string; conversationId?: string }): void {
  focusContext = ctx
  if (!useStore.getState().settingsPage) window.teams.setFocusContext(ctx)
}

export function conversationVisible(): boolean {
  return document.hasFocus() && !useStore.getState().settingsPage
}

export function useActive(): { account?: AccountInfo; snapshot?: AccountSnapshot; selection: Selection } {
  const accounts = useStore((s) => s.accounts)
  const id = useStore((s) => s.activeAccountId)
  const snapshot = useStore((s) => (id ? s.snapshots[id] : undefined))
  const selection = useStore((s) => (id ? s.selection[id] : undefined))
  return { account: accounts.find((a) => a.id === id), snapshot, selection: selection ?? {} }
}

// Konto, zu dem ein Listeneintrag gehört. Die Chatliste zeigt alle Konten untereinander,
// Avatare und Vorladen brauchen deshalb das Konto des Eintrags, nicht das aktive.
export const AccountScope = createContext<string | undefined>(undefined)

export function useScopedAccountId(): string {
  const scoped = useContext(AccountScope)
  const active = useStore((s) => s.activeAccountId)
  return scoped ?? active ?? ''
}

export function usePresence(mri?: string): Presence | undefined {
  return useStore((s) => (mri && s.activeAccountId ? s.snapshots[s.activeAccountId]?.presence[mri] : undefined))
}

export function personName(snapshot: AccountSnapshot | undefined, mri: string, fallback = ''): string {
  return snapshot?.people[mri]?.displayName || fallback || 'Unbekannt'
}

// Welche Ansichten und Unterhaltungen geöffnet werden. Nur die Art, nie Namen oder IDs.
function trackNavigation(): void {
  let lastScreen: string | undefined
  let lastConversation: string | undefined
  useStore.subscribe((s, prev) => {
    if (!s.settings) return
    const screen = s.settingsPage ? `settings:${s.settingsPage}` : s.accounts.length === 0 ? 'welcome' : s.view
    if (screen !== lastScreen) {
      lastScreen = screen
      track(
        '$screen',
        s.settingsPage
          ? { $screen_name: 'settings', settings_page: s.settingsPage }
          : { $screen_name: screen, grouped_by_account: groupedByAccount(screen, s.settings, s.accounts.length) }
      )
    }
    const id = s.activeAccountId
    const sel = id ? s.selection[id] : undefined
    const prevSel = id ? prev.selection[id] : undefined
    if (sel?.newChat && !prevSel?.newChat) track('new_chat_opened')
    const conv = sel?.channelId ?? sel?.chatId
    if (conv && conv !== lastConversation) {
      const kind = sel?.channelId ? 'channel' : (id && s.snapshots[id]?.chats.find((c) => c.id === conv)?.kind) || 'unknown'
      track('conversation_opened', { kind, view: s.view })
    }
    lastConversation = conv
  })
}

let initialized = false
export function initStore(): void {
  if (initialized) return
  initialized = true
  trackNavigation()
  useStore.subscribe((s, prev) => {
    if (!s.settingsPage !== !prev.settingsPage) window.teams.setFocusContext(s.settingsPage ? {} : focusContext)
  })
  void Promise.all([api.listAccounts(), api.getSettings(), api.getCallState()]).then(([accounts, settings, call]) => {
    const active = accounts.find((a) => a.id === settings.activeAccountId)?.id ?? accounts[0]?.id
    useStore.setState({ accounts, settings, activeAccountId: active, callState: call })
    for (const a of accounts) {
      void api.getSnapshot(a.id).then((snap) => {
        if (snap && snap.chats.length + snap.teams.length > 0) useStore.setState((s) => ({ snapshots: { ...s.snapshots, [a.id]: snap } }))
      })
    }
  })
  onEvent('accounts', (accounts) => {
    useStore.setState((s) => {
      const active = s.activeAccountId && accounts.some((a) => a.id === s.activeAccountId) ? s.activeAccountId : accounts[0]?.id
      return { accounts, activeAccountId: active }
    })
  })
  onEvent('snapshot', (snap) => useStore.setState((s) => ({ snapshots: { ...s.snapshots, [snap.accountId]: snap } })))
  onEvent('presence', ({ accountId, presence }) =>
    useStore.setState((s) => {
      const snap = s.snapshots[accountId]
      if (!snap) return {}
      return { snapshots: { ...s.snapshots, [accountId]: { ...snap, presence: { ...snap.presence, ...presence } } } }
    })
  )
  void api.getUpdateState().then((update) => useStore.setState({ update }))
  onEvent('update-state', (update) => useStore.setState({ update }))
  onEvent('settings', (settings) => useStore.setState({ settings }))
  onEvent('call-state', (callState) => useStore.setState({ callState }))
  onEvent('typing', (t) => {
    const key = `${t.accountId}|${t.conversationId}`
    useStore.setState((s) => ({ typing: { ...s.typing, [key]: { name: t.name, until: Date.now() + 6000 } } }))
  })
  onEvent('navigate', (n) => {
    const s = useStore.getState()
    // Klick auf eine Mitteilung: die Unterhaltung zeigen, nicht das Einstellungsfenster davor
    if (n.view !== 'settings') s.closeSettings()
    if (n.accountId && n.accountId !== s.activeAccountId && s.accounts.some((a) => a.id === n.accountId)) s.setActiveAccount(n.accountId)
    if (n.view === 'settings') {
      // ⌘ , bei offener Bildansicht oder offenem Dialog: nicht dahinter öffnen, die liegen höher
      if (document.querySelector('.image-viewer, [role="dialog"][aria-modal="true"]:not(.settings-dialog)')) return
      return s.openSettings(n.settingsPage)
    }
    if (n.view === 'teams' && n.conversationId) {
      const snap = useStore.getState().snapshots[n.accountId]
      const team = snap?.teams.find((t) => t.channels.some((c) => c.id === n.conversationId))
      return useStore.getState().select({ chatId: undefined, newChat: false, teamId: team?.id ?? n.teamId, channelId: n.conversationId, focusMessageId: n.messageId }, 'chat')
    }
    if (n.conversationId) {
      const snap = useStore.getState().snapshots[n.accountId]
      const team = snap?.teams.find((t) => t.channels.some((c) => c.id === n.conversationId))
      if (team) return useStore.getState().select({ chatId: undefined, newChat: false, teamId: team.id, channelId: n.conversationId }, 'chat')
      return useStore.getState().select({ chatId: n.conversationId, channelId: undefined, newChat: false, focusMessageId: n.messageId }, 'chat')
    }
    useStore.getState().setView(n.view)
  })
}
