import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanCallName, matchPerson, nameQueries } from '../src/shared/call-names.ts'

test('Rollen und Hinweise aus dem aria-label verschwinden aus dem Namen', () => {
  assert.deepEqual(cleanCallName('Boettcher External unfamiliar, Has control of production tools, Context menu is available'), {
    name: 'Boettcher',
    external: true
  })
})

test('Namen im Format "Nachname, Vorname" bleiben ganz', () => {
  assert.deepEqual(cleanCallName('Schulz, Tim, Muted, video is on, Fill frame, Has context menu'), { name: 'Schulz, Tim', external: false })
  assert.deepEqual(cleanCallName('Myself video, Schulz, Tim, Unmuted'), { name: 'Schulz, Tim', external: false })
  assert.deepEqual(cleanCallName('Müller, Anna'), { name: 'Müller, Anna', external: false })
})

test('Externe Teilnehmer werden erkannt', () => {
  assert.deepEqual(cleanCallName('Anna Berg (External)'), { name: 'Anna Berg', external: true })
  assert.deepEqual(cleanCallName('Anna Berg, External, Muted'), { name: 'Anna Berg', external: true })
  assert.deepEqual(cleanCallName('Anna Berg, Gast'), { name: 'Anna Berg', external: true })
})

test('Externe Hinweise nach einem Zustand zählen auch', () => {
  assert.deepEqual(cleanCallName('Anna Berg, Muted, External'), { name: 'Anna Berg', external: true })
})

test('Nachnamen wie "Gast" bleiben erhalten', () => {
  assert.deepEqual(cleanCallName('Anna Gast'), { name: 'Anna Gast', external: false })
  assert.deepEqual(cleanCallName('Anna Gast (Gast)'), { name: 'Anna Gast', external: true })
})

test('Der Zusatz für Bildschirmfreigaben bleibt erhalten', () => {
  assert.deepEqual(cleanCallName('Boettcher External unfamiliar, Context menu is available (Bildschirm)'), { name: 'Boettcher (Bildschirm)', external: true })
})

test('Eigene Bezeichnungen der App bleiben unverändert', () => {
  for (const l of ['Du', 'Deine Bildschirmfreigabe', 'Teilnehmer 2', 'Teilnehmer']) assert.equal(cleanCallName(l).name, l)
})

test('Namen, die nur aus "External" bestehen, gehen nicht verloren', () => {
  assert.equal(cleanCallName('External').name, 'External')
})

test('Personen passen unabhängig von Reihenfolge, Komma und Akzenten', () => {
  const people = [
    { mri: '8:orgid:1', displayName: 'Tim Schulz' },
    { mri: '8:orgid:2', displayName: 'Schulz, Timo' }
  ]
  assert.equal(matchPerson('Schulz, Tim', people)?.mri, '8:orgid:1')
  assert.equal(matchPerson('Schulz, Timo', people)?.mri, '8:orgid:2')
  assert.equal(matchPerson('Schulz', people), undefined)
  assert.equal(
    matchPerson('Max Weber', [
      { mri: 'a', displayName: 'Max Weber' },
      { mri: 'b', displayName: 'Weber, Max' }
    ]),
    undefined,
    'gleichnamige Personen sind nicht eindeutig'
  )
  assert.equal(matchPerson('Max Weber', [{ mri: 'a', displayName: 'Max Weber' }, { mri: 'a', displayName: 'Max Weber' }])?.mri, 'a')
  assert.equal(matchPerson('Zoë Bauer', [{ mri: 'x', displayName: 'Bauer, Zoe' }])?.mri, 'x')
})

test('Externe passen nur zu Gastkonten', () => {
  const people = [
    { mri: 'int', displayName: 'Boettcher', upn: 'boettcher@firma.de' },
    { mri: 'gast', displayName: 'Anna Berg', upn: 'anna_extern.de#EXT#@firma.onmicrosoft.com' }
  ]
  assert.equal(matchPerson('Boettcher', people, true), undefined)
  assert.equal(matchPerson('Boettcher', people)?.mri, 'int')
  assert.equal(matchPerson('Anna Berg', people, true)?.mri, 'gast')
})

test('Suchanfragen probieren beide Namensreihenfolgen', () => {
  assert.deepEqual(nameQueries('Schulz, Tim'), ['Schulz, Tim', 'Tim Schulz'])
  assert.deepEqual(nameQueries('Tim Schulz'), ['Tim Schulz'])
})
