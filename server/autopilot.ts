// Autopilot: an always-on agent that watches how you work, proposes automations you can turn on
// in one click, and keeps owning them afterwards: it records every run, flags failures and
// stalls as Needs me, pauses an automation that keeps failing or runs without doing anything,
// and graduates one that proves itself. Ownership doesn't end at creation.
import { randomUUID } from 'node:crypto'
import { ephemeral, PERCH_MCP, runningChats, subscribe } from './chat.ts'
import { ALLOWED } from './seek.ts'
import { list, saveRule, setStates } from './conversations.ts'
import { link } from './context.ts'
import { judgeSuggestion } from './compare.ts'
import { all, db, get, once, run } from './db.ts'
import { posthogStatus } from './indexer.ts'
import { scouts } from './posthog.ts'
import { listRoutines, RUN_COST, saveRoutine } from './routines.ts'
import { autonomyOn, HOME, settings } from './settings.ts'
import { recordError, resolveErrors } from './errors.ts'
import { useCaseDigest } from './evolve.ts'
import { findingToDecision, selfFix } from './selffix.ts'

db.exec(`
create table if not exists suggestions (
  id text primary key, created_at integer, status text default 'open', -- open | accepted | dismissed
  kind text, title text, why text, evidence text, payload text, created_ref text
);
create table if not exists routine_runs (
  id text primary key, routine_id text not null, conversation_id text, started_at integer, finished_at integer,
  outcome text default 'running', -- running | ok | error | stalled | noop
  detail text, cost real
);
create index if not exists routine_runs_routine on routine_runs(routine_id, started_at desc);
`)
for (const sql of [
  'alter table routines add column watch_until integer', // watched closely until then
  'alter table routines add column trusted integer default 0',
  'alter table routines add column paused_reason text',
  'alter table routines add column suggestion_id text',
]) { try { db.exec(sql) } catch {} }

const DAY = 86400_000
export const onAutopilot = new Set<() => void>()
const changed = () => onAutopilot.forEach(f => f())
export const status = { scanning: false, lastScan: 0, error: '' }

// ---------- owning what runs ----------
// Every routine run is recorded and followed to its end. "noop" is a run whose answer says there
// was nothing to do: harmless once, a sign of a runaway schedule if it is all a routine ever does.
const NOOP = /\b(nothing to do|no action needed|no changes?( needed)?|nothing new|already (merged|closed|done)|no new)\b/i

export function trackRun(routineId: string, conversationId: string) {
  const id = randomUUID()
  run('insert into routine_runs (id, routine_id, conversation_id, started_at) values (?, ?, ?, ?)', id, routineId, conversationId, Date.now())
  let text = ''
  const unsub = subscribe(conversationId, ev => {
    if (ev.type === 'stream_event' && ev.event?.delta?.type === 'text_delta') text += ev.event.delta.text
    if (ev.type === 'result') {
      const denied = ev.permission_denials?.length ?? 0
      const outcome = ev.is_error ? 'error' : denied ? 'error' : NOOP.test(text.slice(-1500)) ? 'noop' : 'ok'
      finish(id, outcome, ev.is_error ? String(ev.result ?? ev.subtype).slice(0, 300) : denied ? `${denied} tool calls denied by permission mode` : text.slice(-300), ev.total_cost_usd)
      unsub()
    }
    if (ev.type === 'perch_error') { finish(id, 'error', String(ev.message).slice(0, 300)); unsub() }
  }, { background: true })
}

function finish(runId: string, outcome: string, detail: string, cost?: number) {
  const r = get<any>('select * from routine_runs where id = ?', runId)
  // A late result overrides 'stalled': the watchdog's call was a guess, the result is the answer.
  if (!r || (r.outcome !== 'running' && !(r.outcome === 'stalled' && outcome !== 'stalled'))) return
  run('update routine_runs set outcome = ?, finished_at = ?, detail = ?, cost = ? where id = ?', outcome, Date.now(), detail, cost ?? null, runId)
  run('update routines set last_status = ? where id = ?', outcome, r.routine_id)
  // The run came back after all: take back the "automation stalled" ask the watchdog raised.
  if (r.outcome === 'stalled') run(`update user_state set state = null, note = null, state_at = ? where id = ? and state = 'waiting' and state_auto = 2 and note like 'automation stalled%'`, Date.now(), r.conversation_id)
  // A failed or stalled run needs you: its conversation goes to Needs me with the reason.
  if (outcome === 'error' || outcome === 'stalled') {
    run('insert into user_state (id) values (?) on conflict do nothing', r.conversation_id)
    run(`update user_state set state = 'waiting', state_auto = 2, note = ?, state_at = ? where id = ?`, `automation ${outcome}: ${detail}`.slice(0, 300), Date.now(), r.conversation_id)
  }
  review(r.routine_id)
  changed()
}

