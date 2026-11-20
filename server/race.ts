// Model race: one task, several models, one answer, and a record of who was better at what.
//
// Shadow mode looks back (would a cheaper model have shipped this merged PR?). A race looks forward:
// you (or an agent) give a task, and perch runs it on several comparable models at once, each in its
// own worktree off the same commit. Then:
//   1. race     every contestant does the task on its own (Claude Code headless, or Codex exec)
//   2. review   every contestant reviews every other one's work, in that work's worktree: bugs,
//               missing pieces, wrong behaviour, worse engineering, overbuilding. Claims need evidence.
//   3. merge    the contestant the others rated best adjudicates every review claim (valid or not,
//               checked against the code) and builds the one solution from the best parts, on a
//               branch race/<id>/final. It writes the findings: ranking, strengths and weaknesses
//               per model, which models' work alone would have been enough to ship.
// Hard evidence is kept for every claim: each contestant's diff, its event log (tools it reached
// for, tokens, turns), its time and cost, the verify command's output, every review, every
// adjudication. Each contestant's work is also committed to race/<id>/<model> so it can be diffed.
//
// "Enough vs too much": the race knows which models' solutions were sufficient, so for the model
// you would have used (the asking chat's model, or `picked`) it says whether that was overkill (a
// cheaper or faster model was also enough), right, or underkill (yours wasn't enough, another was).
// insights() rolls this up across races and shadow runs for the Insights → Models tab.
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { codexBin, codexReadySync } from './codex.ts'
import { all, db, get, run } from './db.ts'
import { DATA_DIR, settings } from './settings.ts'
import { hypotheses as shadowHypotheses, isLocalModel, summaries as shadowSummaries } from './shadow.ts'
import { autoConfig, autoInsights, candidate, deliverRaceResults, pendingCandidate, raceCapacityError, skipCandidate, startedCandidate, validateCandidate } from './autorace.ts'
import { allCapped, isCapped, type Tier } from './router.ts'
import { isUnderPressure } from './quiet.ts'

const exec = promisify(execFile)
const git = (cwd: string, args: string[], timeout = 300_000) => exec('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, maxBuffer: 50e6, timeout }).then(r => r.stdout.trim())

db.exec(`create table if not exists race_runs (
  id text primary key, task text not null, top text, base text, requester text, picked text, verify text, mcp integer default 0,
  status text default 'running', phase text default 'race', error text, synth text, final_branch text, final_diff text, final_verify text,
  findings text, report text, usd real, pid integer, synth_started integer, created_at integer, ended_at integer
)`)
db.exec(`create table if not exists race_entries (
  id text primary key, run_id text not null, model text not null, worktree text, branch text, status text default 'queued', error text,
  pid integer, out text, started_at integer, ended_at integer, duration_ms integer, usd real, tokens integer, turns integer,
  tools text, diff text, diff_stat text, summary text, verify text
)`)
db.exec(`create table if not exists race_reviews (
  id text primary key, run_id text not null, reviewer text not null, target text not null, status text default 'queued', error text,
  pid integer, out text, started_at integer, ended_at integer, duration_ms integer, usd real, tokens integer, result text
)`)
const OUT_DIR = join(DATA_DIR, 'race')
mkdirSync(OUT_DIR, { recursive: true })

export const cfg = () => ({ models: ['claude-opus-5-5', 'claude-fable-5-2', 'codex:gpt-6-astra'], budgetUsd: 10, timeoutMin: 45, reviewTimeoutMin: 20, verifyTimeoutMin: 10, ...(settings as any).race })
export const isCodex = (m: string) => m.startsWith('codex:')
export const pretty = (m: string) => {
  if (isCodex(m)) return m.slice(6).replace(/^gpt-/, 'GPT ').replace(/-(\w)/g, (_, c) => ` ${c.toUpperCase()}`)
  if (isLocalModel(m)) return `${m} (local)`
  const c = m.match(/^claude-(\w+)-([\d-]+)/)
  return c ? `${c[1][0].toUpperCase()}${c[1].slice(1)} ${c[2].replace(/-/g, '.')}` : m
}
const slug = (m: string) => m.replace(/^codex:/, '').replace(/[^\w.-]/g, '_')
const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } }
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))
let notify = () => {}
let deliver = () => {}

