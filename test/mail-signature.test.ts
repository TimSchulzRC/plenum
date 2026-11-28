import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findHeaders, findSignatures, modelRanges, modelRequest, partStarts, type SigLine } from '../src/renderer/src/lib/mail-signature.ts'

const L = (...texts: (string | SigLine)[]): SigLine[] => texts.map((t) => (typeof t === 'string' ? { text: t } : t))
const hidden = (lines: SigLine[], sender?: string) => findSignatures(lines, sender).map((r) => lines.slice(r.start, r.end).map((l) => l.text))

test('Deutsche Outlook-Signatur: Gruß und Name bleiben, Kontaktblock fällt weg', () => {
  const lines = L(
    'Hallo Kim,',
    'anbei das Angebot. Bitte gib mir bis Freitag Bescheid.',
    'Viele Grüße',
    'Alex Beispiel',
    'Senior Consultant',
    'Contoso GmbH | Musterstraße 1 | 12345 Musterstadt',
    'Tel. +49 123 456789 | alex@contoso.com',
    'Geschäftsführer: Max Muster, Amtsgericht Musterstadt HRB 12345'
  )
  assert.deepEqual(hidden(lines), [['Senior Consultant', 'Contoso GmbH | Musterstraße 1 | 12345 Musterstadt', 'Tel. +49 123 456789 | alex@contoso.com', 'Geschäftsführer: Max Muster, Amtsgericht Musterstadt HRB 12345']])
  assert.equal(findSignatures(lines)[0].reason, 'closing')
})

test('Englisch mit Logo und Disclaimer', () => {
  const lines = L(
    'Hi Alex,',
    'thanks, works for me.',
    'Best regards,',
    'Kim',
    { text: '', image: true },
    'Fabrikam Ltd. · www.fabrikam.com',
    'This e-mail may contain confidential information. If you are not the intended recipient, please notify the sender and delete it.'
  )
  assert.equal(hidden(lines)[0][0], '')
  assert.equal(hidden(lines)[0].length, 3)
})

test('Vom Client markierte Signatur und Trenner „-- “', () => {
  const marked = L('Hallo,', 'kurze Frage zum Termin.', { text: 'Sam Muster', marker: 1 }, { text: 'IT-Service', marker: 1 })
  assert.deepEqual(hidden(marked), [['IT-Service']])
  assert.equal(findSignatures(marked)[0].reason, 'marker')
  // P.S. unter der markierten Signatur bleibt sichtbar
  const ps = L('Hallo,', 'kurze Frage zum Termin.', { text: 'Sam Muster', marker: 1 }, { text: 'IT-Service', marker: 1 }, 'P.S. Bitte bis Freitag.')
  assert.deepEqual(hidden(ps), [['IT-Service']])
  // Eine „--“-Linie im Text ist kein Trenner, „-- “ mit Leerzeichen schon
  assert.deepEqual(hidden(L('Agenda', '--', 'Punkt eins ist wichtig, weil wir sonst nicht weiterkommen.', 'Punkt zwei auch, das klären wir morgen.')), [])
  assert.deepEqual(hidden(L('Agenda', { text: '--', sep: true }, 'Robin Nord', 'Tel. +49 30 1234567')), [['Tel. +49 30 1234567']])
  const gmail = L('Klingt gut, bis Freitag!', '--', { text: 'Sam Muster', marker: 1 }, { text: 'Mobil: +49 151 23456789', marker: 1 })
  assert.deepEqual(hidden(gmail), [['Mobil: +49 151 23456789']])
  const dashes = L('Hallo,', 'siehe unten.', '-- ', 'Robin Nord', 'Northwind Traders')
  assert.deepEqual(hidden(dashes), [['Northwind Traders']])
})

test('Verlauf: jede Nachricht hat ihre eigene Signatur, der Kopf des Zitats bleibt', () => {
  const lines = L(
    'Passt, danke!',
    'Viele Grüße',
    'Alex',
    'Contoso GmbH, Tel. +49 123 456789',
    'www.contoso.com',
    { text: 'Von: Kim Fabrik <kim@fabrikam.de>', boundary: true },
    'Gesendet: Mittwoch, 25. November 2026 10:00',
    'An: Alex Beispiel',
    'Betreff: Angebot',
    'Hallo Alex, hier das Angebot.',
    'Mit freundlichen Grüßen',
    'Kim Fabrik',
    'Fabrikam AG · Hafenweg 3 · 20457 Hamburg',
    'kim@fabrikam.de · +49 40 1234567'
  )
  assert.deepEqual(partStarts(lines), [0, 5])
  const r = findSignatures(lines)
  assert.equal(r.length, 2)
  assert.deepEqual(lines.slice(r[0].start, r[0].end).map((l) => l.text), ['Contoso GmbH, Tel. +49 123 456789', 'www.contoso.com'])
  assert.deepEqual(lines.slice(r[1].start, r[1].end).map((l) => l.text), ['Fabrikam AG · Hafenweg 3 · 20457 Hamburg', 'kim@fabrikam.de · +49 40 1234567'])
})

test('Zitierter Kopf nur als Text („Von:“ … „Betreff:“, „Am … schrieb …:“) trennt die Teile', () => {
  assert.deepEqual(partStarts(L('Danke!', 'Von: Kim', 'Gesendet: heute', 'Betreff: x', 'Text')), [0, 1])
  assert.deepEqual(partStarts(L('Danke!', 'Am 25.11.2026 um 10:00 schrieb Kim Fabrik <kim@fabrikam.de>:', 'Text')), [0, 1])
  assert.deepEqual(partStarts(L('Danke!', '-----Ursprüngliche Nachricht-----', 'Von: Kim')), [0, 1])
  // „Von:“ mitten im Text ohne weitere Kopfzeilen ist kein Kopf
  assert.deepEqual(partStarts(L('Hallo', 'Von: wem kommt das?', 'Grüße')), [0])
})

