// Erzeugt die App-Icons der drei Kanäle aus einer gemeinsamen Marke: eine Scheibe mit
// abgesetztem Punkt. Die Kanäle folgen dem System von Obtion (scripts/generate-icons.ts dort):
// gleiche Marke, eigene Kachel und Akzentfarbe, Nightly unter einem Nachthimmel, Dev auf einer
// Blaupause. Jeder Kanal hat eine dunkle und eine helle Fassung. Die App-Icons sind die dunklen,
// die hellen zeigt die README im hellen GitHub-Theme.
//
// Aufruf: pnpm run icons. Schreibt assets/icons/*.svg, build/icon.icns (Stable),
// build/icon-nightly.icns, build/icon-dev.icns (Bundle-Icon bei `pnpm run dev`) und build/icon-dev.png.
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// macOS-Raster vor Tahoe: 1024er Leinwand, Körper 824×824 mit 100 px Rand und Radius 185.
const BODY = 'M285,100 H739 A185,185 0 0 1 924,285 V739 A185,185 0 0 1 739,924 H285 A185,185 0 0 1 100,739 V285 A185,185 0 0 1 285,100 Z'
const EDGE = 'M285,101 H739 A184,184 0 0 1 923,285 V739 A184,184 0 0 1 739,923 H285 A184,184 0 0 1 101,739 V285 A184,184 0 0 1 285,101 Z'
// Obtions Deko ist für eine 512er Kachel gezeichnet und wird auf den Körper skaliert.
const TILE = `translate(100 100) scale(${824 / 512})`

// Die Marke: Scheibe um (506, 506), der Punkt sitzt auf ihrem Rand unter 45°.
const CX = 506
const CY = 506
const R = 208
const DOT = 72
const GAP = 44
const DX = +(CX + R * Math.SQRT1_2).toFixed(2)
const DY = DX

function night(star, stars, back, front) {
  return `<g transform="${TILE}"><g fill="${star}" fill-opacity="${stars}">
<circle cx="74" cy="92" r="5"/><circle cx="212" cy="54" r="4"/><circle cx="452" cy="250" r="4"/><circle cx="52" cy="268" r="4"/><circle cx="296" cy="88" r="3"/><circle cx="462" cy="96" r="3"/>
<path d="M134 44l5 15 15 5-15 5-5 15-5-15-15-5 15-5zM440 152l4 11 11 4-11 4-4 11-4-11-11-4 11-4z"/></g>
<path d="M250 512V402a62 62 0 0 1 110-36 78 78 0 0 1 134 22 60 60 0 0 1 18 6V512z" fill="${back}"/>
<path d="M0 512V392a66 66 0 0 1 92-28 88 88 0 0 1 152 34 62 62 0 0 1 96 44 50 50 0 0 1 60 70z" fill="${front}"/></g>`
}

// Raster und Maßlinien wie bei Obtion, die gestrichelten Kreise folgen Scheibe und Aussparung.
function blueprint(line, grid, draft) {
  const minor = Array.from({ length: 15 }, (_, i) => (i + 1) * 32).filter((v) => v % 128 !== 0)
  const lines = (at) => at.map((v) => `M${v} 0V512M0 ${v}H512`).join('')
  return `<g stroke="${line}" fill="none">
<g transform="${TILE}"><path d="${lines(minor)}" stroke-width="1.5" stroke-opacity="${grid}"/>
<path d="${lines([128, 256, 384])}" stroke-width="2" stroke-opacity="${grid * 2}"/>
<g stroke-width="3" stroke-opacity="${draft}"><path d="M103 462H409M103 450V474M409 450V474M50 103V409M38 103H62M38 409H62"/>
<path d="M426 52V76M414 64H438M64 430 80 446M80 430 64 446"/></g></g>
<g stroke-width="4.8" stroke-opacity="${draft}">
<circle cx="${CX}" cy="${CY}" r="${R}" stroke-dasharray="16 14"/>
<circle cx="${DX}" cy="${DY}" r="${DOT + GAP}" stroke-dasharray="16 14"/>
<path d="M${CX - 305},${CY}H${CX + 305}M${CX},${CY - 305}V${CY + 305}" stroke-dasharray="35 13 6 13"/></g></g>`
}

const AMBER = ['#F6B93E', '#E0940F']
const DARK_MARK = ['#FFFFFF', '#D8D8D8']
const LIGHT_MARK = ['#4A4A4A', '#111111']

