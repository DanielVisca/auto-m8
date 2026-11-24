// Shadow mode: would a cheaper or faster model have shipped the same PR?
//
// For a PR you already shipped, perch replays the chat that wrote it: every message you sent that
// chat, on the commit the PR started from, in a throwaway worktree, once per model, all in
// parallel. Each replay is headless Claude Code with file tools only (no network, no gh, no push).
// A judge then compares each replay's diff with the diff that actually merged and says whether it
// reached the same outcome. Cost and time come from Claude Code's own result (total_cost_usd,
// duration_ms) and are set against the original chat's cost and active time (gaps between API
// calls capped at 2 minutes, so your thinking time doesn't count against the agent).
//
// The original model is always replayed too, as a control: if it can't get back to its own
// outcome from the same messages, the context isn't replayable and the PR says so instead of
// blaming the cheaper models.
//
// Hypotheses are derived, never stored: every (PR shape, model) pair is one hypothesis ("Sonnet
// gets the same outcome on posthog/posthog fix S PRs for less"), and every replay of a PR with that
// shape is a verification for or against it. Shape = repo · conventional-commit type · size.
//
// Runs automatically in the background (settings.shadow: a few PRs a day, costliest first,
// preferring shapes whose hypotheses still need trials), or on demand per PR from Settings →
// AI spend per PR, POST /api/shadow/run, or the perch `shadow` MCP tool.
import { banditPick, banditStats } from './learn.ts'
import { isPaused } from './pausehold.ts'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, totalmem } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { all, db, get, run } from './db.ts'
import { prSpend, prSpendDetail } from './prspend.ts'
import { codeRoots, DATA_DIR, settings } from './settings.ts'
import { toItems, itemsOf } from './transcript.ts'
import { agentEnv, loadedModels, localStatus, unloadModel } from './local.ts'
import { isQuiet, isUnderPressure, quietState, startQuiet } from './quiet.ts'
import { learningGate, type UsageSnapshot } from './learning-budget.ts'
import { noteClaude } from './usage.ts'
import { ourMcpTool } from '../shared/brand.ts'

