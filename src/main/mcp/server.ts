// Lokaler MCP-Server über HTTP (Streamable HTTP, Antworten als JSON, ohne SSE).
// Lauscht nur auf 127.0.0.1. Zugang nur mit dem geheimen Schlüssel, im Pfad (/mcp/<schlüssel>)
// oder als „Authorization: Bearer <schlüssel>“ auf /mcp.
// Ohne Electron-Abhängigkeiten, damit `pnpm test` den Server direkt starten kann.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { McpInfo } from '@shared/mcp'
import type { McpProtocol } from './protocol'

export interface McpConfig {
  enabled: boolean
  port: number
  token: string
}

const MAX_BODY = 4 * 1024 * 1024

function newToken(): string {
  return randomBytes(24).toString('hex')
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export interface McpServerOptions {
  // mcp.json im Datenordner
  file: string
  defaultPort: number
  name: string
  protocol: McpProtocol
  onChange?: (info: McpInfo) => void
  log?: (level: 'info' | 'warn', msg: string) => void
}

export class McpServer {
  private config: McpConfig
  private server?: Server
  private port?: number
  private error?: string

  private readonly opts: McpServerOptions

  constructor(opts: McpServerOptions) {
    this.opts = opts
    this.config = this.load()
  }

  private load(): McpConfig {
    let raw: Partial<McpConfig> = {}
    try {
      raw = JSON.parse(readFileSync(this.opts.file, 'utf8'))
    } catch {
      /* noch keine Datei */
    }
    const cfg: McpConfig = {
      enabled: raw.enabled === true,
      port: Number.isInteger(raw.port) && raw.port! > 0 && raw.port! < 65536 ? raw.port! : this.opts.defaultPort,
      token: typeof raw.token === 'string' && /^[0-9a-f]{32,}$/.test(raw.token) ? raw.token : newToken()
    }
    if (cfg.token !== raw.token || cfg.port !== raw.port) this.save(cfg)
    return cfg
  }

  private save(cfg: McpConfig): void {
    try {
      mkdirSync(dirname(this.opts.file), { recursive: true })
      writeFileSync(this.opts.file, JSON.stringify(cfg, null, 2), { mode: 0o600 })
    } catch (e) {
      this.opts.log?.('warn', `[mcp] Konfiguration nicht gespeichert: ${(e as Error).message}`)
    }
  }

  info(): McpInfo {
    const port = this.port ?? this.config.port
    return {
      enabled: this.config.enabled,
      running: !!this.server && this.port !== undefined,
      name: this.opts.name,
      url: this.config.enabled ? `http://127.0.0.1:${port}/mcp/${this.config.token}` : undefined,
      error: this.error
    }
  }

  private changed(): void {
    this.opts.onChange?.(this.info())
  }

  // Start und Stopp laufen nacheinander, auch wenn der Schalter schnell hin und her geht
  private queue: Promise<void> = Promise.resolve()
  private serial(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn, fn)
    return this.queue
  }

  start(): Promise<void> {
    return this.serial(() => this.doStart())
  }

  stop(): Promise<void> {
    return this.serial(() => this.doStop())
  }

  private async doStart(): Promise<void> {
    if (!this.config.enabled || this.server) return
    this.error = undefined
    try {
      await this.listen(this.config.port)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EADDRINUSE') {
        this.error = (e as Error).message
      } else {
        // Port belegt: freien Port nehmen und merken. Die Adresse ändert sich, die Einstellungen zeigen sie neu.
        this.opts.log?.('warn', `[mcp] Port ${this.config.port} belegt, nehme einen freien`)
        try {
          await this.listen(0)
          this.config = { ...this.config, port: this.port! }
          this.save(this.config)
        } catch (e2) {
          this.error = (e2 as Error).message
        }
      }
    }
    if (this.port) this.opts.log?.('info', `[mcp] lauscht auf 127.0.0.1:${this.port}`)
    this.changed()
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = createServer((req, res) => void this.onRequest(req, res))
      srv.once('error', reject)
      srv.listen(port, '127.0.0.1', () => {
        srv.off('error', reject)
        srv.on('error', (e) => this.opts.log?.('warn', `[mcp] ${e.message}`))
        this.server = srv
        const addr = srv.address()
        this.port = typeof addr === 'object' && addr ? addr.port : port
        resolve()
      })
    })
  }

  private async doStop(): Promise<void> {
    const srv = this.server
    this.server = undefined
    this.port = undefined
    if (srv) {
      // Offene Verbindungen (Keep-alive der Clients) sofort trennen, sonst wartet close() auf sie
      const closed = new Promise<void>((r) => srv.close(() => r()))
      srv.closeAllConnections()
      await closed
    }
  }

  async setEnabled(on: boolean): Promise<McpInfo> {
    this.config = { ...this.config, enabled: on }
    this.save(this.config)
    if (on) await this.start()
    else {
      await this.stop()
      this.error = undefined
      this.changed()
    }
    return this.info()
  }

  // Neuer Schlüssel: alte Einträge in Claude Code und Codex funktionieren danach nicht mehr.
  async resetToken(): Promise<McpInfo> {
    this.config = { ...this.config, token: newToken() }
    this.save(this.config)
    this.changed()
    return this.info()
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      if (res.headersSent) return
      const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
      res.writeHead(status, { ...(body === undefined ? {} : { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json' }), ...headers })
      res.end(text)
    }
    try {
      const port = this.port
      // Schutz vor DNS-Rebinding: nur Aufrufe an 127.0.0.1 oder localhost, keine Webseiten
      const host = req.headers.host ?? ''
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return send(403, 'Falscher Host')
      const origin = req.headers.origin
      if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return send(403, 'Aufrufe aus dem Browser sind nicht erlaubt')

      const path = (req.url ?? '').split('?')[0].replace(/\/+$/, '')
      const auth = String(req.headers.authorization ?? '')
      const authorized = () =>
        this.config.enabled &&
        (path.startsWith('/mcp/')
          ? sameSecret(path.slice(5), this.config.token)
          : path === '/mcp' && /^bearer\s+/i.test(auth) && sameSecret(auth.replace(/^bearer\s+/i, ''), this.config.token))
      if (!authorized()) return path === '/mcp' ? send(401, 'Schlüssel fehlt oder ist falsch') : send(404, 'Unbekannte Adresse')

      if (req.method !== 'POST') return send(405, 'Nur POST', { allow: 'POST' })

      const chunks: Buffer[] = []
      let size = 0
      for await (const c of req) {
        size += (c as Buffer).length
        if (size > MAX_BODY) return send(413, 'Anfrage zu groß')
        chunks.push(c as Buffer)
      }
      let body: unknown
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Kein gültiges JSON' } })
      }
      // Schlüssel neu erzeugt oder Server abgeschaltet, während die Anfrage lief
      if (!authorized()) return send(404, 'Unbekannte Adresse')
      const out = await this.opts.protocol.handle(body)
      if (out === null) return send(202)
      send(200, out)
    } catch (e) {
      this.opts.log?.('warn', `[mcp] Anfrage fehlgeschlagen: ${(e as Error).message}`)
      send(500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Interner Fehler' } })
    }
  }
}
