// Merkt sich pro Chat, wo es mit älteren Nachrichten weitergeht.
// Schlüssel ist die Zeit der ältesten Nachricht einer Seite. Die Oberfläche fragt mit genau dieser
// Zeit nach (älteste angezeigte Nachricht). So setzt ein Neuladen der neuesten Seite den Cursor
// nicht mehr auf Seite 2 zurück, wenn schon weiter zurückgeblättert wurde.
const MAX_PER_CHAT = 50

export class OlderCursors {
  private byChat = new Map<string, Map<number, string>>()

  set(conversationId: string, oldest: number, link: string): void {
    let m = this.byChat.get(conversationId)
    if (!m) this.byChat.set(conversationId, (m = new Map()))
    m.delete(oldest)
    m.set(oldest, link)
    if (m.size > MAX_PER_CHAT) m.delete(m.keys().next().value!)
  }

  get(conversationId: string, before: number): string | undefined {
    return this.byChat.get(conversationId)?.get(before)
  }
}
