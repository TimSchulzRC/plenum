import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'

// Ohne Electron-Abhängigkeit, damit die Tests den Ablauf mit Fake-Helfern prüfen können
export interface SignatureModelOptions {
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void }
  platform?: string
  helloTimeout?: number
  // Zeitlimit je Anfrage: base + perPart je Teil
  base?: number
  perPart?: number
}

export interface ModelPart {
  // Nummer der ersten übergebenen Zeile (1-basiert), damit das Modell die Zeilen des Teils zählt
  first: number
  lines: string[]
}

type Pending = { resolve: (starts: (number | null)[] | null) => void; timer: NodeJS.Timeout; proc: ChildProcessWithoutNullStreams }

// Hilfsprozess native/mail-signatures (Apple Foundation Models). Startet beim ersten Bedarf und
// bleibt dann geladen: Die erste Antwort dauert sonst rund drei Sekunden, die nächsten unter einer.
// Fehlt er, ist das Modell nicht verfügbar oder stürzt er mehrfach ab, liefert find() null und die
// Oberfläche bleibt bei den Regeln.
export class SignatureModel {
  private proc?: ChildProcessWithoutNullStreams
  private hello?: Promise<boolean>
  private pending = new Map<string, Pending>()
  private queue: Promise<unknown> = Promise.resolve()
  private seq = 0
  private crashes = 0
  // Kein Apple Intelligence auf diesem Mac: für die ganze Sitzung bei den Regeln bleiben
  private unavailable = false
  private retired = new WeakSet<ChildProcessWithoutNullStreams>()

  private readonly bin: string
  private readonly opts: SignatureModelOptions
  private readonly log: SignatureModelOptions['log']

  constructor(bin: string, opts: SignatureModelOptions) {
    this.bin = bin
    this.opts = opts
    this.log = opts.log
  }

  // Hängender oder kaputter Helfer: beenden und als Fehlschlag zählen. Die nächste Anfrage startet
  // einen neuen, nach drei Fehlschlägen bleibt es für die Sitzung bei den Regeln. Offene Anfragen
  // beantwortet der exit-Handler mit null.
  private retire(proc: ChildProcessWithoutNullStreams, why: string): void {
    if (this.proc !== proc) return
    this.log.warn(`[signatures] Helfer beendet: ${why}`)
    this.crashes++
    // Sofort austragen: Eine schon wartende Anfrage startet einen neuen Helfer, statt in den
    // sterbenden zu schreiben
    this.proc = undefined
    this.hello = undefined
    this.retired.add(proc)
    proc.kill()
  }

  private start(): Promise<boolean> {
    if (this.hello) return this.hello
    if ((this.opts.platform ?? process.platform) !== 'darwin' || this.unavailable || !existsSync(this.bin) || this.crashes >= 3) return Promise.resolve(false)
    this.hello = new Promise<boolean>((resolve) => {
      let proc: ChildProcessWithoutNullStreams
      try {
        proc = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (e) {
        this.log.warn('[signatures] Helfer startet nicht', (e as Error).message)
        this.crashes = 3
        resolve(false)
        return
      }
      this.proc = proc
      const timer = setTimeout(() => {
        this.retire(proc, 'keine Startmeldung')
        resolve(false)
      }, this.opts.helloTimeout ?? 15_000)
      // Schreiben in einen gerade beendeten Helfer (EPIPE) darf den Hauptprozess nicht beenden
      proc.stdin.on('error', (e) => this.retire(proc, e.message))
      createInterface({ input: proc.stdout }).on('line', (line) => {
        let msg: { ready?: boolean; available?: boolean; reason?: string; id?: string; starts?: (number | null)[] | null }
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if (msg.ready) {
          clearTimeout(timer)
          if (!msg.available) {
            this.log.info(`[signatures] Modell nicht verfügbar: ${msg.reason ?? 'unbekannt'}`)
            this.unavailable = true
            proc.kill()
          }
          resolve(!!msg.available)
          return
        }
        const p = msg.id ? this.pending.get(msg.id) : undefined
        if (!p) return
        clearTimeout(p.timer)
        this.pending.delete(msg.id!)
        p.resolve(Array.isArray(msg.starts) ? msg.starts : null)
      })
      proc.stderr.on('data', (d) => this.log.warn('[signatures]', String(d).slice(0, 300)))
      // Aufräumen genau einmal: nach exit, close oder einem Startfehler (EACCES, ENOENT), bei dem
      // Node nur error und close meldet
      let done = false
      const finish = (failed: boolean) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(false)
        // Schon in retire() gezählt und ausgetragen? Dann gehört this.proc einem neuen Helfer.
        if (failed && !this.retired.has(proc)) this.crashes++
        if (this.proc === proc) {
          this.proc = undefined
          this.hello = undefined
        }
        for (const [id, p] of this.pending) {
          if (p.proc !== proc) continue
          clearTimeout(p.timer)
          this.pending.delete(id)
          p.resolve(null)
        }
      }
      proc.on('error', (e: NodeJS.ErrnoException) => {
        this.log.warn('[signatures] Helfer', e.message)
        // Lässt sich gar nicht starten (fehlt, nicht ausführbar, falsche Architektur auf Intel-Macs):
        // für die Sitzung bei den Regeln bleiben
        if (!proc.pid) this.unavailable = true
        finish(true)
      })
      proc.on('exit', (code) => finish(!!code))
      proc.on('close', (code) => finish(!!code))
    })
    return this.hello
  }

  // Erste Signaturzeile je Teil (wie first gezählt) oder null je Teil; null insgesamt, wenn das Modell fehlt
  find(parts: ModelPart[]): Promise<(number | null)[] | null> {
    const run = async () => {
      if (!parts.length || !(await this.start()) || !this.proc) return null
      const proc = this.proc
      const id = String(++this.seq)
      return new Promise<(number | null)[] | null>((resolve) => {
        // Je Teil unter einer Sekunde, dazu Reserve für das erste Laden
        const timer = setTimeout(() => {
          this.pending.delete(id)
          this.retire(proc, 'Zeitüberschreitung')
          resolve(null)
        }, (this.opts.base ?? 8_000) + parts.length * (this.opts.perPart ?? 4_000))
        this.pending.set(id, { resolve, timer, proc })
        proc.stdin.write(JSON.stringify({ id, parts }) + '\n')
      })
    }
    // Eine Anfrage nach der anderen: Der Helfer liest zeilenweise
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  available(): Promise<boolean> {
    return this.start()
  }

  stop(): void {
    this.proc?.kill()
  }
}
