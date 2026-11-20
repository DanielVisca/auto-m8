// Carry a conversation from one profile to another (Work → Personal or back). You see exactly what
// goes before it goes; the other profile gets it as a conversation of its own: listed, searchable,
// and pulled into a new chat when you reply. Only text crosses: no files, keys or connections.
import { updateSearch } from './searchindex.ts'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { get, refreshMeta, run } from './db.ts'
import { condensed } from './mcp.ts'
import { profile, profiles } from './profile.ts'
import { DATA_DIR } from './settings.ts'
import { toItems } from './transcript.ts'

export type Carry = { title: string; text: string; from: string; sourceId: string; mode: 'brief' | 'full' }

// What would be carried, for the preview and the copy alike.
export function carryText(id: string, mode: 'brief' | 'full'): Carry {
  const c = get<any>('select c.*, coalesce(u.title, c.title, c.first_prompt) t from conversations c left join user_state u on u.id = c.id where c.id = ?', id)
  if (!c) throw new Error('No such conversation.')
  let text = ''
  if (c.path) {
    const items = toItems(readFileSync(c.path, 'utf8'))
    if (mode === 'full') text = condensed(items, 40_000)
    else {
      const first = items.find(i => i.kind === 'user') as any
      // The latest reply that says something (mid-turn, the very last message is often just a tool step).
      const last = [...items].reverse().find(i => i.kind === 'assistant' && (i as any).blocks.some((b: any) => b.type === 'text' && b.text.trim())) as any
      const reply = last?.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') ?? ''
      text = `Asked: ${String(first?.text ?? '').slice(0, 2000)}\n\nLatest answer:\n${reply.slice(-6000)}`
    }
  } else text = String(c.summary ?? c.first_prompt ?? '')
  return { title: String(c.t ?? 'Conversation').slice(0, 160), text, from: profile.label, sourceId: id, mode }
}

// Send it to another profile's server (it must be running: turned on in the switcher).
export async function carryTo(id: string, targetId: string, mode: 'brief' | 'full') {
  const target = profiles().find(p => p.id === targetId)
  if (!target || target.id === profile.id) throw new Error('Pick another profile.')
  const body = carryText(id, mode)
  const r = await fetch(`http://127.0.0.1:${target.port}/api/import`, { method: 'POST', headers: { 'content-type': 'application/json', host: `127.0.0.1:${target.port}` }, body: JSON.stringify(body) }).catch(() => null)
  if (!r?.ok) throw new Error(`${target.label} isn’t running. Turn it on from the profile switcher first.`)
  return { ...(await r.json() as { id: string }), to: target.label }
}

// Receiving end: written as a small transcript so it reads like any conversation.
export function importCarry(b: Carry) {
  const id = randomUUID()
  const dir = join(DATA_DIR, 'imports')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id}.jsonl`)
  const now = new Date().toISOString()
  const intro = `Carried over from ${b.from}: ${b.title}`
  writeFileSync(path, [
    { type: 'user', uuid: randomUUID(), timestamp: now, message: { role: 'user', content: intro } },
    { type: 'assistant', uuid: randomUUID(), timestamp: now, message: { role: 'assistant', content: [{ type: 'text', text: `**${b.title}** (from ${b.from}, ${b.mode === 'full' ? 'the full thread' : 'the ask and latest answer'})\n\n${b.text}` }] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n')
  run(`insert into conversations (id, source, title, first_prompt, path, started_at, updated_at, messages, status) values (?, 'import', ?, ?, ?, ?, ?, 2, 'completed')`,
    id, `↪ ${b.title}`, intro, path, Date.now(), Date.now())
  updateSearch([{ id, title: `${b.title} ${b.from}`, body: b.text.slice(0, 200_000) }]) // keeps the id -> rowid map in step
  refreshMeta(id)
  return { id }
}
