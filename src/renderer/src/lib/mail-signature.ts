import type { MailSignaturePart } from '@shared/types'

// Signaturen in Mails finden, ohne DOM, damit die Tests es direkt laden.
// Eingabe sind die sichtbaren Zeilen der Mail (Absätze, <br>-Zeilen, Tabellenzellen) in Reihenfolge.
// Ein Verlauf besteht aus Teilen: oben die neue Nachricht, darunter je ein zitierter Kopf
// („Von: … Gesendet: … Betreff:“) mit seiner Nachricht. Jeder Teil hat höchstens eine Signatur,
// sie reicht bis zum Ende des Teils, eine vom Client markierte bis zum Ende ihres Elements.

export interface SigLine {
  text: string
  // Liegt in einem Element, das der Mail-Client als Signatur markiert (id/class „Signature“ …).
  // Eine Zahl je Element, damit die Signatur an dessen Ende aufhört.
  marker?: number
  // Signaturtrenner „-- “ mit Leerzeichen (RFC 3676), nicht nur „--“
  sep?: boolean
  // Beginnt einen zitierten Teil (Outlook-Antwortkopf, gmail_quote, blockquote type=cite …)
  boundary?: boolean
  // Enthält ein Bild (Logo, Social-Media-Symbole)
  image?: boolean
}

export interface SigRange {
  start: number
  // exklusiv: erste Zeile des nächsten Teils oder Ende
  end: number
  reason: 'marker' | 'dashes' | 'mobile' | 'closing' | 'contact' | 'footer' | 'model'
}

// Grußformeln, nach denen Name und Signatur folgen
const CLOSING =
  /^(?:(?:mit\s+)?(?:(?:den\s+)?(?:besten|beste|vielen|viele|liebe|lieben|herzliche|herzlichen|schöne|schönen|sonnige|sonnigen|freundliche|freundlichen|kollegiale|kollegialen|beste|besten|lieben|herzlichen)\s+)?gr(?:ü|ue|u)(?:ß|ss)(?:e|en)?(?:\s+(?:aus|nach|in|vom|von)\b.*)?|mfg|lg|vg|bg|gruß|gruss|danke(?:\s+und\s+(?:viele\s+)?gr(?:ü|ue)(?:ß|ss)e)?|vielen\s+dank(?:\s+und\s+(?:viele\s+)?gr(?:ü|ue)(?:ß|ss)e)?|(?:best|kind|warm|warmest)\s+(?:regards|wishes)|regards|best|cheers|thanks|thank\s+you|many\s+thanks|sincerely|yours\s+(?:sincerely|truly)|all\s+the\s+best|cordialement|saludos)[\s,.!]*$/i

// Kopf eines zitierten Teils, als Text erkannt (falls das HTML keine Markierung hat)
const HEADER_FROM = /^(?:von|from|de|da)\s*:\s*\S/i
const HEADER_DATE = /^(?:gesendet|sent|datum|date|received|empfangen)\s*:\s*/i
// Auch mit Leerzeichen zwischen den Strichen („- - - Original Message - - -“)
const ORIGINAL = /^(?:-[-\s]*(?:ursprüngliche nachricht|original message|weitergeleitete nachricht|forwarded message)[-\s]*-|(?:anfang der weitergeleiteten nachricht|begin forwarded message)\s*:)$/i
// Felder eines Kopfes. Jedes kommt höchstens einmal vor.
const FIELDS: [RegExp, string][] = [
  [/^(?:von|from|de|da)\s*:/i, 'from'],
  [/^(?:gesendet|sent|datum|date|received|empfangen)\s*:/i, 'date'],
  [/^(?:an|to)\s*:/i, 'to'],
  [/^(?:cc|kopie)\s*:/i, 'cc'],
  [/^bcc\s*:/i, 'bcc'],
  [/^(?:antwort an|reply-to)\s*:/i, 'replyto'],
  [/^(?:betreff|subject)\s*:/i, 'subject'],
  [/^(?:wichtigkeit|importance|priorität|priority)\s*:/i, 'importance'],
  [/^(?:anlagen|attachments)\s*:/i, 'attachments']
]
// „Received:“ und „Empfangen:“ stehen auch im Inhalt („Received: 12 pallets“). Als Kopffeld zählen
// sie nur mit Jahr, Uhrzeit oder Datum im Wert.
const RECEIVED = /^(?:received|empfangen)\s*:/i
const DATED = /\b\d{1,2}:\d{2}\b|\b(?:19|20)\d{2}\b|\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/
function fieldKey(text: string): string | undefined {
  const t = text.trim()
  if (RECEIVED.test(t) && !DATED.test(t)) return undefined
  return FIELDS.find(([re]) => re.test(t))?.[1]
}
const WROTE = /^(?:am|on)\s.{4,160}\s(?:schrieb|wrote)\b.{0,160}:$/i

const PHONE_RE = /(?:\+|00)\d[\d\s/().-]{6,}\d|\(?0\d{2,5}\)?[\s/-]?\d[\d\s/-]{4,}\d/g
const PHONE = /(?:^|\s|:)(?:\+|00)\d[\d\s/().-]{6,}\d|(?:tel|telefon|phone|fon|mobil|mobile|handy|fax|direkt|zentrale|t|m|f)\.?\s*:?\s*[+(]?\d[\d\s/().-]{5,}\d/i
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
const URL_G = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:de|com|net|org|eu|io|at|ch|info|biz|dev|example)\b(?:\/\S*)?/gi
const has = (re: RegExp, t: string) => {
  re.lastIndex = 0
  return re.test(t)
}
// Postleitzahl mit Ort als ganze Ortsangabe („12345 Musterstadt“, „60311 Frankfurt am Main“, „A-1010 Wien“).
// Vierstellig nur mit Länderkürzel: „2026 Berlin Summit“ ist ein Jahr.
const ADDRESS_PLZ = /(?:^|[\s,|·])(?:\d{5}|(?:A|AT|CH|D|DE|NL|B|L)-\s?\d{4,5})\s+[A-ZÄÖÜ][\wäöüß.-]+(?:\s+(?:[A-ZÄÖÜ(][\wäöüß.()-]*|am|an|im|in|a\.|bei|ob|vor|der))*\s*(?:$|[|·,;–])/
const ADDRESS_STREET = /(?:straße|strasse|str\.|weg|platz|allee|gasse|ring|damm|ufer)\s*\d+[a-z]?\b/i
// „San Francisco, CA 94107“
const ADDRESS_US = /\b[A-Z][A-Za-z .]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/
const ADDRESS = { test: (t: string) => ADDRESS_PLZ.test(t) || ADDRESS_STREET.test(t) || ADDRESS_US.test(t) }
// Rechtsform nach einem Namen, in üblicher Schreibweise: „Contoso GmbH“, nicht „AG“ für Arbeitsgruppe
const COMPANY = /[A-ZÄÖÜ0-9][\w&.-]*\s+(?:GmbH|gGmbH|mbH|AG|KG|OHG|KGaA|SE|UG|e\.\s?K\.|e\.\s?V\.|Ltd\.?|Limited|Inc\.?|LLC|Corp\.?|PLC|S\.A\.|B\.V\.)(?=$|[\s,.;:|·&)–-])/
const LEGAL_HARD =
  /\b(?:geschäftsführ|vorstand|aufsichtsrat|amtsgericht|registergericht|handelsregister|hrb|hra|ust-?id|umsatzsteuer|steuer-?nr|sitz der gesellschaft|vat|registered office|company registration|registry court|register court|commercial register|managing directors?|komplementär\w*|datenschutz|data protection|privacy|impressum)/i
