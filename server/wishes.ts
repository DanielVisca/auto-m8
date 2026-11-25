// Wishes: what agents lacked, learned from what they ran into, not from asking them.
// report_missing_capability only fires when an agent volunteers it, which almost never happens
// (4 reports in a month). Agents hit the same walls all the time, though, and the transcripts say so:
//   tool-miss     ToolSearch found no tool for what it was looking for (its query is the wish)
//   unavailable   a tool call failed because the tool or connector wasn't there, connected or allowed
//   said          the agent told the user it couldn't reach, see or verify something
// Nothing is added to agents' prompts, so nothing leads them. Each signal is kept with its evidence,
// then a cheap model call groups signals and reports into named needs ("prod PostHog MCP from
// Claude sessions") and drops the noise (a server still connecting, an agent's own slip).
// Settings → Health → "Agents wished they had" shows the needs, most recurring first.
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { all, db, get, run } from './db.ts'
import { modelJson } from './evolve.ts'
import { autonomyOn } from './settings.ts'
import { itemsOf, type Item } from './transcript.ts'

db.exec(`
create table if not exists wish_groups (
  id text primary key, name text not null, kind text, suggested text, description text,
  status text default 'open', -- open | ignored
  created_at integer, updated_at integer
);
create table if not exists wish_files (conversation_id text primary key, mtime integer);
`)
for (const c of ['source text', 'signal text', 'evidence text', 'group_id text']) { try { db.exec(`alter table capability_wishes add column ${c}`) } catch {} }
// A report with no need was saved as the text "undefined" before the tool checked for it.
run(`delete from capability_wishes where need is null or trim(need) in ('', 'undefined')`)

const DAY = 86400_000
const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16)
const one = (s: string, n = 300) => s.replace(/\s+/g, ' ').trim().slice(0, n)

// A failure that says the capability wasn't there, as opposed to the agent using it wrong.
const UNAVAILABLE = /not available in this session|no such tool available|requires? (re-?)?authenticat|needs? (you to )?authori[sz]|failed to connect|CONNECTION_CLOSED|is not connected|not configured|permission denied|insufficient (scope|permission)|missing (the )?scope|403 forbidden|access denied|not allowed to/i
const SLIP = /case-sensitive|call \w+ instead|InputValidationError|still connecting/i
// The agent telling the user it couldn't get at something. The model step drops the ones that
// aren't about a missing source ("I can't see why").
const SAID = /\bI (?:don't|do not|can't|cannot|couldn't|could not|wasn't able to|was unable to|have no way to) (?:have )?(?:access|reach|query|verify|see|check|read|get at|confirm|look at|pull)\b[^.\n]{8,180}/gi
const SAID_ALSO = /\b(?:no|without) (?:access|MCP|connector|credentials|permission) (?:to|for)\b[^.\n]{4,160}/gi

type Signal = { id: string; ts: number; signal: string; text: string; evidence: string }

export function signalsOf(conversationId: string, items: Item[]): Signal[] {
  const out: Signal[] = []
  for (const it of items) {
    if (it.kind !== 'assistant') continue
    const ts = it.ts ?? Date.now()
    for (const b of it.blocks) {
      if (b.type === 'tool') {
        const result = String(b.result ?? '')
        if (b.name === 'ToolSearch' && /^No matching deferred tools found/.test(result) && !/still connecting/.test(result)) {
          const q = String((b.input as any)?.query ?? '').replace(/^select:/, '')
          if (q) out.push({ id: hash(`${conversationId}|${b.id}`), ts, signal: 'tool-miss', text: one(`looked for a tool: ${q}`), evidence: one(result, 240) })
        } else if (result && UNAVAILABLE.test(result) && !SLIP.test(result) && (b.isError || result.length < 600)) {
          const inp: any = b.input ?? {}
          const what = one(String(inp.command ?? inp.url ?? inp.query ?? inp.name ?? ''), 90) // "Bash failed" alone says nothing; what it ran does
          out.push({ id: hash(`${conversationId}|${b.id}`), ts, signal: 'unavailable', text: one(`${b.name}${what ? ` (${what})` : ''} failed: ${result.match(UNAVAILABLE)?.[0] ?? ''}`), evidence: one(result, 240) })
        }
      } else if (b.type === 'text') {
        for (const re of [SAID, SAID_ALSO]) for (const m of b.text.matchAll(re)) {
          out.push({ id: hash(`${conversationId}|${it.uuid ?? ts}|${m.index}`), ts, signal: 'said', text: one(m[0], 240), evidence: one(b.text.slice(Math.max(0, (m.index ?? 0) - 120), (m.index ?? 0) + 260), 380) })
        }
      }
    }
  }
  return out
}

// Read new transcript bytes for signals. Yields between files so a 50 MB transcript can't freeze the server.
export async function observe(days = 14) {
  let added = 0
  for (const c of all<any>(`select id, path from conversations where source in ('claude', 'posthog-code') and path is not null and updated_at > ?`, Date.now() - days * DAY)) {
    let mtime = 0
    try { mtime = statSync(c.path).mtimeMs } catch { continue }
    if (get<any>('select mtime from wish_files where conversation_id = ?', c.id)?.mtime === mtime) continue
    await new Promise(r => setImmediate(r))
    let items: Item[] = []
    try { items = itemsOf(c.path) } catch { continue }
    for (const s of signalsOf(c.id, items)) {
      added += Number(run(`insert or ignore into capability_wishes (id, conversation_id, need, would_help, suggested, created_at, source, signal, evidence) values (?, ?, ?, '', '', ?, 'observed', ?, ?)`,
        s.id, c.id, s.text, s.ts, s.signal, s.evidence).changes)
    }
    run('insert into wish_files (conversation_id, mtime) values (?, ?) on conflict(conversation_id) do update set mtime = excluded.mtime', c.id, mtime)
  }
  return added
}

