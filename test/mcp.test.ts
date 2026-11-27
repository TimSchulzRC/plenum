import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTools, decodeCursor, encodeCursor, imageUrls, ToolError, type McpAccount } from '../src/main/mcp/tools.ts'
import { McpProtocol } from '../src/main/mcp/protocol.ts'
import { McpServer } from '../src/main/mcp/server.ts'
import { mcpCommand, mcpJsonConfig, mcpReplaceCommand, mcpTomlConfig } from '../src/shared/mcp.ts'
import type { AccountInfo, CallLogEntry, ChatSummary, Message, Team } from '../src/shared/types.ts'

process.env.TZ = 'Europe/Berlin'

const NOW = Date.parse('2026-11-25T12:00:00Z')
const H = 3_600_000

function msg(id: number, from: string, text: string, extra: Partial<Message> = {}): Message {
  return {
    id: String(id),
    conversationId: '',
    type: 'RichText/Html',
    kind: 'text',
    from,
    fromName: from === '8:orgid:me' ? 'Ich' : from === '8:orgid:anna' ? 'Anna Berg' : 'Bernd Klein',
    isMine: from === '8:orgid:me',
    time: NOW - id * H,
    html: `<p>${text}</p>`,
    text,
    reactions: [],
    attachments: [],
    ...extra
  }
}

interface FakeOpts {
  id: string
  upn: string
  status?: AccountInfo['status']
  chats: ChatSummary[]
  teams?: Team[]
  messages: Record<string, Message[]>
  calls?: CallLogEntry[]
}

// Liefert Nachrichten wie der Chat-Dienst: neueste zuerst, seitenweise mit Adresse der älteren Seite
function fakeAccount(o: FakeOpts, log: string[] = []): McpAccount {
  const pageOf = <T>(list: T[], size: number, older?: string): { items: T[]; older?: string } => {
    const start = older ? Number(new URL(older).searchParams.get('offset')) : 0
    const items = list.slice(start, start + size)
    const next = start + size < list.length ? `https://emea.ng.msg.teams.microsoft.com/v1/x?offset=${start + size}` : undefined
    return { items, older: next }
  }
  return {
    id: o.id,
    info: () => ({ id: o.id, label: o.upn, upn: o.upn, displayName: o.upn.split('@')[0], status: o.status ?? 'ready', unread: 0, teamsUnread: 0, activityUnread: 0 }),
    chats: () => o.chats,
    teams: () => o.teams ?? [],
    name: (mri) => ({ '8:orgid:anna': 'Anna Berg', '8:orgid:bernd': 'Bernd Klein' })[mri],
    async messages(conv, size, older) {
      log.push(`${o.id}:${conv}`)
      const list = [...(o.messages[conv] ?? [])].sort((a, b) => b.time - a.time)
      return pageOf(list, size, older)
    },
    async callLog(size, older) {
      return pageOf(o.calls ?? [], size, older)
    },
    activity: async () => [],
    calendar: async () => [],
    searchPeople: async () => [],
    async download(url) {
      if (url.endsWith('.txt')) return { data: new TextEncoder().encode('Inhalt der Datei'), contentType: 'text/plain' }
      if (url.includes('asm.skype.com')) return { data: new Uint8Array([137, 80, 78, 71]), contentType: 'image/png' }
      throw new ToolError('nicht gefunden')
    }
  }
}