// Stehen in Fußzeilen, aber auch im Inhalt („Represented by: Jane Doe“ in einer Vertragsmail): Sie
// dürfen in einer Fußzeile vorkommen, belegen und beginnen aber keine.
const LEGAL_SOFT = /\b(?:vertreten durch|represented by|management\s*:|postanschrift)/i
const LEGAL = { test: (t: string) => LEGAL_HARD.test(t) || LEGAL_SOFT.test(t) }
// Hinweise und Standardsätze aus Fußzeilen: Vertraulichkeit, Umwelt, Netzwerk von
// Prüfungsgesellschaften, Streitbeilegung, Newsletter und Benachrichtigungen
const DISCLAIMER =
  /\b(?:vertraulich|confidential|disclaimer|irrtümlich|in error|intended recipient|bestimmungsgemäß|unbefugte|unauthori[sz]ed|ausdrucken|before printing|the environment|der umwelt|member firms?|mitgliedsunternehmen|streitbeilegung|schlichtungsstelle|dispute resolution|unsubscribe (?:here|from)|click here to unsubscribe|newsletter abbestellen|vom newsletter abmelden|you(?: are)? receiv(?:e|ed|ing) this|sie erhalten diese (?:e-?mail|nachricht|benachrichtigung))/i
// Copyright-Vermerk, nicht das Wort im Satz („wir müssen das Copyright klären“)
const COPYRIGHT = /©|\(c\)\s*\d{4}|\bcopyright\s*(?:©|\(c\)|\d{4})|all rights reserved|alle rechte vorbehalten/i
const JOB = /\b(?:geschäftsführer|consultant|berater|manager|leiter|leitung|head of|director|engineer|entwickler|developer|assistant|assistenz|vertrieb|sales|support|projekt|project|team|abteilung|department|ceo|cto|cfo|coo|partner|inhaber|owner|referent|sachbearbeit|specialist|spezialist|architekt)/i
// Echte Rolle, die allein eine Signatur belegt („Senior Consultant“, „Leitung Integration“), nicht
// allgemeine Wörter wie „Projekt“ oder „Team“
const ROLE = /\b(?:geschäftsführer(?:in)?|consultant|berater(?:in)?|manager(?:in)?|\w*leiter(?:in)?|\w*leitung|head of|director|direktor(?:in)?|engineer|ingenieur(?:in)?|entwickler(?:in)?|developer|assistant|assistenz|ceo|cto|cfo|coo|inhaber(?:in)?|owner|referent(?:in)?|sachbearbeiter(?:in)?|specialist|spezialist(?:in)?|architekt(?:in)?|vorstand|prokurist(?:in)?|teamlead|team lead)\b/i

const isSep = (l: SigLine) => !!l.sep || /^--[  ]$/.test(l.text)

// ---------- Zeilenklassen ----------
// Grundsatz: Ausgeblendet wird nur, was einen eigenen Beleg hat. „Kurz“ allein reicht nicht, und
// im Zweifel bleibt eine Zeile sichtbar.

const PS = /^p\.?\s?(?:p\.?\s?)?s\.?(?:[\s:]|$)/i
// Anweisung oder Bitte am Zeilenanfang: immer Inhalt
const IMPERATIVE =
  /^(?:please|kindly|bitte|could you|can you|would you|kannst du|könntest du|können sie|könnten sie|call|send|hold|let|see|check|ask|tell|use|read|note|ruf|rufe|schick|schicke|melde|gib|sag|bring|komm|denk|beachte|prüf|prüfe|siehe)\b/i

// Rechts- oder Hinweistext aus einer Fußzeile: Copyright, oder ein langer Satz mit einschlägigem Begriff
// Wendungen, die nur in Fußzeilen stehen, und einzelne Wörter, die auch im Inhalt vorkommen („unser
// Datenschutz-Team“): Letztere zählen erst zu zweit.
const FOOTER_PHRASE =
  /\b(?:HR[AB]\s*\d+|registergericht|handelsregister|ust-?id|umsatzsteuer-?id|steuer-?nr|sitz der gesellschaft|registered office|company registration|registry court|commercial register|(?:irrtümlich|versehentlich|fälschlich\w*) erhalten|receiv\w+ (?:this|it)\b.{0,40}\bin error|intended recipient|bestimmungsgemäße[nr]? (?:empfänger|adressat)|unbefugte[sn]? (?:weitergabe|nutzung|verwendung|kopieren|kenntnisnahme)|unauthori[sz]ed (?:use|disclosure|copying|review|distribution|dissemination)|(?:vor dem|bevor sie) (?:aus)?drucken|before (?:you )?print(?:ing)?|member firms?|mitgliedsunternehmen|streitbeilegung|schlichtungsstelle|dispute resolution|unsubscribe (?:here|from)|click here to unsubscribe|newsletter abbestellen|vom newsletter abmelden|you(?: are)? receiv(?:e|ed|ing) this (?:e-?mail|message|notification|newsletter)|sie erhalten diese (?:e-?mail|nachricht|benachrichtigung))/i
