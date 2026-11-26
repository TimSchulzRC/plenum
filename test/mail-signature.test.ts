import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findSignatures, modelRanges, modelRequest, partStarts, type SigLine } from '../src/renderer/src/lib/mail-signature.ts'

const L = (...texts: (string | SigLine)[]): SigLine[] => texts.map((t) => (typeof t === 'string' ? { text: t } : t))
const hidden = (lines: SigLine[]) => findSignatures(lines).map((r) => lines.slice(r.start, r.end).map((l) => l.text))

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
  assert.deepEqual(hidden(marked), [['Sam Muster', 'IT-Service']])
  assert.equal(findSignatures(marked)[0].reason, 'marker')
  // P.S. unter der markierten Signatur bleibt sichtbar
  const ps = L('Hallo,', 'kurze Frage zum Termin.', { text: 'Sam Muster', marker: 1 }, { text: 'IT-Service', marker: 1 }, 'P.S. Bitte bis Freitag.')
  assert.deepEqual(hidden(ps), [['Sam Muster', 'IT-Service']])
  // Eine „--“-Linie im Text ist kein Trenner, „-- “ mit Leerzeichen schon
  assert.deepEqual(hidden(L('Agenda', '--', 'Punkt eins ist wichtig, weil wir sonst nicht weiterkommen.', 'Punkt zwei auch, das klären wir morgen.')), [])
  assert.deepEqual(hidden(L('Agenda', { text: '--', sep: true }, 'Robin Nord')), [['--', 'Robin Nord']])
  const gmail = L('Klingt gut, bis Freitag!', '--', { text: 'Sam Muster', marker: 1 }, { text: 'Mobil: +49 151 23456789', marker: 1 })
  assert.deepEqual(hidden(gmail), [['--', 'Sam Muster', 'Mobil: +49 151 23456789']])
  const dashes = L('Hallo,', 'siehe unten.', '-- ', 'Robin Nord', 'Northwind Traders')
  assert.deepEqual(hidden(dashes), [['-- ', 'Robin Nord', 'Northwind Traders']])
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
  assert.deepEqual(hidden(lines), [['Robin Nord', 'Northwind Traders GmbH', 'Tel: +49 30 1234567', 'robin@northwind.example']])
  assert.equal(findSignatures(lines)[0].reason, 'contact')
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
  assert.deepEqual(modelRanges([3], req, [p]), [{ start: 7, end: 10, reason: 'model' }])
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
  assert.deepEqual(hidden(L('Lieber Kim,', { text: prose, marker: 1 }, { text: 'Alex', marker: 1 }, { text: 'Tel. +49 123 456789', marker: 1 })), [['Alex', 'Tel. +49 123 456789']])
})

test('Modell: erste gezeigte Zeile und Blöcke über 15 Zeilen werden verworfen', () => {
  const p = open(0, 'Hallo,', 'Text', 'Jo Beispiel | Teamleitung', 'Fabrikam – wir verbinden Systeme.', { text: '', image: true })
  const req = { of: [0], parts: [{ first: 2, lines: ['Text', 'Jo Beispiel | Teamleitung', 'Fabrikam – wir verbinden Systeme.', '[Bild]'] }] }
  assert.deepEqual(modelRanges([2], req, [p]), [])
  assert.deepEqual(modelRanges([3], req, [p]), [{ start: 2, end: 5, reason: 'model' }])
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
    [['Alex Beispiel', 'Tel. +49 123 456789']]
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
  assert.deepEqual(hidden(L('Neue Anschrift ab Montag:', 'Robin Nord', 'Musterstraße 1', '12345 Musterstadt', 'Tel. +49 30 1234567')).length, 1)
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