function chat(id: string, title: string, hoursAgo: number, extra: Partial<ChatSummary> = {}): ChatSummary {
  return { id, kind: 'group', title, members: ['8:orgid:anna', '8:orgid:bernd'], lastActivity: NOW - hoursAgo * H, unread: false, ...extra }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-test-'))
  const work = fakeAccount({
    id: 'a1',
    upn: 'tim@firma.de',
    chats: [chat('19:projekt@thread.v2', 'Projekt Nord', 1, { unread: true }), chat('19:alt@thread.v2', 'Alter Chat', 24 * 60)],
    teams: [
      {
        id: 'team1',
        displayName: 'Vertrieb',
        unread: false,
        channels: [{ id: '19:allg@thread.tacv2', teamId: 'team1', displayName: 'Allgemein', isGeneral: true, unread: false, lastActivity: NOW - 2 * H }]
      }
    ],
    messages: {
      '19:projekt@thread.v2': [
        msg(1, '8:orgid:anna', 'Das Angebot für Kunde Nord ist fertig', {
          attachments: [{ kind: 'file', name: 'Angebot Nord.pdf', url: 'https://firma.sharepoint.com/sites/x/Angebot%20Nord.pdf', fileType: 'pdf', size: 1234 }]
        }),
        msg(2, '8:orgid:bernd', 'Bild vom Whiteboard', {
          html: '<p>Bild vom Whiteboard</p><img src="https://eu-api.asm.skype.com/v1/objects/0-weu-abc/views/imgo" itemtype="http://schema.skype.com/AMSImage">'
        }),
        ...Array.from({ length: 8 }, (_, i) => msg(10 + i, '8:orgid:me', `Statusmeldung ${i}`))
      ],
      '19:allg@thread.tacv2': [msg(3, '8:orgid:bernd', 'Angebot Süd geht morgen raus', { subject: 'Kunde Süd' }), msg(4, '8:orgid:anna', 'Danke', { parentId: '3', time: NOW - 2.5 * H })],
      '19:alt@thread.v2': [msg(24 * 60, '8:orgid:anna', 'Angebot von vor zwei Monaten')]
    },
    calls: [
      { id: 'c1', time: NOW - 3 * H, direction: 'incoming', state: 'missed', peerMri: '8:orgid:anna' },
      { id: 'c2', time: NOW - 5 * H, direction: 'outgoing', state: 'accepted', durationSec: 120, peerMri: '8:orgid:bernd' }
    ]
  })
  const priv = fakeAccount({
    id: 'b2',
    upn: 'tim@verein.org',
    chats: [chat('19:verein@thread.v2', 'Vorstand', 4)],
    messages: { '19:verein@thread.v2': [msg(4, '8:orgid:anna', 'Angebot für die Halle liegt vor')] },
    calls: [{ id: 'c3', time: NOW - 4 * H, direction: 'incoming', state: 'missed', peerName: 'Kassenwart' }]
  })
  const offline = fakeAccount({ id: 'c3', upn: 'alt@firma.de', status: 'login-required', chats: [], messages: {} })
  const accounts = [work, priv, offline]
  const tools = createTools({
    accounts: () => accounts,
    saveFile: async (name) => join(dir, name),
    now: () => NOW
  })
  const protocol = new McpProtocol({ name: 'plenum', title: 'Plenum', version: '0.1.0', instructions: 'x' }, tools)
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await protocol.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as {
      result: { content: { type: string; text?: string; data?: string }[]; isError?: boolean }
    }
    return res.result
  }
  const json = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(name, args)
    assert.ok(!r.isError, r.content[0].text)
    return JSON.parse(r.content[0].text!)
  }
  return { dir, protocol, call, json, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('Werkzeuge: alle lesen nur', async () => {
  const { protocol, cleanup } = setup()
  const res = (await protocol.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } }
  const names = res.result.tools.map((t) => t.name)
  assert.deepEqual(names, ['list_accounts', 'list_conversations', 'list_teams', 'get_messages', 'search_messages', 'list_files', 'read_file', 'get_call_history', 'get_activity', 'get_calendar', 'search_people'])
  assert.ok(res.result.tools.every((t) => t.annotations.readOnlyHint))
  cleanup()
})

test('list_conversations: Chats und Kanäle aller verbundenen Konten, mit Hinweis auf getrennte', async () => {
  const { json, cleanup } = setup()
  const r = await json('list_conversations')
  assert.deepEqual(
    r.conversations.map((c: { title: string }) => c.title),
    ['Projekt Nord', 'Vertrieb › Allgemein', 'Vorstand', 'Alter Chat']
  )
  assert.equal(r.conversations[0].account, 'tim@firma.de')
  assert.deepEqual(r.conversations[0].members, ['Anna Berg', 'Bernd Klein'])
  assert.match(r.warnings[0], /alt@firma\.de: nicht verbunden/)
  const nur = await json('list_conversations', { account: 'verein', kind: 'chat' })
  assert.deepEqual(nur.conversations.map((c: { title: string }) => c.title), ['Vorstand'])
  const ungelesen = await json('list_conversations', { unread_only: true })
  assert.deepEqual(ungelesen.conversations.map((c: { title: string }) => c.title), ['Projekt Nord'])
  cleanup()
})

test('Konto nicht eindeutig oder unbekannt: verständlicher Fehler', async () => {
  const { call, cleanup } = setup()
  const r = await call('list_conversations', { account: 'tim' })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text!, /mehrere Konten/)
  const r2 = await call('list_conversations', { account: 'niemand' })
  assert.match(r2.content[0].text!, /Kein Konto passt/)
  cleanup()
})

