// Projects: a piece of work bigger than one PR ("get every metric into PostHog"), kept as data
// instead of living only in one long conversation. A project is owned by the conversation that
// drives it: its goal, what "done" means, the PRs it opened (and any it adopted), how they wait on
// each other (the perch-plan `after:` lines), where each one is (review, merged, verified), and
// the decisions waiting on you. When auto-m8 restarts mid-turn, or a new conversation picks the work
// up, `project status` gives the whole picture back in one call, without rereading the transcript.
// No chat imports: the MCP process uses this too.
import { randomUUID } from 'node:crypto'
import { all, db, get, run } from './db.ts'
import { decisionsFor } from './decisionstore.ts'
import { proofOf } from './proof.ts'
import './shepherdstore.ts' // creates shepherd_watch, which the graph reads
import { convIdOf, convLink } from '../shared/brand.ts'

db.exec(`create table if not exists projects (
  id text primary key, conversation_id text unique, goal text not null, done_when text,
  status text default 'active',    -- active | done
  created_at integer, updated_at integer
)`)
db.exec('create table if not exists project_prs (project_id text not null, url text not null, primary key (project_id, url))')
// Workstreams: the parallel parts of a plan, each with one north-star metric (baseline → target),
// the workstreams it waits on (a gate), and the agents and PRs working on it. Readings are the
// metric over time: written by agents (project action=record) and by autoresearch runs linked to the
// workstream, so progress comes from measurements, not from someone remembering to update a note.
db.exec(`create table if not exists project_workstreams (
  project_id text not null, key text not null, name text not null, north_star text, metric text, unit text,
  direction text default 'maximize', baseline real, target real, measure text, after text default '[]',
  status text default 'active',    -- active | done (blocked is derived from the gate)
  position integer default 0, created_at integer, updated_at integer, primary key (project_id, key)
)`)
db.exec(`create table if not exists project_readings (
  id integer primary key autoincrement, project_id text not null, workstream text not null, value real not null,
  source text, note text, at integer not null
)`)
db.exec('create index if not exists project_readings_ws on project_readings (project_id, workstream, at)')
// What works on a workstream: helper conversations, autoresearch run conversations, other chats, PRs.
db.exec(`create table if not exists project_links (
  project_id text not null, workstream text not null, kind text not null, ref text not null, created_at integer,
  primary key (project_id, workstream, kind, ref)
)`)

export type WorkstreamInput = { key: string; name?: string; north_star?: string; metric?: string; unit?: string; direction?: 'minimize' | 'maximize'; baseline?: number | null; target?: number | null; measure?: string; after?: string[]; status?: string }

const projectIdFor = (conversationId: string) => get<any>('select id from projects where conversation_id = ?', conversationId)?.id as string | undefined
const slug = (s: string) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
const num = (v: unknown) => v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null

