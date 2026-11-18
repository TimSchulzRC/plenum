import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings } from '@shared/types'
import type { AccountRecord } from './account'

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  notifications: true,
  notificationSound: true,
  showMessagePreview: true,
  runAllAccounts: true,
  compactChatList: false
}

function file(name: string): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, name)
}

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file(name), 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(name: string, data: unknown): void {
  writeFileSync(file(name), JSON.stringify(data, null, 2))
}

export const store = {
  loadAccounts(): AccountRecord[] {
    return readJson<AccountRecord[]>('accounts.json', [])
  },
  saveAccounts(records: AccountRecord[]): void {
    writeJson('accounts.json', records)
  },
  loadSettings(): AppSettings {
    return { ...DEFAULT_SETTINGS, ...readJson<Partial<AppSettings>>('settings.json', {}) }
  },
  saveSettings(s: AppSettings): void {
    writeJson('settings.json', s)
  }
}