test('Ohne Grußformel: Kontaktblock am Ende mit mindestens zwei Kontaktzeilen', () => {
  const lines = L('Die Unterlagen liegen im Ordner.', 'Robin Nord', 'Northwind Traders GmbH', 'Tel: +49 30 1234567', 'robin@northwind.example')
  // Nur mit dem Namen des Absenders: Ein fremder Name ist ein Kontakt, den die Mail mitteilt
  assert.deepEqual(hidden(lines, 'Nord, Robin (Northwind)'), [['Northwind Traders GmbH', 'Tel: +49 30 1234567', 'robin@northwind.example']])
  assert.equal(findSignatures(lines, 'Robin Nord')[0].reason, 'contact')
  assert.deepEqual(hidden(lines, 'Alex Beispiel'), [])
  assert.deepEqual(hidden(lines), [])
})

test('Nichts verstecken: kurze Mail, nur Gruß und Name, Inhalt mit Telefonnummer', () => {
  assert.deepEqual(hidden(L('Danke!', 'Alex')), [])
  assert.deepEqual(hidden(L('Hallo Kim,', 'klingt gut.', 'Viele Grüße', 'Alex')), [])
  // Telefonnummer im Fließtext ist Inhalt, keine Signatur
  assert.deepEqual(
    hidden(L('Hallo,', 'ruf mich bitte unter +49 170 1234567 an, ich bin bis 18 Uhr erreichbar und kann dann alles erklären.', 'Viele Grüße', 'Alex')),
    []
  )
  // Nach dem Gruß folgt noch ein ganzer Satz: kein Signaturblock
  assert.deepEqual(hidden(L('Hallo,', 'anbei die Datei.', 'Viele Grüße', 'Alex', 'PS: Denk bitte an die Rechnung, die ist seit letzter Woche offen und sollte bald raus.')), [])
})

test('Die ganze Nachricht ist nie Signatur', () => {
  // Markierung schon in der ersten Inhaltszeile, nur Kontaktzeilen: die erste Zeile bleibt stehen
  for (const lines of [
    L({ text: 'Alex Beispiel', marker: 1 }, 'Tel. +49 123 456789', 'alex@contoso.com'),
    L('Neue Durchwahl: +49 123 456789', 'Tel. +49 123 456789', 'alex@contoso.com')
  ]) {
    const r = findSignatures(lines)
    assert.ok(r.every((x) => x.start > 0))
  }
})

test('Rechtsformen nur nach einem Namen, Kontaktblock braucht eine harte Angabe', () => {
  // „AG“ als Arbeitsgruppe, „KG“ als Kilogramm: keine Firma
  assert.deepEqual(hidden(L('Hallo,', 'Variante A passt.', 'Die AG trifft sich morgen', 'Ag und KG prüfen')), [])
  assert.deepEqual(hidden(L('Hi,', 'Plan A works.', 'Option B is cheaper.')), [])
  // Firmenname und Logo allein: kein Signaturblock ohne Grußformel
  assert.deepEqual(hidden(L('Hallo,', 'neues Logo anbei.', 'Contoso GmbH', { text: '', image: true })), [])
})

test('Grußformeln in Varianten', () => {
  for (const g of ['Mit freundlichen Grüßen', 'Beste Grüße aus Hamburg', 'LG', 'VG,', 'Danke und Grüße', 'Kind regards', 'Cheers!', 'Herzliche Grüsse']) {
    const lines = L('Hallo,', 'alles klar.', g, 'Alex', 'Contoso GmbH', 'Tel. +49 123 456789')
    assert.equal(findSignatures(lines)[0]?.reason, 'closing', g)
  }
})

const open = (body: number, ...texts: (string | SigLine)[]) => {
  const lines = L(...texts)
  return { body, end: body + lines.length, lines }
}

test('Modell: nur Teile mit mindestens vier Zeilen, höchstens vier Teile, Zeilen ab dem Inhalt gezählt', () => {
  const parts = [open(0, 'a', 'b', 'c'), open(5, 'Hallo,', 'kurz:', 'passt.', 'Jo Beispiel', 'Fabrikam – wir verbinden Systeme.'), ...Array.from({ length: 5 }, (_, i) => open(20 + i * 10, 'x', 'y', 'z', 'w'))]
  const req = modelRequest(parts)
  assert.equal(req.parts.length, 4)
  assert.deepEqual(req.of, [1, 2, 3, 4])
  assert.deepEqual(req.parts[0], { first: 2, lines: ['kurz:', 'passt.', 'Jo Beispiel', 'Fabrikam – wir verbinden Systeme.'] })
})

test('Modell: lange Teile nur bis 40 Zeilen und 2500 Zeichen vom Ende, Bilder als [Bild]', () => {
  const long = open(0, ...Array.from({ length: 60 }, (_, i) => `Zeile ${i + 1}`), { text: '', image: true })
  const req = modelRequest([long])
  assert.equal(req.parts[0].lines.length, 40)
  assert.equal(req.parts[0].first, 22)
  assert.equal(req.parts[0].lines.at(-1), '[Bild]')
  const wide = open(0, ...Array.from({ length: 30 }, () => 'x'.repeat(190)))
  assert.ok(modelRequest([wide]).parts[0].lines.join('').length <= 2500)
})

