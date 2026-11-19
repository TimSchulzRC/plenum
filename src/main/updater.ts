// Updates aus den GitHub-Releases. electron-updater setzt auf macOS eine Apple-Signatur
// voraus, die Builds sind aber nur ad hoc signiert. Deshalb lädt der Updater die ZIP selbst,
// prüft die SHA256-Summe und tauscht das App-Bundle nach dem Beenden per Shell-Skript aus.
// Bleibt die Electron-Version gleich, reicht das Patch-ZIP ohne Frameworks (wenige MB statt >100).
import { app, net } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { promisify } from 'node:util'
import type { UpdateState } from '@shared/types'
import { log } from './log'
import { channelOf, checksumFor, pickUpdate, type GithubAsset, type GithubRelease, type UpdateCandidate } from './update/releases'

const execFileAsync = promisify(execFile)

const REPOSITORY = 'TimSchulzRC/teams-everywhere'
const WORKDIR_PREFIX = 'teams-everywhere-update-'
const FIRST_CHECK_DELAY = 15_000
const CHECK_INTERVAL = 30 * 60 * 1000
const CHECK_TIMEOUT = 30_000
const DOWNLOAD_IDLE_TIMEOUT = 60_000
const HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'teams-everywhere-updater' }

// Wartet, bis die App beendet ist, ersetzt das Bundle und startet die neue Version.
// Lässt sich die neue Version nicht verschieben oder nicht starten, kommt die alte zurück.
const INSTALL_SCRIPT = `
pid="$1"; target="$2"; source="$3"; workdir="$4"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 600 ]; then echo "App wurde nicht beendet, Update abgebrochen"; exit 1; fi
  sleep 0.1
done
launch() {
  if [ -n "$TE_USER_DATA_DIR" ]; then
    open --env "TE_USER_DATA_DIR=$TE_USER_DATA_DIR" "$target"
  else
    open "$target"
  fi
}
restore() {
  rm -rf "$target"
  mv "$backup" "$target"
}
backup="$target.update-old"
rm -rf "$backup"
if ! mv "$target" "$backup"; then
  echo "Alte Version ließ sich nicht verschieben, Update abgebrochen"
  launch
elif ! mv "$source" "$target"; then
  echo "Neue Version ließ sich nicht verschieben, alte Version wird wiederhergestellt"
  restore
  launch
else
  xattr -dr com.apple.quarantine "$target" 2>/dev/null
  if launch; then
    rm -rf "$backup"
    echo "Update installiert: $target"
  else
    echo "Neue Version startet nicht, alte Version wird wiederhergestellt"
    restore
    launch
  fi
fi
rm -rf "$workdir"
`

export class Updater {
  state: UpdateState
  private candidate: UpdateCandidate | null = null
  private stagedApp: string | null = null
  private workdir: string | null = null
  private readonly emit: (s: UpdateState) => void
  private readonly quit: () => void

  constructor(emit: (s: UpdateState) => void, quit: () => void) {
    this.emit = emit
    this.quit = quit
    const currentVersion = app.getVersion()
    const supported = app.isPackaged && process.platform === 'darwin'
    this.state = {
      status: supported ? 'idle' : 'disabled',
      currentVersion,
      channel: channelOf(currentVersion),
      availableVersion: null,
      downloadedVersion: null,
      releaseUrl: null,
      downloadPercent: null,
      errorContext: null,
      message: supported ? null : 'Updates gibt es nur in der installierten App für macOS.',
      lastChecked: null
    }
  }

  start(): void {
    if (this.state.status === 'disabled') return
    removeStaleDownloads()
    setTimeout(() => void this.check(), FIRST_CHECK_DELAY)
    setInterval(() => void this.check(), CHECK_INTERVAL)
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.emit(this.state)
  }

  private busy(): boolean {
    // Ein fertig geladenes Update bleibt bestehen, bis es installiert ist.
    return this.stagedApp !== null || ['checking', 'downloading', 'downloaded', 'installing'].includes(this.state.status)
  }