// Health decides what happens next: pause after 3 failures in a row, or after 8 runs in a row
// that found nothing to do (the babysitter-loop failure mode); graduate after 5 clean runs.
export function review(routineId: string) {
  const routine = get<any>('select * from routines where id = ?', routineId)
  if (!routine) return
  const runs = all<any>('select outcome from routine_runs where routine_id = ? and outcome != ? order by started_at desc limit 10', routineId, 'running').map(r => r.outcome)
  const streak = (o: string[]) => { let n = 0; for (const x of runs) { if (o.includes(x)) n++; else break } return n }
  if (routine.enabled && streak(['error', 'stalled']) >= 3) pause(routineId, '3 failed or stalled runs in a row')
  else if (routine.enabled && streak(['noop']) >= 8) pause(routineId, '8 runs in a row found nothing to do')
  else if (!routine.trusted && runs.length >= 5 && runs.slice(0, 5).every(o => o === 'ok' || o === 'noop') && runs.slice(0, 5).some(o => o === 'ok')) {
    run('update routines set trusted = 1 where id = ?', routineId)
  }
}

function pause(routineId: string, reason: string) {
  run('update routines set enabled = 0, paused_reason = ? where id = ?', reason, routineId)
  const last = get<any>('select conversation_id from routine_runs where routine_id = ? order by started_at desc limit 1', routineId)
  if (last?.conversation_id) {
    run('insert into user_state (id) values (?) on conflict do nothing', last.conversation_id)
    run(`update user_state set state = 'waiting', state_auto = 2, note = ?, state_at = ? where id = ?`, `autopilot paused this automation: ${reason}`, Date.now(), last.conversation_id)
  }
}

// A run with no result after 30 minutes and no live process is stalled. One whose agent is still
// working is not: the blog workshop, montage and long scouts take 40 minutes to 3 hours and used
// to be marked stalled (then paused) while they were still going, their real answers thrown away.
// A live agent still gets a ceiling, so a hung process can't hold a run open forever.
export const STALL_MS = 30 * 60_000, LIVE_CEILING_MS = 4 * 60 * 60_000
export function stalledRuns<T extends { started_at: number, conversation_id: string }>(runs: T[], working: Set<string>, now = Date.now()) {
  return runs.filter(r => now - r.started_at > (working.has(r.conversation_id) ? LIVE_CEILING_MS : STALL_MS))
}
export function watchdog() {
  const working = new Set(runningChats().filter(c => c.live && c.state === 'running').map(c => c.id))
  const open = all<any>(`select * from routine_runs where outcome = 'running' and started_at < ?`, Date.now() - STALL_MS)
  for (const r of stalledRuns(open, working)) {
    finish(r.id, 'stalled', working.has(r.conversation_id) ? `still running after ${LIVE_CEILING_MS / 3_600_000} hours` : 'no result after 30 minutes and no live agent')
  }
}

export function health() {
  return listRoutines().map((r: any) => {
    const runs = all<any>(`select outcome, started_at, finished_at, conversation_id, detail, ${RUN_COST} cost from routine_runs where routine_id = ? order by started_at desc limit 12`, r.id)
    const week = all<any>(`select count(*) n, sum(${RUN_COST}) cost, sum(outcome in ('error', 'stalled')) bad from routine_runs where routine_id = ? and started_at > ?`, r.id, Date.now() - 7 * DAY)[0]
    const watching = r.watch_until && r.watch_until > Date.now() && !r.trusted
    return { ...r, runs, week, phase: !r.enabled ? (r.paused_reason ? 'paused by autopilot' : 'off') : r.trusted ? 'trusted' : watching ? 'watching' : 'running' }
  })
}