test('Modell: Antwort wird geprüft, bevor etwas verschwindet', () => {
  const p = open(5, 'Hallo,', 'das Update ist eingespielt, bitte einmal neu starten.', 'Jo Beispiel | Teamleitung Plattform', 'Fabrikam – wir verbinden Systeme.', { text: '', image: true })
  const req = { of: [0] }
  // Zeile 3 (ab dem Inhalt): Name, Slogan, Logo
  assert.deepEqual(modelRanges([3], req, [p]), [{ start: 8, end: 10, reason: 'model' }])
  // Erste Inhaltszeile nie, nichts gefunden, außerhalb des Teils
  assert.deepEqual(modelRanges([1], req, [p]), [])
  assert.deepEqual(modelRanges([null], req, [p]), [])
  assert.deepEqual(modelRanges([9], req, [p]), [])
  // Fragen oder Fließtext ohne Kontaktangabe sind keine Signatur
  const q = open(0, 'Hallo,', 'kannst du morgen?', 'Wann passt es dir am besten?', 'Jo')
  assert.deepEqual(modelRanges([3], req, [q]), [])
  const prose = open(0, 'Hallo,', 'Text', 'Noch ein ganz normaler Satz ohne Kontakt.', 'Und noch einer.')
  assert.deepEqual(modelRanges([3], req, [prose]), [])
})

// Muster aus der Messung an 80 echten Mails, mit erfundenen Texten
test('Zweisprachige Grußformel und Gruß mit Name: darüber bleibt alles Inhalt', () => {
  assert.deepEqual(
    hidden(L('Hallo Kim,', 'schick mir die Datei bitte an alex@contoso.com', 'Viele Grüße | Best regards', 'Alex', 'Contoso GmbH', 'Tel. +49 123 456789')),
    [['Contoso GmbH', 'Tel. +49 123 456789']]
  )
  assert.deepEqual(hidden(L('Hi,', 'hier der Link:', 'https://contoso.example/report', 'Viele Grüße, Best regards', 'Alex')), [])
  assert.deepEqual(
    hidden(L('Vielen Dank für Ihre Nachricht.', 'Ich bin bis 02.12.2026 nicht im Büro. In dringenden Fällen wenden Sie sich an support@contoso.com.', 'Mit freundlichen Grüßen / Best regards / Cordialement', 'Alex Beispiel')),
    []
  )
  assert.deepEqual(hidden(L('Hallo,', 'Termin: Mittwoch 10 Uhr', 'Ort: Raum Elbe', 'Tel.-Einwahl: +49 30 1234567', 'Konferenz-ID: 123 456', 'Viele Grüße / Kind regards', 'Kim')), [])
  assert.deepEqual(
    hidden(L('Hallo,', 'hier die Teilnehmer:', 'Kim Fabrik (kim@fabrikam.de)', 'Robin Nord (robin@northwind.example)', 'Sam Muster (sam@example.dev)', 'Danke / Viele Grüße', 'Alex')),
    []
  )
  // Gruß und Name in einer Zeile, danach der Kontaktblock
  assert.deepEqual(hidden(L('Hallo,', 'passt so.', 'Viele Grüße, Alex', 'Contoso GmbH', 'Tel. +49 123 456789')), [['Contoso GmbH', 'Tel. +49 123 456789']])
  // „Danke, das passt.“ ist keine Grußformel
  assert.deepEqual(hidden(L('Hallo,', 'Danke, das passt.', 'Alex')), [])
})

test('Nach der Grußformel bleibt nur eine Namenszeile, Firma ohne Rechtsform gehört zur Signatur', () => {
  assert.deepEqual(hidden(L('Hallo,', 'passt.', 'Viele Grüße', 'Alex Beispiel', 'Contoso Consulting', 'Tel. +49 123 456789')), [['Contoso Consulting', 'Tel. +49 123 456789']])
  // Titel und Firma ohne Kontaktzeile, aber mit Position
  assert.deepEqual(hidden(L('Hallo,', 'passt.', 'Viele Grüße / Kind regards', 'Alex Beispiel', 'Senior Consultant', 'Contoso Consulting')), [['Senior Consultant', 'Contoso Consulting']])
})

test('„Gesendet von Outlook für iOS“ und Co., auch in kurzen Antworten', () => {
  assert.deepEqual(hidden(L('Ok, danke.', 'Gesendet von Outlook für iOS')), [['Gesendet von Outlook für iOS']])
  assert.deepEqual(hidden(L('Passt!', 'Von meinem iPhone gesendet')), [['Von meinem iPhone gesendet']])
  assert.deepEqual(hidden(L('Sure.', 'Sent from my iPhone')), [['Sent from my iPhone']])
  assert.deepEqual(hidden(L('Ok', 'Outlook für iOS beziehen')), [['Outlook für iOS beziehen']])
  // Kein Gerät, sondern Inhalt
  assert.deepEqual(hidden(L('Hallo,', 'Gesendet von der Buchhaltung am Montag, bitte prüfen.')), [])
})

test('Fließtext im markierten Element bleibt sichtbar', () => {
  const prose = 'Wir haben die Auswertung abgeschlossen und schicken dir die Ergebnisse bis Ende der Woche zusammen mit den Folien.'
  assert.deepEqual(hidden(L('Lieber Kim,', { text: prose, marker: 1 }, { text: 'Alex', marker: 1 }, { text: 'Tel. +49 123 456789', marker: 1 })), [['Tel. +49 123 456789']])
})

test('Modell: erste gezeigte Zeile und Blöcke über 15 Zeilen werden verworfen', () => {
  const p = open(0, 'Hallo,', 'Text', 'Jo Beispiel | Teamleitung', 'Fabrikam – wir verbinden Systeme.', { text: '', image: true })
  const req = { of: [0], parts: [{ first: 2, lines: ['Text', 'Jo Beispiel | Teamleitung', 'Fabrikam – wir verbinden Systeme.', '[Bild]'] }] }
  assert.deepEqual(modelRanges([2], req, [p]), [])
  assert.deepEqual(modelRanges([3], req, [p]), [{ start: 3, end: 5, reason: 'model' }])
  const fields = open(0, 'Neues Ticket', ...Array.from({ length: 20 }, (_, i) => `Feld ${i}: Wert ${i}`), 'Melder: kim@fabrikam.de')
  assert.deepEqual(modelRanges([3], { of: [0], parts: [{ first: 2, lines: [] }] }, [fields]), [])
})

