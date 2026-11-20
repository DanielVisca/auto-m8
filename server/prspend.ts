// What each of your PRs cost in AI tokens, from first investigation to verified in production.
//
// Local (Claude Code transcripts on this Mac, priced in spend.ts) — each session goes to the PRs it
// worked on, in one role, split evenly when it touched several:
//   shepherd    perch's shepherd runs (review threads, CI, merge, prod verify), by shepherd_watch
//   write       the chat that opened the PR (gh pr create), and helpers it delegated to
//   investigate chats that mention 1-3 PRs without opening them (linked chats aren't enough: an audit of
//               real chats found a link pulled one $206 chat onto 32 PRs it never looked at)
// Cloud (PostHog project's LLM analytics, `$ai_generation` at API prices):
//   review      Review Hog (task_origin_key "review-pr:<team>:<repo>:<n>") and Stamphog (stamphog_pr_number)
//   validate    prod verify scouts (walkthrough, blast radius): a run's cost split over the PRs in its output
//   monitor     any other scout whose structured output names the PR
// Not covered: GitHub Actions minutes, third-party review bots, claude.ai chats, PostHog cloud tasks
// that don't name the PR.
import { all, get } from './db.ts'
import { settings } from './settings.ts'

export type Role = 'write' | 'investigate' | 'shepherd'
export const ROLES = ['write', 'investigate', 'shepherd', 'review', 'validate', 'monitor'] as const
export type Bucket = (typeof ROLES)[number]
export const MAX_MENTIONS = 3
const LINK_KINDS = ['continues', 'context', 'started', 'branch', 'manual']

const norm = (u: string) => u.toLowerCase().replace(/\/+$/, '')
const keyOf = (u: string) => { const m = norm(u).match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/); return m ? `${m[1]}:${m[2]}` : null }

export type Graph = {
  by: Map<string, string>             // session -> who started it (perch_started.by)
  created: Map<string, string[]>      // session -> PRs it opened
  mentioned: Map<string, string[]>    // session -> PRs it mentions
  shepherdOf: Map<string, string[]>   // shepherd conversation -> its PR
  parent: Map<string, string>         // helper session -> the chat that delegated it
  linked: Map<string, string[]>       // session -> sessions linked to it (either direction)
}

// One session: which PRs, in which role. Pure, so the rules are testable.
export function attribute(s: string, g: Graph): { role: Role; prs: string[] } | null {
  if (g.by.get(s) === 'shepherd') {
    const prs = g.shepherdOf.get(s) ?? g.created.get(s) ?? g.mentioned.get(s)
    return prs?.length ? { role: 'shepherd', prs } : null
  }
  const own = g.created.get(s)
  if (own?.length) return { role: 'write', prs: own }
  const p = g.parent.get(s), fromParent = p ? g.created.get(p) : undefined
  if (fromParent?.length) return { role: 'write', prs: fromParent }
  // Chats that name many PRs are overviews (PR summaries, sweeps), not investigation of one of them.
  const men = g.mentioned.get(s)
  if (men?.length && men.length <= MAX_MENTIONS) return { role: 'investigate', prs: men }
  return null
}

const multi = (rows: { k: string; v: string }[], f = (v: string) => v) => {
  const m = new Map<string, string[]>()
  for (const r of rows) { const a = m.get(r.k) ?? []; const v = f(r.v); if (!a.includes(v)) a.push(v); m.set(r.k, a) }
  return m
}

function graph(): Graph {
  const links = all<any>(`select a, b from links where kind in (${LINK_KINDS.map(() => '?').join(',')})`, ...LINK_KINDS)
  return {
    by: new Map(all<any>('select id, by from perch_started where by is not null').map(r => [r.id, r.by])),
    created: multi(all<any>('select conversation_id k, url v from conversation_prs where created = 1'), norm),
    mentioned: multi(all<any>('select conversation_id k, url v from conversation_prs where created = 0'), norm),
    shepherdOf: multi(all<any>('select conversation_id k, url v from shepherd_watch where conversation_id is not null'), norm),
    parent: new Map(all<any>('select child, parent from delegations').map(r => [r.child, r.parent])),
    linked: multi([...links.map(l => ({ k: l.a, v: l.b })), ...links.map(l => ({ k: l.b, v: l.a }))]),
  }
}