// ---------- launching one agent, detached so a perch restart doesn't kill it ----------
// Every process writes its event stream to a file and, on exit, a final {"type":"perch_exit"} line.
const RACE = `You are one of several AI models given the same task, each in its own copy of the repository. Your work will be reviewed by the other models and compared on correctness, completeness, engineering quality and how well the size of the change fits the task. Work only in the current directory. Run tests or checks if they help. Leave your changes uncommitted. Don't push, open PRs, comment anywhere or message anyone. Don't ask questions: decide and carry on. When you're done, summarise what you changed and why in three sentences.`
const REVIEW = `You are reviewing a competitor's solution. Several AI models did the same task independently; the current directory holds ANOTHER model's finished work (uncommitted changes on top of the starting commit: see \`git diff\` and \`git status\`). Your own solution's diff is below for reference. Be adversarial but honest: find bugs, missing requirements, wrong behaviour, weaker engineering, and overbuilding (more than the task needed). Every claim needs evidence: a file and line, a command you ran and its output, or the requirement it misses. Don't edit any files. Also say what it does better than yours.
Reply with ONLY JSON at the end: {"score":0-100,"vs_mine":"better"|"comparable"|"worse","sufficient":true|false,"issues":[{"severity":"high"|"medium"|"low","kind":"bug"|"missing"|"wrong"|"engineering"|"overbuilt"|"tests","file":"","claim":"","evidence":""}],"strengths":["..."],"steal":["what you'd take from it into a final solution"]}
"sufficient" means: shippable as is for this task.`
const MERGE = `You ran in a race of AI models on the same task, and the other models rated your solution best, so you now build the ONE final solution. The current directory starts as your own solution. Below are every contestant's diff and every review they wrote of each other.
1. Adjudicate every review issue: check it against the code (read files, run things) and decide valid or not.
2. Improve the solution in the current directory: fix valid issues against it, and bring in the better parts of the others. Keep it as small as the task needs. Leave changes uncommitted.
3. Reply with ONLY JSON at the end: {"winner":"<model whose solution was best before merging>","ranking":[{"model":"","rank":1,"why":""}],"models":{"<model>":{"strengths":[""],"weaknesses":[""],"sufficient":true|false,"size":"too-little"|"right"|"too-much"}},"adjudication":[{"review":"<review id>","issue":0,"valid":true|false,"note":""}],"taken":{"<model>":["what the final takes from it"]},"summary":"what the final solution does, two sentences","lessons":["one-line lesson about which model is good at what"]}`

function claudeArgs(model: string, prompt: string, o: { budget?: number; readOnly?: boolean; mcp?: boolean }) {
  const tools = o.readOnly
    ? ['--allowedTools', 'Read', 'Glob', 'Grep', 'Bash', '--disallowedTools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']
    : ['--permission-mode', 'bypassPermissions']
  return ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', model, '--no-session-persistence', ...tools,
    ...(o.mcp ? [] : ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']), ...(o.budget ? ['--max-budget-usd', String(o.budget)] : []),
    '--disallowedTools', 'Bash(git push:*)', 'Bash(gh:*)', 'Bash(git commit:*)', 'Bash(git reset:*)', 'Bash(git checkout:*)']
}
function codexArgs(model: string, prompt: string, o: { readOnly?: boolean; mcp?: boolean }) {
  return ['exec', '--json', '--skip-git-repo-check', '-m', model.slice(6), '-c', `sandbox_mode="${o.readOnly ? 'read-only' : 'workspace-write'}"`,
    ...(o.mcp ? [] : ['-c', 'mcp_servers={}']), '--', prompt]
}

function spawnAgent(model: string, prompt: string, cwd: string, out: string, o: { budget?: number; readOnly?: boolean; mcp?: boolean }) {
  const [bin, args] = isCodex(model) ? [codexBin(), codexArgs(model, prompt, o)] : ['claude', claudeArgs(model, prompt, o)]
  if (!bin) throw new Error('Codex CLI not found')
  const fd = openSync(out, 'w')
  const script = '"$@"; c=$?; printf \'\\n{"type":"perch_exit","code":%s,"at":%s000}\\n\' "$c" "$(date +%s)"'
  const p = spawn('/bin/sh', ['-c', script, 'race', bin, ...args], { cwd, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, PERCH_SHADOW: '1', PERCH_RACE: '1' } })
  closeSync(fd); p.unref()
  return p.pid ?? null
}

// What an event log says: tools used (discoverability), tokens, turns, cost, the final text.
export function readLog(text: string) {
  const tools: Record<string, number> = {}
  let usd = 0, tokens = 0, turns = 0, result = '', exit: number | null = null, at: number | null = null, error = ''
  const msgs: string[] = []
  const add = (n: string) => { tools[n] = (tools[n] ?? 0) + 1 }
  for (const line of text.split('\n')) {
    let e: any; try { e = JSON.parse(line) } catch { continue }
    if (e.type === 'perch_exit') { exit = e.code; at = e.at; continue }
    // Claude Code stream-json
    if (e.type === 'assistant') for (const b of e.message?.content ?? []) { if (b.type === 'tool_use') add(b.name === 'Bash' ? `Bash:${String(b.input?.command ?? '').trim().split(/\s+/)[0]}` : b.name); if (b.type === 'text') msgs.push(b.text) }
    if (e.type === 'result') { usd = e.total_cost_usd ?? 0; turns = e.num_turns ?? 0; result = String(e.result ?? ''); const u = e.usage ?? {}; tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0); if (e.is_error) error = String(e.subtype ?? 'error') }
    // Codex exec --json
    if (e.type === 'item.completed') {
      const it = e.item ?? {}
      if (it.type === 'command_execution') add(`Bash:${String(it.command ?? '').replace(/^\/bin\/(z|ba)?sh -lc /, '').replace(/^\s*['"]/, '').trim().split(/[\s'"]+/)[0]}`)
      else if (it.type === 'mcp_tool_call') add(`mcp__${it.server}__${it.tool}`)
      else if (it.type === 'file_change') add('Edit')
      else if (it.type === 'web_search') add('WebSearch')
      else if (it.type === 'agent_message' && it.text) msgs.push(it.text)
    }
    if (e.type === 'turn.completed') { turns++; const u = e.usage ?? {}; tokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0) }
    if (e.type === 'turn.failed' || e.type === 'error') error = e.error?.message ?? e.message ?? 'failed'
  }
  return { tools, usd, tokens, turns, result: result || msgs.join('\n\n'), exit, at, error }
}

