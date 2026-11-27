import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  channelFilesTarget,
  chatFilesTarget,
  CHUNK_BYTES,
  driveFileName,
  encodeDrivePath,
  filesEntry,
  GRAPH,
  inviteMembers,
  inviteRecipients,
  SIMPLE_UPLOAD_MAX,
  uploadDriveFile
} from '../src/main/engine/chat-files.ts'

const SITE = 'https://contoso-my.sharepoint.com/personal/erika_contoso_com/'
const GUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const ITEM = {
  id: '01ABCDEF',
  name: 'Angebot Nord.pdf',
  webUrl: `${SITE}Documents/Microsoft%20Teams-Chatdateien/Angebot%20Nord.pdf`,
  webDavUrl: `${SITE}Documents/Microsoft%20Teams-Chatdateien/Angebot%20Nord.pdf`,
  eTag: `"{${GUID.toUpperCase()}},1"`,
  parentReference: { driveId: 'b!drive' },
  sharepointIds: { listItemUniqueId: GUID, siteUrl: SITE.slice(0, -1) }
}
const SELECT = '$select=id,name,webUrl,webDavUrl,eTag,size,parentReference,sharepointIds'
const notFound = () => Object.assign(new Error('graph 404'), { status: 404 })

test('Chatordner: der vorhandene gewinnt, sonst der deutsche, andere Fehler gehen durch', async () => {
  const asked: string[] = []
  assert.deepEqual(
    await chatFilesTarget(async (url) => {
      asked.push(url)
      if (url.includes('Chatdateien')) throw notFound()
      return { id: 'x' }
    }),
    { rootPath: 'Microsoft Teams Chat Files' }
  )
  assert.deepEqual(asked, [`${GRAPH}/me/drive/root:/Microsoft%20Teams-Chatdateien?$select=id`, `${GRAPH}/me/drive/root:/Microsoft%20Teams%20Chat%20Files?$select=id`])
  assert.deepEqual(await chatFilesTarget(async () => ({ id: 'x' })), { rootPath: 'Microsoft Teams-Chatdateien' })
  // Keiner da: der deutsche wird angelegt, sonst scheitert eine Upload-Session am fehlenden Ordner
  const created: any[] = []
  assert.deepEqual(
    await chatFilesTarget(async (url, init) => {
      if (init?.method === 'POST') return created.push({ url, body: init.body })
      throw notFound()
    }),
    { rootPath: 'Microsoft Teams-Chatdateien' }
  )
  assert.deepEqual(created, [{ url: `${GRAPH}/me/drive/root/children`, body: { name: 'Microsoft Teams-Chatdateien', folder: {}, '@microsoft.graph.conflictBehavior': 'fail' } }])
  // Gleichzeitig angelegt (409): kein Fehler
  assert.deepEqual(
    await chatFilesTarget(async (_url, init) => {
      throw init?.method === 'POST' ? Object.assign(new Error('graph 409'), { status: 409 }) : notFound()
    }),
    { rootPath: 'Microsoft Teams-Chatdateien' }
  )
  await assert.rejects(
    chatFilesTarget(async () => {
      throw Object.assign(new Error('graph 401'), { status: 401 })
    }),
    /401/
  )
})

test('Kanalordner kommt aus filesFolder des Kanals', async () => {
  let asked = ''
  const target = await channelFilesTarget(
    async (url) => {
      asked = url
      return { id: 'folder1', parentReference: { driveId: 'b!team' } }
    },
    'group-1',
    '19:abc@thread.tacv2'
  )
  assert.equal(asked, `${GRAPH}/teams/group-1/channels/19%3Aabc%40thread.tacv2/filesFolder?$select=id,parentReference`)
  assert.deepEqual(target, { driveId: 'b!team', folderId: 'folder1' })
  await assert.rejects(channelFilesTarget(async () => ({}), 'g', 'c'), /keinen Dateiordner/)
})

test('Dateinamen ohne Zeichen, die OneDrive ablehnt, Pfade teilweise kodiert', () => {
  assert.equal(driveFileName('a:b*c?.pdf'), 'a_b_c_.pdf')
  assert.equal(driveFileName('..versteckt.'), 'versteckt')
  assert.equal(driveFileName('   '), 'Datei')
  assert.equal(encodeDrivePath("Microsoft Teams Chat Files/Bericht #1 & Co's.pdf"), 'Microsoft%20Teams%20Chat%20Files/Bericht%20%231%20%26%20Co%27s.pdf')
})

test('Kleine Dateien gehen mit einem PUT in den Ordner, gleicher Name wird umbenannt', async () => {
  const calls: { url: string; init?: any }[] = []
  const data = new Uint8Array([1, 2, 3])
  const item = await uploadDriveFile(
    async (url, init) => {
      calls.push({ url, init })
      return init?.method === 'PUT' ? { id: '01ABCDEF', name: 'Angebot Nord.pdf', parentReference: { driveId: 'b!drive' } } : ITEM
    },
    async () => assert.fail('keine Upload-Session erwartet'),
    { rootPath: 'Microsoft Teams-Chatdateien' },
    'Angebot Nord.pdf',
    data
  )
  assert.equal(item, ITEM)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, `${GRAPH}/me/drive/root:/Microsoft%20Teams-Chatdateien/Angebot%20Nord.pdf:/content?@microsoft.graph.conflictBehavior=rename`)
  assert.equal(calls[0].init.method, 'PUT')
  assert.equal(calls[0].init.body, data)
  assert.equal(calls[1].url, `${GRAPH}/drives/b!drive/items/01ABCDEF?${SELECT}`)
})

