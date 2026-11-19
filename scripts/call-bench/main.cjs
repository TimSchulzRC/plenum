// Prüfstand für die Anruf-Medienbrücke: Eine nachgebaute Teams-Besprechungsseite läuft mit der
// echten Engine-Preload, das echte Anruffenster empfängt die Videos. Misst CPU, Codec und Kacheln.
// Start über run.mjs.
const { app, BrowserWindow, ipcMain, protocol, session, webContents } = require('electron')
const { join } = require('node:path')
const fs = require('node:fs')

const OUT = process.env.BENCH_OUT
const SECONDS = Number(process.env.BENCH_SECONDS || 20)
const QS = process.env.BENCH_QS || 'cams=4'
const COMPACT = !!process.env.BENCH_COMPACT
const fixture = fs.readFileSync(join(__dirname, 'fixture.html'))

// Wie in src/main/index.ts, dazu eine künstliche Kamera
for (const s of ['disable-renderer-backgrounding', 'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows', 'allow-loopback-in-peer-connection', 'use-fake-device-for-media-stream', 'use-fake-ui-for-media-stream'])
  app.commandLine.appendSwitch(s)
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns,MediaSessionService')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.setPath('userData', process.env.BENCH_USERDATA)

let state = null
let engine = null
let callWin = null
const logs = []
const broadcast = (ev, p) => {
  for (const w of BrowserWindow.getAllWindows()) if (w !== engine && !w.isDestroyed()) w.webContents.send('event', ev, p)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rtpStats = (wc, type) =>
  wc
    .executeJavaScript(
      `(async () => { const out = []; for (const pc of window.__pcs ? window.__pcs() : []) { const st = await pc.getStats(); st.forEach((r) => { if (r.type === '${type}' && r.kind === 'video' && r.frameWidth) out.push({ codec: st.get(r.codecId)?.mimeType, impl: r.encoderImplementation ?? r.decoderImplementation, w: r.frameWidth, h: r.frameHeight, fps: r.framesPerSecond, limit: r.qualityLimitationReason }) }) } return out })()`
    )
    .catch(() => [])

app.whenReady().then(async () => {
  session.defaultSession.registerPreloadScript({ type: 'frame', filePath: join(__dirname, 'pcspy.cjs') })
  protocol.handle('https', () => new Response(fixture, { headers: { 'content-type': 'text/html' } }))
  // Nachbau der Weiterleitung aus src/main/calls.ts
  ipcMain.handle('api', (_e, name) => (name === 'getCallState' ? state : null))
  ipcMain.on('engine:msg', (_e, msg) => {
    if (msg.ch === 'call-state') {
      state = { accountId: 'bench', ...msg.state }
      broadcast('call-state', state)
    } else if (msg.ch === 'streams') broadcast('bridge', { type: 'streams', streams: msg.streams })
    else if (msg.ch === 'bridge') {
      const wc = webContents.fromId(msg.msg.receiverId)
      if (wc && !wc.isDestroyed()) wc.send('event', 'bridge', msg.msg)
    } else if (msg.ch === 'log') logs.push(msg.text)
  })
  ipcMain.on('bridge:send', (e, msg) => engine.webContents.send('engine:cmd', { ch: 'bridge', msg: { ...msg, receiverId: e.sender.id } }))

  const prefs = (preload) => ({ preload: join(OUT, 'preload', preload), contextIsolation: true, sandbox: true, backgroundThrottling: false })
  engine = new BrowserWindow({ show: false, width: 1366, height: 900, webPreferences: prefs('engine.js') })
  await engine.loadURL(`https://teams.microsoft.com/v2/?${QS}`)
  callWin = new BrowserWindow({ width: 1280, height: 800, webPreferences: prefs('ui.js') })
  await callWin.loadFile(join(OUT, 'renderer/index.html'), { hash: '/call' })
  if (COMPACT) setTimeout(() => callWin.webContents.send('event', 'call-compact', true), 3000)

  await sleep(8000)
  const samples = []
  for (let i = 0; i < SECONDS; i++) {
    await sleep(1000)
    samples.push(app.getAppMetrics())
  }
  const cpuOf = (pid) => {
    const v = samples.map((s) => s.find((p) => p.pid === pid)?.cpu.percentCPUUsage ?? 0)
    return Math.round(v.reduce((a, b) => a + b, 0) / v.length)
  }
  const pids = [...new Set(samples.flat().map((p) => p.pid))]
  const tickMs = await engine.webContents.executeJavaScript('(() => { const t0 = performance.now(); for (let i = 0; i < 20; i++) window.__tmTick(); return (performance.now() - t0) / 20 })()')
  const result = {
    cpu: {
      total: pids.reduce((a, p) => a + cpuOf(p), 0),
      engine: cpuOf(engine.webContents.getOSProcessId()),
      call: cpuOf(callWin.webContents.getOSProcessId())
    },
    tickMs: Math.round(tickMs * 10) / 10,
    encoders: await rtpStats(engine.webContents, 'outbound-rtp'),
    decoders: await rtpStats(callWin.webContents, 'inbound-rtp'),
    tiles: await callWin.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.cw-tile .cw-tile-label span')).map((s) => s.textContent)`),
    participants: (state?.participants ?? []).map((p) => p.name + (p.isMe ? ' (ich)' : '')),
    log: logs.filter((l) => l.startsWith('bridge'))
  }
  if (process.env.BENCH_SHOT) fs.writeFileSync(process.env.BENCH_SHOT, (await callWin.webContents.capturePage()).toPNG())
  console.log(`BENCH ${JSON.stringify(result)}`)
  app.exit(0)
})
