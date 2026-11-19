// Bilder in Chatnachrichten über den Async Media Service (AMS) von Teams hochladen, wie es die
// Web-App tut: Objekt anlegen, Bytes hochladen, im HTML auf die Ansicht "imgo" verweisen.
// Ohne Electron-Abhängigkeit, damit die Tests die Datei direkt laden können.

export const AMS_BASE = 'https://as-prod.asyncgw.teams.microsoft.com'

// Größer lässt die Teams-Web-App eingefügte Bilder auch nicht zu.
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp'
}

// <img ... src="data:image/png;base64,..." ...> aus dem Eingabefeld
const DATA_IMG = /<img\b[^>]*?\bsrc="data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]*)"[^>]*>/gi

export interface AmsRequest {
  (url: string, init: { method: string; headers: Record<string, string>; body: unknown; raw?: boolean }): Promise<{ id?: string } | unknown>
}

function attr(tag: string, name: string): number | undefined {
  const m = tag.match(new RegExp(`\\b${name}="(\\d+)"`, 'i'))
  const n = m ? Number(m[1]) : NaN
  return n > 0 ? n : undefined
}

export function amsImageTag(id: string, width?: number, height?: number): string {
  const src = `${AMS_BASE}/v1/objects/${encodeURIComponent(id)}/views/imgo`
  const size = width && height ? ` width="${width}" height="${height}"` : ''
  const style = width && height ? `vertical-align:bottom; width:${width}px; height:${height}px` : 'vertical-align:bottom'
  return `<img src="${src}"${size} id="x_${id}" itemscope="" itemtype="http://schema.skype.com/AMSImage" itemid="${id}" style="${style}">`
}

export async function uploadAmsImage(request: AmsRequest, skypeToken: string, conversationId: string, data: Uint8Array, mime: string): Promise<string> {
  const auth = { authorization: `skype_token ${skypeToken}` }
  const filename = `image.${MIME_EXT[mime] ?? 'png'}`
  const created = (await request(`${AMS_BASE}/v1/objects/`, {
    method: 'POST',
    headers: { ...auth, accept: 'application/json' },
    body: { type: 'pish/image', permissions: { [conversationId]: ['read'] }, filename, sharingMode: 'Inline' }
  })) as { id?: unknown }
  const id = typeof created?.id === 'string' ? created.id : ''
  if (!id) throw new Error('Teams hat für das Bild keine ID vergeben')
  await request(`${AMS_BASE}/v1/objects/${encodeURIComponent(id)}/content/imgpsh`, {
    method: 'PUT',
    headers: { ...auth, accept: '*/*', 'content-type': 'application/octet-stream' },
    body: data,
    raw: true
  })
  return id
}

// Ersetzt eingebettete data:-Bilder durch hochgeladene AMS-Bilder. Gibt das neue HTML und die
// Objekt-IDs für amsreferences zurück.
export async function replaceInlineImages(
  html: string,
  upload: (data: Uint8Array, mime: string) => Promise<string>
): Promise<{ html: string; ids: string[] }> {
  const found = [...html.matchAll(DATA_IMG)]
  if (found.length === 0) return { html, ids: [] }
  const ids: string[] = []
  const tags: string[] = []
  for (const m of found) {
    const mime = m[1].toLowerCase()
    if (!MIME_EXT[mime]) throw new Error(`Bildformat ${mime} wird nicht unterstützt`)
    const data = Buffer.from(m[2].replace(/\s+/g, ''), 'base64')
    if (data.length === 0) throw new Error('Das Bild ist leer')
    if (data.length > MAX_IMAGE_BYTES) throw new Error('Das Bild ist größer als 25 MB')
    const id = await upload(data, mime)
    ids.push(id)
    tags.push(amsImageTag(id, attr(m[0], 'width'), attr(m[0], 'height')))
  }
  let i = 0
  return { html: html.replace(DATA_IMG, () => tags[i++]), ids }
}

// IDs der AMS-Bilder, die schon in einer Nachricht stehen (beim Bearbeiten wieder mitschicken)
export function amsImageIds(html: string): string[] {
  const ids: string[] = []
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    if (!/itemtype="http:\/\/schema\.skype\.com\/AMSImage"/i.test(m[0])) continue
    const id = m[0].match(/\bitemid="([^"]+)"/i)?.[1]
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}
