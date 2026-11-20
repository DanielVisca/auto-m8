// Learning what to prioritise from production outcomes: the "backprop" experiment, done as credit
// assignment and bandits rather than a neural net (≈300 PRs a quarter fits a few numbers per area,
// not a network). Plan and gates: perch project on conversation 453402f6.
//
//   phase 0  labels: the Works check has to resolve (proven / concern), not stop at "no signal".
//            Fixed in the prod-walkthrough scout (v6, scheduled round 2 at 72h); measured here.
//   phase 1  ledger: one row per PR joining who wrote it (model, $), how long each stage took and
//            the production verdict. The credit-assignment record.
//   phase 1b does ordering matter? Every 5 min, sample whether anything was the limit (quota,
//            machine, helper worktrees, shepherd run caps). Ordering only matters under a limit.
//   phase 2  switchback: each day is control (perch's fixed rank) or learned (value per hour), in a
//            fixed random order. Starts by itself once phases 0 and 1b pass, or settings.learn.switchback.
//   phase 3  shadow mode picks its challenger model with Thompson sampling (see banditPick).
//
// Labels are treated like survival data: a PR whose verdict hasn't arrived is censored, not a failure.
import { createHash } from 'node:crypto'
import { all, db, get, run } from './db.ts'
import { maxHelpers } from './owner.ts'
import { prFlow } from './prflow.ts'
import { prSpend } from './prspend.ts'
import { lastSample } from './quiet.ts'
import { strained } from './reaper.ts'
import { settings } from './settings.ts'
import { usageNow } from './usage.ts'

db.exec(`create table if not exists learn_samples (
  at integer primary key, claude_pct real, codex_pct real, strained integer, helpers integer, helper_cap integer,
  shepherd_capped integer, needs_you integer, running_chats integer, reasons text
)`)
db.exec(`create table if not exists learn_arms (day text primary key, arm text, active integer, created_at integer)`)

const HOUR = 3600_000, DAY = 24 * HOUR
const cfg = () => ({ switchback: null as boolean | null, sampleMinutes: 5, ...(settings as any).learn })

// ---------- small maths ----------
export const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

function normal(rand: () => number) { let u = 0; while (!u) u = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()) }
// Marsaglia–Tsang; shape >= 1 here (Beta(1 + successes, 1 + failures)).
function gamma(k: number, rand: () => number): number {
  if (k < 1) return gamma(k + 1, rand) * Math.pow(rand() || 1e-12, 1 / k)
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x = 0, v = 0
    do { x = normal(rand); v = 1 + c * x } while (v <= 0)
    v = v * v * v
    const u = rand()
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}
export function betaSample(a: number, b: number, rand: () => number = Math.random) { const x = gamma(a, rand), y = gamma(b, rand); return x / (x + y) }

// Beta posterior mean with a prior centred on the global rate (empirical Bayes; strength = pseudo-counts).
export const shrunk = (s: number, n: number, prior: number, strength = 4) => (s + prior * strength) / (n + strength)

// ---------- phase 2: switchback arms ----------
export const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
// A fixed random order: the arm is a hash of the date, so it can't drift with what happened that day.
export function armFor(day: string): 'control' | 'learned' { return createHash('sha256').update(`perch-learn-v1:${day}`).digest()[0] & 1 ? 'learned' : 'control' }

// ---------- phase 1: the ledger ----------
export type LedgerRow = {
  url: string; repo: string; area: string; created: number; merged: number | null; closed: number | null; outcome: string
  usd: number; activeMs: number; model: string | null
  proof: string | null; works: string | null; contained: string | null; verdictAt: number | null
  shipped: 0 | 1 | null      // merged = 1, abandoned/stale = 0, still open = censored
  proven: 0 | 1 | null       // proven = 1, concerns = 0, anything else = censored (PostHog/posthog only)
  hoursToMerge: number | null; hoursToVerdict: number | null; arm: string
}

export function ledgerRow(p: any, spend: any, proof: any, model: string | null): LedgerRow {
  const shipped = p.merged ? 1 : p.outcome === 'abandoned' || p.outcome === 'stale' ? 0 : null
  const proven = proof?.state === 'proven' ? 1 : proof?.state === 'concerns' ? 0 : null
  const verdictAt = proven != null ? proof.updated_at ?? null : null
  return {
    url: p.url, repo: p.repo, area: p.area, created: p.created, merged: p.merged, closed: p.closed, outcome: p.outcome,
    usd: spend?.total ?? 0, activeMs: spend?.ms ?? 0, model,
    proof: proof?.state ?? null, works: proof?.works ?? null, contained: proof?.contained ?? null, verdictAt,
    shipped: shipped as 0 | 1 | null, proven: proven as 0 | 1 | null,
    hoursToMerge: p.merged ? (p.merged - p.created) / HOUR : null,
    hoursToVerdict: verdictAt ? (verdictAt - p.created) / HOUR : null,
    arm: armFor(dayKey(p.created)),
  }
}

