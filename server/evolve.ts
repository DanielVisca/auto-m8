// Evolve: the layer that learns what you keep asking agents for and grows the tools to do it.
// 1. Ledger: every ask you make (Claude Code, PostHog Code, PostHog tasks) in one table, with how it
//    ended: answered, corrected, dropped (the agent went quiet with work unfinished) or still open.
// 2. Use cases: asks grouped by meaning ("shepherd my PRs", "debug a metrics alert"), each with
//    volume, how often it goes wrong, and what already covers it (skills, routines, scouts).
// 3. Forge: a use case you keep coming back to, with no skill behind it, gets one: a SKILL.md
//    written from your own conversations (how you want it done, what you corrected), installed
//    as autom8-<name> (perch-<name> on installs that already have perch-* skills) in your Claude
//    skills folder so every agent can load it.
// 4. Tune: each skill perch made is watched. If its use case keeps coming up and agents never
//    load it, the description is rewritten so they do. If sessions using it keep getting
//    corrected, the instructions are revised from those corrections. If nobody needs it for a
//    month, it's retired. Every change is a version you can roll back.
// Agents also say what they wished they had (report_missing_capability kind=skill|tool): those
// wishes count as use cases too. Autopilot reads the use cases, so repeated work also becomes
// scheduled jobs; evolve builds the skills those jobs run on.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { chats, ephemeral, send } from './chat.ts'
import { all, db, get, run } from './db.ts'
import { recordError, resolveErrors } from './errors.ts'
import { profile } from './profile.ts'
import { localSkills } from './search.ts'
import { autonomyOn, DATA_DIR, settings } from './settings.ts'
import { toItems, itemsOf, type Item } from './transcript.ts'
import { intentOf, isCorrection } from './turns.ts'
import { agentSender } from '../shared/messageOrigin.ts'

db.exec(`
create table if not exists asks (
  id text primary key, conversation_id text not null, ts integer not null, text text not null,
  intent text, use_case_id text, corrected integer default 0, -- your next message pushed back on its answer
  last integer default 0 -- the last ask in its conversation
);
create index if not exists asks_ts on asks(ts desc);
create index if not exists asks_uc on asks(use_case_id);
create table if not exists ask_files (conversation_id text primary key, mtime integer);
create table if not exists use_cases (
  id text primary key, name text not null, description text, created_at integer, updated_at integer,
  covered_by text,               -- the skill, routine or scout that already does it, if any
  status text default 'open'     -- open | covered | forged | ignored
);
create table if not exists forged (
  id text primary key, name text not null, use_case_id text, path text, version integer default 1,
  status text default 'live',    -- live | retired
  created_at integer, updated_at integer, reason text
);
create table if not exists forged_versions (forged_id text, version integer, body text, reason text, at integer, primary key (forged_id, version));
create table if not exists evolve_log (at integer, kind text, text text, ref text);
`)
try { db.exec('alter table capability_wishes add column kind text') } catch {}

const DAY = 86400_000
export const onEvolve = new Set<() => void>()
const changed = () => onEvolve.forEach(f => f())
export const status = { running: false, step: '', lastRun: 0, error: '' }
const log = (kind: string, text: string, ref?: string) => { run('insert into evolve_log (at, kind, text, ref) values (?, ?, ?, ?)', Date.now(), kind, text, ref ?? null); changed() }

const SKILLS_DIR = () => join(profile.claudeDir, 'skills')
const RETIRED_DIR = join(DATA_DIR, 'retired-skills')
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'skill'
const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16)

// ---------- 1. the ledger ----------
// Reads each changed transcript once. Messages that are tool plumbing (<command-…>, system
// reminders) are skipped: only what you typed counts as an ask.
// Conversations perch's own automation drives (PR shepherds, routines, autoresearch): their
// prompts are perch talking, not you, so they stay out of the ledger.
const AUTOMATED = `(select conversation_id from shepherd_watch where conversation_id is not null
  union select conversation_id from routine_runs where conversation_id is not null
  union select conversation_id from autoresearch_runs where conversation_id is not null)`
