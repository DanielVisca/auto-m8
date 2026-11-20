// Cursor's agent conversations in perch. Cursor keeps them in its own SQLite store
// (globalStorage/state.vscdb: composerData:<id> for each conversation, bubbleId:<id>:<msg> for each
// message). perch reads that store without touching it and writes each conversation out as a
// transcript in the same shape Claude Code uses, into a folder that is just another source: the
// usual indexer then lists, searches and links them (PRs, files, evidence) like any other.
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { get, run } from './db.ts'
import { DATA_DIR, HOME } from './settings.ts'

export const CURSOR_DB = join(HOME, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb')
export const CURSOR_DIR = join(DATA_DIR, 'cursor')
db_init()
function db_init() { run('create table if not exists cursor_sync (id text primary key, updated integer)') }

const params = (raw: any) => { try { return typeof raw === 'string' ? JSON.parse(raw) : raw ?? {} } catch { return { raw: String(raw).slice(0, 2000) } } }

// One Cursor conversation as Claude Code transcript lines.
function transcript(c: any, bubbles: any[]) {
  const cwd = c.workspaceIdentifier?.uri?.fsPath ?? null
  const base = { sessionId: c.composerId, cwd, version: 'cursor' }
  const lines: any[] = []
  if (c.name) lines.push({ type: 'summary', summary: c.name, leafUuid: c.composerId })
  for (const b of bubbles) {
    const ts = b.createdAt ?? new Date(c.lastUpdatedAt ?? Date.now()).toISOString()
    const uuid = b.bubbleId ?? `${c.composerId}-${lines.length}`
    if (b.type === 1) { if (b.text?.trim()) lines.push({ ...base, type: 'user', uuid, timestamp: ts, message: { role: 'user', content: b.text } }); continue }
    const content: any[] = []
    if (b.text?.trim()) content.push({ type: 'text', text: b.text })
    const t = b.toolFormerData
    if (t?.name) content.push({ type: 'tool_use', id: t.toolCallId ?? uuid, name: t.name, input: params(t.params ?? t.rawArgs) })
    if (!content.length) continue
    lines.push({ ...base, type: 'assistant', uuid, timestamp: ts, message: { role: 'assistant', content } })
    if (t?.name && t.result != null && t.result !== 'undefined')
      lines.push({ ...base, type: 'user', uuid: `${uuid}-r`, timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: t.toolCallId ?? uuid, content: String(t.result).slice(0, 20_000), is_error: t.status === 'error' }] } })
  }
  return lines
}

// Write out every Cursor conversation changed since the last pass. Cheap when nothing changed:
// skipped outright when Cursor's store hasn't been written since, and otherwise SQLite reads just
// the two fields needed from each conversation. (Parsing every conversation's full JSON in JS,
// megabytes each, blocked perch for ~1.6s every minute: chats loaded slowly, 2026-11-12.)
let lastSeen = ''
export function syncCursor() {
  if (!existsSync(CURSOR_DB)) return { conversations: 0, written: 0 }
  const stamp = [CURSOR_DB, `${CURSOR_DB}-wal`].map(f => { try { const st = statSync(f); return `${st.mtimeMs}:${st.size}` } catch { return '-' } }).join('|')
  if (stamp === lastSeen) return { conversations: 0, written: 0, unchanged: true }
  mkdirSync(join(CURSOR_DIR, 'chats'), { recursive: true }) // one folder down, like Claude Code's project folders
  let db: DatabaseSync
  try { db = new DatabaseSync(CURSOR_DB, { readOnly: true }) } catch { return { conversations: 0, written: 0 } }
  let written = 0, total = 0
  try {
    const list = db.prepare(`select key, json_extract(value, '$.composerId') id, coalesce(json_extract(value, '$.lastUpdatedAt'), json_extract(value, '$.createdAt'), 0) updated,
        coalesce(json_array_length(value, '$.fullConversationHeadersOnly'), 0) n
      from cursorDiskKV where key >= 'composerData:' and key < 'composerData;' and json_valid(value)`).all() as any[] // a key range uses the index; LIKE scanned the whole 1GB file (3s on every boot)
    for (const h of list) {
      if (!h.id || h.n < 2) continue // empty drafts
      total++
      const updated = Number(h.updated)
      if (get<any>('select updated from cursor_sync where id = ?', h.id)?.updated === updated) continue
      let c: any
      try { c = JSON.parse((db.prepare('select value from cursorDiskKV where key = ?').get(h.key) as any).value) } catch { continue }
      const heads: any[] = c.fullConversationHeadersOnly ?? []
      // Messages in conversation order, read by key prefix (the store's primary key: fast).
      const byId = new Map((db.prepare(`select key, value from cursorDiskKV where key >= ? and key < ?`).all(`bubbleId:${c.composerId}:`, `bubbleId:${c.composerId};`) as any[])
        .map(x => { try { const b = JSON.parse(x.value); return [b.bubbleId ?? x.key.split(':').pop(), b] } catch { return [x.key, null] } }))
      const bubbles = heads.map(h => byId.get(h.bubbleId)).filter(Boolean)
      writeFileSync(join(CURSOR_DIR, 'chats', `${c.composerId}.jsonl`), transcript(c, bubbles).map(l => JSON.stringify(l)).join('\n') + '\n')
      run('insert into cursor_sync (id, updated) values (?, ?) on conflict(id) do update set updated = excluded.updated', c.composerId, updated)
      written++
    }
  } finally { db.close() }
  lastSeen = stamp
  return { conversations: total, written }
}