  async check(): Promise<UpdateState> {
    if (this.state.status === 'disabled' || this.busy()) return this.state
    this.set({ status: 'checking', errorContext: null, message: null })
    try {
      // Stable-Installationen fragen direkt den neuesten Stable-Release ab, sonst schieben
      // viele Nightlies ihn aus der ersten Seite. 404 heißt: Es gibt noch keinen.
      const stable = this.state.channel === 'stable'
      const url = `https://api.github.com/repos/${REPOSITORY}/releases${stable ? '/latest' : '?per_page=50'}`
      // Ohne Frist bliebe eine hängende Anfrage für immer in „checking“.
      const res = await net.fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(CHECK_TIMEOUT) })
      if (!res.ok && !(stable && res.status === 404)) throw new Error(`GitHub antwortet mit ${res.status}`)
      const releases: GithubRelease[] = !res.ok ? [] : stable ? [(await res.json()) as GithubRelease] : ((await res.json()) as GithubRelease[])
      this.candidate = pickUpdate(releases, this.state.currentVersion, process.arch)
      if (this.candidate) {
        log.info(`Update verfügbar: ${this.candidate.version}`)
        this.set({ status: 'available', availableVersion: this.candidate.version, releaseUrl: this.candidate.releaseUrl, lastChecked: Date.now() })
      } else {
        this.set({ status: 'up-to-date', availableVersion: null, releaseUrl: null, lastChecked: Date.now() })
      }
    } catch (err) {
      log.warn('Update-Prüfung fehlgeschlagen', (err as Error).message)
      this.set({ status: 'error', errorContext: 'check', message: `Prüfung fehlgeschlagen: ${(err as Error).message}`, lastChecked: Date.now() })
    }
    return this.state
  }

  async download(): Promise<void> {
    const c = this.candidate
    // Nur aus „verfügbar“ oder nach einem fehlgeschlagenen Download, nie während einer laufenden Prüfung.
    const retry = this.state.status === 'error' && this.state.errorContext === 'download'
    if (!c || (this.state.status !== 'available' && !retry)) return
    const blocked = this.installBlocker()
    if (blocked) {
      this.set({ status: 'error', errorContext: 'download', message: blocked })
      return
    }
    this.set({ status: 'downloading', downloadPercent: 0, errorContext: null, message: null })
    try {
      this.cleanup()
      const dir = mkdtempSync(join(app.getPath('temp'), WORKDIR_PREFIX))
      this.workdir = dir

      if (!c.checksums) throw new Error('Der Release enthält keine SHA256SUMS.txt')
      const sumsRes = await net.fetch(c.checksums.browser_download_url, { headers: { 'User-Agent': HEADERS['User-Agent'] }, signal: AbortSignal.timeout(CHECK_TIMEOUT) })
      if (!sumsRes.ok) throw new Error(`Prüfsummen nicht ladbar (${sumsRes.status})`)
      const sums = await sumsRes.text()

      // Erst das kleine Patch-ZIP mit den Frameworks der installierten App. Passen die nicht
      // mehr (neue Electron-Version), scheitert die Signaturprüfung und es kommt die volle ZIP.
      let staged: string | null = null
      if (c.patch) {
        try {
          staged = await this.stage(c.patch, sums, join(dir, 'patch'))
          await addFrameworks(currentBundlePath(), staged)
          await verifyBundle(staged)
        } catch (err) {
          log.info(`Patch-Update nicht nutzbar, lade die ganze App: ${(err as Error).message}`)
          // Klappt das Aufräumen nicht, räumt cleanup() bzw. das Install-Skript den Ordner später weg.
          try {
            rmSync(join(dir, 'patch'), { recursive: true, force: true })
          } catch {}
          staged = null
          this.set({ downloadPercent: 0 })
        }
      }
      if (!staged) {
        staged = await this.stage(c.zip, sums, join(dir, 'full'))
        await verifyBundle(staged)
      }

      this.stagedApp = staged
      log.info(`Update ${c.version} geladen und geprüft: ${staged}`)
      this.set({ status: 'downloaded', downloadedVersion: c.version, downloadPercent: 100 })
    } catch (err) {
      log.warn('Update-Download fehlgeschlagen', (err as Error).message)
      this.cleanup()
      this.set({ status: 'error', errorContext: 'download', downloadPercent: null, message: `Download fehlgeschlagen: ${(err as Error).message}` })
    }
  }

  // Lädt ein ZIP, gleicht es mit SHA256SUMS.txt ab, entpackt es und liefert den Pfad zum App-Bundle.
  private async stage(asset: GithubAsset, sums: string, into: string): Promise<string> {
    const expected = checksumFor(sums, asset.name)
    if (!expected) throw new Error(`Keine Prüfsumme für ${asset.name}`)
    mkdirSync(into)
    const zipPath = join(into, asset.name)
    const hash = await this.fetchToFile(asset.browser_download_url, zipPath, asset.size)
    if (expected !== hash) throw new Error('Prüfsumme stimmt nicht, Download verworfen')
    const extracted = join(into, 'app')
    await execFileAsync('/usr/bin/ditto', ['-x', '-k', zipPath, extracted])
    rmSync(zipPath, { force: true })
    const bundle = readdirSync(extracted).find((n) => n.endsWith('.app'))
    if (!bundle) throw new Error('Kein App-Bundle in der ZIP')
    return join(extracted, bundle)
  }

  install(): void {
    if (this.state.status === 'installing' || !this.stagedApp || !this.workdir) return
    const blocked = this.installBlocker()
    if (blocked) {
      this.set({ status: 'error', errorContext: 'install', message: blocked })
      return
    }
    const logFile = join(app.getPath('userData'), 'logs', 'update.log')
    log.info(`Installiere Update ${this.state.downloadedVersion}, Protokoll in ${logFile}`)
    const child = spawn('/bin/sh', ['-c', `{ : >>"$5"; } 2>/dev/null && exec >>"$5" 2>&1\n${INSTALL_SCRIPT}`, 'sh', String(process.pid), currentBundlePath(), this.stagedApp, this.workdir, logFile], {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    this.set({ status: 'installing' })
    this.quit()
  }

  // Liefert einen Grund, warum sich die App nicht selbst ersetzen kann.
  private installBlocker(): string | null {
    const bundle = currentBundlePath()
    if (bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) {
      return 'Verschiebe Teams Everywhere in den Ordner Programme und starte die App von dort, dann klappt das Update.'
    }
    try {
      accessSync(resolve(bundle, '..'), constants.W_OK)
      accessSync(bundle, constants.W_OK)
    } catch {
      return `Keine Schreibrechte für ${bundle}. Bitte die neue Version von GitHub laden und von Hand installieren.`
    }
    return null
  }

  private async fetchToFile(url: string, file: string, size: number): Promise<string> {
    // Kommen 60 s lang keine Daten, bricht der Download ab, statt ewig in „downloading“ zu hängen.
    const stall = new AbortController()
    let idle: ReturnType<typeof setTimeout> | undefined
    const alive = () => {
      clearTimeout(idle)
      idle = setTimeout(() => stall.abort(), DOWNLOAD_IDLE_TIMEOUT)
    }
    alive()
    try {
      return await this.fetchToFileWith(url, file, size, stall.signal, alive)
    } catch (err) {
      if (stall.signal.aborted) throw new Error(`seit ${DOWNLOAD_IDLE_TIMEOUT / 1000} s kommen keine Daten`)
      throw err
    } finally {
      clearTimeout(idle)
    }
  }

  private async fetchToFileWith(url: string, file: string, size: number, signal: AbortSignal, alive: () => void): Promise<string> {
    const res = await net.fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'] }, signal })
    if (!res.ok || !res.body) throw new Error(`Download antwortet mit ${res.status}`)
    const total = Number(res.headers.get('content-length')) || size
    const hash = createHash('sha256')
    let received = 0
    let lastPercent = 0
    const progress = (bytes: number) => {
      received += bytes
      const percent = total > 0 ? Math.min(99, Math.floor((received / total) * 100)) : 0
      if (percent !== lastPercent) {
        lastPercent = percent
        this.set({ downloadPercent: percent })
      }
    }
    // pipeline reicht Schreibfehler (z. B. volle Platte) als Ablehnung an download() weiter.
    await pipeline(
      Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          alive()
          hash.update(chunk)
          progress(chunk.byteLength)
          yield chunk
        }
      },
      createWriteStream(file),
      { signal }
    )
    return hash.digest('hex')
  }

  private cleanup(): void {
    if (this.workdir && existsSync(this.workdir)) rmSync(this.workdir, { recursive: true, force: true })
    this.workdir = null
    this.stagedApp = null
  }
}

