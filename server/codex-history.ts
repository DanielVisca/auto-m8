// Persist the user's message before starting/queuing a turn, and each completed answer block
// before publishing it. The provider's exit callback must never be the only copy of a chat.
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { get } from './db.ts'
import { settings } from './settings.ts'

type Chat = { id: string; cwd: string }
export function transcriptPath(id: string, cwd: string) {
  const known = get<{ path: string | null }>('select path from conversations where id = ?', id)?.path
  return known && existsSync(known) ? known : join(settings.sources[0].dir, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`)
}
const entries = (path: string): any[] => !existsSync(path) ? [] : readFileSync(path, 'utf8').split('\n').flatMap(line => {
  try { return [JSON.parse(line)] } catch { return [] }
})
// What append needs from a transcript (ids already written, the last main-thread id), kept per file
// and advanced by reading only the bytes added since. Re-reading and parsing the whole file on every
// append made long Codex chats quadratic: a 52.7s event-loop stall after the 2026-11-16 wake.
type Seen = { size: number; uuids: Set<string>; last: string | null; activity: Set<string>; answered: Set<string> } // activity, answered: turn ids
const seen = new Map<string, Seen>()
function seenOf(path: string): Seen {
  const size = existsSync(path) ? statSync(path).size : 0
  let c = seen.get(path)
  if (!c || size < c.size) c = { size: 0, uuids: new Set(), last: null, activity: new Set(), answered: new Set() } // new, truncated or replaced: start over
  if (size > c.size) {
    const buf = Buffer.alloc(size - c.size), fd = openSync(path, 'r')
    try { readSync(fd, buf, 0, buf.length, c.size) } finally { closeSync(fd) }
    const end = buf.lastIndexOf(0x0a) + 1 // only whole lines; a half-written one is read next time
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      let e: any; try { e = JSON.parse(line) } catch { continue }
      if (e?.uuid) { c.uuids.add(e.uuid); if (!e.isSidechain) c.last = e.uuid }
      if (e?.type === 'perch-codex-activity' && e.perchTurnId) c.activity.add(e.perchTurnId)
      if (e?.type === 'assistant' && e.perchTurnId) c.answered.add(e.perchTurnId)
    }
    c.size += end
  }
  seen.set(path, c)
  return c
}
function append(o: Chat, entry: any) {
  const path = transcriptPath(o.id, o.cwd), c = seenOf(path)
  if (entry.uuid && c.uuids.has(entry.uuid)) return path
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify({ isSidechain: false, userType: 'external', cwd: o.cwd,
    sessionId: o.id, version: 'perch-codex', parentUuid: c.last, timestamp: new Date().toISOString(), ...entry }) + '\n')
  seenOf(path) // pick up the line just written (and anything another writer added)
  return path
}
export function recordedCodexPrompt(id: string, cwd: string, prompt: string, since: number): string | null {
  return entries(transcriptPath(id, cwd)).find(e => e.type === 'user' && Date.parse(e.timestamp) >= since &&
    (typeof e.message?.content === 'string' ? e.message.content : (e.message?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')) === prompt)?.uuid ?? null
}
export function recordCodexPrompt(o: Chat & { messageId: string; prompt: string; images?: any[]; at?: string }) {
  return append(o, { type: 'user', uuid: o.messageId, ...(o.at ? { timestamp: o.at } : {}),
    message: { role: 'user', content: o.images?.length ? [...o.images, { type: 'text', text: o.prompt }] : o.prompt } })
}
export function codexMessageUuid(turnId: string, itemId: string) {
  const hex = createHash('sha256').update(`${turnId}:${itemId}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
export function recordCodexMessage(o: Chat & { turnId: string; itemId: string; text: string; model?: string; at?: string }) {
  // Stable across durable-run replay, including a crash between writing and saving the offset.
  const uuid = codexMessageUuid(o.turnId, o.itemId)
  return append(o, { type: 'assistant', uuid, perchTurnId: o.turnId, ...(o.at ? { timestamp: o.at } : {}),
    message: { id: `msg_codex_${uuid}`, type: 'message', role: 'assistant', model: o.model ?? 'codex',
      content: [{ type: 'text', text: o.text }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 } } })
}
export function recordCodexTurn(o: Chat & { turnId?: string; messageId?: string; prompt: string; reply: string; tools: string[] }) {
  const turnId = o.turnId ?? randomUUID(), path = transcriptPath(o.id, o.cwd)
  // From the per-file record kept by seenOf, not a fresh read: parsing the whole transcript twice
  // per turn showed up in freeze profiles.
  const before = seenOf(path)
  if (before.uuids.has(turnId) || before.activity.has(turnId)) return path
  recordCodexPrompt({ ...o, messageId: o.messageId ?? randomUUID() })
  if (!seenOf(path).answered.has(turnId)) {
    recordCodexMessage({ ...o, turnId, itemId: 'answer', text: o.reply || '(no reply)' })
  }
  // Metadata attaches to the last saved answer without appending the entire answer again.
  return append(o, { type: 'perch-codex-activity', perchTurnId: turnId, tools: o.tools })
}
