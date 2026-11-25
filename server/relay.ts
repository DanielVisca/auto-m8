// One auto-m8 chat writing into another: a "driver" chat (a monitor, a the user pair) keeps the user's
// other conversations going. Every message carries a marker line, so the receiving agent knows the
// user didn't type it, and the chat renders it as agent-sent (it survives reloads because it lives
// in the transcript itself, not in a side table).
import { chats, send } from './chat.ts'
import { all, get, run } from './db.ts'
import { readFileSync, statSync, type Stats } from 'node:fs'
import { liveSessions } from './presence.ts'
import { watch } from './orchestra.ts'
import { convIdOf, convLink } from '../shared/brand.ts'
import { agentSender } from '../shared/messageOrigin.ts'

export { AGENT_MARK } from '../shared/messageOrigin.ts'

export const titleFor = (id: string) =>
  get<{ t: string }>(`select coalesce(u.title, c.title, c.first_prompt, '') as t from conversations c left join user_state u on u.id = c.id where c.id = ?`, id)?.t?.replace(/["\n]/g, ' ').slice(0, 80) ?? ''

export const marked = (from: string, message: string) => `[auto-m8: sent by an agent from ${convLink(from)}${titleFor(from) ? ` "${titleFor(from)}"` : ''}. Not typed by the user.]\n\n${message}`

export function relay(input: { from: string; to: string; message: string; reportBack?: boolean }) {
  const from = convIdOf(String(input.from || '')), to = convIdOf(String(input.to || '')), message = String(input.message ?? '').trim()
  if (!from) throw new Error('Pass your own conversation_id as from.')
  if (!to) throw new Error('Pass the conversation to write to.')
  if (from === to) throw new Error("That's your own conversation.")
  if (!message) throw new Error('The message is empty.')
  const row = get<{ source: string }>('select source from conversations where id = ?', to)
  if (!row && !chats.has(to)) throw new Error(`No conversation ${to}. Find it with search_conversations or recent_activity.`)
  if (row && row.source !== 'claude') throw new Error(`auto-m8 can't write into a ${row.source} conversation, only Claude Code ones.`)
  // Open in a terminal right now: resuming it from auto-m8 would fork its history under the user.
  if (!chats.has(to) && liveSessions().some(s => s.session === to)) throw new Error('That conversation is open in a terminal right now; writing to it from auto-m8 would fork it. Tell the user instead.')
  send({ id: to, prompt: marked(from, message), resume: true })
  run('insert or ignore into links (a, b, kind, note, created_at) values (?, ?, ?, ?, ?)', from, to, 'drives', 'agent-sent messages', Date.now())
  const ours = chats.has(from) || !!get('select 1 from perch_started where id = ?', from)
  // The reply comes back through the owner's inbox (batched with everything else it watches).
  if (input.reportBack !== false && ours && !get('select 1 from watches where owner = ? and target = ? and active = 1', from, to)) watch({ owner: from, targets: [to], events: ['turn_end', 'asked', 'error'] })
  return { ok: true, title: titleFor(to), reportBack: input.reportBack !== false && ours }
}

// Who drives whom: every agent-sent message, read back from the receiving transcripts (the marker
// line is the only record). Parsed files are cached by size+mtime, so repeat calls are cheap.
type Sent = { uuid: string; from: string; ts: number; chars: number; preview: string }
const graphCache = new Map<string, { key: string; msgs: Sent[] }>()

export function sentIn(path: string): Sent[] {
  let st: Stats
  try { st = statSync(path) } catch { return [] }
  const key = `${st.size}:${st.mtimeMs}`
  const hit = graphCache.get(path)
  if (hit?.key === key) return hit.msgs
  const msgs: Sent[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    // Cheap prefilter before JSON.parse; the marker says auto-m8 now and perch in older transcripts.
    if (!line.includes(': sent by an agent from ') || !line.startsWith('{"') || !line.includes('"type":"user"')) continue
    try {
      const e = JSON.parse(line)
      if (e.type !== 'user' || e.isMeta) continue
      const c = e.message?.content
      const text: string = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((p: any) => p?.type === 'text')?.text ?? '') : ''
      const s = agentSender(text)
      if (!s?.id || !/sent by an agent from/.test(text.slice(0, 600))) continue
      const body = s.body.trim()
      msgs.push({ uuid: String(e.uuid ?? `${s.id}:${e.timestamp}`), from: s.id, ts: Date.parse(e.timestamp), chars: body.length, preview: body.slice(0, 160) })
    } catch {}
  }
  graphCache.set(path, { key, msgs })
  return msgs
}

/** Edges between conversations: who sent how many messages to whom, with each send's time. */
export function relayGraph(days: number) {
  const since = days > 0 ? Date.now() - days * 86_400_000 : 0
  const targets = all<{ id: string; path: string | null }>(
    `select c.id, c.path from conversations c where c.path is not null and (c.id in (select b from links where kind = 'drives')
       or c.root_uuid in (select root_uuid from conversations where root_uuid is not null and id in (select b from links where kind = 'drives')))`)
  const seen = new Set<string>()
  const edges = new Map<string, { from: string; to: string; times: number[]; chars: number; last: string }>()
  for (const t of targets) {
    for (const m of sentIn(t.path!)) {
      if (seen.has(m.uuid) || !(m.ts >= since) || m.from === t.id) continue
      seen.add(m.uuid)
      const k = `${m.from}>${t.id}`
      const e = edges.get(k) ?? { from: m.from, to: t.id, times: [], chars: 0, last: '' }
      e.times.push(m.ts); e.chars += m.chars
      if (m.ts >= Math.max(...e.times)) e.last = m.preview
      edges.set(k, e)
    }
  }
  const ids = [...new Set([...edges.values()].flatMap(e => [e.from, e.to]))]
  const nodes = ids.map(id => {
    const r = get<{ t: string; source: string; updated_at: number }>(`select coalesce(u.title, c.title, c.first_prompt, '') t, c.source, c.updated_at from conversations c left join user_state u on u.id = c.id where c.id = ?`, id)
    return { id, title: (r?.t || id.slice(0, 8)).replace(/\s+/g, ' ').slice(0, 80), source: r?.source ?? 'unknown', updatedAt: r?.updated_at ?? null, sent: 0, received: 0 }
  })
  const byId = new Map(nodes.map(n => [n.id, n]))
  const list = [...edges.values()].map(e => { e.times.sort((a, b) => a - b); byId.get(e.from)!.sent += e.times.length; byId.get(e.to)!.received += e.times.length; return { ...e, count: e.times.length } })
    .sort((a, b) => b.count - a.count)
  return { days, since, generatedAt: Date.now(), total: seen.size, nodes, edges: list }
}