export function setWorkstreams(conversationId: string, list: WorkstreamInput[]) {
  const pid = projectIdFor(conversationId)
  if (!pid) throw new Error('Set the project first (action=set with a goal).')
  const now = Date.now()
  list.forEach((w, i) => {
    const key = slug(w.key || w.name || '')
    if (!key) return
    const cur = get<any>('select * from project_workstreams where project_id = ? and key = ?', pid, key)
    if (!cur) {
      run(`insert into project_workstreams (project_id, key, name, north_star, metric, unit, direction, baseline, target, measure, after, status, position, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, pid, key, w.name ?? key, w.north_star ?? null, w.metric ?? null, w.unit ?? null,
        w.direction === 'minimize' ? 'minimize' : 'maximize', num(w.baseline), num(w.target), w.measure ?? null, JSON.stringify((w.after ?? []).map(slug)),
        w.status === 'done' ? 'done' : 'active', (get<any>('select max(position) m from project_workstreams where project_id = ?', pid)?.m ?? -1) + 1, now, now)
    } else {
      run(`update project_workstreams set name = coalesce(?, name), north_star = coalesce(?, north_star), metric = coalesce(?, metric), unit = coalesce(?, unit),
        direction = coalesce(?, direction), baseline = coalesce(?, baseline), target = coalesce(?, target), measure = coalesce(?, measure),
        after = coalesce(?, after), status = coalesce(?, status), updated_at = ? where project_id = ? and key = ?`,
        w.name ?? null, w.north_star ?? null, w.metric ?? null, w.unit ?? null, w.direction ?? null, num(w.baseline), num(w.target), w.measure ?? null,
        w.after ? JSON.stringify(w.after.map(slug)) : null, w.status ?? null, now, pid, key)
    }
    if (w.status === 'done' && cur?.status !== 'done') gateOpened(conversationId, pid, key)
  })
}

// A reading of a workstream's metric. The first reading becomes the baseline when none was given.
export function recordReading(conversationId: string, workstream: string, value: number, source?: string, note?: string) {
  const pid = projectIdFor(conversationId)
  if (!pid) throw new Error('This conversation has no project.')
  const key = slug(workstream)
  const w = get<any>('select * from project_workstreams where project_id = ? and key = ?', pid, key)
  if (!w) throw new Error(`No workstream "${workstream}". Known: ${all<any>('select key from project_workstreams where project_id = ?', pid).map(r => r.key).join(', ') || 'none'}.`)
  if (!Number.isFinite(value)) throw new Error('value must be a number')
  run('insert into project_readings (project_id, workstream, value, source, note, at) values (?, ?, ?, ?, ?, ?)', pid, key, value, source ?? null, note ?? null, Date.now())
  if (w.baseline == null) run('update project_workstreams set baseline = ? where project_id = ? and key = ?', value, pid, key)
  run('update projects set updated_at = ? where id = ?', Date.now(), pid)
}

export function linkWorkstream(conversationId: string, workstream: string, kind: 'conversation' | 'autoresearch' | 'pr', ref: string) {
  const pid = projectIdFor(conversationId)
  if (!pid) throw new Error('This conversation has no project.')
  const key = slug(workstream)
  if (!get<any>('select 1 from project_workstreams where project_id = ? and key = ?', pid, key)) throw new Error(`No workstream "${workstream}".`)
  const r = kind === 'pr' ? ref : convIdOf(ref)
  run('insert or ignore into project_links (project_id, workstream, kind, ref, created_at) values (?, ?, ?, ?, ?)', pid, key, kind, r, Date.now())
  if (kind === 'pr') run('insert or ignore into project_prs (project_id, url) values (?, ?)', pid, r)
}

// An autoresearch run linked to a workstream reports every kept (best-so-far) value as a reading.
export function autoresearchReading(runConversationId: string, value: number, note?: string) {
  for (const l of all<any>(`select l.project_id, l.workstream, p.conversation_id from project_links l join projects p on p.id = l.project_id
    where l.kind = 'autoresearch' and l.ref = ?`, runConversationId)) {
    run('insert into project_readings (project_id, workstream, value, source, note, at) values (?, ?, ?, ?, ?, ?)', l.project_id, l.workstream, value, `autoresearch ${convLink(runConversationId)}`, note ?? null, Date.now())
    const w = get<any>('select * from project_workstreams where project_id = ? and key = ?', l.project_id, l.workstream)
    if (w && w.baseline == null) run('update project_workstreams set baseline = ? where project_id = ? and key = ?', value, l.project_id, l.workstream)
  }
}

// When a workstream is done, the driving conversation hears which gated workstreams can start now.
function gateOpened(conversationId: string, pid: string, key: string) {
  const ws = all<any>('select * from project_workstreams where project_id = ?', pid)
  const done = new Set(ws.filter(w => w.status === 'done' || w.key === key).map(w => w.key))
  const ready = ws.filter(w => w.status !== 'done' && parseAfter(w.after).includes(key) && parseAfter(w.after).every(a => done.has(a)))
  const text = ready.length ? `Workstream "${key}" is done. Its gate is open for: ${ready.map(w => `${w.key} (${w.name})`).join(', ')}. Start them.` : `Workstream "${key}" is done.`
  try { run('insert into inbox (owner, at, target, event, text) values (?, ?, ?, ?, ?)', conversationId, Date.now(), null, 'gate_open', text) } catch {}
}
// delegations and autoresearch_runs are created by modules this file doesn't import (the MCP process uses it too).
const safe = <T,>(f: () => T): T | null => { try { return f() } catch { return null } }
const parseAfter = (s: string | null) => { try { return JSON.parse(s ?? '[]') as string[] } catch { return [] } }

export type Workstream = {
  key: string; name: string; north_star: string | null; metric: string | null; unit: string | null; direction: 'minimize' | 'maximize'
  baseline: number | null; target: number | null; measure: string | null; after: string[]; status: string
  gate: 'open' | 'blocked'; waiting_on: string[]; current: number | null; best: number | null; progress: number | null; met: boolean
  readings: { value: number; at: number; source: string | null; note: string | null }[]
  agents: { kind: string; id: string; name: string; status: string | null; metric?: string | null }[]
  prs: { url: string; title: string | null; phase: string; checks: string | null; review: string | null }[]
}

function workstreamsOf(pid: string): Workstream[] {
  const rows = all<any>('select * from project_workstreams where project_id = ? order by position, created_at', pid)
  const status = new Map(rows.map(r => [r.key, r.status]))
  return rows.map(w => {
    const readings = all<any>('select value, at, source, note from project_readings where project_id = ? and workstream = ? order by at', pid, w.key).slice(-60)
    const dir = w.direction === 'minimize' ? 'minimize' : 'maximize'
    const current = readings.length ? readings[readings.length - 1].value : null
    const best = readings.length ? readings.reduce((b: number, r: any) => dir === 'minimize' ? Math.min(b, r.value) : Math.max(b, r.value), readings[0].value) : null
    const met = best != null && w.target != null && (dir === 'minimize' ? best <= w.target : best >= w.target)
    // Progress from baseline to target, using the best value seen.
    let progress: number | null = null
    if (best != null && w.target != null && w.baseline != null) {
      progress = w.target === w.baseline ? (met ? 1 : 0) : Math.max(0, Math.min(1, (best - w.baseline) / (w.target - w.baseline)))
    }
    const after = parseAfter(w.after)
    const waiting_on = after.filter(a => status.get(a) !== 'done')
    const links = all<any>('select kind, ref from project_links where project_id = ? and workstream = ? order by created_at', pid, w.key)
    const agents = links.filter(l => l.kind !== 'pr').map(l => {
      const d = safe(() => get<any>('select name, status from delegations where child = ? order by created_at desc limit 1', l.ref))
      const a = l.kind === 'autoresearch' ? safe(() => get<any>('select status, metric_name from autoresearch_runs where conversation_id = ? order by created_at desc limit 1', l.ref)) : null
      const c = get<any>(`select coalesce(u.title, c.title) title, u.state from conversations c left join user_state u on u.id = c.id where c.id = ?`, l.ref)
      return { kind: l.kind, id: l.ref, name: d?.name ?? c?.title ?? l.ref.slice(0, 8), status: a?.status ?? d?.status ?? c?.state ?? null, metric: a?.metric_name ?? null }
    })
    return {
      key: w.key, name: w.name, north_star: w.north_star, metric: w.metric, unit: w.unit, direction: dir, baseline: w.baseline, target: w.target,
      measure: w.measure, after, status: w.status, gate: waiting_on.length ? 'blocked' : 'open', waiting_on, current, best, progress, met,
      readings, agents,
      prs: [...new Set([...links.filter(l => l.kind === 'pr').map(l => l.ref), ...agentPrs(pid, w.key)])].map(u => {
        const pr = prInfo(u)
        return { url: u, title: pr.title, phase: phaseOf(pr), checks: pr.checks, review: pr.review }
      }),
    } as Workstream
  })
}

export type ProjectPr = { url: string; title: string | null; state: string | null; review: string | null; checks: string | null; stage: string | null; outcome: string | null; after: string[] }

export function setProject(conversationId: string, p: { goal?: string; done_when?: string; prs?: string[]; status?: string }) {
  const existing = get<any>('select * from projects where conversation_id = ?', conversationId)
  const id = existing?.id ?? randomUUID()
  if (!existing) {
    if (!p.goal) throw new Error('A new project needs a goal.')
    run('insert into projects (id, conversation_id, goal, done_when, created_at, updated_at) values (?, ?, ?, ?, ?, ?)', id, conversationId, p.goal, p.done_when ?? null, Date.now(), Date.now())
  } else {
    run(`update projects set goal = coalesce(?, goal), done_when = coalesce(?, done_when), status = coalesce(?, status), updated_at = ? where id = ?`,
      p.goal ?? null, p.done_when ?? null, p.status ?? null, Date.now(), id)
  }
  for (const u of p.prs ?? []) if (/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.test(u)) run('insert or ignore into project_prs (project_id, url) values (?, ?)', id, u)
  return projectStatus(conversationId)
}

// Every PR in the project: the ones its conversation opened, the ones added to it, and the ones
// they wait on.
function prsOf(projectId: string, conversationId: string): ProjectPr[] {
  const urls = new Set<string>([
    ...all<any>('select url from conversation_prs where conversation_id = ? and created = 1', conversationId).map(r => r.url),
    ...all<any>('select url from project_prs where project_id = ?', projectId).map(r => r.url),
    // PRs opened by the agents working on a workstream belong to the project too.
    ...agentPrs(projectId),
  ])
  const out = new Map<string, ProjectPr>()
  const add = (u: string) => {
    if (out.has(u)) return
    const pr = prInfo(u)
    out.set(u, pr)
    for (const a of pr.after) add(a)
  }
  for (const u of urls) add(u)
  return [...out.values()]
}

function prInfo(u: string): ProjectPr {
  const p = safe(() => get<any>('select title, state, review, checks from prs where url = ?', u))
  const w = safe(() => get<any>('select stage, outcome, after_urls from shepherd_watch where url = ?', u))
  const after = (() => { try { return JSON.parse(w?.after_urls ?? '[]') as string[] } catch { return [] } })()
  return { url: u, title: p?.title ?? null, state: p?.state ?? null, review: p?.review ?? null, checks: p?.checks ?? null, stage: w?.stage ?? null, outcome: w?.outcome ?? null, after }
}
// PRs created by the conversations linked to a project's workstreams (helpers, autoresearch runs).
function agentPrs(projectId: string, workstream?: string): string[] {
  return all<any>(`select distinct cp.url from project_links l join conversation_prs cp on cp.conversation_id = l.ref and cp.created = 1
    where l.project_id = ? and l.kind != 'pr'${workstream ? ' and l.workstream = ?' : ''}`, ...(workstream ? [projectId, workstream] : [projectId])).map(r => r.url)
}

// Where a PR is, in one word, for the graph: what it is waiting for.
export function phaseOf(p: ProjectPr) {
  if (p.stage === 'verified') {
    // The production proof scorecard on the PR (PostHog scouts): proven, or concerns found after the checks passed.
    const proof = proofOf(p.url)?.state
    return proof === 'proven' ? 'proven' : proof === 'concerns' ? 'needs you' : 'verified'
  }
  if (p.stage === 'handed-off') return 'live, follow-up owns the rest'
  if (p.stage === 'failed') return 'needs you'
  if (p.stage === 'verifying') return 'live, second check due'
  if (p.stage === 'deploying' || p.state === 'MERGED') return 'merged, deploying'
  if (p.state === 'CLOSED' || p.stage === 'closed') return 'closed'
  if (/waiting for/.test(p.outcome ?? '')) return 'waiting on another PR'
  if (p.review === 'APPROVED' && p.checks === 'SUCCESS') return /manual/.test(p.outcome ?? '') ? 'ready: merge is yours' : 'ready to merge'
  if (p.checks === 'FAILURE' || p.checks === 'ERROR') return 'CI red'
  if (p.review === 'CHANGES_REQUESTED') return 'changes requested'
  return 'in review'
}

export function projectStatus(conversationId: string) {
  const p = get<any>('select * from projects where conversation_id = ?', conversationId)
  if (!p) return null
  const prs = prsOf(p.id, conversationId).map(x => ({ ...x, phase: phaseOf(x) }))
  return { ...p, prs, workstreams: workstreamsOf(p.id), decisions: decisionsFor(conversationId), done: prs.length > 0 && prs.every(x => x.phase === 'verified' || x.phase === 'proven' || x.phase === 'closed') }
}

export const projects = () => all<any>(`select conversation_id from projects where status = 'active' order by updated_at desc`).map(r => projectStatus(r.conversation_id)).filter(Boolean)

// The status as text, for agents.
export function projectText(conversationId: string) {
  const s = projectStatus(conversationId)
  if (!s) return 'This conversation has no project yet. Set one with action=set, a goal, and done_when.'
  const n = (u: string) => u.replace('https://github.com/', '').replace('/pull/', '#')
  return [
    `Goal: ${s.goal}`,
    `Done when: ${s.done_when ?? '(not set)'}`,
    `Status: ${s.status}${s.done ? ' (every PR is verified, proven or closed: check the done-when line, then set status=done)' : ''}`,
    '', 'PRs:',
    ...s.prs.map((p: any) => `- ${n(p.url)} ${p.title ?? ''} | ${p.phase}${p.outcome ? ` | ${p.outcome}` : ''}${p.after.length ? ` | after ${p.after.map(n).join(', ')}` : ''}`),
    ...(s.workstreams.length ? ['', 'Workstreams:', ...s.workstreams.map((w: Workstream) => {
      const v = (x: number | null) => x == null ? '?' : `${x}${w.unit ? ` ${w.unit}` : ''}`
      const state = w.status === 'done' ? 'done' : w.met ? 'target met (set status=done when verified)' : w.gate === 'blocked' ? `blocked on ${w.waiting_on.join(', ')}` : 'active'
      return [`- ${w.key}: ${w.name} | ${state}`,
        `  north star: ${w.north_star ?? '(not set)'}${w.metric ? ` | metric ${w.metric} (${w.direction})` : ''}`,
        `  baseline ${v(w.baseline)} → target ${v(w.target)} | latest ${v(w.current)} | best ${v(w.best)}${w.progress != null ? ` | ${Math.round(w.progress * 100)}%` : ''} | ${w.readings.length} readings`,
        ...(w.measure ? [`  measure: ${w.measure}`] : []),
        ...(w.agents.length ? [`  agents: ${w.agents.map(a => `${a.name} (${a.kind}${a.status ? `, ${a.status}` : ''}) ${convLink(a.id)}`).join('; ')}`] : []),
        ...(w.prs.length ? [`  PRs: ${w.prs.map(p => `${n(p.url)} (${p.phase})`).join(', ')}`] : []),
      ].join('\n')
    })] : ['', 'No workstreams yet: add them with action=workstreams for plans with parallel parts and north-star metrics.']),
    '', `Open decisions (${s.decisions.length}):`,
    ...s.decisions.map((d: any) => `- ${d.title}${d.options.length ? ` [${d.options.join(' / ')}]` : ''}${d.recommendation ? ` (recommended: ${d.recommendation})` : ''}`),
  ].join('\n')
}