// ---------- noticing what to automate ----------
// Which automation a run belongs to. Scout and workflow titles share a long prefix
// ("[sandbox_prompt:signals_scout:<skill>] You are…"), so grouping by the first 30 characters
// lumped every scout into one and made one look like it ran 250 times a week. Group by the part
// in brackets when there is one.
export const RUN_KEY = `case when title like '[%]%' then substr(title, 1, instr(title, ']')) else substr(title, 1, 40) end`
async function digest() {
  const since = Date.now() - 21 * DAY
  const repeats = all<any>(`select lower(substr(first_prompt, 1, 70)) prefix, count(*) n, group_concat(id) ids from conversations
                            where started_at > ? and first_prompt is not null and source != 'posthog-task' group by lower(substr(first_prompt, 1, 40)) having n > 1 order by n desc limit 15`, since)
  const asks = all<any>(`select title, origin, started_at, id from conversations where source = 'posthog-task' and started_at > ? and origin in ('slack', 'user_created') order by started_at desc limit 40`, since)
  const autoRuns = all<any>(`select origin, count(*) n, count(distinct title) targets, max(started_at) last_at, sum(coalesce(cost, 0)) cost, min(title) example from conversations where source = 'posthog-task' and started_at > ? and origin not in ('slack', 'user_created') group by origin, ${RUN_KEY} order by n desc limit 15`, Date.now() - 7 * DAY)
  const skills = all<any>(`select detail, count(*) n from tool_calls where name = 'Skill' and detail is not null and ts > ? group by detail order by n desc limit 12`, since)
  const hours = all<any>(`select cast(strftime('%w', started_at / 1000, 'unixepoch', 'localtime') as int) dow, cast(strftime('%H', started_at / 1000, 'unixepoch', 'localtime') as int) h, count(*) n from conversations where started_at > ? group by dow, h order by n desc limit 8`, since)
  let myScouts = ''
  try {
    if (posthogStatus.user) {
      const s = await scouts.list({ mine: true })
      myScouts = s.results.map((x: any) => `- ${x.display_name || x.skill_name}: ${x.enabled === false || x.status === 'paused' ? 'paused' : 'on'}, ${x.run_cron_schedule ?? (x.run_interval_minutes ? `every ${x.run_interval_minutes}m` : 'no schedule')}, failures in a row ${x.consecutive_failure_count ?? 0}, last run ${x.last_run_at ?? 'never'}`).join('\n')
    }
  } catch {}
  const mine = health().map(r => `- ${r.name} [${r.phase}] ${r.cron ?? 'webhook'}: last runs ${r.runs.map((x: any) => x.outcome).join(',') || 'none'}; 7d ${r.week.n} runs $${(r.week.cost ?? 0).toFixed(2)}`).join('\n')
  const past = all<any>(`select title, status from suggestions order by created_at desc limit 30`).map(s => `- [${s.status}] ${s.title}`).join('\n')
  const broken = all<any>(`select source, message, count from errors where status != 'resolved' and count >= 3 and last_at > ?`, Date.now() - DAY).map(e => `- ${e.source}: ${e.message} (${e.count}× today)`).join('\n')
  return [
    `Today is ${new Date().toDateString()}. Default folder: ${settings.chat.cwd}.`,
    `## Requests that repeat (first words, count, ids)\n${repeats.map(r => `- ${r.n}× "${r.prefix}" ids=${String(r.ids).split(',').slice(0, 4).join(',')}`).join('\n') || 'none'}`,
    `## Recent asks to the PostHog agent (Slack, desktop)\n${asks.map(a => `- ${new Date(a.started_at).toISOString().slice(0, 16)} ${String(a.title).slice(0, 140)} (id=${a.id})`).join('\n') || 'none'}`,
    `## Automated runs in the last 7 days (origin, count, distinct titles, last run, cost, example). A bucket with many distinct titles is many targets: never blame its example. A last run older than a day means the schedule already stopped, so it is not burning money\n${autoRuns.map(a => `- ${a.origin} ${a.n} runs across ${a.targets} distinct titles, last run ${new Date(a.last_at).toISOString().slice(0, 16)}, $${(a.cost ?? 0).toFixed(2)}: ${String(a.example).slice(0, 90)}`).join('\n') || 'none'}`,
    `## Skills used\n${skills.map(s => `- ${s.detail}: ${s.n}`).join('\n') || 'none'}`,
    `## When work starts (weekday 0=Sun, hour, count)\n${hours.map(h => `- ${h.dow} ${h.h}:00 ${h.n}`).join('\n')}`,
    `## My PostHog scouts\n${myScouts || 'none'}`,
    `## auto-m8 routines already running\n${mine || 'none'}`,
    `## Suggestions already made (don't repeat these)\n${past || 'none'}`,
    `## auto-m8 errors that keep recurring (flag the ones the user must fix)\n${broken || 'none'}`,
    `## Use cases: the jobs the user hands to agents, from every ask in the last 30 days (evolve writes skills for these; you propose the schedules that run them)\n${(() => { try { return useCaseDigest() } catch { return '' } })() || 'none yet'}`,
  ].join('\n\n')
}

