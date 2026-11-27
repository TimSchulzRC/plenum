import DOMPurify from 'dompurify'
import type { MailMessage } from '@shared/types'
import { darkColor, darkCss } from './mail-dark'
import { bodyStart, findHeaders, findSignatures, isMe, parseMailDate, partStarts, shortDate, threadParts, type OpenPart, type Person, type SigLine, type SigRange, type ThreadPart } from './mail-signature'

export interface MailDoc {
  html: string
  blocked: number
  // Gefundene Signaturen (Regeln und, falls übergeben, Modell)
  signatures: number
  // Kopfzeilen zitierter Nachrichten („Von / Gesendet / An / Betreff“)
  headers: number
  // Teile des Verlaufs ohne Regel-Treffer, für das Sprachmodell
  unresolved: OpenPart[]
  // Nachrichten im Verlauf
  messages: number
}

// Verlauf als Chat: jede Nachricht eine Sprechblase, eigene rechts, andere links. Signatur und Kopf
// stehen nicht in der Blase, sondern im Pop-up über Name und Uhrzeit.
export interface ChatOptions {
  // eigene Konten: Name und Adresse
  me: Person[]
  // oberste Nachricht: Uhrzeit zur Anzeige und ihr Kopf fürs Pop-up, aus den Angaben der Mail
  topTime: string
  topHeader: string[]
  // Zeitpunkt aus einem zitierten Kopf wie topTime beschriften
  formatTime: (ms: number) => string
  // In dieser Sitzung gesendete Antworten, älteste zuerst. Sie stehen noch nicht in der Mail und
  // kommen als eigene Blasen unter den Verlauf.
  sent?: { name: string; text: string; time: string; header: string[]; files: number }[]
}

export interface SignatureOptions {
  // Signaturen einklappen
  hide: boolean
  // Kopfzeilen zitierter Nachrichten einklappen
  hideHeaders?: boolean
  // Vom Sprachmodell gefundene Signaturen (Zeilen wie in unresolved)
  extra?: SigRange[]
  // Als Chat zeigen statt als Mail. hide und hideHeaders gelten dann nicht.
  chat?: ChatOptions
}

// Block-Elemente trennen Zeilen, <br> auch
const BLOCK = new Set(
  'ADDRESS ARTICLE ASIDE BLOCKQUOTE CENTER DD DETAILS DIV DL DT FIELDSET FIGCAPTION FIGURE FOOTER H1 H2 H3 H4 H5 H6 HEADER HR LI MAIN NAV OL P PRE SECTION TABLE TBODY TD TFOOT TH THEAD TR UL'.split(' ')
)

// Signatur, wie Outlook (Web, Mobile), Gmail, Apple Mail und Thunderbird sie markieren
function signatureMarker(el: Element): boolean {
  const id = el.id || ''
  const cls = typeof el.className === 'string' ? el.className : ''
  return (
    /^(?:x_)*(?:signature|applemailsignature|ms-outlook-mobile-signature)$/i.test(id) ||
    /(?:^|\s)(?:x_)*(?:gmail_signature|moz-signature|signature)(?:\s|$)/i.test(cls) ||
    el.getAttribute('data-smartmail') === 'gmail_signature'
  )
}

// Beginn eines zitierten Teils, wie die Clients ihn markieren. Kopfzeilen ohne Markierung
// erkennt partStarts() am Text.
function quoteMarker(el: Element): boolean {
  const id = el.id || ''
  const cls = typeof el.className === 'string' ? el.className : ''
  return (
    /^(?:x_)*(?:divrplyfwdmsg|appendonsend|mail-editor-reference-message-container)$/i.test(id) ||
    /(?:^|\s)(?:x_)*(?:gmail_quote|gmail_attr|moz-cite-prefix|yahoo_quoted)(?:\s|$)/i.test(cls) ||
    (el.tagName === 'BLOCKQUOTE' && el.getAttribute('type') === 'cite')
  )
}

type DomLine = SigLine & { first: Node }