const FOOTER_WORDS = /\b(?:geschäftsführ\w*|vorstand|aufsichtsrat|datenschutz\w*|data protection|privacy|impressum|vertraulich\w*|confidential|disclaimer|umwelt|environment|vat)\b/gi
// Eindeutiger Fußzeilentext: Copyright-Vermerk oder ein langer Satz mit einer Wendung, die nur dort steht
function strongBoilerplate(l: SigLine): boolean {
  const t = l.text.trim()
  if (PS.test(t) || IMPERATIVE.test(t) || /\?$/.test(t)) return false
  return COPYRIGHT.test(t) || (t.length > 60 && FOOTER_PHRASE.test(t))
}

function boilerplate(l: SigLine): boolean {
  const t = l.text.trim()
  if (PS.test(t) || IMPERATIVE.test(t) || /\?$/.test(t)) return false
  if (strongBoilerplate(l)) return true
  return t.length > 60 && new Set((t.match(FOOTER_WORDS) ?? []).map((w) => w.toLowerCase())).size >= 2
}

// Trennlinie („--“, „---“, „___“, „- - -“) und Beschriftung ohne Wert („Tel:“ vor der Nummer in der
// nächsten Zeile): weder Inhalt noch Beleg, sie unterbrechen einen Signaturblock nicht
const ruleLine = (l: SigLine) => /^[-–—_=*\s]{2,}$/.test(l.text)
const bareLabel = (l: SigLine) =>
  /^[|·\s]*(?:(?:tel|telefon|phone|fon|mobil|mobile|fax|e-?mail|web|internet|website|homepage)\.?\s*:?|unsubscribe|abmelden|abbestellen|chat with me (?:on|in) teams!?)$/i.test(l.text.trim())

// Inhalt, der nie in einer Signatur steht: ein P.S., eine Anweisung, eine Frage oder ein ganzer Satz
// (ab sechs Wörtern mit Satzzeichen am Ende), auch mit Mailadresse oder Telefonnummer darin
function prose(l: SigLine): boolean {
  const t = l.text.trim()
  if (PS.test(t) || IMPERATIVE.test(t) || /\?$/.test(t)) return true
  if (boilerplate(l)) return false
  return t.split(/\s+/).length >= 6 && /[.!:]$/.test(t)
}

// Klein geschriebene Wörter, die weder Kontaktangabe noch Beschriftung noch Bindewort sind. In
// Signaturzeilen kommen sie kaum vor („Tel. +49 …“, „Contoso GmbH | Musterstraße 1“), in Sätzen
// immer („Call me tomorrow“).
const LABELS = new Set(
  'tel telefon phone fon mobil mobile handy fax direkt zentrale durchwahl e-mail email mail web www internet homepage website t m f e i v a ppa pp und and oder or von of für for der die das den dem des am im in an at auf bei the de la le van zu zur zum mit'.split(' ')
)
function stray(text: string): number {
  const rest = text.replace(URL_G, ' ').replace(EMAIL_RE, ' ').replace(PHONE_RE, ' ')
  let n = 0
  for (const w of rest.split(/[\s|·•,;:()/&+–-]+/)) {
    const word = w.replace(/\.$/, '')
    if (/^\p{Ll}/u.test(word) && !LABELS.has(word.toLowerCase())) n++
  }
  return n
}

// Position als eigene Zeile („Senior Consultant“, „Head of Operations | Northwind“), kein Satz
const jobLine = (l: SigLine) => JOB.test(l.text) && l.text.length <= 100 && !/[.!?]\s*$/.test(l.text)
const roleLine = (l: SigLine) => jobLine(l) && ROLE.test(l.text) && stray(l.text) <= 2

// Angabe, die nur in Signaturen steht: Telefon, Anschrift, Firma, Register, Rolle oder ein Bild
function specific(l: SigLine): boolean {
  if (prose(l)) return false
  const t = l.text
  if (l.image && !t.trim()) return true
  if (roleLine(l)) return true
  if (LEGAL.test(t) && t.length <= 160 && stray(t) <= 2) return true
  if (stray(t) > 1) return false
  return PHONE.test(t) || ADDRESS.test(t) || (COMPANY.test(t) && t.length < 120)
}

// Mailadresse oder Link als eigene Zeile, höchstens mit Beschriftung. Kommt auch in Inhalt vor und
// belegt deshalb allein keine Signatur.
const link = (l: SigLine) => !prose(l) && (has(EMAIL_RE, l.text) || has(URL_G, l.text)) && stray(l.text) <= 1

// Name, Abteilung oder Firma ohne Rechtsform: wenige groß geschriebene Wörter ohne Satzzeichen am Ende
function filler(l: SigLine): boolean {
  const t = l.text.trim()
  return !!t && t.length <= 60 && t.split(/\s+/).length <= 6 && /[A-Za-zÄÖÜäöüß]/.test(t) && !/[.!?:]$/.test(t) && stray(t) === 0 && !prose(l)
}

// Personenname: zwei bis vier groß geschriebene Wörter, optional mit Titel oder „i. V.“
// Auch mit Initiale („J. Smith“) und Buchstaben aller Sprachen („José Álvarez“)
const PROPER_NAME =
  /^(?:(?:i\.\s?[AV]\.|ppa\.|pp\.)\s+)?(?:(?:Dr\.|Prof\.|Dipl\.-\p{L}+\.?|Mag\.|Ing\.)\s+)*\p{Lu}(?:\.|[\p{L}'’-]+)(?:\s+(?:\p{Lu}(?:\.|[\p{L}'’.-]*)|von|van|de|der|zu|da|del|la|le)){1,3}$/u
const properName = (l: SigLine) => PROPER_NAME.test(l.text.trim()) && !COMPANY.test(l.text) && !JOB.test(l.text)

// Zeile, die in einem Signaturblock stehen darf
const blockLine = (l: SigLine) => specific(l) || link(l) || boilerplate(l) || filler(l) || ruleLine(l) || bareLabel(l) || (!!l.image && l.text.length < 120 && stray(l.text) <= 1) || sentFrom(l.text)

// Ein Block ist nur dann Signatur, wenn jede Zeile hineinpasst und mindestens eine Angabe nur in
// Signaturen vorkommt. Listen aus Links oder Mailadressen sind Inhalt.
const validBlock = (lines: SigLine[]) => lines.length > 0 && lines.every(blockLine) && lines.some(specific)