// The model that did most of the work in the PR's own conversation (prflow links each PR to it).
function writerModel(conversation: string | null): string | null {
  if (!conversation) return null
  return get<any>(`select model from usage_msgs where session = ? and model != '' group by model order by sum(cost) desc limit 1`, conversation)?.model ?? null
}
const norm = (u: string) => u.toLowerCase().replace(/\/+$/, '')

let ledgerCache: { at: number; rows: LedgerRow[] } | null = null
export async function ledger(days = 90): Promise<LedgerRow[]> {
  if (ledgerCache && Date.now() - ledgerCache.at < 10 * 60_000) return ledgerCache.rows
  const flow = await prFlow(days)
  const spend = new Map(((await prSpend(days, 1000)).list ?? []).map((p: any) => [norm(p.url), p]))
  const proofs = new Map(all<any>('select * from pr_proof').map(r => [norm(r.url), r]))
  const rows = (flow.prs ?? []).filter((p: any) => /^PostHog\//i.test(p.repo)).map((p: any) => ledgerRow(p, spend.get(norm(p.url)), proofs.get(norm(p.url)), writerModel(p.conversation)))
  ledgerCache = { at: Date.now(), rows }
  return rows
}

// ---------- phase 2: the value model ----------
// P(ships | area) and P(proven | area), shrunk toward the global rate, and the expected hours still to
// go given how old the PR already is (conditional on having survived that long: survival, not mean).
export function model(rows: LedgerRow[]) {
  const done = rows.filter(r => r.shipped != null)
  const g = done.length ? done.filter(r => r.shipped === 1).length / done.length : 0.7
  const pv = rows.filter(r => r.proven != null)
  const gp = pv.length ? pv.filter(r => r.proven === 1).length / pv.length : 0.5
  const areas = new Map<string, LedgerRow[]>()
  for (const r of rows) areas.set(r.area, [...(areas.get(r.area) ?? []), r])
  const by = new Map<string, { pShip: number; pProven: number; mergeHours: number[]; n: number }>()
  for (const [a, rs] of areas) {
    const d = rs.filter(r => r.shipped != null), p = rs.filter(r => r.proven != null)
    by.set(a, { pShip: shrunk(d.filter(r => r.shipped === 1).length, d.length, g), pProven: shrunk(p.filter(r => r.proven === 1).length, p.length, gp),
      mergeHours: rs.filter(r => r.hoursToMerge != null).map(r => r.hoursToMerge!), n: rs.length })
  }
  const allHours = rows.filter(r => r.hoursToMerge != null).map(r => r.hoursToMerge!)
  return { globalShip: g, globalProven: gp, by, allHours }
}

export function remainingHours(mergeHours: number[], ageH: number) {
  const later = mergeHours.filter(h => h > ageH)
  return Math.max(1, (median(later) ?? ageH * 2) - ageH)
}

// Expected proven PRs per hour of remaining wait. Impact is 1 for every PR until there is a per-PR measure.
export function value(m: ReturnType<typeof model>, area: string, created: number, now = Date.now()) {
  const a = m.by.get(area)
  const hours = a && a.mergeHours.length >= 5 ? a.mergeHours : m.allHours
  const rem = remainingHours(hours, (now - created) / HOUR)
  const p = (a?.pShip ?? m.globalShip) * (a?.pProven ?? m.globalProven)
  return { p, rem, score: p / rem }
}

// Does the area split carry signal at all? Leave-one-out Brier score of P(ships | area) vs the global rate.
export function calibration(rows: LedgerRow[]) {
  const d = rows.filter(r => r.shipped != null)
  if (d.length < 20) return { n: d.length, areaBrier: null, globalBrier: null, skill: null }
  let ab = 0, gb = 0
  const tot = d.filter(r => r.shipped === 1).length
  for (const r of d) {
    const g = (tot - r.shipped!) / (d.length - 1)
    const same = d.filter(x => x !== r && x.area === r.area)
    const p = shrunk(same.filter(x => x.shipped === 1).length, same.length, g)
    ab += (p - r.shipped!) ** 2; gb += (g - r.shipped!) ** 2
  }
  return { n: d.length, areaBrier: ab / d.length, globalBrier: gb / d.length, skill: 1 - ab / gb }
}

// ---------- phase 1b: is anything the limit? ----------
export function constraintReasons(s: { claudePct: number; codexPct: number; strained: boolean; helpers: number; helperCap: number; shepherdCapped: number }) {
  const r: string[] = []
  if (s.claudePct >= 0.8) r.push('claude-quota')
  if (s.strained) r.push('machine')
  if (s.helpers >= s.helperCap) r.push('helpers')
  if (s.shepherdCapped > 0) r.push('shepherd-cap')
  return r
}

export function sample(now = Date.now(), runningChats = 0) {
  const u = usageNow()
  const pct = (x: any) => Math.max(0, ...((x?.windows ?? []).map((w: any) => Number.isFinite(w.pct) ? w.pct : 0)))
  const m = lastSample()
  const start = new Date(now); start.setHours(0, 0, 0, 0)
  const s = {
    claudePct: pct(u.claude), codexPct: pct(u.codex), strained: strained(m ? { availBytes: m.availBytes, load1: m.load1, cores: m.cores } : null),
    helpers: get<any>(`select count(*) n from delegations where status = 'running' and worktree is not null`)?.n ?? 0, helperCap: maxHelpers,
    shepherdCapped: get<any>(`select count(*) n from shepherd_watch where paused_reason like 'hit % runs today' and paused_at >= ?`, start.getTime())?.n ?? 0,
  }
  const needs = get<any>(`select count(*) n from needs where status = 'needs_you'`)?.n ?? 0
  const reasons = constraintReasons(s)
  run(`insert or replace into learn_samples values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, now, s.claudePct, s.codexPct, s.strained ? 1 : 0, s.helpers, s.helperCap, s.shepherdCapped, needs, runningChats, reasons.join(','))
  return { ...s, needs, reasons }
}

// ---------- phase 3: Thompson sampling for shadow challengers ----------
// A challenger "matches" when it scores within 90% of the original model replaying itself on the same
// run. Only finished trials whose control finished count; restarts and timeouts are missing data, not losses.
export function banditStats(shape: string | null) {
  const rows = all<any>(`select t.model, t.score, t.usd, r.shape, c.score cscore, c.usd cusd from shadow_trials t
    join shadow_runs r on r.id = t.run_id join shadow_trials c on c.run_id = t.run_id and c.control = 1 and c.status = 'done'
    where t.control = 0 and t.status = 'done'`)
  const stats = new Map<string, { s: number; n: number; costRatios: number[]; shapeN: number }>()
  for (const t of rows) {
    const w = shape && t.shape === shape ? 1 : 0.5 // other shapes count half: same model, different job
    const st = stats.get(t.model) ?? { s: 0, n: 0, costRatios: [], shapeN: 0 }
    const ok = (t.score ?? 0) >= 0.9 * Math.max(1, t.cscore ?? 0)
    st.s += ok ? w : 0; st.n += w; if (w === 1) st.shapeN++
    if (t.cusd > 0 && t.usd != null) st.costRatios.push(t.usd / t.cusd)
    stats.set(t.model, st)
  }
  return stats
}

const PRIOR_COST: [RegExp, number][] = [[/haiku/, 0.15], [/sonnet/, 0.4], [/opus/, 1], [/./, 0.6]]
export function banditPick(candidates: string[], stats: Map<string, { s: number; n: number; costRatios: number[] }>, rand: () => number = Math.random, k = 1) {
  const draws = candidates.map(model => {
    const st = stats.get(model)
    const theta = betaSample(1 + (st?.s ?? 0), 1 + (st ? st.n - st.s : 0), rand)
    const cost = median(st?.costRatios ?? []) ?? PRIOR_COST.find(([re]) => re.test(model))![1]
    return { model, theta, cost, reward: theta * Math.max(0, 1 - cost), n: st?.n ?? 0 }
  }).sort((a, b) => b.reward - a.reward)
  return { chosen: draws.slice(0, k).map(d => d.model), draws }
}

// ---------- gates and the report ----------
export async function report(now = Date.now()) {
  const rows = await ledger()
  const since30 = now - 30 * DAY
  const merged30 = rows.filter(r => r.merged && r.merged > since30)
  const coverage = merged30.length ? merged30.filter(r => r.usd > 0 && r.shipped != null).length / merged30.length : null
  const works = all<any>(`select works from pr_proof where updated_at > ? and works is not null and works != ''`, now - 14 * DAY)
  const noSignal = works.length ? works.filter(w => w.works === 'no_signal').length / works.length : null
  const samples = all<any>(`select at, reasons from learn_samples where at > ?`, now - 14 * DAY)
  const sampledDays = samples.length ? (now - samples[0].at) / DAY : 0
  const constrainedShare = samples.length ? samples.filter(s => s.reasons).length / samples.length : null
  const reasons: Record<string, number> = {}
  for (const s of samples) for (const r of (s.reasons || '').split(',').filter(Boolean)) reasons[r] = (reasons[r] ?? 0) + 1
  const cal = calibration(rows)

  const gates = {
    phase0: { metric: 'Works no_signal share, 14d', value: noSignal, n: works.length, target: 0.1, stopAbove: 0.2,
      status: noSignal == null ? 'no data' : noSignal < 0.1 ? 'pass' : noSignal > 0.2 ? 'blocked' : 'improving' },
    phase1: { metric: 'merged PRs (30d) with cost and outcome', value: coverage, n: merged30.length, target: 0.9,
      status: coverage == null ? 'no data' : coverage >= 0.9 ? 'pass' : 'fail' },
    phase1b: { metric: 'share of 5-min samples with a limit hit', value: constrainedShare, n: samples.length, days: sampledDays, target: 0.15, reasons,
      status: sampledDays < 3 ? 'collecting' : (constrainedShare ?? 0) >= 0.15 ? 'go' : 'skip phase 2' },
    calibration: { ...cal, status: cal.skill == null ? 'no data' : cal.skill > 0.02 ? 'area carries signal' : 'area adds nothing over global rate' },
  }
  const phase2On = phase2Active(gates)
  const started = get<any>(`select min(day) d from learn_arms where active = 1`)?.d ?? null
  const inExp = started ? rows.filter(r => dayKey(r.created) >= started) : []
  const arm = (a: string) => {
    const rs = inExp.filter(r => r.arm === a)
    const v = rs.filter(r => r.hoursToVerdict != null).map(r => r.hoursToVerdict!)
    const proven = rs.filter(r => r.proven === 1)
    return { prs: rs.length, verdicts: v.length, medianHoursToVerdict: median(v), merged: rs.filter(r => r.merged).length,
      stalledOrStale: rs.filter(r => r.outcome === 'stalled' || r.outcome === 'stale').length,
      usdPerProven: proven.length ? rs.reduce((a, r) => a + r.usd, 0) / proven.length : null }
  }
  // shadow.ts adds the policy column; before it has run, every run used the fixed model list.
  let shadow: any[] = []
  try { shadow = all<any>(`select coalesce(policy, 'fixed') policy, count(*) runs, sum(status = 'done') done from shadow_runs where created_at > ? group by 1`, now - 30 * DAY) } catch {}
  return {
    gates, today: { day: dayKey(now), arm: armFor(dayKey(now)), phase2Active: phase2On, startedOn: started },
    phase2: started ? { control: arm('control'), learned: arm('learned') } : null,
    phase3: { runs: shadow, arms: Object.fromEntries([...banditStats(null)].map(([m, s]) => [m, { matches: s.s, trials: s.n, costRatio: median(s.costRatios) }])) },
    ledger: { prs: rows.length, merged: rows.filter(r => r.merged).length, proven: rows.filter(r => r.proven === 1).length, concerns: rows.filter(r => r.proven === 0).length, censored: rows.filter(r => r.merged && r.proven == null).length },
  }
}

type Gates = { phase0: { status: string }; phase1b: { status: string } }
let lastGates: Gates | null = null
function phase2Active(g: Gates | null = lastGates): boolean {
  const s = cfg().switchback
  if (s === true || s === false) return s
  // Automatic start: the labels resolve and ordering is shown to matter.
  return !!g && g.phase0.status === 'pass' && g.phase1b.status === 'go'
}

// The arm for ordering work today, or null when the experiment isn't running.
export function todaysArm(now = Date.now()): 'control' | 'learned' | null {
  if (!phase2Active()) return null
  const day = dayKey(now), arm = armFor(day)
  run(`insert or ignore into learn_arms (day, arm, active, created_at) values (?, ?, 1, ?)`, day, arm, now)
  return arm
}

// Learned ordering for a list of PR urls (higher first). Unknown PRs get the global rates.
export function scorePrs(urls: string[], now = Date.now()) {
  const rows = ledgerCache?.rows ?? []
  const m = model(rows)
  const byUrl = new Map(rows.map(r => [r.url, r]))
  return new Map(urls.map(u => { const r = byUrl.get(u); return [u, value(m, r?.area ?? '', r?.created ?? now, now).score] }))
}

export function startLearn(runningChats: () => number = () => 0) {
  const tick = () => { try { sample(Date.now(), runningChats()) } catch (e) { console.error('[learn] sample', e) } }
  setTimeout(tick, 60_000)
  setInterval(tick, cfg().sampleMinutes * 60_000).unref?.()
  const gates = () => report().then(r => { lastGates = r.gates; todaysArm() }).catch(e => console.error('[learn] report', e))
  setTimeout(gates, 3 * 60_000)
  setInterval(gates, HOUR).unref?.()
}