const has = (t: string) => !!get(`select 1 from sqlite_master where name = ?`, t)
// Helpers perch delegated to: their kickoff is perch's brief, not something you asked.
const HELPERS = () => has('delegations') ? ' union select child from delegations' : ''
// Prompts perch injects into a conversation (follow-ups, resumes, watch events, helper reports,
// auto-decisions). They sit in the transcript as user turns, but you didn't type them.
export const PERCH_PROMPT = /^\s*(⏰ Follow-up from (?:auto-m8|perch)|⏰ (?:auto-m8|perch) check:|You stopped here before the work was finished|\((?:auto-m8|perch): |Your previous API request got no reply|This chat stalled \(|(?:auto-m8|perch) restarted while you were working|\(a message sent before (?:auto-m8|perch) restarted\)|EVENTS \(\d+\) from what you're watching|HELPER REPORT \(|Decision on "|The user changed the decision on "|\[Request interrupted by user|You are the shepherd for |New on this PR since your last run:)/

export function ingest(days = 30) {
  let added = 0
  const automated = AUTOMATED.replace(/\)$/, `${HELPERS()})`)
  const auto = ['shepherd_watch', 'routine_runs', 'autoresearch_runs'].every(has) ? `and id not in ${automated}` : ''
  if (auto) run(`delete from asks where conversation_id in ${automated}`)
  for (const a of all<any>(`select id, text from asks`)) if (PERCH_PROMPT.test(a.text) || agentSender(a.text)) run('delete from asks where id = ?', a.id)
  for (const c of all<any>(`select id, path from conversations where source in ('claude', 'posthog-code') and path is not null and updated_at > ? ${auto}`, Date.now() - days * DAY)) {
    let mtime = 0
    try { mtime = statSync(c.path).mtimeMs } catch { continue }
    if (get<any>('select mtime from ask_files where conversation_id = ?', c.id)?.mtime === mtime) continue
    let items: Item[] = []
    try { items = itemsOf(c.path) } catch { continue }
    const users = items.filter((i): i is Extract<Item, { kind: 'user' }> => i.kind === 'user' && !/^\s*</.test(i.text) && !PERCH_PROMPT.test(i.text) && !agentSender(i.text) && i.text.trim().length > 3)
    db.exec('begin')
    try {
      run('update asks set last = 0 where conversation_id = ?', c.id)
      users.forEach((u, n) => {
        const next = users[n + 1]
        const id = hash(`${c.id}|${u.uuid ?? u.ts ?? n}`)
        const r = run(`insert into asks (id, conversation_id, ts, text, intent, corrected, last) values (?, ?, ?, ?, ?, ?, ?)
                       on conflict(id) do update set corrected = excluded.corrected, last = excluded.last`,
          id, c.id, u.ts ?? Date.now(), u.text.slice(0, 600), intentOf(u.text), next && isCorrection(next.text) ? 1 : 0, n === users.length - 1 ? 1 : 0)
        added += Number(r.changes)
      })
      run('insert into ask_files (conversation_id, mtime) values (?, ?) on conflict(conversation_id) do update set mtime = excluded.mtime', c.id, mtime)
      db.exec('commit')
    } catch (e) { db.exec('rollback'); throw e }
  }
  // PostHog tasks: one ask each (the Slack message or desktop prompt that started it).
  // A task auto-m8 started to carry on a local chat in the cloud ("☁ <chat title>") is not a new
  // ask: the chat's own asks are already counted, and the title is auto-m8's, not your words.
  const handedOff = has('cloud_leases') ? new Set(all<any>('select task_id from cloud_leases').map(r => `task:${r.task_id}`)) : new Set<string>()
  for (const t of all<any>(`select id, started_at, coalesce(first_prompt, title) text from conversations where source = 'posthog-task' and origin in ('slack', 'user_created', 'posthog_ai') and started_at > ?`, Date.now() - days * DAY)) {
    if (!t.text || handedOff.has(t.id) || /^\s*☁ /.test(t.text)) { run('delete from asks where id = ?', hash(t.id)); continue }
    added += Number(run(`insert or ignore into asks (id, conversation_id, ts, text, intent, last) values (?, ?, ?, ?, ?, 1)`, hash(t.id), t.id, t.started_at, String(t.text).slice(0, 600), intentOf(t.text)).changes)
  }
  // What agents said they lacked a skill or tool for counts as an ask too, so it joins a use case.
  for (const w of all<any>(`select id, conversation_id, need, would_help, created_at from capability_wishes where kind in ('skill', 'tool') and created_at > ?`, Date.now() - days * DAY)) {
    added += Number(run(`insert or ignore into asks (id, conversation_id, ts, text, intent) values (?, ?, ?, ?, 'wish')`, hash(`wish|${w.id}`), w.conversation_id ?? 'wish', w.created_at, `[an agent wished it had a skill for this] ${w.need}${w.would_help ? ` — ${w.would_help}` : ''}`.slice(0, 600)).changes)
  }
  return added
}

// Dropped: the agent stopped with the work unfinished and nobody came back. The conversation is
// quiet for a day, isn't done, archived or snoozed, and it ended stalled, on an error, or with the
// agent asking you something you never answered. These are the asks that fell through the cracks.
export function dropped(limit = 30) {
  return all<any>(`select c.id, coalesce(u.title, c.title, c.first_prompt) title, c.updated_at, c.stall, c.asks, c.status, c.source, c.cwd,
      a.text last_ask, a.use_case_id, uc.name use_case, (select 1 from perch_started p where p.id = c.id) ours
    from conversations c join asks a on a.conversation_id = c.id and a.last = 1
    left join user_state u on u.id = c.id left join use_cases uc on uc.id = a.use_case_id
    where c.updated_at between ? and ? and coalesce(u.state, '') not in ('done', 'archived', 'hidden', 'later')
      and (c.stall is not null or c.asks = 1 or c.status = 'failed')
      and not exists (select 1 from promises p where p.conversation_id = c.id and p.status = 'open')
    order by c.updated_at desc limit ?`, Date.now() - 14 * DAY, Date.now() - DAY, limit)
}

// ---------- 2. use cases ----------
async function model(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    ephemeral(['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', settings.ai.model, '--no-session-persistence',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk'], settings.chat.cwd, ev => {
      if (ev.type === 'result') out = String(ev.result ?? '')
      if (ev.type === 'perch_done') ev.code && !out ? reject(new Error(ev.error || 'the model call failed')) : resolve(out)
    })
  })
}
const json = (s: string, open = '{', close = '}') => JSON.parse(s.slice(s.indexOf(open), s.lastIndexOf(close) + 1))
// Long skill bodies sometimes come back with an unescaped quote; one retry fixes nearly all of them.
async function modelJson(prompt: string) {
  try { return json(await model(prompt)) } catch (e) {
    if (!(e instanceof SyntaxError)) throw e
    return json(await model(`${prompt}\n\nYour previous reply was not valid JSON (${e.message}). Reply with ONLY valid JSON: escape quotes and newlines inside strings.`))
  }
}

