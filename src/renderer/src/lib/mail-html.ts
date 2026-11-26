import DOMPurify from 'dompurify'
import type { MailMessage } from '@shared/types'

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Dokument für das iframe im Lesebereich. Drei Schichten Schutz:
// 1. DOMPurify entfernt Skripte, Formulare, eingebettete Frames und Event-Attribute.
// 2. Das iframe läuft mit sandbox ohne allow-scripts und ohne allow-same-origin.
// 3. Eine eigene Content-Security-Policy lässt externe Bilder, Schriften und CSS-URLs nur zu, wenn
//    remote true ist. Sonst lädt die Mail nichts nach (Tracking-Pixel), auch nicht über CSS.
export function mailDocument(m: Pick<MailMessage, 'body' | 'bodyType' | 'inlineImages'>, remote: boolean): { html: string; blocked: number } {
  let head = ''
  let body: string
  let blocked = 0
  if (m.bodyType === 'text') {
    body = `<div style="white-space: pre-wrap">${escape(m.body)}</div>`
  } else {
    const root = DOMPurify.sanitize(m.body, {
      WHOLE_DOCUMENT: true,
      RETURN_DOM: true,
      FORBID_TAGS: ['script', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'meta', 'link', 'base', 'svg', 'math'],
      FORBID_ATTR: ['srcset', 'ping'],
      ADD_ATTR: ['target']
    }) as HTMLElement
    for (const img of root.querySelectorAll('img')) {
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
      for (const el of root.querySelectorAll('[background]')) {
        el.removeAttribute('background')
        blocked++
      }
    }
    for (const a of root.querySelectorAll('a[href]')) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
    }
    head = [...root.querySelectorAll('style')].map((s) => s.outerHTML).join('')
    root.querySelectorAll('style').forEach((s) => s.remove())
    body = root.querySelector('body')?.innerHTML ?? ''
  }
  const img = remote ? 'data: https: http:' : 'data:'
  const csp = `default-src 'none'; img-src ${img}; style-src 'unsafe-inline'${remote ? ' https:' : ''}; font-src data:${remote ? ' https:' : ''}`
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html{background:#fff;color:#242424}body{margin:20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;font-size:14px;line-height:1.45;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}blockquote{margin:0 0 0 8px;padding-left:12px;border-left:2px solid #d1d1d1}</style>${head}</head><body>${body}</body></html>`
  return { html, blocked }
}
