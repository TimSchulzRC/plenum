// Konten und Gastmandanten in der Chatliste. Ein Gastmandant läuft als eigenes Konto
// mit parentId, angemeldet über das Konto, zu dem er gehört.
import type { AccountInfo } from './types'

type Named = Pick<AccountInfo, 'id' | 'label' | 'upn' | 'tenantName' | 'parentId'>

// Unterkonten (Gastmandanten) direkt unter ihr Konto, sonst bleibt die Reihenfolge
export function orderAccounts<T extends Pick<AccountInfo, 'id' | 'parentId'>>(accounts: T[]): T[] {
  const top = accounts.filter((a) => !a.parentId || !accounts.some((p) => p.id === a.parentId))
  return top.flatMap((a) => [a, ...accounts.filter((c) => c.parentId === a.id && c !== a)])
}

// Kopf eines Blocks: Organisation vorn, damit zwei Konten derselben Person unterscheidbar sind
export function accountTitle(a: Named): { name: string; sub: string } {
  if (a.parentId) return { name: a.tenantName || 'Mandant', sub: 'Gast' }
  const domain = a.upn?.split('@')[1]
  return { name: a.tenantName || domain || a.label, sub: a.upn || '' }
}