const exec = promisify(execFile)
const git = (cwd: string, args: string[], timeout = 300_000) => exec('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, maxBuffer: 50e6, timeout }).then(r => r.stdout.trim())
const gh = (args: string[]) => exec('gh', args, { maxBuffer: 50e6, timeout: 120_000 }).then(r => r.stdout)
const norm = (u: string) => u.toLowerCase().replace(/\/+$/, '')

db.exec(`create table if not exists shadow_runs (
  id text primary key, pr_url text not null, trigger text, status text default 'running', error text,
  shape text, original text, created_at integer, ended_at integer
)`)
db.exec(`create table if not exists shadow_trials (
  id text primary key, run_id text not null, pr_url text not null, model text not null, control integer default 0,
  status text default 'running', error text, usd real, duration_ms integer, turns integer, tokens integer,
  diff_stat text, diff text, outcome text, score integer, judge text, started_at integer, ended_at integer
)`)
try { db.exec('alter table shadow_trials add column worktree text') } catch {}
db.exec('create index if not exists shadow_trials_pr on shadow_trials (pr_url)')
for (const c of ['task text', 'original_diff text', 'top text', 'models text', 'attempts integer default 0', 'base text', 'brief text', 'fork text', 'plain text', 'fork_tokens integer', 'version integer default 1', 'policy text']) try { db.exec(`alter table shadow_runs add column ${c}`) } catch {}
for (const c of ['pid integer', 'out text', 'summary text', 'fork_file text', 'mode text', 'paused_at integer', 'paused_ms integer default 0']) try { db.exec(`alter table shadow_trials add column ${c}`) } catch {}
// Bump when the replay method changes enough that older results shouldn't stop a PR being replayed
// again. 1: isolated brief, judged vs merged. 2: same-context fork, judged vs the writing chat's PR,
// local models with a fitted context window.
export const REPLAY_VERSION = 2
const OUT_DIR = join(DATA_DIR, 'shadow')
mkdirSync(OUT_DIR, { recursive: true })

// localModels: 'auto' = every installed Ollama model that fits in memory, a list, or [] for none.
const cfg = () => ({ auto: true, mode: 'fork' as 'fork' | 'brief', perDay: 2, maxPrsPerChat: 3, budgetUsd: 15, timeoutMin: 40, localTimeoutMin: 60, quietMinutes: 20, models: ['claude-sonnet-5-5', 'claude-haiku-5-5'],
  localModels: 'auto' as string[] | 'auto', ...(settings as any).shadow })
// Local models (Ollama, through Claude Code) cost nothing, so any same outcome is a win on cost;
// time says whether they're also the faster choice.
export const isLocalModel = (m: string) => !/^(claude-|opus|sonnet|haiku|fable|mythos)/.test(m)
// Local models get a context window big enough for real work. Ollama's default (often 32k) cuts a
// long conversation from the front, so the model never sees the task. For each installed model
// that fits in memory perch makes a variant with a bigger window once (`ollama create`, same
// weights, nothing downloaded): <model>-shadow96k. KV cache is roughly 100 KB a token, so 96k
// costs ~10 GB on top of the weights; the variant is only made when both fit in 70% of memory.
const OLLAMA = () => settings.local.baseUrl.replace(/\/$/, '')
async function ollama(path: string, body?: any) {
  return fetch(`${OLLAMA()}${path}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) }).then(r => r.json())
}
async function variant(name: string, size: number, ctx: number, installed: Set<string>) {
  const v = `${name.replace(/:latest$/, '')}-shadow${Math.round(ctx / 1024)}k`
  if (installed.has(v)) return v
  if (size + ctx * 100_000 > totalmem() * 0.7) return name
  const mf = join(OUT_DIR, `${v.replace(/[^\w.-]/g, '_')}.Modelfile`)
  writeFileSync(mf, `FROM ${name}\nPARAMETER num_ctx ${ctx}\n`)
  try { await exec('ollama', ['create', v, '-f', mf], { timeout: 120_000 }); return v } catch { return name }
}
async function localModels(): Promise<string[]> {
  const c = cfg() as any
  if (Array.isArray(c.localModels)) return c.localModels
  const st = await localStatus().catch(() => null)
  if (!st?.running) return []
  const installed = new Set(st.models.map(m => m.name))
  const base = st.models.filter(m => m.fits && !/-shadow\d+k$/.test(m.name)).sort((a, b) => a.size - b.size)
  return Promise.all(base.map(m => variant(m.name, m.size, Number(c.localContext) || 98_304, installed)))
}
// The window a local model really gets: its num_ctx parameter, else Ollama's default.
async function windowFor(model: string): Promise<number> {
  try {
    const show: any = await ollama('/api/show', { model })
    const n = Number(String(show.parameters ?? '').match(/num_ctx\s+(\d+)/)?.[1])
    if (n) return n
  } catch {}
  return Number((cfg() as any).localContext) || 32_768
}

// ---------- what the original cost, and how long each step took ----------
// prspend gives every chat its cost and active agent time (gaps between API calls capped at 2
// minutes). The replay is measured against the one chat it replays (the costliest writing chat),
// not the whole write stage, so helpers and other chats don't flatter the shadow.
export async function original(url: string) {
  const d: any = await prSpendDetail(url, 365)
  const stages: Record<string, { usd: number; activeMs: number; wallMs: number; n: number }> = {}
  for (const i of d.items ?? []) {
    const s = stages[i.bucket] ??= { usd: 0, activeMs: 0, wallMs: 0, n: 0 }
    s.usd += i.usd; s.n++; s.activeMs += i.ms ?? 0; s.wallMs += i.wallMs ?? 0
  }
  const w = (d.items ?? []).filter((i: any) => i.kind === 'chat' && i.bucket === 'write').sort((a: any, b: any) => b.usd - a.usd)[0]
  // A chat that opened several PRs is replayed whole, so it's compared whole: its full cost and time,
  // and the diffs of every PR it opened in this repo (a replay can't touch other repos, so their
  // share of the cost comes off).
  const repo = url.split('/').slice(3, 5).join('/').toLowerCase()
  const opened: string[] = w ? all<any>('select distinct lower(url) url from conversation_prs where conversation_id = ? and created = 1', w.id).map(r => r.url.replace(/\/+$/, '')) : []
  const prs = opened.filter(u => u.split('/').slice(3, 5).join('/') === repo)
  const scale = w ? (1 / (w.share ?? 1)) * (opened.length ? prs.length / opened.length : 1) : 0
  const models = w ? all<any>(`select model, sum(cost) c from usage_msgs where session = ? and model like 'claude-%' group by model order by c desc`, w.id) : []
  return {
    total: d.total ?? 0, totalMs: d.ms ?? 0, stages, writeSession: w?.id ?? null, writeLabel: w?.label ?? null,
    write: { usd: (w?.usd ?? 0) * scale, activeMs: (w?.ms ?? 0) * scale, wallMs: (w?.wallMs ?? 0) * scale },
    prs: prs.length ? prs : [url], otherRepoPrs: opened.length - prs.length,
    model: models[0]?.model ?? null,
  }
}

// ---------- the PR's shape: what makes PRs comparable ----------
export function shapeOf(p: { repo: string; title: string; additions: number; deletions: number }) {
  const kind = (p.title.match(/^(\w+)(\(|!|:)/)?.[1] ?? 'other').toLowerCase()
  const n = p.additions + p.deletions
  return `${p.repo.toLowerCase()} · ${kind} · ${n < 100 ? 'S' : n < 500 ? 'M' : 'L'}`
}

// ---------- the context the original agent had ----------
function userMessages(session: string) {
  const c = get<any>('select path, cwd from conversations where id = ?', session)
  if (!c?.path || !existsSync(c.path)) return { cwd: c?.cwd ?? null, messages: [] as string[], items: [] as any[], path: null as string | null }
  const clean = (t: string) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<!--perch[\s\S]*?-->/g, '').trim()
  // Only what you typed: perch's own injections (follow-up alarms, helper reports, PR events,
  // task notifications) would send the replay chasing things that no longer exist.
  const injected = /^(\[(?:perch|auto-m8)|\((?:perch|auto-m8):|⏰|<task-notification>|HELPER REPORT|NEEDS HELP|EVENTS\b|\[SYSTEM NOTIFICATION|Caveat:|<command-|<local-command|You stopped here before the work was finished)/
  const items = itemsOf(c.path)
  const messages = items.filter((i: any) => i.kind === 'user').map((i: any) => clean(String(i.text ?? ''))).filter(m => m && !injected.test(m))
  return { cwd: c.cwd as string | null, messages, items, path: c.path as string }
}

// Active time (API-call gaps capped at 2 min) for a session, optionally from a moment on.
function activeBounds(session: string, from = 0) {
  return get<any>(`select sum(min(coalesce(gap, 0), 120000)) active, min(ts) first, max(ts) last from (
      select ts, ts - lag(ts) over (order by ts) gap from usage_msgs where session = ? and ts >= ?)`, session, from) as { active: number; first: number; last: number } | undefined
}

// The PR as the writing chat left it: its last commit pushed before the chat ended. Commits that
// were amended or force-pushed away fall back to the merged diff.
async function writeStageDiff(url: string, top: string, until: number) {
  const merged = async () => ({ diff: await gh(['pr', 'diff', url]), label: 'as merged' })
  try {
    const pr = JSON.parse(await gh(['pr', 'view', url, '--json', 'commits,number']))
    const cs = (pr.commits ?? []) as { oid: string; committedDate: string }[]
    const upto = cs.filter(c => Date.parse(c.committedDate) <= until)
    if (!upto.length || upto.length === cs.length) return await merged()
    const head = upto[upto.length - 1].oid
    await git(top, ['fetch', '--quiet', 'origin', cs[0].oid, head], 600_000)
    const diff = await git(top, ['diff', '--no-color', `${cs[0].oid}^`, head])
    return { diff, label: `as the writing chat left it, ${upto.length} of ${cs.length} commits (${head.slice(0, 8)})` }
  } catch { return await merged() }
}

// Where to fork the original conversation: just before its first code change. Returns the raw
// transcript lines before that point, the typed messages that came after it, and its time.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// Any Bash that can change files counts: an early cut costs a little context, a late one leaks the answer.
const EDIT_CMD = /(sed -i|perl -[a-z]*i|git (apply|commit|am|rm|mv|checkout -- )|\bpatch\b|\btee\b|<<\s*['"]?\w+|\brm\s|\bmv\s|\bcp\s|write_text|writeFile|makemigrations|pnpm (i|install|add)\b|npm (i|install)\b|uv (add|lock)\b)/
// A redirect only counts outside quotes: `jq 'select(.at > "2026-11-10")'` is a comparison, not a write.
const REDIRECT = /(?<![0-9&=-])>>?\s*(?!\/dev\/null|&)["']?[\w~./-]+/
export const editsFiles = (cmd: string) => EDIT_CMD.test(cmd) || REDIRECT.test(cmd.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''"))
export function checkpoint(path: string | null, originalDiff: string, prNumbers: number[] = [], top = '') {
  if (!path || !existsSync(path)) return null
  const raw = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  let cut = -1, ts = 0, reason = ''
  for (let i = 0; i < raw.length && cut < 0; i++) {
    let e: any; try { e = JSON.parse(raw[i]) } catch { continue }
    if (e.type !== 'assistant' || e.isSidechain) continue
    for (const b of e.message?.content ?? []) {
      if (b?.type !== 'tool_use') continue
      if (EDIT_TOOLS.has(b.name) || (b.name === 'Bash' && editsFiles(String(b.input?.command ?? '')))) { cut = i; ts = Date.parse(e.timestamp) || 0; reason = `${b.name}${b.name === 'Bash' ? `: ${String(b.input.command).slice(0, 80)}` : ` ${b.input?.file_path ?? ''}`}`; break }
    }
  }
  if (cut <= 0) return null
  const lines = raw.slice(0, cut)
  // A prefix that already holds the merged change (the chat picked up an existing PR) would just
  // be copied: no fork.
  const added = originalDiff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++') && l.trim().length > 25).map(l => l.slice(1).trim())
  const prefix = lines.join('\n')
  // The chat fetched this very PR before changing anything: it picked up a PR written elsewhere.
  const fetchedPr = prNumbers.some(n => new RegExp(`gh pr (diff|view|checkout)\\s+(--repo\\s+\\S+\\s+)?${n}\\b|pull/${n}/head`).test(prefix))
  if (fetchedPr && added.filter(l => prefix.includes(JSON.stringify(l).slice(1, -1))).length > 3) return { pickedUp: true as const }
  // Otherwise overlap means the cut came too late (an edit perch didn't recognise): no fork.
  if (added.filter(l => prefix.includes(JSON.stringify(l).slice(1, -1))).length > 3) return null
  const injected = /^(\[(?:perch|auto-m8)|\((?:perch|auto-m8):|⏰|<task-notification>|HELPER REPORT|NEEDS HELP|EVENTS\b|\[SYSTEM NOTIFICATION|Caveat:|<command-|<local-command|You stopped here before the work was finished)/
  const later = toItems(raw.slice(cut).join('\n')).filter((i: any) => i.kind === 'user').map((i: any) => String(i.text ?? '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()).filter(m => m && !injected.test(m))
  // Where the original worked on this repo: its checkout, and any worktree of it the chat used
  // (`cd ~/Development/posthog-rm-mcp-registry`). The fork rewrites these to the replay's worktree.
  const name = basename(top), home = homedir()
  const re = new RegExp(`((?:~|${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?:/[\\w.-]+)*?/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-[\\w.-]+)?)(?=[/\\s"'\\\\;&|)]|$)`, 'g')
  const srcs = top ? [...new Set([top, top.replace(home, '~'), ...[...prefix.matchAll(re)].map(m => m[1])])] : []
  return { lines, ts, later, reason, srcs }
}

const FORK = `(auto-m8 shadow replay) From here on you are a different model continuing this conversation, to compare outcomes. Your working copy is now {{DIR}}, a fresh checkout of the repository at the commit the work started from: paths above have been rewritten to it. Read and edit only under {{DIR}}.
External tools (Slack, GitHub, MCP servers, the web) are unavailable now; what they returned above is all you have. Work only on local files, leave your changes uncommitted, don't push or open PRs. Carry on and finish the code change the conversation asks for, then summarise it in two sentences.`
function forkPrompt(later: string[], _top: string) {
  return `${FORK}${later.length ? `\n\nLater in the original conversation the user also said, in order (satisfy these too):\n${later.map((m, i) => `--- ${i + 1} ---\n${m}`).join('\n\n').slice(0, 15_000)}` : ''}`
}

// Claude Code keeps sessions under <config>/projects/<cwd with every non-alphanumeric as '-'>.
const projectDir = (cwd: string) => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
function writeFork(tid: string, fork: { lines: string[]; srcs: string[] }, dir: string, top: string) {
  const sid = randomUUID()
  const srcs = [...new Set([...(fork.srcs ?? []), top])].sort((a, b) => b.length - a.length)
  const body = fork.lines.map(l => {
    let s = l.replace(/"sessionId":"[0-9a-f-]{36}"/g, `"sessionId":"${sid}"`)
    for (const src of srcs) s = s.split(JSON.stringify(src).slice(1, -1)).join(JSON.stringify(dir).slice(1, -1))
    return s
  }).join('\n') + '\n'
  const pd = projectDir(dir)
  mkdirSync(pd, { recursive: true })
  const file = join(pd, `${sid}.jsonl`)
  writeFileSync(file, body)
  run('update shadow_trials set fork_file = ? where id = ?', file, tid)
  return sid
}

// What the original agent read from outside the repo (Slack threads, PRs, issues, Grafana, PostHog,
// the web): a replay has no network, so without this a brief like "fix what this Slack thread
// says" is unanswerable. Anything that carries the merged change itself (a `gh pr diff` of the PR,
// say) is left out, or the replay would just copy the answer.
const EXTERNAL = /^(mcp__|WebFetch|WebSearch)/
const EXTERNAL_CMD = /^\s*(gh |curl |argocd |kubectl )/
export function fetchedContext(items: any[], originalDiff: string, cap = 25_000) {
  const added = new Set(originalDiff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++') && l.trim().length > 25).map(l => l.slice(1).trim()))
  const leaks = (text: string) => { let n = 0; for (const l of text.split('\n')) if (added.has(l.replace(/^[+\-\s]/, '').trim()) && ++n > 3) return true; return false }
  const out: string[] = []
  let used = 0, dropped = 0
  for (const it of items) {
    if (it.kind !== 'assistant') continue
    for (const b of it.blocks ?? []) {
      if (b.type !== 'tool' || !b.result || b.isError) continue
      const cmd = b.name === 'Bash' ? String((b.input as any)?.command ?? '') : ''
      if (!EXTERNAL.test(b.name) && !EXTERNAL_CMD.test(cmd)) continue
      if (/^(send_to_conversation|delegate|follow_up|watch|shepherd|terminal|project|board)/.test(ourMcpTool(b.name) ?? '')) continue
      const result = String(b.result)
      if (leaks(result)) { dropped++; continue }
      const entry = `### ${b.name}${cmd ? `: ${cmd.slice(0, 200)}` : ` ${JSON.stringify(b.input).slice(0, 200)}`}\n${result.slice(0, 3000)}`
      if (used + entry.length > cap) return { text: out.join('\n\n'), dropped, truncated: true }
      out.push(entry); used += entry.length
    }
  }
  return { text: out.join('\n\n'), dropped, truncated: false }
}

async function repoDir(cwd: string | null, repo: string) {
  const name = repo.split('/')[1]
  const tries = [cwd, ...codeRoots().map(r => join(r, name))].filter((d): d is string => !!d && existsSync(d))
  for (const d of tries) {
    const common = await git(d, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => '')
    if (!common) continue
    const top = dirname(common)
    const remote = await git(top, ['remote', 'get-url', 'origin']).catch(() => '')
    if (remote.toLowerCase().includes(repo.toLowerCase())) return top
  }
  return null
}

const REPLAY = `You are re-doing a task that was done before, to compare models. Below are the messages the user sent the original agent, in order. Treat them as the full brief and produce the code change they led to, in this repository, on your own.
Rules: work only on local files. Leave your changes uncommitted. Don't push, open PRs, comment anywhere, or call external services. Don't ask questions: decide and carry on. When the change is complete, stop and summarise it in two sentences.`

function trialArgs(model: string, prompt: string, budget: number) {
  return ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', model, '--no-session-persistence', '--permission-mode', 'acceptEdits',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', ...(isLocalModel(model) ? [] : ['--max-budget-usd', String(budget)]),
    '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git diff:*)', 'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(ls:*)', 'Bash(rg:*)', 'Bash(grep:*)', 'Bash(find:*)', 'Bash(cat:*)',
    '--disallowedTools', 'WebFetch', 'WebSearch', 'Bash(gh:*)', 'Bash(git push:*)', 'Bash(curl:*)']
}

function claude(args: string[], cwd: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const p = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PERCH_SHADOW: '1' } })
    let out = '', err = ''
    p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
    const t = setTimeout(() => { p.kill(); reject(new Error(`timed out after ${Math.round(timeoutMs / 60000)} min`)) }, timeoutMs)
    p.on('error', e => { clearTimeout(t); reject(e) })
    p.on('exit', code => {
      clearTimeout(t)
      try { resolve(JSON.parse(out.trim().split('\n').pop() ?? '')) } catch { reject(new Error(`claude exited ${code}: ${(err || out).slice(-500)}`)) }
    })
  })
}

