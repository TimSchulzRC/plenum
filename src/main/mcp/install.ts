// Trägt den MCP-Server direkt in Claude Code oder Codex ein, über deren Kommandozeile.
// Eine App aus dem Finder hat nicht den PATH des Terminals, deshalb läuft der Befehl in einer
// interaktiven Login-Shell des Nutzers, die .zprofile und .zshrc lädt.
import { execFile } from 'node:child_process'
import { mcpReplaceCommand, shellQuote, type McpClient } from '@shared/mcp'

const CLI: Record<McpClient, { bin: string; label: string }> = {
  claude: { bin: 'claude', label: 'Claude Code' },
  codex: { bin: 'codex', label: 'Codex' }
}

// Übliche Installationsorte, falls die Shell-Konfiguration sie nicht in den PATH nimmt:
// nativer Installer von Claude Code, Homebrew (Apple Silicon und Intel), npm ohne nvm.
const EXTRA_PATH = ['$HOME/.local/bin', '$HOME/.claude/local', '/opt/homebrew/bin', '/usr/local/bin', '$HOME/.npm-global/bin']

function run(cmd: string): Promise<{ code: number; output: string }> {
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  const path = `export PATH="$PATH":${shellQuote(process.env.PATH ?? '')}:${EXTRA_PATH.map((p) => `"${p}"`).join(':')}; `
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', path + cmd], { timeout: 60_000, env: { ...process.env, NO_COLOR: '1' } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0
      resolve({ code, output: `${stdout}${stderr}`.trim() })
    })
  })
}

export async function installMcp(client: McpClient, name: string, url: string): Promise<{ ok: boolean; message: string }> {
  const { bin, label } = CLI[client]
  const found = await run(`command -v ${bin}`)
  if (found.code !== 0 || !found.output) {
    return { ok: false, message: `${label} ist nicht installiert oder nicht im PATH. Kopiere den Befehl und führe ihn im Terminal aus.` }
  }
  const res = await run(mcpReplaceCommand(client, name, url))
  if (res.code !== 0) return { ok: false, message: `${label} meldet einen Fehler: ${res.output.split('\n').slice(-3).join(' ') || `Exit-Code ${res.code}`}` }
  return { ok: true, message: `In ${label} als „${name}“ eingetragen. Starte laufende Sitzungen neu, damit sie den Server sehen.` }
}
