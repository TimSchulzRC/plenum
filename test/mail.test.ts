import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  attachmentBody,
  camelize,
  contentId,
  folderName,
  mailHtmlToText,
  mailPageApi,
  mailQueryUrl,
  mapFolder,
  mapSummary,
  messagesUrl,
  newDraftBody,
  pascalize,
  recipientsPatch,
  replyDraftBody,
  tokenValid,
  validFirst,
  sortFolders,
  textToHtml,
  unwrapSafeLink,
  wellKnownUrl
} from '../src/main/engine/mail.ts'

const isGraphPage = (u?: string) => mailPageApi(u) === 'graph'
import { fileSize, mergeMail, replyDraft, withImages } from '../src/renderer/src/lib/mail.ts'

test('Folgeseiten nur von Graph, sonst bekäme eine fremde Adresse den Token', () => {
  const next = 'https://graph.microsoft.com/v1.0/me/mailFolders/AAMk/messages?$top=40&$skip=40'
  assert.equal(isGraphPage(next), true)
  assert.equal(isGraphPage('https://evil.example/v1.0/me/mailFolders/AAMk/messages'), false)
  assert.equal(isGraphPage('http://graph.microsoft.com/v1.0/me/mailFolders/AAMk/messages'), false)
  assert.equal(isGraphPage('https://graph.microsoft.com/v1.0/me/sendMail'), false)
  assert.equal(isGraphPage(undefined), false)
  // So liefert Graph die Folgeseite tatsächlich (Live-Test)
  assert.equal(isGraphPage("https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages?$select=id&$orderby=receivedDateTime+desc&$top=40&$skip=40"), true)
  assert.equal(isGraphPage("https://graph.microsoft.com/v1.0/me/mailFolders('AAMkAD-x_y=')/messages?$skip=40"), true)
  assert.equal(isGraphPage("https://graph.microsoft.com/v1.0/me/mailFolders('a')/b/messages"), false)
  assert.match(messagesUrl('graph', 'inbox'), /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/mailFolders\/inbox\/messages\?/)
})

test('Mail aus Graph: Absender, Vorschau, Wichtigkeit, Markierung', () => {
  const m = mapSummary(
    {
      id: 'AAMk1',
      conversationId: 'c1',
      subject: '',
      from: { emailAddress: { name: 'Kim Fabrik', address: 'kim@fabrikam.de' } },
      toRecipients: [{ emailAddress: { address: 'alex@contoso.com' } }, { emailAddress: {} }],
      bodyPreview: '  Hallo\r\n  zusammen ',
      receivedDateTime: '2026-11-26T09:15:00Z',
      isRead: false,
      isDraft: false,
      hasAttachments: true,
      importance: 'High',
      flag: { flagStatus: 'flagged' }
    },
    'acc'
  )
  assert.equal(m.subject, '(Kein Betreff)')
  assert.deepEqual(m.from, { name: 'Kim Fabrik', address: 'kim@fabrikam.de' })
  assert.deepEqual(m.to, [{ name: undefined, address: 'alex@contoso.com' }])
  assert.equal(m.preview, 'Hallo zusammen')
  assert.equal(m.received, Date.parse('2026-11-26T09:15:00Z'))
  assert.equal(m.importance, 'high')
  assert.equal(m.flagged, true)
  assert.equal(m.accountId, 'acc')
})

test('Bekannte Ordner zuerst, in fester Reihenfolge, Rest alphabetisch', () => {
  const list = sortFolders([
    mapFolder({ id: '1', displayName: 'Zeta' }),
    mapFolder({ id: '2', displayName: 'Gesendete Elemente' }, 'sentitems'),
    mapFolder({ id: '3', displayName: 'Archiv', unreadItemCount: 2 }, 'archive'),
    mapFolder({ id: '4', displayName: 'Posteingang', unreadItemCount: 5 }, 'inbox'),
    mapFolder({ id: '5', displayName: 'Alpha' })
  ])
  assert.deepEqual(list.map((f) => f.name), ['Posteingang', 'Gesendete Elemente', 'Archiv', 'Alpha', 'Zeta'])
  assert.equal(list[0].unread, 5)
})