test('Review: P.S., Anweisungen und Linklisten bleiben Inhalt', () => {
  // Mobile Fußzeile versteckt nur sich selbst, „Sent from Outlook, please review.“ ist Inhalt
  assert.deepEqual(hidden(L('Done.', 'Sent from my iPhone', 'P.S. Please cancel the transfer.')), [['Sent from my iPhone']])
  assert.deepEqual(hidden(L('Hi,', 'Sent from Outlook, please review.')), [])
  // Linkliste ohne Grußformel
  assert.deepEqual(hidden(L('Hi Kim', 'Here are the links', 'https://example.com/report', 'https://example.com/approval')), [])
  // „Thanks, see below“ ist kein Gruß mit Name, die Anweisung mit „team“ keine Positionszeile
  assert.deepEqual(hidden(L('Hi,', 'Thanks, see below', 'Please ask the project team to hold the release.')), [])
  // P.S. mit Mailadresse am Ende des markierten Elements
  assert.deepEqual(
    hidden(L('Hallo,', 'anbei der Vertrag.', { text: 'Alex Beispiel', marker: 1 }, { text: 'Tel. +49 123 456789', marker: 1 }, { text: 'P.S. Send the signed copy to kim@example.com by Friday.', marker: 1 })),
    [['Tel. +49 123 456789']]
  )
})

test('Review: Modell darf keine Anweisung mit Kontaktangabe ausblenden', () => {
  const p = open(0, 'Hi Kim', 'An update', 'Please hold the release until Monday.', 'Escalation contact: kim@example.com')
  assert.deepEqual(modelRanges([3], { of: [0], parts: [{ first: 1, lines: [] }] }, [p]), [])
})

test('Zweite Messung: „Besten Gruß“, Dank vor dem Gruß, Fußzeile des Servers, Jahreszahl', () => {
  // „Besten Gruß“ (Einzahl): die Termindaten darüber bleiben Inhalt
  assert.deepEqual(hidden(L('Hallo,', 'Abstimmung Schnittstellen', 'Mittwoch, 2. Dezember 2026, 10:00', 'Raum Elbe', 'Kim Fabrik', 'Besten Gruß / Best regards', 'Alex')), [])
  for (const g of ['Vielen Dank vorab und beste Grüße', 'Thanks in advance and kind regards', 'Lieben Gruß']) {
    assert.equal(findSignatures(L('Hallo,', 'kurze Bitte.', g, 'Alex', 'Contoso GmbH', 'Tel. +49 123 456789'))[0]?.reason, 'closing', g)
  }
  // Fußzeile unter der markierten Signatur (vom Mailserver angehängt) gehört dazu, ein P.S. nicht
  const footer = L('Hallo,', 'anbei.', { text: 'Alex Beispiel', marker: 1 }, { text: 'Tel. +49 123 456789', marker: 1 }, 'Contoso GmbH · Sitz: Musterstadt · Amtsgericht Musterstadt HRB 98765', 'Diese E-Mail enthält vertrauliche Informationen und ist nur für den bestimmungsgemäßen Empfänger gedacht.')
  assert.equal(findSignatures(footer)[0].end, footer.length)
  const ps = L('Hallo,', 'anbei.', { text: 'Alex Beispiel', marker: 1 }, { text: 'Tel. +49 123 456789', marker: 1 }, 'P.S. Die Rechnung kommt separat an buchhaltung@contoso.com.')
  assert.equal(findSignatures(ps)[0].end, 4)
  // „2026 bis“ ist keine Anschrift, „12345 Musterstadt“ und „Musterstraße 1“ schon
  assert.deepEqual(hidden(L('Hallo,', 'Vertrag läuft 2026 bis Ende März', 'Verlängerung 2027 möglich')), [])
  // Nach einer Zeile mit Doppelpunkt ist die Anschrift eine Mitteilung, keine Signatur
  assert.deepEqual(hidden(L('Hallo,', 'neue Anschrift ab Montag:', 'Robin Nord', 'Musterstraße 1', '12345 Musterstadt', 'Tel. +49 30 1234567')), [])
  assert.deepEqual(hidden(L('Hallo,', 'bis morgen.', 'Robin Nord', 'Musterstraße 1', '12345 Musterstadt', 'Tel. +49 30 1234567'), 'Robin Nord').length, 1)
})

test('Review Runde 3: Überschriften, P.S. mit Datenschutz, kurze Anweisungen, Jahreszahl mit Ort', () => {
  // S10: „Project Release“ ist keine Rolle
  assert.deepEqual(hidden(L('Hi,', 'Thanks, See Below', 'Project Release')), [])
  // Echte Rolle ohne Kontakt reicht weiter
  assert.deepEqual(hidden(L('Hallo,', 'passt.', 'Viele Grüße', 'Alex', 'Senior Consultant')), [['Senior Consultant']])
  // S11: langes P.S. mit „data protection“ nach der markierten Signatur bleibt
  const ps = L('Hallo,', 'anbei.', { text: 'Alex', marker: 1 }, { text: 'Tel. +49 123 456789', marker: 1 }, 'P.S. Please also read the new data protection notice before you sign the contract next week.')
  assert.equal(findSignatures(ps)[0].end, 4)
  // S11: Anweisung mit Link unter der markierten Signatur ist keine Server-Fußzeile
  const cancel = L('Hallo,', 'anbei.', { text: 'Alex', marker: 1 }, { text: 'Tel. +49 123 456789', marker: 1 }, 'Please cancel the transfer.', 'https://example.com/transfer/123')
  assert.equal(findSignatures(cancel)[0].end, 4)
  // S12: Modell beginnt bei einer kurzen Anweisung
  const p = open(0, 'Hi Kim', 'An update', 'Hold the release', 'Escalation contact: kim@example.com')
  assert.deepEqual(modelRanges([3], { of: [0], parts: [{ first: 1, lines: [] }] }, [p]), [])
  // S13: „2026 Berlin shipment“ ist keine Anschrift
  assert.deepEqual(hidden(L('Hi,', 'Status:', '2026 Berlin shipment', 'Tracking: https://example.com/track')), [])
  assert.deepEqual(hidden(L('Hallo,', 'anbei.', 'Viele Grüße', 'Alex', 'Contoso AG', '60311 Frankfurt am Main')), [['Contoso AG', '60311 Frankfurt am Main']])
})