// „Gesendet von Outlook für iOS“, „Von meinem iPhone gesendet“, „Sent from my iPhone“: nur diese
// festen Varianten, nichts dahinter
const SENT_FROM = [
  /^(?:gesendet|sent)\s+(?:von|from|mit|with|via)\s+(?:meinem\s+|mein\s+|my\s+)?(?:outlook|iphone|ipad|android(?:-gerät|\s+device)?|samsung(?:\s+galaxy(?:\s+smartphone)?)?|mobile|mobilgerät|mobiltelefon|smartphone|handy|blackberry|gmail|yahoo\s+mail|mail)(?:\s+(?:für|for)\s+(?:ios|android|mac|windows))?\.?$/i,
  /^von\s+meinem\s+(?:iphone|ipad|android-gerät|samsung\s+galaxy\s+smartphone|smartphone|handy|mobilgerät)\s+gesendet\.?$/i,
  /^(?:outlook|gmail)\s+für\s+(?:ios|android)\s+(?:beziehen|herunterladen)$/i,
  /^get\s+outlook\s+for\s+(?:ios|android)$/i
]
const sentFrom = (t: string) => SENT_FROM.some((r) => r.test(t.trim()))

// Grußformel, auch zweisprachig („Viele Grüße | Best regards“, „Danke / Grüße“) und mit Name in
// derselben Zeile („Viele Grüße, Alex“)
const THANKS_AND = /^(?:vielen\s+dank|danke(?:\s+(?:dir|ihnen|euch))?|thanks|thank\s+you|many\s+thanks)(?:\s+(?:vorab|im\s+voraus|schon\s+mal|in\s+advance))?\s+(?:und|and)\s+/i

function closingLine(t: string): { closing: boolean; name: boolean } {
  const segs = t
    .trim()
    .split(/\s+[-–]\s+|\s*[|/,;·]\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!segs.length) return { closing: false, name: false }
  // „Vielen Dank vorab und beste Grüße“, „Thanks in advance and kind regards“: Dank davor zählt mit
  const isClosing = (s: string) => CLOSING.test(s) || CLOSING.test(s.replace(THANKS_AND, ''))
  if (segs.every(isClosing)) return { closing: true, name: false }
  const k = segs.findIndex((s) => !isClosing(s))
  // Name in derselben Zeile: ein bis drei groß geschriebene Wörter („Viele Grüße, Alex“), nicht „Thanks, see below“
  if (k > 0 && k === segs.length - 1 && /^[A-ZÄÖÜ][\w'’.-]*(?:\s+[A-ZÄÖÜ][\w'’.-]*){0,2}$/.test(segs[k])) return { closing: true, name: true }
  return { closing: false, name: false }
}


function nameLike(t: string): boolean {
  return t.length <= 48 && !/\d|@|:/.test(t) && t.split(/\s+/).length <= 5 && !/[.!?]$/.test(t)
}


// Ende des Kopfes, wenn bei from einer beginnt, sonst from. Ein Kopf ist die Zeile „Am … schrieb …:“
// oder „Von:“ mit mindestens einem weiteren Feld, davor optional „-----Ursprüngliche Nachricht-----“.
// Ein Feld, das sich wiederholt, oder ein Empfängerfeld mit einem Satz als Wert ist schon Inhalt
// („An: Bitte bis Freitag weiterleiten.“). Gmail schreibt „To:“ erst nach dem Betreff.
function headerEnd(lines: SigLine[], from: number, to: number): number {
  let i = from
  if (i < to && ORIGINAL.test(lines[i].text.trim())) i++
  if (i < to && WROTE.test(lines[i].text.trim())) return i + 1
  const start = i
  if (!(i < to && fieldKey(lines[i].text) === 'from')) return start
  const seen = new Set<string>()
  while (i < to) {
    const key = fieldKey(lines[i].text)
    if (!key || seen.has(key)) break
    if ((key === 'to' || key === 'cc' || key === 'bcc' || key === 'replyto') && /[.!?]$/.test(lines[i].text.trim())) break
    seen.add(key)
    i++
  }
  return seen.size >= 2 ? i : start
}

// Teile des Verlaufs: Grenzen aus dem HTML oder aus Kopfzeilen im Text
export function partStarts(lines: SigLine[]): number[] {
  const starts = [0]
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].text.trim()
    const textHeader =
      ORIGINAL.test(t) ||
      WROTE.test(t) ||
      (HEADER_FROM.test(t) && lines.slice(i + 1, i + 5).some((x) => (fieldKey(x.text) ?? 'from') !== 'from'))
    if (lines[i].boundary || textHeader) {
      // Noch im Kopf des vorigen Teils („-----Ursprüngliche Nachricht-----“ vor „Von:“), oder die
      // Markierung des Zitats direkt nach seinem Kopf: kein neuer Teil. Ein neuer Kopf direkt nach
      // dem alten („On … wrote:“ unter einem Outlook-Kopf) beginnt dagegen einen.
      const last = starts[starts.length - 1]
      const end = bodyStart(lines, last, lines.length)
      const inHeader = end > last && (i < end || (i === end && !textHeader))
      if (last !== i && !inHeader) starts.push(i)
    }
  }
  return starts
}

// Erste Inhaltszeile eines Teils nach seinem Kopf. Der oberste Teil hat nur dann einen, wenn die
// Mail mit einer Weiterleitung beginnt.
export function bodyStart(lines: SigLine[], from: number, to: number): number {
  if (from === 0 && !(lines.length > 0 && (lines[0].boundary || ORIGINAL.test(lines[0].text.trim())))) return 0
  return headerEnd(lines, from, to)
}

// Beginn der Signatur in einem Teil [from, to), oder undefined
// Wörter eines Namens zum Vergleich („Fabrik, Kim (Fabrikam)“ → fabrik, kim, fabrikam)
const nameTokens = (t: string) => new Set((t.toLowerCase().match(/[a-zäöüßéèáó]{2,}/g) ?? []))

// Absender eines zitierten Teils aus seinem Kopf („Von: Kim Fabrik <kim@…>“, „Am … schrieb Kim Fabrik:“)
function quotedSender(lines: SigLine[], from: number, body: number): string | undefined {
  for (let i = from; i < Math.max(body, from + 1); i++) {
    const t = lines[i].text.trim()
    if (HEADER_FROM.test(t)) return t.replace(/^[^:]*:/, '').replace(/<[^>]*>|\[[^\]]*\]/g, ' ')
    if (WROTE.test(t)) return t.replace(/<[^>]*>/g, ' ')
  }
  return undefined
}