// ---------- judging: same outcome as what merged? ----------
const JUDGE = `You compare two code changes made for the same task. ORIGINAL is the change that was reviewed and merged. REPLAY is another model's attempt from the same brief.
Decide whether REPLAY reaches the same outcome: same behaviour change, same files or equivalent ones, nothing important missing, nothing harmful added. Style, naming and comments don't matter; tests and docs that ORIGINAL had count a little.
Reply with only JSON: {"outcome":"same"|"partial"|"different","score":0-100,"missing":["..."],"extra":["..."],"why":"one sentence"}`

async function judge(task: string, originalDiff: string, replayDiff: string) {
  if (!replayDiff.trim()) return { outcome: 'different', score: 0, missing: ['no change made'], extra: [], why: 'The replay changed nothing.' }
  const prompt = `${JUDGE}\n\nTASK (first message):\n${task.slice(0, 3000)}\n\nORIGINAL:\n${originalDiff.slice(0, 60_000)}\n\nREPLAY:\n${replayDiff.slice(0, 60_000)}`
  const r = await claude(['-p', prompt, '--output-format', 'json', '--model', 'claude-opus-5-5', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', ''], settings.chat.cwd, 10 * 60_000)
  const j = String(r.result ?? '').match(/\{[\s\S]*\}/)?.[0]
  if (!j) throw new Error('judge gave no verdict')
  return { ...JSON.parse(j), judgeUsd: r.total_cost_usd ?? 0 }
}

// ---------- one run: a PR replayed on several models in parallel ----------
// Replays run detached, writing their result to a file, so a perch restart (frequent: every agent
// that changes perch restarts it) doesn't kill them. On startup perch reattaches to each one.
const isRunning = () => all<any>(`select id, pr_url from shadow_runs where status = 'running'`)
export const running = () => isRunning().length

export async function start(url: string, trigger: 'auto' | 'manual' = 'manual', models?: string[]) {
  url = norm(url)
  const now = isRunning()
  if (now.some(r => r.pr_url === url)) return { error: 'A shadow run for this PR is already going.' }
  if (now.length >= 2) return { error: 'Two shadow runs are already going; try again when one finishes.' }
  const id = randomUUID()
  run('insert into shadow_runs (id, pr_url, trigger, created_at, models, version) values (?, ?, ?, ?, ?, ?)', id, url, trigger, Date.now(), JSON.stringify(models ?? null), REPLAY_VERSION)
  prepare(id)
  return { runId: id }
}

function prepare(id: string) {
  const r = get<any>('select pr_url, models from shadow_runs where id = ?', id)
  run('update shadow_runs set attempts = coalesce(attempts, 0) + 1 where id = ?', id)
  execute(id, r.pr_url, JSON.parse(r.models ?? 'null') ?? undefined).catch(e => { run(`update shadow_runs set status = 'error', error = ?, ended_at = ? where id = ?`, String(e?.message ?? e).slice(0, 800), Date.now(), id); notify() })
  notify()
}

async function execute(id: string, url: string, only?: string[]) {
  const c = cfg()
  const orig = await original(url)
  if (!orig.writeSession) throw new Error('No chat on this Mac wrote this PR, so there is nothing to replay.')
  const opened = orig.prs.length + orig.otherRepoPrs
  if (opened > c.maxPrsPerChat) throw new Error(`The chat that wrote this PR opened ${opened} PRs; a replay of it can't be judged against one outcome (limit ${c.maxPrsPerChat}).`)
  const ctx = userMessages(orig.writeSession)
  if (!ctx.messages.length) throw new Error('The chat that wrote this PR has no readable transcript.')
  const pr = JSON.parse(await gh(['pr', 'view', url, '--json', 'title,additions,deletions,commits']))
  const repo = url.split('/').slice(3, 5).join('/')
  const shape = shapeOf({ repo, title: pr.title, additions: pr.additions, deletions: pr.deletions })
  run('update shadow_runs set shape = ?, original = ? where id = ?', shape, JSON.stringify(orig), id)
  const top = await repoDir(ctx.cwd, repo)
  if (!top) throw new Error(`No local checkout of ${repo} found.`)
  const first = pr.commits?.[0]?.oid
  if (!first) throw new Error('The PR has no commits.')
  await git(top, ['fetch', '--quiet', 'origin', first], 600_000)
  const base = await git(top, ['rev-parse', `${first}^`])
  // Judge against the PR as the writing chat left it: the merged diff also has the shepherd's CI and
  // review fixes, which no replay of the writing chat could produce.
  const until = (activeBounds(orig.writeSession)?.last ?? Date.now()) + 5 * 60_000
  const diffs = await Promise.all((orig.prs as string[]).map(u => writeStageDiff(u, top, until)))
  const originalDiff = diffs.map((d, i) => `### ${orig.prs[i]} (${d.label})\n${d.diff}`).join('\n\n')
  run('update shadow_runs set task = ?, original_diff = ?, top = ?, base = ? where id = ?', ctx.messages[0].slice(0, 5000), originalDiff.slice(0, 200_000), top, base, id)
  // Same context by default: fork the original conversation just before its first code change, so
  // the other model has every read and tool result the original had. If there's no such point, or
  // the context before it already holds the change, fall back to a brief rebuilt from your messages
  // and what the agent fetched.
  const found = checkpoint(ctx.path, originalDiff, (orig.prs as string[]).map(u => Number(u.split('/').pop())), top)
  // The chat read the PR's own change before touching code: it picked up a PR someone (or something)
  // else wrote, so replaying it would only measure copying.
  if (found && 'pickedUp' in found) throw new Error("This chat didn't write the PR: it read the PR's change before editing anything (it picked up an existing PR, e.g. one a Slack task opened). Nothing fair to replay.")
  const cp = c.mode === 'brief' ? null : found
  const fetched = fetchedContext(ctx.items ?? [], originalDiff)
  const plain = `${REPLAY}\n\n${ctx.messages.map((m, i) => `--- message ${i + 1} ---\n${m}`).join('\n\n').slice(0, 30_000)}${fetched.text
    ? `\n\n=== What the original agent read from outside this repository (Slack, GitHub, monitoring), in order. You can't fetch anything yourself; this is all of it. ===\n${fetched.text}` : ''}`
  const brief = cp ? forkPrompt(cp.later, top) : plain
  // How much context the fork needs: exactly what the original sent on its last call before the cut.
  const atCut = cp ? get<any>('select in_tok + cache_read + cache_write t from usage_msgs where session = ? and ts < ? order by ts desc limit 1', orig.writeSession, cp.ts)?.t ?? null : null
  if (cp) {
    // Compare with what the original spent from the checkpoint on, not the investigation before it.
    const after = get<any>(`select sum(cost) usd from usage_msgs where session = ? and ts >= ?`, orig.writeSession, cp.ts)
    const act = activeBounds(orig.writeSession, cp.ts)
    const whole = get<any>('select sum(cost) usd from usage_msgs where session = ?', orig.writeSession)?.usd ?? 0
    const scale = whole ? orig.write.usd / whole : 1
    orig.write = { usd: (after?.usd ?? 0) * scale, activeMs: (act?.active ?? 0) * scale, wallMs: (act ? act.last - cp.ts : 0) * scale }
  }
  Object.assign(orig, { mode: cp ? 'fork' : 'brief', checkpoint: cp ? { ts: cp.ts, lines: cp.lines.length, reason: cp.reason } : null, judgedAgainst: diffs.map(d => d.label), fetchedChars: fetched.text.length, fetchedDropped: fetched.dropped })
  run('update shadow_runs set brief = ?, plain = ?, fork = ?, fork_tokens = ?, original = ? where id = ?', brief, plain, cp ? JSON.stringify({ lines: cp.lines, srcs: cp.srcs }) : null, atCut, JSON.stringify(orig), id)
  // Claude Code's own system prompt and tools take about 20k tokens before the task.
  const plainTokens = Math.ceil(plain.length / 3.5) + 20_000
  const control = orig.model ?? 'claude-opus-5-5'
  // Phase 3 of the learning experiment (learn.ts): unless asked for specific models, Thompson-sample one
  // cloud challenger by expected (matches the original) × (cost saved), instead of replaying every model.
  const bandit = !only?.length && c.bandit !== false && c.models.length > 1
  const pickd = bandit ? banditPick(c.models.filter((m: string) => m !== control), banditStats(shape)) : null
  if (pickd) run('update shadow_runs set policy = ? where id = ?', `bandit:${pickd.chosen.join(',')} ${pickd.draws.map(d => `${d.model}=${d.reward.toFixed(2)}`).join(' ')}`.slice(0, 500), id)
  const models = [...new Set([control, ...(only?.length ? only : [...(pickd?.chosen ?? c.models), ...await localModels()])])]
  // Cloud replays run side by side; local ones one at a time, so two models never fight over memory.
  await Promise.allSettled(models.map(async (model, i) => {
    const tid = randomUUID()
    const dir = join(dirname(top), '.perch-worktrees', `${basename(top)}-shadow-${tid.slice(0, 8)}`)
    const local = isLocalModel(model)
    // A local model's context window is set by Ollama (often 32k): a conversation bigger than that
    // is silently cut from the front, so the model never sees the task. Fork if it fits, else the
    // smaller rebuilt brief, else say so instead of reporting a meaningless "different".
    const window = local ? await windowFor(model) : Infinity
    const mode = !local ? (cp ? 'fork' : 'brief') : cp && (atCut ?? Infinity) + 8_000 <= window ? 'fork' : plainTokens + 8_000 <= window ? 'brief' : null
    if (!mode) {
      run(`insert into shadow_trials (id, run_id, pr_url, model, control, started_at, ended_at, worktree, status, error, mode) values (?, ?, ?, ?, 0, ?, ?, ?, 'skipped', ?, null)`, tid, id, url, model, Date.now(), Date.now(), dir,
        `Needs ~${Math.round(Math.min(atCut ?? Infinity, plainTokens) / 1000)}k tokens of context; Ollama gives ${model} ${Math.round(window / 1000)}k. Raise Ollama's context length to try it.`)
      return notify()
    }
    // Queue first: cloud replays wait for subscription room, locals for a quiet Mac.
    run('insert into shadow_trials (id, run_id, pr_url, model, control, started_at, worktree, status, mode) values (?, ?, ?, ?, ?, ?, ?, ?, ?)', tid, id, url, model, model === control ? 1 : 0, Date.now(), dir, 'queued', mode)
    notify()
    if (local) return void setTimeout(drainLocal, 0)
    try { launch(tid) } catch (e: any) { fail(tid, e); closeRun(id); return }
    if (get<any>('select status from shadow_trials where id = ?', tid)?.status === 'running') await finishTrial(tid)
  }))
  closeRun(id)
}

// Start one replay: check out the PR's base in its own worktree and run Claude Code there, all in
// one detached process (on a big repo the checkout takes minutes, and a perch restart in that
// window must not lose the trial). Local models run the same Claude Code, pointed at Ollama.
function launch(tid: string) {
  const t = get<any>('select * from shadow_trials where id = ?', tid)
  const r = get<any>('select * from shadow_runs where id = ?', t.run_id)
  const c = cfg(), local = isLocalModel(t.model)
  const gate = learningGate(t.model)
  if (gate?.paused) { run('update shadow_trials set error = ? where id = ?', gate.reason, tid); notify(); return false }
  mkdirSync(dirname(t.worktree), { recursive: true })
  const out = join(OUT_DIR, `${tid}.json`), fd = openSync(out, 'w')
  const script = 'git -c core.hooksPath=/dev/null -C "$SHADOW_TOP" worktree add --detach "$SHADOW_DIR" "$SHADOW_BASE" >/dev/null 2>&1 || { echo "worktree add failed"; exit 1; }; cd "$SHADOW_DIR" && exec claude "$@"'
  // Fork mode: the original conversation up to its checkpoint, resumed in the worktree on this model.
  const fork = r.fork && t.mode !== 'brief' ? JSON.parse(r.fork) : null
  const prompt = String(fork ? r.brief : r.plain ?? r.brief).split('{{DIR}}').join(t.worktree)
  const args = trialArgs(t.model, prompt, c.budgetUsd)
  if (fork) args.push('--resume', writeFork(tid, fork, t.worktree, r.top), '--fork-session')
  const p = spawn('/bin/sh', ['-c', script, 'shadow', ...args], { cwd: r.top, detached: true, stdio: ['ignore', fd, fd],
    env: { ...process.env, PERCH_SHADOW: '1', SHADOW_TOP: r.top, SHADOW_DIR: t.worktree, SHADOW_BASE: r.base, ...(local ? agentEnv(t.model) : {}) } })
  closeSync(fd); p.unref()
  run(`update shadow_trials set status = 'running', started_at = ?, pid = ?, out = ?, error = null where id = ?`, Date.now(), p.pid ?? null, out, tid)
  notify()
  return true
}

// Local replays load a big model (tens of GB) and pin the GPU, so they run one at a time across
// every run, and only once the Mac has been quiet for a while: you stepped away, or it's lightly
// loaded with room for the model. If you come back to heavy work mid-replay, it steps aside
// (stopped, model unloaded, queued again) up to MAX_PREEMPTS times.
const MAX_PREEMPTS = 3
const preempts = new Map<string, number>()
const stepAside = new Set<string>()
async function localNeed(model: string) {
  if ((await loadedModels()).includes(model)) return 0
  // Weights plus the KV cache for its window (~100 KB a token): a 96k variant of a 19 GB model is ~28 GB.
  const st = await localStatus().catch(() => null)
  const weights = st?.models.find(m => m.name === model)?.size ?? 20 * 1024 ** 3
  return weights + (await windowFor(model)) * 100_000
}
let draining = false
async function drainLocal() {
  if (draining) return
  draining = true
  try {
    const busy = all<any>(`select model from shadow_trials where status = 'running'`).some(t => isLocalModel(t.model))
    const q = all<any>(`select id, run_id, model from shadow_trials where status = 'queued' order by started_at, rowid`).find(t => isLocalModel(t.model))
    if (busy || !q) return
    if (!isQuiet({ bytes: await localNeed(q.model), minutes: cfg().quietMinutes })) return
    try { launch(q.id) } catch (e: any) { fail(q.id, e); closeRun(q.run_id); draining = false; return drainLocal() }
    finishTrial(q.id)
  } finally { draining = false }
}
export function localGate() {
  const qs = all<any>(`select model from shadow_trials where status = 'queued' order by started_at, rowid`).filter(t => isLocalModel(t.model))
  return qs.length ? { waiting: qs.length, model: qs[0].model, ...quietState({ bytes: 0, minutes: cfg().quietMinutes }) } : null
}

const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } }
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))
function fail(tid: string, e: any) {
  run(`update shadow_trials set status = 'error', error = ?, ended_at = ? where id = ?`, String(e?.message ?? e).slice(0, 800), Date.now(), tid)
}