const CLUSTER = `You group a user's requests to AI agents into use cases: the recurring jobs they hand to agents.
A use case is a JOB, not a topic: "shepherd my PRs to merge", "debug a failing CI run", "draft a Slack message to a team", "review someone's PR as me", "investigate a production alert". Name it in 2-6 words, verb first.
Put each new ask into an existing use case when it fits; otherwise make a new one. Asks that are one-off or just conversational ("thanks", "yes do it", "continue") go in "skip".
Reply with ONLY JSON: {"assign": [{"ask": "<ask id>", "use_case": "<existing use case id, or the name of a new one>"}], "new": [{"name": "...", "description": "one sentence: what the user wants done and what good looks like"}], "skip": ["<ask id>"]}`

export async function cluster(max = 160) {
  const pending = all<any>(`select id, text from asks where use_case_id is null and ts > ? order by ts desc limit ?`, Date.now() - 30 * DAY, max)
  if (!pending.length) return 0
  const known = all<any>(`select id, name, description from use_cases where status != 'ignored'`)
  const prompt = `${CLUSTER}\n\n## Existing use cases\n${known.map(u => `- ${u.id}: ${u.name} — ${u.description ?? ''}`).join('\n') || 'none yet'}\n\n## Asks\n${pending.map(a => `- ${a.id}: ${a.text.replace(/\s+/g, ' ').slice(0, 220)}`).join('\n')}`
  const r = json(await model(prompt))
  const byName = new Map(known.map(u => [u.name.toLowerCase(), u.id]))
  for (const n of r.new ?? []) {
    if (!n?.name || byName.has(String(n.name).toLowerCase())) continue
    const id = `uc_${hash(n.name)}`
    run('insert or ignore into use_cases (id, name, description, created_at, updated_at) values (?, ?, ?, ?, ?)', id, String(n.name).slice(0, 80), String(n.description ?? '').slice(0, 300), Date.now(), Date.now())
    byName.set(String(n.name).toLowerCase(), id)
  }
  const ids = new Set(known.map(u => u.id))
  let n = 0
  for (const a of r.assign ?? []) {
    const uc = ids.has(a.use_case) ? a.use_case : byName.get(String(a.use_case ?? '').toLowerCase())
    if (uc) { run('update asks set use_case_id = ? where id = ?', uc, a.ask); run('update use_cases set updated_at = ? where id = ?', Date.now(), uc); n++ }
  }
  for (const id of r.skip ?? []) run(`update asks set use_case_id = 'skip' where id = ?`, id)
  return n
}