// Sichtbare Zeilen der Mail in Reihenfolge, je mit dem ersten Knoten für die Range
function collectLines(root: Element): DomLine[] {
  const out: DomLine[] = []
  let text = ''
  let first: Node | undefined
  let image = false
  // Nummer des äußersten markierten Signatur-Elements, in dem wir gerade sind
  const markers: number[] = []
  let markerSeq = 0
  let boundary = false
  const flush = () => {
    // Unsichtbare Zeichen (Zero-Width-Space, weiches Trennzeichen) zählen nicht als Text: Eine Zeile
    // nur daraus ist leer und unterbricht keinen Signaturblock
    const t = text.replace(/[\u200b-\u200d\ufeff\u00ad]/g, '').replace(/[\u2010\u2011]/g, '-').replace(/\s+/g, ' ').trim()
    if (first && (t || image)) {
      // „-- “ mit Leerzeichen am Ende ist der Signaturtrenner, das Leerzeichen fällt beim Trimmen weg
      const sep = /^[ \t\r\n]*--[ \u00a0]$/.test(text.replace(/[\r\n]+$/, '')) || undefined
      out.push({ text: t, image: image || undefined, first, marker: markers[0], sep, boundary: boundary || undefined })
      boundary = false
    }
    text = ''
    first = undefined
    image = false
  }
  const visit = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (!first && child.textContent?.trim()) first = child
        text += child.textContent ?? ''
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const el = child as Element
      if (el.tagName === 'BR') {
        flush()
        continue
      }
      if (el.tagName === 'IMG') {
        first ??= el
        image = true
        continue
      }
      if (el.tagName === 'STYLE') continue
      const sig = signatureMarker(el)
      const quote = quoteMarker(el)
      const split = BLOCK.has(el.tagName) || sig || quote
      if (split) flush()
      if (quote) boundary = true
      if (sig) markers.push(++markerSeq)
      const before = out.length
      visit(el)
      // Erst die letzte Zeile des Elements abschließen, dann die Markierung beenden
      if (split) flush()
      if (sig) markers.pop()
      // Leere Zitat-Markierung (z. B. ein leeres appendonsend): kein neuer Teil bei der nächsten Zeile
      if (quote && out.length === before) boundary = false
    }
  }
  visit(root)
  flush()
  return out
}

const INLINE = new Set(['A', 'SPAN', 'FONT', 'B', 'STRONG', 'I', 'EM', 'U', 'SMALL', 'BIG', 'SUB', 'SUP'])

// child ist der erste Inhalt von parent (davor höchstens Leerraum)
function startsWith(parent: Node, child: Node): boolean {
  for (let n = parent.firstChild; n && n !== child; n = n.nextSibling) {
    if (n.nodeType === Node.TEXT_NODE && !n.textContent?.trim()) continue
    if (n.nodeType === Node.COMMENT_NODE) continue
    return false
  }
  return true
}

const TABLE_PARTS = new Set(['TR', 'TD', 'TH', 'TBODY', 'THEAD', 'TFOOT', 'CAPTION', 'COLGROUP', 'COL'])

// Schneidet die Signatur durch eine Tabelle (ganze Mail in einer Layout-Tabelle), liegen im
// herausgelösten Stück Zeilen oder Zellen ohne Tabelle. Im iframe würde der Parser sie aus <details>
// herausschieben, die Signatur bliebe sichtbar. Deshalb kommen sie in eine eigene Tabelle.
function wrapTableParts(frag: DocumentFragment): void {
  const doc = frag.ownerDocument
  const kids = [...frag.childNodes]
  const isPart = (n: Node) => n.nodeType === Node.ELEMENT_NODE && TABLE_PARTS.has((n as Element).tagName)
  const blank = (n: Node) => n.nodeType === Node.TEXT_NODE && !n.textContent?.trim()
  let i = 0
  while (i < kids.length) {
    if (!isPart(kids[i])) {
      i++
      continue
    }
    const table = doc.createElement('table')
    let tbody: Element | null = null
    let tr: Element | null = null
    while (i < kids.length && (isPart(kids[i]) || blank(kids[i]))) {
      const el = kids[i++] as Element
      if (!isPart(el)) continue
      if (el.tagName === 'TD' || el.tagName === 'TH') {
        tbody ??= table.appendChild(doc.createElement('tbody'))
        tr ??= tbody.appendChild(doc.createElement('tr'))
        tr.appendChild(el)
      } else if (el.tagName === 'TR') {
        tbody ??= table.appendChild(doc.createElement('tbody'))
        tbody.appendChild(el)
        tr = null
      } else {
        table.appendChild(el)
        tbody = null
        tr = null
      }
    }
    frag.insertBefore(table, kids[i] ?? null)
  }
}

