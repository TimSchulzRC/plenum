import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appVariant, dataName, displayName } from '../src/main/variant.ts'

test('nicht gepackt ist immer dev, gepackt zählt der Kanal', () => {
  assert.equal(appVariant(false, '0.1.0'), 'dev')
  assert.equal(appVariant(false, '0.1.1-nightly.20261118.7'), 'dev')
  assert.equal(appVariant(true, '0.1.0'), 'stable')
  assert.equal(appVariant(true, '0.1.1-nightly.20261118.7'), 'nightly')
})

test('PR-Builds sind dev und haben dieselben Daten wie pnpm run dev', () => {
  assert.equal(appVariant(true, '0.1.0-dev.pr31.12'), 'dev')
  assert.equal(dataName(appVariant(true, '0.1.0-dev.pr31.12')), dataName(appVariant(false, '0.1.0')))
})

test('Nightly und Dev tragen den Kanal im Namen', () => {
  assert.equal(displayName('stable'), 'Teams Everywhere')
  assert.equal(displayName('nightly'), 'Teams Everywhere (nightly)')
  assert.equal(displayName('dev'), 'Teams Everywhere (dev)')
})

test('nur Dev hat eigene Daten, Stable und Nightly teilen sie', () => {
  assert.equal(dataName('stable'), 'Teams Everywhere')
  assert.equal(dataName('nightly'), 'Teams Everywhere')
  assert.equal(dataName('dev'), 'Teams Everywhere (dev)')
})
