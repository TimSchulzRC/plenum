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

// Namen der Einträge aus der Zeit, als die App „Teams Everywhere“ hieß. Sie zeigen auf denselben
// Server, und doppelt eingetragen sähe der Agent jedes Werkzeug zweimal.
const LEGACY_NAMES: Record<string, string> = { plenum: 'teams-everywhere', 'plenum-dev': 'teams-everywhere-dev' }

// Wie mcpCommand, entfernt aber zuerst ältere Einträge gleichen oder alten Namens (z. B. mit altem Schlüssel).
export function mcpReplaceCommand(client: McpClient, name: string, url: string): string {
  const names = LEGACY_NAMES[name] ? [name, LEGACY_NAMES[name]] : [name]
  const remove = names
    .map((n) => `${client === 'claude' ? `claude mcp remove --scope user ${n}` : `codex mcp remove ${n}`} >/dev/null 2>&1; `)
    .join('')
  return `${remove}${mcpCommand(client, name, url)}`
}

// Eintrag für .mcp.json, ~/.claude.json und andere Clients mit JSON-Konfiguration.
export function mcpJsonConfig(name: string, url: string): string {
  return JSON.stringify({ mcpServers: { [name]: { type: 'http', url } } }, null, 2)
}

// Eintrag für ~/.codex/config.toml.
export function mcpTomlConfig(name: string, url: string): string {
  return `[mcp_servers.${name}]\nurl = "${url}"\n`
}
