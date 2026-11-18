import type { ApiMethods, EventMap } from '@shared/ipc'

type Api = { [K in keyof ApiMethods]: (...args: Parameters<ApiMethods[K]>) => Promise<Awaited<ReturnType<ApiMethods[K]>>> }

// api.getMessages(accountId, id) statt window.teams.invoke('getMessages', ...)
export const api = new Proxy({} as Api, {
  get: (_t, name: string) => (...args: unknown[]) =>
    (window.teams.invoke as (n: string, ...a: unknown[]) => Promise<unknown>)(name, ...args)
})

export function onEvent<K extends keyof EventMap>(event: K, cb: (p: EventMap[K]) => void): () => void {
  return window.teams.on(event, cb)
}

export function routeInfo(): { path: string; params: URLSearchParams } {
  const h = location.hash.replace(/^#/, '') || '/main'
  const [path, query] = h.split('?')
  return { path, params: new URLSearchParams(query ?? '') }
}