const CONDENSE = `AI coding and ops agents work for one engineer. Below are moments where an agent hit the edge of what it could reach, taken from their transcripts, plus things agents reported missing.
Group them into NEEDS: a missing data source, connector, MCP server, permission, credential, or tool that would have let the agent finish the job. Name each need in 3-8 words, specific enough to act on ("Grafana MCP for prod-eu", "read access to Argo CD and Kargo", "production PostHog MCP in Claude sessions"). kind is data (a source or connector), tool (a command or script) or skill (a procedure).
Put a signal in an existing need when it is the same gap. Skip a signal when it is not a capability gap: the agent's own mistake, a one-off network blip, something it simply hadn't tried, a human's opinion, or vague ("I can't see why").
Reply with ONLY JSON: {"assign": [{"signal": "<id>", "need": "<existing need id, or the name of a new one>"}], "new": [{"name": "...", "kind": "data|tool|skill", "suggested": "a product or server that provides it, or empty", "description": "one sentence: what the agent couldn't do without it"}], "skip": ["<id>"]}`

export async function condense(max = 80) {
  const pending = all<any>(`select id, need, would_help, evidence, signal from capability_wishes where group_id is null and created_at > ? order by created_at desc limit ?`, Date.now() - 30 * DAY, max)
  if (!pending.length) return 0
  const known = all<any>(`select id, name, description from wish_groups`)
  const r = await modelJson(`${CONDENSE}\n\n## Existing needs\n${known.map(g => `- ${g.id}: ${g.name} — ${g.description ?? ''}`).join('\n') || 'none yet'}\n\n## Signals\n${pending.map(p => `- ${p.id} [${p.signal ?? 'reported'}]: ${p.need}${p.would_help ? ` (would have helped: ${one(p.would_help, 160)})` : ''}${p.evidence ? ` | context: ${one(p.evidence, 220)}` : ''}`).join('\n')}`)
  const byName = new Map(known.map(g => [g.name.toLowerCase(), g.id]))
  for (const n of r.new ?? []) {
    if (!n?.name || byName.has(String(n.name).toLowerCase())) continue
    const id = `wg_${hash(n.name)}`
    run('insert or ignore into wish_groups (id, name, kind, suggested, description, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
      id, one(String(n.name), 90), ['data', 'tool', 'skill'].includes(n.kind) ? n.kind : 'data', one(String(n.suggested ?? ''), 80), one(String(n.description ?? ''), 240), Date.now(), Date.now())
    byName.set(String(n.name).toLowerCase(), id)
  }
  const ids = new Set(known.map(g => g.id))
  let n = 0
  for (const a of r.assign ?? []) {
    const g = ids.has(a.need) ? a.need : byName.get(String(a.need ?? '').toLowerCase())
    if (!g) continue
    run('update capability_wishes set group_id = ? where id = ?', g, a.signal)
    run('update wish_groups set updated_at = ? where id = ?', Date.now(), g)
    n++
  }
  for (const id of r.skip ?? []) run(`update capability_wishes set group_id = 'skip' where id = ?`, id)
  // Anything the model passed over would be resent every hour; treat it as skipped.
  const seen = new Set([...(r.assign ?? []).map((a: any) => a.signal), ...(r.skip ?? [])])
  for (const p of pending) if (!seen.has(p.id)) run(`update capability_wishes set group_id = 'skip' where id = ? and group_id is null`, p.id)
  return pending.length
}

// Needs, most recurring first, each with how it was seen and a few quotes to check it against.
export function needs() {
  const groups = all<any>(`select g.id, g.name, g.kind, g.suggested, g.description, count(w.id) n, count(distinct w.conversation_id) convs, max(w.created_at) last,
      sum(w.source = 'observed') observed, sum(coalesce(w.source, 'reported') = 'reported') reported
    from wish_groups g join capability_wishes w on w.group_id = g.id where g.status = 'open' group by g.id order by convs desc, n desc, last desc limit 25`)
  for (const g of groups) g.examples = all<any>(`select need, evidence, signal, conversation_id, created_at from capability_wishes where group_id = ? order by created_at desc limit 3`, g.id)
  const meta = get<any>(`select max(created_at) last, sum(created_at > ?) week, sum(group_id is null) pending, sum(source = 'observed') observed, sum(coalesce(source, 'reported') = 'reported') reported from capability_wishes`, Date.now() - 7 * DAY)
  return { groups, meta: { ...meta, lastRun: status.lastRun, error: status.error } }
}

export const ignoreNeed = (id: string) => run(`update wish_groups set status = 'ignored' where id = ?`, id)

export const status = { running: false, lastRun: 0, error: '' }
export async function wishCycle() {
  if (status.running) return
  status.running = true
  try { await observe(); for (let i = 0; i < 10 && await condense(); i++) {} status.error = '' } catch (e: any) { status.error = String(e?.message ?? e).slice(0, 200) } finally { status.running = false; status.lastRun = Date.now() }
}

export function startWishes() {
  setTimeout(() => { if (autonomyOn()) wishCycle() }, 3 * 60_000).unref()
  setInterval(() => { if (autonomyOn()) wishCycle() }, 60 * 60_000).unref()
}
