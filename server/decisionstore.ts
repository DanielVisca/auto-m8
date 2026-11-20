// Decisions: the one queue of things only you can decide. Everything that used to stop and wait
// somewhere you had to go and look (a shepherd's NEEDS YOU, a release waiting for someone's
// approval, an autopilot finding, a question an agent buried at the end of a long reply) becomes
// one item here: a one-line question, the options, perch's recommendation, and the conversation
// that owns the work. It shows at the top of that conversation and on Home; your answer goes back
// into that conversation so the work carries on. No chat or GitHub imports: the MCP process
// (where agents raise decisions) uses this too.
import { randomUUID } from 'node:crypto'
import { all, db, get, run } from './db.ts'
import { askMe, settings } from './settings.ts'

db.exec(`create table if not exists decisions (
  id text primary key,
  key text unique,                 -- what it is about, so the same question is raised once (e.g. gate:<pr url>)
  created_at integer, updated_at integer,
  source text,                     -- shepherd | autopilot | agent | project
  conversation_id text,            -- the conversation that owns the work; the answer goes there
  url text,                        -- the PR or page it is about
  title text not null,             -- the question, one line
  context text,                    -- what perch already found, so you don't have to look
  options text,                    -- json array of short answers
  recommendation text,             -- which option perch would pick, and why in a few words
  status text default 'open',      -- open | answered | resolved (the condition cleared on its own)
  answer text, answered_at integer
)`)
db.exec('create index if not exists decisions_open on decisions(status, conversation_id)')
// Stakes: only 'high' ones reach you. 'low' ones perch decides at once with the recommendation
// (status 'auto') and logs, so you can see and override them. auto_at: when perch stops waiting
// for you and goes with the recommendation (null: it waits for you, for irreversible things).
for (const [col, type] of [['stakes', "text default 'high'"], ['auto_at', 'integer']] as const) {
  try { db.exec(`alter table decisions add column ${col} ${type}`) } catch {}
}
// Decisions raised before stakes existed: the system's own routine ones become low, agents' ones
// get a fresh window from now so nothing is decided behind your back the moment this ships.
try {
  db.exec(`update decisions set stakes = 'low', auto_at = ${Date.now()} where status = 'open' and auto_at is null and (key like 'needs:%' or key like 'unverified:%' or key like 'gate:%' or key like 'autopilot:%' or key like 'perchfix:%')`)
  const h = settings.decisions?.autoAfterHours ?? 4
  if (h > 0 && !get(`select 1 from decisions where auto_at is not null and coalesce(stakes, 'high') = 'high' limit 1`))
    db.exec(`update decisions set auto_at = ${Date.now() + h * 3600_000} where status = 'open' and auto_at is null and coalesce(stakes, 'high') = 'high'`)
} catch {}
// Asking turned off: whatever is still waiting on the user becomes due now (decideDue takes it a couple at a time).
try { if (!askMe()) db.exec(`update decisions set auto_at = ${Date.now()} where status = 'open' and (auto_at is null or auto_at > ${Date.now()})`) } catch {}
db.exec('create table if not exists chat_notices (conversation_id text not null, at integer not null, text text not null)') // chat.ts owns it; the MCP process may get here first

export type Decision = {
  id: string; key: string; created_at: number; updated_at: number; source: string; conversation_id: string | null; url: string | null
  title: string; context: string | null; options: string[]; recommendation: string | null; status: string; answer: string | null; answered_at: number | null
  stakes: 'high' | 'low'; auto_at: number | null
}
const parse = (r: any): Decision => ({ ...r, options: (() => { try { return JSON.parse(r.options ?? '[]') } catch { return [] } })() })

// The conversation that owns a PR: the one that opened it, else the last one that worked on it.
export function ownerOf(url: string): string | null {
  return get<any>(`select conversation_id from conversation_prs cp join conversations c on c.id = cp.conversation_id
                   where cp.url = ? order by cp.created desc, c.updated_at desc limit 1`, url)?.conversation_id ?? null
}

export type Raise = {
  reopen?: boolean; key: string; source: string; title: string; context?: string; options?: string[]; recommendation?: string; conversationId?: string | null; url?: string | null
  stakes?: 'high' | 'low'          // default high; low ones perch decides right away and only logs
  autoAfterMinutes?: number | null // high only: how long perch waits for you before taking the recommendation; 0 = wait for you
}
const autoAt = (d: Raise) => {
  if (d.stakes === 'low' || !askMe()) return Date.now() // not asking the user: perch takes the recommendation now
  const min = d.autoAfterMinutes ?? (settings.decisions?.autoAfterHours ?? 4) * 60
  return min > 0 ? Date.now() + min * 60_000 : null // 0: it waits for you
}