const imageOnly = (l: SigLine) => !!l.image && !l.text.trim()

// Beleg für eine Fußzeile: Hinweistext oder eine Firmen- oder Registerzeile. Telefon, Anschrift oder
// eine Vertretungsangabe allein können auch Angaben sein, die die Mail mitteilt.
const footerTop = (l: SigLine) => boilerplate(l) || (specific(l) && !roleLine(l) && (COMPANY.test(l.text) || LEGAL_HARD.test(l.text)))

// Zeile direkt nach der Grußformel, die sagt, wer unterschreibt: Name, Team oder Firma, aber keine
// Rolle und keine Kontaktangabe
function signer(l: SigLine): boolean {
  const t = l.text.trim()
  if (!nameLike(t) || l.image || prose(l) || roleLine(l) || link(l)) return false
  return !(PHONE.test(t) || ADDRESS.test(t) || LEGAL.test(t))
}

function inPart(lines: SigLine[], from: number, to: number, sender?: string): SigRange | undefined {
  // Kopfzeilen eines zitierten Teils gehören nicht zum Inhalt, den wir schützen
  const body = bodyStart(lines, from, to)
  if (to - body < 2) return undefined

  // 1. Vom Mail-Client markiert. Nicht die erste Inhaltszeile: dann wäre der ganze Teil Signatur.
  // Sie endet am Ende des markierten Elements: Ein P.S. darunter bleibt sichtbar.
  const marked = lines.slice(body + 1, to).findIndex((l) => l.marker !== undefined)
  if (marked >= 0) {
    const first = body + 1 + marked
    let end = first
    while (end < to && lines[end].marker === lines[first].marker) end++
    // Gmail setzt den Trenner „-- “ (oder „--“) direkt vor die markierte Signatur
    let start = first - 1 > body && /^--[\s ]?$/.test(lines[first - 1].text) ? first - 1 : first
    // Manche Clients packen auch Fließtext oder ein P.S. in das markierte Element: das bleibt sichtbar.
    // Am Ende des Elements endet die Signatur davor, mittendrin beginnt sie danach.
    while (end > start && prose(lines[end - 1])) end--
    for (let i = end - 1; i >= start; i--) if (prose(lines[i])) {
      start = i + 1
      break
    }
    // Fußzeile, die der Mailserver unter die Signatur setzt (Register, Anschrift, Vertraulichkeit):
    // Besteht der Rest des Teils nur aus solchen Zeilen, gehört er dazu
    const rest = lines.slice(end, to)
    const footerLine = (l: SigLine) => specific(l) || link(l) || boilerplate(l) || ruleLine(l) || bareLabel(l)
    // Hinter einer Trennlinie oder Beschriftung („---“, „Website:“) können auch mitgeteilte Kontaktdaten
    // stehen: Dann muss eine Firmen- oder Registerzeile oder Hinweistext die Fußzeile belegen.
    const loose = rest.some((l) => ruleLine(l) || bareLabel(l))
    const proof = (l: SigLine) => (loose ? footerTop(l) : boilerplate(l) || (specific(l) && !roleLine(l)))
    if (start < end && rest.length && rest.every(footerLine) && rest.some(proof)) end = to
    if (start < end) return { start, end, reason: 'marker' }
  }

  // 2. Signaturtrenner „-- “ nach RFC 3676, mit Leerzeichen: Ein „--“ als Linie im Text zählt nicht.
  // Die Signatur reicht bis zum Ende oder bis zur ersten Inhaltszeile (P.S., Satz, Anweisung).
  for (let i = body + 1; i < to; i++) {
    if (!isSep(lines[i])) continue
    let end = i + 1
    while (end < to && !prose(lines[end])) end++
    return { start: i, end, reason: 'dashes' }
  }

  // 3. „Gesendet von Outlook für iOS“ in den letzten beiden Zeilen, nur diese Zeile
  for (let i = Math.max(body + 1, to - 2); i < to; i++) if (sentFrom(lines[i].text)) return { start: i, end: i + 1, reason: 'mobile' }

  // 4. Grußformel, dann eine Namenszeile, dann ein Signaturblock. Über der Grußformel wird nie
  // etwas versteckt: Was dort steht, ist Inhalt.
  let floor = body
  for (let i = to - 1; i > body; i--) {
    const c = closingLine(lines[i].text)
    if (!c.closing) continue
    let start = i + 1
    // Wer unterschreibt, bleibt sichtbar: die Zeile nach dem Gruß mit Name, Team oder Firma, auch
    // wenn ein Bild (Logo, Foto) dazwischen steht. Was darunter folgt, gehört zur Signatur.
    if (!c.name) {
      let n = start
      while (n < to && imageOnly(lines[n])) n++
      if (n < to && signer(lines[n])) start = n + 1
    }
    if (validBlock(lines.slice(start, to))) return { start, end: to, reason: 'closing' }
    floor = start - 1
    break
  }

  // 5. Ohne Grußformel: am Ende ein Block, der mit dem Namen des Absenders beginnt und Telefon,
  // Anschrift oder Registerangabe enthält. Ein anderer Name ist ein Kontakt, den die Mail mitteilt.
  // Steht davor eine Zeile mit Doppelpunkt, ist es eine Aufzählung.
  const senderTokens = nameTokens(sender ?? '')
  let start = to
  while (start - 1 > floor && blockLine(lines[start - 1])) start--
  while (start < to && !properName(lines[start])) start++
  const block = lines.slice(start, to)
  const evidence = block.some((l) => !prose(l) && stray(l.text) <= 1 && (PHONE.test(l.text) || ADDRESS.test(l.text) || LEGAL.test(l.text)))
  // Vor- und Nachname müssen passen, in beliebiger Reihenfolge: „Alex Doe“ ist nicht „Alex Kim“
  const isSender = start < to && [...nameTokens(lines[start].text)].filter((w) => senderTokens.has(w)).length >= 2
  if (start > floor && start < to && isSender && validBlock(block) && evidence && !/:\s*$/.test(lines[start - 1].text)) return { start, end: to, reason: 'contact' }

  // 6. Fußzeile ohne Gruß und Namen (Benachrichtigungen, Newsletter, Fußzeile des Mailservers): am
  // Ende nur Hinweistext, Angaben und Links, darunter mindestens ein eindeutiger Fußzeilentext
  const footerLine = (l: SigLine) => boilerplate(l) || (specific(l) && !roleLine(l)) || link(l) || ruleLine(l) || bareLabel(l)
  let fs = to
  while (fs - 1 > floor && footerLine(lines[fs - 1])) fs--
  // Sie beginnt beim Hinweistext oder bei einer Firmen- oder Registerzeile. Eine Telefonnummer,
  // Anschrift oder Vertretungsangabe direkt davor kann die Mail mitteilen, sie bleibt sichtbar.
  while (fs < to && !footerTop(lines[fs])) fs++
  // Eine Zeile mit Doppelpunkt davor leitet eine Aufzählung ein („unsere neuen Daten:“), außer sie ist
  // selbst eine Beschriftung der Fußzeile („Registry Court:“)
  const intro = /:\s*$/.test(lines[fs - 1]?.text ?? '') && !bareLabel(lines[fs - 1]) && !LEGAL.test(lines[fs - 1].text)
  if (fs > floor && fs < to && lines.slice(fs, to).some(strongBoilerplate) && !intro) return { start: fs, end: to, reason: 'footer' }
  return undefined
}