interface Fold {
  start: number
  end: number
  label: string
  cls: 'te-sig' | 'te-head'
}

// Bereiche in <details> packen: zugeklappt, ein Klick auf die Zeile zeigt sie (ohne Skript).
// Von oben nach unten: Das Ende eines Bereichs ist oft der Anfang des nächsten, der dann noch an
// seinem Platz stehen muss.
function wrapFolds(root: Element, lines: DomLine[], folds: Fold[]): void {
  const doc = root.ownerDocument
  for (const r of [...folds].sort((a, b) => a.start - b.start)) {
    // Platzhalter an der Stelle der ersten Zeile (etwa in ihrer Tabellenzelle). Nach dem
    // Herauslösen läge der Anfang der Range sonst eine Ebene höher, bei Tabellen direkt in <tbody>.
    // Beginnt die Zeile mit einem Link oder einer Formatierung, kommt der Platzhalter davor: <details>
    // in einem <a> setzt der Parser im iframe auseinander. Nur wenn die Zeile das Element beginnt,
    // sonst geriete Text davor mit in den Bereich.
    let first: Node = lines[r.start].first
    while (first.parentNode && first.parentNode !== root && INLINE.has(first.parentNode.nodeName) && startsWith(first.parentNode, first)) first = first.parentNode
    const mark = doc.createElement('span')
    first.parentNode!.insertBefore(mark, first)
    const range = doc.createRange()
    range.setStartAfter(mark)
    if (r.end < lines.length) range.setEndBefore(lines[r.end].first)
    else range.setEnd(root, root.childNodes.length)
    const frag = range.extractContents()
    wrapTableParts(frag)
    const details = doc.createElement('details')
    details.className = r.cls
    const summary = doc.createElement('summary')
    summary.textContent = r.label
    details.append(summary, frag)
    mark.replaceWith(details)
  }
}

// Erster Knoten einer Zeile für eine Schnittstelle: Beginnt die Zeile mit einem Link oder einer
// Formatierung, liegt die Schnittstelle davor (siehe wrapFolds)
function cutBefore(root: Element, line: DomLine): Node {
  let first: Node = line.first
  while (first.parentNode && first.parentNode !== root && INLINE.has(first.parentNode.nodeName) && startsWith(first.parentNode, first)) first = first.parentNode
  return first
}

