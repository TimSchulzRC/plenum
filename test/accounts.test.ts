import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountTitle, colorOrder, mergeByTime, orderAccounts } from '../src/shared/accounts.ts'

test('Gastmandanten stehen direkt unter ihrem Konto', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'a-g1', parentId: 'a' }, { id: 'b-g1', parentId: 'b' }, { id: 'a-g2', parentId: 'a' }]
  assert.deepEqual(
    orderAccounts(list).map((a) => a.id),
    ['a', 'a-g1', 'a-g2', 'b', 'b-g1']
  )
})

test('Mandant ohne vorhandenes Konto bleibt sichtbar', () => {
  assert.deepEqual(
    orderAccounts([{ id: 'x', parentId: 'weg' }, { id: 'a' }]).map((a) => a.id),
    ['x', 'a']
  )
})

test('Kopfzeile nennt Organisation, sonst Domain, sonst Namen', () => {
  assert.deepEqual(accountTitle({ id: 'a', label: 'Alex', upn: 'alex@contoso.com', tenantName: 'Contoso' }), { name: 'Contoso', sub: 'alex@contoso.com' })
  assert.deepEqual(accountTitle({ id: 'a', label: 'Alex', upn: 'alex@contoso.com' }), { name: 'contoso.com', sub: 'alex@contoso.com' })
  assert.deepEqual(accountTitle({ id: 'a', label: 'Neues Konto' }), { name: 'Neues Konto', sub: '' })
  assert.deepEqual(accountTitle({ id: 'g', label: 'Alex', tenantName: 'Fabrikam', parentId: 'a' }), { name: 'Fabrikam', sub: 'Gast' })
  assert.deepEqual(accountTitle({ id: 'g', label: 'Alex', upn: 'alex@contoso.com', tenantName: 'Fabrikam', parentId: 'a' }), { name: 'Fabrikam', sub: 'Gast · alex@contoso.com' })
})

test('Farben: erst die Konten wie in Mail und Kalender, dann die Gastmandanten', () => {
  const list = orderAccounts([{ id: 'a' }, { id: 'a-g1', parentId: 'a' }, { id: 'b' }, { id: 'b-g1', parentId: 'b' }])
  assert.deepEqual(colorOrder(list), ['a', 'b', 'a-g1', 'b-g1'])
})

test('Listen aller Konten: neueste zuerst, gleich alte in Kontenreihenfolge', () => {
  const merged = mergeByTime([
    { accountId: 'a', items: [{ id: 'a1', time: 30 }, { id: 'a2', time: 10 }] },
    { accountId: 'g', items: [] },
    { accountId: 'b', items: [{ id: 'b1', time: 40 }, { id: 'b2', time: 10 }, { id: 'b3', time: 5 }] }
  ])
  assert.deepEqual(
    merged.map((m) => `${m.accountId}:${m.item.id}`),
    ['b:b1', 'a:a1', 'a:a2', 'b:b2', 'b:b3']
  )
})