// Der Name bleibt sichtbar: Eine Signatur beginnt erst unter dem Trenner „--“, der Grußformel und der
// Namenszeile. Bleibt danach nichts übrig, gibt es nichts auszublenden.
function nameLine(l: SigLine): boolean {
  const t = l.text.trim()
  if (l.image || !t) return false
  if (properName({ text: t.split(/\s*[|·]\s*/)[0] })) return true
  // einzelner Vorname
  return /^\p{Lu}[\p{L}'’-]+$/u.test(t) && !COMPANY.test(t) && !JOB.test(t)
}

function belowName<T extends { start: number; end: number }>(lines: SigLine[], r: T, sender?: string): T | undefined {
  const senderTokens = nameTokens(sender ?? '')
  // Zeile mit dem Namen des Absenders, auch wenn sie nicht wie ein Name aussieht („SMITH, J.“)
  const senderLine = (l: SigLine) => l.text.length <= 60 && !specific(l) && !link(l) && [...nameTokens(l.text)].some((w) => senderTokens.has(w))
  let s = r.start
  if (s < r.end && /^--[\s\u00a0]?$/.test(lines[s].text)) s++
  const c = s < r.end ? closingLine(lines[s].text) : undefined
  if (c?.closing) s++
  // Ein Bild zwischen Gruß und Name bleibt mit dem Namen sichtbar
  let n = s
  while (n < r.end && imageOnly(lines[n])) n++
  if (!c?.name && n < r.end && (nameLine(lines[n]) || senderLine(lines[n]))) s = n + 1
  return s < r.end ? { ...r, start: s } : undefined
}

// sender: Anzeigename des Absenders der Mail, gilt für den obersten Teil. Zitierte Teile nennen ihren
// Absender im Kopf.
export function findSignatures(lines: SigLine[], sender?: string): SigRange[] {
  const starts = partStarts(lines)
  const out: SigRange[] = []
  starts.forEach((from, k) => {
    const to = starts[k + 1] ?? lines.length
    // Absender des Teils: bei der obersten Nachricht der Absender der Mail, sonst aus dem Kopf des Zitats
    const body = bodyStart(lines, from, to)
    const who = k === 0 && body === 0 ? sender : quotedSender(lines, from, body)
    const hit = inPart(lines, from, to, who)
    // Nach einer Grußformel, bei „Gesendet von …“ und in reinen Fußzeilen gibt es keinen Namen zu zeigen
    const visible = hit && (hit.reason === 'closing' || hit.reason === 'mobile' || hit.reason === 'footer' ? hit : belowName(lines, hit, who))
    if (visible) out.push(visible)
  })
  return out
}

// ---------- Kopfzeilen zitierter Nachrichten ----------

export interface HeaderRange {
  start: number
  end: number
  // Kurzform für die eingeklappte Zeile: „Kim Fabrik · Dienstag, 24. November 2026 11:03“
  label: string
}

// Der Block „Von: … Gesendet: … An: … Betreff: …“ über jeder zitierten Nachricht. Eine einzelne Zeile
// „Am … schrieb …:“ bleibt stehen, sie ist schon die Kurzform.
export function findHeaders(lines: SigLine[]): HeaderRange[] {
  const starts = partStarts(lines)
  const out: HeaderRange[] = []
  starts.forEach((from, k) => {
    const to = starts[k + 1] ?? lines.length
    const end = bodyStart(lines, from, to)
    const block = lines.slice(from, end).map((l) => l.text.trim())
    if (block.filter((t) => fieldKey(t)).length < 2) return
    const sender = block.find((t) => fieldKey(t) === 'from')?.replace(/^[^:]*:/, '') ?? ''
    const date = block.find((t) => HEADER_DATE.test(t))
    // Anzeigename, sonst die Adresse („From: <kim@example.com>“)
    const name = sender.replace(/<[^>]*>|\[[^\]]*\]/g, ' ').replace(/["']/g, '').replace(/\s+/g, ' ').replace(/\s*(?:im auftrag von|on behalf of)\b.*$/i, '').replace(/[\s;,]+$/, '').trim() || (sender.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0] ?? '')
    const label = [name, date?.replace(HEADER_DATE, '').trim()].filter(Boolean).join(' · ')
    out.push({ start: from, end, label: label || 'Kopfzeilen' })
  })
  return out
}

// ---------- Verlauf als Chat ----------
// Verlauf einer Mail als Folge von Nachrichten, für die Chat-Ansicht. Jede Nachricht kennt ihren Absender und ihr Datum aus dem zitierten Kopf, die
// oberste aus den Angaben der Mail selbst.

export interface Person {
  name?: string
  address?: string
}

export interface ThreadPart {
  // erste Zeile samt Kopf, erste Inhaltszeile und Ende (exklusiv)
  start: number
  body: number
  end: number
  sender?: Person
  // Datum, wie es im Kopf steht
  date?: string
  signature?: { start: number; end: number }
}


// „Kim Fabrik <kim@fabrikam.de>“, „Fabrik, Kim [mailto:kim@fabrikam.de]“, „kim@fabrikam.de“
export function parsePerson(raw: string): Person | undefined {
  const address = raw.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0]
  const name = raw
    .replace(/<[^>]*>|\[[^\]]*\]/g, ' ')
    .replace(/\s*(?:im auftrag von|on behalf of)\b.*$/i, '')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, ' ')
    .replace(/["'“”„]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s;,]+$/, '')
    .trim()
  if (!name && !address) return undefined
  return { name: name || undefined, address }
}

// „Am 24.11.2026 um 11:03 schrieb Kim Fabrik <kim@…>:“ und „On Tue, Nov 24, 2026 at 11:03 AM Kim
// Fabrik <kim@…> wrote:“. Im Englischen steht der Name hinter Uhrzeit oder Jahr.
export function parseWrote(text: string): { sender?: Person; date?: string } {
  const t = text.trim()
  const de = t.match(/^am\s+(.+?)\s+schrieb\s+(.+):$/i)
  if (de) return { date: de[1], sender: parsePerson(de[2]) }
  const en = t.match(/^on\s+(.+?)\s+wrote\b.*:$/i)
  if (!en) return {}
  const split = en[1].match(/^(.*(?:\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?|\b(?:19|20)\d{2}))[,\s]+(\S.*)$/i)
  if (split) return { date: split[1].replace(/[,\s]+$/, ''), sender: parsePerson(split[2]) }
  return { sender: parsePerson(en[1]) }
}

// Wochentag am Anfang weglassen: „Dienstag, 24. November 2026 11:03“ → „24. November 2026 11:03“
export function shortDate(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:mo|di|mi|do|fr|sa|so|mon|tue|wed|thu|fri|sat|sun)[a-zäöü]*\.?,?\s+(?=\S)/i, '')
    .replace(/\s+/g, ' ')
}