// Downloads aus früheren Sitzungen, die nie installiert wurden.
function removeStaleDownloads(): void {
  const temp = app.getPath('temp')
  try {
    for (const name of readdirSync(temp)) {
      if (name.startsWith(WORKDIR_PREFIX)) rmSync(join(temp, name), { recursive: true, force: true })
    }
  } catch (err) {
    log.warn('Alte Update-Downloads nicht entfernt', (err as Error).message)
  }
}

// /Applications/Teams Everywhere.app/Contents/MacOS/Teams Everywhere -> /Applications/Teams Everywhere.app
function currentBundlePath(): string {
  return resolve(app.getPath('exe'), '../../..')
}

// Gleiche Bundle-ID und eine gültige Signatur über das ganze Bundle, auch die Frameworks.
async function verifyBundle(staged: string): Promise<void> {
  const [ownId, newId] = await Promise.all([bundleId(currentBundlePath()), bundleId(staged)])
  if (ownId !== newId) throw new Error(`Falsche App im Download (${newId})`)
  await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged])
}

// Kopiert die Electron-Frameworks der installierten App in ein Bundle aus dem Patch-ZIP.
async function addFrameworks(from: string, to: string): Promise<void> {
  const frameworks = join(from, 'Contents', 'Frameworks')
  for (const name of readdirSync(frameworks).filter((n) => n.endsWith('.framework'))) {
    await execFileAsync('/usr/bin/ditto', ['--norsrc', '--noextattr', '--noacl', join(frameworks, name), join(to, 'Contents', 'Frameworks', name)])
  }
}

async function bundleId(bundle: string): Promise<string> {
  const { stdout } = await execFileAsync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(bundle, 'Contents', 'Info.plist')])
  return stdout.trim()
}