const PROMPT = `You are the user's automation autopilot. Read how they work below and propose at most 4 automations that would save them real, repeated effort. Also flag automations that are failing, idle, or burning money doing nothing (for example schedules that keep running after their job is done).

Reply with ONLY a JSON array. Each item is one of:
{"kind": "routine", "title": "...", "why": "the evidence, with counts", "evidence": ["conversation ids"], "risk": "low" | "high", "blast": "one line: what it can change, where", "what": "one plain sentence for the user: what they will get, when, and where it shows up (e.g. 'Every Friday at 16:00 you get a short summary of your week in perch: what shipped, what stalled, which automations did nothing.')", "ask": "one friendly sentence to ask the user, naming the repetition (e.g. 'You asked for a PR shepherd 20 times: want me to check your open PRs every 2 hours and shepherd the ones with failing CI?')", "routine": {"name": "...", "prompt": "a complete, self-contained instruction for Claude Code, including when to stop and what to report", "cwd": "folder", "cron": "5-field cron, local time", "mode": "fresh"}}
RISK: "low" only when the routine just reads and reports (summaries, checks, digests, local notes): nothing pushed, commented, merged, posted, or changed in GitHub, Slack or PostHog. Anything that writes outside this machine, or could touch production, is "high".
{"kind": "rule", "title": "...", "why": "...", "evidence": [], "rule": {"name": "...", "query": "auto-m8 search, e.g. #label repo:x in:code older:7d", "action": "label|archive|snooze", "value": "label or days"}}
{"kind": "attention", "title": "...", "why": "what is wrong and what to do", "evidence": [], "link": "optional URL"}
Prefer: things asked 3+ times, daily or weekly check-ins, PR follow-ups, and cleanup. Use cases with many asks, or with dropped work (agents that stopped before finishing), are the strongest candidates for a schedule that does the job before the user asks; if an autom8-* or perch-* skill exists for it, have the routine use that skill. A routine prompt must be safe to run unattended: read, check, summarise, open drafts. Never merge, delete, or post publicly without asking.
NO PARALLEL WORK: before proposing anything, check the scouts, routines, automated runs and recent asks listed below. If something already covers it, don't propose a new one; at most propose extending that one (kind "attention", saying exactly which existing item to change and how). Return [] if nothing is worth it.`

// ---------- no parallel work ----------
const STOPW = new Set('the and for with from your my that this what when each into about over run runs report weekly daily every check read only last days week'.split(' '))
const keywords = (t: string) => [...new Set(String(t).toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [])].filter(w => !STOPW.has(w))
const jaccard = (a: string[], b: string[]) => { const A = new Set(a), B = new Set(b); const i = [...A].filter(x => B.has(x)).length; return i / Math.max(1, new Set([...A, ...B]).size) }

// Everything that might already do what a suggestion proposes: threads (including automated
// runs and Slack asks), your scouts, and perch routines.
async function overlapsFor(text: string) {
  const kw = keywords(text).slice(0, 10)
  const out: { kind: string; id: string; title: string; score: number }[] = []
  if (kw.length) {
    for (const c of list({ q: `${kw.slice(0, 4).join(' ')} is:any`, sort: 'relevance', limit: 6, focus: false }).conversations) {
      out.push({ kind: c.automated ? 'automated run' : 'thread', id: c.id, title: String(c.title ?? c.first_prompt).slice(0, 100), score: jaccard(kw, keywords(`${c.title} ${c.first_prompt}`)) })
    }
  }
  try {
    for (const sc of (await scouts.list({})).results) {
      const score = jaccard(kw, keywords(`${sc.display_name} ${sc.skill_name} ${sc.description}`))
      if (score > 0.12) out.push({ kind: sc.mine ? 'your scout' : 'team scout', id: sc.id, title: sc.display_name || sc.skill_name, score })
    }
  } catch {}
  for (const r of listRoutines()) {
    const score = jaccard(kw, keywords(`${r.name} ${r.prompt}`))
    if (score > 0.15) out.push({ kind: 'routine', id: r.id, title: r.name, score })
  }
  return out.filter(o => o.score > 0.08).sort((a, b) => b.score - a.score).slice(0, 6)
}