const MONTHS: [RegExp, number][] = [
  [/^jan/, 0],
  [/^feb/, 1],
  [/^(?:mär|maer|mar)/, 2],
  [/^apr/, 3],
  [/^(?:mai|may)/, 4],
  [/^jun/, 5],
  [/^jul/, 6],
  [/^aug/, 7],
  [/^sep/, 8],
  [/^(?:okt|oct)/, 9],
  [/^nov/, 10],
  [/^(?:dez|dec)/, 11]
]

// Datum aus einem zitierten Kopf als Zeitpunkt in Ortszeit, damit die Chat-Ansicht alle Nachrichten
// gleich beschriftet. „Dienstag, 24. November 2026 11:03“, „24.11.2026 11:03“, „Mi., 25. Nov. 2026
// um 14:02 Uhr“, „Wednesday, November 25, 2026 9:30 AM“, „Mon Nov 23 2026 09:00“. Sonst undefined.
export function parseMailDate(raw: string): number | undefined {
  const t = raw.toLowerCase()
  const time = t.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*(a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z]))?/)
  let year: number
  let month: number | undefined
  let day: number
  const num = t.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b/)
  // Mit Schrägstrich schreibt Outlook in den USA Monat/Tag, in Großbritannien Tag/Monat. Nur wenn
  // eine Zahl über 12 liegt, ist klar, welche der Tag ist. Sonst bleibt der Text des Kopfes stehen.
  const slash = num ? null : t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/)
  if (num) {
    day = +num[1]
    month = +num[2] - 1
    year = +num[3] < 100 ? 2000 + +num[3] : +num[3]
  } else if (slash) {
    const [a, b] = [+slash[1], +slash[2]]
    if (a <= 12 && b <= 12 && a !== b) return undefined
    ;[day, month] = a > 12 ? [a, b - 1] : [b, a - 1]
    year = +slash[3] < 100 ? 2000 + +slash[3] : +slash[3]
  } else {
    const y = t.match(/\b((?:19|20)\d{2})\b/)
    if (!y) return undefined
    year = +y[1]
    for (const w of t.match(/\p{L}+/gu) ?? []) {
      month = MONTHS.find(([re]) => re.test(w))?.[1]
      if (month !== undefined) break
    }
    const d = t.replace(y[0], ' ').replace(time?.[0] ?? '\u0000', ' ').match(/\b(\d{1,2})\b/)
    if (month === undefined || !d) return undefined
    day = +d[1]
  }
  let hour = 0
  let minute = 0
  if (time) {
    hour = +time[1]
    minute = +time[2]
    const pm = time[3]?.startsWith('p')
    if (time[3]) hour = (hour % 12) + (pm ? 12 : 0)
  }
  if (month < 0 || month > 11 || day < 1 || day > 31 || hour > 23 || minute > 59) return undefined
  const date = new Date(year, month, day, hour, minute)
  // 31. Februar und Co.: Date rechnet um, das ist kein gültiges Datum
  if (date.getDate() !== day) return undefined
  return date.getTime()
}

const tokens = (t?: string) => new Set((t ?? '').toLowerCase().match(/\p{L}{2,}/gu) ?? [])

// Stammt die Nachricht von einem der eigenen Konten? Steht eine Adresse da, entscheidet nur sie: Ein
// Namensvetter mit anderer Adresse ist jemand anderes. Outlook nennt im Kopf oft nur den Namen
// („Von: Beispiel, Alex“), dann zählen Vor- und Nachname in beliebiger Reihenfolge.
export function isMe(sender: Person | undefined, me: Person[]): boolean {
  if (!sender) return false
  const address = sender.address?.toLowerCase()
  if (address) return me.some((p) => p.address?.toLowerCase() === address)
  const a = tokens(sender.name)
  if (a.size < 2) return false
  return me.some((p) => {
    const b = tokens(p.name)
    if (b.size < 2) return false
    const [small, big] = a.size <= b.size ? [a, b] : [b, a]
    return [...small].every((w) => big.has(w))
  })
}

// signatures: Bereiche aus findSignatures() und vom Sprachmodell. top: Absender der Mail, gilt für
// die oberste Nachricht, wenn sie keinen eigenen Kopf hat (eine Weiterleitung hat einen).
export function threadParts(lines: SigLine[], signatures: { start: number; end: number }[], top?: Person): ThreadPart[] {
  const starts = partStarts(lines)
  return starts.map((start, k) => {
    const end = starts[k + 1] ?? lines.length
    const body = bodyStart(lines, start, end)
    const part: ThreadPart = { start, body, end }
    if (body === start) {
      if (k === 0) part.sender = top
    } else {
      for (let i = start; i < body; i++) {
        const t = lines[i].text.trim()
        if (WROTE.test(t)) Object.assign(part, parseWrote(t))
        else if (HEADER_FROM.test(t) && fieldKey(t) === 'from') part.sender = parsePerson(t.replace(/^[^:]*:/, ''))
        else if (fieldKey(t) === 'date') part.date = t.replace(HEADER_DATE, '').trim()
      }
    }
    const sig = signatures.find((r) => r.start >= body && r.start < end)
    if (sig) part.signature = { start: sig.start, end: Math.min(sig.end, end) }
    return part
  })
}

