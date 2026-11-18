// Versionsvergleich und Auswahl des passenden GitHub-Releases für den Updater.
// Ohne Electron-Abhängigkeiten, damit `npm test` die Logik direkt prüfen kann.

export type UpdateChannel = 'nightly' | 'stable'

export interface GithubAsset {
  name: string
  browser_download_url: string
  size: number
}

export interface GithubRelease {
  tag_name: string
  html_url: string
  draft: boolean
  prerelease: boolean
  assets: GithubAsset[]
}

export interface UpdateCandidate {
  version: string
  releaseUrl: string
  zip: GithubAsset
  // App ohne Electron-Frameworks. Der Updater ergänzt sie aus der installierten App.
  patch: GithubAsset | null
  checksums: GithubAsset | null
}

interface ParsedVersion {
  core: [number, number, number]
  pre: string[]
}

function parseVersion(raw: string): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim())
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

export function isValidVersion(raw: string): boolean {
  return parseVersion(raw) !== null
}

// Vergleich nach SemVer 2.0: 0.1.0-nightly.20261118.4 < 0.1.0-nightly.20261118.12 < 0.1.0 < 0.1.1-nightly.20261119.1
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa) throw new Error(`Ungültige Version: ${a}`)
  if (!pb) throw new Error(`Ungültige Version: ${b}`)
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) {
    if (pa.pre.length === pb.pre.length) return 0
    return pa.pre.length === 0 ? 1 : -1
  }
  const n = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

// Nightly-Installationen bekommen Nightlies und Stable-Releases, Stable-Installationen nur Stable-Releases.
export function channelOf(version: string): UpdateChannel {
  return /-nightly\./.test(version) ? 'nightly' : 'stable'
}

export function zipAssetName(version: string, arch: string): string {
  return `Teams-Everywhere-${version}-mac-${arch}.zip`
}

export function patchAssetName(version: string, arch: string): string {
  return `Teams-Everywhere-${version}-mac-${arch}-patch.zip`
}

export function pickUpdate(releases: GithubRelease[], currentVersion: string, arch: string): UpdateCandidate | null {
  const channel = channelOf(currentVersion)
  let best: UpdateCandidate | null = null
  for (const r of releases) {
    if (r.draft) continue
    const version = r.tag_name.replace(/^v/, '')
    if (!isValidVersion(version)) continue
    if (channelOf(version) === 'nightly' ? channel !== 'nightly' : r.prerelease) continue
    if (compareVersions(version, currentVersion) <= 0) continue
    if (best && compareVersions(version, best.version) <= 0) continue
    const zip = r.assets.find((a) => a.name === zipAssetName(version, arch))
    if (!zip) continue
    const patch = r.assets.find((a) => a.name === patchAssetName(version, arch)) ?? null
    best = { version, releaseUrl: r.html_url, zip, patch, checksums: r.assets.find((a) => a.name === 'SHA256SUMS.txt') ?? null }
  }
  return best
}

// Liest die erwartete Prüfsumme einer Datei aus SHA256SUMS.txt (Format von `shasum -a 256`).
export function checksumFor(sums: string, fileName: string): string | null {
  for (const line of sums.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (m && m[2] === fileName) return m[1].toLowerCase()
  }
  return null
}
