import assert from 'node:assert/strict'
import { test } from 'node:test'
import { darkColor, darkCss } from '../src/renderer/src/lib/mail-dark.ts'

test('Dunkle Mail: Helligkeit umgekehrt, Farbton bleibt', () => {
  assert.equal(darkColor('#fff'), '#292929')
  assert.equal(darkColor('black'), '#dbdbdb')
  assert.equal(darkColor('windowtext'), '#dbdbdb')
  // Rot bleibt rot, Transparenz bleibt
  assert.equal(darkColor('#ff0000'), '#ee0000')
  assert.equal(darkColor('rgba(0, 0, 0, 0.5)'), 'rgba(219, 219, 219, 0.5)')
  assert.equal(darkColor('rgb(100% 100% 100%)'), '#292929')
  assert.equal(darkColor('transparent'), undefined)
  assert.equal(darkColor('#12'), undefined)
})

test('Dunkle Mail: blauer Link bleibt auf dunklem Grund lesbar', () => {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const link = darkColor('#0000ff')!
  assert.ok((lum(link) + 0.05) / (lum('#292929') + 0.05) >= 4.5, link)
})

test('Dunkle Mail: nur Werte umschreiben, keine Selektoren', () => {
  assert.equal(darkCss('color:black;background:#FFFFFF'), 'color:#dbdbdb;background:#292929')
  assert.equal(darkCss('.red, p.white:hover { color: red; border: 1px solid #000 }'), '.red, p.white:hover { color: #ee0000; border: 1px solid #dbdbdb }')
  assert.equal(darkCss('font-family:Calibri;color:windowtext'), 'font-family:Calibri;color:#dbdbdb')
  assert.equal(darkCss('background:url(cid:img001.png) white'), 'background:url(cid:img001.png) #292929')
  // Farbwörter in Adressen und Zeichenketten bleiben
  assert.equal(darkCss('background:url(https://x.example/white.png) white'), 'background:url(https://x.example/white.png) #292929')
  assert.equal(darkCss('background:url("/images/white.png");font-family:"Red Hat"'), 'background:url("/images/white.png");font-family:"Red Hat"')
})
