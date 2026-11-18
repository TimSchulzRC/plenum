import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appVariant, dataName, displayName } from '../src/main/variant.ts'

test('nicht gepackt ist immer dev, gepackt zählt der Kanal', () => {
  assert.equal(appVariant(false, 'stable'), 'dev')
  assert.equal(appVariant(false, 'nightly'), 'dev')
  assert.equal(appVariant(true, 'stable'), 'stable')
  assert.equal(appVariant(true, 'nightly'), 'nightly')
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