const VERIFY = `You review proposed automations against what the user already has, to stop parallel work. For each proposal, look at its possible overlaps and decide:
- "new": nothing existing really covers it.
- "extend": an existing item covers most of it; say which one and what to change instead.
- "drop": it duplicates something that already exists.
Reply with ONLY JSON: [{"index": 0, "verdict": "new|extend|drop", "note": "one sentence for the user"}]`

async function verify(items: any[]) {
  const withOverlaps = await Promise.all(items.map(async it => ({ it, overlaps: await overlapsFor(`${it.title} ${it.why} ${it.routine?.prompt ?? ''} ${it.rule?.query ?? ''}`) })))
  if (!withOverlaps.some(x => x.overlaps.length)) return withOverlaps.map(x => ({ ...x, verdict: 'new', note: '' }))
  const text = withOverlaps.map((x, i) => `### ${i}. ${x.it.title}\n${x.it.why}\n${x.it.routine?.prompt ?? ''}\nPossible overlaps:\n${x.overlaps.map(o => `- ${o.kind}: ${o.title}`).join('\n') || '- none'}`).join('\n\n')
  const verdicts: any[] = await new Promise(resolve => {
    let out = ''
    ephemeral(['-p', `${VERIFY}\n\n${text}`, '--output-format', 'stream-json', '--verbose', '--model', settings.ai.model, '--no-session-persistence',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk'], settings.chat.cwd, ev => {
      if (ev.type === 'result') out = String(ev.result ?? '')
      if (ev.type === 'perch_done') { try { resolve(JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1))) } catch { resolve([]) } }
    })
  })
  return withOverlaps.map((x, i) => {
    const v = verdicts.find(v => v.index === i)
    return { ...x, verdict: v?.verdict ?? (x.overlaps.length ? 'extend' : 'new'), note: v?.note ?? '' }
  })
}

