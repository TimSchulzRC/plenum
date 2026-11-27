import type { MailSignatures, OutlookSignature } from '@shared/types'

// Signaturen aus Outlook (Roaming-Signaturen). Eine offizielle API gibt es dafür nicht, auch nicht in Graph.
// Outlook im Web lädt sie aus seinen Einstellungen (OWS): erst die Liste der Namen und die beiden Standards,
// dann die Texte. Die App macht es genauso.
const SETTINGS = 'https://outlook.office.com/ows/v1/OutlookCloudSettings/settings/account'
const LIST = 'roaming_signature_list'
const NEW = 'roaming_new_signature'
const REPLY = 'roaming_reply_signature'

export const signatureListUrl = (): string => `${SETTINGS}?settingname=${[LIST, NEW, REPLY].join(',')}`
export const signatureBodiesUrl = (names: string[]): string => `${SETTINGS}?settingname=${names.map(encodeURIComponent).join(',')}`

interface Setting {
  name?: unknown
  value?: unknown
  secondaryKey?: unknown
  nameBase64Encoded?: unknown
}
// OWS antwortet mit einem Array. Alles andere (Anmeldeseite, Fehlerobjekt) ist keine leere Liste, sonst
// überschriebe es die zuletzt geladene Fassung.
function settings(res: unknown): Setting[] {
  if (!Array.isArray(res)) throw new Error('Unerwartete Antwort von Outlook')
  return res.filter((x): x is Setting => !!x && typeof x === 'object')
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
// Outlook schreibt die Namen der Einstellungen mal klein, mal groß
const key = (name: string): string => name.trim().toLowerCase()

// Namen aus roaming_signature_list. Eine Signatur kommt als einfacher Text. Mehrere setzt Outlook im Web mit
// Kommas getrennt in settingname ein, ein JSON-Array nimmt die App auch.
export function signatureNames(value: unknown): string[] {
  let list = value
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      list = JSON.parse(value)
    } catch {
      // doch ein Name
    }
  }
  const names = Array.isArray(list) ? list.map(str) : str(list).split(',')
  const seen = new Set<string>()
  return names
    .map((n) => n.trim())
    .filter((n) => {
      if (!n || seen.has(key(n))) return false
      seen.add(key(n))
      return true
    })
}

// Antwort auf signatureListUrl: Namen und die Standards für neue Mails und für Antworten
export function parseSignatureList(res: unknown): { names: string[]; newDefault?: string; replyDefault?: string } {
  const by = new Map(settings(res).map((s) => [key(str(s.name)), s.value]))
  let names = signatureNames(by.get(LIST))
  // Ohne Liste wenigstens die Standards
  if (!names.length) names = signatureNames([str(by.get(NEW)), str(by.get(REPLY))])
  const pick = (v: unknown) => names.find((n) => key(n) === key(str(v)))
  return { names, newDefault: pick(by.get(NEW)), replyDefault: pick(by.get(REPLY)) }
}

// Antwort auf signatureBodiesUrl: je Signatur HTML (secondaryKey htm, Bilder als data:) und Text (txt).
// Ohne beides fällt eine Signatur weg.
export function parseSignatureBodies(res: unknown, names: string[]): OutlookSignature[] {
  const html = new Map<string, string>()
  const text = new Map<string, string>()
  const known = new Set(names.map(key))
  for (const s of settings(res)) {
    let name = str(s.name)
    // Die Antwort markiert die Namen als Base64 (nameBase64Encoded), live kamen sie trotzdem im Klartext.
    // Deshalb nur dekodieren, wenn der Name sonst fehlt.
    if (s.nameBase64Encoded === true && !known.has(key(name))) {
      const decoded = Buffer.from(name, 'base64').toString('utf8')
      if (known.has(key(decoded))) name = decoded
    }
    const kind = key(str(s.secondaryKey))
    if (kind === 'htm') html.set(key(name), str(s.value))
    else if (kind === 'txt') text.set(key(name), str(s.value))
  }
  return names.map((name) => ({ name, html: html.get(key(name)) ?? '', text: text.get(key(name)) ?? '' })).filter((s) => s.html.trim() || s.text.trim())
}

// Beides zusammen. Ein Standard ohne Text gilt als nicht gesetzt.
export function mailSignatures(list: ReturnType<typeof parseSignatureList>, bodies: OutlookSignature[], at = Date.now()): MailSignatures {
  const has = (n?: string) => (n && bodies.some((s) => s.name === n) ? n : undefined)
  return { list: bodies, newDefault: has(list.newDefault), replyDefault: has(list.replyDefault), at }
}
