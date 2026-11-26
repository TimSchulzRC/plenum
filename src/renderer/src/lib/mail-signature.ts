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
  reason: 'marker' | 'dashes' | 'mobile' | 'closing' | 'contact' | 'model'
}

// Grußformeln, nach denen Name und Signatur folgen
const CLOSING =
  /^(?:(?:mit\s+)?(?:(?:den\s+)?(?:besten|beste|vielen|viele|liebe|lieben|herzliche|herzlichen|schöne|schönen|sonnige|sonnigen|freundliche|freundlichen|kollegiale|kollegialen|beste|besten|lieben|herzlichen)\s+)?gr(?:ü|ue|u)(?:ß|ss)(?:e|en)?(?:\s+(?:aus|nach|in|vom|von)\b.*)?|mfg|lg|vg|bg|gruß|gruss|danke(?:\s+und\s+(?:viele\s+)?gr(?:ü|ue)(?:ß|ss)e)?|vielen\s+dank(?:\s+und\s+(?:viele\s+)?gr(?:ü|ue)(?:ß|ss)e)?|(?:best|kind|warm|warmest)\s+(?:regards|wishes)|regards|best|cheers|thanks|thank\s+you|many\s+thanks|sincerely|yours\s+(?:sincerely|truly)|all\s+the\s+best|cordialement|saludos)[\s,.!]*$/i

// Kopf eines zitierten Teils, als Text erkannt (falls das HTML keine Markierung hat)
const HEADER_FROM = /^(?:von|from|de|da)\s*:\s*\S/i
const HEADER_REST = /^(?:gesendet|sent|datum|date|an|to|betreff|subject|cc)\s*:/i
const ORIGINAL = /^-{2,}\s*(?:ursprüngliche nachricht|original message|weitergeleitete nachricht|forwarded message)\s*-{2,}$/i
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
const ADDRESS = { test: (t: string) => ADDRESS_PLZ.test(t) || ADDRESS_STREET.test(t) }
// Rechtsform nach einem Namen, in üblicher Schreibweise: „Contoso GmbH“, nicht „AG“ für Arbeitsgruppe
const COMPANY = /[A-ZÄÖÜ0-9][\w&.-]*\s+(?:GmbH|gGmbH|mbH|AG|KG|OHG|KGaA|SE|UG|e\.\s?K\.|e\.\s?V\.|Ltd\.?|Limited|Inc\.?|LLC|Corp\.?|PLC|S\.A\.|B\.V\.)(?=$|[\s,.;:|·&)–-])/
const LEGAL =
  /\b(?:geschäftsführ|vorstand|aufsichtsrat|amtsgericht|registergericht|handelsregister|hrb|hra|ust-?id|umsatzsteuer|steuer-?nr|sitz der gesellschaft|vat|registered office|company registration|datenschutz|data protection|privacy|impressum)/i
// Hinweise und Standardsätze aus Fußzeilen: Vertraulichkeit, Umwelt, Netzwerk von
// Prüfungsgesellschaften, Streitbeilegung, Newsletter und Benachrichtigungen
const DISCLAIMER =
  /\b(?:vertraulich|confidential|disclaimer|irrtümlich|in error|intended recipient|bestimmungsgemäß|unbefugte|unauthori[sz]ed|ausdrucken|before printing|the environment|der umwelt|member firms?|mitgliedsunternehmen|streitbeilegung|schlichtungsstelle|dispute resolution|unsubscribe (?:here|from)|click here to unsubscribe|newsletter abbestellen|vom newsletter abmelden|you(?: are)? receiv(?:e|ed|ing) this|sie erhalten diese (?:e-?mail|nachricht|benachrichtigung))/i
const COPYRIGHT = /©|\bcopyright\b|all rights reserved|alle rechte vorbehalten/i
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
  /\b(?:amtsgericht|registergericht|handelsregister|hrb|hra|ust-?id|umsatzsteuer-?id|steuer-?nr|sitz der gesellschaft|registered office|company registration|(?:irrtümlich|versehentlich|fälschlich\w*) erhalten|receiv\w+ (?:this|it)\b.{0,40}\bin error|intended recipient|bestimmungsgemäße[nr]? (?:empfänger|adressat)|unbefugte[sn]? (?:weitergabe|nutzung|verwendung|kopieren|kenntnisnahme)|unauthori[sz]ed (?:use|disclosure|copying|review|distribution|dissemination)|(?:vor dem|bevor sie) (?:aus)?drucken|before (?:you )?print(?:ing)?|member firms?|mitgliedsunternehmen|streitbeilegung|schlichtungsstelle|dispute resolution|unsubscribe (?:here|from)|click here to unsubscribe|newsletter abbestellen|vom newsletter abmelden|you(?: are)? receiv(?:e|ed|ing) this (?:e-?mail|message|notification|newsletter)|sie erhalten diese (?:e-?mail|nachricht|benachrichtigung))/i