// Duplicates found without a model: two runs on the same PR, threads that open with the same
// ask, routines with near-identical prompts. Each becomes a one-click consolidation.
export function findDuplicates() {
  const found: { title: string; why: string; keep: string; merge: string[]; pause?: string[] }[] = []
  const linked = (a: string, b: string) => !!get('select 1 from links where (a = ? and b = ?) or (a = ? and b = ?)', a, b, b, a)
  const sameLineage = (a: string, b: string) => !!get('select 1 from conversations x join conversations y on x.root_uuid = y.root_uuid where x.id = ? and y.id = ? and x.root_uuid is not null', a, b)
  // Keep only members that aren't already connected to the first one (linked, or one history).
  const unconnected = (ids: string[]) => ids.filter((id, i) => i === 0 || !ids.slice(0, i).some(o => linked(id, o) || sameLineage(id, o)))

  // Runs on one PR are duplicates only when they overlap in time. Back-to-back runs are a
  // schedule (one loop), which autopilot watches as a runaway risk instead.
  for (const g of all<any>(`select cp.url, c.origin, group_concat(c.id) ids, count(*) n from conversation_prs cp join conversations c on c.id = cp.conversation_id
                            left join user_state u on u.id = c.id
                            where c.source = 'posthog-task' and coalesce(u.state, '') not in ('archived', 'hidden') and c.updated_at > ?
                            group by cp.url, c.origin having n > 1`, Date.now() - 14 * DAY)) {
    const runs = all<any>(`select id, started_at, updated_at, status from conversations where id in (${String(g.ids).split(',').map(() => '?').join(',')}) order by started_at`, ...String(g.ids).split(','))
    const overlapping = new Set<string>()
    for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
      const end = runs[i].status === 'in_progress' ? Date.now() : runs[i].updated_at
      if (runs[j].started_at < end - 60_000) { overlapping.add(runs[i].id); overlapping.add(runs[j].id) }
    }
    const ids = unconnected([...overlapping].sort((a, b) => runs.find(r => r.id === b).updated_at - runs.find(r => r.id === a).updated_at))
    if (ids.length > 1) found.push({ title: `${ids.length} ${g.origin} runs on ${g.url.replace('https://github.com/', '')} at the same time`, why: 'They overlapped: two agents working the same PR at once. Keep the newest and archive the others.', keep: ids[0], merge: ids.slice(1) })
  }
  for (const g of all<any>(`select lower(substr(first_prompt, 1, 60)) k, group_concat(c.id) ids, count(*) n from conversations c left join user_state u on u.id = c.id
                            where c.started_at > ? and length(c.first_prompt) > 25 and c.source != 'posthog-task' and coalesce(u.state, '') not in ('archived', 'hidden')
                            group by k having n > 1`, Date.now() - 21 * DAY)) {
    const ids = unconnected(all<any>(`select id from conversations where id in (${String(g.ids).split(',').map(() => '?').join(',')}) order by updated_at desc`, ...String(g.ids).split(',')).map((r: any) => r.id))
    if (ids.length > 1) found.push({ title: `${ids.length} threads asking “${String(g.k).slice(0, 50)}…”`, why: 'The same ask was started more than once. Compare them, then link or keep working in one.', keep: ids[0], merge: ids.slice(1) })
  }
  const routines = listRoutines().filter(r => r.enabled)
  for (let i = 0; i < routines.length; i++) for (let j = i + 1; j < routines.length; j++) {
    const a = routines[i], b = routines[j]
    if (jaccard(keywords(a.prompt), keywords(b.prompt)) > 0.55) found.push({ title: `Routines “${a.name}” and “${b.name}” do the same thing`, why: 'Their prompts mostly overlap. Keep the newer one and pause the other.', keep: a.id, merge: [], pause: [b.id] })
  }
  // Suggestions that no longer hold (now linked, or a schedule rather than duplicates) dismiss themselves.
  const still = new Set(found.map(f => f.title))
  for (const s of all<any>(`select id, title from suggestions where status = 'open' and kind = 'consolidate'`)) {
    if (!still.has(s.title)) run(`update suggestions set status = 'dismissed', payload = json_set(coalesce(payload, '{}'), '$.auto', 'no longer duplicates (linked, or a schedule)') where id = ?`, s.id)
  }
  let added = 0
  for (const d of found) {
    if (get('select 1 from suggestions where title = ?', d.title)) continue
    const sid = randomUUID()
    run(`insert into suggestions (id, created_at, kind, title, why, evidence, payload) values (?, ?, 'consolidate', ?, ?, ?, ?)`, sid, Date.now(), d.title, d.why, JSON.stringify([d.keep, ...d.merge]), JSON.stringify(d))
    // Judge whether they really are the same work; confident answers act on their own.
    if (d.merge.length) judgeSuggestion(sid, [d.keep, ...d.merge]).then(changed).catch(() => {})
    added++
  }
  if (added) changed()
  return added
}