// Replays report their own usage too: don't depend on a foreground chat being active
// to notice that a background replay is approaching a cap. Only read appended bytes.
const replayReads = new Map<string, { offset: number; pending: string }>()
export function readReplayUsage(tid: string, out: string) {
  if (!existsSync(out)) return
  const st = statSync(out), prev = replayReads.get(tid) ?? { offset: 0, pending: '' }
  if (prev.offset === st.size) return
  const from = Math.max(prev.offset > st.size ? 0 : prev.offset, st.size - 256_000), fd = openSync(out, 'r')
  let chunk: string
  try { const b = Buffer.alloc(st.size - from); readSync(fd, b, 0, b.length, from); chunk = b.toString('utf8') } finally { closeSync(fd) }
  const lines = ((from === prev.offset ? prev.pending : '') + chunk).split('\n')
  replayReads.set(tid, { offset: st.size, pending: lines.pop()!.slice(-16_000) })
  for (const line of lines) if (line.includes('"rate_limit_event"')) {
    try { const e = JSON.parse(line); if (e.type === 'rate_limit_event') noteClaude(e, Date.parse(e.timestamp) || st.mtimeMs) } catch {}
  }
}

// SIGSTOP preserves the replay and worktree without burning subscription capacity.
// Persist the suspension before stopping: a restart between these steps can recover it.
export function syncTrialQuota(tid: string, usage?: UsageSnapshot, now = Date.now()) {
  const t = get<any>('select * from shadow_trials where id = ?', tid)
  if (!t || !['running', 'paused'].includes(t.status) || isLocalModel(t.model)) return false
  const gate = learningGate(t.model, usage, now)
  if (gate?.paused) {
    if (t.status !== 'paused') {
      run(`update shadow_trials set status = 'paused', paused_at = ?, error = ? where id = ?`, now, gate.reason, tid)
      notify()
    }
    if (alive(t.pid)) process.kill(-t.pid, 'SIGSTOP')
    return true
  }
  if (t.status === 'paused') {
    // Send CONT before clearing the durable marker, so restart recovery can repeat it.
    if (alive(t.pid)) process.kill(-t.pid, 'SIGCONT')
    run(`update shadow_trials set status = 'running', paused_ms = coalesce(paused_ms, 0) + ?, paused_at = null, error = null where id = ?`, Math.max(0, now - (t.paused_at ?? now)), tid)
    notify()
  }
  return false
}

