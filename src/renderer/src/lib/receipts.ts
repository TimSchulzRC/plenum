// Lesebestätigung für die eigene letzte Nachricht. Wer einen Lesestand (consumption horizon)
// auf oder hinter der Nachrichten-ID hat, hat sie gesehen.
export interface Receipt {
  seen: string[]
  unseen: string[]
  text: string
}

export function readReceipt(members: string[], horizons: Record<string, number>, messageId: string): Receipt {
  const id = Number(messageId)
  const seen = members.filter((m) => (horizons[m] ?? 0) >= id)
  const unseen = members.filter((m) => (horizons[m] ?? 0) < id)
  const text = seen.length === 0 ? 'Gesendet' : members.length === 1 || unseen.length === 0 ? 'Gesehen' : `Gesehen von ${seen.length}`
  return { seen, unseen, text }
}