// ---------- cloud: PostHog ----------
// Scouts: billed cost per run (the scout runs API's total_spend), falling back to LLM analytics.
// LLM analytics alone under-counts scout runs (it misses the sandbox's overhead), so it's the fallback.
// Review Hog and Stamphog only report through LLM analytics, so theirs is model tokens only.
export type Item = { bucket: Bucket; kind: 'chat' | 'review-hog' | 'stamphog' | 'scout'; id: string; label: string; usd: number; tokens: number;
  at: number; share: number; detail?: string; href?: string; billed?: boolean; ms?: number; wallMs?: number }
type CloudRow = Item & { key: string }
const VALIDATE = /walkthrough|blast|verify|proof/i
type CloudData = { rows: CloudRow[]; error: string | null }
const cloudCache = new Map<string, { at: number; data: CloudData }>()
const cloudPending = new Map<string, Promise<CloudData>>()
export const CLOUD_LOADING = 'Cloud spend is still loading; history will refresh automatically.'

async function hogql(query: string): Promise<any[][]> {
  const { posthogFetch } = await import('./indexer.ts')
  const r: any = await posthogFetch(`/api/projects/${settings.posthog.projectId}/query/`, {
    method: 'POST', body: JSON.stringify({ query: { kind: 'HogQLQuery', query }, name: 'perch pr spend' }),
  })
  if (r.hasMore) throw new Error('PostHog returned a partial result; narrow the window')
  return r.results ?? []
}

async function cloudSpend(urls: string[], days: number) {
  const cacheKey = `${days}:${[...urls].map(norm).sort().join(',')}`
  const hit = cloudCache.get(cacheKey)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data
  let pending = cloudPending.get(cacheKey)
  if (!pending) {
    pending = fetchCloudSpend(urls, days).then(data => {
      if (!data.error) {
        cloudCache.delete(cacheKey)
        cloudCache.set(cacheKey, { at: Date.now(), data })
        if (cloudCache.size > 8) cloudCache.delete(cloudCache.keys().next().value!)
      }
      return data
    }).finally(() => cloudPending.delete(cacheKey))
    cloudPending.set(cacheKey, pending)
  }
  // Local history is already available. A slow cloud query must not leave an expanded PR (or
  // the whole PR list) loading indefinitely. Keep the shared request alive for the next refresh.
  // The cache key is the exact PR list, so one new PR misses it. Rows are matched to PRs by key
  // later, so the newest result for the same window is a fine stand-in while the query runs.
  const stale = hit ?? [...cloudCache.entries()].reverse().find(([k]) => k.startsWith(`${days}:`))?.[1]
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([pending, new Promise<CloudData>(resolve => {
      timer = setTimeout(() => resolve({ rows: stale?.data.rows ?? [], error: stale ? null : CLOUD_LOADING }), 8000)
    })])
  } finally { clearTimeout(timer) }
}

