import type { TeamsBridge } from '../shared/ipc'

declare global {
  interface Window {
    teams: TeamsBridge & { setFocusContext(ctx: { accountId?: string; conversationId?: string }): void }
  }
}
export {}
