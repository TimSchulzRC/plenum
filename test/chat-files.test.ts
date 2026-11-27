import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CHUNK_BYTES,
  driveFileName,
  encodeDrivePath,
  filesEntry,
  inviteMembers,
  inviteRecipients,
  personalSiteUrl,
  SIMPLE_UPLOAD_MAX,
  uploadDriveFile
} from '../src/main/engine/chat-files.ts'
import { isTokenAudience } from '../src/main/engine/hosts.ts'
import { parseRedirect, silentRequest, tokenRequestBody } from '../src/main/engine/silent-token.ts'

const SITE = 'https://contoso-my.sharepoint.com/personal/erika_contoso_com/'
const TARGET = { siteUrl: SITE, folder: 'Microsoft Teams Chat Files' }
const GUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const ITEM = {
  id: '01ABCDEF',
  name: 'Angebot Nord.pdf',
  webUrl: `${SITE}Documents/Microsoft%20Teams%20Chat%20Files/Angebot%20Nord.pdf`,
  webDavUrl: `${SITE}Documents/Microsoft Teams Chat Files/Angebot Nord.pdf`,
  eTag: `"{${GUID.toUpperCase()}},1"`,
  parentReference: { driveId: 'b!drive' },
  sharepointIds: { listItemUniqueId: GUID, siteUrl: SITE.slice(0, -1) }
}

test('OneDrive-Adresse kommt aus personalFileSite, als JSON-String oder Objekt', () => {
  assert.equal(personalSiteUrl({ personalFileSite: JSON.stringify({ personalSiteUrl: SITE.slice(0, -1), personalRootFolderUrl: 'x' }) }), SITE)
  assert.equal(personalSiteUrl({ personalFileSite: { personalSiteUrl: SITE } }), SITE)
  assert.equal(personalSiteUrl({}), undefined)
  assert.equal(personalSiteUrl({ personalFileSite: '{kaputt' }), undefined)
  assert.equal(personalSiteUrl({ personalFileSite: { personalSiteUrl: 'http://contoso/' } }), undefined)
})

test('Dateinamen ohne Zeichen, die SharePoint ablehnt, Pfade teilweise kodiert', () => {
  assert.equal(driveFileName('a:b*c?.pdf'), 'a_b_c_.pdf')
  assert.equal(driveFileName('..versteckt.'), 'versteckt')
  assert.equal(driveFileName('   '), 'Datei')
  assert.equal(encodeDrivePath('Microsoft Teams Chat Files/Bericht #1 & Co\'s.pdf'), "Microsoft%20Teams%20Chat%20Files/Bericht%20%231%20%26%20Co%27s.pdf")
})

test('Kleine Dateien gehen mit einem PUT in den Chatordner, gleicher Name wird umbenannt', async () => {
  const calls: { url: string; init?: any }[] = []
  const data = new Uint8Array([1, 2, 3])
  const item = await uploadDriveFile(
    async (url, init) => {
      calls.push({ url, init })
      return ITEM
    },
    async () => assert.fail('keine Upload-Session erwartet'),
    TARGET,
    'Angebot Nord.pdf',
    data
  )
  assert.equal(item, ITEM)
  assert.equal(calls.length, 1)
  assert.equal(
    calls[0].url,
    `${SITE}_api/v2.0/drive/root:/Microsoft%20Teams%20Chat%20Files/Angebot%20Nord.pdf:/content?@name.conflictBehavior=rename&$select=*,sharepointIds,webDavUrl`
  )
  assert.equal(calls[0].init.method, 'PUT')
  assert.equal(calls[0].init.body, data)
})

test('Große Dateien laufen über eine Upload-Session in Teilen und lesen das Ergebnis nach', async () => {
  const size = SIMPLE_UPLOAD_MAX + CHUNK_BYTES + 5
  const data = new Uint8Array(size)
  const requests: { url: string; init?: any }[] = []
  const ranges: string[] = []
  let received = 0
  const item = await uploadDriveFile(
    async (url, init) => {
      requests.push({ url, init })
      if (url.endsWith('/createUploadSession')) return { uploadUrl: 'https://contoso-my.sharepoint.com/upload?tempauth=x' }
      return ITEM
    },
    async (url, body, headers) => {
      assert.equal(url, 'https://contoso-my.sharepoint.com/upload?tempauth=x')
      ranges.push(headers['content-range'])
      received += body.byteLength
      return received === size ? { id: '01ABCDEF', parentReference: { driveId: 'b!drive' } } : { nextExpectedRanges: [`${received}-`] }
    },
    TARGET,
    'gross.zip',
    data
  )
  assert.equal(received, size)
  assert.equal(ranges.length, Math.ceil(size / CHUNK_BYTES))
  assert.equal(ranges[0], `bytes 0-${CHUNK_BYTES - 1}/${size}`)
  assert.equal(ranges.at(-1), `bytes ${CHUNK_BYTES * (ranges.length - 1)}-${size - 1}/${size}`)
  assert.equal(requests[0].url, `${SITE}_api/v2.0/drive/root:/Microsoft%20Teams%20Chat%20Files/gross.zip:/createUploadSession`)
  assert.deepEqual(requests[0].init.body, { item: { '@name.conflictBehavior': 'rename' } })
  assert.equal(requests[1].url, `${SITE}_api/v2.0/drives/b!drive/items/01ABCDEF?$select=*,sharepointIds,webDavUrl`)
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
    SITE,
    ITEM,
    recipients
  )
  assert.equal(call!.url, `${SITE}_api/v2.0/sites/root/items/${GUID}/driveItem/invite`)
  assert.equal(call!.init.method, 'POST')
  assert.equal(call!.init.headers.prefer, 'ReturnSpecificErrorCode,getDefaultLink')
  assert.deepEqual(call!.init.body, { recipients, requireSignIn: true, sendInvitation: false })
  assert.deepEqual(share, { shareUrl: 'https://contoso-my.sharepoint.com/:b:/g/personal/x/abc', shareId: 'perm1' })

  // Notizen an mich selbst: niemand zum Freigeben, kein Aufruf
  assert.deepEqual(await inviteMembers(async () => assert.fail('kein Aufruf erwartet'), SITE, ITEM, []), {})
})