export function scan(): Promise<number> {
  if (status.scanning) return Promise.resolve(0)
  status.scanning = true
  changed()
  return digest().then(d => new Promise<number>(resolve => {
    let out = ''
    ephemeral(['-p', `${PROMPT}\n\n${d}`, '--output-format', 'stream-json', '--verbose', '--model', settings.ai.model, '--no-session-persistence',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk'], settings.chat.cwd, ev => {
      if (ev.type === 'result') out = String(ev.result ?? '')
      if (ev.type !== 'perch_done') return
      status.lastScan = Date.now()
      let items: any[] = []
      try { items = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1)); resolveErrors('Autopilot') }
      catch { status.error = recordError('Autopilot', new Error(ev.error || `unreadable reply: ${out.slice(0, 160)}`), 'The autopilot scan').message }
      status.scanning = true // still verifying
      const seen = new Set(all<any>('select lower(title) t from suggestions').map(r => r.t))
      const fresh = items.filter(it => it?.title && !seen.has(String(it.title).toLowerCase()))
      // Every proposal is checked against what already exists before you see it.
      verify(fresh).then(checked => {
        let n = 0
        for (const { it, overlaps, verdict, note } of checked) {
          if (verdict === 'drop') continue
          const payload = { ...(it.routine ?? it.rule ?? { link: it.link }), overlaps, verdict, note, risk: it.risk ?? 'high', blast: it.blast ?? '', ask: it.ask ?? '', what: it.what ?? '' }
          const sid = randomUUID()
          run('insert into suggestions (id, created_at, kind, title, why, evidence, payload) values (?, ?, ?, ?, ?, ?, ?)', sid, Date.now(), it.kind, it.title, it.why ?? '', JSON.stringify(it.evidence ?? []), JSON.stringify(payload))
          // A finding goes to your decision queue, where you answer it in one click, not to a tab.
          if (it.kind === 'attention') findingToDecision({ id: sid, title: it.title, why: it.why ?? '', link: it.link })
          // Self-driving where it is safe: a new, read-only routine is set up without asking
          // (and still watched, paused or graduated like any other). Anything that writes asks first.
          if (it.kind === 'routine' && verdict === 'new' && it.risk === 'low') {
            try { accept(sid); run(`update suggestions set payload = json_set(payload, '$.auto', 'set up for you') where id = ?`, sid) } catch {}
          }
          n++
        }
        n += findDuplicates()
        if (items.length || !status.error) status.error = ''
        status.scanning = false
        changed()
        resolve(n)
      })
    })
  }))
}

// One click: turn a suggestion into a running automation, watched closely for a week.
export function accept(id: string, edits: Record<string, any> = {}) {
  const s = get<any>('select * from suggestions where id = ?', id)
  if (!s) throw new Error('unknown suggestion')
  const payload = { ...JSON.parse(s.payload ?? '{}'), ...edits }
  let ref: string | null = null
  if (s.kind === 'routine') {
    const r = saveRoutine({ name: payload.name ?? s.title, prompt: payload.prompt, cwd: payload.cwd ?? settings.chat.cwd, cron: payload.cron, mode: payload.mode ?? 'fresh', enabled: 1 })
    run('update routines set watch_until = ?, suggestion_id = ? where id = ?', Date.now() + 7 * DAY, id, r.id)
    ref = r.id
  } else if (s.kind === 'rule') {
    ref = saveRule({ name: payload.name ?? s.title, query: payload.query, action: payload.action, value: payload.value })
  } else if (s.kind === 'consolidate') {
    // Keep one, link the others to it, archive them; pause duplicate routines.
    for (const m of payload.merge ?? []) link(m, payload.keep, 'continues', 'consolidated by autopilot')
    if (payload.merge?.length) setStates(payload.merge, { state: 'archived' })
    for (const r of payload.pause ?? []) run(`update routines set enabled = 0, paused_reason = 'duplicate: consolidated by autopilot' where id = ?`, r)
    ref = payload.keep
  }
  run(`update suggestions set status = 'accepted', created_ref = ? where id = ?`, ref, id)
  changed()
  return { ref }
}

export function dismiss(id: string) { run(`update suggestions set status = 'dismissed' where id = ?`, id); changed() }

// "Not now": ask again tomorrow.
export function later(id: string) { run(`update suggestions set payload = json_set(payload, '$.askAfter', ?) where id = ?`, Date.now() + DAY, id); changed() }

// Undo something autopilot set up on its own: the routine goes, the suggestion is marked dismissed.
export function undo(id: string) {
  const s = get<any>('select * from suggestions where id = ?', id)
  if (s?.created_ref) run('delete from routines where id = ?', s.created_ref)
  run(`update suggestions set status = 'dismissed', payload = json_set(payload, '$.auto', 'undone by you') where id = ?`, id)
  changed()
}