// ---------- Eigene Signatur aus gesendeten Mails ----------

export interface SentMailLines {
  lines: SigLine[]
  sender?: string
}

const lineKey = (l: SigLine) => l.text || (l.image ? '[Bild]' : '')

// Eigene Signatur: das Ende der eigenen Nachricht, das in mindestens zwei der letzten gesendeten Mails
// gleich ist, ohne Grußformel (die schreibt man selbst). Neueste Mail zuerst. Findet sich keins, die
// Signatur, die die Regeln in einer der Mails finden, mit Namenszeile. Ergebnis: Mail und Zeilen [start, end).
export function learnSignature(mails: SentMailLines[]): { mail: number; start: number; end: number } | undefined {
  // Nur die eigene Nachricht, ohne zitierten Verlauf
  const own = mails.map((m) => m.lines.slice(0, partStarts(m.lines)[1] ?? m.lines.length))
  for (let i = 0; i < own.length; i++) {
    const a = own[i]
    let same = 0
    for (let j = 0; j < own.length; j++) {
      if (j === i) continue
      const b = own[j]
      let k = 0
      while (k < a.length && k < b.length && lineKey(a[a.length - 1 - k]) === lineKey(b[b.length - 1 - k])) k++
      same = Math.max(same, k)
    }
    // Die erste Zeile ist Inhalt, auch wenn zwei Mails gleich lauten
    let start = Math.max(1, a.length - same)
    while (start < a.length && closingLine(a[start].text).closing) start++
    const block = a.slice(start)
    if (block.length >= 2 && block.some((l) => specific(l) || link(l)) && !block.some(prose)) return { mail: i, start, end: a.length }
  }
  for (let i = 0; i < own.length; i++) {
    const r = findSignatures(mails[i].lines, mails[i].sender).find((x) => x.start < own[i].length)
    if (!r) continue
    let start = r.start
    // Die Namenszeile steht über dem Bereich, den der Lesebereich einklappt
    if (start > 1 && nameLine(own[i][start - 1])) start--
    return { mail: i, start, end: Math.min(r.end, own[i].length) }
  }
  return undefined
}

// ---------- Sprachmodell (Apple Intelligence) für Teile ohne Regel-Treffer ----------

export interface OpenPart {
  // erste Inhaltszeile (nach dem zitierten Kopf) und Ende des Teils im Dokument
  body: number
  end: number
  lines: SigLine[]
}

const MODEL_LINES = 40
const MODEL_CHARS = 2500

// Was ans Modell geht: höchstens vier Teile mit mindestens vier Zeilen, je das Ende des Teils
// (dort steht die Signatur), höchstens 40 Zeilen und 2500 Zeichen. Zeilen zählen ab dem Inhalt.
export function modelRequest(parts: OpenPart[]): { parts: MailSignaturePart[]; of: number[] } {
  const out: MailSignaturePart[] = []
  const of: number[] = []
  parts.forEach((p, k) => {
    if (p.lines.length < 4 || out.length >= 4) return
    let from = p.lines.length
    let chars = 0
    while (from > 1 && p.lines.length - from < MODEL_LINES) {
      const t = p.lines[from - 1].text.slice(0, 200) || (p.lines[from - 1].image ? '[Bild]' : '')
      if (chars + t.length > MODEL_CHARS) break
      chars += t.length
      from--
    }
    out.push({ first: from + 1, lines: p.lines.slice(from).map((l) => l.text.slice(0, 200) || (l.image ? '[Bild]' : '')) })
    of.push(k)
  })
  return { parts: out, of }
}

// Darf das ausgeblendet werden? Das Modell kann sich irren. Der Block muss wie bei den Regeln aus
// Signaturzeilen bestehen. Weil das Modell die Zeile selbst als Signatur eingestuft hat, darf er eine
// einzige kurze Zeile ohne Beleg enthalten (ein Slogan), wenn mindestens zwei Zeilen einen Beleg haben.
export function plausibleSignature(lines: SigLine[]): boolean {
  if (!lines.length || lines.length > MODEL_LINES) return false
  const free = lines.filter((l) => !blockLine(l))
  if (free.length > 1 || free.some((l) => prose(l) || l.text.length > 60)) return false
  if (!lines.some(specific)) return false
  return free.length === 0 || lines.filter((l) => specific(l) || properName(l)).length >= 2
}

// Antwort des Modells (erste Signaturzeile je Teil, ab 1 gezählt) in Bereiche umrechnen. Die erste
// Inhaltszeile bleibt immer stehen, ebenso die erste Zeile, die das Modell gesehen hat: Im Test an
// echten Mails war diese Antwort in 7 von 7 Fällen falsch und versteckte Inhalt. Längere Blöcke als
// 25 Zeilen sind Feldlisten oder Benachrichtigungen, keine Signaturen.
export function modelRanges(starts: (number | null)[], req: { of: number[]; parts?: MailSignaturePart[] }, parts: OpenPart[]): SigRange[] {
  const out: SigRange[] = []
  starts.forEach((n, i) => {
    const p = parts[req.of[i]]
    if (!p || !n || n < 2 || n > p.lines.length) return
    if (req.parts && n <= req.parts[i].first) return
    const hidden = p.lines.slice(n - 1)
    if (hidden.filter((l) => !boilerplate(l)).length > 25 || !plausibleSignature(hidden)) return
    // Die Signatur beginnt mit einem Personennamen oder einer Angabe, die nur in Signaturen steht
    const top = hidden[0]
    const name = top.text.split(/\s*[|·]\s*/)[0]
    if (!(specific(top) || properName(top) || properName({ text: name }))) return
    // Der Name bleibt sichtbar
    const below = belowName(p.lines, { start: n - 1, end: p.lines.length })
    if (below) out.push({ start: p.body + below.start, end: p.end, reason: 'model' })
  })
  return out
}
