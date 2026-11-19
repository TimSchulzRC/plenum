// Angezeigte Systemmitteilungen. Ohne Electron-Abhängigkeit, damit `pnpm test` die Logik prüfen kann.
//
// Electron entfernt eine Mitteilung aus der Mitteilungszentrale, sobald das Notification-Objekt
// vom Garbage Collector eingesammelt wird. Diese Liste hält die Objekte deshalb fest, bis die
// Unterhaltung gelesen ist (dann verschwindet die Mitteilung wie in Teams) oder bis sie
// angeklickt oder geschlossen wurde.

export interface NotificationKey {
  accountId: string
  conversationId: string
  kind: 'chat' | 'channel' | 'activity'
  activityId?: string
}

interface Closable {
  close(): void
}

export class LiveNotifications<T extends Closable> {
  private live: { item: T; key: NotificationKey }[] = []
  private readonly max: number

  constructor(max = 50) {
    this.max = max
  }

  get size(): number {
    return this.live.length
  }

  add(item: T, key: NotificationKey): void {
    this.live.push({ item, key })
    // Die ältesten fallen heraus, damit die Liste nicht endlos wächst
    while (this.live.length > this.max) this.live.shift()?.item.close()
  }

  // Nach Klick oder Schließen: nur die Referenz loslassen
  forget(item: T): void {
    this.live = this.live.filter((l) => l.item !== item)
  }

  // Schließt die Mitteilungen, deren Unterhaltung nicht mehr ungelesen ist. Gibt die Anzahl zurück.
  closeRead(isUnread: (key: NotificationKey) => boolean): number {
    const keep: typeof this.live = []
    let closed = 0
    for (const l of this.live) {
      if (isUnread(l.key)) keep.push(l)
      else {
        l.item.close()
        closed++
      }
    }
    this.live = keep
    return closed
  }
}
