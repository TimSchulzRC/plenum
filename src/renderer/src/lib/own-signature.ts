import type { MailMessage, OwnSignature } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { ownSignature } from './mail-html'

// So viele gesendete Mails liest die App, um die eigene Signatur zu finden. Nacheinander, Exchange
// drosselt schon bei wenigen gleichzeitigen Anfragen je Postfach.
const SENT_MAILS = 5
const running = new Map<string, Promise<OwnSignature>>()

// Signatur eines Kontos aus „Gesendete Elemente“ lesen und in den Einstellungen speichern. Läuft je
// Konto nur einmal gleichzeitig. Ohne gesendete Mails oder ohne erkennbare Signatur bleibt sie leer.
export function learnOwnSignature(accountId: string): Promise<OwnSignature> {
  const cur = running.get(accountId)
  if (cur) return cur
  const p = (async (): Promise<OwnSignature> => {
    const folders = await api.getMailFolders(accountId)
    const sent = folders.find((f) => f.kind === 'sentitems')
    const mails: MailMessage[] = []
    if (sent) {
      const page = await api.listMail(accountId, sent.id)
      for (const item of page.items.filter((x) => !x.isDraft).slice(0, SENT_MAILS)) mails.push(await api.getMail(accountId, item.id))
    }
    const found = ownSignature(mails)
    const value: OwnSignature = { html: found?.html ?? '', text: found?.text ?? '', source: 'sent', at: Date.now() }
    const all = useStore.getState().settings?.mailSignatures ?? {}
    await api.setSettings({ mailSignatures: { ...all, [accountId]: value } })
    return value
  })().finally(() => running.delete(accountId))
  running.set(accountId, p)
  return p
}

// Signatur nicht mehr anhängen, bis sie neu gelesen wird
export async function disableOwnSignature(accountId: string): Promise<void> {
  const all = useStore.getState().settings?.mailSignatures ?? {}
  await api.setSettings({ mailSignatures: { ...all, [accountId]: { html: '', text: '', source: 'off', at: Date.now() } } })
}
