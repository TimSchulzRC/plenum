import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  contentId,
  isGraphPage,
  mapFolder,
  mapSummary,
  messagesUrl,
  newDraftBody,
  replyDraftBody,
  sortFolders,
  textToHtml
} from '../src/main/engine/mail.ts'
import { fileSize, mergeMail, replyDraft } from '../src/renderer/src/lib/mail.ts'

test('Folgeseiten nur von Graph, sonst bekäme eine fremde Adresse den Token', () => {
  const next = 'https://graph.microsoft.com/v1.0/me/mailFolders/AAMk/messages?$top=40&$skip=40'
  assert.equal(isGraphPage(next), true)
  assert.equal(isGraphPage('https://evil.example/v1.0/me/mailFolders/AAMk/messages'), false)
  assert.equal(isGraphPage('http://graph.microsoft.com/v1.0/me/mailFolders/AAMk/messages'), false)
  assert.equal(isGraphPage('https://graph.microsoft.com/v1.0/me/sendMail'), false)
  assert.equal(isGraphPage(undefined), false)
  assert.match(messagesUrl('inbox'), /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/mailFolders\/inbox\/messages\?/)
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
  const r = replyDraftBody(d) as { comment: string; message: { toRecipients: unknown[] } }
  assert.match(r.comment, /Hi/)
  assert.equal(r.message.toRecipients.length, 1)
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
