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
  private queue: { start: () => void; high: boolean }[] = []
  private max: number

  constructor(max: number) {
    this.max = max
  }

  run<T>(fn: () => Promise<T>, high = true): Promise<T> {
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
      else if (high) {
        // vor die erste wartende Hintergrundanfrage
        const i = this.queue.findIndex((q) => !q.high)
        this.queue.splice(i < 0 ? this.queue.length : i, 0, { start, high })
      } else this.queue.push({ start, high })
    })
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
}

// Bilder je Mail. Ein Bild steht bereit, sobald sein Anhang da ist, nicht erst, wenn alle da sind.
// Ein fehlgeschlagener Anhang (Drosselung, Netz) bleibt offen und wird beim nächsten Mal wieder versucht.
export class MailImageStore {
  private refs = new Map<string, InlineRef[]>()
  private got = new Map<string, Map<string, ImageEntry>>()
  private running = new Map<string, Promise<void>>()
  private waiters = new Map<string, Set<() => void>>()
  private bytes = 0
  private source: MailImageSource
  private maxBytes: number

  constructor(source: MailImageSource, maxBytes = 80 * 1024 * 1024) {
    this.source = source
    this.maxBytes = maxBytes
  }

  // getMail hat die Anhangsliste schon, dann fragt load() sie nicht noch einmal
  remember(messageId: string, refs: InlineRef[]): void {
    this.refs.delete(messageId)
    this.refs.set(messageId, refs)
    while (this.refs.size > 200) this.refs.delete(this.refs.keys().next().value as string)
  }

  // Alle noch fehlenden Bilder einer Mail laden
  load(messageId: string, high: boolean): Promise<void> {
    const cur = this.running.get(messageId)
    if (cur) return cur
    const p = (async () => {
      let refs = this.refs.get(messageId)
      if (!refs) {
        refs = await this.source.list(messageId, high)
        this.remember(messageId, refs)
      }
      const got = this.got.get(messageId) ?? new Map<string, ImageEntry>()
      this.got.set(messageId, got)
      await Promise.all(
        refs
          .filter((r) => !got.has(r.id))
          .map((r) =>
            this.source.fetch(messageId, r.id, high).then(
              (e) => {
                if (!e?.cid) return
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
      this.notify(messageId)
    })
    this.running.set(messageId, p)
    return p
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
      const check = () => {
        const e = this.find(messageId, cid)
        if (e || !this.running.has(messageId)) {
          set.delete(check)
          if (!set.size) this.waiters.delete(messageId)
          resolve(e)
        }
      }
      set.add(check)
      void done.then(check, check)
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
    }
  }
}
