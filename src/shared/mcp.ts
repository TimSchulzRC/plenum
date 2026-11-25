// Lokaler MCP-Server: Zustand für die Einstellungen und die Konfiguration für Claude Code und Codex.
// Ohne Electron-Abhängigkeiten, damit `pnpm test` die Texte direkt prüfen kann.

export interface McpInfo {
  enabled: boolean
  running: boolean
  // Name des Eintrags in Claude Code und Codex. Dev hat einen eigenen, damit beide nebeneinander gehen.
  name: string
  // Vollständige Adresse mit Schlüssel im Pfad, z. B. http://127.0.0.1:47311/mcp/<schlüssel>
  url?: string
  error?: string
}

export type McpClient = 'claude' | 'codex'

// Einfache Anführungszeichen für zsh und bash
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// Befehl für das Terminal, der den Server für alle Projekte einträgt.
export function mcpCommand(client: McpClient, name: string, url: string): string {
  return client === 'claude'
    ? `claude mcp add --transport http --scope user ${name} ${shellQuote(url)}`
    : `codex mcp add ${name} --url ${shellQuote(url)}`
}

// Wie mcpCommand, entfernt aber zuerst einen älteren Eintrag gleichen Namens (z. B. mit altem Schlüssel).
export function mcpReplaceCommand(client: McpClient, name: string, url: string): string {
  const remove = client === 'claude' ? `claude mcp remove --scope user ${name}` : `codex mcp remove ${name}`
  return `${remove} >/dev/null 2>&1; ${mcpCommand(client, name, url)}`
}

// Eintrag für .mcp.json, ~/.claude.json und andere Clients mit JSON-Konfiguration.
export function mcpJsonConfig(name: string, url: string): string {
  return JSON.stringify({ mcpServers: { [name]: { type: 'http', url } } }, null, 2)
}

// Eintrag für ~/.codex/config.toml.
export function mcpTomlConfig(name: string, url: string): string {
  return `[mcp_servers.${name}]\nurl = "${url}"\n`
}