test('Dritte Messung: Standardsätze aus Fußzeilen gehören zur Signatur', () => {
  for (const line of [
    'Copyright © 2026 Fabrikam AG. All rights reserved.',
    'Fabrikam refers to a member firm of a global network of independent firms.',
    'Wir sind weder bereit noch verpflichtet, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.',
    'Sie erhalten diese E-Mail, weil Sie für Benachrichtigungen in diesem Projekt eingetragen sind.'
  ]) {
    const r = findSignatures(L('Hallo,', 'passt.', 'Viele Grüße', 'Alex', 'Fabrikam AG · Hafenweg 3 · 20457 Hamburg', line))
    assert.equal(r[0]?.end, 6, line)
  }
  // Ein Satz mit „abmelden“ im Inhalt bleibt Inhalt
  assert.deepEqual(hidden(L('Hallo,', 'ich muss mich für morgen leider abmelden, weil der Arzttermin verschoben wurde.', 'Alex')), [])
})

test('Review Runde 4: jede ausgeblendete Zeile braucht einen Beleg', () => {
  // S13: Jahr und Ort sind keine Postleitzahl
  assert.deepEqual(hidden(L('Hi,', 'Status:', '2026 Berlin Summit', 'Tracking: https://example.com/track')), [])
  // S14: P.S. nach „-- “ und Name bleibt
  assert.deepEqual(hidden(L('The draft is attached.', { text: '--', sep: true }, 'Alex Doe', 'P.S. Do not send the draft.')), [])
  // S15: kurze Anweisung vor einer Mailadresse
  assert.deepEqual(hidden(L('The draft is attached.', 'Thanks,', 'Alex Doe', 'Call me tomorrow', 'alex@example.com')), [])
  assert.deepEqual(hidden(L('The draft is attached.', 'Thanks,', 'Alex Doe', 'Call me tomorrow', 'Tel. +49 170 1234567')), [])
  // S16: Anweisung mit „unsubscribe“ unter der markierten Signatur
  const marked = L('I attached the draft.', { text: 'Alex Doe', marker: 1 }, 'Please unsubscribe the test account before migration.')
  assert.deepEqual(hidden(marked), [])
  // S18: Liste aus Firmen und Links
  assert.deepEqual(hidden(L('I found two vendors for the migration.', 'Northwind GmbH', 'https://northwind.example.com', 'Contoso GmbH', 'https://contoso.example.com')), [])
})

test('Review Runde 4: Modell blendet keine Linkliste und keine Anweisung aus, einen Slogan schon', () => {
  const links = open(0, 'I found two resources.', 'Use these for the rollout.', 'https://docs.example.com/start', 'https://docs.example.com/rollback')
  assert.deepEqual(modelRanges([3], { of: [0], parts: [{ first: 1, lines: [] }] }, [links]), [])
  const call = open(0, 'Hi,', 'see attachment', 'Alex Doe', 'Call me tomorrow', 'Tel. +49 170 1234567')
  assert.deepEqual(modelRanges([3], { of: [0], parts: [{ first: 1, lines: [] }] }, [call]), [])
  // Ein Slogan zwischen Name mit Rolle und Logo geht durch
  const slogan = open(0, 'Hallo,', 'Text', 'Jo Beispiel | Teamleitung Plattform', 'Fabrikam – wir verbinden Systeme.', { text: '', image: true })
  assert.equal(modelRanges([3], { of: [0], parts: [{ first: 1, lines: [] }] }, [slogan]).length, 1)
})

test('Review Runde 5: Satz mit „privacy“ ist kein Fußzeilentext, fremder Kontakt keine Signatur', () => {
  // S20: nach markierter Signatur und nach „-- “
  const sentence = 'One more thing: our privacy team still needs to approve the draft before Friday.'
  const question = 'Does the privacy team need to approve the updated draft before Friday?'
  assert.deepEqual(hidden(L('Draft attached.', { text: 'Alex Doe', marker: 1 }, { text: 'Tel. +49 170 1234567', marker: 1 }, sentence)), [['Tel. +49 170 1234567']])
  assert.deepEqual(hidden(L('Draft attached.', { text: 'Alex Doe', marker: 1 }, { text: 'Tel. +49 170 1234567', marker: 1 }, question)), [['Tel. +49 170 1234567']])
  assert.deepEqual(hidden(L('Draft attached.', { text: '--', sep: true }, 'Alex Doe', sentence)), [])
  // Echte Fußzeilen bleiben Hinweistext
  const footer = L('Hallo,', 'anbei.', { text: 'Alex', marker: 1 }, { text: 'Tel. +49 123 456789', marker: 1 }, 'This e-mail may contain confidential information. If you are not the intended recipient, please notify the sender.', 'Vorstand: Kim Fabrik (Vors.), Jo Beispiel · Aufsichtsrat: Max Muster · weitere Angaben im Impressum unserer Webseite')
  assert.equal(findSignatures(footer)[0].end, footer.length)
  // S21: Kontakt, den die Mail mitteilt
  const contact = L('I found the on-call contact for tonight.', 'Alex Doe', 'Tel. +49 170 1234567')
  assert.deepEqual(hidden(contact, 'Kim Fabrik'), [])
  assert.deepEqual(hidden(contact), [])
  // Zitierter Teil: Absender aus dem Kopf
  const quoted = L('Danke!', 'Von: Robin Nord <robin@northwind.example>', 'Gesendet: Montag', 'Betreff: Kontakt', 'Die Unterlagen liegen im Ordner.', 'Robin Nord', 'Tel: +49 30 1234567')
  assert.deepEqual(hidden(quoted, 'Alex Beispiel'), [['Tel: +49 30 1234567']])
  const quotedOther = L('Danke!', 'Von: Kim Fabrik <kim@fabrikam.de>', 'Gesendet: Montag', 'Betreff: Kontakt', 'Hier der Ansprechpartner für heute Nacht.', 'Robin Nord', 'Tel: +49 30 1234567')
  assert.deepEqual(hidden(quotedOther, 'Alex Beispiel'), [])
})

