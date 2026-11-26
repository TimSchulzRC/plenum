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

const PHONE = /(?:^|\s|:)(?:\+|00)\d[\d\s/().-]{6,}\d|(?:tel|telefon|phone|fon|mobil|mobile|handy|fax|direkt|zentrale|t|m|f)\.?\s*:?\s*[+(]?\d[\d\s/().-]{5,}\d/i
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:de|com|net|org|eu|io|at|ch|info|biz)\b/i
// Postleitzahl und Ort (groß geschrieben: „2026 bis“ ist ein Datum, keine Anschrift) oder Straße mit Nummer
// Ganze Ortsangabe bis zum Zeilenende oder Trenner („12345 Musterstadt“, „60311 Frankfurt am Main“),
// nicht „2026 Berlin shipment“
const ADDRESS_PLZ = /(?:^|[\s,|·])\d{4,5}\s+[A-ZÄÖÜ][\wäöüß.-]+(?:\s+(?:[A-ZÄÖÜ(][\wäöüß.()-]*|am|an|im|in|a\.|bei|ob|vor|der))*\s*(?:$|[|·,;–])/
const ADDRESS_STREET = /(?:straße|strasse|str\.|weg|platz|allee|gasse|ring|damm|ufer)\s*\d+[a-z]?\b/i
const ADDRESS = { test: (t: string) => ADDRESS_PLZ.test(t) || ADDRESS_STREET.test(t) }
// Rechtsform nach einem Namen, in üblicher Schreibweise: „Contoso GmbH“, nicht „AG“ für Arbeitsgruppe
const COMPANY = /[A-ZÄÖÜ0-9][\w&.-]*\s+(?:GmbH|gGmbH|mbH|AG|KG|OHG|KGaA|SE|UG|e\.\s?K\.|e\.\s?V\.|Ltd\.?|Limited|Inc\.?|LLC|Corp\.?|PLC|S\.A\.|B\.V\.)(?=$|[\s,.;:|·&)–-])/
const LEGAL =
  /\b(?:geschäftsführ|vorstand|aufsichtsrat|amtsgericht|registergericht|handelsregister|hrb|hra|ust-?id|umsatzsteuer|steuer-?nr|sitz der gesellschaft|vat|registered office|company registration|datenschutz|data protection|privacy|impressum)/i
// Hinweise und Standardsätze aus Fußzeilen: Vertraulichkeit, Umwelt, Copyright, Netzwerk von
// Prüfungsgesellschaften, Streitbeilegung, Newsletter und Benachrichtigungen
const DISCLAIMER =
  /©|\b(?:vertraulich|confidential|disclaimer|irrtümlich|in error|intended recipient|bestimmungsgemäß|unbefugte|unauthori[sz]ed|ausdrucken|before printing|the environment|der umwelt|copyright|all rights reserved|alle rechte vorbehalten|member firms?|mitgliedsunternehmen|streitbeilegung|schlichtungsstelle|dispute resolution|unsubscribe|newsletter abbestellen|vom newsletter abmelden|you(?: are)? receiv(?:e|ed|ing) this|sie erhalten diese (?:e-?mail|nachricht|benachrichtigung))/i
const JOB = /\b(?:geschäftsführer|consultant|berater|manager|leiter|leitung|head of|director|engineer|entwickler|developer|assistant|assistenz|vertrieb|sales|support|projekt|project|team|abteilung|department|ceo|cto|cfo|coo|partner|inhaber|owner|referent|sachbearbeit|specialist|spezialist|architekt)/i

// Harte Kontaktangabe: Telefon, Mail, Web, Anschrift, Register- oder Rechtshinweis
function strongContact(l: SigLine): boolean {
  const t = l.text
  return PHONE.test(t) || EMAIL.test(t) || URL_RE.test(t) || ADDRESS.test(t) || LEGAL.test(t) || DISCLAIMER.test(t)
}

function contactLike(l: SigLine): boolean {
  return strongContact(l) || (COMPANY.test(l.text) && l.text.length < 120)
}

const isSep = (l: SigLine) => !!l.sep || /^--[ \u00a0]$/.test(l.text)

