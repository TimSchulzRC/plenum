// Kleiner Cache für Daten, die beim Öffnen einer Ansicht geladen werden.
// load() teilt sich laufende Anfragen, prefetch() lädt nur, wenn nichts Frisches da ist.

interface Entry<T> {
  value: T
  at: number
}

export interface CacheOptions {
  maxEntries: number
  // So lange gilt ein Eintrag als frisch, prefetch() lädt ihn dann nicht neu
  freshMs: number
  now?: () => number
}

export class PrefetchCache<T> {
  private entries = new Map<string, Entry<T>>()
  private inflight = new Map<string, Promise<T>>()
  private now: () => number
  private opts: CacheOptions

  // Ohne Parameter-Properties, damit node --test die Datei direkt laden kann
  constructor(opts: CacheOptions) {
    this.opts = opts
    this.now = opts.now ?? Date.now
  }

  peek(key: string): T | undefined {
    return this.entries.get(key)?.value
  }

  isFresh(key: string): boolean {
    const e = this.entries.get(key)
    return !!e && this.now() - e.at < this.opts.freshMs
  }

  set(key: string, value: T): void {
    this.entries.delete(key)
    this.entries.set(key, { value, at: this.now() })
    while (this.entries.size > this.opts.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  // Gespeicherten Wert ändern, ohne ihn frischer zu machen (z. B. als gelesen markiert)
  update(key: string, fn: (value: T) => T): void {
    const e = this.entries.get(key)
    if (e) e.value = fn(e.value)
  }

  keys(): string[] {
    return [...this.entries.keys()]
  }

  // Daten behalten (für die sofortige Anzeige), aber beim nächsten Mal neu laden.
  // Eine laufende Anfrage zählt nicht mehr, weil sie den alten Stand liefern kann.
  markStale(key: string): void {
    const e = this.entries.get(key)
    if (e) e.at = -Infinity
    this.inflight.delete(key)
  }

  load(key: string, fetcher: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key)
    if (running) return running
    const p = fetcher().then(
      (value) => {
        // Nur der aktuelle Abruf darf schreiben, ein von markStale verworfener nicht
        if (this.inflight.get(key) === p) {
          this.inflight.delete(key)
          this.set(key, value)
        }
        return value
      },
      (err: unknown) => {
        if (this.inflight.get(key) === p) this.inflight.delete(key)
        throw err
      }
    )
    this.inflight.set(key, p)
    return p
  }

  prefetch(key: string, fetcher: () => Promise<T>): void {
    if (this.isFresh(key) || this.inflight.has(key)) return
    this.load(key, fetcher).catch(() => undefined)
  }
}

// Ruft fn erst auf, wenn der Zeiger delay ms auf dem Element bleibt.
// Ein Mausklick lädt sofort, weil zwischen mousedown und click schon Zeit vergeht.
export function hoverIntent(fn: () => void, delay: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  return {
    onMouseEnter: () => {
      cancel()
      timer = setTimeout(() => {
        timer = undefined
        fn()
      }, delay)
    },
    onMouseLeave: cancel,
    onMouseDown: (e?: { button?: number }) => {
      // Rechtsklick öffnet nur das Kontextmenü
      if (e?.button !== undefined && e.button !== 0) return
      cancel()
      fn()
    },
    cancel
  }
}