test('get_messages: alt nach neu, ältere Seiten über next_cursor, Konto aus der Unterhaltung', async () => {
  const { json, call, cleanup } = setup()
  const first = await json('get_messages', { conversation_id: '19:projekt@thread.v2', limit: 4 })
  assert.equal(first.conversation.account, 'tim@firma.de')
  assert.deepEqual(first.messages.map((m: { id: string }) => m.id), ['11', '10', '2', '1'])
  assert.equal(first.messages[3].files[0].name, 'Angebot Nord.pdf')
  assert.deepEqual(first.messages[2].images, ['https://eu-api.asm.skype.com/v1/objects/0-weu-abc/views/imgo'])
  assert.equal(first.messages[0].mine, true)
  assert.match(first.messages[0].time, /^2026-11-25T0\d:00:00\+01:00$/)
  const second = await json('get_messages', { conversation_id: '19:projekt@thread.v2', limit: 4, cursor: first.next_cursor })
  assert.deepEqual(second.messages.map((m: { id: string }) => m.id), ['15', '14', '13', '12'])
  // Cursor einer anderen Unterhaltung wird abgelehnt
  const wrong = await call('get_messages', { conversation_id: '19:verein@thread.v2', cursor: first.next_cursor })
  assert.equal(wrong.isError, true)
  // Kanal: Antworten tragen reply_to
  const channel = await json('get_messages', { conversation_id: '19:allg@thread.tacv2' })
  assert.deepEqual(channel.messages.map((m: { reply_to?: string; subject?: string }) => [m.reply_to, m.subject]), [
    [undefined, 'Kunde Süd'],
    ['3', undefined]
  ])
  cleanup()
})

test('get_messages: since begrenzt und beendet das Blättern', async () => {
  const { json, cleanup } = setup()
  const r = await json('get_messages', { conversation_id: '19:projekt@thread.v2', limit: 100, since: '2026-11-25T09:30:00+01:00' })
  assert.deepEqual(r.messages.map((m: { id: string }) => m.id), ['2', '1'])
  assert.equal(r.next_cursor, undefined)
  cleanup()
})

test('search_messages: durchsucht alle Konten ab since, Wörter in Text, Betreff und Dateinamen', async () => {
  const { json, cleanup } = setup()
  const r = await json('search_messages', { query: 'angebot' })
  assert.deepEqual(
    r.hits.map((h: { conversation: string; text: string }) => h.conversation),
    ['Projekt Nord', 'Vertrieb › Allgemein', 'Vorstand']
  )
  assert.equal(r.hits[2].account, 'tim@verein.org')
  // „Alter Chat“ liegt vor den letzten 30 Tagen
  assert.equal(r.searched.conversations, 3)
  const alt = await json('search_messages', { query: 'angebot', since: '2026-09-01' })
  assert.equal(alt.hits.length, 4)
  const vonBernd = await json('search_messages', { query: 'süd', from: 'bernd' })
  assert.equal(vonBernd.hits.length, 1)
  assert.equal(vonBernd.hits[0].subject, 'Kunde Süd')
  const datei = await json('search_messages', { query: 'nord.pdf' })
  assert.equal(datei.hits.length, 1)
  cleanup()
})

test('list_files: Dateien und eingefügte Bilder, filterbar nach Name', async () => {
  const { json, cleanup } = setup()
  const r = await json('list_files')
  assert.deepEqual(
    r.files.map((f: { name: string; kind: string }) => `${f.kind}:${f.name}`),
    ['file:Angebot Nord.pdf', 'image:Bild']
  )
  assert.equal(r.files[0].from, 'Anna Berg')
  assert.equal(r.files[0].conversation, 'Projekt Nord')
  const pdf = await json('list_files', { query: 'angebot' })
  assert.equal(pdf.files.length, 1)
  cleanup()
})

test('read_file: Text direkt, Bild als Bild, immer mit Pfad', async () => {
  const { call, cleanup, dir } = setup()
  const t = await call('read_file', { url: 'https://teams.microsoft.com/x/notiz.txt' })
  const info = JSON.parse(t.content[0].text!)
  assert.equal(info.text, 'Inhalt der Datei')
  assert.equal(info.saved_to, join(dir, 'notiz.txt'))
  const img = await call('read_file', { url: 'https://eu-api.asm.skype.com/v1/objects/0-weu-abc/views/imgo', conversation_id: '19:projekt@thread.v2' })
  assert.equal(img.content[1].type, 'image')
  assert.equal(JSON.parse(img.content[0].text!).name, 'bild.png')
  const bad = await call('read_file', { url: 'http://example.com/a' })
  assert.equal(bad.isError, true)
  cleanup()
})

