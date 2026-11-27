import type { MailMessage, OwnSignature } from '@shared/types'
import { api } from '../api'
import { ownSignature } from './mail-html'
import { withImages } from './mail'
import { loadImages, loadMail } from './mail-load'

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
      // Mit den eingebetteten Bildern, sonst fehlte das Logo
      for (const item of page.items.filter((x) => !x.isDraft).slice(0, SENT_MAILS)) {
        const m = await loadMail(accountId, item.id)
        mails.push(withImages(m, await loadImages(m).catch(() => undefined)))
      }
    }
    const found = ownSignature(mails)
    const value: OwnSignature = { html: found?.html ?? '', text: found?.text ?? '', source: 'sent', at: Date.now() }
    // Der Hauptprozess führt die Konten zusammen
    await api.setSettings({ mailSignatures: { [accountId]: value } })
    return value
  })().finally(() => running.delete(accountId))
  running.set(accountId, p)
  return p
}

// Gefundene Signatur übernehmen: ab jetzt hängt sie an neue Mails und Antworten
export async function confirmOwnSignature(accountId: string, own: OwnSignature): Promise<void> {
  await api.setSettings({ mailSignatures: { [accountId]: { ...own, confirmed: true } } })
}

// Signatur nicht mehr anhängen, bis sie neu gelesen wird
export async function disableOwnSignature(accountId: string): Promise<void> {
  await api.setSettings({ mailSignatures: { [accountId]: { html: '', text: '', source: 'off', at: Date.now() } } })
}
