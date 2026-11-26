import DOMPurify from 'dompurify'
import type { MailMessage } from '@shared/types'
import { darkColor, darkCss } from './mail-dark'
import { bodyStart, findHeaders, findSignatures, partStarts, type OpenPart, type SigLine, type SigRange } from './mail-signature'

export interface MailDoc {
  html: string
  blocked: number
  // Gefundene Signaturen (Regeln und, falls übergeben, Modell)
  signatures: number
  // Kopfzeilen zitierter Nachrichten („Von / Gesendet / An / Betreff“)
  headers: number
  // Teile des Verlaufs ohne Regel-Treffer, für das Sprachmodell
  unresolved: OpenPart[]
}

export interface SignatureOptions {
  // Signaturen einklappen
  hide: boolean
  // Kopfzeilen zitierter Nachrichten einklappen
  hideHeaders?: boolean
  // Vom Sprachmodell gefundene Signaturen (Zeilen wie in unresolved)
  extra?: SigRange[]
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
    const t = text.replace(/[\u200b-\u200d\ufeff\u00ad]/g, '').replace(/\s+/g, ' ').trim()
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
  const folds: Fold[] = [
    ...(sig.hide ? all.map((r): Fold => ({ start: r.start, end: r.end, label: 'Signatur', cls: 'te-sig' })) : []),
    ...(sig.hideHeaders ? headers.map((r): Fold => ({ ...r, cls: 'te-head' })) : [])
  ]
  if (folds.length) wrapFolds(root, lines, folds)

  const body = root.innerHTML
  const img = remote ? 'data: https: http:' : 'data:'
  const csp = `default-src 'none'; img-src ${img}; style-src 'unsafe-inline'${remote ? ' https:' : ''}; font-src data:${remote ? ' https:' : ''}`
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html{${dark ? 'background:#292929;color:#dbdbdb;color-scheme:dark' : 'background:#fff;color:#242424'}}${dark ? 'a{color:#8ab4f8}' : ''}body{margin:20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;font-size:14px;line-height:1.45;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}blockquote{margin:0 0 0 8px;padding-left:12px;border-left:2px solid ${dark ? '#4a4a4a' : '#d1d1d1'}}${foldCss(dark)}</style>${head}</head><body>${body}</body></html>`
  return { html, blocked, signatures: all.length, headers: headers.length, unresolved }
}
