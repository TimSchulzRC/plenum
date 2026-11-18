import assert from 'node:assert/strict'
import { test } from 'node:test'
import { channelOf, checksumFor, compareVersions, pickUpdate, type GithubRelease } from '../src/main/update/releases.ts'

function release(tag: string, opts: { prerelease?: boolean; draft?: boolean; arches?: string[]; patch?: boolean } = {}): GithubRelease {
  const version = tag.replace(/^v/, '')
  return {
    tag_name: tag,
    html_url: `https://github.com/TimSchulzRC/teams-everywhere/releases/tag/${tag}`,
    draft: opts.draft ?? false,
    prerelease: opts.prerelease ?? version.includes('-'),
    assets: [
      ...(opts.arches ?? ['arm64', 'x64']).map((arch) => ({
        name: `Teams-Everywhere-${version}-mac-${arch}.zip`,
        browser_download_url: `https://example.invalid/${version}-${arch}.zip`,
        size: 1
      })),
      ...(opts.patch ? (opts.arches ?? ['arm64', 'x64']) : []).map((arch) => ({
        name: `Teams-Everywhere-${version}-mac-${arch}-patch.zip`,
        browser_download_url: `https://example.invalid/${version}-${arch}-patch.zip`,
        size: 1
      })),
      { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.invalid/sums', size: 1 }
    ]
  }
}

test('compareVersions sortiert Nightlies und Stable-Releases nach SemVer', () => {
  const sorted = [
    '0.1.1-nightly.20261119.1',
    '0.1.0',
    '0.1.0-nightly.20261118.12',
    '0.1.0-nightly.20261118.4',
    '0.2.0',
    '0.1.0-nightly.20261119.2'
  ].sort(compareVersions)
  assert.deepEqual(sorted, [
    '0.1.0-nightly.20261118.4',
    '0.1.0-nightly.20261118.12',
    '0.1.0-nightly.20261119.2',
    '0.1.0',
    '0.1.1-nightly.20261119.1',
    '0.2.0'
  ])
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0)
})

test('channelOf erkennt den Kanal an der Version', () => {
  assert.equal(channelOf('0.1.0-nightly.20261118.1'), 'nightly')
  assert.equal(channelOf('0.1.0'), 'stable')
})

test('Nightly-Installation bekommt den neuesten Nightly', () => {
  const releases = [release('v0.1.0-nightly.20261118.1'), release('v0.1.0-nightly.20261119.3'), release('v0.1.0-nightly.20261119.2')]
  const c = pickUpdate(releases, '0.1.0-nightly.20261118.1', 'arm64')
  assert.equal(c?.version, '0.1.0-nightly.20261119.3')
  assert.equal(c?.zip.name, 'Teams-Everywhere-0.1.0-nightly.20261119.3-mac-arm64.zip')
  assert.equal(c?.checksums?.name, 'SHA256SUMS.txt')
})

test('Nightly-Installation wechselt auf einen neueren Stable-Release', () => {
  const c = pickUpdate([release('v0.1.0'), release('v0.1.0-nightly.20261119.3')], '0.1.0-nightly.20261119.3', 'x64')
  assert.equal(c?.version, '0.1.0')
})

test('Stable-Installation ignoriert Nightlies', () => {
  const releases = [release('v0.1.1-nightly.20261120.9'), release('v0.1.0')]
  assert.equal(pickUpdate(releases, '0.1.0', 'arm64'), null)
  assert.equal(pickUpdate([...releases, release('v0.1.1')], '0.1.0', 'arm64')?.version, '0.1.1')
})

test('ohne ZIP für die eigene Architektur, als Entwurf oder bei gleicher Version gibt es kein Update', () => {
  assert.equal(pickUpdate([release('v0.1.0-nightly.20261119.3', { arches: ['x64'] })], '0.1.0-nightly.20261118.1', 'arm64'), null)
  assert.equal(pickUpdate([release('v0.1.0-nightly.20261119.3', { draft: true })], '0.1.0-nightly.20261118.1', 'arm64'), null)
  assert.equal(pickUpdate([release('v0.1.0-nightly.20261118.1')], '0.1.0-nightly.20261118.1', 'arm64'), null)
})

test('Patch-ZIP wird mitgeliefert, wenn der Release eines für die eigene Architektur hat', () => {
  const withPatch = pickUpdate([release('v0.1.0-nightly.20261119.3', { patch: true })], '0.1.0-nightly.20261118.1', 'arm64')
  assert.equal(withPatch?.patch?.name, 'Teams-Everywhere-0.1.0-nightly.20261119.3-mac-arm64-patch.zip')
  assert.equal(withPatch?.zip.name, 'Teams-Everywhere-0.1.0-nightly.20261119.3-mac-arm64.zip')
  assert.equal(pickUpdate([release('v0.1.0-nightly.20261119.3')], '0.1.0-nightly.20261118.1', 'arm64')?.patch, null)
})

test('Tags, die keine Version sind, werden übersprungen', () => {
  assert.equal(pickUpdate([{ ...release('v0.1.0-nightly.20261119.3'), tag_name: 'update-feed' }], '0.1.0-nightly.20261118.1', 'arm64'), null)
})

test('checksumFor liest SHA256SUMS.txt', () => {
  const hash = 'a'.repeat(64)
  const sums = `${'b'.repeat(64)}  Teams-Everywhere-1.0.0-mac-x64.zip\n${hash}  Teams-Everywhere-1.0.0-mac-arm64.zip\n`
  assert.equal(checksumFor(sums, 'Teams-Everywhere-1.0.0-mac-arm64.zip'), hash)
  assert.equal(checksumFor(sums, 'fehlt.zip'), null)
})