// A rehearsal: the routine's prompt once, read-only, reporting what it would do. Nothing is created.
export function dryRun(id: string, l: (ev: any) => void) {
  const s = get<any>('select * from suggestions where id = ?', id)
  const p = JSON.parse(s?.payload ?? '{}')
  if (!s || !p.prompt) { setTimeout(() => l({ type: 'perch_done', code: 1, error: 'That suggestion has no automation to rehearse.' }), 0); return () => {} }
  const prompt = `PREVIEW RUN of an automation the user is deciding whether to turn on. Do the automation for real, right now, and reply with exactly what a real run would produce (if it writes a report, the reply IS that report, not a description of it).
- Do every read for real. Never describe a check you could run: run it.
- The only difference from a real run: anything that would change something (comment, push, merge, label, post, create or start a task) is NOT done. List each one at the end under "Would have done", with its target.
- For PostHog tasks, scouts, workflows and routines, use the auto-m8 recent_activity tool. For PRs, use open_prs, then gh for anything more (shape output with gh's own --json/--jq flags: piping into python, node or other programs is blocked here).
- If a source fails (e.g. a GitHub 5xx), retry it once. If it still fails, finish with what you have and add one line naming what's missing.

The automation:
${p.prompt ?? s?.title}`
  return ephemeral(['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', settings.ai.model, '--no-session-persistence',
    '--permission-mode', 'dontAsk', '--add-dir', HOME, '--mcp-config', PERCH_MCP(), '--allowedTools', ...ALLOWED], p.cwd || settings.chat.cwd, l)
}

export function overview() {
  const parse = (s: any) => ({ ...s, evidence: JSON.parse(s.evidence ?? '[]'), payload: JSON.parse(s.payload ?? '{}') })
  const open = all<any>(`select * from suggestions where status = 'open' order by created_at desc`).map(parse)
  return {
    status,
    suggestions: open,
    // The one question worth interrupting for: a higher-risk automation, not asked about today.
    ask: open.find(s => s.kind === 'routine' && s.payload.risk !== 'low' && (!s.payload.askAfter || s.payload.askAfter < Date.now())) ?? null,
    autoCreated: all<any>(`select * from suggestions where status = 'accepted' and json_extract(payload, '$.auto') = 'set up for you' order by created_at desc limit 10`).map(parse),
    automations: health(),
  }
}

// Always on: the watchdog every minute, a fresh look at your usage every 6 hours.
// Suggestions made before judging existed get judged too, a few at a time.
async function judgeBacklog() {
  const open = all<any>(`select id, evidence, payload from suggestions where status = 'open' and kind = 'consolidate'`).filter(s => !JSON.parse(s.payload ?? '{}').verdict).slice(0, 4)
  for (const s of open) { const ids = JSON.parse(s.evidence ?? '[]'); if (ids.length > 1) await judgeSuggestion(s.id, ids).catch(() => {}) }
  if (open.length) changed()
}

// Findings made before the decision queue existed move into it once.
function backfillFindings() {
  // Two findings came from the run-grouping bug above (and a manual run the scout list didn't
  // show): the scouts were fine. They close instead of becoming decisions.
  once('2026-11-10-false-scout-findings', () => run(`update suggestions set status = 'dismissed', payload = json_set(coalesce(payload, '{}'), '$.auto', 'false alarm: perch grouped every scout run as one') where status = 'open' and (title like '%apm-cost-savings-biweekly%ran%' or title like '%abandoned experiments%never run%')`))
  for (const x of all<any>(`select id, title, why, payload from suggestions where status = 'open' and kind = 'attention'`)) {
    findingToDecision({ id: x.id, title: x.title, why: x.why ?? '', link: JSON.parse(x.payload ?? '{}').link })
  }
}

export function startAutopilot() {
  // Scans, judging, duplicate-finding and self-fix act on their own, so they follow the autonomy switch.
  const on = (f: () => unknown) => () => { if (autonomyOn()) f() }
  const fix = () => selfFix().catch(e => recordError('Self-fix', e, 'Fixing a recurring auto-m8 error'))
  setTimeout(backfillFindings, 30_000).unref()
  setTimeout(on(fix), 5 * 60_000).unref()
  setInterval(on(fix), 2 * 3600_000).unref()
  setTimeout(on(judgeBacklog), 45_000).unref()
  setInterval(on(judgeBacklog), 15 * 60_000).unref()
  setInterval(watchdog, 60_000).unref()
  setInterval(on(findDuplicates), 30 * 60_000).unref()
  setTimeout(on(findDuplicates), 20_000).unref()
  const due = () => Date.now() - Math.max(status.lastScan, Number(get<any>('select max(created_at) t from suggestions')?.t ?? 0)) > 6 * 3600_000
  setTimeout(() => { if (autonomyOn() && due()) scan() }, 90_000).unref()
  setInterval(() => { if (autonomyOn() && due()) scan() }, 30 * 60_000).unref()
}