export function cloudGate() {
  const g = learningGate('claude-opus-5-5')!
  return { ...g, waiting: get<any>(`select count(*) n from shadow_trials where status in ('queued', 'paused', 'judging') and (model like 'claude-%' or status = 'judging')`)?.n ?? 0 }
}

// Re-evaluate every minute, including after reset and server restart. Completed diffs
// can wait for their judge without redoing the replay or losing measured results.
export function drainCloud() {
  for (const t of all<any>(`select id, run_id, model, status from shadow_trials where status in ('queued', 'judging')`)) {
    if (watching.has(t.id) || (t.status === 'queued' && isLocalModel(t.model))) continue
    const gate = learningGate(t.status === 'judging' ? 'claude-opus-5-5' : t.model)
    if (gate?.paused) { run('update shadow_trials set error = ? where id = ?', gate.reason, t.id); continue }
    try {
      if (t.status === 'queued' && !launch(t.id)) continue
      void finishTrial(t.id)
    } catch (e) { fail(t.id, e); closeRun(t.run_id) }
  }
}

// Wait for a trial's replay to exit, then diff and judge it. Safe to call again after a restart.
const watching = new Set<string>()
async function finishTrial(tid: string) {
  if (watching.has(tid)) return
  watching.add(tid)
  const t = get<any>('select * from shadow_trials where id = ?', tid)
  const r = get<any>('select * from shadow_runs where id = ?', t.run_id)
  const local = isLocalModel(t.model)
  try {
    if (['running', 'paused'].includes(t.status)) {
      if (!t.pid || !t.out) throw new Error('auto-m8 restarted before the replay started')
      const mins = isLocalModel(t.model) ? cfg().localTimeoutMin : cfg().timeoutMin
      while (alive(t.pid)) {
        if (!local) readReplayUsage(tid, t.out)
        if (syncTrialQuota(tid)) { await pause(5000); continue }
        const pausedMs = get<any>('select paused_ms from shadow_trials where id = ?', tid)?.paused_ms ?? 0
        if (Date.now() > t.started_at + pausedMs + mins * 60_000) { try { process.kill(-t.pid, 'SIGTERM') } catch {} ; throw new Error(`timed out after ${mins} min`) }
        if (local && !stepAside.has(tid) && isUnderPressure()) { stepAside.add(tid); try { process.kill(-t.pid, 'SIGTERM') } catch {} }
        await pause(5000)
      }
      if (!local) readReplayUsage(tid, t.out)
      if (local) await unloadModel(t.model)
      if (stepAside.delete(tid)) {
        const n = (preempts.get(tid) ?? 0) + 1
        preempts.set(tid, n)
        if (n >= MAX_PREEMPTS) throw new Error(`stopped ${n} times to keep out of the way of your work`)
        run(`update shadow_trials set status = 'queued', pid = null, error = ? where id = ?`, `paused: you came back to heavy work (${n}/${MAX_PREEMPTS})`, tid)
        return // drainLocal starts it again when it's quiet
      }
      let res: any
      try { res = readFileSync(t.out, 'utf8').trim().split('\n').reverse().map(line => { try { return JSON.parse(line) } catch { return null } }).find(e => e?.type === 'result' || e?.result != null); if (!res) throw new Error('no result') } catch { throw new Error(`replay ended without a result: ${existsSync(t.out) ? readFileSync(t.out, 'utf8').slice(-400) : 'no output'}`) }
      // Against the PR's base, not HEAD: a replay that commits its work would otherwise look empty.
      const base = r.base ?? 'HEAD'
      await git(t.worktree, ['add', '-A'])
      const diff = await git(t.worktree, ['diff', '--cached', '--no-color', base])
      const stat = await git(t.worktree, ['diff', '--cached', '--shortstat', base])
      const u = res.usage ?? {}
      run(`update shadow_trials set usd = ?, duration_ms = ?, turns = ?, tokens = ?, diff = ?, diff_stat = ?, summary = ?, status = 'judging', error = ? where id = ?`,
        isLocalModel(t.model) ? 0 : res.total_cost_usd ?? 0, Math.max(0, (res.duration_ms ?? 0) - (get<any>('select paused_ms from shadow_trials where id = ?', tid)?.paused_ms ?? 0)), res.num_turns ?? 0, (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        diff.slice(0, 200_000), stat, String(res.result ?? '').slice(0, 2000), res.is_error ? String(res.subtype ?? 'error') : null, tid)
      notify()
    }
    const j = get<any>('select diff from shadow_trials where id = ?', tid)
    const gate = learningGate('claude-opus-5-5')
    if (j.diff?.trim() && gate?.paused) {
      run('update shadow_trials set error = ? where id = ?', gate.reason, tid)
      return
    }
    const v = await judge(r.task ?? '', r.original_diff ?? '', j.diff ?? '')
    run(`update shadow_trials set outcome = ?, score = ?, judge = ?, status = 'done', ended_at = ?, error = null where id = ?`, v.outcome, Math.round(v.score ?? 0), JSON.stringify(v), Date.now(), tid)
  } catch (e: any) { fail(tid, e) } finally {
    if (t.worktree && existsSync(t.worktree)) await git(t.worktree, ['worktree', 'remove', '--force', t.worktree]).catch(() => {})
    const ff = get<any>('select fork_file from shadow_trials where id = ?', tid)?.fork_file
    if (ff && existsSync(ff)) try { unlinkSync(ff) } catch {}
    if (local) drainLocal()
    replayReads.delete(tid)
    watching.delete(tid)
    closeRun(t.run_id)
    notify()
  }
}

function closeRun(id: string) {
  const ts = all<any>('select status from shadow_trials where run_id = ?', id)
  if (!ts.length || ts.some(t => ['running', 'paused', 'judging', 'queued'].includes(t.status))) return
  run(`update shadow_runs set status = ?, ended_at = ? where id = ? and status = 'running'`, ts.some(t => t.status === 'done') ? 'done' : 'error', Date.now(), id)
}

// After a restart: reattach to replays still going, judge the ones that finished, close the rest.
function resume() {
  // A replay may have reported the newest quota reading while no foreground chat
  // was active. Restore it before admitting queued cloud work after a restart.
  for (const t of all<any>(`select id, out from shadow_trials where out is not null and model like 'claude-%' order by started_at desc limit 6`)) {
    try { readReplayUsage(t.id, t.out) } catch {} // a removed log must not block server startup
  }
  for (const t of all<any>(`select id from shadow_trials where status in ('running', 'paused', 'judging')`)) finishTrial(t.id)
  drainCloud()
  // Runs still preparing (no trials yet) start their preparation again, a few times at most.
  for (const r of all<any>(`select id, attempts from shadow_runs where status = 'running'`)) {
    if (get<any>('select 1 from shadow_trials where run_id = ?', r.id)) continue
    if ((r.attempts ?? 0) < 3) prepare(r.id)
    else run(`update shadow_runs set status = 'error', error = 'auto-m8 kept restarting while preparing the run', ended_at = ? where id = ?`, Date.now(), r.id)
  }
}

// ---------- reading results ----------
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const SAME_SCORE = 80
const isSame = (t: any) => t.outcome === 'same' && (t.score ?? 0) >= SAME_SCORE

// Per PR: the latest run, each trial against the original, and the verdict.
export function forPr(url: string) {
  url = norm(url)
  const r = get<any>('select * from shadow_runs where pr_url = ? order by created_at desc limit 1', url)
  if (!r) return { url, run: null, trials: [], verdict: null }
  const orig = r.original ? JSON.parse(r.original) : null
  const trials = all<any>('select id, model, control, status, mode, summary, error, usd, duration_ms, turns, tokens, diff_stat, outcome, score, judge, started_at, ended_at from shadow_trials where run_id = ? order by control desc, model', r.id)
    .map(t => ({ ...t, judge: t.judge ? JSON.parse(t.judge) : null,
      costRatio: orig?.write?.usd && t.usd != null ? t.usd / orig.write.usd : null,
      timeRatio: orig?.write?.activeMs && t.duration_ms ? t.duration_ms / orig.write.activeMs : null }))
  return { url, run: { ...r, original: orig }, trials, verdict: verdict(orig, trials, r.status) }
}

export function verdict(orig: any, trials: any[], status: string) {
  if (status === 'running') return { kind: 'running', text: trials.some(t => t.status === 'paused' || t.error?.includes('reserving the last 20%')) ? 'Waiting for subscription capacity; resumes automatically.' : 'Replaying…' }
  const done = trials.filter(t => t.status === 'done')
  if (!done.length) return { kind: 'error', text: 'No replay finished.' }
  const ctl = done.find(t => t.control)
  if (!ctl) return { kind: 'inconclusive', text: "The original model's control replay didn't finish, so there's nothing to measure the others against." }
  if (!isSame(ctl)) {
    // The replay can't reach the full outcome, but a cheaper model that does as well as the original
    // model's own replay is still a signal, just not proof.
    const peer = done.filter(t => !t.control && t.usd != null && ctl.usd != null && t.usd < ctl.usd && (t.score ?? 0) >= (ctl.score ?? 0) - 5).sort((a, b) => a.usd - b.usd)[0]
    if (peer) return { kind: 'matches-control', model: peer.model, text: `${pretty(peer.model)} did as well as ${pretty(ctl.model)} replaying itself (${peer.score} vs ${ctl.score}) for ${peer.usd ? `${Math.round(peer.usd / ctl.usd * 100)}% of its cost` : 'free'} and ${Math.round((peer.duration_ms ?? 0) / Math.max(1, ctl.duration_ms ?? 1) * 100)}% of its time. Neither reached the merged outcome from the chat alone (${(ctl.judge?.missing ?? []).slice(0, 2).join('; ') || 'context the replay lacked'}), so this is a signal, not proof.` }
    return { kind: 'inconclusive', text: `The original model didn't get back to its own outcome (${ctl.outcome}, ${ctl.score}), so the chat's messages don't carry the full context. No conclusion about cheaper models.` }
  }
  // Best win: free and faster (a local model) beats everything, then cheapest, then fastest.
  const rank = (t: any) => [isLocalModel(t.model) && (t.timeRatio ?? 2) < 1 ? 0 : 1, t.usd ?? 0, t.duration_ms ?? 0]
  const wins = done.filter(t => !t.control && isSame(t) && (t.costRatio ?? 1) < 1)
    .sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] })
  if (!wins.length) return { kind: 'right-cost', text: 'No cheaper model reached the same outcome: the original spend was the right cost.' }
  const w = wins[0], save = (orig?.write?.usd ?? 0) - w.usd
  const faster = w.timeRatio != null && w.timeRatio < 1 ? `, ${fmtMin((orig.write.activeMs ?? 0) - w.duration_ms)} faster` : w.timeRatio != null ? `, but ${fmtMin(w.duration_ms - orig.write.activeMs)} slower` : ''
  return { kind: 'cheaper', model: w.model, local: isLocalModel(w.model), savedUsd: save, savedMs: (orig?.write?.activeMs ?? 0) - (w.duration_ms ?? 0),
    text: `${pretty(w.model)} reached the same outcome for ${w.usd ? `$${w.usd.toFixed(2)}` : 'free'} vs $${(orig?.write?.usd ?? 0).toFixed(2)} (save $${save.toFixed(2)}${faster}).` }
}
const fmtMin = (ms: number) => `${Math.round(Math.abs(ms) / 60000)} min`
const pretty = (m: string) => { if (isLocalModel(m)) return `${m.replace(/:latest$/, '')} (local)`; const c = m.match(/^claude-(\w+)-([\d-]+)/); return c ? `${c[1][0].toUpperCase()}${c[1].slice(1)} ${c[2].replace(/-/g, '.')}` : m }