test('Eigener Text wird nicht als HTML gelesen, Zeilenumbrüche bleiben', () => {
  const html = textToHtml('Hallo <b>Kim</b> & Team\nZeile 2')
  assert.match(html, /Hallo &lt;b&gt;Kim&lt;\/b&gt; &amp; Team<br>Zeile 2/)
  assert.doesNotMatch(html, /<b>/)
})

test('Entwürfe: neue Mail und Antwort mit den Empfängern aus der Oberfläche', () => {
  const d = { to: ['kim@fabrikam.de'], cc: ['robin@fabrikam.de'], subject: 'Angebot', text: 'Hi', attachments: [] }
  const n = newDraftBody(d)
  assert.equal(n.subject, 'Angebot')
  assert.deepEqual(n.toRecipients, [{ emailAddress: { address: 'kim@fabrikam.de' } }])
  assert.deepEqual(n.ccRecipients, [{ emailAddress: { address: 'robin@fabrikam.de' } }])
  assert.equal((n.body as { contentType: string }).contentType, 'HTML')
  const r = replyDraftBody(d, 'replyAll') as { comment: string; toRecipients?: unknown }
  assert.match(r.comment, /Hi/)
  assert.equal(r.toRecipients, undefined)
  // Weiterleiten: Empfänger schon beim Anlegen, bei Outlook als ToRecipients
  assert.deepEqual((replyDraftBody(d, 'forward') as { toRecipients: unknown }).toRecipients, n.toRecipients)
  assert.deepEqual(pascalize(replyDraftBody(d, 'forward')).ToRecipients, [{ EmailAddress: { Address: 'kim@fabrikam.de' } }])
  assert.deepEqual(recipientsPatch(d), { toRecipients: n.toRecipients, ccRecipients: n.ccRecipients })
})

test('Content-ID ohne spitze Klammern', () => {
  assert.equal(contentId('<image001.png@01DA>'), 'image001.png@01DA')
  assert.equal(contentId(''), undefined)
  assert.equal(contentId(undefined), undefined)
})

const src = {
  from: { name: 'Kim', address: 'kim@fabrikam.de' },
  to: [{ address: 'alex@contoso.com' }, { address: 'sam@contoso.com' }],
  cc: [{ address: 'robin@fabrikam.de' }, { address: 'ALEX@contoso.com' }],
  subject: 'Angebot'
}

test('Antworten an den Absender, Allen antworten ohne mich selbst', () => {
  assert.deepEqual(replyDraft(src, 'reply', ['alex@contoso.com']), { to: ['kim@fabrikam.de'], cc: [], subject: 'AW: Angebot' })
  assert.deepEqual(replyDraft(src, 'replyAll', ['alex@contoso.com']), { to: ['kim@fabrikam.de', 'sam@contoso.com'], cc: ['robin@fabrikam.de'], subject: 'AW: Angebot' })
  assert.deepEqual(replyDraft(src, 'forward', ['alex@contoso.com']), { to: [], cc: [], subject: 'WG: Angebot' })
})

test('Kein doppeltes AW: oder WG:, eigene gesendete Mail geht an die Empfänger', () => {
  assert.equal(replyDraft({ ...src, subject: 'RE: Angebot' }, 'reply', []).subject, 'RE: Angebot')
  assert.equal(replyDraft({ ...src, subject: 'Fwd: Angebot' }, 'forward', []).subject, 'Fwd: Angebot')
  const sent = { ...src, from: { address: 'alex@contoso.com' } }
  assert.deepEqual(replyDraft(sent, 'reply', ['alex@contoso.com']).to, ['sam@contoso.com'])
})

test('Gemeinsamer Posteingang: neueste zuerst über alle Konten', () => {
  const mk = (id: string, received: number) => ({ id, received }) as never
  const merged = mergeMail([[mk('a1', 5), mk('a2', 1)], [mk('b1', 3)]])
  assert.deepEqual(merged.map((m: { id: string }) => m.id), ['a1', 'b1', 'a2'])
})

test('Dateigröße lesbar', () => {
  assert.equal(fileSize(512), '512 B')
  assert.equal(fileSize(2048), '2 KB')
  assert.equal(fileSize(3.5 * 1024 * 1024), '3,5 MB')
})

test('Folgeseite auf anderem Port zählt nicht als Graph', () => {
  assert.equal(isGraphPage('https://graph.microsoft.com:8443/v1.0/me/mailFolders/AAMk/messages'), false)
})

