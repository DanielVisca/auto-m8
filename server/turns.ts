// Every turn, timed: how long from your message to the agent's answer, how it got there (tools,
// parallel subagents), what kind of ask it was, and whether it held up (your 👍/👎, and whether
// your next message had to correct it). Turbo and normal turns land in the same table, so the
// comparison is like for like. Claude Code sessions outside perch are timed from their transcripts.
import { readFileSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { all, db, get, run } from './db.ts'
import { priceOf } from './spend.ts'

db.exec(`create table if not exists turns (
  id text primary key, conversation_id text not null, sent_at integer not null, started_at integer, first_token_at integer, finished_at integer,
  duration_ms integer, api_ms integer, tools integer default 0, subagents integer default 0, cost real, turbo integer default 0,
  model text, fast text, intent text, ok integer, corrected integer default 0, rating integer, prompt_chars integer, source text default 'perch'
);
create index if not exists turns_conv on turns (conversation_id, sent_at);
create table if not exists chat_prefs (id text primary key, turbo integer)`)

// What kind of ask, from the words: cheap, deterministic, good enough to group by.
const INTENTS: [string, RegExp][] = [
  ['pr', /\b(pr|pull request|merge|ci\b|checks?|shepherd|rebase|push it|stamp|trunk)\b/i],
  ['review', /\b(review|audit|critique|look over)\b/i],
  ['fix', /\b(fix|bug|error|fail(s|ing|ed)?|broken|crash|debug|doesn'?t work|not working)\b/i],
  ['build', /\b(add|implement|build|create|make|refactor|change|update|rename|move|wire)\b/i],
  ['research', /\b(find|search|look up|what (is|are|was|were)|what's|which|how (many|much|do|does|did|is)|why|explain|compare|where|list)\b|\?\s*$/i],
  ['write', /\b(write|draft|summari[sz]e|doc(s|ument)?|message|email|announce)\b/i],
]
export const intentOf = (prompt: string) => INTENTS.find(([, re]) => re.test(prompt))?.[0] ?? 'other'
// Your next message pushing back means the last answer missed.
const CORRECTION = /^\s*(no\b|nope|not quite|that'?s (wrong|not)|wrong\b|didn'?t work|doesn'?t work|still (broken|failing|wrong|not|the same)|undo|revert|try again|actually,?\s|wait,|hold on|stop\b)|\b(that'?s not what i|not what i (asked|meant|wanted)|i (meant|told you|already (said|told you))\b|you (didn'?t|forgot|missed|ignored)\b|why did you\b|why are you\b|you were supposed to)/i

export const isCorrection = (prompt: string) => CORRECTION.test(prompt)
const queue = new Map<string, string[]>() // conversation → open turn ids, oldest first (queued follow-ups)

export function startTurn(conversationId: string, prompt: string, meta: { turbo: boolean; model?: string }) {
  const prev = get<any>(`select id from turns where conversation_id = ? and finished_at is not null order by sent_at desc limit 1`, conversationId)
  if (prev && CORRECTION.test(prompt)) run('update turns set corrected = 1 where id = ?', prev.id)
  const id = randomUUID()
  const q = queue.get(conversationId) ?? []
  run(`insert into turns (id, conversation_id, sent_at, started_at, turbo, model, intent, prompt_chars) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    id, conversationId, Date.now(), q.length ? null : Date.now(), meta.turbo ? 1 : 0, meta.model ?? null, intentOf(prompt), prompt.length)
  queue.set(conversationId, [...q, id])
  return id
}

export function turnEvent(conversationId: string, ev: any, turnId?: string) {
  const id = turnId ?? queue.get(conversationId)?.[0]
  if (!id) return
  if (turnId && !get('select 1 from turns where id = ? and conversation_id = ? and finished_at is null', id, conversationId)) return
  if (ev.type === 'system' && ev.subtype === 'init') run('update turns set fast = ?, model = coalesce(?, model) where id = ?', ev.fast_mode_state ?? null, ev.model ?? null, id)
  else if (ev.type === 'stream_event' && !ev.parent_tool_use_id && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') run('update turns set first_token_at = coalesce(first_token_at, ?) where id = ?', Date.now(), id)
  else if (ev.type === 'assistant') {
    // Codex delivers complete assistant messages rather than text deltas. API error messages and
    // subagent output are not a reply to the user, and must not hide a failed/empty turn.
    if (!ev.parent_tool_use_id && !ev.isApiErrorMessage && !ev.error && (ev.message?.content ?? []).some((b: any) => b.type === 'text' && b.text?.trim()))
      run('update turns set first_token_at = coalesce(first_token_at, ?) where id = ?', Date.now(), id)
    const uses = (ev.message?.content ?? []).filter((b: any) => b.type === 'tool_use')
    if (uses.length) run('update turns set tools = tools + ?, subagents = subagents + ? where id = ?', uses.length, uses.filter((b: any) => b.name === 'Agent' || b.name === 'Task').length, id)
  } else if (ev.type === 'result') {
    const now = Date.now()
    const u = turnUsage(conversationId, ev)
    ev.perch_cost = u.cost; ev.perch_switch = u.switchTokens ? { tokens: u.switchTokens, cost: u.switchCost } : null
    run(`update turns set finished_at = ?, end_reason = 'result', duration_ms = ? - coalesce(started_at, sent_at), api_ms = ?, cost = ?, ok = ?,
         in_tok = ?, out_tok = ?, cache_read = ?, cache_write = ?, models = ?, switch_tok = ?, switch_cost = ?, session_total = ?, session_models = ? where id = ?`,
      now, now, ev.duration_api_ms ?? null, u.cost, ev.is_error ? 0 : 1, u.input, u.output, u.cacheRead, u.cacheWrite, JSON.stringify(u.models), u.switchTokens, u.switchCost, u.total, u.session, id)
    const rest = (queue.get(conversationId) ?? []).filter(open => open !== id)
    queue.set(conversationId, rest)
    if (rest[0]) run('update turns set started_at = ? where id = ?', now, rest[0]) // queued: its clock starts now
  }
}
// After perch restarts, a chat still mid-turn picks its open turns back up, so they finish timed.
export function requeueTurns(conversationId: string) {
  const open = all<any>('select id from turns where conversation_id = ? and finished_at is null order by sent_at', conversationId).map(r => r.id)
  if (open.length) queue.set(conversationId, open)
}
// ---------- usage: what each turn cost, on which models ----------
// Claude Code reports the session's running cost (total_cost_usd) and per-model running totals
// (modelUsage); a long-lived chat process spans many turns, so a turn's own share is the change
// since the last result. "usage" is already per turn: fresh input, output, and context read from
// cache vs written to it. Figures are API-equivalent: on a subscription they aren't billed, but
// they track how fast you use up the plan's limits.
for (const col of ['in_tok integer', 'out_tok integer', 'cache_read integer', 'cache_write integer', 'models text', 'switch_tok integer', 'switch_cost real', 'session_total real', 'session_models text'])
  try { db.exec(`alter table turns add column ${col}`) } catch {}
// Turns recorded before this stored the session's running total as their cost. Turn those back into
// each turn's own share (the change since the previous turn in the same process; a drop means a new
// process). Runs once: repaired rows get session_total.
{
  const old = all<any>(`select id, conversation_id, cost from turns where session_total is null and cost is not null and source = 'perch' order by conversation_id, sent_at`)
  let conv = '', prev = 0
  for (const r of old) {
    if (r.conversation_id !== conv) { conv = r.conversation_id; prev = 0 }
    const own = r.cost >= prev ? r.cost - prev : r.cost
    run('update turns set cost = ?, session_total = ? where id = ?', own, r.cost, r.id)
    prev = r.cost
  }
}
// Repair turns recorded before that: the first turn of a resumed process stored the session's
// lifetime cost. Re-price them from their own tokens. Repaired rows no longer equal session_total,
// so this only touches each row once.
{
  const bad = all<any>(`select t.id, t.cost, t.in_tok, t.out_tok, t.cache_read, t.cache_write, t.models, t.model from turns t
    where t.source = 'perch' and t.cost is not null and t.session_total is not null and abs(t.cost - t.session_total) < 1e-9 and t.cost > 1
      and exists (select 1 from turns p where p.conversation_id = t.conversation_id and p.sent_at < t.sent_at)`)
  for (const r of bad) {
    const own = priceOf(JSON.parse(r.models ?? '[]')[0] ?? r.model ?? '', { input_tokens: r.in_tok, output_tokens: r.out_tok, cache_read_input_tokens: r.cache_read, cache_creation_input_tokens: r.cache_write })
    if (own < r.cost) run('update turns set cost = ? where id = ?', own, r.id)
  }
}
const last = new Map<string, { total: number; byModel: Record<string, number>; model: string | null }>()
function turnUsage(conversationId: string, ev: any) {
  // The previous result's running totals: in memory, or from the last turn (after a restart).
  let prev = last.get(conversationId)
  if (!prev) {
    const t = get<any>('select session_total, session_models from turns where conversation_id = ? and session_total is not null order by sent_at desc limit 1', conversationId)
    if (t) { const sm = JSON.parse(t.session_models ?? '{}'); prev = { total: t.session_total, byModel: sm.byModel ?? {}, model: sm.main ?? null } }
  }
  const total = Number(ev.total_cost_usd ?? 0)
  // A new process starts its totals again from zero.
  const fresh = !prev || total < prev.total - 1e-9
  const byModel: Record<string, number> = Object.fromEntries(Object.entries<any>(ev.modelUsage ?? {}).map(([m, x]) => [m, Number(x.costUSD ?? 0)]))
  const models = Object.keys(byModel).filter(m => byModel[m] - (fresh ? 0 : prev!.byModel[m] ?? 0) > 1e-9)
  const main = models.sort((a, b) => (byModel[b] - (prev?.byModel[b] ?? 0)) - (byModel[a] - (prev?.byModel[a] ?? 0)))[0] ?? prev?.model ?? null
  const us = ev.usage ?? {}
  // A process that resumed an earlier session reports that session's whole history in its first
  // total_cost_usd (a $259 "turn" whose own tokens were worth $2). With an earlier process in this
  // chat (an earlier turn), price the turn's own tokens instead. A brand-new chat's first total is all its own.
  const resumed = fresh && (!!prev || !!get('select 1 from turns where conversation_id = ? and finished_at is not null limit 1', conversationId))
  const cost = Math.max(0, resumed ? Math.min(total, priceOf(main ?? ev.model ?? '', us)) : fresh ? total : total - prev!.total)
  const input = Number(us.input_tokens ?? 0), output = Number(us.output_tokens ?? 0), cacheRead = Number(us.cache_read_input_tokens ?? 0), cacheWrite = Number(us.cache_creation_input_tokens ?? 0)
  // A model switch: the new model has no cache of this conversation, so the whole context is
  // written again. Its share of the turn, by Anthropic's price ratios (cache write 1.25×, cache
  // read 0.1×, output 5× the input price).
  const switched = !!prev?.model && !!main && main !== prev.model
  const weight = input + cacheWrite * 1.25 + cacheRead * 0.1 + output * 5
  const switchTokens = switched && cacheWrite > 5000 ? cacheWrite : 0
  const switchCost = switchTokens && weight ? cost * (cacheWrite * 1.25) / weight : 0
  last.set(conversationId, { total, byModel, model: main })
  return { cost, input, output, cacheRead, cacheWrite, models, switchTokens, switchCost, total, session: JSON.stringify({ byModel, main }) }
}

// How big the conversation's context is now (what a model switch would have to reload).
export const contextTokens = (conversationId: string) => {
  const t = get<any>(`select coalesce(in_tok, 0) + coalesce(cache_read, 0) + coalesce(cache_write, 0) n from turns where conversation_id = ? and finished_at is not null and cache_read is not null order by sent_at desc limit 1`, conversationId)
  return Number(t?.n ?? 0)
}

// One conversation's usage, for its panel.
export function chatUsage(conversationId: string) {
  const rows = all<any>(`select sent_at, model, models, cost, in_tok, out_tok, cache_read, cache_write, switch_tok, switch_cost, prompt_chars from turns
    where conversation_id = ? and finished_at is not null and source = 'perch' order by sent_at`, conversationId)
  const byModel: Record<string, { turns: number; cost: number; tokens: number }> = {}
  for (const r of rows) {
    const m = (JSON.parse(r.models ?? '[]')[0] ?? r.model ?? 'unknown') as string
    const b = byModel[m] ??= { turns: 0, cost: 0, tokens: 0 }
    b.turns++; b.cost += r.cost ?? 0; b.tokens += (r.in_tok ?? 0) + (r.out_tok ?? 0) + (r.cache_read ?? 0) + (r.cache_write ?? 0)
  }
  return {
    turns: rows.length, cost: rows.reduce((x, r) => x + (r.cost ?? 0), 0), context: contextTokens(conversationId),
    byModel: Object.entries(byModel).map(([model, v]) => ({ model, ...v })).sort((a, b) => b.cost - a.cost),
    switches: rows.filter(r => r.switch_tok > 0).map(r => ({ at: r.sent_at, model: JSON.parse(r.models ?? '[]')[0] ?? r.model, tokens: r.switch_tok, cost: r.switch_cost })),
  }
}

// Across all chats, for Settings → Usage.
export function usageSummary(days = 30) {
  const since = Date.now() - days * 86400_000
  const rows = all<any>(`select t.conversation_id id, t.model, t.models, t.cost, t.switch_tok, t.switch_cost, coalesce(u.title, c.title, c.first_prompt) title
    from turns t left join conversations c on c.id = t.conversation_id left join user_state u on u.id = t.conversation_id
    where t.finished_at is not null and t.source = 'perch' and t.sent_at > ? and t.cost is not null`, since)
  const byModel: Record<string, { turns: number; cost: number }> = {}, byChat: Record<string, { title: string; cost: number; turns: number }> = {}
  for (const r of rows) {
    const m = (JSON.parse(r.models ?? '[]')[0] ?? r.model ?? 'unknown') as string
    ;(byModel[m] ??= { turns: 0, cost: 0 }).turns++; byModel[m].cost += r.cost
    const ch = byChat[r.id] ??= { title: String(r.title ?? r.id).slice(0, 80), cost: 0, turns: 0 }
    ch.cost += r.cost; ch.turns++
  }
  const sw = rows.filter(r => r.switch_tok > 0)
  return {
    days, cost: rows.reduce((x, r) => x + r.cost, 0), turns: rows.length,
    byModel: Object.entries(byModel).map(([model, v]) => ({ model, ...v })).sort((a, b) => b.cost - a.cost),
    topChats: Object.entries(byChat).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.cost - a.cost).slice(0, 8),
    switches: { n: sw.length, tokens: sw.reduce((x, r) => x + r.switch_tok, 0), cost: sw.reduce((x, r) => x + (r.switch_cost ?? 0), 0) },
  }
}

// Why a turn ended: 'result' (the agent answered), 'merged' (the message landed mid-turn and the
// agent answered it in that turn's reply), or why perch gave up on it ('exited', 'stall',
// 'request hung', 'died while perch was down'). Without this, every unanswered turn looked alike.
try { db.exec('alter table turns add column end_reason text') } catch {}
export function abandonTurns(conversationId: string, reason = 'abandoned') {
  // At startup the in-memory queue may be empty even though the dead process had open turns.
  run('update turns set ok = 0, finished_at = ?, end_reason = ? where conversation_id = ? and source = \'perch\' and finished_at is null', Date.now(), reason, conversationId)
  queue.delete(conversationId)
}
// The agent finished and went idle with messages still counted as open: Claude Code folded them
// into the turn that just ended (a message sent mid-turn is read between tool calls), so that
// reply answered them too. Close them as answered instead of leaving them to be "abandoned" later.
export function settleTurns(conversationId: string) {
  const open = queue.get(conversationId) ?? []
  for (const id of open) run(`update turns set ok = 1, finished_at = coalesce(finished_at, ?), end_reason = 'merged' where id = ?`, Date.now(), id)
  queue.delete(conversationId)
  return open.length
}

export function rateLast(conversationId: string, rating: 1 | -1 | 0) {
  const t = get<any>(`select id from turns where conversation_id = ? and finished_at is not null order by sent_at desc limit 1`, conversationId)
  if (t) run('update turns set rating = ? where id = ?', rating || null, t.id)
  return { ok: !!t }
}

try { db.exec('alter table chat_prefs add column engine text') } catch {} // which model a chat runs on ('' = Claude)
export const engineFor = (id: string) => String(get<any>('select engine from chat_prefs where id = ?', id)?.engine ?? '')
export const setEngine = (id: string, engine: string) => run('insert into chat_prefs (id, engine) values (?, ?) on conflict(id) do update set engine = excluded.engine', id, engine || null)
export const turboFor = (id: string) => !!get<any>('select turbo from chat_prefs where id = ?', id)?.turbo
export const setTurbo = (id: string, on: boolean) => run('insert into chat_prefs (id, turbo) values (?, ?) on conflict(id) do update set turbo = excluded.turbo', id, on ? 1 : 0)

// Claude Code sessions run in a terminal: time their turns from the transcript (user message →
// last reply before the next one). Read once per file change.
const seen = new Map<string, number>()
function backfill(days: number) {
  for (const c of all<any>(`select id, path from conversations where source in ('claude', 'posthog-code') and path is not null and updated_at > ? and id not in (select id from perch_started)`, Date.now() - days * 86400_000)) {
    let m = 0
    try { m = statSync(c.path).mtimeMs } catch { continue }
    if (seen.get(c.id) === m) continue
    seen.set(c.id, m)
    const turns: any[] = []
    let cur: any = null
    for (const line of readFileSync(c.path, 'utf8').split('\n')) {
      let e: any
      try { e = JSON.parse(line) } catch { continue }
      if (e.isSidechain || !e.timestamp) continue
      const ts = Date.parse(e.timestamp)
      const text = e.type === 'user' && !e.isMeta && e.message?.role === 'user' && (typeof e.message.content === 'string' ? e.message.content : (e.message.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' '))
      if (text && !/^\s*</.test(text)) {
        if (cur) turns.push(cur)
        if (cur && CORRECTION.test(text)) cur.corrected = 1
        cur = { sent: ts, last: null, tools: 0, subagents: 0, intent: intentOf(text), chars: text.length, corrected: 0 }
      } else if (cur && e.type === 'assistant') {
        cur.last = ts
        for (const b of e.message?.content ?? []) if (b.type === 'tool_use') { cur.tools++; if (b.name === 'Agent' || b.name === 'Task') cur.subagents++ }
      }
    }
    if (cur) turns.push(cur)
    run(`delete from turns where conversation_id = ? and source = 'transcript'`, c.id)
    for (const t of turns.filter(t => t.last && t.last > t.sent))
      run(`insert into turns (id, conversation_id, sent_at, started_at, finished_at, duration_ms, tools, subagents, intent, prompt_chars, corrected, ok, source) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'transcript')`,
        randomUUID(), c.id, t.sent, t.sent, t.last, t.last - t.sent, t.tools, t.subagents, t.intent, t.chars, t.corrected)
  }
}

// Turbo vs normal, per kind of ask: median and slow-end time, and how often it held up.
export function turnStats(days = 30) {
  backfill(days)
  const rows = all<any>(`select turbo, intent, duration_ms, first_token_at - started_at ttft, tools, subagents, cost, corrected, rating, ok, source from turns
    where finished_at is not null and duration_ms > 0 and sent_at > ?`, Date.now() - days * 86400_000)
  const q = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }
  const sum = (rs: any[]) => ({
    n: rs.length, median: q(rs.map(r => r.duration_ms), 0.5), p75: q(rs.map(r => r.duration_ms), 0.75), ttft: q(rs.map(r => r.ttft).filter(x => x > 0), 0.5),
    corrected: rs.filter(r => r.corrected).length, down: rs.filter(r => r.rating === -1).length, up: rs.filter(r => r.rating === 1).length, failed: rs.filter(r => r.ok === 0).length,
    subagents: rs.reduce((s, r) => s + (r.subagents ?? 0), 0) / Math.max(1, rs.length), cost: q(rs.map(r => r.cost).filter(x => x != null), 0.5),
  })
  const intents = [...new Set(rows.map(r => r.intent))]
  return {
    days,
    overall: { normal: sum(rows.filter(r => !r.turbo)), turbo: sum(rows.filter(r => r.turbo)) },
    byIntent: intents.map(i => ({ intent: i, normal: sum(rows.filter(r => r.intent === i && !r.turbo)), turbo: sum(rows.filter(r => r.intent === i && r.turbo)) })).sort((a, b) => (b.normal.n + b.turbo.n) - (a.normal.n + a.turbo.n)),
    sources: { perch: rows.filter(r => r.source === 'perch').length, transcript: rows.filter(r => r.source === 'transcript').length },
  }
}