async function fetchCloudSpend(urls: string[], days: number): Promise<CloudData> {
  const keys = [...new Set(urls.map(keyOf).filter((k): k is string => !!k && /^[\w.-]+\/[\w.-]+:\d+$/.test(k)))]
  if (!keys.length) return { rows: [], error: null }
  const inList = keys.map(k => `'${k}'`).join(',')
  const urlList = urls.map(u => `'${norm(u).replace(/'/g, '')}'`).join(',')
  const since = `now() - interval ${Math.max(1, Math.round(days))} day`
  const cost = 'toFloat(properties.$ai_total_cost_usd)'
  const toks = 'coalesce(toInt(properties.$ai_input_tokens), 0) + coalesce(toInt(properties.$ai_output_tokens), 0)'
  const ts = (t: any) => Date.parse(t) || 0
  const rows: CloudRow[] = []
  try {
    const { scouts } = await import('./posthog.ts')
    const [rh, sh, sc, billed] = await Promise.all([
      hogql(`select lower(extract(toString(properties.task_origin_key), 'review-pr:\\\\d+:([^:]+:\\\\d+)')) k, toString(properties.task_run_id) rid, min(timestamp), sum(${cost}), sum(${toks}), count(), any(toString(properties.$ai_model))
        from events where event = '$ai_generation' and timestamp > ${since} and properties.$ai_product = 'review_hog' and k in (${inList}) group by k, rid limit 50000`),
      hogql(`select lower(concat(toString(properties.stamphog_repo), ':', toString(toInt(toFloat(properties.stamphog_pr_number))))) k, toString(properties.stamphog_review_run_id) rid, min(timestamp), sum(${cost}), sum(${toks}), count(), any(toString(properties.$ai_model))
        from events where event = '$ai_generation' and timestamp > ${since} and properties.$ai_product = 'aio_stamphog' and k in (${inList}) group by k, rid limit 50000`),
      hogql(`with runs as (select toString(properties.task_run_id) rid, any(toString(properties.skill_name)) skill, groupUniqArray(lower(toString(properties.output_pr_url))) prs, min(timestamp) at
          from events where event = '$scout_structured_output' and timestamp > ${since} and properties.output_pr_url like 'https://github.com/%' group by rid
          having hasAny(prs, [${urlList}])),
        c as (select toString(properties.task_run_id) rid, sum(${cost}) usd, sum(${toks}) t, any(toString(properties.$ai_model)) model from events
          where event = '$ai_generation' and timestamp > ${since} and properties.$ai_product = 'signals_scout' and toString(properties.task_run_id) in (select rid from runs) group by rid)
        select runs.rid, runs.skill, runs.prs, runs.at, c.usd, c.t, c.model from runs left join c on c.rid = runs.rid limit 50000`),
      scouts.billedRuns(days).catch(() => new Map<string, number>()),
    ])
    for (const [k, rid, at, usd, t, n, model] of rh)
      rows.push({ key: k, bucket: 'review', kind: 'review-hog', id: rid, label: 'Review Hog review', usd: usd ?? 0, tokens: t ?? 0, at: ts(at), share: 1, detail: `${n} model calls · ${model}` })
    for (const [k, rid, at, usd, t, n, model] of sh)
      rows.push({ key: k, bucket: 'review', kind: 'stamphog', id: rid, label: 'Stamphog review', usd: usd ?? 0, tokens: t ?? 0, at: ts(at), share: 1, detail: `${n} model calls · ${model}` })
    for (const [rid, skill, prs, at, logged, t, model] of sc) {
      const list: string[] = (prs ?? []).map(norm)
      const b = billed.get(rid)
      const usd = b ?? logged ?? 0
      for (const u of list) {
        const k = keyOf(u); if (!k) continue
        rows.push({ key: k, bucket: VALIDATE.test(skill) ? 'validate' : 'monitor', kind: 'scout', id: rid, label: `Scout: ${skill}`, usd: usd / list.length, tokens: (t ?? 0) / list.length,
          at: ts(at), share: 1 / list.length, billed: b != null, detail: `${b != null ? 'billed' : 'LLM analytics only'}${list.length > 1 ? ` · run covered ${list.length} PRs` : ''}${model ? ` · ${model}` : ''}` })
      }
    }
    return { rows, error: null }
  } catch (e: any) { return { rows, error: String(e?.message ?? e) } }
}

// ---------- the model: every PR with its itemised costs ----------
type Cell = { usd: number; tokens: number; n: number; ms: number }
type Pr = { url: string; title: string | null; number: number; repo: string; state: string | null; draft: boolean; mine: boolean
  total: number; tokens: number; ms: number; buckets: Partial<Record<Bucket, Cell>>; items: Item[] }
const modelCache = new Map<string, { at: number; data: Awaited<ReturnType<typeof build>> }>()