test('Antwortadresse (Reply-To) statt Absender', () => {
  const withReplyTo = { ...src, replyTo: [{ address: 'support@fabrikam.de' }] }
  assert.deepEqual(replyDraft(withReplyTo, 'reply', ['alex@contoso.com']).to, ['support@fabrikam.de'])
  assert.deepEqual(replyDraft(withReplyTo, 'replyAll', ['alex@contoso.com']).to, ['support@fabrikam.de', 'sam@contoso.com'])
  assert.deepEqual(replyDraft({ ...src, replyTo: [] }, 'reply', ['alex@contoso.com']).to, ['kim@fabrikam.de'])
})

test('Outlook als zweiter Weg: Adressen, Ordnernamen und Folgeseiten', () => {
  assert.equal(
    messagesUrl('outlook', 'inbox'),
    'https://outlook.office.com/api/v2.0/me/MailFolders/Inbox/messages?$top=40&$select=Id,ConversationId,Subject,From,ToRecipients,BodyPreview,ReceivedDateTime,IsRead,IsDraft,HasAttachments,Importance,Flag&$orderby=ReceivedDateTime desc'
  )
  assert.match(wellKnownUrl('outlook', 'deleteditems'), /\/MailFolders\/DeletedItems\?/)
  assert.equal(folderName('outlook', 'deleteditems'), 'DeletedItems')
  assert.equal(folderName('outlook', 'AAMkFolder'), 'AAMkFolder')
  assert.equal(folderName('graph', 'deleteditems'), 'deleteditems')
  assert.equal(mailPageApi("https://outlook.office.com/api/v2.0/me/MailFolders('Inbox')/messages?$skip=40"), 'outlook')
  assert.equal(mailPageApi('https://outlook.office.com/api/v2.0/me/sendmail'), undefined)
  // Suche im ganzen Postfach (MCP)
  assert.equal(mailPageApi('https://graph.microsoft.com/v1.0/me/messages?$search=%22x%22&$skip=25'), 'graph')
  assert.equal(mailPageApi('https://graph.microsoft.com/v1.0/me/messages/AAMk/send'), undefined)
  assert.equal(mailPageApi('https://outlook.office.com.evil.example/api/v2.0/me/MailFolders/Inbox/messages'), undefined)
})

test('Outlook-Antworten in camelCase, Anfragen in PascalCase', () => {
  const m = camelize({ Id: 'AAMk1', Subject: 'Hallo', From: { EmailAddress: { Name: 'Kim', Address: 'kim@fabrikam.de' } }, Importance: 'High', Flag: { FlagStatus: 'Flagged' }, ReceivedDateTime: '2026-11-26T09:15:00Z', '@odata.etag': 'W/1' })
  const s = mapSummary(m, 'acc')
  assert.equal(s.id, 'AAMk1')
  assert.deepEqual(s.from, { name: 'Kim', address: 'kim@fabrikam.de' })
  assert.equal(s.importance, 'high')
  assert.equal(s.flagged, true)
  assert.equal((m as Record<string, unknown>)['@odata.etag'], 'W/1')
  const d = { to: ['kim@fabrikam.de'], cc: [], subject: 'Angebot', text: 'Hi', attachments: [] }
  assert.deepEqual(pascalize(newDraftBody(d)).ToRecipients, [{ EmailAddress: { Address: 'kim@fabrikam.de' } }])
  assert.deepEqual(pascalize({ isRead: true }), { IsRead: true })
  assert.deepEqual(pascalize(attachmentBody({ name: 'a.txt', contentType: 'text/plain', data: 'QQ==' })), {
    '@odata.type': '#Microsoft.OutlookServices.FileAttachment',
    Name: 'a.txt',
    ContentType: 'text/plain',
    ContentBytes: 'QQ=='
  })
})