// Inhalt, der nie in einer Signatur steht: ein P.S. oder ein ganzer Satz (ab sechs Wörtern mit
// Satzzeichen am Ende), auch wenn er eine Mailadresse oder Telefonnummer enthält. Rechtshinweise und
// Disclaimer sind zwar Sätze, gehören aber zur Signatur.
const PS = /^p\.?\s?(?:p\.?\s?)?s\.?(?:[\s:]|$)/i
function prose(l: SigLine): boolean {
  const t = l.text.trim()
  if (PS.test(t)) return true
  if (LEGAL.test(t) || DISCLAIMER.test(t)) return false
  return t.split(/\s+/).length >= 6 && /[.!?:]$/.test(t)
}

// Langer Rechts- oder Vertraulichkeitshinweis
// Ein P.S. ist nie Rechtstext, auch wenn „Datenschutz“ darin steht
const legalText = (l: SigLine) => !PS.test(l.text.trim()) && l.text.length > 60 && (DISCLAIMER.test(l.text) || LEGAL.test(l.text))

// Position als eigene Zeile („Senior Consultant“, „Head of Operations | Northwind“), kein Satz
const jobLine = (l: SigLine) => JOB.test(l.text) && l.text.length <= 100 && !/[.!?]\s*$/.test(l.text)
// Echte Rolle, die allein eine Signatur belegt („Senior Consultant“, „Leitung Integration“), nicht
// allgemeine Wörter wie „Projekt“ oder „Team“
const ROLE = /\b(?:geschäftsführer(?:in)?|consultant|berater(?:in)?|manager(?:in)?|leiter(?:in)?|leitung|head of|director|direktor(?:in)?|engineer|ingenieur(?:in)?|entwickler(?:in)?|developer|assistant|assistenz|ceo|cto|cfo|coo|inhaber(?:in)?|owner|referent(?:in)?|sachbearbeiter(?:in)?|specialist|spezialist(?:in)?|architekt(?:in)?|vorstand|prokurist(?:in)?|teamlead|team lead|teamleiter(?:in)?)\b/i
const roleLine = (l: SigLine) => jobLine(l) && ROLE.test(l.text)

