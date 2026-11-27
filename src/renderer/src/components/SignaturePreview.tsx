import { darkSignature } from '../lib/mail-html'
import { useDarkMode } from '../theme'

// Vorschau der eigenen Signatur, wie sie unter der Mail steht: eigenes iframe ohne Skripte. Bilder
// eingebettet oder über https, genau die, die mit der Mail rausgehen (siehe cleanSignature). Im dunklen
// Theme mit umgerechneten Farben wie im Lesebereich.
export function SignaturePreview({ html }: { html: string }): JSX.Element {
  const dark = useDarkMode()
  const csp = "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'"
  const colors = dark ? 'background:#292929;color:#dbdbdb;color-scheme:dark}a{color:#8ab4f8' : 'background:#fff;color:#242424'
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html{${colors}}body{margin:10px 12px;font-family:Aptos,Calibri,Helvetica,sans-serif;font-size:13px;line-height:1.4;overflow-wrap:anywhere}img{max-width:100%;height:auto}p{margin:0}</style></head><body>${dark ? darkSignature(html) : html}</body></html>`
  return <iframe className={`signature-preview${dark ? ' dark' : ''}`} title="Vorschau der Signatur" sandbox="" srcDoc={doc} />
}
