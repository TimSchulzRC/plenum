// Dateien an Chatnachrichten: Die Datei geht über Graph ins eigene OneDrive (Chats) oder in den
// Dateiordner des Kanals, wird im Chat für die Mitglieder freigegeben, und die Nachricht verweist in
// properties.files darauf, mit denselben Feldern wie in der Teams-Web-App. Deren Graph-Token darf das
// (Files.ReadWrite.All, Sites.ReadWrite.All).
// Ohne Electron-Abhängigkeit, damit die Tests die Datei direkt laden können.

export const GRAPH = 'https://graph.microsoft.com/v1.0'

// Ordner im OneDrive, den Teams für Chatdateien anlegt. Der Name hängt von der Sprache ab, in der
// Teams ihn zuerst angelegt hat. Ein vorhandener Ordner gewinnt, sonst der erste.
export const CHAT_FILES_FOLDERS = ['Microsoft Teams-Chatdateien', 'Microsoft Teams Chat Files']

// Bis hierhin ein einzelnes PUT, darüber eine Upload-Session in Teilen (eigene Wahl: kleine Anfragen
// lassen sich bei schlechter Verbindung eher durchbringen)
export const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024
// Teile einer Upload-Session müssen ein Vielfaches von 320 KiB sein
export const CHUNK_BYTES = 320 * 1024 * 32

const ITEM_FIELDS = '$select=id,name,webUrl,webDavUrl,eTag,size,parentReference,sharepointIds'

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