// Per use case: volume, how it goes, and what covers it.
export function useCases(days = 30) {
  const since = Date.now() - days * DAY
  const drops = new Set(dropped(200).map(d => d.id))
  return all<any>(`select uc.*, count(a.id) n, sum(a.corrected) corrected, count(distinct a.conversation_id) convs, max(a.ts) last,
        (select json_group_array(conversation_id) from (select distinct conversation_id from asks where use_case_id = uc.id order by ts desc limit 6)) recent,
        (select json_object('id', f.id, 'name', f.name, 'version', f.version, 'status', f.status) from forged f where f.use_case_id = uc.id and f.status = 'live') skill
      from use_cases uc left join asks a on a.use_case_id = uc.id and a.ts > ?
      where uc.status != 'ignored' group by uc.id order by n desc`, since)
    .map(u => {
      const recent: string[] = JSON.parse(u.recent ?? '[]')
      return { ...u, recent, skill: u.skill ? JSON.parse(u.skill) : null, dropped: recent.filter(id => drops.has(id)).length }
    })
}

// ---------- 3. forging skills ----------
// Skills we write are named <prefix><name>. New installs use autom8-; installs from before the
// rename already have perch-* skills, so they keep that prefix rather than mixing two. Both count
// as ours.
const OUR_PREFIXES = ['autom8-', 'perch-']
export const isOurSkill = (name: string) => OUR_PREFIXES.some(p => name.startsWith(p))
export function skillPrefix() {
  return localSkills().some(s => s.name.startsWith('perch-')) ? 'perch-' : 'autom8-'
}

// What already covers a use case: a skill whose name and description share its words.
function coveredBy(uc: { name: string; description: string }) {
  const words = (s: string) => new Set(String(s).toLowerCase().match(/[a-z]{4,}/g) ?? [])
  const want = words(`${uc.name} ${uc.description}`)
  let best: { name: string; score: number } | null = null
  for (const s of localSkills()) {
    if (isOurSkill(s.name)) continue
    const have = words(`${s.name} ${s.description}`)
    const score = [...want].filter(w => have.has(w)).length / Math.max(1, want.size)
    if (score > (best?.score ?? 0.5)) best = { name: s.name, score }
  }
  return best?.name ?? null
}

function excerpt(conversationId: string, max = 7000) {
  const c = get<any>('select path, coalesce(title, first_prompt) title from conversations where id = ?', conversationId)
  if (!c?.path || !existsSync(c.path)) return ''
  const lines: string[] = []
  for (const i of itemsOf(c.path)) {
    if (i.kind === 'user') { if (!/^\s*</.test(i.text)) lines.push(`USER: ${i.text.slice(0, 1200)}`) }
    else for (const b of i.blocks) {
      if (b.type === 'text') lines.push(`AGENT: ${b.text.slice(0, 800)}`)
      else if (b.type === 'tool') lines.push(`  [${b.name}${b.isError ? ' ERROR' : ''}${b.name === 'Bash' ? ': ' + String((b.input as any)?.command ?? '').slice(0, 120) : b.name === 'Skill' ? ': ' + (b.input as any)?.skill : ''}]`)
    }
  }
  const text = lines.join('\n')
  return `### ${c.title} (${conversationId})\n` + (text.length > max ? text.slice(0, max / 3) + '\n[…]\n' + text.slice(-(2 * max) / 3) : text)
}

