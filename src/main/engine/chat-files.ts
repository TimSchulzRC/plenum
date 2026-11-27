// Dateien an Chatnachrichten, wie die Teams-Web-App sie schickt: Die Datei geht über die OneDrive-API
// (SharePoint `_api/v2.0`) ins eigene OneDrive (Chats) oder in den Dateiordner des Kanals, wird für die
// Chatmitglieder freigegeben, und die Nachricht verweist in properties.files darauf.
// Ohne Electron-Abhängigkeit, damit die Tests die Datei direkt laden können.

// Ordner im OneDrive, den Teams für Chatdateien anlegt. Der Name hängt von der Sprache ab, in der
// Teams ihn zuerst angelegt hat. Ein vorhandener Ordner gewinnt, sonst der englische.
export const CHAT_FILES_FOLDERS = ['Microsoft Teams-Chatdateien', 'Microsoft Teams Chat Files']

// Bis hierhin ein einzelnes PUT, wie in der Web-App (Quick-Upload), darüber eine Upload-Session
export const SIMPLE_UPLOAD_MAX = 10 * 1024 * 1024
// Teile einer Upload-Session müssen ein Vielfaches von 320 KiB sein
export const CHUNK_BYTES = 320 * 1024 * 32

export interface DriveItem {
  id: string
  name: string
  webUrl?: string
  webDavUrl?: string
  eTag?: string
  size?: number
  parentReference?: { driveId?: string }
  sharepointIds?: { listItemUniqueId?: string; siteUrl?: string }
}