test('Große Dateien laufen über eine Upload-Session in Teilen, im Kanal per Ordner-ID', async () => {
  const size = SIMPLE_UPLOAD_MAX + CHUNK_BYTES + 5
  const data = new Uint8Array(size)
  const requests: { url: string; init?: any }[] = []
  const ranges: string[] = []
  let received = 0
  const item = await uploadDriveFile(
    async (url, init) => {
      requests.push({ url, init })
      if (url.endsWith('/createUploadSession')) return { uploadUrl: 'https://contoso.sharepoint.com/upload?tempauth=x' }
      return ITEM
    },
    async (url, body, headers) => {
      assert.equal(url, 'https://contoso.sharepoint.com/upload?tempauth=x')
      ranges.push(headers['content-range'])
      received += body.byteLength
      return received === size ? { id: '01ABCDEF', parentReference: { driveId: 'b!team' } } : { nextExpectedRanges: [`${received}-`] }
    },
    { driveId: 'b!team', folderId: 'folder1' },
    'gross.zip',
    data
  )
  assert.equal(received, size)
  assert.equal(ranges.length, Math.ceil(size / CHUNK_BYTES))
  assert.equal(ranges[0], `bytes 0-${CHUNK_BYTES - 1}/${size}`)
  assert.equal(ranges.at(-1), `bytes ${CHUNK_BYTES * (ranges.length - 1)}-${size - 1}/${size}`)
  assert.equal(requests[0].url, `${GRAPH}/drives/b!team/items/folder1:/gross.zip:/createUploadSession`)
  assert.deepEqual(requests[0].init.body, { item: { '@microsoft.graph.conflictBehavior': 'rename' } })
  assert.equal(requests[1].url, `${GRAPH}/drives/b!team/items/01ABCDEF?${SELECT}`)
  assert.equal(item, ITEM)
})

test('Freigabe geht an die Chatmitglieder: Mail, wenn bekannt, sonst Objekt-ID', async () => {
  const recipients = inviteRecipients([
    { mri: '8:orgid:11111111-2222-3333-4444-555555555555' },
    { mri: '8:orgid:66666666-2222-3333-4444-555555555555', email: 'max@contoso.com' },
    { mri: '28:bot-id' }
  ])
  assert.deepEqual(recipients, [{ objectId: '11111111-2222-3333-4444-555555555555' }, { email: 'max@contoso.com' }])

  let call: { url: string; init?: any } | undefined
  const share = await inviteMembers(
    async (url, init) => {
      call = { url, init }
      return { value: [{ id: 'perm1', link: { webUrl: 'https://contoso-my.sharepoint.com/:b:/g/personal/x/abc' } }] }
    },
    ITEM,
    recipients
  )
  assert.equal(call!.url, `${GRAPH}/drives/b!drive/items/01ABCDEF/invite`)
  assert.equal(call!.init.method, 'POST')
  assert.deepEqual(call!.init.body, { recipients, roles: ['write'], requireSignIn: true, sendInvitation: false })
  assert.deepEqual(share, { shareUrl: 'https://contoso-my.sharepoint.com/:b:/g/personal/x/abc', shareId: 'perm1' })

  // Teilerfolg (207): ein Empfänger ohne Freigabe bricht ab
  await assert.rejects(
    inviteMembers(async () => ({ value: [{ id: 'perm1' }, { error: { code: 'notAllowed', message: 'Externe Freigabe ist gesperrt' } }] }), ITEM, recipients),
    /Externe Freigabe ist gesperrt/
  )

  // Notizen an mich selbst: niemand zum Freigeben, kein Aufruf
  assert.deepEqual(await inviteMembers(async () => assert.fail('kein Aufruf erwartet'), ITEM, []), {})
})

test('properties.files-Eintrag wie von der Web-App', () => {
  const e = filesEntry(ITEM, { shareUrl: 'https://s', shareId: 'perm1' })
  const objectUrl = `${SITE}Documents/Microsoft Teams-Chatdateien/Angebot Nord.pdf`
  assert.equal(e['@type'], 'http://schema.skype.com/File')
  assert.equal(e.version, 2)
  assert.equal(e.id, GUID)
  assert.equal(e.itemid, GUID)
  assert.equal(e.baseUrl, SITE)
  assert.equal(e.objectUrl, objectUrl)
  assert.equal(e.type, 'pdf')
  assert.equal(e.fileType, 'pdf')
  assert.equal(e.title, 'Angebot Nord.pdf')
  assert.equal(e.fileName, 'Angebot Nord.pdf')
  assert.equal(e.state, 'active')
  assert.deepEqual(e.fileInfo, { itemId: '01ABCDEF', fileUrl: objectUrl, siteUrl: SITE, serverRelativeUrl: '', shareUrl: 'https://s', shareId: 'perm1' })
  assert.deepEqual(e.fileChicletState, { serviceName: 'p2p', state: 'active' })
  assert.equal((filesEntry(ITEM, { channel: true }).fileChicletState as any).serviceName, 'teams')
  // Ohne sharepointIds: GUID aus dem eTag, Site aus der Adresse
  const bare = filesEntry({ ...ITEM, sharepointIds: undefined })
  assert.equal(bare.itemid, GUID)
  assert.equal(bare.baseUrl, SITE)
})