// Every (shape, model) pair is a hypothesis; every finished, controlled trial is a verification.
export function hypotheses() {
  const rows = all<any>(`select t.pr_url, t.model, t.usd, t.duration_ms, t.outcome, t.score, r.shape, r.original, r.created_at,
      (select c.outcome = 'same' and c.score >= ${SAME_SCORE} from shadow_trials c where c.run_id = t.run_id and c.control = 1 and c.status = 'done') control_ok
    from shadow_trials t join shadow_runs r on r.id = t.run_id where t.status = 'done' and t.control = 0
      and r.created_at = (select max(created_at) from shadow_runs r2 where r2.pr_url = r.pr_url)`)
  const groups = new Map<string, any[]>()
  for (const t of rows) { if (!t.control_ok) continue; const k = `${t.shape}|${t.model}`; groups.set(k, [...(groups.get(k) ?? []), t]) }
  return [...groups.entries()].map(([k, ts]) => {
    const [shape, model] = k.split('|')
    const ratios = ts.map(t => { const o = JSON.parse(t.original ?? '{}'); return { cost: o.write?.usd ? t.usd / o.write.usd : null, time: o.write?.activeMs ? t.duration_ms / o.write.activeMs : null, saved: (o.write?.usd ?? 0) - t.usd, savedMs: (o.write?.activeMs ?? 0) - t.duration_ms } })
    const same = ts.filter(isSame).length, n = ts.length, rate = same / n
    const costRatio = median(ratios.map(r => r.cost).filter((x): x is number => x != null)), timeRatio = median(ratios.map(r => r.time).filter((x): x is number => x != null))
    const status = n < 3 ? 'testing' : rate >= 0.8 && (costRatio ?? 1) < 0.7 ? 'supported' : rate < 0.5 || (costRatio ?? 1) >= 1 ? 'refuted' : 'mixed'
    const local = isLocalModel(model)
    return { shape, model, local, statement: local
        ? `${pretty(model)} reaches the same outcome as the original on ${shape} PRs for free${timeRatio != null ? `, ${timeRatio < 1 ? 'and faster' : 'but slower'} (time x${timeRatio.toFixed(2)})` : ''}`
        : `${pretty(model)} reaches the same outcome as the original on ${shape} PRs for under 70% of the cost`,
      status, trials: n, same, sameRate: rate, costRatio, timeRatio, needs: Math.max(0, 3 - n),
      savedUsd: ratios.reduce((a, r, i) => a + (isSame(ts[i]) ? r.saved : 0), 0), savedMs: ratios.reduce((a, r, i) => a + (isSame(ts[i]) ? r.savedMs : 0), 0),
      evidence: ts.map((t, i) => ({ url: t.pr_url, outcome: t.outcome, score: t.score, costRatio: ratios[i].cost, timeRatio: ratios[i].time, at: t.created_at })) }
  }).sort((a, b) => b.trials - a.trials || b.savedUsd - a.savedUsd)
}