const FORGE = `You write Claude Code skills from a user's real conversations with agents. The user hands this job to agents again and again; write the skill that lets any agent do it the way they want, first time, without being corrected.
Learn from the transcripts: the steps that worked, the tools and commands used, the user's preferences and standards, and above all what they corrected or pushed back on. Generalise: no one-off names, ids or PR numbers unless they are stable (repos, channels, dashboards, projects).
SKILL.md body: a short purpose line, "When to use", the procedure as numbered steps, the user's rules ("Always…", "Never…" with the reason), and how to verify and report. Under 120 lines. Plain, direct sentences.
A helper script is allowed only when the procedure repeats the same multi-command sequence; keep it read-only unless the job itself writes.
Reply with ONLY JSON: {"name": "kebab-case, 2-4 words", "description": "one or two sentences: what it does and the exact situations and phrasings that should trigger it (this is what makes agents load it)", "body": "the SKILL.md body in markdown, without frontmatter", "scripts": [{"path": "scripts/x.sh", "content": "..."}]}
If the conversations show no repeatable procedure (each was different, or it's trivial), reply {"skip": "why"}.`

function frontmatter(name: string, description: string, ucId: string, version: number) {
  return `---\nname: ${name}\ndescription: ${description.replace(/\n/g, ' ')}\nmetadata:\n  generated-by: perch\n  use-case: ${ucId}\n  version: ${version}\n---\n\n`
}

export async function forge(ucId: string) {
  const uc = get<any>('select * from use_cases where id = ?', ucId)
  if (!uc) throw new Error('unknown use case')
  status.step = `writing a skill for “${uc.name}”`; changed()
  const convs = all<any>(`select conversation_id id, max(ts) t, sum(corrected) c from asks where use_case_id = ? group by conversation_id order by c desc, t desc limit 4`, ucId)
  const asks = all<any>(`select text from asks where use_case_id = ? order by ts desc limit 12`, ucId)
  const wishes = all<any>(`select text need, '' would_help from asks where use_case_id = ? and intent = 'wish' order by ts desc limit 6`, ucId)
  const prompt = `${FORGE}\n\n## The job: ${uc.name}\n${uc.description ?? ''}\n\n## How the user asks for it\n${asks.map(a => `- ${a.text.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')}\n${wishes.length ? `\n## What agents said they were missing\n${wishes.map(w => `- ${w.need}: ${w.would_help}`).join('\n')}\n` : ''}\n## Conversations doing it\n${convs.map(c => excerpt(c.id)).filter(Boolean).join('\n\n')}`
  const r = await modelJson(prompt)
  if (r.skip) { run(`update use_cases set status = 'ignored', covered_by = ? where id = ?`, `not repeatable: ${String(r.skip).slice(0, 200)}`, ucId); log('skip', `“${uc.name}” has no repeatable procedure: ${r.skip}`, ucId); return null }
  const name = `${skillPrefix()}${slug(r.name || uc.name)}`
  const dir = join(SKILLS_DIR(), name)
  mkdirSync(dir, { recursive: true })
  for (const s of r.scripts ?? []) {
    const p = join(dir, String(s.path))
    if (!p.startsWith(dir + '/') || p.includes('..')) continue // stays inside the skill
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, String(s.content), { mode: 0o755 })
  }
  const id = `sk_${hash(name)}`
  const prev = get<any>('select version from forged where id = ?', id)
  const version = (prev?.version ?? 0) + 1
  const body = frontmatter(name, String(r.description), ucId, version) + String(r.body)
  writeFileSync(join(dir, 'SKILL.md'), body)
  run(`insert into forged (id, name, use_case_id, path, version, status, created_at, updated_at, reason) values (?, ?, ?, ?, ?, 'live', ?, ?, ?)
       on conflict(id) do update set version = excluded.version, status = 'live', updated_at = excluded.updated_at, reason = excluded.reason, path = excluded.path`,
    id, name, ucId, dir, version, Date.now(), Date.now(), `made from ${convs.length} conversations`)
  run('insert or replace into forged_versions (forged_id, version, body, reason, at) values (?, ?, ?, ?, ?)', id, version, body, 'first version', Date.now())
  run(`update use_cases set status = 'forged' where id = ?`, ucId)
  log('forge', `Made skill ${name} for “${uc.name}” from ${convs.length} conversations`, id)
  return { id, name, path: dir }
}