// Zeile, die in einer Signatur stehen darf: Kontakt, Bild, oder kurz (Name, Titel, Firma)
function signatureLike(l: SigLine): boolean {
  if (prose(l)) return false
  if (l.image && l.text.length < 120) return true
  if (contactLike(l)) return true
  const t = l.text.trim()
  // Kurz: Name, Titel, Firma, auch ein Slogan mit Punkt („Fabrikam – wir verbinden Systeme.“), keine Frage
  if (t.length <= 60 && !/\?\s*$/.test(t) && (t.split(/\s+/).length <= 5 || !/[.!]\s*$/.test(t))) return true
  return jobLine(l)
}

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
function inPart(lines: SigLine[], from: number, to: number): SigRange | undefined {
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
    let start = first - 1 > body && /^--[\s\u00a0]?$/.test(lines[first - 1].text) ? first - 1 : first
    // Manche Clients packen auch Fließtext oder ein P.S. in das markierte Element: das bleibt sichtbar.
    // Am Ende des Elements endet die Signatur davor, mittendrin beginnt sie danach.
    while (end > start && prose(lines[end - 1])) end--
    for (let i = end - 1; i >= start; i--) if (prose(lines[i])) {
      start = i + 1
      break
    }
    // Fußzeile, die der Mailserver unter die Signatur setzt (Register, Anschrift, Vertraulichkeit):
    // Besteht der Rest des Teils nur daraus, gehört er dazu
    const rest = lines.slice(end, to)
    const footerLine = (l: SigLine) => !prose(l) && (contactLike(l) || legalText(l) || LEGAL.test(l.text) || (!!l.image && !l.text))
    if (start < end && rest.length && rest.every(footerLine) && rest.some((l) => LEGAL.test(l.text) || DISCLAIMER.test(l.text) || ADDRESS.test(l.text) || PHONE.test(l.text))) end = to
    if (start < end) return { start, end, reason: 'marker' }
  }

  // 2. Signaturtrenner „-- “ nach RFC 3676, mit Leerzeichen: Ein „--“ als Linie im Text zählt nicht
  for (let i = body + 1; i < to; i++) if (isSep(lines[i])) return { start: i, end: to, reason: 'dashes' }

  // 3. „Gesendet von Outlook für iOS“ in den letzten beiden Zeilen, nur diese Zeile
  for (let i = Math.max(body + 1, to - 2); i < to; i++) if (sentFrom(lines[i].text)) return { start: i, end: i + 1, reason: 'mobile' }

  // 4. Grußformel, dann eine Namenszeile, dann ein Block, der wie eine Signatur aussieht. Über der
  // Grußformel wird nie etwas versteckt: Was dort steht, ist Inhalt.
  let floor = body
  for (let i = to - 1; i > body; i--) {
    const c = closingLine(lines[i].text)
    if (!c.closing) continue
    let start = i + 1
    // Eine Namenszeile bleibt sichtbar, Firma oder Abteilung darunter gehören zur Signatur
    if (!c.name && start < to && nameLike(lines[start].text.trim()) && !JOB.test(lines[start].text) && !contactLike(lines[start]) && !lines[start].image) start++
    const rest = lines.slice(start, to)
    if (rest.length && rest.every(signatureLike) && (rest.some((l) => contactLike(l) || l.image) || (rest.length <= 3 && rest.some(roleLine))))
      return { start, end: to, reason: 'closing' }
    floor = start - 1
    break
  }

  // 5. Am Ende ein zusammenhängender Block aus Signaturzeilen mit mindestens zwei Kontaktangaben,
  // nur unterhalb einer Grußformel samt Name
  let start = to
  while (start - 1 > floor && signatureLike(lines[start - 1])) start--
  // Name und Titel über den Kontaktzeilen gehören dazu, eine kurze letzte Inhaltszeile nicht:
  // ohne Kontaktzeile ganz oben beginnt die Signatur erst bei einer Namens- oder Bildzeile
  while (start < to && !contactLike(lines[start]) && !lines[start].image && !nameLike(lines[start].text.trim())) start++
  const block = lines.slice(start, to)
  const contacts = block.filter((l) => contactLike(l) || l.image).length
  // Mindestens eine Angabe, die nur in Signaturen steht (Telefon, Anschrift, Firma, Rechtshinweis):
  // Eine Liste aus Links oder Mailadressen ist Inhalt
  const evidence = block.some((l) => PHONE.test(l.text) || ADDRESS.test(l.text) || LEGAL.test(l.text) || DISCLAIMER.test(l.text) || COMPANY.test(l.text))
  if (start > floor && contacts >= 2 && block.some(strongContact) && evidence) return { start, end: to, reason: 'contact' }
  return undefined
}

export function findSignatures(lines: SigLine[]): SigRange[] {
  const starts = partStarts(lines)
  const out: SigRange[] = []
  starts.forEach((from, k) => {
    const to = starts[k + 1] ?? lines.length
    const hit = inPart(lines, from, to)
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

// Darf das ausgeblendet werden? Das Modell kann sich irren: Nur kurze Zeilen (oder Rechtstexte), keine
// Fragen, und mindestens eine Kontaktangabe, ein Bild oder eine Position.
export function plausibleSignature(lines: SigLine[]): boolean {
  if (!lines.length || lines.length > MODEL_LINES) return false
  // Jede Zeile muss in eine Signatur passen: kein Satz, keine Anweisung, kein P.S., keine Frage
  if (!lines.every((l) => signatureLike(l) || legalText(l))) return false
  return lines.some((l) => contactLike(l) || l.image || roleLine(l))
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
    if (hidden.filter((l) => !legalText(l) && !LEGAL.test(l.text)).length > 15 || !plausibleSignature(hidden)) return
    // Die Signatur beginnt mit Name, Kontakt, Bild oder Position, nicht mit einem Slogan oder Satz
    const top = hidden[0]
    const properName = /^(?:(?:i\.\s?[AV]\.|ppa\.|pp\.)\s+)?[A-ZÄÖÜ][\wäöüß'’-]+(?:\s+[A-ZÄÖÜ][\wäöüß'’.-]*){1,3}(?:\s*[|·,–-]\s*.*)?$/
    if (!((nameLike(top.text.trim()) && properName.test(top.text.trim())) || contactLike(top) || top.image || roleLine(top))) return
    out.push({ start: p.body + n - 1, end: p.end, reason: 'model' })
  })
  return out
}