// Compact per-PR summary for the spend table.
export function summaries() {
  const latest = all<any>(`select r.pr_url from shadow_runs r where r.created_at = (select max(created_at) from shadow_runs r2 where r2.pr_url = r.pr_url)`)
  return Object.fromEntries(latest.map(r => { const f = forPr(r.pr_url); return [r.pr_url, f.verdict] }))
}

export function overview() {
  return { hypotheses: hypotheses(), summaries: summaries(), running: running(), settings: cfg(),
    runs: all<any>('select id, pr_url, trigger, status, error, shape, created_at, ended_at from shadow_runs order by created_at desc limit 30'), localGate: localGate(), cloudGate: cloudGate() }
}

// ---------- background picker ----------
// Merged PRs you wrote, costliest first; PRs whose shape still has a hypothesis under test jump the queue.
export async function pick() {
  // A PR is done once replayed with today's method; one replayed with an older method (isolated
  // brief, merged-diff judging) gets another go.
  const done = new Set(all<any>('select distinct pr_url from shadow_runs where coalesce(version, 1) >= ?', REPLAY_VERSION).map(r => r.pr_url))
  const testing = new Set(hypotheses().filter(h => h.status === 'testing').map(h => h.shape))
  const list = (await prSpend(90, 300)).list.filter((p: any) => /^merged$/i.test(p.state ?? '') && (p.buckets.write?.usd ?? 0) >= 1 && !done.has(norm(p.url)))
  // Only PRs whose writing chat is replayable: it's on this Mac and opened few PRs.
  const ok: string[] = []
  for (const p of list.slice(0, 25)) { const o = await original(p.url); if (o.writeSession && o.prs.length + o.otherRepoPrs <= cfg().maxPrsPerChat) ok.push(p.url) }
  // Shape needs the diff size (one gh call); a PR whose shape still needs trials goes first.
  for (const u of ok.slice(0, 8)) {
    const v = JSON.parse(await gh(['pr', 'view', u, '--json', 'title,additions,deletions']).catch(() => '{}'))
    if (v.title && testing.has(shapeOf({ repo: u.split('/').slice(3, 5).join('/'), title: v.title, additions: v.additions, deletions: v.deletions }))) return u
  }
  return ok[0] ?? null
}

