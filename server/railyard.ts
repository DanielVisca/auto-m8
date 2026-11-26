// The railyard: one live snapshot of everything moving, for the control-room canvas tile.
// PRs are trains moving through stations (draft → CI → review → approved → deploy → +2h check →
// verified), agents are drivers, the shepherd is the signal box, `after:` PRs are red signals,
// decisions and NEEDS YOU are the level crossing where the user has to act, scouts are inspection
// trains on a timetable. Station changes are recorded here so the Marey chart has a history.
import { all, db, get, run } from './db.ts'
import { openDecisions } from './decisions.ts'
import { openPromises } from './promises.ts'
import { runningChats } from './chat.ts'
import { prSidebar } from './prview.ts'
import { scouts } from './posthog.ts'
import { listRoutines, RUN_COST } from './routines.ts'
import { posthogFetch } from './indexer.ts'
import { settings } from './settings.ts'
import { proofOf } from './proof.ts'
import { waitingOn } from './shepherd.ts'

db.exec(`create table if not exists railyard_events (url text not null, station text not null, at integer not null, primary key (url, at, station))`)
try { db.exec(`alter table railyard_events add column guess integer default 0`) } catch {}

export const STATIONS = ['draft', 'ci', 'review', 'approved', 'deploy', 'check2', 'verified', 'proven'] as const
type Holder = 'you' | 'agent' | 'ci' | 'reviewer' | 'merge' | 'prod' | 'idle'
const HOUR = 3600_000

const windows = (w: any): [number, number | null][] => { try { return JSON.parse(w?.own_windows ?? '[]') } catch { return [] } }

function stationOf(p: any, w: any, proof?: { state: string } | null): { station: string; red: boolean } {
  // Proven: the PR's production proof scorecard (kept by PostHog scouts) shows every check passed.
  if (proof?.state === 'proven') return { station: 'proven', red: false }
  if (w?.stage === 'verified') return { station: 'verified', red: proof?.state === 'concerns' }
  if (w?.stage === 'handed-off') return { station: 'verified', red: false }
  if (w?.stage === 'failed') return { station: w.merged_at ? 'check2' : 'review', red: true }
  if (w?.stage === 'verifying') return { station: 'check2', red: false }
  if (w?.stage === 'deploying') return { station: 'deploy', red: false }
  if (!p) return { station: 'review', red: false }
  if (p.draft) return { station: 'draft', red: p.checks === 'FAILURE' }
  if (p.checks === 'FAILURE') return { station: 'ci', red: true }
  if (p.review === 'APPROVED') return { station: p.checks === 'PENDING' ? 'ci' : 'approved', red: false }
  if (p.checks === 'PENDING') return { station: 'ci', red: false }
  return { station: 'review', red: p.review === 'CHANGES_REQUESTED' }
}