test('Review Runde 6: „sent in error“ ist Inhalt, gleicher Vorname reicht nicht', () => {
  const billing = 'The invoice was sent in error and we need a corrected copy by Friday.'
  assert.deepEqual(hidden(L('Draft attached.', { text: 'Alex Doe', marker: 1 }, { text: 'Tel. +49 170 1234567', marker: 1 }, billing)), [['Tel. +49 170 1234567']])
  assert.deepEqual(hidden(L('Draft attached.', { text: '--', sep: true }, 'Alex Doe', billing)), [])
  // Der übliche Hinweis bleibt Fußzeilentext
  const notice = L('Hallo,', 'anbei.', { text: 'Alex', marker: 1 }, { text: 'Tel. +49 123 456789', marker: 1 }, 'If you have received this message in error, please notify the sender immediately and delete it.')
  assert.equal(findSignatures(notice)[0].end, notice.length)
  const contact = L('I found the on-call contact for tonight.', 'Alex Doe', 'Tel. +49 170 1234567')
  assert.deepEqual(hidden(contact, 'Alex Kim alex.kim'), [])
  assert.deepEqual(hidden(contact, 'Doe, Alex'), [['Tel. +49 170 1234567']])
})

test('Der Name bleibt sichtbar, ausgeblendet wird erst darunter', () => {
  // Markierte Signatur mit Gruß und Name im Element
  const marked = L('Hi Alex,', 'danke dir.', { text: 'Viele Grüße', marker: 1 }, { text: 'Robin Nord', marker: 1 }, { text: 'Head of Operations | Northwind Traders', marker: 1 }, { text: '+49 30 1234567', marker: 1 })
  assert.deepEqual(hidden(marked), [['Head of Operations | Northwind Traders', '+49 30 1234567']])
  // Name mit Rolle in einer Zeile zählt als Namenszeile
  assert.deepEqual(hidden(L('Hallo,', 'passt.', { text: 'Jo Beispiel | Teamleitung', marker: 1 }, { text: 'Tel. +49 123 456789', marker: 1 })), [['Tel. +49 123 456789']])
  // Beginnt die Signatur mit der Firma, gibt es keinen Namen zu zeigen
  assert.deepEqual(hidden(L('Hallo,', 'passt.', { text: 'Fabrikam AG', marker: 1 }, { text: 'Tel. +49 123 456789', marker: 1 })), [['Fabrikam AG', 'Tel. +49 123 456789']])
  // Nur der Name: nichts auszublenden
  assert.deepEqual(hidden(L('Hallo,', 'passt.', { text: 'Sam Muster', marker: 1 })), [])
})

test('Kopfzeilen zitierter Nachrichten: Bereich und Kurzform', () => {
  const lines = L(
    'Passt, danke!',
    'Von: Kim Fabrik <kim@fabrikam.de>',
    'Gesendet: Mittwoch, 25. November 2026 10:00',
    'An: Alex Beispiel',
    'Cc: Robin Nord',
    'Betreff: Angebot',
    'Hallo Alex, hier das Angebot.',
    '-----Ursprüngliche Nachricht-----',
    'From: "Beispiel, Alex" [mailto:alex@contoso.com]',
    'Sent: Tuesday, November 24, 2026 4:12 PM',
    'Subject: Angebot',
    'Hallo Kim.',
    'Am 23.11.2026 um 09:00 schrieb Kim Fabrik <kim@fabrikam.de>:',
    'Erste Nachricht.'
  )
  assert.deepEqual(findHeaders(lines), [
    { start: 1, end: 6, label: 'Kim Fabrik · Mittwoch, 25. November 2026 10:00' },
    { start: 7, end: 11, label: 'Beispiel, Alex · Tuesday, November 24, 2026 4:12 PM' }
  ])
  // Ohne Zitat keine Kopfzeilen, „Von:“ im Fließtext zählt nicht
  assert.deepEqual(findHeaders(L('Hallo', 'Von: wem kommt das?', 'Grüße')), [])
})