const FOOTER_WORDS = /\b(?:geschäftsführ\w*|vorstand|aufsichtsrat|datenschutz\w*|data protection|privacy|impressum|vertraulich\w*|confidential|disclaimer|umwelt|environment|vat)\b/gi
function boilerplate(l: SigLine): boolean {
  const t = l.text.trim()
  if (PS.test(t) || IMPERATIVE.test(t) || /\?$/.test(t)) return false
  if (COPYRIGHT.test(t)) return true
  if (t.length <= 60) return false
  if (FOOTER_PHRASE.test(t)) return true
  return new Set((t.match(FOOTER_WORDS) ?? []).map((w) => w.toLowerCase())).size >= 2
}

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
    if (/^[a-zäöüß]/.test(word) && !LABELS.has(word.toLowerCase())) n++
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
const PROPER_NAME = /^(?:(?:i\.\s?[AV]\.|ppa\.|pp\.)\s+)?(?:(?:Dr\.|Prof\.|Dipl\.-\w+\.?|Mag\.|Ing\.)\s+)*[A-ZÄÖÜ][a-zäöüßéèáó'’-]+(?:\s+(?:[A-ZÄÖÜ][a-zäöüßéèáó'’.-]*|von|van|de|der|zu)){1,3}$/
const properName = (l: SigLine) => PROPER_NAME.test(l.text.trim()) && !COMPANY.test(l.text) && !JOB.test(l.text)

// Zeile, die in einem Signaturblock stehen darf
const blockLine = (l: SigLine) => specific(l) || link(l) || boilerplate(l) || filler(l) || (!!l.image && l.text.length < 120 && stray(l.text) <= 1) || sentFrom(l.text)

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


// Teile des Verlaufs: Grenzen aus dem HTML oder aus Kopfzeilen im Text
export function partStarts(lines: SigLine[]): number[] {
  const starts = [0]
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].text.trim()
    const textHeader =
      ORIGINAL.test(t) ||
      WROTE.test(t) ||
      (HEADER_FROM.test(t) && lines.slice(i + 1, i + 5).some((x) => HEADER_REST.test(x.text.trim())))
    if (lines[i].boundary || textHeader) {
      if (starts[starts.length - 1] !== i) starts.push(i)
    }
  }
  return starts
}

// Erste Inhaltszeile eines Teils: Kopfzeilen eines zitierten Teils („Von:“, „Betreff:“ …) überspringen
export function bodyStart(lines: SigLine[], from: number, to: number): number {
  let body = from
  if (from > 0) while (body < to && (HEADER_FROM.test(lines[body].text.trim()) || HEADER_REST.test(lines[body].text.trim()) || ORIGINAL.test(lines[body].text.trim()) || WROTE.test(lines[body].text.trim()))) body++
  return body
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
    const footerLine = (l: SigLine) => specific(l) || link(l) || boilerplate(l)
    if (start < end && rest.length && rest.every(footerLine) && rest.some((l) => boilerplate(l) || (specific(l) && !roleLine(l)))) end = to
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
    // Eine Namenszeile bleibt sichtbar, Firma oder Abteilung darunter gehören zur Signatur
    if (!c.name && start < to && nameLike(lines[start].text.trim()) && !JOB.test(lines[start].text) && !specific(lines[start]) && !link(lines[start]) && !lines[start].image) start++
    if (validBlock(lines.slice(start, to))) return { start, end: to, reason: 'closing' }
    floor = start - 1
    break
  }

  // 5. Ohne Grußformel: am Ende ein Block, der mit dem Namen des Absenders beginnt und Telefon,
  // Anschrift oder Registerangabe enthält. Ein anderer Name ist ein Kontakt, den die Mail mitteilt.
  // Steht davor eine Zeile mit Doppelpunkt, ist es eine Aufzählung.
  const from_ = sender ?? quotedSender(lines, from, body)
  if (!from_) return undefined
  const senderTokens = nameTokens(from_)
  let start = to
  while (start - 1 > floor && blockLine(lines[start - 1])) start--
  while (start < to && !properName(lines[start])) start++
  const block = lines.slice(start, to)
  const evidence = block.some((l) => !prose(l) && stray(l.text) <= 1 && (PHONE.test(l.text) || ADDRESS.test(l.text) || LEGAL.test(l.text)))
  // Vor- und Nachname müssen passen, in beliebiger Reihenfolge: „Alex Doe“ ist nicht „Alex Kim“
  const isSender = start < to && [...nameTokens(lines[start].text)].filter((w) => senderTokens.has(w)).length >= 2
  if (start > floor && start < to && isSender && validBlock(block) && evidence && !/:\s*$/.test(lines[start - 1].text)) return { start, end: to, reason: 'contact' }
  return undefined
}

// sender: Anzeigename des Absenders der Mail, gilt für den obersten Teil. Zitierte Teile nennen ihren
// Absender im Kopf.
export function findSignatures(lines: SigLine[], sender?: string): SigRange[] {
  const starts = partStarts(lines)
  const out: SigRange[] = []
  starts.forEach((from, k) => {
    const to = starts[k + 1] ?? lines.length
    const hit = inPart(lines, from, to, k === 0 ? sender : undefined)
    if (hit) out.push(hit)
  })
  return out
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
// 15 Zeilen sind Feldlisten oder Benachrichtigungen, keine Signaturen.
export function modelRanges(starts: (number | null)[], req: { of: number[]; parts?: MailSignaturePart[] }, parts: OpenPart[]): SigRange[] {
  const out: SigRange[] = []
  starts.forEach((n, i) => {
    const p = parts[req.of[i]]
    if (!p || !n || n < 2 || n > p.lines.length) return
    if (req.parts && n <= req.parts[i].first) return
    const hidden = p.lines.slice(n - 1)
    if (hidden.filter((l) => !boilerplate(l)).length > 15 || !plausibleSignature(hidden)) return
    // Die Signatur beginnt mit einem Personennamen oder einer Angabe, die nur in Signaturen steht
    const top = hidden[0]
    const name = top.text.split(/\s*[|·]\s*/)[0]
    if (!(specific(top) || properName(top) || properName({ text: name }))) return
    out.push({ start: p.body + n - 1, end: p.end, reason: 'model' })
  })
  return out
}
