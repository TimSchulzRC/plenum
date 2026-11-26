import assert from 'node:assert/strict'
import { test } from 'node:test'
import { darkColor, darkCss } from '../src/renderer/src/lib/mail-dark.ts'

test('Dunkle Mail: Helligkeit umgekehrt, Farbton bleibt', () => {
  assert.equal(darkColor('#fff'), '#292929')
  assert.equal(darkColor('black'), '#dbdbdb')
  assert.equal(darkColor('windowtext'), '#dbdbdb')
  // Rot bleibt rot, Transparenz bleibt
  assert.equal(darkColor('#ff0000'), '#ff0505')
  assert.equal(darkColor('rgba(0, 0, 0, 0.5)'), 'rgba(219, 219, 219, 0.5)')
  assert.equal(darkColor('rgb(100% 100% 100%)'), '#292929')
  assert.equal(darkColor('transparent'), undefined)
  assert.equal(darkColor('#12'), undefined)
})

test('Dunkle Mail: nur Werte umschreiben, keine Selektoren', () => {
  assert.equal(darkCss('color:black;background:#FFFFFF'), 'color:#dbdbdb;background:#292929')
  assert.equal(darkCss('.red, p.white:hover { color: red; border: 1px solid #000 }'), '.red, p.white:hover { color: #ff0505; border: 1px solid #dbdbdb }')
  assert.equal(darkCss('font-family:Calibri;color:windowtext'), 'font-family:Calibri;color:#dbdbdb')
  assert.equal(darkCss('background:url(cid:img001.png) white'), 'background:url(cid:img001.png) #292929')
})