// Pull the last JSON object out of a model's reply.
export function lastJson(text: string): any {
  for (let end = text.lastIndexOf('}'); end > 0; end = text.lastIndexOf('}', end - 1)) {
    for (let start = text.lastIndexOf('{', end); start >= 0; start = text.lastIndexOf('{', start - 1)) {
      try { return JSON.parse(text.slice(start, end + 1)) } catch {}
      if (end - start > 200_000) break
    }
  }
  return null
}

async function waitFor(pid: number | null, out: string, startedAt: number, mins: number) {
  while (alive(pid)) {
    if (Date.now() > startedAt + mins * 60_000) { try { process.kill(-pid!, 'SIGTERM') } catch {}; throw new Error(`timed out after ${mins} min`) }
    await pause(5000)
  }
  return readLog(existsSync(out) ? readFileSync(out, 'utf8') : '')
}

async function verify(cmd: string | null, cwd: string) {
  if (!cmd) return null
  const t = Date.now()
  try {
    const r = await exec('/bin/sh', ['-c', cmd], { cwd, maxBuffer: 20e6, timeout: cfg().verifyTimeoutMin * 60_000 })
    return { ok: true, ms: Date.now() - t, output: `${r.stdout}${r.stderr}`.slice(-4000) }
  } catch (e: any) { return { ok: false, ms: Date.now() - t, output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.killed ? '\n(timed out)' : ''}`.slice(-4000) || String(e.message) } }
}

// Fresh worktrees don't have dependencies installed: borrow the main checkout's.
function linkDeps(top: string, dir: string) {
  for (const d of ['node_modules', 'web/node_modules', 'frontend/node_modules', '.venv', 'env']) {
    if (existsSync(join(top, d)) && !existsSync(join(dir, d)) && existsSync(dirname(join(dir, d)))) try { symlinkSync(join(top, d), join(dir, d)) } catch {}
  }
}
async function addWorktree(top: string, base: string, name: string) {
  const dir = join(dirname(top), '.perch-worktrees', `${basename(top)}-${name}`)
  mkdirSync(dirname(dir), { recursive: true })
  await git(top, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', dir, base], 900_000)
  linkDeps(top, dir)
  return dir
}
async function diffOf(dir: string, base: string) {
  await git(dir, ['add', '-A', '--', '.', ':!node_modules', ':!web/node_modules', ':!frontend/node_modules', ':!.venv', ':!env'])
  return { diff: await git(dir, ['diff', '--cached', '--no-color', base]), stat: await git(dir, ['diff', '--cached', '--shortstat', base]) }
}
// Keep the work as a branch (evidence you can diff later), then drop the checkout.
async function keepAndRemove(top: string, dir: string, branch: string, message: string) {
  try {
    await git(dir, ['-c', 'user.name=perch race', '-c', 'user.email=perch@localhost', 'commit', '--no-verify', '-q', '--allow-empty', '-m', message])
    await git(dir, ['branch', '-f', branch, 'HEAD'])
  } catch {}
  await git(top, ['worktree', 'remove', '--force', dir]).catch(() => {})
}

// ---------- a run ----------
type StartInput = { task: string; cwd: string; models?: string[]; verify?: string; base?: string; requester?: string; picked?: string; mcp?: boolean; autoCandidate?: string }
let startQueue = Promise.resolve()
export async function start(input: StartInput) {
  // Existing Claude sessions keep their MCP schema until they restart. Their old start call
  // still goes through the automatic limits and completion outbox, without a new argument.
  if (!input.autoCandidate && input.requester) input = { ...input, autoCandidate: pendingCandidate(input.requester)?.id }
  // Serialize admission, not the races: concurrent requests can fill both slots without
  // oversubscribing them or dropping the second request during asynchronous git checks.
  const previous = startQueue
  let release!: () => void
  startQueue = new Promise<void>(resolve => { release = resolve })
  await previous
  try {
    if (input.autoCandidate) {
      const c = candidate(input.autoCandidate)
      if (c && c.conversation_id === input.requester && c.run_id) {
        const r = get<any>('select * from race_runs where id = ?', c.run_id)
        if (r) return { error: undefined, runId: r.id, models: all<any>('select model from race_entries where run_id = ?', r.id).map(e => e.model), base: r.base.slice(0, 10), picked: r.picked }
      }
      const error = validateCandidate(input.autoCandidate, input.requester)
      if (error) return { error }
      input = { ...input, models: autoConfig().models.filter((m: string) => isCodex(m) ? codexReadySync() : !allCapped() && !isCapped(m.match(/^claude-(\w+)-/)?.[1] as Tier)).slice(0, 2), mcp: false, base: 'HEAD' }
      if (!input.verify?.trim()) return { error: 'Automatic races need a focused verify command after scoping.' }
    }
    const out = await startRun(input)
    if (input.autoCandidate && out.error) skipCandidate(input.autoCandidate, input.requester!, out.error)
    return out
  } catch (e: any) {
    const error = String(e?.message ?? e).slice(0, 800)
    if (input.autoCandidate) skipCandidate(input.autoCandidate, input.requester!, error)
    return { error }
  } finally { release(); notify() }
}

async function startRun(input: StartInput) {
  if (!input.task?.trim()) return { error: 'What is the task?' }
  const models: string[] = [...new Set<string>(input.models ?? cfg().models)].slice(0, 5)
  if (models.length < 2) return { error: 'A race needs at least two models.' }
  const capacity = raceCapacityError(models.length)
  if (capacity) return { error: capacity }
  if (input.requester && get("select 1 from race_runs where requester = ? and status = 'running'", input.requester)) return { error: 'This conversation already has a running race.' }
  if (input.autoCandidate) {
    if (isUnderPressure()) return { error: 'The Mac is under pressure; continue without a race.' }
    const dirty = await git(input.cwd, ['status', '--porcelain', '--untracked-files=normal'], 20_000)
    if (dirty) return { error: 'This checkout has uncommitted work; automatic racers need a clean, reproducible starting point. Continue normally.' }
  }
  const common = await git(input.cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => '')
  if (!common) return { error: `${input.cwd} isn't a git repository.` }
  const top = dirname(common)
  const base = await git(input.cwd, ['rev-parse', input.base ?? 'HEAD']).catch(() => '')
  if (!base) return { error: `Unknown base ${input.base}` }
  if (models.some(isCodex) && !codexReadySync()) return { error: 'Codex isn\'t ready (signed out or at its limit); drop the codex: models or sign in.' }
  // Recheck after asynchronous git calls: the user may have disabled races or sent a new request.
  if (input.autoCandidate) { const error = validateCandidate(input.autoCandidate, input.requester); if (error) return { error } }
  // The model you would have used: the asking chat's main model.
  const picked = input.picked ?? (input.requester ? get<any>(`select model from usage_msgs where session = ? group by model order by sum(cost) desc limit 1`, input.requester)?.model ?? null : null)
  const id = randomUUID()
  run('insert into race_runs (id, task, top, base, requester, picked, verify, mcp, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, input.task, top, base, input.requester ?? null, picked, input.verify ?? null, input.mcp ? 1 : 0, Date.now())
  for (const m of models) run('insert into race_entries (id, run_id, model) values (?, ?, ?)', randomUUID(), id, m)
  if (input.autoCandidate) startedCandidate(input.autoCandidate, id)
  drive(id)
  return { runId: id, models, base: base.slice(0, 10), picked }
}

const fail = (table: string, id: string, e: any) => run(`update ${table} set status = 'error', error = ?, ended_at = ? where id = ?`, String(e?.message ?? e).slice(0, 800), Date.now(), id)
const driving = new Set<string>()
function drive(id: string) {
  if (driving.has(id)) return
  driving.add(id)
  advance(id).catch(e => { run(`update race_runs set status = 'error', error = ?, ended_at = ? where id = ?`, String(e?.message ?? e).slice(0, 800), Date.now(), id) })
    .finally(() => { driving.delete(id); deliver(); notify() })
}

async function advance(id: string) {
  const r = () => get<any>('select * from race_runs where id = ?', id)
  if (r().phase === 'race') { await racePhase(id); run(`update race_runs set phase = 'review' where id = ?`, id); notify() }
  if (r().phase === 'review') { await reviewPhase(id); run(`update race_runs set phase = 'merge' where id = ?`, id); notify() }
  if (r().phase === 'merge') await mergePhase(id)
}

async function racePhase(id: string) {
  const r = get<any>('select * from race_runs where id = ?', id)
  const c = cfg()
  await Promise.allSettled(all<any>('select * from race_entries where run_id = ?', id).map(async e => {
    if (['done', 'error'].includes(e.status)) return
    try {
      if (e.status === 'queued') {
        const dir = await addWorktree(r.top, r.base, `race-${id.slice(0, 8)}-${slug(e.model)}`)
        const out = join(OUT_DIR, `${e.id}.jsonl`)
        const pid = spawnAgent(e.model, `${RACE}\n\nTASK:\n${r.task}${r.verify ? `\n\nThe solution will be checked with: ${r.verify}` : ''}`, dir, out, { budget: c.budgetUsd, mcp: !!r.mcp })
        run(`update race_entries set status = 'running', worktree = ?, out = ?, pid = ?, started_at = ? where id = ?`, dir, out, pid, Date.now(), e.id)
        notify()
        e = get<any>('select * from race_entries where id = ?', e.id)
      }
      const log = await waitFor(e.pid, e.out, e.started_at, c.timeoutMin)
      const ended = log.at ?? Date.now()
      const { diff, stat } = await diffOf(e.worktree, r.base)
      const v = await verify(r.verify, e.worktree)
      run(`update race_entries set status = ?, error = ?, ended_at = ?, duration_ms = ?, usd = ?, tokens = ?, turns = ?, tools = ?, diff = ?, diff_stat = ?, summary = ?, verify = ? where id = ?`,
        diff.trim() ? 'done' : 'error', diff.trim() ? (log.error || null) : `made no change${log.error ? ` (${log.error})` : ''}`, ended, ended - e.started_at, log.usd, log.tokens, log.turns, JSON.stringify(log.tools),
        diff.slice(0, 300_000), stat, log.result.slice(-3000), v ? JSON.stringify(v) : null, e.id)
    } catch (err) { fail('race_entries', e.id, err) }
    notify()
  }))
  if (all<any>(`select id from race_entries where run_id = ? and status = 'done'`, id).length < 1) throw new Error('No contestant finished with a change.')
}

async function reviewPhase(id: string) {
  const r = get<any>('select * from race_runs where id = ?', id)
  const done = all<any>(`select * from race_entries where run_id = ? and status = 'done'`, id)
  if (!all<any>('select 1 from race_reviews where run_id = ?', id).length)
    for (const a of done) for (const b of done) if (a.id !== b.id) run('insert into race_reviews (id, run_id, reviewer, target) values (?, ?, ?, ?)', randomUUID(), id, a.id, b.id)
  await Promise.allSettled(all<any>('select * from race_reviews where run_id = ?', id).map(async v => {
    if (['done', 'error'].includes(v.status)) return
    const me = done.find(e => e.id === v.reviewer), them = done.find(e => e.id === v.target)
    try {
      if (v.status === 'queued') {
        const out = join(OUT_DIR, `${v.id}.jsonl`)
        const prompt = `${REVIEW}\n\nTASK:\n${r.task}${r.verify ? `\n\nCheck command: ${r.verify}${them.verify ? ` (its result on this solution: ${JSON.parse(them.verify).ok ? 'passed' : 'FAILED'})` : ''}` : ''}\n\nYOUR OWN SOLUTION'S DIFF:\n${String(me.diff).slice(0, 60_000)}`
        const pid = spawnAgent(me.model, prompt, them.worktree, out, { budget: cfg().budgetUsd / 2, readOnly: true })
        run(`update race_reviews set status = 'running', out = ?, pid = ?, started_at = ? where id = ?`, out, pid, Date.now(), v.id)
        notify()
        v = get<any>('select * from race_reviews where id = ?', v.id)
      }
      const log = await waitFor(v.pid, v.out, v.started_at, cfg().reviewTimeoutMin)
      const j = lastJson(log.result)
      if (!j) throw new Error(`review gave no verdict: ${log.error || log.result.slice(-300)}`)
      run(`update race_reviews set status = 'done', result = ?, usd = ?, tokens = ?, ended_at = ?, duration_ms = ? where id = ?`, JSON.stringify(j), log.usd, log.tokens, log.at ?? Date.now(), (log.at ?? Date.now()) - v.started_at, v.id)
    } catch (err) { fail('race_reviews', v.id, err) }
    notify()
  }))
}

// Peer score: the mean score the other contestants gave it, with the verify result as a tiebreak.
export function peerRank(entries: any[], reviews: any[]) {
  return entries.map(e => {
    const got = reviews.filter(v => v.target === e.id && v.result).map(v => (typeof v.result === 'string' ? JSON.parse(v.result) : v.result))
    const score = got.length ? got.reduce((a, j) => a + (Number(j.score) || 0), 0) / got.length : null
    const ok = e.verify ? (typeof e.verify === 'string' ? JSON.parse(e.verify) : e.verify).ok : null
    return { id: e.id, model: e.model, score, verifyOk: ok, sufficientVotes: got.filter(j => j.sufficient).length, votes: got.length }
  }).sort((a, b) => (Number(b.verifyOk !== false) - Number(a.verifyOk !== false)) || ((b.score ?? -1) - (a.score ?? -1)))
}

async function mergePhase(id: string) {
  let r = get<any>('select * from race_runs where id = ?', id)
  const entries = all<any>(`select * from race_entries where run_id = ? and status = 'done'`, id)
  const reviews = all<any>(`select * from race_reviews where run_id = ? and status = 'done'`, id)
  const best = entries.find(e => e.id === peerRank(entries, reviews)[0].id)!
  const out = join(OUT_DIR, `${id}-merge.jsonl`)
  if (!r.synth) {
    // The final starts from the best solution's worktree; the others get kept as branches and removed.
    const prompt = `${MERGE}\n\nTASK:\n${r.task}${r.verify ? `\n\nCheck command: ${r.verify}` : ''}\n\n${entries.map(e => `=== CONTESTANT ${e.model}${e.id === best.id ? ' (you; the current directory)' : ''} · ${e.diff_stat} · ${e.verify ? (JSON.parse(e.verify).ok ? 'check passed' : 'check FAILED') : 'no check'} ===\n${String(e.diff).slice(0, 40_000)}`).join('\n\n')}\n\n=== REVIEWS ===\n${reviews.map(v => `--- review ${v.id}: ${entries.find(e => e.id === v.reviewer)?.model} on ${entries.find(e => e.id === v.target)?.model} ---\n${v.result}`).join('\n\n').slice(0, 80_000)}`
    const pid = spawnAgent(best.model, prompt, best.worktree, out, { budget: cfg().budgetUsd })
    run(`update race_runs set synth = ? where id = ?`, best.model, id)
    run('update race_runs set pid = ?, synth_started = ? where id = ?', pid, Date.now(), id)
    notify()
    r = get<any>('select * from race_runs where id = ?', id)
  }
  const log = await waitFor(r.pid, out, r.synth_started, cfg().timeoutMin)
  const findings = lastJson(log.result) ?? { error: `no findings: ${log.error || log.result.slice(-300)}` }
  const { diff } = await diffOf(best.worktree, r.base)
  const v = await verify(r.verify, best.worktree)
  const short = id.slice(0, 8)
  for (const e of all<any>('select * from race_entries where run_id = ?', id)) {
    if (!e.worktree || e.id === best.id || !existsSync(e.worktree)) continue
    await keepAndRemove(r.top, e.worktree, `race/${short}/${slug(e.model)}`, `race ${short}: ${e.model}`)
    run('update race_entries set branch = ? where id = ?', `race/${short}/${slug(e.model)}`, e.id)
  }
  // The best contestant's own work, before merging, is its diff in race_entries; its worktree becomes the final.
  run('update race_entries set branch = ? where id = ?', `race/${short}/final`, best.id)
  await keepAndRemove(r.top, best.worktree, `race/${short}/final`, `race ${short}: final (${best.model} merged the best parts)\n\n${findings.summary ?? ''}`)
  const usd = (get<any>('select sum(usd) u from race_entries where run_id = ?', id)?.u ?? 0) + (get<any>('select sum(usd) u from race_reviews where run_id = ?', id)?.u ?? 0) + log.usd
  run(`update race_runs set status = 'done', phase = 'done', findings = ?, final_branch = ?, final_diff = ?, final_verify = ?, usd = ?, ended_at = ? where id = ?`,
    JSON.stringify(findings), `race/${short}/final`, diff.slice(0, 300_000), v ? JSON.stringify(v) : null, usd, Date.now(), id)
  const report = reportMd(id)
  const file = join(OUT_DIR, `${id}.md`)
  writeFileSync(file, report)
  run('update race_runs set report = ? where id = ?', file, id)
}

// ---------- reading results ----------
const J = (s: any) => { try { return typeof s === 'string' ? JSON.parse(s) : s ?? null } catch { return null } }

// Was the model you'd have used too much, right, or too little for this task?
export function sizing(picked: string | null, entries: { model: string; usd: number | null; duration_ms: number | null; sufficient: boolean }[]) {
  if (!picked) return null
  const mine = entries.find(e => e.model === picked)
  const enough = entries.filter(e => e.sufficient)
  if (!enough.length) return { kind: 'none-enough', text: 'No contestant was enough on its own.' }
  if (!mine) return null
  if (!mine.sufficient) return { kind: 'underkill', text: `${pretty(picked)} wasn't enough; ${enough.map(e => pretty(e.model)).join(', ')} ${enough.length > 1 ? 'were' : 'was'}.` }
  const cheaper = enough.filter(e => e.model !== picked && ((e.usd != null && mine.usd != null && e.usd < mine.usd * 0.7) || (e.duration_ms != null && mine.duration_ms != null && e.duration_ms < mine.duration_ms * 0.7)))
  return cheaper.length ? { kind: 'overkill', text: `${pretty(picked)} was enough, but so was ${cheaper.map(e => pretty(e.model)).join(', ')} for less time or money.` } : { kind: 'right', text: `${pretty(picked)} was enough and nothing cheaper or faster was.` }
}

export function detail(id: string) {
  const r = get<any>('select * from race_runs where id = ?', id)
  if (!r) return null
  const findings = J(r.findings)
  const entries = all<any>('select * from race_entries where run_id = ? order by started_at', id).map(e => ({ ...e, tools: J(e.tools), verify: J(e.verify) }))
  const reviews = all<any>('select * from race_reviews where run_id = ?', id).map(v => ({ ...v, result: J(v.result) }))
  const adj = findings?.adjudication ?? []
  const rank = peerRank(entries.filter(e => e.status === 'done'), reviews.filter(v => v.result))
  const per = entries.map(e => {
    const by = reviews.filter(v => v.reviewer === e.id && v.result), on = reviews.filter(v => v.target === e.id && v.result)
    const judged = (vs: any[]) => vs.flatMap(v => (v.result.issues ?? []).map((_: any, i: number) => adj.find((a: any) => a.review === v.id && a.issue === i))).filter(Boolean)
    const raised = judged(by), against = judged(on)
    const f = findings?.models?.[e.model] ?? {}
    return { ...e, peerScore: rank.find(x => x.id === e.id)?.score ?? null, strengths: f.strengths ?? [], weaknesses: f.weaknesses ?? [], sufficient: f.sufficient ?? null, size: f.size ?? null,
      issuesRaised: by.reduce((a, v) => a + (v.result.issues?.length ?? 0), 0), issuesRaisedValid: raised.filter((a: any) => a.valid).length, issuesJudged: raised.length,
      issuesAgainstValid: against.filter((a: any) => a.valid).length, rank: findings?.ranking?.find((x: any) => x.model === e.model)?.rank ?? null }
  })
  const size = sizing(r.picked, per.map(e => ({ model: e.model, usd: e.usd, duration_ms: e.duration_ms, sufficient: !!e.sufficient })))
  return { ...r, findings, final_verify: J(r.final_verify), entries: per, reviews, sizing: size }
}

export function reportMd(id: string) {
  const d = detail(id)!
  const f = d.findings ?? {}
  const min = (ms: number | null) => ms == null ? '–' : `${(ms / 60_000).toFixed(1)}m`
  const rows = d.entries.map((e: any) => `| ${pretty(e.model)}${f.winner === e.model ? ' 🏆' : ''} | ${e.rank ?? '–'} | ${e.peerScore?.toFixed(0) ?? '–'} | ${e.verify ? (e.verify.ok ? 'pass' : 'FAIL') : '–'} | ${min(e.duration_ms)} | ${e.usd ? `$${e.usd.toFixed(2)}` : isCodex(e.model) ? 'plan' : '–'} | ${e.tokens ? `${Math.round(e.tokens / 1000)}k` : '–'} | ${e.turns ?? '–'} | ${Object.values(e.tools ?? {}).reduce((a: number, n: any) => a + n, 0)} | ${e.issuesRaisedValid}/${e.issuesJudged} | ${e.issuesAgainstValid} | ${e.sufficient == null ? '–' : e.sufficient ? 'yes' : 'no'} | ${e.size ?? '–'} |`)
  return `# Race ${id.slice(0, 8)}

**Task:** ${d.task.split('\n')[0].slice(0, 300)}

Base \`${String(d.base).slice(0, 10)}\` in \`${d.top}\` · ${new Date(d.created_at).toISOString().slice(0, 16)} · total ${d.usd ? `$${d.usd.toFixed(2)}` : '–'} (Claude at API prices; Codex runs on the ChatGPT plan)
**Final solution:** branch \`${d.final_branch}\` (built by ${d.synth ? pretty(d.synth) : '–'})${d.final_verify ? ` · check ${d.final_verify.ok ? 'passed' : 'FAILED'}` : ''}
${f.summary ?? ''}
${d.sizing ? `\n**Your pick (${pretty(d.picked)}):** ${d.sizing.kind} — ${d.sizing.text}\n` : ''}
| Model | Rank | Peer score | Check | Time | Cost | Tokens | Turns | Tool calls | Valid issues raised | Valid issues against | Enough alone | Size |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

## Strengths and weaknesses
${d.entries.map((e: any) => `### ${pretty(e.model)}\n${e.strengths.map((s: string) => `- ➕ ${s}`).join('\n')}\n${e.weaknesses.map((s: string) => `- ➖ ${s}`).join('\n')}\n- Tools: ${Object.entries(e.tools ?? {}).sort((a: any, b: any) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ×${n}`).join(', ') || 'none recorded'}`).join('\n\n')}

## What the final took from each
${Object.entries(f.taken ?? {}).map(([m, xs]: any) => `- **${pretty(m)}:** ${(xs ?? []).join('; ')}`).join('\n') || '–'}

## Lessons
${(f.lessons ?? []).map((l: string) => `- ${l}`).join('\n') || '–'}

## Evidence
${d.entries.map((e: any) => `- ${pretty(e.model)}: branch \`${e.branch ?? '–'}\`, event log \`${e.out ?? '–'}\`${e.verify ? `, check output in perch (race ${id.slice(0, 8)})` : ''}`).join('\n')}
- Reviews: ${d.reviews.length} (${d.reviews.filter((v: any) => v.result).length} with verdicts); adjudications: ${(f.adjudication ?? []).length}
`
}

export function list(limit = 30) {
  return all<any>('select id, task, status, phase, error, picked, synth, final_branch, usd, created_at, ended_at from race_runs order by created_at desc limit ?', limit)
    .map(r => ({ ...r, task: String(r.task).slice(0, 200), winner: J(get<any>('select findings from race_runs where id = ?', r.id)?.findings)?.winner ?? null,
      models: all<any>('select model, status from race_entries where run_id = ?', r.id) }))
}

// ---------- across races (and shadow runs): who is good at what, and how often you over/under-size ----------
export function insights() {
  const runs = all<any>(`select id from race_runs where status = 'done' order by created_at desc limit 200`).map(r => detail(r.id)!)
  const by: Record<string, any> = {}
  const med = (xs: number[]) => { const s = xs.filter(x => x != null && !isNaN(x)).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null }
  for (const d of runs) for (const e of d.entries) {
    const m = by[e.model] ??= { model: e.model, races: 0, wins: 0, finished: 0, checks: 0, checksPassed: 0, enough: 0, scores: [] as number[], times: [] as number[], costs: [] as number[], tokens: [] as number[], raised: 0, raisedValid: 0, judged: 0, against: 0, tools: {} as Record<string, number>, strengths: [] as any[], weaknesses: [] as any[], sizes: {} as Record<string, number> }
    m.races++
    if (d.findings?.winner === e.model) m.wins++
    if (e.status === 'done') m.finished++
    if (e.verify) { m.checks++; if (e.verify.ok) m.checksPassed++ }
    if (e.sufficient) m.enough++
    if (e.size) m.sizes[e.size] = (m.sizes[e.size] ?? 0) + 1
    if (e.peerScore != null) m.scores.push(e.peerScore)
    if (e.duration_ms) m.times.push(e.duration_ms)
    if (e.usd) m.costs.push(e.usd)
    if (e.tokens) m.tokens.push(e.tokens)
    m.raised += e.issuesRaised; m.raisedValid += e.issuesRaisedValid; m.judged += e.issuesJudged; m.against += e.issuesAgainstValid
    for (const [k, n] of Object.entries(e.tools ?? {})) m.tools[k] = (m.tools[k] ?? 0) + (n as number)
    for (const s of e.strengths) m.strengths.push({ text: s, race: d.id })
    for (const s of e.weaknesses) m.weaknesses.push({ text: s, race: d.id })
  }
  const models = Object.values(by).map((m: any) => ({ ...m, scores: undefined, times: undefined, costs: undefined, tokens: undefined,
    peerScore: m.scores.length ? m.scores.reduce((a: number, b: number) => a + b, 0) / m.scores.length : null, medianMs: med(m.times), medianUsd: med(m.costs), medianTokens: med(m.tokens),
    reviewPrecision: m.judged ? m.raisedValid / m.judged : null, topTools: Object.entries(m.tools).sort((a: any, b: any) => b[1] - a[1]).slice(0, 8), tools: undefined,
    strengths: m.strengths.slice(0, 12), weaknesses: m.weaknesses.slice(0, 12) })).sort((a: any, b: any) => b.wins - a.wins || (b.peerScore ?? 0) - (a.peerScore ?? 0))
  // Sizing: races where you'd have used a model, plus shadow verdicts on PRs you shipped.
  const sizes = runs.filter(d => d.sizing && d.sizing.kind !== 'none-enough').map(d => ({ source: 'race', id: d.id, kind: d.sizing!.kind, text: d.sizing!.text, model: d.picked, at: d.created_at }))
  const shadow = Object.entries(shadowSummaries()).filter(([, v]: any) => v && ['cheaper', 'right-cost'].includes(v.kind))
    .map(([url, v]: any) => ({ source: 'shadow', id: url, kind: v.kind === 'cheaper' ? 'overkill' : 'right', text: v.text, model: null, at: null }))
  const all_ = [...sizes, ...shadow]
  const count = (k: string) => all_.filter(s => s.kind === k).length
  return { races: runs.length, running: all<any>(`select id from race_runs where status = 'running'`).length, models,
    sizing: { overkill: count('overkill'), right: count('right'), underkill: count('underkill'), total: all_.length, items: all_.slice(0, 40) },
    shadow: shadowHypotheses().filter(h => h.status !== 'testing').slice(0, 20), list: list(), settings: cfg(), automatic: autoInsights() }
}

// After a restart: pick every running race back up where it was (its agents kept running).
export function startRace(broadcast: (topic: string) => void, sendResult?: (id: string, prompt: string) => void) {
  notify = () => broadcast('race')
  if (sendResult) {
    deliver = () => deliverRaceResults(sendResult)
    deliver()
    setInterval(deliver, 30_000).unref()
  }
  for (const r of all<any>(`select id from race_runs where status = 'running'`)) drive(r.id)
}
