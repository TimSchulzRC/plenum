import { useEffect, useState } from 'react'
import type { MailSignatures, OutlookSignature } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store'

// Signaturen aus Outlook. Die zuletzt geladene Fassung steht in den Einstellungen (mailSignatures), beim
// Verfassen lädt die App sie neu. Gleichzeitige Abrufe eines Kontos teilen sich einen.
const running = new Map<string, Promise<MailSignatures>>()

export function refreshSignatures(accountId: string): Promise<MailSignatures> {
  const cur = running.get(accountId)
  if (cur) return cur
  const p = api.loadMailSignatures(accountId).finally(() => running.delete(accountId))
  running.set(accountId, p)
  return p
}

// Ältere Einstellungen haben unter mailSignatures noch die aus gesendeten Mails gelesene Signatur
const valid = (v: unknown): MailSignatures | undefined => (v && Array.isArray((v as MailSignatures).list) ? (v as MailSignatures) : undefined)

export type SignatureStatus = 'loading' | 'done' | 'error'

// Signaturen eines Kontos: gespeicherte Fassung sofort, die aus Outlook sobald geladen
export function useMailSignatures(accountId: string, enabled = true): { sigs?: MailSignatures; status: SignatureStatus; retry: () => void } {
  const sigs = useStore((s) => valid(s.settings?.mailSignatures?.[accountId]))
  const [status, setStatus] = useState<SignatureStatus>('loading')
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    setStatus('loading')
    refreshSignatures(accountId).then(
      () => alive && setStatus('done'),
      () => alive && setStatus('error')
    )
    return () => {
      alive = false
    }
  }, [accountId, enabled, tick])
  return { sigs, status, retry: () => setTick((t) => t + 1) }
}

export function findSignature(sigs: MailSignatures | undefined, name: string | null | undefined): OutlookSignature | undefined {
  return name ? sigs?.list.find((s) => s.name === name) : undefined
}

// Wie in Outlook: neue Mails bekommen den einen Standard, Antworten und Weiterleitungen den anderen
export function defaultSignature(sigs: MailSignatures | undefined, reply: boolean): OutlookSignature | undefined {
  return findSignature(sigs, reply ? sigs?.replyDefault : sigs?.newDefault)
}
