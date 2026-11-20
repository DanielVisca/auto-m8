// Autoresearch: an agent improves ONE measurable metric by iterating, measuring after each small
// change and keeping what helps. The protocol (kickoff, a fenced `autoresearch` report block per
// turn, continue / remind / end) follows PostHog Desktop's autoresearch mode so the two stay
// compatible. perch adds: a git worktree per run so your checkout is never touched, a commit for
// every improvement (each one a restore point), and the same ownership as autopilot (stalls and
// protocol failures land in Needs me).
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { chats, interrupt, send, subscribe } from './chat.ts'
import { editLabels, setTitle } from './conversations.ts'
import { all, db, get, run } from './db.ts'
import { settings } from './settings.ts'
import { autoresearchReading } from './projects.ts'

const exec = promisify(execFile)
// Run commits aren't signed: signing waits for 1Password approval, which would stall the loop.
// Sign them when you take the work (cherry-pick or squash into your own commit).
const git = (cwd: string, args: string[]) => exec('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, maxBuffer: 20e6, timeout: 60_000 }).then(r => r.stdout.trim())

db.exec(`create table if not exists autoresearch_runs (
  id text primary key, conversation_id text, cwd text, worktree text, branch text, config text, iterations text default '[]',
  metric_name text, metric_unit text, status text default 'running', end_reason text, reminders integer default 0,
  created_at integer, ended_at integer
)`)

export type Config = { brief: string; direction: 'minimize' | 'maximize'; maxIterations: number; target: number | null }
type Iteration = { index: number; value: number; summary?: string; hypothesis?: string; approach?: string; kept: boolean; commit?: string; at: number }

export const onOptimize = new Set<() => void>()
const changed = () => onOptimize.forEach(f => f())

// ---------- protocol (same block format as PostHog Desktop) ----------
const REPORT = ['```autoresearch', 'metric: <number>', 'name: <short metric label; identical every time>', 'unit: <unit, e.g. kB, ms, %; omit for counts>',
  'summary: <one line: what you changed>', 'hypothesis: <why it should improve the metric>', 'approach: <short category: caching, query, algorithm…>', '```'].join('\n')
const RESEARCH = ['```autoresearch', 'type: research', 'summary: <what you investigated>', 'finding: <specific finding>', 'next: <next step>', '```'].join('\n')

export function kickoff(cfg: Config) {
  const dir = cfg.direction === 'maximize' ? 'maximize' : 'minimize'
  const target = cfg.target == null ? '' : `\nTarget: the run ends early once the metric ${cfg.direction === 'maximize' ? 'reaches' : 'drops to'} ${cfg.target}.`
  return `You are in autoresearch mode: an iterative loop to ${dir} the metric defined by the brief below. You are working in a dedicated git worktree, so change files freely; perch commits every improvement for you.

Every iteration:
1. Make ONE focused change aimed at the metric. Keep it small and attributable.
2. Measure the metric after the change, the same way every time.
3. End your reply with exactly one report block (a plain number: no units, no thousands separators):

${REPORT}

Before you have a baseline, research turns may end with this checkpoint instead:

${RESEARCH}

The block is read by a machine; without it the iteration does not count. Budget: up to ${cfg.maxIterations} iterations.${target}
Iteration 1: establish and report the baseline (setting up the measurement is this iteration's change if nothing exists). If a change makes the metric worse, revert it in the next iteration and try something else. Never commit, push or open PRs yourself.

Optimization brief (what to optimise, how to measure, constraints):
${cfg.brief}`
}

export function parseReport(text: string) {
  const blocks = [...text.matchAll(/```autoresearch\s*\n([\s\S]*?)```/g)]
  const last = blocks[blocks.length - 1]?.[1]
  if (!last) return null
  const f: Record<string, string> = {}
  for (const line of last.split('\n')) { const m = line.match(/^\s*([a-z_]+)\s*:\s*(.*)$/i); if (m) f[m[1].toLowerCase()] = m[2].trim() }
  if (f.type === 'research' || f.type === 'plan') return { kind: f.type as 'research' | 'plan', fields: f }
  const value = Number(String(f.metric ?? '').replace(/[,_\s]/g, ''))
  return Number.isFinite(value) && f.metric !== undefined ? { kind: 'metric' as const, value, fields: f } : null
}

const better = (a: number, b: number | null, d: Config['direction']) => b === null || (d === 'maximize' ? a > b : a < b)
export function best(its: Iteration[], d: Config['direction']) {
  let b: Iteration | null = null
  for (const i of its) if (better(i.value, b?.value ?? null, d)) b = i
  return b
}

function continuation(r: any, cfg: Config, its: Iteration[]) {
  const b = best(its, cfg.direction)
  const unit = r.metric_unit ? ` ${r.metric_unit}` : ''
  const recent = its.slice(-5).map(i => `Iteration ${i.index}: ${i.value}${unit}${i.kept ? ' (kept)' : ' (worse: revert it)'}${i.summary ? `. ${i.summary}` : ''}`).join('\n')
  return `Iteration ${its.length + 1} of ${cfg.maxIterations}. Best so far: ${b ? `${b.value}${unit} at iteration ${b.index}` : 'none yet'}.
Recent:
${recent || 'none'}
Try a different approach from the ones that didn't help. Make one focused change, measure, and end with the report block.`
}

// ---------- running ----------
async function worktreeFor(cwd: string, id: string) {
  const top = await git(cwd, ['rev-parse', '--show-toplevel']).catch(() => '')
  if (!top) return { cwd, worktree: null, branch: null }
  const branch = `autoresearch/${id.slice(0, 8)}`
  const dir = join(dirname(top), '.perch-worktrees', `${basename(top)}-${id.slice(0, 8)}`)
  mkdirSync(dirname(dir), { recursive: true })
  await git(top, ['worktree', 'add', '-b', branch, dir, 'HEAD'])
  return { cwd: dir, worktree: dir, branch }
}

export async function start(input: { brief: string; direction?: string; cwd?: string; max_iterations?: number; target?: number | null; worktree?: boolean; parent?: string }) {
  const cfg: Config = { brief: input.brief, direction: input.direction === 'maximize' ? 'maximize' : 'minimize', maxIterations: Math.min(50, Math.max(1, Number(input.max_iterations) || 10)), target: input.target == null || input.target === ('' as any) ? null : Number(input.target) }
  const id = randomUUID()
  const base = input.cwd && existsSync(input.cwd) ? input.cwd : settings.chat.cwd
  const wt = input.worktree === false ? { cwd: base, worktree: null, branch: null } : await worktreeFor(base, id)
  const conversationId = randomUUID()
  run('insert into autoresearch_runs (id, conversation_id, cwd, worktree, branch, config, created_at) values (?, ?, ?, ?, ?, ?, ?)', id, conversationId, base, wt.worktree, wt.branch, JSON.stringify(cfg), Date.now())
  send({ by: 'autoresearch', id: conversationId, cwd: wt.cwd, prompt: kickoff(cfg), mode: 'acceptEdits', context: true, resume: false })
  editLabels([conversationId], ['autoresearch'])
  setTitle(conversationId, `Autoresearch: ${cfg.brief.replace(/\s+/g, ' ').slice(0, 90)}`)
  // The conversation that started this run is the parent: a = parent, b = child, so both sides show it in Details.
  if (input.parent && input.parent !== conversationId) run('insert or ignore into links (a, b, kind, note, created_at) values (?, ?, ?, ?, ?)', input.parent, conversationId, 'started', 'autoresearch run', Date.now())
  follow(id)
  changed()
  return { runId: id, conversationId, worktree: wt.worktree, branch: wt.branch }
}

const following = new Set<string>()
export function follow(runId: string) {
  if (following.has(runId)) return
  following.add(runId)
  const r0 = get<any>('select * from autoresearch_runs where id = ?', runId)
  let text = ''
  subscribe(r0.conversation_id, ev => {
    if (ev.parent_tool_use_id) return
    if (ev.type === 'perch_user') text = ''
    if (ev.type === 'stream_event' && ev.event?.delta?.type === 'text_delta') text += ev.event.delta.text
    if (ev.type === 'result') onTurn(runId, text, !!ev.is_error).catch(e => console.error('[autoresearch]', e))
  }, { background: true })
}

async function onTurn(runId: string, text: string, failed: boolean) {
  const r = get<any>('select * from autoresearch_runs where id = ?', runId)
  if (!r || r.status !== 'running') return
  const cfg: Config = JSON.parse(r.config)
  const its: Iteration[] = JSON.parse(r.iterations)
  const rep = failed ? null : parseReport(text)
  const say = (prompt: string) => send({ id: r.conversation_id, prompt })
  if (!rep) {
    if (r.reminders >= 2) return end(runId, 'stalled', 'the agent stopped reporting the metric')
    run('update autoresearch_runs set reminders = reminders + 1 where id = ?', runId)
    return say(`Your last reply had no \`autoresearch\` report block, so it didn't count. Measure the metric now and end with the report block:\n\n${REPORT}`)
  }
  run('update autoresearch_runs set reminders = 0 where id = ?', runId)
  if (rep.kind !== 'metric') return say('Good. Continue: establish the baseline measurement and report it with the metric block.')
  const kept = better(rep.value, best(its, cfg.direction)?.value ?? null, cfg.direction)
  const it: Iteration = { index: its.length + 1, value: rep.value, summary: rep.fields.summary, hypothesis: rep.fields.hypothesis, approach: rep.fields.approach, kept, at: Date.now() }
  // Every improvement is committed in the run's worktree: a restore point per step.
  if (kept && r.worktree) {
    try {
      await git(r.worktree, ['add', '-A'])
      await git(r.worktree, ['commit', '-q', '--allow-empty', '-m', `autoresearch ${it.index}: ${rep.fields.name ?? 'metric'} ${rep.value}${rep.fields.unit ? ' ' + rep.fields.unit : ''}\n\n${it.summary ?? ''}`])
      it.commit = (await git(r.worktree, ['rev-parse', '--short', 'HEAD']))
    } catch {}
  }
  its.push(it)
  run('update autoresearch_runs set iterations = ?, metric_name = coalesce(metric_name, ?), metric_unit = coalesce(metric_unit, ?) where id = ?', JSON.stringify(its), rep.fields.name ?? null, rep.fields.unit ?? null, runId)
  // A run linked to a project workstream feeds its north-star metric (best-so-far values only).
  if (kept) { try { autoresearchReading(r.conversation_id, rep.value, it.summary) } catch (e: any) { console.error('project reading', e.message) } }
  changed()
  const hit = cfg.target != null && (cfg.direction === 'maximize' ? rep.value >= cfg.target : rep.value <= cfg.target)
  if (hit) return end(runId, 'target', `reached the target ${cfg.target}`)
  if (its.length >= cfg.maxIterations) return end(runId, 'budget', `used all ${cfg.maxIterations} iterations`)
  return say(continuation(get<any>('select * from autoresearch_runs where id = ?', runId), cfg, its))
}

function end(runId: string, status: string, reason: string) {
  const r = get<any>('select * from autoresearch_runs where id = ?', runId)
  run('update autoresearch_runs set status = ?, end_reason = ?, ended_at = ? where id = ?', status === 'stalled' ? 'stalled' : 'done', reason, Date.now(), runId)
  if (status === 'stalled') {
    run('insert into user_state (id) values (?) on conflict do nothing', r.conversation_id)
    run(`update user_state set state = 'waiting', state_auto = 2, note = ?, state_at = ? where id = ?`, `autoresearch stalled: ${reason}`, Date.now(), r.conversation_id)
  }
  changed()
}

export function pause(runId: string) {
  const r = get<any>('select * from autoresearch_runs where id = ?', runId)
  if (!r) return
  run(`update autoresearch_runs set status = 'paused' where id = ?`, runId)
  if (chats.get(r.conversation_id)?.state === 'running') interrupt(r.conversation_id)
  changed()
}

export function resume(runId: string) {
  const r = get<any>('select * from autoresearch_runs where id = ?', runId)
  if (!r) return
  run(`update autoresearch_runs set status = 'running', reminders = 0 where id = ?`, runId)
  follow(runId)
  const cfg: Config = JSON.parse(r.config)
  send({ id: r.conversation_id, prompt: continuation(r, cfg, JSON.parse(r.iterations)) })
  changed()
}

export const stop = (runId: string) => { pause(runId); end(runId, 'done', 'stopped by you') }

export function runFor(conversationId: string) {
  const r = get<any>('select * from autoresearch_runs where conversation_id = ? order by created_at desc limit 1', conversationId)
  if (!r) return null
  const cfg = JSON.parse(r.config)
  const its = JSON.parse(r.iterations)
  return { ...r, config: cfg, iterations: its, best: best(its, cfg.direction) }
}

export const listRuns = () => all<any>('select id, conversation_id, metric_name, status, end_reason, created_at from autoresearch_runs order by created_at desc limit 30')

// Runs still marked running pick their follower back up after a restart.
export function resumeFollowers() { for (const r of all<any>(`select id from autoresearch_runs where status = 'running'`)) follow(r.id) }
