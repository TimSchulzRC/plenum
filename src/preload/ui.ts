// Preload für alle eigenen Fenster (Hauptfenster, Anruf, Pop-out, eingehender Anruf).
import { contextBridge, ipcRenderer } from 'electron'
import type { TeamsBridge } from '@shared/ipc'
import type { BridgeMessage } from '@shared/types'

const listeners = new Map<string, Set<(p: unknown) => void>>()
ipcRenderer.on('event', (_e, name: string, payload: unknown) => {
  const set = listeners.get(name)
  if (set) for (const cb of set) cb(payload)
})

const bridge: TeamsBridge & { setFocusContext(ctx: { accountId?: string; conversationId?: string }): void } = {
  invoke: ((name: string, ...args: unknown[]) => ipcRenderer.invoke('api', name, ...args)) as TeamsBridge['invoke'],
  on: ((event: string, cb: (p: unknown) => void) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event)!.add(cb)
    return () => listeners.get(event)?.delete(cb)
  }) as TeamsBridge['on'],
  bridgeSend: (msg: BridgeMessage) => ipcRenderer.send('bridge:send', msg),
  webContentsId: 0,
  platform: process.platform,
  route: '',
  setFocusContext: (ctx) => ipcRenderer.send('focus-context', ctx)
}

contextBridge.exposeInMainWorld('teams', bridge)