test('Review Kopfzeilen: Inhalt nach dem Kopf, Weiterleitung, zwei Köpfe, nur Adresse', () => {
  // S1: „An: …“ nach dem Kopf ist Inhalt, auch wenn der Kopf selbst kein „An:“ hatte
  assert.equal(findHeaders(L('Ok', 'Von: Kim Fabrik', 'Gesendet: Montag', 'Betreff: x', 'An: Bitte bis Freitag weiterleiten.', 'Gruß'))[0].end, 4)
  const s1 = L('Danke!', 'Von: Kim Fabrik <kim@fabrikam.de>', 'Gesendet: Montag', 'An: Alex Beispiel', 'Betreff: Angebot', 'An: Bitte bis Freitag weiterleiten.', 'Gruß Kim')
  assert.deepEqual(findHeaders(s1), [{ start: 1, end: 5, label: 'Kim Fabrik · Montag' }])
  // Wichtigkeit darf nach dem Betreff stehen, „Von:“ allein ist kein Kopf
  assert.equal(findHeaders(L('Ok', 'Von: Kim Fabrik', 'Gesendet: Montag', 'Betreff: x', 'Wichtigkeit: Hoch', 'Text'))[0].end, 5)
  assert.deepEqual(findHeaders(L('Ok', { text: 'Von: Kim', boundary: true }, 'Text')), [])
  // S3: Weiterleitung ohne eigenen Text
  const s3 = L('---------- Forwarded message ---------', 'From: Kim Fabrik <kim@fabrikam.de>', 'Date: Mon, Nov 23, 2026', 'Subject: Angebot', 'To: Alex', 'Hallo Alex.')
  assert.deepEqual(findHeaders(s3), [{ start: 0, end: 5, label: 'Kim Fabrik · Mon, Nov 23, 2026' }])
  // S4: „On … wrote:“ direkt unter einem Outlook-Kopf beginnt eine eigene Nachricht und bleibt stehen
  const s4 = L('Danke!', 'From: Kim Fabrik', 'Sent: Monday', 'Subject: x', 'On Mon, Nov 23, 2026 at 9:00 AM Alex Doe <alex@example.com> wrote:', 'Erste Nachricht.')
  assert.deepEqual(partStarts(s4), [0, 1, 4])
  assert.deepEqual(findHeaders(s4), [{ start: 1, end: 4, label: 'Kim Fabrik · Monday' }])
  // Markiertes Zitat direkt nach „Am … schrieb …:“ ist derselbe Teil
  assert.deepEqual(partStarts(L('Ok', { text: 'Am 23.11.2026 um 09:00 schrieb Kim Fabrik <kim@fabrikam.de>:', boundary: true }, { text: 'Hallo.', boundary: true })), [0, 1])
  // S5: nur Adresse
  assert.equal(findHeaders(L('Ok', 'From: <kim@example.com>', 'Sent: Monday', 'Subject: x', 'Text'))[0].label, 'kim@example.com · Monday')
})

test('Review Name: Initiale, Akzente und der Name des Absenders bleiben sichtbar', () => {
  const sig = (name: string) => L('Hallo,', 'passt.', { text: name, marker: 1 }, { text: 'Tel. +49 123 456789', marker: 1 })
  assert.deepEqual(hidden(sig('J. Smith')), [['Tel. +49 123 456789']])
  assert.deepEqual(hidden(sig('José Álvarez')), [['Tel. +49 123 456789']])
  // Sieht nicht wie ein Name aus, gehört aber zum Absender
  assert.deepEqual(hidden(sig('SMITH, J. (Contoso)'), 'Smith, John'), [['Tel. +49 123 456789']])
  assert.deepEqual(hidden(sig('SMITH, J. (Contoso)')), [['SMITH, J. (Contoso)', 'Tel. +49 123 456789']])
})

test('Messung: Trennlinien, „Tel:“ allein und Fußzeilen ohne Gruß', () => {
  // „--“ zwischen Signaturzeilen unterbricht den Block nicht
  assert.deepEqual(
    hidden(L('Hallo,', 'passt.', 'Vielen Dank vorab und beste Grüße', 'Kim', '--', 'Kim Fabrik', 'Leitung Integration | Fabrikam', 'Hafenweg 3, 20457 Hamburg', 'Tel:', '+49 40 1234567')),
    [['--', 'Kim Fabrik', 'Leitung Integration | Fabrikam', 'Hafenweg 3, 20457 Hamburg', 'Tel:', '+49 40 1234567']]
  )
  // Benachrichtigung: Fußzeile ohne Gruß und Namen
  const note = L('Ihr Bericht ist fertig.', 'Sie können ihn im Portal herunterladen.', 'Fabrikam AG · Hafenweg 3 · 20457 Hamburg', 'Sitz der Gesellschaft: Hamburg · HRB 123456', 'Copyright © 2026 Fabrikam AG. All rights reserved.')
  assert.deepEqual(hidden(note), [note.slice(2).map((l) => l.text)])
  assert.equal(findSignatures(note)[0].reason, 'footer')
  // Ohne eindeutigen Fußzeilentext bleibt alles stehen, auch mit zwei einschlägigen Wörtern im Satz
  assert.deepEqual(hidden(L('Hallo,', 'kurzes Update.', 'Der Vorstand und der Aufsichtsrat haben dem Vorschlag gestern in der Sitzung einstimmig zugestimmt.')), [])
  assert.deepEqual(hidden(L('Hallo,', 'kurzes Update.', 'Das Amtsgericht hat den Termin auf den 12. Januar verlegt, wir müssen also umplanen.')), [])
  assert.deepEqual(hidden(L('Hallo,', 'wir müssen das Copyright für die Bilder noch klären, bevor die Seite online geht.')), [])
  // Aufzählung nach Doppelpunkt ist keine Fußzeile
  assert.deepEqual(hidden(L('Hallo,', 'unsere neuen Daten:', 'Fabrikam AG · Hafenweg 3 · 20457 Hamburg', 'HRB 123456, Sitz der Gesellschaft: Hamburg, Registergericht Hamburg, USt-IdNr. DE123456789')), [])
})

test('Review Fußzeile: mitgeteilte Telefonnummer vor dem Disclaimer bleibt sichtbar', () => {
  const disclaimer = 'This e-mail may contain confidential information. If you are not the intended recipient, please notify the sender.'
  assert.deepEqual(hidden(L('You can reach the venue directly.', '+49 40 1234567', disclaimer)), [[disclaimer]])
  assert.deepEqual(hidden(L('Hallo,', 'die Adresse lautet', 'Hafenweg 3, 20457 Hamburg', disclaimer)), [[disclaimer]])
})