async function build(days: number | null, onlyUrl?: string) {
  const until = Date.now(), since = days === null ? 0 : until - days * 86400_000
  // Transcript scans can import older calls while this model is cached. Keep the chart and its
  // item totals on the same append-only usage snapshot, including backfilled timestamps.
  const maxRowid = get<{ id: number }>('select max(rowid) id from usage_msgs')?.id ?? 0
  const g = graph()
  const sess = all<any>(`select m.session, sum(m.cost) usd, sum(m.in_tok + m.out_tok + m.cache_read + m.cache_write) tokens, min(m.ts) first, max(m.ts) last,
      count(*) n, max(m.source) source, group_concat(distinct m.model) models
    from usage_msgs m where m.ts > ? and m.ts <= ? and m.session is not null group by m.session`, since, until)
  // Active agent time per session: gaps between its API calls, each capped at 2 minutes so time you
  // spent reading or away doesn't count. Wall time is first to last call.
  const act = new Map(all<any>(`select session, sum(min(coalesce(gap, 0), 120000)) active from (
      select session, ts - lag(ts) over (partition by session order by ts) gap from usage_msgs where ts > ? and ts <= ? and session is not null) group by session`, since, until).map(r => [r.session, r.active ?? 0]))
  const titles = new Map<string, string>()
  const ids = sess.map(s => s.session)
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    for (const t of all<any>(`select c.id, coalesce(u.title, a.title, c.title, c.first_prompt) title from conversations c left join user_state u on u.id = c.id
        left join auto_titles a on a.id = c.id where c.id in (${chunk.map(() => '?').join(',')})`, ...chunk))
      titles.set(t.id, String(t.title ?? '').replace(/\s+/g, ' ').slice(0, 120))
  }
  const prs = new Map<string, Pr>()
  const pr = (url: string) => {
    let p = prs.get(url)
    if (!p) prs.set(url, p = { url, title: null, number: Number(url.split('/').pop()), repo: url.split('/').slice(3, 5).join('/'), state: null, draft: false, mine: false, total: 0, tokens: 0, ms: 0, buckets: {}, items: [] })
    return p
  }
  const add = (url: string, it: Item) => {
    if (onlyUrl && url !== onlyUrl) return
    const p = pr(url), c = p.buckets[it.bucket] ??= { usd: 0, tokens: 0, n: 0, ms: 0 }
    c.usd += it.usd; c.tokens += it.tokens; c.n++; c.ms += it.ms ?? 0; p.ms += it.ms ?? 0
    p.total += it.usd; p.tokens += it.tokens; p.items.push(it)
  }
  let localTotal = 0, unattributed = 0
  for (const s of sess) {
    localTotal += s.usd ?? 0
    const a = attribute(s.session, g)
    if (!a) { unattributed += s.usd ?? 0; continue }
    const n = a.prs.length
    const who = g.by.get(s.session)
    for (const u of a.prs) add(u, { bucket: a.role, kind: 'chat', id: s.session, label: titles.get(s.session) || s.session.slice(0, 8),
      usd: (s.usd ?? 0) / n, tokens: (s.tokens ?? 0) / n, at: s.first, share: 1 / n, ms: (act.get(s.session) ?? 0) / n, wallMs: ((s.last ?? 0) - (s.first ?? 0)) / n, href: `#chat/${encodeURIComponent(s.session)}`,
      detail: [who ?? (s.source === 'perch' ? 'you' : s.source), `${s.n} API calls`, String(s.models ?? '').split(',').filter(Boolean).join(', '), n > 1 ? `split over ${n} PRs` : ''].filter(Boolean).join(' · ') })
  }
  // "Yours": PRs a chat opened or the shepherd watches. Others' PRs you only discussed are summed apart.
  const yours = new Set([...[...g.created.values()].flat(), ...[...g.shepherdOf.values()].flat()])
  const cloud = await cloudSpend([...yours].filter(u => !onlyUrl || u === onlyUrl), days ?? Math.ceil(until / 86400_000)).catch((e: any) => ({ rows: [] as CloudRow[], error: String(e?.message ?? e) }))
  const byKey = new Map([...yours].map(u => [keyOf(u), u]))
  for (const r of cloud.rows) { const u = byKey.get(r.key); if (u) { const { key, ...it } = r; add(u, it) } }
  const meta = new Map(all<any>('select url, repo, number, title, state, draft from prs').map(r => [norm(r.url), r]))
  for (const p of prs.values()) {
    const m = meta.get(p.url)
    if (m) Object.assign(p, { title: m.title, number: m.number, repo: m.repo, state: m.state, draft: !!m.draft })
    p.mine = yours.has(p.url)
    p.items.sort((a, b) => a.at - b.at)
  }
  return { prs, localTotal, unattributed, cloudError: cloud.error, since, until, maxRowid }
}