test('MCP-Abfrage: Ordner mit Filter und Sortierung, ungelesen immer nach dem Datum', () => {
  const g = new URL(mailQueryUrl('graph', { folder: 'inbox', unreadOnly: true, since: Date.parse('2026-11-01T00:00:00Z'), top: 25 }))
  assert.equal(g.pathname, '/v1.0/me/mailFolders/inbox/messages')
  assert.equal(g.searchParams.get('$filter'), 'receivedDateTime ge 2026-11-01T00:00:00Z and isRead eq false')
  assert.equal(g.searchParams.get('$orderby'), 'receivedDateTime desc')
  assert.match(g.searchParams.get('$select')!, /parentFolderId/)
  // Ohne since trotzdem zuerst das Datum, sonst lehnt Exchange Filter mit $orderby ab
  const o = new URL(mailQueryUrl('outlook', { folder: 'sentitems', until: Date.parse('2026-11-20T10:00:00Z'), top: 5 }))
  assert.equal(o.pathname, '/api/v2.0/me/MailFolders/SentItems/messages')
  assert.equal(o.searchParams.get('$filter'), 'ReceivedDateTime ge 1900-01-01T00:00:00Z and ReceivedDateTime lt 2026-11-20T10:00:00Z')
  assert.equal(o.searchParams.get('$top'), '5')
  // Bruchteile von until runden auf, die Mail von 10:00:00 bleibt drin
  const frac = new URL(mailQueryUrl('graph', { until: Date.parse('2026-11-20T10:00:00.500Z'), top: 5 }))
  assert.match(frac.searchParams.get('$filter')!, /lt 2026-11-20T10:00:01Z$/)
})

test('MCP-Suche: ganzes Postfach, KQL mit Zeitraum, ohne $filter und $orderby', () => {
  const g = new URL(mailQueryUrl('graph', { search: 'from:anna "Angebot\\ Nord"', since: Date.parse('2026-11-10T12:00:00Z'), top: 25 }))
  assert.equal(g.pathname, '/v1.0/me/messages')
  assert.equal(g.searchParams.get('$search'), '"(from:anna Angebot Nord) AND received>=2026-11-09"')
  assert.equal(g.searchParams.get('$filter'), null)
  assert.equal(g.searchParams.get('$orderby'), null)
  const o = new URL(mailQueryUrl('outlook', { search: 'x', folder: 'AAMkFolder=', top: 10 }))
  assert.equal(o.pathname, '/api/v2.0/me/MailFolders/AAMkFolder%3D/messages')
  assert.equal(o.searchParams.get('$search'), '"x"')
})

test('Mail-HTML als Text: ohne Kopf und Styles, Tabellen, Listen, Links mit Ziel', () => {
  const html = `<html><head><meta charset="utf-8"><style>p { margin: 0 }</style><title>x</title></head>
<body><!-- Kommentar --><div class="WordSection1"><p>Hallo   Tim,<br>
anbei die    Bestellung.</p>
<table><tr><th>Pos</th><th>Artikel</th></tr>
<tr><td>1</td><td>Schrauben&nbsp;M4</td></tr></table>
<ul><li>Lieferung bis 3.12.</li><li>Preis 12,50&nbsp;&euro;</li></ul>
<p><a href="https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Ffirma.de%2Fb%3Fid%3D4711&amp;data=abc">Bestellung ansehen</a>
<a href="mailto:einkauf@firma.de">einkauf@firma.de</a> <a href="https://firma.de">https://firma.de</a> <a href="#top">nach oben</a></p>
<pre>Zeile 1
Zeile 2</pre></div></body></html>`
  assert.equal(
    mailHtmlToText(html),
    [
      'Hallo Tim,',
      'anbei die Bestellung.',
      'Pos | Artikel',
      '1 | Schrauben M4',
      '- Lieferung bis 3.12.',
      '- Preis 12,50 €',
      'Bestellung ansehen (https://firma.de/b?id=4711) einkauf@firma.de https://firma.de nach oben',
      'Zeile 1',
      'Zeile 2'
    ].join('\n')
  )
  assert.equal(mailHtmlToText(''), '')
  // Outlook: Leerzeile als eigener Absatz, Umlaute als Entity
  assert.equal(
    mailHtmlToText('<p class=MsoNormal>Gr&uuml;&szlig;e<o:p></o:p></p><p class=MsoNormal><o:p>&nbsp;</o:p></p><p class=MsoNormal>Kim<o:p></o:p></p>'),
    'Grüße\n\nKim'
  )
  // Outlook: jede Zelle ein eigener Absatz, die Zeile bleibt trotzdem eine Zeile
  assert.equal(
    mailHtmlToText('<table><tr><td width=80><p class=MsoNormal>4711<o:p></o:p></p></td><td><p class=MsoNormal>5 St&uuml;ck</p></td></tr></table>'),
    '4711 | 5 Stück'
  )
  // Gmail und neues Outlook: Leerzeile als <div><br></div>, <br> am Blockende zählt nicht doppelt
  assert.equal(mailHtmlToText('<div>Hallo<br></div><div><br></div><div>Text</div><div>Ende</div>'), 'Hallo\n\nText\nEnde')
  assert.equal(unwrapSafeLink('https://example.com/a'), 'https://example.com/a')
})

