// Eingebettete Bilder (cid:) von Mails: laden, zwischenspeichern und an das Protokoll tmimg://mailcid
// ausliefern. Ohne Electron, damit die Tests die Datei direkt laden.

export interface InlineRef {
  id: string
  size: number
}

export interface ImageEntry {
  cid: string
  type: string
  data: Uint8Array
}

// Höchstens max Anfragen gleichzeitig je Postfach. Exchange drosselt schon bei sieben gleichzeitigen
// Anfragen je Postfach. Was der Nutzer geöffnet hat, kommt vor dem, was die App nur vorlädt.
export class Limiter {
  private active = 0
  private queue: { start: () => void; high: boolean; key?: string }[] = []
  private max: number

  constructor(max: number) {
    this.max = max
  }

  // key: wozu die Anfrage gehört (Mail), damit promote() sie nach vorn holen kann
  run<T>(fn: () => Promise<T>, high = true, key?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.active--
            this.queue.shift()?.start()
          })
      }
      if (this.active < this.max) start()
      else if (high) this.ahead({ start, high, key })
      else this.queue.push({ start, high, key })
    })
  }

  // vor die erste wartende Hintergrundanfrage
  private ahead(q: { start: () => void; high: boolean; key?: string }): void {
    const i = this.queue.findIndex((x) => !x.high)
    this.queue.splice(i < 0 ? this.queue.length : i, 0, q)
  }

  // Wartende Hintergrundanfragen zu key nach vorn: Der Nutzer hat die vorgeladene Mail geöffnet
  promote(key: string): void {
    const mine = this.queue.filter((q) => q.key === key && !q.high)
    if (!mine.length) return
    this.queue = this.queue.filter((q) => !mine.includes(q))
    for (const q of mine) this.ahead({ ...q, high: true })
  }
}

// Eingebettete Bilder, die die App lädt: Inline-Anhänge in ihrer Reihenfolge, höchstens 20 und
// zusammen höchstens 8 MB
export const INLINE_BUDGET = 8 * 1024 * 1024
export function inlineToLoad(attachments: { id: string; size: number; isInline: boolean }[]): InlineRef[] {
  const out: InlineRef[] = []
  let budget = INLINE_BUDGET
  for (const a of attachments) {
    if (!a.isInline || a.size > budget || out.length >= 20) continue
    out.push({ id: a.id, size: a.size })
    budget -= a.size
  }
  return out
}

export interface MailImageSource {
  // Inline-Anhänge einer Mail (wenn getMail sie noch nicht gemeldet hat)
  list: (messageId: string, high: boolean) => Promise<InlineRef[]>
  // Ein Anhang mit Content-ID und Daten, undefined ohne Daten (kein Bild, verlinkter Anhang)
  fetch: (messageId: string, attachmentId: string, high: boolean) => Promise<ImageEntry | undefined>
  // Wartende Hintergrundanfragen der Mail nach vorn holen
  promote?: (messageId: string) => void
}

// Bilder je Mail. Ein Bild steht bereit, sobald sein Anhang da ist, nicht erst, wenn alle da sind.
// Ein fehlgeschlagener Anhang (Drosselung, Netz) bleibt offen und wird beim nächsten Mal wieder versucht.
export class MailImageStore {
  private refs = new Map<string, InlineRef[]>()
  private got = new Map<string, Map<string, ImageEntry>>()
  // Anhänge ohne Bilddaten (kein Bild, verlinkter Anhang): nicht noch einmal holen
  private empty = new Map<string, Set<string>>()
  private running = new Map<string, Promise<void>>()
  // Mails, die der Nutzer geöffnet hat, während ihr Vorladen lief: alles Weitere mit Vorrang
  private urgent = new Set<string>()
  private waiters = new Map<string, Set<() => void>>()
  private bytes = 0
  private source: MailImageSource
  private maxBytes: number

  constructor(source: MailImageSource, maxBytes = 80 * 1024 * 1024) {
    this.source = source
    this.maxBytes = maxBytes
  }

  // getMail hat die Anhangsliste schon, dann fragt load() sie nicht noch einmal. Bilder von Anhängen,
  // die nicht mehr in der Mail sind (Entwurf geändert), fallen weg.
  remember(messageId: string, refs: InlineRef[]): void {
    this.refs.delete(messageId)
    this.refs.set(messageId, refs)
    const got = this.got.get(messageId)
    if (got) {
      const keep = new Set(refs.map((r) => r.id))
      for (const [id, e] of got) {
        if (keep.has(id)) continue
        got.delete(id)
        this.bytes -= e.data.byteLength
      }
    }
    this.trimRefs()
  }

  // Höchstens 200 Anhangslisten, älteste zuerst. Nie eine der 20 zuletzt gemerkten (die Mail, die
  // gleich geöffnet wird) und keine, die gerade lädt: Ihre Bilder gälten sonst als entfernt.
  // Überhang räumt das Ende eines Ladevorgangs ab.
  private trimRefs(): void {
    if (this.refs.size <= 200) return
    const keys = [...this.refs.keys()]
    const recent = new Set(keys.slice(-20))
    for (const id of keys) {
      if (this.refs.size <= 200) break
      if (recent.has(id) || this.running.has(id)) continue
      this.refs.delete(id)
    }
  }

