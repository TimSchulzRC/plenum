// Baut den Hilfsprozess für Signaturen mit Apple Foundation Models (native/mail-signatures.swift)
// nach out/native/mail-signatures. Nur auf macOS mit einem SDK, das FoundationModels enthält
// (Xcode 26 oder neuer). Sonst ohne Fehler überspringen: Die App erkennt Signaturen dann nur mit
// Regeln. Läuft vor electron-builder (siehe package.json) und vor `pnpm run dev`.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'native', 'mail-signatures.swift')
const outDir = join(root, 'out', 'native')
const out = join(outDir, 'mail-signatures')
mkdirSync(outDir, { recursive: true })

const skip = (why) => {
  console.log(`[native] Signatur-Helfer übersprungen: ${why}`)
  process.exit(0)
}

if (process.platform !== 'darwin') skip('kein macOS')
if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) skip('schon aktuell')

let sdk
try {
  sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim()
} catch {
  skip('kein Xcode')
}
if (!existsSync(join(sdk, 'System/Library/Frameworks/FoundationModels.framework'))) skip('SDK ohne FoundationModels (Xcode 26 oder neuer nötig)')

try {
  // Nur arm64: Apple Intelligence gibt es nicht auf Intel-Macs
  execFileSync('xcrun', ['--sdk', 'macosx', 'swiftc', '-O', '-parse-as-library', '-target', 'arm64-apple-macos26.0', src, '-o', out], { stdio: 'inherit' })
  console.log(`[native] ${out}`)
} catch (e) {
  // Lieber ohne Helfer bauen als gar nicht: Die App nutzt dann nur die Regeln
  console.warn(`[native] Signatur-Helfer nicht gebaut: ${e.message}`)
}