let nextPickAt = Date.now() + 10 * 60_000
async function tick() {
  const c = cfg()
  if (cloudGate().paused) { nextPickAt = 0; return }
  if (!c.auto || running()) return
  if (Date.now() < nextPickAt) return
  // Auto runs check out a big repo and start several agents: wait for a quiet stretch.
  if (!isQuiet({ bytes: 0, minutes: c.quietMinutes })) return
  const today = get<any>(`select count(*) n from shadow_runs where trigger = 'auto' and created_at > ?`, Date.now() - 86400_000)?.n ?? 0
  if (today >= c.perDay) return
  nextPickAt = Date.now() + 60 * 60_000
  const url = await pick().catch(() => null)
  if (url) start(url, 'auto')
}

let notify = () => {}
export function startShadow(broadcast: (topic: string) => void, busyChats: () => number = () => 0) {
  notify = () => broadcast('shadow')
  startQuiet(busyChats)
  resume()
  setInterval(() => { try { drainCloud(); notify() } catch (e) { console.error('[shadow]', e) } }, 60_000).unref()
  setInterval(() => drainLocal().catch(e => console.error('[shadow]', e)), 60_000).unref()
  setTimeout(() => tick().catch(e => console.error('[shadow]', e)), 10 * 60_000)
  setInterval(() => { if (!isPaused()) tick().catch(e => console.error('[shadow]', e)) }, 60_000).unref()
}
