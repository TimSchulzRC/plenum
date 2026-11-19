import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AMS_BASE, amsImageIds, replaceInlineImages, uploadAmsImage } from '../src/main/engine/ams.ts'
import { imageFileName, parseDataUrl } from '../src/main/image-file.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

test('Upload legt ein AMS-Objekt mit Leserecht für die Unterhaltung an und lädt die Bytes hoch', async () => {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body: unknown; raw?: boolean } }[] = []
  const id = await uploadAmsImage(
    async (url, init) => {
      calls.push({ url, init })
      return init.method === 'POST' ? { id: '0-weu-d1-abc' } : {}
    },
    'SKYPE',
    '19:abc@thread.v2',
    PNG,
    'image/png'
  )
  assert.equal(id, '0-weu-d1-abc')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, `${AMS_BASE}/v1/objects/`)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, 'skype_token SKYPE')
  assert.deepEqual(calls[0].init.body, {
    type: 'pish/image',
    permissions: { '19:abc@thread.v2': ['read'] },
    filename: 'image.png',
    sharingMode: 'Inline'
  })
  assert.equal(calls[1].url, `${AMS_BASE}/v1/objects/0-weu-d1-abc/content/imgpsh`)
  assert.equal(calls[1].init.method, 'PUT')
  assert.equal(calls[1].init.headers['content-type'], 'application/octet-stream')
  assert.equal(calls[1].init.headers.authorization, 'skype_token SKYPE')
  assert.deepEqual(Buffer.from(calls[1].init.body as Uint8Array), PNG)
})

test('Upload ohne ID von Teams schlägt fehl', async () => {
  await assert.rejects(uploadAmsImage(async () => ({}), 'S', '19:x', PNG, 'image/png'), /keine ID/)
})

test('data:-Bilder werden durch AMS-Bilder ersetzt, Größe und Reihenfolge bleiben', async () => {
  const b64 = PNG.toString('base64')
  const html = `<p>Hallo</p><p><img src="data:image/png;base64,${b64}" width="300" height="200"><img src="data:image/jpeg;base64,${b64}"></p>`
  const uploaded: string[] = []
  const out = await replaceInlineImages(html, async (data, mime) => {
    assert.deepEqual(Buffer.from(data), PNG)
    uploaded.push(mime)
    return `id-${uploaded.length}`
  })
  assert.deepEqual(uploaded, ['image/png', 'image/jpeg'])
  assert.deepEqual(out.ids, ['id-1', 'id-2'])
  assert.ok(!out.html.includes('data:'))
  assert.ok(out.html.startsWith('<p>Hallo</p><p><img src="https://as-prod.asyncgw.teams.microsoft.com/v1/objects/id-1/views/imgo" width="300" height="200"'))
  assert.match(out.html, /itemtype="http:\/\/schema\.skype\.com\/AMSImage" itemid="id-1"/)
  assert.match(out.html, /<img src="[^"]*\/id-2\/views\/imgo" id="x_id-2"/)
})

test('HTML ohne eingefügte Bilder bleibt unverändert und lädt nichts hoch', async () => {
  const html = '<p>Text <img src="https://as-prod.asyncgw.teams.microsoft.com/v1/objects/x/views/imgo"></p>'
  const out = await replaceInlineImages(html, async () => assert.fail('kein Upload erwartet'))
  assert.deepEqual(out, { html, ids: [] })
})

test('Nicht unterstützte Bildformate werden abgelehnt', async () => {
  await assert.rejects(replaceInlineImages('<img src="data:image/svg+xml;base64,PHN2Zy8+">', async () => 'x'), /svg/)
})

test('Dateiname und data:-URL für Bild herunterladen/kopieren', () => {
  assert.equal(imageFileName('image/jpeg', new Date(2026, 10, 19, 14, 5, 3)), 'Bild 2026-11-19 14.05.03.jpg')
  assert.equal(imageFileName('image/png; charset=binary', new Date(2026, 0, 2, 3, 4, 5)), 'Bild 2026-01-02 03.04.05.png')
  assert.equal(imageFileName('application/octet-stream', new Date(2026, 0, 2, 3, 4, 5)), 'Bild 2026-01-02 03.04.05.png')
  const parsed = parseDataUrl(`data:image/png;base64,${PNG.toString('base64')}`)
  assert.equal(parsed?.type, 'image/png')
  assert.deepEqual(parsed?.data, PNG)
  assert.equal(parseDataUrl('https://example.com/a.png'), null)
})

test('Beim Bearbeiten bleiben vorhandene AMS-Bilder in amsreferences', async () => {
  const b64 = PNG.toString('base64')
  const old = '<img src="https://as-prod.asyncgw.teams.microsoft.com/v1/objects/alt/views/imgo" itemscope="" itemtype="http://schema.skype.com/AMSImage" itemid="alt">'
  const out = await replaceInlineImages(`<p>${old}<img src="data:image/png;base64,${b64}"></p>`, async () => 'neu')
  assert.deepEqual(amsImageIds(out.html), ['alt', 'neu'])
  assert.deepEqual(amsImageIds('<img src="x.png"><img itemtype="http://schema.skype.com/Emoji" itemid="smile">'), [])
})