// ---------- 4. watching what it made ----------
// For each live skill since its current version: how often its use case came up, how often an
// agent loaded it, and how often those sessions were corrected.
export function skillHealth() {
  return all<any>(`select f.*, uc.name use_case from forged f left join use_cases uc on uc.id = f.use_case_id order by f.status, f.updated_at desc`).map(f => {
    const since = f.updated_at
    const a = get<any>('select count(*) n, count(distinct conversation_id) c from asks where use_case_id = ? and ts > ?', f.use_case_id, since)
    const asked = Number(a?.n ?? 0), askedConvs = Number(a?.c ?? 0)
    const loaded = all<any>(`select distinct conversation_id from tool_calls where name = 'Skill' and detail in (?, ?) and ts > ?`, f.name, `user-skills:${f.name}`, since).map(r => r.conversation_id)
    const turns = loaded.length ? get<any>(`select count(*) n, sum(corrected) c from asks where conversation_id in (${loaded.map(() => '?').join(',')}) and ts > ?`, ...loaded, since) : { n: 0, c: 0 }
    const lastAsk = Number(get<any>('select max(ts) t from asks where use_case_id = ?', f.use_case_id)?.t ?? 0)
    const versions = all<any>('select version, reason, at from forged_versions where forged_id = ? order by version desc', f.id)
    return { ...f, asked, askedConvs, loaded: loaded.length, sessions: loaded, turns: Number(turns?.n ?? 0), corrected: Number(turns?.c ?? 0), lastAsk, versions }
  })
}

const TUNE = `You maintain a Claude Code skill that auto-m8 wrote for a user. Its evidence says it isn't working well enough. Rewrite it to fix exactly that, keeping what works.
- "not loaded": the job keeps coming up but agents don't load the skill. Rewrite the description so it triggers: name the situations and the user's actual phrasings.
- "corrected": sessions that loaded it were corrected by the user. Change the instructions so the agent would have done what the user wanted. Each correction should become a rule.
Reply with ONLY JSON: {"description": "...", "body": "full SKILL.md body without frontmatter", "change": "one sentence: what you changed and why"}`

