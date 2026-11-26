import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  attachmentBody,
  camelize,
  contentId,
  folderName,
  mailPageApi,
  mapFolder,
  mapSummary,
  messagesUrl,
  newDraftBody,
  pascalize,
  recipientsPatch,
  replyDraftBody,
  sortFolders,
  textToHtml,
  wellKnownUrl
} from '../src/main/engine/mail.ts'

const isGraphPage = (u?: string) => mailPageApi(u) === 'graph'
import { fileSize, mergeMail, replyDraft } from '../src/renderer/src/lib/mail.ts'

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
