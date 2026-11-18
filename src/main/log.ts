import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

let file: string | undefined
function target(): string | undefined {
  if (file) return file
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    file = join(dir, 'main.log')
  } catch {
    /* ignore */
  }
  return file
}

function write(level: string, args: unknown[]): void {
  const line = `${new Date().toISOString()} ${level} ${args
    .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : safeJson(a)))
    .join(' ')}`
  if (level === 'ERROR' || level === 'WARN') console.warn(line)
  else console.log(line)
  const f = target()
  if (f) {
    try {
      appendFileSync(f, line + '\n')
    } catch {
      /* ignore */
    }
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export const log = {
  info: (...a: unknown[]) => write('INFO', a),
  warn: (...a: unknown[]) => write('WARN', a),
  error: (...a: unknown[]) => write('ERROR', a)
}
