// JSON-RPC-Teil des MCP-Servers (Streamable HTTP ohne SSE). Ohne Electron-Abhängigkeiten,
// damit `pnpm test` ihn direkt prüfen kann.

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface ToolResult {
  content: ToolContent[]
  isError?: boolean
}

export interface ToolDef {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  run(args: Record<string, unknown>): Promise<ToolResult | unknown>
}

// Fehler mit einer Meldung, die so an den Agenten geht (z. B. „Konto nicht gefunden“), ohne Log-Eintrag.
// Erkennung über das Feld statt instanceof, damit tools.ts diese Datei nur als Typ importiert.
export function isExpectedError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { expected?: unknown }).expected === true
}

interface RpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

type RpcResponse = { jsonrpc: '2.0'; id: string | number | null } & ({ result: unknown } | { error: { code: number; message: string } })

export interface ServerMeta {
  name: string
  title: string
  version: string
  instructions: string
}

function isToolResult(v: unknown): v is ToolResult {
  return !!v && typeof v === 'object' && Array.isArray((v as ToolResult).content)
}

export class McpProtocol {
  private readonly meta: ServerMeta
  private readonly tools: ToolDef[]
  private readonly onError: (tool: string, err: Error) => void

  constructor(meta: ServerMeta, tools: ToolDef[], onError: (tool: string, err: Error) => void = () => undefined) {
    this.meta = meta
    this.tools = tools
    this.onError = onError
  }

  // Verarbeitet den Inhalt eines POST. null heißt: nur Benachrichtigungen, Antwort 202 ohne Inhalt.
  async handle(body: unknown): Promise<RpcResponse | RpcResponse[] | null> {
    if (Array.isArray(body)) {
      if (body.length === 0) return this.error(null, -32600, 'Leere Anfrage')
      const out = (await Promise.all(body.map((b) => this.one(b)))).filter((r): r is RpcResponse => r !== null)
      return out.length ? out : null
    }
    return this.one(body)
  }

  private error(id: RpcResponse['id'], code: number, message: string): RpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } }
  }

  private async one(raw: unknown): Promise<RpcResponse | null> {
    if (!raw || typeof raw !== 'object') return this.error(null, -32600, 'Ungültige Anfrage')
    const req = raw as RpcRequest
    // Antworten des Clients auf Anfragen des Servers gibt es hier nicht, sie werden ignoriert.
    if (!req.method) return req.id !== undefined && ('result' in req || 'error' in req) ? null : this.error(req.id ?? null, -32600, 'Methode fehlt')
    // Benachrichtigungen (ohne id) bekommen keine Antwort
    if (req.id === undefined) return null
    const id = req.id
    try {
      return { jsonrpc: '2.0', id, result: await this.dispatch(req.method, req.params ?? {}) }
    } catch (e) {
      if (e instanceof RpcError) return this.error(id, e.code, e.message)
      return this.error(id, -32603, (e as Error).message || 'Interner Fehler')
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const asked = String(params.protocolVersion ?? '')
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.meta.name, title: this.meta.title, version: this.meta.version },
          instructions: this.meta.instructions
        }
      }
      case 'ping':
        return {}
      case 'tools/list':
        return {
          tools: this.tools.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            // Alle Werkzeuge lesen nur, sie ändern nichts in Teams.
            annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
          }))
        }
      case 'tools/call': {
        const name = String(params.name ?? '')
        const tool = this.tools.find((t) => t.name === name)
        if (!tool) throw new RpcError(-32602, `Unbekanntes Werkzeug: ${name}`)
        const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {}
        try {
          const out = await tool.run(args)
          return isToolResult(out) ? out : { content: [{ type: 'text', text: JSON.stringify(out) }] }
        } catch (e) {
          if (!isExpectedError(e)) this.onError(name, e as Error)
          return { content: [{ type: 'text', text: `Fehler: ${(e as Error).message}` }], isError: true }
        }
      }
      // Ressourcen und Prompts gibt es nicht, leere Listen halten neugierige Clients ruhig.
      case 'resources/list':
        return { resources: [] }
      case 'resources/templates/list':
        return { resourceTemplates: [] }
      case 'prompts/list':
        return { prompts: [] }
      default:
        throw new RpcError(-32601, `Unbekannte Methode: ${method}`)
    }
  }
}

class RpcError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}
