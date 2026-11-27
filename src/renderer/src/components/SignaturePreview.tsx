// Vorschau der eigenen Signatur, wie sie unter der Mail steht: eigenes iframe ohne Skripte, ohne
// Netzwerk, Bilder nur als data:
export function SignaturePreview({ html }: { html: string }): JSX.Element {
  const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'"
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html{background:#fff;color:#242424}body{margin:10px 12px;font-family:Aptos,Calibri,Helvetica,sans-serif;font-size:13px;line-height:1.4;overflow-wrap:anywhere}img{max-width:100%;height:auto}p{margin:0}</style></head><body>${html}</body></html>`
  return <iframe className="signature-preview" title="Vorschau der Signatur" sandbox="" srcDoc={doc} />
}