// Aufruf an die SharePoint-Site mit deren Token. Wirft bei Fehlern (mit status).
export interface SiteRequest {
  (url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<any>
}

// PUT an die vorsignierte Upload-Adresse einer Session, ohne Token
export interface ChunkPut {
  (url: string, body: Uint8Array, headers: Record<string, string>): Promise<any>
}

// Wo die Datei landet: Site (mit / am Ende) und Ordner relativ zur Dokumentbibliothek
export interface UploadTarget {
  siteUrl: string
  folder: string
}

export function withSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

// personalFileSite aus chatsvc /v1/users/ME/properties (JSON-String oder Objekt)
export function personalSiteUrl(props: any): string | undefined {
  let site = props?.personalFileSite
  if (typeof site === 'string') {
    try {
      site = JSON.parse(site)
    } catch {
      return undefined
    }
  }
  const url = site?.personalSiteUrl
  return typeof url === 'string' && /^https:\/\//i.test(url) ? withSlash(url) : undefined
}

// Zeichen, die SharePoint in Dateinamen ablehnt, ersetzen
export function driveFileName(name: string): string {
  const clean = name
    .replace(/["*:<>?/\\|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
  return clean || 'Datei'
}

export function fileExtension(name: string): string {
  const m = name.match(/\.([A-Za-z0-9]{1,10})$/)
  return m ? m[1].toLowerCase() : ''
}

// Pfadteile einzeln kodieren, Schrägstriche bleiben
export function encodeDrivePath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((p) => encodeURIComponent(p).replace(/'/g, '%27'))
    .join('/')
}

function itemUrl(target: UploadTarget, name: string): string {
  return `${target.siteUrl}_api/v2.0/drive/root:/${encodeDrivePath(`${target.folder}/${name}`)}:`
}

const SELECT = '$select=*,sharepointIds,webDavUrl'

// Lädt die Datei hoch. Bei gleichem Namen legt OneDrive eine Kopie mit Nummer an.
export async function uploadDriveFile(request: SiteRequest, put: ChunkPut, target: UploadTarget, name: string, data: Uint8Array): Promise<DriveItem> {
  const url = itemUrl(target, driveFileName(name))
  if (data.byteLength <= SIMPLE_UPLOAD_MAX) {
    return (await request(`${url}/content?@name.conflictBehavior=rename&${SELECT}`, {
      method: 'PUT',
      body: data,
      headers: { 'content-type': 'application/octet-stream' }
    })) as DriveItem
  }
  const session = (await request(`${url}/createUploadSession`, {
    method: 'POST',
    body: { item: { '@name.conflictBehavior': 'rename' } }
  })) as { uploadUrl?: string }
  if (!session?.uploadUrl) throw new Error('OneDrive hat keine Upload-Adresse geliefert')
  let last: any
  for (let start = 0; start < data.byteLength; start += CHUNK_BYTES) {
    const end = Math.min(start + CHUNK_BYTES, data.byteLength)
    last = await put(session.uploadUrl, data.subarray(start, end), { 'content-range': `bytes ${start}-${end - 1}/${data.byteLength}` })
  }
  if (!last?.id) throw new Error('OneDrive hat den Upload nicht bestätigt')
  // Die Antwort der Session kennt webDavUrl und sharepointIds nicht
  return (await request(`${target.siteUrl}_api/v2.0/drives/${encodeURIComponent(last.parentReference?.driveId ?? '')}/items/${encodeURIComponent(last.id)}?${SELECT}`)) as DriveItem
}

// GUID der Datei in SharePoint, so referenziert Teams Dateien
export function itemGuid(item: DriveItem): string {
  const fromEtag = item.eTag?.match(/\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?/i)?.[1]
  return (item.sharepointIds?.listItemUniqueId || fromEtag || item.id).toLowerCase()
}

export type InviteRecipient = { objectId: string } | { email: string }

// Empfänger für die Freigabe: Mailadresse, wenn bekannt, sonst die Objekt-ID aus der MRI (8:orgid:<oid>)
export function inviteRecipients(members: { mri: string; email?: string }[]): InviteRecipient[] {
  const out: InviteRecipient[] = []
  for (const m of members) {
    if (m.email) out.push({ email: m.email })
    else {
      const oid = m.mri.match(/^8:orgid:([0-9a-f-]{36})$/i)?.[1]
      if (oid) out.push({ objectId: oid })
    }
  }
  return out
}

// Freigabe für die Chatmitglieder, wie die Web-App sie anlegt. Gibt den Freigabelink zurück.
export async function inviteMembers(request: SiteRequest, siteUrl: string, item: DriveItem, recipients: InviteRecipient[]): Promise<{ shareUrl?: string; shareId?: string }> {
  if (recipients.length === 0) return {}
  const res = await request(`${siteUrl}_api/v2.0/sites/root/items/${encodeURIComponent(itemGuid(item))}/driveItem/invite`, {
    method: 'POST',
    headers: { prefer: 'ReturnSpecificErrorCode,getDefaultLink' },
    body: { recipients, requireSignIn: true, sendInvitation: false }
  })
  const first = Array.isArray(res?.value) ? res.value[0] : undefined
  return { shareUrl: first?.link?.webUrl, shareId: first?.id }
}

// Ein Eintrag für properties.files der Chatnachricht (Feldnamen wie im Serializer der Web-App)
export function filesEntry(item: DriveItem, siteUrl: string, opts: { shareUrl?: string; shareId?: string; channel?: boolean } = {}): Record<string, unknown> {
  const id = itemGuid(item)
  const type = fileExtension(item.name)
  const objectUrl = item.webDavUrl || item.webUrl || ''
  return {
    '@type': 'http://schema.skype.com/File',
    version: 2,
    id,
    baseUrl: siteUrl,
    type,
    title: item.name,
    state: 'active',
    objectUrl,
    providerData: '',
    itemid: id,
    fileName: item.name,
    fileType: type,
    fileInfo: {
      itemId: item.id,
      fileUrl: objectUrl,
      siteUrl,
      serverRelativeUrl: '',
      shareUrl: opts.shareUrl ?? null,
      shareId: opts.shareId ?? null
    },
    botFileProperties: {},
    filePreview: {},
    fileChicletState: { serviceName: opts.channel ? 'teams' : 'p2p', state: 'active' }
  }
}
