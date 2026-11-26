// Antwort an setDisplayMediaRequestHandler für die gewählte Quelle. Ton nur beim ganzen Bildschirm.
// Bei Fenstern fehlt der Schlüssel `audio` ganz: Fragt Teams Ton an, wirft Electron bei
// `audio: undefined` ("audio must be a WebFrameMain, "loopback" or "loopbackWithMute""), und
// getDisplayMedia scheitert mit "Invalid capture constraints".
export function displayResponse<T extends { id: string }>(src: T): { video: T; audio?: 'loopback' } {
  return src.id.startsWith('screen') ? { video: src, audio: 'loopback' } : { video: src }
}