const VARIANTS = {
  stable: {
    dark: { tile: ['#272727', '#121212'], mark: DARK_MARK, dot: AMBER, shadow: '#000000', shadowOpacity: 0.35, edge: 0.1, decor: '' },
    light: { tile: ['#FDFCFA', '#EEEAE2'], mark: LIGHT_MARK, dot: AMBER, shadow: '#000000', edge: 0.8, decor: '' },
  },
  nightly: {
    dark: { tile: ['#241E55', '#0D0B26'], mark: DARK_MARK, dot: ['#C3A6FF', '#9466F5'], shadow: '#000000', edge: 0.12, decor: night('#FFFFFF', 0.9, '#3A2D85', '#4C3BA6') },
    light: { tile: ['#F6F2FF', '#DDD2F7'], mark: LIGHT_MARK, dot: ['#A983FF', '#7A45E8'], shadow: '#3F1A8F', edge: 0.8, decor: night('#8452F0', 0.55, '#CDBDF3', '#BBA6EE') },
  },
  dev: {
    dark: { tile: ['#3F86F2', '#1749B5'], mark: DARK_MARK, dot: ['#BFE0FF', '#7DB8FF'], shadow: '#0B2A6B', edge: 0.12, decor: blueprint('#FFFFFF', 0.14, 0.55) },
    light: { tile: ['#F7FAFF', '#DCE7F8'], mark: LIGHT_MARK, dot: ['#5B9AFF', '#2466DD'], shadow: '#1A4B9B', edge: 0.8, decor: blueprint('#2773ED', 0.13, 0.45) },
  },
}

const gradient = (id, [a, b], x2 = 1, y2 = 1) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`

// Beide Schatten rechnen in sRGB. Im voreingestellten linearRGB bleiben in dunklen Flächen
// nur grobe Stufen übrig, und die Verläufe darunter bekommen Streifen.
function icon(v) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<defs>
<filter id="sh" color-interpolation-filters="sRGB" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#000" flood-opacity="0.28"/></filter>
<filter id="msh" color-interpolation-filters="sRGB" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="19" stdDeviation="19" flood-color="${v.shadow}" flood-opacity="${v.shadowOpacity ?? 0.17}"/></filter>
<clipPath id="body"><path d="${BODY}"/></clipPath>
${gradient('tile', v.tile, 0.7)}${gradient('mark', v.mark, 0.6)}${gradient('dot', v.dot)}
<mask id="cut"><rect width="1024" height="1024" fill="#fff"/><circle cx="${DX}" cy="${DY}" r="${DOT + GAP}" fill="#000"/></mask>
</defs>
<g filter="url(#sh)"><path d="${BODY}" fill="#000"/></g>
<g clip-path="url(#body)">
<rect width="1024" height="1024" fill="url(#tile)"/>
${v.decor}
<g filter="url(#msh)"><circle cx="${CX}" cy="${CY}" r="${R}" fill="url(#mark)" mask="url(#cut)"/>
<circle cx="${DX}" cy="${DY}" r="${DOT}" fill="url(#dot)"/>
<circle cx="${DX}" cy="${DY}" r="${DOT - 1.6}" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="3.2"/></g>
</g>
<path d="${EDGE}" fill="none" stroke="#fff" stroke-opacity="${v.edge}" stroke-width="2"/>
</svg>
`
}

function png(svg, size) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
}

// ICNS mit PNG-Einträgen, wie iconutil sie schreibt: 16 bis 512 pt, jeweils in 1× und 2×.
const ICNS_ENTRIES = [
  ['icp4', 16], ['ic11', 32], ['icp5', 32], ['ic12', 64], ['ic07', 128],
  ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024],
]

function icns(images) {
  const chunks = ICNS_ENTRIES.map(([type, size]) => {
    const data = images(size)
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([head, data])
  })
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4)
  return Buffer.concat([head, ...chunks])
}

mkdirSync(join(root, 'assets/icons'), { recursive: true })
const svgs = {}
for (const [channel, { dark, light }] of Object.entries(VARIANTS)) {
  svgs[channel] = icon(dark)
  writeFileSync(join(root, `assets/icons/${channel}.svg`), svgs[channel])
  writeFileSync(join(root, `assets/icons/${channel}-light.svg`), icon(light))
}
const cache = new Map()
const render = (channel) => (size) => {
  const key = `${channel}@${size}`
  if (!cache.has(key)) cache.set(key, png(svgs[channel], size))
  return cache.get(key)
}
writeFileSync(join(root, 'build/icon.icns'), icns(render('stable')))
writeFileSync(join(root, 'build/icon-nightly.icns'), icns(render('nightly')))
writeFileSync(join(root, 'build/icon-dev.icns'), icns(render('dev')))
writeFileSync(join(root, 'build/icon.png'), render('stable')(1024))
writeFileSync(join(root, 'build/icon-dev.png'), render('dev')(1024))
console.log('Icons geschrieben: assets/icons, build/icon.icns, build/icon-nightly.icns, build/icon-dev.icns, build/icon.png, build/icon-dev.png')