async function model(days: number | null, onlyUrl?: string) {
  const key = `${days}:${onlyUrl ?? ''}`, hit = modelCache.get(key)
  if (hit && Date.now() - hit.at < (hit.data.cloudError ? 5_000 : 2 * 60_000)) return hit.data
  const data = await build(days, onlyUrl)
  modelCache.delete(key)
  // A model built before the cloud query finished has empty review/scout columns: keep it only
  // briefly so the page's next poll picks up the finished query instead of a 2-minute-old gap.
  modelCache.set(key, { at: Date.now(), data })
  if (modelCache.size > 8) modelCache.delete(modelCache.keys().next().value!)
  return data
}

const quantile = (xs: number[], q: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * q, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo) }
const stats = (xs: number[]) => ({ n: xs.length, mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0, median: quantile(xs, 0.5), p75: quantile(xs, 0.75), p90: quantile(xs, 0.9), max: xs.length ? Math.max(...xs) : 0 })

export async function prSpend(days = 30, limit = 500) {
  const m = await model(days)
  const all_ = [...m.prs.values()]
  const mine = all_.filter(p => p.mine)
  const merged = mine.filter(p => /^merged$/i.test(p.state ?? ''))
  const totals = Object.fromEntries(ROLES.map(r => [r, mine.reduce((a, p) => a + (p.buckets[r]?.usd ?? 0), 0)]))
  // Average per PR for each bucket, over the PRs where that bucket happened at all, and over every PR.
  const perBucket = Object.fromEntries(ROLES.map(r => { const xs = mine.map(p => p.buckets[r]?.usd ?? 0); const hit = xs.filter(x => x > 0); const ms = mine.map(p => p.buckets[r]?.ms ?? 0).filter(x => x > 0)
    return [r, { ...stats(hit), meanAll: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0, msMedian: quantile(ms, 0.5), msTotal: ms.reduce((a, b) => a + b, 0) }] }))
  return {
    days, prs: mine.length, merged: merged.length, total: mine.reduce((a, p) => a + p.total, 0), totals, perBucket,
    perPr: stats(mine.map(p => p.total)), perMerged: stats(merged.map(p => p.total)),
    otherPrs: all_.filter(p => !p.mine).reduce((a, p) => a + p.total, 0),
    local: { total: m.localTotal, unattributed: m.unattributed },
    cloudError: m.cloudError,
    list: mine.sort((a, b) => b.total - a.total).slice(0, limit).map(({ items, ...p }) => ({ ...p, n: items.length })),
  }
}

type SpendEvent = { at: number; usd: number; bucket: Bucket }

// Steps at actual call timestamps, not at the beginning of a whole writing session.
// Cloud costs are only available per run, so each lands at that run's recorded timestamp.
export function spendTimeline(events: SpendEvent[], now = Date.now()) {
  const timed = events.filter(e => Number.isFinite(e.at) && e.at > 0 && e.at <= now && Number.isFinite(e.usd) && e.usd > 0).sort((a, b) => a.at - b.at)
  const points: { at: number; usd: number; total: number; buckets: Partial<Record<Bucket, number>> }[] = []
  let total = 0
  for (const e of timed) {
    let p = points.at(-1)
    if (!p || p.at !== e.at) { p = { at: e.at, usd: 0, total, buckets: {} }; points.push(p) }
    p.usd += e.usd
    p.buckets[e.bucket] = (p.buckets[e.bucket] ?? 0) + e.usd
    total += e.usd; p.total = total
  }
  return { points, total, until: now }
}

// One PR, every line that went into it. null means all recorded history.
export async function prSpendDetail(url: string, days: number | null = 30, timeline = false) {
  const m = await model(days, days === null ? norm(url) : undefined)
  const p = m.prs.get(norm(url))
  const detail = p ?? { url, total: 0, items: [] as Item[], buckets: {} }
  if (!timeline) return detail
  const events: SpendEvent[] = []
  for (const it of detail.items) {
    if (it.kind !== 'chat') { events.push({ at: it.at, usd: it.usd, bucket: it.bucket }); continue }
    for (const row of all<{ ts: number; cost: number }>('select ts, cost from usage_msgs where session = ? and ts > ? and ts <= ? and rowid <= ?', it.id, m.since, m.until, m.maxRowid))
      events.push({ at: row.ts, usd: row.cost * it.share, bucket: it.bucket })
  }
  const history = spendTimeline(events)
  return { ...detail, timeline: history, cloudError: m.cloudError, untimedUsd: Math.max(0, detail.total - history.total) }
}
