import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mailSignatures, parseSignatureBodies, parseSignatureList, signatureBodiesUrl, signatureListUrl, signatureNames } from '../src/main/engine/outlook-signatures.ts'

test('Outlook-Signaturen: Liste und Standards, Namen ohne Rücksicht auf Groß- und Kleinschreibung', () => {
  assert.equal(signatureListUrl(), 'https://outlook.office.com/ows/v1/OutlookCloudSettings/settings/account?settingname=roaming_signature_list,roaming_new_signature,roaming_reply_signature')
  // So kam es live: eine Signatur als einfacher Text, Typ BlobArray
  const one = [
    { name: 'roaming_signature_list', type: 'BlobArray', value: 'Alex Beispiel Contoso' },
    { name: 'Roaming_New_Signature', type: 'String', value: 'Alex Beispiel Contoso' },
    { name: 'roaming_reply_signature', type: 'String', value: 'alex beispiel contoso' }
  ]
  assert.deepEqual(parseSignatureList(one), { names: ['Alex Beispiel Contoso'], newDefault: 'Alex Beispiel Contoso', replyDefault: 'Alex Beispiel Contoso' })
  // Mehrere mit Komma, Antworten ohne Standard
  const two = [
    { name: 'roaming_signature_list', value: 'Lang,Kurz' },
    { name: 'roaming_new_signature', value: 'Lang' },
    { name: 'roaming_reply_signature', value: '' }
  ]
  assert.deepEqual(parseSignatureList(two), { names: ['Lang', 'Kurz'], newDefault: 'Lang', replyDefault: undefined })
  assert.deepEqual(signatureNames('["Lang","Kurz","lang"]'), ['Lang', 'Kurz'])
  assert.deepEqual(signatureNames(['Lang', ' ', 'Kurz']), ['Lang', 'Kurz'])
  // Standard, der nicht in der Liste steht, gilt nicht
  assert.equal(parseSignatureList([{ name: 'roaming_signature_list', value: 'Kurz' }, { name: 'roaming_new_signature', value: 'Weg' }]).newDefault, undefined)
  // Ohne Liste wenigstens die Standards
  assert.deepEqual(parseSignatureList([{ name: 'roaming_new_signature', value: 'Kurz' }]).names, ['Kurz'])
  // Leere Antwort heißt keine Signatur, eine unerwartete ist ein Fehler (die gespeicherte Fassung bleibt)
  assert.deepEqual(parseSignatureList([]), { names: [], newDefault: undefined, replyDefault: undefined })
  assert.deepEqual(parseSignatureList([null, 3, 'x']), { names: [], newDefault: undefined, replyDefault: undefined })
  assert.throws(() => parseSignatureList({}), /Unerwartete Antwort/)
  assert.throws(() => parseSignatureList('<html>Anmelden</html>'), /Unerwartete Antwort/)
  assert.throws(() => parseSignatureBodies({ value: [] }, ['Kurz']), /Unerwartete Antwort/)
})

test('Outlook-Signaturen: Texte zu den Namen, ohne Text keine Signatur', () => {
  assert.equal(signatureBodiesUrl(['Lang', 'Kurz & bündig']), 'https://outlook.office.com/ows/v1/OutlookCloudSettings/settings/account?settingname=Lang,Kurz%20%26%20b%C3%BCndig')
  const res = [
    { name: 'Lang', secondaryKey: 'htm', value: '<p>Alex</p><img src="data:image/png;base64,AAA">', nameBase64Encoded: true },
    { name: 'Lang', secondaryKey: 'txt', value: 'Alex' },
    { name: Buffer.from('Kurz').toString('base64'), secondaryKey: 'htm', value: '<p>A.</p>', nameBase64Encoded: true },
    { name: 'Leer', secondaryKey: 'htm', value: '  ' },
    { name: 'Fremd', secondaryKey: 'htm', value: '<p>x</p>' }
  ]
  const bodies = parseSignatureBodies(res, ['Lang', 'Kurz', 'Leer'])
  assert.deepEqual(bodies, [
    { name: 'Lang', html: '<p>Alex</p><img src="data:image/png;base64,AAA">', text: 'Alex' },
    { name: 'Kurz', html: '<p>A.</p>', text: '' }
  ])
  const list = { names: ['Lang', 'Kurz', 'Leer'], newDefault: 'Leer', replyDefault: 'Kurz' }
  assert.deepEqual(mailSignatures(list, bodies, 5), { list: bodies, newDefault: undefined, replyDefault: 'Kurz', at: 5 })
})