test('get_call_history: alle Konten zusammen, neueste zuerst, nur verpasste', async () => {
  const { json, cleanup } = setup()
  const r = await json('get_call_history')
  assert.deepEqual(r.calls.map((c: { peer: string }) => c.peer), ['Anna Berg', 'Kassenwart', 'Bernd Klein'])
  const missed = await json('get_call_history', { missed_only: true })
  assert.deepEqual(missed.calls.map((c: { account: string }) => c.account), ['tim@firma.de', 'tim@verein.org'])
  cleanup()
})

test('Cursor und Bild-URLs', () => {
  const c = encodeCursor('19:a@thread.v2', 'https://x/y?z=1')
  assert.equal(decodeCursor(c, '19:a@thread.v2'), 'https://x/y?z=1')
  assert.throws(() => decodeCursor(c, '19:b@thread.v2'))
  assert.throws(() => decodeCursor('kaputt', '19:a@thread.v2'))
  // Emojis und fremde Bilder sind keine geteilten Bilder
  assert.deepEqual(imageUrls('<img src="https://statics.teams.cdn.office.net/emoji.png"><img src="https://evil.example/x.png">'), [])
})

test('Befehle für Claude Code und Codex', () => {
  const url = 'http://127.0.0.1:47311/mcp/abc123'
  assert.equal(mcpCommand('claude', 'plenum', url), "claude mcp add --transport http --scope user plenum 'http://127.0.0.1:47311/mcp/abc123'")
  assert.equal(mcpCommand('codex', 'plenum', url), "codex mcp add plenum --url 'http://127.0.0.1:47311/mcp/abc123'")
  assert.equal(
    mcpReplaceCommand('claude', 'plenum', url),
    "claude mcp remove --scope user plenum >/dev/null 2>&1; claude mcp remove --scope user teams-everywhere >/dev/null 2>&1; claude mcp add --transport http --scope user plenum 'http://127.0.0.1:47311/mcp/abc123'"
  )
  // Der alte Eintrag aus der Zeit als „Teams Everywhere“ verschwindet, sonst sähe der Agent jedes Werkzeug doppelt
  assert.match(mcpReplaceCommand('codex', 'plenum-dev', url), /^codex mcp remove plenum-dev >\/dev\/null 2>&1; codex mcp remove teams-everywhere-dev >\/dev\/null 2>&1; codex mcp add plenum-dev /)
  assert.match(mcpReplaceCommand('codex', 'anders', url), /^codex mcp remove anders >\/dev\/null 2>&1; codex mcp add anders /)
  assert.deepEqual(JSON.parse(mcpJsonConfig('plenum', url)), { mcpServers: { plenum: { type: 'http', url } } })
  assert.equal(mcpTomlConfig('plenum', url), `[mcp_servers.plenum]\nurl = "${url}"\n`)
})

test('HTTP: Schlüssel, Host- und Origin-Prüfung, JSON-RPC', async () => {
  const { protocol, dir, cleanup } = setup()
  const file = join(dir, 'mcp.json')
  const srv = new McpServer({ file, defaultPort: 0, name: 'plenum', protocol })
  assert.equal(srv.info().enabled, false)
  assert.equal(srv.info().url, undefined)
  const info = await srv.setEnabled(true)
  assert.ok(info.running)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.enabled, true)
  assert.match(saved.token, /^[0-9a-f]{48}$/)
  const url = info.url!
  const base = url.replace(/\/mcp\/.*/, '')
  const post = (u: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) })

  const init = await post(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
  assert.equal(init.status, 200)
  const ir = (await init.json()) as { result: { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string } } }
  assert.equal(ir.result.protocolVersion, '2025-06-18')
  assert.equal(ir.result.serverInfo.name, 'plenum')

  assert.equal((await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
  assert.equal((await post(`${base}/mcp/falsch`, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 404)
  assert.equal((await post(`${base}/mcp`, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401)
  assert.equal((await post(`${base}/mcp`, { jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: `Bearer ${saved.token}` })).status, 200)
  assert.equal((await post(url, { jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await fetch(url)).status, 405)

  // Ein neuer Schlüssel sperrt die alte Adresse
  const fresh = await srv.resetToken()
  assert.equal((await post(url, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 404)
  assert.equal((await post(fresh.url!, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200)

  // Schnelles Aus und Ein und Aus lässt keinen Listener zurück
  void srv.setEnabled(false)
  void srv.setEnabled(true)
  await srv.setEnabled(false)
  assert.equal(srv.info().running, false)
  await assert.rejects(post(fresh.url!, { jsonrpc: '2.0', id: 1, method: 'ping' }))
  cleanup()
})
