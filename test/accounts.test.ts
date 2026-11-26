import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountTitle, orderAccounts } from '../src/shared/accounts.ts'

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