// Raise a decision, once per key. Raising again updates the open one (fresher context). One you
// already answered stays answered (the caller gets your answer back), unless the caller says the
// situation came back (reopen: e.g. "verify it again" and it failed again).
export function raise(d: Raise): Decision {
  const owner = d.conversationId ?? (d.url ? ownerOf(d.url) : null)
  const existing = get<any>('select * from decisions where key = ?', d.key)
  if (existing && existing.status !== 'open' && !d.reopen) return parse(existing)
  // Perch already decided this exact question: the same ask again isn't news.
  if (existing && existing.status === 'auto' && existing.title === d.title) return parse(existing)
  if (existing && existing.status !== 'open') {
    run(`update decisions set status = 'open', answer = null, answered_at = null, created_at = ?, stakes = ?, auto_at = ? where id = ?`, Date.now(), d.stakes ?? 'high', autoAt(d), existing.id)
    existing.status = 'open'
    if (owner && askMe()) run('insert into chat_notices (conversation_id, at, text) values (?, ?, ?)', owner, Date.now(), `Decision needed again: ${d.title}`)
  }
  if (existing) {
    run(`update decisions set title = ?, context = ?, options = ?, recommendation = ?, conversation_id = coalesce(?, conversation_id), url = coalesce(?, url), updated_at = ? where id = ?`,
      d.title, d.context ?? null, JSON.stringify(d.options ?? []), d.recommendation ?? null, owner, d.url ?? null, Date.now(), existing.id)
    changed()
    return parse(get('select * from decisions where id = ?', existing.id))
  }
  const id = randomUUID()
  run(`insert into decisions (id, key, created_at, updated_at, source, conversation_id, url, title, context, options, recommendation, stakes, auto_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, d.key, Date.now(), Date.now(), d.source, owner, d.url ?? null, d.title, d.context ?? null, JSON.stringify(d.options ?? []), d.recommendation ?? null, d.stakes ?? 'high', autoAt(d))
  // A big one shows in the owning conversation's thread as perch's own note; small ones stay quiet.
  if (owner && d.stakes !== 'low' && askMe()) run('insert into chat_notices (conversation_id, at, text) values (?, ?, ?)', owner, Date.now(), `Decision needed: ${d.title}${d.recommendation ? ` (Mothership recommends: ${d.recommendation})` : ''}`)
  changed()
  return parse(get('select * from decisions where id = ?', id))
}

// The condition cleared by itself (the approval came, the PR merged): it leaves the queue.
export function resolveKey(key: string, why = 'resolved on its own') {
  if (run(`update decisions set status = 'resolved', answer = ?, answered_at = ?, updated_at = ? where key = ? and status = 'open'`, why, Date.now(), Date.now(), key).changes) changed()
}

// Something changed in the queue: main broadcasts it to the UI (the MCP process can't, so main
// also notices those within a few seconds by polling the count).
export const onDecision = new Set<() => void>()
const changed = () => onDecision.forEach(f => f())

// What reaches you: open and high stakes. Low ones are perch's to decide (see due()).
export const openDecisions = () => all<any>(`select * from decisions where status = 'open' and coalesce(stakes, 'high') = 'high' order by created_at desc`).map(parse)
export const decisionsFor = (conversationId: string) => all<any>(`select * from decisions where conversation_id = ? and status = 'open' and coalesce(stakes, 'high') = 'high' order by created_at`, conversationId).map(parse)
// Open ones whose wait is over, oldest first: perch decides them now.
export const dueDecisions = (now = Date.now()) => all<any>(`select * from decisions where status = 'open' and auto_at is not null and auto_at <= ? order by auto_at`, now).map(parse)
// What perch decided for you lately, so you can see it and change your mind.
export const autoDecided = (since = Date.now() - 3 * 86400_000) => all<any>(`select * from decisions where status = 'auto' and answered_at > ? order by answered_at desc limit 50`, since).map(parse)
export function markAuto(id: string, answer: string) {
  run(`update decisions set status = 'auto', answer = ?, answered_at = ?, updated_at = ? where id = ?`, answer, Date.now(), Date.now(), id)
  changed()
}
// The recommendation as one of the options when it starts with one ("Merge #1: because…" → "Merge #1").
export function recommendedOption(d: Pick<Decision, 'options' | 'recommendation'>): string | null {
  if (!d.recommendation) return null
  const r = d.recommendation.toLowerCase()
  return [...d.options].sort((a, b) => b.length - a.length).find(o => r.startsWith(o.toLowerCase()) || r.startsWith(o.toLowerCase().split(':')[0])) ?? d.recommendation
}
export const decision = (id: string) => { const r = get<any>('select * from decisions where id = ?', id); return r ? parse(r) : null }
export function markAnswered(id: string, answer: string) {
  run(`update decisions set status = 'answered', answer = ?, answered_at = ?, updated_at = ? where id = ?`, answer, Date.now(), Date.now(), id)
}