const BLANK_CHARS = /[\s\u00a0\u200b-\u200d\ufeff]/g
const KEEP = 'img,table,video,picture'
// Leerer Absatz, <br>, Trennlinie: am Anfang und Ende einer Blase überflüssig
function blank(n: Node): boolean {
  if (n.nodeType === Node.COMMENT_NODE) return true
  if (n.nodeType === Node.TEXT_NODE) return !n.textContent?.replace(BLANK_CHARS, '')
  if (n.nodeType !== Node.ELEMENT_NODE) return false
  const el = n as Element
  if (el.matches(KEEP) || el.querySelector(KEEP)) return false
  return !el.textContent?.replace(BLANK_CHARS, '')
}
const DIGS = new Set(['DIV', 'P', 'SPAN', 'FONT', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'CENTER'])
function trimBlank(node: Node): void {
  while (node.lastChild && blank(node.lastChild)) node.removeChild(node.lastChild)
  while (node.firstChild && blank(node.firstChild)) node.removeChild(node.firstChild)
  // Leere Absätze stecken oft eine Ebene tiefer („<div><p>Text</p><p>&nbsp;</p></div>“)
  const last = node.lastChild
  if (last && DIGS.has(last.nodeName)) trimBlank(last)
  const first = node.firstChild
  if (first && first !== last && DIGS.has(first.nodeName)) trimBlank(first)
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Zeilen eines Kopfes („Von: …“) mit fettem Feldnamen
const headLines = (texts: string[]) =>
  texts.map((t) => {
    const m = t.match(/^([^:]{1,24}):\s*(.*)$/)
    return `<div class="hl">${m ? `<b>${esc(m[1])}:</b> ${esc(m[2])}` : esc(t)}</div>`
  })

// Name oder Uhrzeit mit Pop-up. Das Pop-up hängt per CSS-Ankerpositionierung an seinem Auslöser und
// öffnet nach unten oder oben, je nachdem, wo im iframe mehr Platz ist. Jeder Auslöser braucht dafür
// einen eigenen Ankernamen.
let popSeq = 0
function popTrigger(cls: string, label: string, card: string): string {
  if (!card) return `<div class="${cls}">${label}</div>`
  const id = `--p${++popSeq}`
  return `<div class="${cls} has-pop" tabindex="0" style="anchor-name:${id}">${label}<div class="pop" style="position-anchor:${id}"><div class="card">${card}</div></div></div>`
}

// Mail in Nachrichten zerschneiden und als Chat aufbauen. Jede Grenze bekommt eine Markierung, dann
// wird zwischen je zwei Markierungen herausgelöst. Kopf und Signatur landen in Pop-ups.
function chatBody(root: Element, lines: DomLine[], parts: ThreadPart[], chat: ChatOptions): string {
  const doc = root.ownerDocument
  // Der Signaturtrenner „--“ über dem Namen bleibt in der Blase sonst allein stehen
  for (const p of parts) {
    if (!p.signature) continue
    for (let i = Math.max(p.body + 1, p.signature.start - 2); i < p.signature.start; i++) {
      const first = lines[i].first
      if (/^--$/.test(lines[i].text) && first.nodeType === Node.TEXT_NODE && first.textContent?.trim() === '--') first.textContent = ''
    }
  }
  const bounds = new Set<number>()
  for (const p of parts) {
    bounds.add(p.start).add(p.body).add(p.end)
    if (p.signature) bounds.add(p.signature.start).add(p.signature.end)
  }
  const sorted = [...bounds].filter((i) => i > 0 && i < lines.length).sort((a, b) => a - b)
  const cuts = new Map(sorted.map((i) => [i, cutBefore(root, lines[i])]))
  const marks = new Map<number, Element>()
  for (const [i, node] of cuts) {
    const mark = doc.createElement('span')
    node.parentNode!.insertBefore(mark, node)
    marks.set(i, mark)
  }
  // Inhalt der Zeilen [a, b) als eigenes Stück
  const cut = (a: number, b: number): DocumentFragment => {
    // Ohne Zeilen (leere Mail) gehört alles in die eine Blase
    if (lines.length && a >= b) return doc.createDocumentFragment()
    const range = doc.createRange()
    if (a <= 0) range.setStart(root, 0)
    else range.setStartAfter(marks.get(a)!)
    if (b >= lines.length) range.setEnd(root, root.childNodes.length)
    else range.setEndBefore(marks.get(b)!)
    const frag = range.extractContents()
    wrapTableParts(frag)
    return frag
  }
  const html = (frag: DocumentFragment) => {
    const div = doc.createElement('div')
    div.append(frag)
    trimBlank(div)
    return div.innerHTML
  }

  const out: string[] = []
  parts.forEach((p, k) => {
    // Alles vor der ersten Zeile gehört zur obersten Nachricht
    const from = k === 0 ? 0 : p.start
    const to = k === parts.length - 1 ? lines.length : p.end
    const sig = p.signature
    let body = ''
    let signature = ''
    const head = lines.slice(p.start, p.body).map((l) => l.text)
    if (p.body > from) cut(from, p.body)
    if (sig) {
      body = html(cut(p.body, sig.start))
      signature = html(cut(sig.start, sig.end))
      // Ein P.S. unter einer markierten Signatur bleibt in der Blase
      const after = html(cut(sig.end, to))
      if (after) body += after
    } else body = html(cut(p.body, to))

    const mine = isMe(p.sender, chat.me)
    const name = p.sender?.name || p.sender?.address || (k === 0 ? '' : 'Zitat')
    const ms = p.date ? parseMailDate(p.date) : undefined
    const time = k === 0 && p.body === p.start ? chat.topTime : ms !== undefined ? chat.formatTime(ms) : p.date ? shortDate(p.date) : ''
    const header = k === 0 && p.body === p.start ? chat.topHeader : head
    const who = [p.sender?.name && p.sender.address ? `<div class="addr">${esc(p.sender.address)}</div>` : '', signature ? `<div class="sig">${signature}</div>` : ''].join('')
    const meta = [
      name ? popTrigger('who', esc(name), who) : '',
      time || header.length ? popTrigger('when', esc(time || 'Details'), headLines(header).join('')) : ''
    ].join('')
    out.push(`<div class="msg ${mine ? 'mine' : 'other'}">${meta ? `<div class="meta">${meta}</div>` : ''}<div class="bubble">${body || '<span class="empty">(ohne Text)</span>'}</div></div>`)
  })
  // Gesendete Antworten: Klartext, Zeilenumbrüche bleiben
  const sent = (chat.sent ?? []).map((x) => {
    const text = esc(x.text.trim()).replace(/\r?\n/g, '<br>')
    const files = x.files ? `<div class="files">${x.files === 1 ? '1 Anhang' : `${x.files} Anhänge`}</div>` : ''
    return `<div class="msg mine sent"><div class="meta">${popTrigger('who', esc(x.name), '')}${popTrigger('when', `${esc(x.time)} · gesendet`, headLines(x.header).join(''))}</div><div class="bubble">${text || '<span class="empty">(ohne Text)</span>'}${files}</div></div>`
  })
  // Älteste oben, neueste unten
  return `<div class="thread">${[...out.reverse(), ...sent].join('')}</div>`
}

// Chat-Ansicht: Hintergrund, Blasen, Name und Uhrzeit mit Pop-up beim Überfahren (ohne Skript)
const chatCss = (dark: boolean) => {
  const c = dark
    ? { bg: '#1f1f1f', other: '#292929', mine: '#2b2b40', fg: '#dbdbdb', meta: '#adadad', card: '#2e2e2e', line: '#3d3d3d', shadow: 'rgba(0,0,0,.5)' }
    : { bg: '#f5f5f5', other: '#ffffff', mine: '#e8ebfa', fg: '#242424', meta: '#616161', card: '#ffffff', line: '#e0e0e0', shadow: 'rgba(0,0,0,.16)' }
  return `html{height:100%;background:${c.bg}}body.chat{height:100%;margin:0;display:flex;flex-direction:column-reverse;overflow-y:auto;overflow-x:hidden}.thread{margin-bottom:auto;padding:18px 24px 22px;display:flex;flex-direction:column;gap:18px}.msg{display:flex;flex-direction:column;align-items:flex-start;max-width:min(86%,780px);min-width:0}.msg.mine{align-self:flex-end;align-items:flex-end}.meta{position:relative;display:flex;gap:10px;align-items:baseline;margin:0 6px 4px;font-size:12px;color:${c.meta};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif}.who{font-weight:600;font-size:12.5px;color:${c.fg}}.has-pop{cursor:default;outline:none}.has-pop:hover,.has-pop:focus{text-decoration:underline dotted;text-underline-offset:3px}.pop{display:none;position:fixed;z-index:10;position-area:block-end span-inline-end;position-try:most-height flip-block,flip-inline,flip-block flip-inline;max-height:100%;max-width:100%;padding:6px 0;box-sizing:border-box;flex-direction:column;font-weight:400;cursor:auto}.mine .pop{position-area:block-end span-inline-start}.has-pop:hover>.pop,.has-pop:focus-within>.pop{display:flex}.card{box-sizing:border-box;max-width:440px;max-height:380px;min-height:0;flex:0 1 auto;overflow:auto;overflow-wrap:anywhere;padding:10px 12px;border-radius:10px;background:${c.card};color:${c.fg};border:1px solid ${c.line};box-shadow:0 8px 24px ${c.shadow};font-size:12.5px;line-height:1.45;text-decoration:none}.card .addr{color:${c.meta};margin-bottom:6px}.card .addr:last-child{margin-bottom:0}.card .sig{border-top:1px solid ${c.line};padding-top:8px}.card .addr+.sig{margin-top:2px}.card .sig:first-child{border-top:0;padding-top:0}.card .hl{margin:1px 0}.bubble{min-width:0;max-width:100%;overflow-x:auto;padding:10px 14px;border-radius:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;background:${c.other};color:${c.fg};box-shadow:0 1px 2px rgba(0,0,0,${dark ? '.4' : '.08'})}.mine .bubble{background:${c.mine}}.card{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif}.bubble :not(pre,code,pre *,code *,tt,kbd,samp),.card :not(pre,code,pre *,code *,tt,kbd,samp){font-family:inherit!important}.bubble>:first-child,.bubble>:first-child>:first-child{margin-top:0}.bubble>:last-child,.bubble>:last-child>:last-child{margin-bottom:0}.bubble .files{margin-top:6px;font-size:12px;color:${c.meta}}.bubble .empty{color:${c.meta};font-style:italic}.bubble blockquote[type=cite],.bubble .gmail_quote,.bubble blockquote.gmail_quote{margin:0!important;padding:0!important;border:0!important}`
}

// „Signatur anzeigen“ und die Kurzform der Kopfzeilen im Dokument, hell oder dunkel
const foldCss = (dark: boolean) => {
  const fg = dark ? '#adadad' : '#707070'
  const line = dark ? '#4a4a4a' : '#e0e0e0'
  return `details.te-sig{margin:4px 0 10px}details.te-sig>summary{display:inline-block;list-style:none;cursor:pointer;font-size:12px;color:${fg};padding:1px 9px;border:1px solid ${line};border-radius:10px;user-select:none}details.te-sig>summary::-webkit-details-marker,details.te-head>summary::-webkit-details-marker{display:none}details.te-sig>summary::after{content:" anzeigen"}details.te-sig[open]>summary::after{content:" ausblenden"}details.te-sig[open]>summary{margin-bottom:6px}details.te-head{margin:12px 0 6px}details.te-head>summary{list-style:none;cursor:pointer;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;font-size:12px;font-weight:600;color:${fg};user-select:none}details.te-head>summary::before{content:"▸ "}details.te-head[open]>summary::before{content:"▾ "}details.te-head[open]>summary{margin-bottom:4px}`
}

// Dokument für das iframe im Lesebereich. Drei Schichten Schutz:
// 1. DOMPurify entfernt Skripte, Formulare, eingebettete Frames und Event-Attribute.
// 2. Das iframe läuft mit sandbox ohne allow-scripts und ohne allow-same-origin.
// 3. Eine eigene Content-Security-Policy lässt externe Bilder, Schriften und CSS-URLs nur zu, wenn
//    remote true ist. Sonst lädt die Mail nichts nach (Tracking-Pixel), auch nicht über CSS.
// dark: Farben der Mail für dunklen Hintergrund umrechnen (siehe mail-dark.ts)
// Signaturen und Kopfzeilen sucht mail-signature.ts, das Einklappen braucht kein Skript (<details>).
export function mailDocument(
  m: Pick<MailMessage, 'body' | 'bodyType' | 'inlineImages'> & Partial<Pick<MailMessage, 'from'>>,
  remote: boolean,
  dark = false,
  sig: SignatureOptions = { hide: false }
): MailDoc {
  let head = ''
  let root: HTMLElement
  let blocked = 0
  if (m.bodyType === 'text') {
    // Klartext zeilenweise, damit die Signatursuche Zeilen sieht. Leerzeichen bleiben (pre-wrap).
    const doc = document.implementation.createHTMLDocument('')
    root = doc.body
    const div = doc.createElement('div')
    div.setAttribute('style', 'white-space: pre-wrap')
    m.body.split(/\r?\n/).forEach((line, i) => {
      if (i) div.appendChild(doc.createElement('br'))
      div.appendChild(doc.createTextNode(line))
    })
    root.appendChild(div)
  } else {
    const html = DOMPurify.sanitize(m.body, {
      WHOLE_DOCUMENT: true,
      RETURN_DOM: true,
      FORBID_TAGS: ['script', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'meta', 'link', 'base', 'svg', 'math'],
      FORBID_ATTR: ['srcset', 'ping'],
      ADD_ATTR: ['target']
    }) as HTMLElement
    for (const img of html.querySelectorAll('img')) {
      const src = img.getAttribute('src') ?? ''
      const cid = /^cid:/i.test(src) ? src.slice(4).replace(/^<|>$/g, '') : undefined
      if (cid) {
        const data = m.inlineImages[cid]
        if (data) img.setAttribute('src', data)
        else img.removeAttribute('src')
      } else if (/^https?:/i.test(src) && !remote) {
        // Statt kaputtem Bildsymbol nur der Alternativtext, Zählpixel ohne Text fallen weg
        const alt = img.getAttribute('alt')?.trim()
        if (alt) {
          const span = img.ownerDocument.createElement('span')
          span.setAttribute('style', 'color:#707070;font-size:12px')
          span.textContent = `[${alt}]`
          img.replaceWith(span)
        } else img.remove()
        blocked++
      }
    }
    if (!remote) {
      for (const el of html.querySelectorAll('[background]')) {
        el.removeAttribute('background')
        blocked++
      }
    }
    for (const a of html.querySelectorAll('a[href]')) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
    }
    if (dark) {
      for (const el of html.querySelectorAll('[style]')) el.setAttribute('style', darkCss(el.getAttribute('style') ?? ''))
      for (const el of html.querySelectorAll('style')) el.textContent = darkCss(el.textContent ?? '')
      for (const [sel, attr] of [['[bgcolor]', 'bgcolor'], ['font[color]', 'color']]) {
        for (const el of html.querySelectorAll(sel)) {
          const c = darkColor(el.getAttribute(attr) ?? '')
          if (c) el.setAttribute(attr, c)
        }
      }
    }
    head = [...html.querySelectorAll('style')].map((s) => s.outerHTML).join('')
    html.querySelectorAll('style').forEach((s) => s.remove())
    root = html.querySelector('body') ?? html
  }

  const lines = collectLines(root)
  // Absender für die Regel „Block mit dem Namen des Absenders“: Anzeigename, sonst der Teil vor dem @
  const found = findSignatures(lines, m.from ? `${m.from.name ?? ''} ${m.from.address.split('@')[0].replace(/[._-]+/g, ' ')}` : undefined)
  const starts = partStarts(lines)
  const unresolved = starts
    .map((start, k) => ({ start, end: starts[k + 1] ?? lines.length }))
    .filter((p) => !found.some((r) => r.start >= p.start && r.start < p.end))
    .map((p): OpenPart => {
      const body = bodyStart(lines, p.start, p.end)
      return { body, end: p.end, lines: lines.slice(body, p.end).map(({ text, image }) => ({ text, image })) }
    })
  const extra = (sig.extra ?? []).filter((x) => x.start > 0 && x.end <= lines.length && !found.some((r) => r.start < x.end && x.start < r.end))
  const all = [...found, ...extra]
  const headers = findHeaders(lines)
  const top: Person | undefined = m.from ? { name: m.from.name, address: m.from.address } : undefined
  const parts = threadParts(lines, all, top)
  let body: string
  if (sig.chat) body = chatBody(root, lines, parts, sig.chat)
  else {
    const folds: Fold[] = [
      ...(sig.hide ? all.map((r): Fold => ({ start: r.start, end: r.end, label: 'Signatur', cls: 'te-sig' })) : []),
      ...(sig.hideHeaders ? headers.map((r): Fold => ({ ...r, cls: 'te-head' })) : [])
    ]
    if (folds.length) wrapFolds(root, lines, folds)
    body = root.innerHTML
  }
  const img = remote ? 'data: https: http:' : 'data:'
  const csp = `default-src 'none'; img-src ${img}; style-src 'unsafe-inline'${remote ? ' https:' : ''}; font-src data:${remote ? ' https:' : ''}`
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html{${dark ? 'background:#292929;color:#dbdbdb;color-scheme:dark' : 'background:#fff;color:#242424'}}${dark ? 'a{color:#8ab4f8}' : ''}body{margin:20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;font-size:14px;line-height:1.45;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}blockquote{margin:0 0 0 8px;padding-left:12px;border-left:2px solid ${dark ? '#4a4a4a' : '#d1d1d1'}}${sig.chat ? chatCss(dark) : foldCss(dark)}</style>${head}</head><body${sig.chat ? ' class="chat"' : ''}>${body}</body></html>`
  return { html, blocked, signatures: all.length, headers: headers.length, unresolved, messages: parts.length + (sig.chat?.sent?.length ?? 0) }
}
