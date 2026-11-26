import { useEffect } from 'react'
import { create } from 'zustand'
import { api } from '../api'
import { useStore } from '../store'

// Ungelesene Mails im Posteingang je Konto, für die Zahl an „E-Mail“ in der Seitenleiste.
export const useMailUnread = create<{ counts: Record<string, number> }>(() => ({ counts: {} }))

export function setMailUnread(accountId: string, n: number): void {
  useMailUnread.setState((s) => (s.counts[accountId] === n ? s : { counts: { ...s.counts, [accountId]: n } }))
}

// Alle zwei Minuten nachsehen, und sobald ein Konto verbunden ist. Gastmandanten haben kein Postfach.
export function useMailUnreadPolling(): void {
  const key = useStore((s) => s.accounts.filter((a) => !a.parentId && a.status === 'ready').map((a) => a.id).join(','))
  useEffect(() => {
    const ids = key.split(',').filter(Boolean)
    const poll = () => {
      for (const id of ids) void api.getMailUnread(id).then((n) => n !== null && setMailUnread(id, n)).catch(() => {})
    }
    poll()
    const t = setInterval(poll, 120_000)
    return () => clearInterval(t)
  }, [key])
}