export async function tune(f: any, problem: 'not loaded' | 'corrected') {
  status.step = `tuning ${f.name} (${problem})`; changed()
  const file = join(f.path, 'SKILL.md')
  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
  let evidence = ''
  if (problem === 'not loaded') {
    evidence = all<any>(`select text from asks where use_case_id = ? and ts > ? and conversation_id not in (${f.sessions.map(() => '?').join(',') || "''"}) order by ts desc limit 12`, f.use_case_id, f.updated_at, ...f.sessions).map(a => `- ${a.text.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')
  } else {
    // The corrections, each with the answer it pushed back on.
    evidence = f.sessions.slice(0, 3).map((id: string) => excerpt(id, 5000)).join('\n\n')
  }
  const r = await modelJson(`${TUNE}\n\n## Problem: ${problem}\n\n## Current skill\n${current}\n\n## Evidence (${problem === 'not loaded' ? `asks since the last version where no agent loaded it (loaded in ${f.loaded} of ${f.askedConvs} conversations)` : 'sessions that loaded it and were corrected'})\n${evidence}`)
  const version = f.version + 1
  const body = frontmatter(f.name, String(r.description), f.use_case_id, version) + String(r.body)
  writeFileSync(file, body)
  run('update forged set version = ?, updated_at = ?, reason = ? where id = ?', version, Date.now(), String(r.change ?? problem).slice(0, 300), f.id)
  run('insert or replace into forged_versions (forged_id, version, body, reason, at) values (?, ?, ?, ?, ?)', f.id, version, body, String(r.change ?? problem).slice(0, 300), Date.now())
  log('tune', `${f.name} v${version}: ${r.change ?? problem}`, f.id)
}

export function retire(id: string, reason = 'retired by you') {
  const f = get<any>('select * from forged where id = ?', id)
  if (!f || f.status !== 'live') return
  mkdirSync(RETIRED_DIR, { recursive: true })
  const to = join(RETIRED_DIR, f.name)
  if (existsSync(to)) rmSync(to, { recursive: true, force: true })
  if (existsSync(f.path)) renameSync(f.path, to)
  run(`update forged set status = 'retired', reason = ?, updated_at = ? where id = ?`, reason, Date.now(), id)
  if (reason === 'retired by you') run(`update use_cases set status = 'ignored' where id = ?`, f.use_case_id) // you said no: don't make it again
  log('retire', `Retired ${f.name}: ${reason}`, id)
}

export function restore(id: string) {
  const f = get<any>('select * from forged where id = ?', id)
  if (!f) return
  const from = join(RETIRED_DIR, f.name)
  if (existsSync(from) && !existsSync(f.path)) renameSync(from, f.path)
  run(`update forged set status = 'live', reason = 'restored by you', updated_at = ? where id = ?`, Date.now(), id)
  run(`update use_cases set status = 'forged' where id = ?`, f.use_case_id)
  log('restore', `Restored ${f.name}`, id)
}

export function rollback(id: string, version: number) {
  const f = get<any>('select * from forged where id = ?', id)
  const v = get<any>('select body from forged_versions where forged_id = ? and version = ?', id, version)
  if (!f || !v) throw new Error('unknown version')
  const next = f.version + 1
  writeFileSync(join(f.path, 'SKILL.md'), v.body.replace(/version: \d+/, `version: ${next}`))
  run('update forged set version = ?, updated_at = ?, reason = ? where id = ?', next, Date.now(), `rolled back to v${version}`, id)
  run('insert or replace into forged_versions (forged_id, version, body, reason, at) values (?, ?, ?, ?, ?)', id, next, v.body, `rolled back to v${version}`, Date.now())
  log('rollback', `${f.name}: back to v${version}`, id)
}

export function ignore(ucId: string) { run(`update use_cases set status = 'ignored' where id = ?`, ucId); changed() }

// ---------- the loop ----------
// When a use case earns a skill: asked 3+ times in 3+ conversations over the last 30 days,
// nothing already covers it, and it isn't marked ignored. At most 2 new skills per cycle.
export const FORGE_MIN = 3

export async function cycle() {
  if (status.running) return
  Object.assign(status, { running: true, error: '', step: 'reading your conversations' }); changed()
  try {
    const added = ingest()
    status.step = 'grouping asks into use cases'; changed()
    let grouped = 0
    for (let i = 0; i < 4; i++) { const n = await cluster(); grouped += n; if (!n) break }
    if (added || grouped) log('ledger', `${added} new asks, ${grouped} grouped into use cases`)
    for (const uc of all<any>(`select * from use_cases where status = 'open'`)) {
      const by = coveredBy(uc)
      if (by) run(`update use_cases set status = 'covered', covered_by = ? where id = ?`, by, uc.id)
    }
    if (settings.evolve.forge) {
      const due = useCases().filter(u => u.status === 'open' && u.n >= FORGE_MIN && u.convs >= FORGE_MIN).slice(0, 2)
      for (const u of due) await forge(u.id).catch(e => log('error', `Couldn't make a skill for “${u.name}”: ${e.message}`, u.id))
    }
    if (settings.evolve.tune) {
      for (const f of skillHealth().filter(f => f.status === 'live')) {
        const age = Date.now() - f.updated_at
        if (f.askedConvs >= 3 && f.loaded / f.askedConvs < 0.2) await tune(f, 'not loaded').catch(e => log('error', `Couldn't tune ${f.name}: ${e.message}`, f.id))
        else if (f.turns >= 4 && f.corrected / f.turns >= 0.3) await tune(f, 'corrected').catch(e => log('error', `Couldn't tune ${f.name}: ${e.message}`, f.id))
        else if (age > 30 * DAY && f.lastAsk < Date.now() - 30 * DAY) retire(f.id, 'not needed for 30 days')
      }
    }
    resolveErrors('Evolve')
  } catch (e: any) {
    status.error = recordError('Evolve', e, 'The evolve cycle').message
  } finally {
    // A failed cycle waits its turn too, so a persistent error doesn't retry every 20 minutes.
    status.lastRun = Date.now()
    run('insert into evolve_log (at, kind, text) values (?, ?, ?)', Date.now(), 'cycle', status.error || 'ok')
    Object.assign(status, { running: false, step: '' }); changed()
  }
}

// For autopilot: the use cases worth a scheduled job, in one block of its digest.
export function useCaseDigest() {
  return useCases().filter(u => u.n >= 2).slice(0, 15)
    .map(u => `- ${u.name}: ${u.n} asks in ${u.convs} conversations, ${u.corrected ?? 0} corrected, ${u.dropped} dropped; ${u.skill ? `skill ${u.skill.name}` : u.covered_by ? `covered by ${u.covered_by}` : 'no skill'}`).join('\n')
}

export function overview() {
  const cases = useCases()
  const asks = get<any>('select count(*) n, sum(corrected) c, count(distinct conversation_id) convs from asks where ts > ?', Date.now() - 30 * DAY)
  return {
    status, settings: settings.evolve, skillPrefix: skillPrefix(),
    totals: { asks: asks?.n ?? 0, corrected: asks?.c ?? 0, conversations: asks?.convs ?? 0, useCases: cases.length, skills: get<any>(`select count(*) n from forged where status = 'live'`)?.n ?? 0 },
    byIntent: all<any>(`select intent, count(*) n, sum(corrected) c from asks where ts > ? group by intent order by n desc`, Date.now() - 30 * DAY),
    useCases: cases,
    skills: skillHealth(),
    dropped: dropped(),
    wishes: all<any>(`select coalesce(kind, 'data') kind, need, would_help, conversation_id, created_at from capability_wishes order by created_at desc limit 20`),
    log: all<any>(`select * from evolve_log where kind != 'cycle' order by at desc limit 40`),
  }
}

// Always on: a cycle 2 minutes after start, then every 4 hours.
// Automatic resume: dropped work that perch itself started (never a terminal session you own, which
// perch doesn't write to behind your back) gets the same follow-up the Resume button sends. Once per
// conversation, so a conversation that drops again waits for you. At most 2 per pass.
const resumed = 'create table if not exists evolve_resumes (conversation_id text primary key, at integer)'
db.exec(resumed)
try { db.exec('alter table evolve_resumes add column attempts integer default 1') } catch {}
// A resume counts once the agent actually answered. One that hung (the turn ended without a single
// token) gets one more try after 30 minutes instead of being marked handled forever.
const answered = (id: string, since: number) => !!get('select 1 from turns where conversation_id = ? and sent_at >= ? and first_token_at is not null', id, since)
const why = (d: any) => d.status === 'failed' ? 'task failed' : d.stall ? `stalled: ${d.stall}` : d.asks ? 'asked you something, no answer' : 'went quiet'
export function resumeDropped(limit = 2) {
  if (!settings.evolve.resume) return 0
  let n = 0
  for (const d of dropped(50)) {
    if (n >= limit) break
    if (!d.ours || d.source === 'posthog-task') continue
    if (chats.get(d.id)?.state === 'running') continue
    const prev = get<any>('select at, attempts from evolve_resumes where conversation_id = ?', d.id)
    if (prev && (prev.attempts >= 2 || Date.now() - prev.at < 30 * 60_000 || answered(d.id, prev.at))) continue
    run('insert into evolve_resumes (conversation_id, at, attempts) values (?, ?, 1) on conflict(conversation_id) do update set at = excluded.at, attempts = attempts + 1', d.id, Date.now())
    send({ id: d.id, resume: true, prompt: RESUME_PROMPT })
    log('resume', `${prev ? 'Retried (last resume got no reply)' : 'Resumed'} “${String(d.title).slice(0, 60)}”: ${why(d)}`, d.id)
    n++
  }
  if (n) changed()
  return n
}
export const RESUME_PROMPT = 'You stopped here before the work was finished. This is an instruction, not a notification: check where things stand now (files, PRs, CI), finish the task, and reply with the result. If something blocks you, say exactly what and what you need from me.'

export function startEvolve() {
  status.lastRun = Number(get<any>(`select max(at) t from evolve_log where kind = 'cycle'`)?.t ?? 0)
  const due = () => Date.now() - status.lastRun > 4 * 3600_000
  setTimeout(() => { if (settings.evolve.enabled && autonomyOn() && due()) cycle() }, 120_000).unref()
  setInterval(() => { if (settings.evolve.enabled && autonomyOn() && due()) cycle() }, 20 * 60_000).unref()
  setInterval(() => { if (settings.evolve.enabled && autonomyOn()) { try { resumeDropped() } catch (e) { console.error('evolve resume', e) } } }, 15 * 60_000).unref()
}
