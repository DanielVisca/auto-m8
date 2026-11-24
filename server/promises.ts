// Agents say "I'll let you know when CI finishes" and then their turn ends: nothing wakes them.
// perch holds those promises and does the waking.
// - Agents in perch chats register one with the follow_up MCP tool: a time, or a PR condition.
// - Promises they only say are caught from the last reply of any recent conversation.
// - When one comes due, a chat perch started is resumed with a follow-up message, so the agent
//   actually checks and reports. Terminal sessions and cloud tasks are never written to behind
//   your back: their overdue promises show in the list and on Home with a "Nudge" button.
import { readFileSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { all, db, get, run } from './db.ts'
import { toItems, itemsOf } from './transcript.ts'

db.exec(`create table if not exists promises (
  id text primary key, conversation_id text not null, text text not null, source text not null,
  due_at integer, pr_url text, until text, status text not null default 'open',
  created_at integer not null, nudged_at integer, attempts integer not null default 0, note text
);
create table if not exists perch_started (id text primary key, at integer)`)
// Who started it: 'you' (typed in perch), or the automation that did (helper, shepherd, routine, ...).
try { db.exec('alter table perch_started add column by text') } catch {}

export const onPromises = new Set<() => void>()
const changed = () => onPromises.forEach(f => f())

export function addPromise(p: { conversation_id: string; text: string; source: 'tool' | 'detected'; due_at?: number | null; pr_url?: string | null; until?: string | null }) {
  const id = createHash('sha1').update(`${p.conversation_id}|${p.text}`).digest('hex').slice(0, 16)
  // A conversation keeps one open promise: a newer one replaces the older.
  run(`update promises set status = 'replaced' where conversation_id = ? and status in ('open', 'waiting') and id != ?`, p.conversation_id, id)
  run(`insert or ignore into promises (id, conversation_id, text, source, due_at, pr_url, until, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    id, p.conversation_id, p.text.slice(0, 400), p.source, p.due_at ?? null, p.pr_url ?? null, p.until ?? null, Date.now())
  changed()
  return id
}

// "I'll let you know", "I'll check back", "once CI is green I'll …": the shapes of a promise to act later.
const PROMISE = /\b(?:I(?:'|’)ll|I will|I'm going to)\s+(?:let you know|report back|check back|check (?:on|in) (?:it|this|again)|ping you|update you|get back to you|follow up|keep an eye|keep watching|monitor|come back|circle back|notify you|tell you (?:when|once|if))|\b(?:once|when|as soon as)\b[^.!?\n]{3,90}\b(?:I(?:'|’)ll|I will)\b/i
const MINUTES = /\bin (?:about |~)?(\d+)\s*(min(?:ute)?s?|h(?:ou)?rs?)\b/i

// Quoted or code text is talk about a promise, not a promise ("they say “I'll let you know…”").
const unquoted = (t: string) => t.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ').replace(/“[^”\n]*”/g, ' ').replace(/"[^"\n]*"/g, ' ').replace(/^>.*$/gm, ' ')

export function detectPromise(conversationId: string, text: string, prs: string[] = []) {
  if (!PROMISE.test(unquoted(text))) return null
  text = unquoted(text)
  const m = text.match(PROMISE)
  if (!m) return null
  const sentence = text.slice(Math.max(0, text.lastIndexOf('\n', m.index!) + 1), text.indexOf('\n', m.index! + m[0].length) >>> 0 || undefined).trim().slice(0, 300) || m[0]
  // The agent registered its own follow-up a moment ago. That one is precise, so this text adds nothing.
  if (get('select 1 from promises where conversation_id = ? and source = ? and created_at > ?', conversationId, 'tool', Date.now() - 15 * 60_000)) return null
  const t = sentence.match(MINUTES)
  const mins = t ? Number(t[1]) * (/^h/i.test(t[2]) ? 60 : 1) : null
  const pr = prNamedIn(sentence, prs)
  const until = pr ? (/merg/i.test(sentence) ? 'merged' : /review|approv/i.test(sentence) ? 'reviewed' : 'checks') : null
  // The condition already holds, so the agent is reporting a finished step, not waiting for one.
  if (pr && until && conditionHolds(pr, until)) return null
  return addPromise({ conversation_id: conversationId, text: sentence, source: 'detected', due_at: Date.now() + (mins ?? (pr ? 90 : 20)) * 60_000, pr_url: pr, until })
}

// Only a PR the sentence names: its full URL, or "#123" matching a PR this conversation touched.
// perch used to guess the chat's first linked PR here. A PR merged earlier in the chat then woke the agent again and again.
function prNamedIn(sentence: string, prs: string[]): string | null {
  const url = sentence.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0]
  if (url) return url
  const n = sentence.match(/#(\d+)\b/)?.[1]
  return n ? prs.find(u => u.endsWith(`/pull/${n}`)) ?? null : null
}

// Same test that due() uses, read from what perch already knows about the PR.
function conditionHolds(url: string, until: string): boolean {
  const pr = get<any>('select state, review, checks from prs where url = ?', url)
  if (!pr) return false
  if (until === 'merged') return !!pr.state && pr.state !== 'OPEN'
  if (until === 'reviewed') return !!pr.review && pr.review !== 'REVIEW_REQUIRED'
  return !!pr.checks && pr.checks !== 'PENDING' && pr.checks !== 'EXPECTED'
}

// Last replies of recently active conversations, for promises nobody registered.
const seenReply = new Map<string, string>()
// Transcripts already read at this size and mtime: re-parsing every active chat's whole transcript
// each minute (tens of MB with ~40 chats) blocked the server for seconds (stall profiles 2026-11-17).
const seenFile = new Map<string, string>()
export function scanForPromises() {
  const rows = all<any>(`select c.id, c.path, c.summary, c.updated_at, (select json_group_array(url) from conversation_prs where conversation_id = c.id) prs
    from conversations c where c.updated_at > ? and (c.path is not null or c.summary is not null)`, Date.now() - 15 * 60_000)
  for (const r of rows) {
    let text = ''
    // Cloud tasks (Slack asks, PostHog Code) have no local transcript: their run summary is the last word.
    if (!r.path || !existsSync(r.path)) text = r.summary ?? ''
    else {
      let items, stamp = ''
      try { const st = statSync(r.path); stamp = `${st.size}:${st.mtimeMs}` } catch { continue }
      if (seenFile.get(r.id) === stamp) continue
      seenFile.set(r.id, stamp)
      try { items = itemsOf(r.path) } catch { continue }
      const last = items.at(-1)
      if (!last || last.kind !== 'assistant') continue
      text = last.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
    }
    if (!text) continue
    const key = createHash('sha1').update(text).digest('hex')
    if (seenReply.get(r.id) === key) continue
    seenReply.set(r.id, key)
    detectPromise(r.id, text, JSON.parse(r.prs ?? '[]').filter(Boolean))
  }
}

const FOLLOW = (p: any, why: string) => `⏰ Follow-up from auto-m8. Earlier you told the user: “${p.text}”
${why}
Check it now and report the result to the user in a few lines. If it isn't done yet, say where it stands, then call the auto-m8 follow_up tool again with a sensible time or condition instead of promising to come back.`

// Is it time? Either the clock ran out, or the PR condition it was waiting on is met.
function due(p: any) {
  if (p.pr_url) {
    const pr = get<any>('select state, checks, review from prs where url = ?', p.pr_url)
    if (pr) {
      if (p.until === 'merged' && pr.state !== 'OPEN') return `#${p.pr_url.split('/').pop()} is now ${pr.state.toLowerCase()}.`
      if (p.until === 'reviewed' && pr.review && pr.review !== 'REVIEW_REQUIRED') return `#${p.pr_url.split('/').pop()} now has a review: ${pr.review.toLowerCase().replace('_', ' ')}.`
      if (p.until === 'checks' && pr.checks && pr.checks !== 'PENDING' && pr.checks !== 'EXPECTED') return `CI on #${p.pr_url.split('/').pop()} finished: ${pr.checks.toLowerCase()}.`
    }
  }
  if (p.due_at && p.due_at <= Date.now()) return p.pr_url ? `It's been a while and #${p.pr_url.split('/').pop()} hasn't reached that point; check where it is.` : 'The time you gave is up.'
  return null
}

// Every minute: settle the promises that were kept, follow up on the ones that came due.
export function tickPromises(opts: { resume: (id: string, prompt: string) => void; isRunning: (id: string) => boolean }) {
  for (const p of all<any>(`select p.*, c.updated_at, c.source from promises p join conversations c on c.id = p.conversation_id where p.status in ('open', 'waiting')`)) {
    // The conversation moved on without a new promise: kept, or the user took it from here.
    const moved = p.updated_at > (p.nudged_at ?? p.created_at) + 90_000
    if (moved && !opts.isRunning(p.conversation_id) && p.status === 'open' && !p.nudged_at && p.source === 'detected') { run(`update promises set status = 'settled' where id = ?`, p.id); continue }
    // After a nudge, any reply that finished counts as following through.
    if (p.nudged_at && p.updated_at > p.nudged_at && !opts.isRunning(p.conversation_id)) { run(`update promises set status = 'kept' where id = ?`, p.id); changed(); continue }
    const why = due(p)
    if (!why || opts.isRunning(p.conversation_id)) continue
    const ours = !!get('select 1 from perch_started where id = ?', p.conversation_id)
    if (ours && p.attempts < 3) {
      opts.resume(p.conversation_id, FOLLOW(p, why))
      run(`update promises set status = 'open', nudged_at = ?, attempts = attempts + 1, note = ? where id = ?`, Date.now(), why, p.id)
    } else if (p.status !== 'waiting') run(`update promises set status = 'waiting', note = ? where id = ?`, why, p.id)
    changed()
  }
}

// You pressed Nudge: follow up now, whatever started the conversation.
export function nudge(id: string, resume: (id: string, prompt: string) => void) {
  const p = get<any>('select p.*, c.updated_at, c.source from promises p join conversations c on c.id = p.conversation_id where p.id = ?', id)
  if (!p) throw new Error('That follow-up is gone.')
  // A conversation that moved in the last few minutes is open somewhere (a terminal, another
  // window). Resuming it from here would fork its history: two processes, one transcript.
  if (!get('select 1 from perch_started where id = ?', p.conversation_id) && Date.now() - p.updated_at < 10 * 60_000)
    throw new Error('That conversation is active right now, probably in a terminal. Nudge it there, or wait until it has been quiet for 10 minutes.')
  resume(p.conversation_id, FOLLOW(p, due(p) ?? 'The user asked you to follow up now.'))
  run(`update promises set status = 'open', nudged_at = ?, attempts = attempts + 1 where id = ?`, Date.now(), id)
  changed()
}
export const dropPromise = (id: string) => { run(`update promises set status = 'dropped' where id = ?`, id); changed() }

export const openPromises = () => all<any>(`select p.*, coalesce(u.title, c.title, c.first_prompt) title from promises p join conversations c on c.id = p.conversation_id
  left join user_state u on u.id = c.id where p.status in ('open', 'waiting') order by coalesce(p.due_at, p.created_at)`)

// Every follow-up a conversation registered lately, whatever became of it (the chat's Waiting card).
export const promisesOf = (id: string) => all<any>(`select id, text, source, due_at, pr_url, until, status, note, nudged_at, created_at from promises
  where conversation_id = ? and created_at > ? order by created_at`, id, Date.now() - 14 * 86400_000)

// For the list rows: each conversation's open promise, cached briefly (rows are built often).
let pm: { at: number; map: Map<string, any> } | null = null
export function promiseFor(id: string) {
  if (!pm || Date.now() - pm.at > 5000) pm = { at: Date.now(), map: new Map(all<any>(`select id, conversation_id, text, due_at, pr_url, until, status, note, nudged_at from promises where status in ('open', 'waiting')`).map(p => [p.conversation_id, p])) }
  return pm.map.get(id) ?? null
}