  // Alle noch fehlenden Bilder einer Mail laden
  load(messageId: string, high: boolean): Promise<void> {
    const cur = this.running.get(messageId)
    if (cur) {
      // Vorgeladen und jetzt geöffnet: nicht mehr hinter anderen Mails warten, auch nicht mit den
      // Anfragen, die der laufende Vorgang erst noch stellt
      if (high) {
        this.urgent.add(messageId)
        this.source.promote?.(messageId)
      }
      // Hat sich die Anhangsliste inzwischen geändert (Entwurf) oder ist etwas fehlgeschlagen,
      // folgt noch ein Durchgang
      return cur.then(() => (this.missing(messageId) ? this.load(messageId, high) : undefined))
    }
    const p = (async () => {
      let refs = this.refs.get(messageId)
      if (!refs) {
        refs = await this.source.list(messageId, high)
        this.remember(messageId, refs)
      }
      const got = this.got.get(messageId) ?? new Map<string, ImageEntry>()
      this.got.set(messageId, got)
      const prio = high || this.urgent.has(messageId)
      await Promise.all(
        refs
          .filter((r) => !got.has(r.id) && !this.empty.get(messageId)?.has(r.id))
          .map((r) =>
            this.source.fetch(messageId, r.id, prio).then(
              (e) => {
                // Inzwischen nicht mehr in der Mail (Entwurf geändert): verwerfen
                if (!this.refs.get(messageId)?.some((x) => x.id === r.id)) return
                if (!e?.cid) {
                  const set = this.empty.get(messageId) ?? new Set<string>()
                  this.empty.set(messageId, set.add(r.id))
                  return
                }
                got.set(r.id, e)
                this.bytes += e.data.byteLength
                this.notify(messageId)
              },
              () => undefined
            )
          )
      )
      this.evict(messageId)
    })().finally(() => {
      this.running.delete(messageId)
      this.urgent.delete(messageId)
      this.trimRefs()
      this.notify(messageId)
    })
    this.running.set(messageId, p)
    return p
  }

  // Fehlt noch ein Bild, das zu holen ist (neue Anhänge, fehlgeschlagene Anfragen)
  private missing(messageId: string): boolean {
    const got = this.got.get(messageId)
    const empty = this.empty.get(messageId)
    return (this.refs.get(messageId) ?? []).some((r) => !got?.has(r.id) && !empty?.has(r.id))
  }

  private find(messageId: string, cid: string): ImageEntry | undefined {
    for (const e of this.got.get(messageId)?.values() ?? []) if (e.cid === cid) return e
    return undefined
  }

  private notify(messageId: string): void {
    for (const w of this.waiters.get(messageId) ?? []) w()
  }

  // Ein Bild nach Content-ID, sobald es da ist. undefined, wenn die Mail es nicht hat.
  async image(messageId: string, cid: string): Promise<ImageEntry | undefined> {
    const hit = this.find(messageId, cid)
    if (hit) return hit
    const done = this.load(messageId, true)
    return new Promise<ImageEntry | undefined>((resolve) => {
      const set = this.waiters.get(messageId) ?? new Set()
      this.waiters.set(messageId, set)
      // Gefunden: sofort. Nicht gefunden erst, wenn der ganze Ladevorgang durch ist, auch ein
      // zweiter Durchgang nach einer geänderten Anhangsliste
      const finish = (e: ImageEntry | undefined) => {
        // Schon erledigt: nichts anfassen, die Liste kann inzwischen einem anderen Leser gehören
        if (!set.delete(check)) return
        if (!set.size && this.waiters.get(messageId) === set) this.waiters.delete(messageId)
        resolve(e)
      }
      const check = () => {
        const e = this.find(messageId, cid)
        if (e) finish(e)
      }
      set.add(check)
      const end = () => finish(this.find(messageId, cid))
      void done.then(end, end)
    })
  }

  // Anhang-ID → Content-ID aller geladenen Bilder, nach dem Laden
  async index(messageId: string): Promise<Record<string, string>> {
    await this.load(messageId, true)
    return Object.fromEntries([...(this.got.get(messageId) ?? new Map<string, ImageEntry>())].map(([id, e]) => [id, e.cid]))
  }

  // Alle Bilder einer Mail als Einträge (für die eigene Signatur)
  async all(messageId: string): Promise<[string, ImageEntry][]> {
    await this.load(messageId, true)
    return [...(this.got.get(messageId) ?? new Map<string, ImageEntry>())]
  }

  // Älteste Mails zuerst verwerfen, die gerade geladene bleibt
  private evict(keep: string): void {
    for (const [id, got] of this.got) {
      if (this.bytes <= this.maxBytes) break
      if (id === keep || this.running.has(id)) continue
      for (const e of got.values()) this.bytes -= e.data.byteLength
      this.got.delete(id)
      this.empty.delete(id)
    }
  }
}