test('properties.files-Eintrag wie von der Web-App', () => {
  const e = filesEntry(ITEM, SITE, { shareUrl: 'https://s', shareId: 'perm1' })
  assert.equal(e['@type'], 'http://schema.skype.com/File')
  assert.equal(e.version, 2)
  assert.equal(e.id, GUID)
  assert.equal(e.itemid, GUID)
  assert.equal(e.baseUrl, SITE)
  assert.equal(e.objectUrl, ITEM.webDavUrl)
  assert.equal(e.type, 'pdf')
  assert.equal(e.fileType, 'pdf')
  assert.equal(e.title, 'Angebot Nord.pdf')
  assert.equal(e.fileName, 'Angebot Nord.pdf')
  assert.equal(e.state, 'active')
  assert.deepEqual(e.fileInfo, { itemId: '01ABCDEF', fileUrl: ITEM.webDavUrl, siteUrl: SITE, serverRelativeUrl: '', shareUrl: 'https://s', shareId: 'perm1' })
  assert.deepEqual(e.fileChicletState, { serviceName: 'p2p', state: 'active' })
  assert.deepEqual((filesEntry(ITEM, SITE, { channel: true }).fileChicletState as any).serviceName, 'teams')
  // Ohne sharepointIds: GUID aus dem eTag
  assert.equal(filesEntry({ ...ITEM, sharepointIds: undefined }, SITE).itemid, GUID)
})

test('SharePoint-Token geht nur an die Origin seiner Audience', () => {
  assert.equal(isTokenAudience('https://contoso-my.sharepoint.com', 'https://contoso-my.sharepoint.com/personal/x/_api/v2.0/drive'), true)
  assert.equal(isTokenAudience('https://contoso-my.sharepoint.com/', 'https://contoso-my.sharepoint.com/x'), true)
  assert.equal(isTokenAudience('https://contoso-my.sharepoint.com', 'https://evil-my.sharepoint.com/x'), false)
  assert.equal(isTokenAudience('https://contoso-my.sharepoint.com', 'http://contoso-my.sharepoint.com/x'), false)
  assert.equal(isTokenAudience('https://contoso-my.sharepoint.com', 'https://contoso-my.sharepoint.com.evil.example/x'), false)
  assert.equal(isTokenAudience('00000003-0000-0ff1-ce00-000000000000', 'https://contoso.sharepoint.com/x'), false)
  assert.equal(isTokenAudience('https://contoso.sharepoint.com/sites/a', 'https://contoso.sharepoint.com/x'), false)
  assert.equal(isTokenAudience(undefined, 'https://contoso.sharepoint.com/x'), false)
})

test('Stille Anmeldung: prompt=none mit PKCE, Code nur bei passendem state', () => {
  const req = silentRequest({ tenant: 'tid-1', resource: 'https://contoso-my.sharepoint.com', webOrigin: 'https://teams.microsoft.com', loginHint: 'erika@contoso.com' })
  const u = new URL(req.authorizeUrl)
  assert.equal(u.origin + u.pathname, 'https://login.microsoftonline.com/tid-1/oauth2/v2.0/authorize')
  assert.equal(u.searchParams.get('prompt'), 'none')
  assert.equal(u.searchParams.get('scope'), 'https://contoso-my.sharepoint.com/.default openid profile offline_access')
  assert.equal(u.searchParams.get('redirect_uri'), 'https://teams.microsoft.com/v2/authv2')
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(u.searchParams.get('login_hint'), 'erika@contoso.com')
  assert.notEqual(u.searchParams.get('code_challenge'), req.verifier)

  assert.equal(parseRedirect('https://login.microsoftonline.com/x', req), null)
  assert.deepEqual(parseRedirect(`https://teams.microsoft.com/v2/authv2#code=abc&state=${req.state}`, req), { code: 'abc' })
  assert.deepEqual(parseRedirect('https://teams.microsoft.com/v2/authv2#code=abc&state=fremd', req), { error: 'state passt nicht' })
  assert.deepEqual(parseRedirect(`https://teams.microsoft.com/v2/authv2#error=interaction_required&error_description=AADSTS50058%3A+x&state=${req.state}`, req), {
    error: 'interaction_required: AADSTS50058: x'
  })

  const body = new URLSearchParams(tokenRequestBody(req, 'abc'))
  assert.equal(body.get('grant_type'), 'authorization_code')
  assert.equal(body.get('code'), 'abc')
  assert.equal(body.get('code_verifier'), req.verifier)
  assert.equal(body.get('redirect_uri'), req.redirectUri)
})