test('Messung Kopfzeilen und Name: Bild vor dem Namen, Team als Unterzeichner, Ticket-Kopf', () => {
  // Bild zwischen Grußformel und Name: Name bleibt sichtbar
  const img = L('Hallo,', 'passt.', 'Mit freundlichen Grüßen, Best regards', { text: '', image: true }, 'Kim Fabrik', 'Leitung Integration', 'Tel. +49 40 1234567')
  assert.deepEqual(hidden(img), [['Leitung Integration', 'Tel. +49 40 1234567']])
  const marked = L('Hallo,', 'passt.', { text: 'Besten Gruß / Best regards', marker: 1 }, { text: '', image: true, marker: 1 }, { text: 'Kim Fabrik', marker: 1 }, { text: 'Tel. +49 40 1234567', marker: 1 })
  assert.deepEqual(hidden(marked), [['Tel. +49 40 1234567']])
  // Team oder Firma direkt nach dem Gruß unterschreibt und bleibt sichtbar
  assert.deepEqual(hidden(L('Hallo,', 'Ticket ist gelöst.', 'Viele Grüße', 'Ihr Servicedesk Team', 'Fabrikam AG', 'Tel. +49 40 1234567')), [['Fabrikam AG', 'Tel. +49 40 1234567']])
  assert.deepEqual(hidden(L('Hallo,', 'Ticket ist gelöst.', 'Viele Grüße', 'Fabrikam AG', 'Hafenweg 3, 20457 Hamburg', 'Tel. +49 40 1234567')), [['Hafenweg 3, 20457 Hamburg', 'Tel. +49 40 1234567']])
  // Ticket-Mail: Trenner mit Leerzeichen, „Received:“ als Datum, Werte mit Semikolon
  const ticket = L('Neuer Kommentar.', '------------------- Original Message -------------------', 'From: Kim Fabrik <kim@fabrikam.de>;', 'Received: Mon Nov 23 2026 09:00', 'To: Support;', 'Subject: Störung', 'Text der Anfrage.')
  assert.deepEqual(partStarts(ticket), [0, 1])
  assert.deepEqual(findHeaders(ticket), [{ start: 1, end: 6, label: 'Kim Fabrik · Mon Nov 23 2026 09:00' }])
  // „Im Auftrag von“ gehört nicht zum Namen
  assert.equal(findHeaders(L('Ok', 'Von: Kim Fabrik <kim@fabrikam.de> Im Auftrag von Support <support@fabrikam.de>', 'Gesendet: Montag', 'Betreff: x', 'Text'))[0].label, 'Kim Fabrik · Montag')
})

test('Messung Fußzeilen: Beschriftungen, US-Anschrift, Abmelden', () => {
  // Fußzeile des Mailservers mit Beschriftungen unter einer markierten Signatur
  const gateway = L(
    'Hallo,', 'anbei.',
    { text: 'Kim Fabrik', marker: 1 }, { text: 'Tel. +49 40 1234567', marker: 1 },
    'Fabrikam GmbH & Co. KG', 'Registry Court:', 'Amtsgericht Hamburg, HRA 12345', 'Sitz der Gesellschaft/Registered Office:', 'Hafenweg 3, 20457 Hamburg',
    'Vertreten durch: Fabrikam Verwaltungs GmbH', 'Phone:', '+49 40 1234567', 'Management: Kim Fabrik',
    'Diese E-Mail enthält vertrauliche Informationen. Wenn Sie nicht der richtige Adressat sind oder sie irrtümlich erhalten haben, informieren Sie bitte den Absender.'
  )
  assert.equal(findSignatures(gateway)[0].end, gateway.length)
  // Dieselbe Fußzeile ohne Signatur davor
  const bare = L('Die Rechnung liegt bei.', ...gateway.slice(4))
  assert.deepEqual(findSignatures(bare), [{ start: 1, end: bare.length, reason: 'footer' }])
  // Newsletter: Copyright, US-Anschrift, Abmelden
  const news = L('Your weekly summary is ready.', 'Open the dashboard to see details.', 'Copyright © 2026 Northwind Inc. All rights reserved.', '500 Market St #300, San Francisco, CA 94105', 'Unsubscribe')
  assert.deepEqual(findSignatures(news), [{ start: 2, end: 5, reason: 'footer' }])
})

test('Review Runde 10: „Received:“ ohne Datum, Kontaktdaten hinter „---“, Vertretungsangabe', () => {
  // Lagermeldung: „Received: 12 pallets“ ist Inhalt, kein Kopffeld
  const stock = L('Zur Info.', 'From: Warehouse North', 'Subject: Inbound update', 'Received: 12 pallets', 'Missing: 2 pallets')
  assert.deepEqual(findHeaders(stock), [{ start: 1, end: 3, label: 'Warehouse North' }])
  assert.deepEqual(findHeaders(L('Zur Info.', 'From: Warehouse North', 'Received: 12 pallets', 'Missing: 2 pallets')), [])
  assert.deepEqual(findHeaders(L('Ok', 'Von: Kim Fabrik', 'Empfangen: 24.11.2026 09:00', 'Betreff: x', 'Text')), [{ start: 1, end: 4, label: 'Kim Fabrik · 24.11.2026 09:00' }])
  // Mitgeteilte Kontaktdaten unter einer markierten Signatur bleiben sichtbar
  const venue = L('Hallo,', 'hier die Daten des Hotels.', { text: 'Kim Fabrik', marker: 1 }, { text: 'Tel. +49 40 1234567', marker: 1 }, '---', 'Website:', 'https://hotel.example.com', '+49 40 7654321')
  assert.deepEqual(hidden(venue), [['Tel. +49 40 1234567']])
  // Mit Registerzeile ist es die Fußzeile des Servers
  assert.equal(findSignatures(L(...venue, 'Fabrikam GmbH · Amtsgericht Hamburg HRB 12345'))[0].end, venue.length + 1)
  // Vertragsmail: Der Vertreter ist Inhalt, nur der Hinweis fällt weg
  const disclaimer = 'This e-mail may contain confidential information. If you are not the intended recipient, please notify the sender.'
  assert.deepEqual(hidden(L('The agreement names the following party.', 'Represented by: Jane Doe', disclaimer)), [[disclaimer]])
  assert.deepEqual(hidden(L('Der Vertrag nennt folgende Partei.', 'Vertreten durch: Kim Fabrik', disclaimer)), [[disclaimer]])
})
