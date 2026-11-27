import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { legacyAppRunning, migrateLegacyUserData, renamedBundlePath } from '../src/main/legacy-data.ts'

let root: string
let legacy: string
let target: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'legacy-data-test-'))
  legacy = join(root, 'Teams Everywhere')
  target = join(root, 'Plenum')
  mkdirSync(legacy)
  writeFileSync(join(legacy, 'accounts.json'), '[]')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

// Eine PID, die sicher nicht läuft.
const DEAD_PID = 2 ** 22 + 12345

test('ohne laufende alte App zieht der Ordner um', () => {
  assert.equal(migrateLegacyUserData(legacy, target), 'migrated')
  assert.ok(existsSync(join(target, 'accounts.json')))
  assert.ok(!existsSync(legacy))
})

test('ein veralteter SingletonLock blockiert den Umzug nicht', () => {
  symlinkSync(`MacBookAir.fritz.box-${DEAD_PID}`, join(legacy, 'SingletonLock'))
  assert.equal(legacyAppRunning(legacy), false)
  assert.equal(migrateLegacyUserData(legacy, target), 'migrated')
})

test('läuft die alte App noch, bleibt der Ordner, wo er ist', () => {
  symlinkSync(`MacBookAir.fritz.box-${process.pid}`, join(legacy, 'SingletonLock'))
  assert.equal(legacyAppRunning(legacy), true)
  assert.equal(migrateLegacyUserData(legacy, target), 'legacy-running')
  assert.ok(existsSync(join(legacy, 'accounts.json')))
  assert.ok(!existsSync(target))
})

test('gibt es den neuen Ordner schon, passiert nichts', () => {
  mkdirSync(target)
  assert.equal(migrateLegacyUserData(legacy, target), 'none')
  assert.ok(existsSync(join(legacy, 'accounts.json')))
})

test('ein Bundle unter altem Namen bekommt den neuen, je Kanal', () => {
  assert.equal(renamedBundlePath(join(root, 'Teams Everywhere.app'), 'Plenum'), join(root, 'Plenum.app'))
  assert.equal(renamedBundlePath(join(root, 'Teams Everywhere (nightly).app'), 'Plenum (nightly)'), join(root, 'Plenum (nightly).app'))
  // Nach einem Wechsel von Nightly auf Stable heißt die App wie Stable
  assert.equal(renamedBundlePath(join(root, 'Teams Everywhere (nightly).app'), 'Plenum'), join(root, 'Plenum.app'))
})

test('neue und von Hand umbenannte Bundles bleiben, ein belegter Zielpfad auch', () => {
  assert.equal(renamedBundlePath(join(root, 'Plenum.app'), 'Plenum'), null)
  assert.equal(renamedBundlePath(join(root, 'Teams.app'), 'Plenum'), null)
  mkdirSync(join(root, 'Plenum.app'))
  assert.equal(renamedBundlePath(join(root, 'Teams Everywhere.app'), 'Plenum'), null)
})