test('Eigene Signatur unter dem Text, Logo als eingebetteter Anhang', () => {
  const d = { to: ['kim@fabrikam.de'], cc: [], subject: 'Angebot', text: 'Hi', attachments: [], signature: '<p>Alex Beispiel</p><img src="cid:logo@sig">' }
  const n = newDraftBody(d) as { body: { content: string } }
  assert.match(n.body.content, /Hi<\/div><div><br><\/div><div class="te-signature"><p>Alex Beispiel<\/p><img src="cid:logo@sig"><\/div>$/)
  const r = replyDraftBody(d, 'reply') as { comment: string }
  assert.match(r.comment, /Hi<\/div>.*te-signature.*Alex Beispiel/)
  // Ohne Signatur bleibt es beim Text
  assert.doesNotMatch((replyDraftBody({ ...d, signature: undefined }, 'reply') as { comment: string }).comment, /te-signature/)
  const inline = attachmentBody({ name: 'logo.png', contentType: 'image/png', data: 'AAA', contentId: 'logo@sig' })
  assert.equal(inline.isInline, true)
  assert.equal(inline.contentId, 'logo@sig')
  assert.equal(pascalize(inline).ContentId, 'logo@sig')
  assert.equal(attachmentBody({ name: 'plan.pdf', contentType: 'application/pdf', data: 'AAA' }).isInline, undefined)
})

test('Mail mit nachgeladenen Bildern: eingebettete Anhänge fallen aus der Liste', () => {
  const m = {
    id: 'm1', accountId: 'a', subject: 's', to: [], cc: [], replyTo: [], preview: '', received: 0, isRead: true, isDraft: false, hasAttachments: true,
    importance: 'normal' as const, flagged: false, bodyType: 'html' as const, body: '<img src="cid:logo@x"><p>Hi</p>', inlineImages: {},
    attachments: [
      { id: 'logo', name: 'logo.png', size: 10, isInline: true },
      { id: 'unused', name: 'bild.png', size: 10, isInline: true },
      { id: 'failed', name: 'x.png', size: 10, isInline: true },
      { id: 'pdf', name: 'plan.pdf', size: 10, isInline: false }
    ]
  }
  // Vorher: nur echte Anhänge, keine Bilder
  const before = withImages(m)
  assert.deepEqual(before.attachments.map((a) => a.id), ['pdf'])
  assert.deepEqual(before.inlineImages, {})
  // Danach: das genutzte Logo ist eingebettet, ein nicht genutztes oder nicht geladenes Bild bleibt als Datei
  const after = withImages(m, { images: { 'logo@x': 'data:image/png;base64,AAA', 'unused@x': 'data:image/png;base64,BBB' }, cids: { logo: 'logo@x', unused: 'unused@x' } })
  assert.deepEqual(after.attachments.map((a) => a.id), ['unused', 'failed', 'pdf'])
  assert.equal(after.inlineImages['logo@x'], 'data:image/png;base64,AAA')
})

test('Mail-Dienste: gültiger Token zuerst, abgelaufener zuletzt', () => {
  const now = 1_000_000
  assert.equal(tokenValid(undefined, now), true)
  assert.equal(tokenValid(now + 120_000, now), true)
  assert.equal(tokenValid(now + 30_000, now), false)
  assert.equal(tokenValid(now - 1, now), false)
  const exp: Record<string, number> = { graph: now - 5000, outlook: now + 3_600_000 }
  assert.deepEqual(validFirst(['graph', 'outlook'], (a) => tokenValid(exp[a], now)), ['outlook', 'graph'])
  exp.graph = now + 3_600_000
  assert.deepEqual(validFirst(['graph', 'outlook'], (a) => tokenValid(exp[a], now)), ['graph', 'outlook'])
})
