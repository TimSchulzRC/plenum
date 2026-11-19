// pnpm bench:call [--cams 4] [--share] [--compact] [--seconds 20] [--out out] [--shot datei.png]
// Braucht einen Build (pnpm build). Auf Linux ohne Bildschirm läuft es unter xvfb-run.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const { values: a } = parseArgs({
  options: {
    cams: { type: 'string', default: '4' },
    share: { type: 'boolean', default: false },
    compact: { type: 'boolean', default: false },
    seconds: { type: 'string', default: '20' },
    out: { type: 'string', default: 'out' },
    shot: { type: 'string' }
  }
})
const electron = createRequire(import.meta.url)('electron')
const userData = mkdtempSync(join(tmpdir(), 'te-call-bench-'))
const env = {
  ...process.env,
  BENCH_USERDATA: userData,
  BENCH_OUT: resolve(a.out),
  BENCH_SECONDS: a.seconds,
  BENCH_QS: `cams=${a.cams}${a.share ? '&share=1' : ''}`,
  ...(a.compact ? { BENCH_COMPACT: '1' } : {}),
  ...(a.shot ? { BENCH_SHOT: resolve(a.shot) } : {})
}
const headless = process.platform === 'linux' && !process.env.DISPLAY
const cmd = headless ? 'xvfb-run' : electron
const args = headless ? ['-a', '-s', '-screen 0 1920x1080x24', electron, join(here, 'main.cjs')] : [join(here, 'main.cjs')]
const res = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: (Number(a.seconds) + 60) * 1000 })
rmSync(userData, { recursive: true, force: true })
const line = (res.stdout || '').split('\n').find((l) => l.startsWith('BENCH '))
if (!line) {
  console.error(res.stderr || res.error || 'Kein Ergebnis')
  process.exit(1)
}
const r = JSON.parse(line.slice(6))
const fmt = (s) => `${s.codec?.replace('video/', '')} ${s.impl ?? ''} ${s.w}x${s.h}@${s.fps ?? '?'}${s.limit && s.limit !== 'none' ? ` (${s.limit})` : ''}`.replace(/\s+/g, ' ')
console.log(`CPU gesamt ${r.cpu.total} %, Engine ${r.cpu.engine} %, Anruffenster ${r.cpu.call} %, Takt ${r.tickMs} ms`)
console.log(`Encoder:  ${r.encoders.map(fmt).join(' | ') || '–'}`)
console.log(`Decoder:  ${r.decoders.map(fmt).join(' | ') || '–'}`)
console.log(`Kacheln:  ${r.tiles.join(' | ')}`)
console.log(`Personen: ${r.participants.join(' | ')}`)
for (const l of r.log) console.log(`Log:      ${l}`)