let snapCache: { at: number; v: any } | null = null
let building: Promise<any> | null = null
const scoutRuns: { at: number; v: any[] } = { at: 0, v: [] }
// One build at a time, and never make a caller wait for GitHub when there is a snapshot: the build
// can take 20-75s (gh graphql under rate pressure), and each waiting request holds one of the
// browser's 6 connections to auto-m8, so a few polling Railyard views starved chat transcripts
// into "Loading…" (2026-11-25). Stale data comes back at once and a refresh runs behind it.
export function railyard(): Promise<any> {
  const fresh = snapCache && Date.now() - snapCache.at < 8_000
  if (!fresh && !building) building = build().finally(() => { building = null })
  if (snapCache) { building?.catch(() => {}); return Promise.resolve(snapCache.v) }
  return building!
}
async function build() {
  const now = Date.now()
  const [sidebarR, scoutsR] = await Promise.allSettled([prSidebar(false), scouts.list({ mine: true })])
  const sidebar: any = sidebarR.status === 'fulfilled' ? sidebarR.value : null
  const open: any[] = (sidebar?.sections ?? []).flatMap((s: any) => s.prs.map((p: any) => ({ ...p, section: s.title })))
  const watch = new Map(all<any>('select * from shepherd_watch').map(w => [w.url, w]))
  const decisions = openDecisions() as any[]
  const promises = openPromises() as any[]
  const live = new Set(runningChats().filter(c => c.live).map(c => c.id))
  const decisionFor = new Map(decisions.filter(d => d.url).map(d => [d.url, d]))

  // Trains: every open PR, plus merged ones still on the way to proven (verified ones stay on the
  // line until their scorecard says proven, for up to a week), and last 48h's arrivals.
  const byUrl = new Map<string, any>()
  for (const p of open) byUrl.set(p.url, p)
  for (const w of watch.values()) {
    if (byUrl.has(w.url) || !w.merged_at || !['deploying', 'verifying', 'verified', 'failed', 'handed-off'].includes(w.stage)) continue
    const proven = proofOf(w.url)?.state === 'proven'
    if (w.enabled || now - w.merged_at < 48 * HOUR || (!proven && w.stage === 'verified' && w.url.includes('/PostHog/posthog/pull/') && now - w.merged_at < 7 * 24 * HOUR)) byUrl.set(w.url, null)
  }

  const trains = [...byUrl.entries()].map(([url, p]) => {
    const w = watch.get(url)
    const proof = w?.merged_at ? proofOf(url) : null
    const { station, red } = stationOf(p, w, proof)
    const wins = windows(w)
    const working = wins.at(-1)?.[1] === null || !!w?.awaiting || (p?.agents?.length ?? 0) > 0 || (w?.conversation_id && live.has(w.conversation_id))
    const after: string[] = (() => { try { return JSON.parse(w?.after_urls ?? '[]') } catch { return [] } })()
    // Red signal: an `after:` prerequisite that hasn't passed a production check yet, by the same rule
    // the shepherd's merge gate uses. Only before merge: once merged nothing is held any more.
    const merged = !!w?.merged_at || ['deploy', 'check2', 'verified', 'proven'].includes(station)
    const signal = merged ? [] : waitingOn({ after } as any, Object.fromEntries(after.map(a => [a, watch.get(a)?.stage ?? null])))
    const decision = decisionFor.get(url)
    const needsYou = !!decision || /^NEEDS YOU/.test(w?.outcome ?? '') || /NEEDS YOU/.test(w?.last_detail ?? '') || w?.stage === 'blocked'
      || (station === 'approved' && /merge: manual/.test(w?.outcome ?? ''))
    // "agent" means an agent is working on it right now. Red with nobody on it is stuck, and stuck
    // with nobody on it is yours (drafts aren't: they're parked until you pick them up). An approved
    // PR with no shepherd to merge it is yours too. This is the one definition of "needs you": the
    // line's pill counts exactly these orange dots.
    let holder: Holder
    if (needsYou) holder = 'you'
    else if (working) holder = 'agent'
    else if (red && station !== 'draft') holder = 'you'
    else if (station === 'deploy' || station === 'check2') holder = 'prod'
    else if (station === 'verified') holder = 'prod' // live; the scouts are still gathering proof
    else if (station === 'proven') holder = 'idle'
    else if (station === 'ci') holder = 'ci'
    else if (station === 'review') holder = 'reviewer'
    else if (station === 'approved') holder = w?.enabled ? 'merge' : 'you'
    else holder = 'idle'
    const m = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/)
    const title = p?.title ?? get<any>('select title from prs where url = ?', url)?.title ?? ''
    return {
      url, repo: m?.[2] ?? '', number: Number(m?.[3] ?? 0), title, section: p?.section ?? null, station, red, holder,
      working: !!working, size: p ? (p.additions ?? 0) + (p.deletions ?? 0) : null, review: p?.review ?? null, checks: p?.checks ?? null,
      signal, decision: decision ? { title: decision.title, recommendation: decision.recommendation, stakes: decision.stakes } : null,
      outcome: w?.outcome ?? p?.action ?? null, detail: (w?.last_detail ?? '').slice(0, 300) || null, shepherded: !!w?.enabled,
      createdAt: p?.createdAt ?? null, mergedAt: w?.merged_at ?? null, verifyDueAt: w?.stage === 'verifying' || w?.stage === 'deploying' ? w?.verify_due_at ?? null : null,
      windows: wins.filter(([a, b]) => (b ?? now) > now - 48 * HOUR),
      proof: proof?.state ? { state: proof.state, live: proof.live, healthy: proof.healthy, used: proof.used, works: proof.works, contained: proof.contained, url: proof.comment_url } : null,
    }
  })

  // Record station changes (and backfill what we know: opened, merged) for the Marey chart.
  for (const t of trains) {
    const last = get<any>('select station from railyard_events where url = ? order by at desc limit 1', t.url)
    if (!last) {
      if (t.createdAt) run('insert or ignore into railyard_events (url, station, at, guess) values (?, ?, ?, 1)', t.url, 'draft', t.createdAt)
      if (t.mergedAt) run('insert or ignore into railyard_events (url, station, at, guess) values (?, ?, ?, ?)', t.url, 'deploy', t.mergedAt, t.station === 'deploy' ? 0 : 1)
    }
    if (last?.station !== t.station) run('insert or ignore into railyard_events (url, station, at) values (?, ?, ?)', t.url, t.station, t.mergedAt && t.station === 'deploy' && !last ? t.mergedAt : now)
  }
  const history = all<any>('select url, station, at, guess from railyard_events where at > ? or url in (select value from json_each(?)) order by at', now - 7 * 24 * HOUR, JSON.stringify(trains.map(t => t.url)))

  // Workers: every agent turn in the last 12h, one lane per conversation, tagged by kind.
  const turns = all<any>(`select t.conversation_id id, coalesce(t.started_at, t.sent_at) a, t.finished_at f, c.updated_at u
    from turns t left join conversations c on c.id = t.conversation_id
    where coalesce(t.finished_at, c.updated_at, t.sent_at) > ? or t.finished_at is null order by a`, now - 12 * HOUR)
    .map(t => ({ ...t, b: t.f ?? (live.has(t.id) ? now : Math.max(t.a + 60_000, Number(t.u) || t.a)) }))
    .filter(t => t.b > now - 12 * HOUR)
  const ids = [...new Set(turns.map(t => t.id))]
  const conv = new Map(ids.map(id => [id, get<any>('select id, title, first_prompt, summary from conversations where id = ?', id)]))
  const labels = new Map(ids.map(id => [id, all<any>('select label from labels where conversation_id = ?', id).map(l => l.label)]))
  const delegates = new Set(all<any>('select child from delegations').map(d => d.child))
  const routineConvs = new Set(all<any>('select conversation_id from routine_runs where conversation_id is not null').map(r => r.conversation_id))
  const shepherdOf = new Map([...watch.values()].filter(w => w.conversation_id).map(w => [w.conversation_id, w.url]))
  // Who started each lane: you, or perch on your behalf (shepherd, helper, routine, autopilot, ...).
  // The tile shows yours and folds the rest into one row per kind.
  const startedBy = new Map(ids.map(id => [id, get<any>('select by from perch_started where id = ?', id)?.by as string | undefined]))
  const prTitle = new Map(trains.map((t: any) => [t.url, t.title]))
  const lanes = ids.map(id => {
    const c = conv.get(id), ls = labels.get(id) ?? [], by = startedBy.get(id)
    const kind = shepherdOf.has(id) || ls.includes('shepherd') ? 'shepherd' : delegates.has(id) ? 'helper' : routineConvs.has(id) ? 'routine' : ls.includes('search') ? 'search'
      : by && by !== 'you' ? by : 'chat'
    const pr = shepherdOf.get(id) ?? (String(c?.first_prompt ?? '').match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0])
    const name = pr && kind === 'shepherd' ? (prTitle.get(pr) ?? pr.split('/').slice(-3, -2)[0] ?? '') : String(c?.title ?? c?.summary ?? c?.first_prompt ?? id)
    return { id, kind, bot: kind !== 'chat', pr, live: live.has(id), title: (pr ? `#${pr.split('/').pop()} ` : '') + name.slice(0, 70),
      spans: turns.filter(t => t.id === id).map(t => [t.a, t.b]) }
  })

  // Scouts: your scouts on their timetable, with recent runs.
  const mine: any[] = scoutsR.status === 'fulfilled' ? scoutsR.value.results : []
  if (now - scoutRuns.at > 5 * 60_000) {
    scoutRuns.at = now
    const got: PromiseSettledResult<any>[] = []
    for (const s of mine) got.push(...await Promise.allSettled([posthogFetch(`/api/projects/${settings.posthog.projectId}/signals/scout/runs/?skill_name=${encodeURIComponent(s.skill_name)}&limit=12`)]))
    scoutRuns.v = got.flatMap(g => g.status === 'fulfilled' ? (g.value as any[]).map(r => ({ ...r, posthog_url: r.task_url ? new URL(r.task_url, settings.posthog.host).toString() : null })) : [])
  }
  const runs = scoutRuns.v
  const scoutList = mine.map(s => ({
    name: s.display_name || s.skill_name, skill: s.skill_name, enabled: s.enabled && s.status === 'active', cron: s.run_cron_schedule ?? null,
    everyMin: s.run_interval_minutes ?? null, lastRunAt: Date.parse(s.last_run_at ?? '') || null,
    runs: runs.filter(r => r.skill_name === s.skill_name).slice(0, 10).map(r => ({ at: Date.parse(r.created_at), done: Date.parse(r.completed_at ?? '') || null, status: r.status, emitted: r.emitted_count ?? 0, url: r.posthog_url,
      // What the run found or why it failed, for the run mark's hover card; perch opens the task chat when it has it.
      summary: r.summary ? String(r.summary).slice(0, 1500) : null, failure: r.failure_reason || r.error || null,
      findings: [...(r.emitted_finding_ids ?? []), ...(r.emitted_report_ids ?? [])].slice(0, 8), cost: r.total_spend != null ? r.total_spend / 100 : null,
      perch: r.task_id && get<any>('select 1 from conversations where id = ?', `task:${r.task_id}`) ? `task:${r.task_id}` : null })),
  }))
  const routines = listRoutines().map((r: any) => ({ id: r.id, name: r.name, cron: r.cron, enabled: !!r.enabled, lastRunAt: r.last_run_at, lastStatus: r.last_status,
    // Last 10 runs, newest first, so local routines get the same run marks as cloud scouts.
    runs: all<any>(`select outcome, started_at, finished_at, conversation_id, detail, ${RUN_COST} cost from routine_runs where routine_id = ? order by started_at desc limit 10`, r.id)
      .map(x => ({ at: x.started_at, done: x.finished_at, status: x.outcome ?? 'running', conversation: x.conversation_id, detail: x.detail ? String(x.detail).slice(0, 1000) : null, cost: x.cost ?? null })),
    // 7-day spend at API prices, like the cloud scouts' 7d column.
    week: all<any>(`select count(*) runs, sum(${RUN_COST}) usd, sum(${RUN_COST} is null) untracked from routine_runs where routine_id = ? and started_at > ?`, r.id, Date.now() - 7 * 86400_000)[0] }))

  // The crossing: what is waiting on the user, oldest first.
  const crossing = [
    ...decisions.map(d => ({ kind: 'decision', title: d.title, since: d.created_at, url: d.url, conversation: d.conversation_id, stakes: d.stakes, autoAt: d.auto_at })),
    ...trains.filter(t => t.holder === 'you' && !t.decision).map(t => ({ kind: 'pr', title: `#${t.number} ${t.title}`, since: null, url: t.url, detail: t.outcome })),
  ].sort((a, b) => (a.since ?? now) - (b.since ?? now))

  const v = {
    at: now, stations: STATIONS, trains, history, lanes, scouts: scoutList, routines, crossing,
    timers: promises.map(p => ({ title: p.text, due: p.due_at, url: p.pr_url, conversation: p.conversation_id })),
    errors: [sidebarR, scoutsR].filter(r => r.status === 'rejected').map((r: any) => String(r.reason?.message ?? r.reason).slice(0, 200)),
  }
  snapCache = { at: now, v }
  return v
}

// Keep the history accruing even when nobody is looking at the tile.
export function startRailyard() {
  const tick = () => railyard().catch(() => {})
  setTimeout(tick, 20_000)
  setInterval(tick, 60_000).unref?.()
}
