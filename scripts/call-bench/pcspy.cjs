// Merkt sich jede RTCPeerConnection der Seite, damit der Prüfstand ihre Statistik lesen kann.
const { webFrame } = require('electron')
void webFrame.executeJavaScript(
  `(() => { const O = window.RTCPeerConnection; const all = []; window.__pcs = () => all.filter((p) => p.connectionState !== 'closed'); window.RTCPeerConnection = class extends O { constructor(...a) { super(...a); all.push(this) } } })()`
)
