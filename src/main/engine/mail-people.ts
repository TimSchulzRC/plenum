// Mails nennen Absender und Empfänger nur mit Adresse. Profilbilder gibt es bei Teams aber nur zur
// MRI. Dieses Verzeichnis findet die MRI zu einer Adresse, sammelt dafür die Anfragen einer Liste
// in einem Abruf und merkt sich Treffer und Fehlschläge, damit nicht jedes Rendern neu fragt.
// Ohne Electron-Abhängigkeit, damit die Tests die Datei direkt laden.

// Adresse (klein geschrieben) → MRI. Fehlt eine Adresse in der Antwort, kennt Teams sie nicht.
export type AddressLookup = (addresses: string[]) => Promise<Map<string, string>>

// Externe Absender kennt Teams meist nicht. Nach sechs Stunden fragen wir noch einmal nach,
// falls jemand inzwischen im Mandanten ist.
const MISS_TTL = 6 * 3600_000
// Scheitert der Abruf (Drosselung, Netz), eine Minute lang gar nicht fragen
const PAUSE = 60_000
const BATCH = 50
const WAIT = 40

export class MailDirectory {
  private known = new Map<string, { mri?: string; at: number }>()
  private queue = new Map<string, ((mri: string | undefined) => void)[]>()
  private timer?: ReturnType<typeof setTimeout>
  private running = false
  private pausedUntil = 0
  private readonly lookup: AddressLookup
  private readonly now: () => number

  constructor(lookup: AddressLookup, now: () => number = Date.now) {
    this.lookup = lookup
    this.now = now
  }

  resolve(address: string): Promise<string | undefined> {
    const a = address.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+$/.test(a)) return Promise.resolve(undefined)
    const k = this.known.get(a)
    if (k && (k.mri || this.now() - k.at < MISS_TTL)) return Promise.resolve(k.mri)
    if (this.now() < this.pausedUntil) return Promise.resolve(undefined)
    return new Promise((done) => {
      const waiting = this.queue.get(a)
      if (waiting) waiting.push(done)
      else this.queue.set(a, [done])
      this.schedule()
    })
  }

  // Vor dem Abruf kurz warten, damit alle Zeilen einer Liste in einer Anfrage landen
  private schedule(): void {
    if (this.timer || this.running) return
    this.timer = setTimeout(() => void this.flush(), WAIT)
  }

  private async flush(): Promise<void> {
    this.timer = undefined
    this.running = true
    while (this.queue.size) {
      const batch = [...this.queue.keys()].slice(0, BATCH)
      const waiting = batch.map((a) => [a, this.queue.get(a) ?? []] as const)
      for (const a of batch) this.queue.delete(a)
      let found: Map<string, string> | undefined
      try {
        found = await this.lookup(batch)
      } catch {
        this.pausedUntil = this.now() + PAUSE
      }
      for (const [a, list] of waiting) {
        const mri = found?.get(a)
        if (found) this.known.set(a, { mri, at: this.now() })
        for (const done of list) done(mri)
      }
      if (!found) {
        for (const list of this.queue.values()) for (const done of list) done(undefined)
        this.queue.clear()
      }
    }
    this.running = false
  }
}

// Personen (aus Chats oder fetchShortProfile) den gesuchten Adressen zuordnen, über Mail und UPN
export function mailMatches(list: string[], people: ({ mri?: string; email?: string; upn?: string; userPrincipalName?: string } | undefined)[]): Map<string, string> {
  const want = new Set(list)
  const found = new Map<string, string>()
  for (const p of people) {
    if (!p?.mri?.startsWith('8:')) continue
    for (const k of [p.email, p.upn, p.userPrincipalName]) {
      const a = k?.toLowerCase()
      if (a && want.has(a) && !found.has(a)) found.set(a, p.mri)
    }
  }
  return found
}