// Graph-Aufruf mit dem Token der Web-App. Wirft bei Fehlern (mit status).
export interface GraphRequest {
  (url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<any>
}

// Aufruf an die vorsignierte Adresse einer Upload-Session, ohne Token
export interface SessionRequest {
  (url: string, init: { method: string; body?: Uint8Array; headers?: Record<string, string> }): Promise<any>
}

// Zielordner als Graph-Adresse: ein Ordner per ID (Kanal) oder ein Pfad unter der OneDrive-Wurzel (Chat)
export type UploadTarget = { driveId: string; folderId: string } | { rootPath: string }

// Zeichen, die OneDrive in Dateinamen ablehnt, ersetzen
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

export function itemAddress(target: UploadTarget, name: string): string {
  if ('rootPath' in target) return `${GRAPH}/me/drive/root:/${encodeDrivePath(`${target.rootPath}/${name}`)}:`
  return `${GRAPH}/drives/${encodeURIComponent(target.driveId)}/items/${encodeURIComponent(target.folderId)}:/${encodeDrivePath(name)}:`
}

// Chatordner im OneDrive: der vorhandene, sonst wird der erste angelegt (eine Upload-Session braucht
// einen vorhandenen Ordner)
export async function chatFilesTarget(graph: GraphRequest): Promise<UploadTarget> {
  for (const folder of CHAT_FILES_FOLDERS) {
    try {
      await graph(`${GRAPH}/me/drive/root:/${encodeDrivePath(folder)}?$select=id`)
      return { rootPath: folder }
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e
    }
  }
  try {
    await graph(`${GRAPH}/me/drive/root/children`, {
      method: 'POST',
      body: { name: CHAT_FILES_FOLDERS[0], folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }
    })
  } catch (e) {
    // Inzwischen angelegt (etwa von Teams selbst): auch gut
    if ((e as { status?: number }).status !== 409) throw e
  }
  return { rootPath: CHAT_FILES_FOLDERS[0] }
}

// Dateiordner eines Kanals (liegt in der SharePoint-Site des Teams bzw. des privaten Kanals)
export async function channelFilesTarget(graph: GraphRequest, groupId: string, channelId: string): Promise<UploadTarget> {
  const f = (await graph(`${GRAPH}/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/filesFolder?$select=id,parentReference`)) as DriveItem
  if (!f?.id || !f.parentReference?.driveId) throw new Error('Teams hat für diesen Kanal keinen Dateiordner geliefert')
  return { driveId: f.parentReference.driveId, folderId: f.id }
}

// Lädt die Datei hoch. Bei gleichem Namen legt OneDrive eine Kopie mit Nummer an.
export async function uploadDriveFile(graph: GraphRequest, session: SessionRequest, target: UploadTarget, name: string, data: Uint8Array): Promise<DriveItem> {
  const url = itemAddress(target, driveFileName(name))
  let done: DriveItem
  if (data.byteLength <= SIMPLE_UPLOAD_MAX) {
    done = (await graph(`${url}/content?@microsoft.graph.conflictBehavior=rename`, {
      method: 'PUT',
      body: data,
      headers: { 'content-type': 'application/octet-stream' }
    })) as DriveItem
  } else {
    const created = (await graph(`${url}/createUploadSession`, {
      method: 'POST',
      body: { item: { '@microsoft.graph.conflictBehavior': 'rename' } }
    })) as { uploadUrl?: string }
    const uploadUrl = created?.uploadUrl
    if (!uploadUrl) throw new Error('OneDrive hat keine Upload-Adresse geliefert')
    let last: any
    try {
      for (let start = 0; start < data.byteLength; start += CHUNK_BYTES) {
        const end = Math.min(start + CHUNK_BYTES, data.byteLength)
        last = await session(uploadUrl, { method: 'PUT', body: data.subarray(start, end), headers: { 'content-range': `bytes ${start}-${end - 1}/${data.byteLength}` } })
      }
    } catch (e) {
      // Sonst belegt ein leerer Platzhalter den Dateinamen
      await session(uploadUrl, { method: 'DELETE' }).catch(() => undefined)
      throw e
    }
    done = last as DriveItem
  }
  const driveId = done?.parentReference?.driveId
  if (!done?.id || !driveId) throw new Error('OneDrive hat den Upload nicht bestätigt')
  // Die Upload-Antwort kennt webDavUrl und sharepointIds nicht
  return (await graph(`${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(done.id)}?${ITEM_FIELDS}`)) as DriveItem
}

// GUID der Datei in SharePoint, so referenziert Teams Dateien
export function itemGuid(item: DriveItem): string {
  const fromEtag = item.eTag?.match(/\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?/i)?.[1]
  return (item.sharepointIds?.listItemUniqueId || fromEtag || item.id).toLowerCase()
}

export type InviteRecipient = { objectId: string } | { email: string }

// Empfänger der Freigabe: Mailadresse, wenn bekannt, sonst die Objekt-ID aus der MRI (8:orgid:<oid>)
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

// Freigabe für die Chatmitglieder ohne Mail an sie. Teams gibt Chatdateien zum Bearbeiten frei.
export async function inviteMembers(graph: GraphRequest, item: DriveItem, recipients: InviteRecipient[]): Promise<{ shareUrl?: string; shareId?: string }> {
  if (recipients.length === 0) return {}
  const res = await graph(`${GRAPH}/drives/${encodeURIComponent(item.parentReference?.driveId ?? '')}/items/${encodeURIComponent(item.id)}/invite`, {
    method: 'POST',
    body: { recipients, roles: ['write'], requireSignIn: true, sendInvitation: false }
  })
  // Bei Teilerfolg (207) steht der Fehler je Empfänger in value
  const results: any[] = Array.isArray(res?.value) ? res.value : []
  const failed = results.find((r) => r?.error)
  if (failed) throw new Error(failed.error.message || failed.error.code || 'Freigabe fehlgeschlagen')
  const first = results[0]
  return { shareUrl: first?.link?.webUrl, shareId: first?.id }
}

// Basis der Website (OneDrive oder Team-Site) mit Schrägstrich am Ende
export function siteBase(item: DriveItem): string {
  const site = item.sharepointIds?.siteUrl
  if (site) return site.endsWith('/') ? site : `${site}/`
  const m = (item.webUrl ?? '').match(/^(https:\/\/[^/]+\/(?:personal|sites|teams)\/[^/]+\/)/i)
  return m ? m[1] : ''
}

// Ein Eintrag für properties.files der Chatnachricht (Feldnamen wie im Serializer der Web-App)
export function filesEntry(item: DriveItem, opts: { shareUrl?: string; shareId?: string; channel?: boolean } = {}): Record<string, unknown> {
  const id = itemGuid(item)
  const type = fileExtension(item.name)
  // Kodiert wie bei Teams (Leerzeichen als %20)
  const objectUrl = item.webDavUrl || item.webUrl || ''
  const baseUrl = siteBase(item)
  return {
    '@type': 'http://schema.skype.com/File',
    version: 2,
    id,
    baseUrl,
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
      siteUrl: baseUrl,
      serverRelativeUrl: '',
      shareUrl: opts.shareUrl ?? null,
      shareId: opts.shareId ?? null
    },
    botFileProperties: {},
    filePreview: {},
    fileChicletState: { serviceName: opts.channel ? 'teams' : 'p2p', state: 'active' }
  }
}
