import { Button, Switch } from '@fluentui/react-components'
import { useEffect, useState } from 'react'
import { mcpCommand, mcpJsonConfig, mcpTomlConfig, type McpClient, type McpInfo } from '@shared/mcp'
import { api, onEvent } from '../api'

const CLIENTS: { id: McpClient; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' }
]

// Einstellungen für den lokalen MCP-Server: an/aus, Befehle zum Kopieren, direkt eintragen.
export function McpSettings(): JSX.Element {
  const [info, setInfo] = useState<McpInfo | null>(null)
  const [copied, setCopied] = useState<string>()
  const [result, setResult] = useState<Partial<Record<McpClient, { busy?: boolean; ok?: boolean; message?: string }>>>({})

  useEffect(() => {
    void api.getMcpInfo().then(setInfo)
    return onEvent('mcp', setInfo)
  }, [])

  if (!info) return <section />

  const copy = (key: string, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied((k) => (k === key ? undefined : k)), 1500)
    })
  }

  const install = async (client: McpClient) => {
    setResult((r) => ({ ...r, [client]: { busy: true } }))
    const res = await api.installMcp(client).catch((e: Error) => ({ ok: false, message: e.message }))
    setResult((r) => ({ ...r, [client]: res }))
  }

  const resetToken = () => {
    if (confirm('Neuen Schlüssel erzeugen? Bisherige Einträge in Claude Code und Codex funktionieren danach nicht mehr und müssen neu eingetragen werden.')) {
      setResult({})
      void api.resetMcpToken().then(setInfo)
    }
  }

  const port = info.url ? new URL(info.url).port : undefined

  return (
    <section>
      <h2>Claude Code und Codex</h2>
      <div className="row">
        <div className="grow">
          MCP-Server
          <div className="hint">
            Claude Code, Codex und andere MCP-Clients auf diesem Gerät lesen darüber Chats, Kanäle, geteilte Dateien, Anrufverlauf, Aktivität, Kalender und E-Mails aller Konten. Sie
            können nichts senden oder ändern.
          </div>
        </div>
        <Switch checked={info.enabled} onChange={(_e, d) => void api.setMcpEnabled(d.checked).then(setInfo)} />
      </div>
      {info.enabled && info.url && (
        <>
          <div className="row">
            <div className="grow hint">
              {info.error
                ? `Der Server startet nicht: ${info.error}`
                : info.running
                  ? `Läuft auf 127.0.0.1:${port}, solange die App geöffnet ist.`
                  : 'Startet …'}
            </div>
          </div>
          {CLIENTS.map((c) => {
            const cmd = mcpCommand(c.id, info.name, info.url!)
            const r = result[c.id]
            return (
              <div className="row mcp-client" key={c.id}>
                <div className="grow">
                  <div>{c.label}</div>
                  <code className="mcp-command selectable">{cmd}</code>
                  {r?.message && <div className={`hint ${r.ok ? 'mcp-ok' : 'mcp-error'}`}>{r.message}</div>}
                </div>
                <Button size="small" onClick={() => copy(c.id, cmd)}>
                  {copied === c.id ? 'Kopiert' : 'Befehl kopieren'}
                </Button>
                <Button size="small" appearance="primary" disabled={r?.busy} onClick={() => void install(c.id)}>
                  {r?.busy ? 'Trage ein …' : 'Eintragen'}
                </Button>
              </div>
            )
          })}
          <details className="mcp-more">
            <summary className="hint">Andere Clients und Konfigurationsdateien</summary>
            <div className="row">
              <div className="grow">
                <div className="hint">.mcp.json, ~/.claude.json und andere Clients mit JSON-Konfiguration</div>
                <pre className="mcp-command selectable">{mcpJsonConfig(info.name, info.url)}</pre>
              </div>
              <Button size="small" onClick={() => copy('json', mcpJsonConfig(info.name, info.url!))}>
                {copied === 'json' ? 'Kopiert' : 'Kopieren'}
              </Button>
            </div>
            <div className="row">
              <div className="grow">
                <div className="hint">~/.codex/config.toml</div>
                <pre className="mcp-command selectable">{mcpTomlConfig(info.name, info.url)}</pre>
              </div>
              <Button size="small" onClick={() => copy('toml', mcpTomlConfig(info.name, info.url!))}>
                {copied === 'toml' ? 'Kopiert' : 'Kopieren'}
              </Button>
            </div>
          </details>
          <div className="row">
            <div className="grow hint">Die Adresse enthält einen geheimen Schlüssel. Wer ihn kennt, kann auf diesem Gerät deine Teams-Daten lesen.</div>
            <Button size="small" onClick={resetToken}>
              Neuer Schlüssel
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
