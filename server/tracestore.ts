// Durable tracing of auto-m8 itself: everything that takes time, how much, and where, tied to the
// build (code + settings) that was running, so an agent can answer "why was it slow on Tuesday?" and
// "did that change make chats load slower?".
//
// Three layers, each with a TTL:
//   trace_builds  one row per server start: git sha, commit subject, commits since the previous
//                 build, uncommitted files (auto-m8 runs from the working tree, so they're live
//                 code), and the feature toggles in settings. A settings change mid-run is a
//                 `config` event. Kept while anything refers to it.
//   trace_events  raw events, kept `rawHours` (default 48): API requests with their spans (SQL,
//                 gh, subprocesses), background work per minute, event-loop delay per 10s, and
//                 client timings the app window reports (time a request waited for a connection,
//                 chat open to first paint, long tasks, page loads).
//   trace_rollups once raw events expire they're condensed per hour, build, kind and name: count,
//                 errors, percentiles, total time, where the time went (top spans) and the 3
//                 slowest examples with their breakdown. Kept `summaryDays` (default 30).
// Writes are buffered and flushed every 5s in one transaction, so tracing costs ~nothing per request.
// Read with GET /api/traces or the MCP tool `traces`; the live view is still latency.ts.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { all, db, get, run, tx } from './db.ts'
import { backgroundMinutes, onLoopSample, onTraceDone, type Span, type Trace } from './latency.ts'
import { settings, UNDER_TEST } from './settings.ts'

const HOUR = 3600_000, MIN = 60_000
const env = (k: string, d: number) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d }
export const RAW_HOURS = env('PERCH_TRACE_RAW_HOURS', 48)
export const SUMMARY_DAYS = env('PERCH_TRACE_SUMMARY_DAYS', 30)
// Spans are kept for events at least this slow, or that failed; the rest keep only totals.
const SPANS_FROM_MS = 50

db.exec(`
create table if not exists trace_builds (
  id integer primary key, started_at integer not null, pid integer,
  sha text, subject text, branch text,
  commits_since text,      -- JSON [{sha, subject}] since the previous build's sha
  dirty_files text,        -- JSON [path]: uncommitted changes the server is running
  dirty_hash text,
  config text,             -- JSON {path: value}: feature toggles in settings at start
  config_hash text
);
create table if not exists trace_events (
  id integer primary key, at integer not null, build_id integer,
  kind text not null,      -- request | background | loop | client | config
  name text not null, ms real not null, status integer,
  db_ms real, db_calls integer,
  spans text,              -- JSON [{name, start, ms}] (requests at least ${SPANS_FROM_MS}ms or failed)
  meta text                -- JSON, kind-specific
);
create index if not exists trace_events_at on trace_events(at);
create index if not exists trace_events_name_at on trace_events(name, at);
create table if not exists trace_rollups (
  hour integer not null, build_id integer, kind text not null, name text not null,
  n integer, calls integer, errors integer, total_ms real,
  p50 real, p90 real, p95 real, p99 real, max real, db_ms real,
  top_spans text,          -- JSON [{name, calls, ms}]
  slowest text,            -- JSON [{at, ms, status, where, meta}]
  primary key (hour, build_id, kind, name)
);
create index if not exists trace_rollups_name on trace_rollups(name, hour);
`)

// ---- builds: what the app was at the time ----

const git = (...args: string[]) => { try { return execFileSync('git', args, { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' } }

// Feature toggles and modes, not personal data: booleans, numbers and short strings, minus
// window geometry, paths, names and lists.
const SKIP = /^(window\.bounds|sources|owner|slack|focus\.areas|browser\.sites|browser\.allowedActions|browser\.chromePath|chat\.cwd|autonomy\.(interrupted|reason|pausedAt)|posthog\.host|local\.baseUrl|shepherd\.autoSince)/
export function flatConfig(o: any, prefix = '', out: Record<string, any> = {}) {
  for (const [k, v] of Object.entries(o ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k
    if (SKIP.test(key)) continue
    if (v && typeof v === 'object' && !Array.isArray(v)) flatConfig(v, key, out)
    else if (typeof v === 'boolean' || typeof v === 'number' || (typeof v === 'string' && v.length <= 40)) out[key] = v
  }
  return out
}
const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12)

let buildId: number | null = null
let configNow: Record<string, any> = {}
export const currentBuild = () => buildId

export function recordBuild(now = Date.now()) {
  const sha = git('rev-parse', 'HEAD'), subject = git('log', '-1', '--format=%s'), branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  const prev = get<{ sha: string }>('select sha from trace_builds where sha is not null and sha != ? order by id desc limit 1', sha)
  const since = prev?.sha && sha ? git('log', '--format=%h %s', '-n', '50', `${prev.sha}..${sha}`).split('\n').filter(Boolean).map(l => ({ sha: l.slice(0, l.indexOf(' ')), subject: l.slice(l.indexOf(' ') + 1) })) : []
  const dirty = git('status', '--porcelain').split('\n').filter(Boolean).map(l => l.slice(3)).filter(f => /^(server|web|shell|shared|tiles)\//.test(f))
  const dirtyHash = dirty.length ? hash(git('diff', 'HEAD', '--', ...dirty)) : null
  configNow = flatConfig(settings)
  const cfg = JSON.stringify(configNow)
  buildId = Number(run(`insert into trace_builds (started_at, pid, sha, subject, branch, commits_since, dirty_files, dirty_hash, config, config_hash) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    now, process.pid, sha || null, subject || null, branch || null, JSON.stringify(since), JSON.stringify(dirty), dirtyHash, cfg, hash(cfg)).lastInsertRowid)
  return buildId
}

// A settings change while running: which toggles moved, as a `config` event.
function checkConfig(now: number) {
  const next = flatConfig(settings)
  const changed: Record<string, [any, any]> = {}
  for (const k of new Set([...Object.keys(configNow), ...Object.keys(next)])) if (configNow[k] !== next[k]) changed[k] = [configNow[k], next[k]]
  if (!Object.keys(changed).length) return
  configNow = next
  queue.push({ at: now, kind: 'config', name: 'settings changed', ms: 0, meta: changed })
}

// ---- recording ----

type Row = { at: number; kind: string; name: string; ms: number; status?: number | null; dbMs?: number | null; dbCalls?: number | null; spans?: Span[] | null; meta?: any }
const queue: Row[] = []
const MAX_QUEUE = 20_000
const push = (r: Row) => { if (queue.length < MAX_QUEUE) queue.push(r) }

export function recordRequest(t: Trace) {
  const keepSpans = t.ms >= SPANS_FROM_MS || (t.status ?? 0) >= 500
  push({ at: t.at, kind: 'request', name: t.name, ms: t.ms, status: t.status ?? null, dbMs: t.dbMs, dbCalls: t.dbCalls, spans: keepSpans && t.spans.length ? t.spans : null, meta: t.ms >= 500 && t.path ? { path: t.path } : null })
}

// Client events from the app window (web/src/tracing.ts).
export type ClientEvent = { at?: number; name: string; ms: number; meta?: any }
export function recordClient(events: ClientEvent[], now = Date.now()) {
  let n = 0
  for (const e of (Array.isArray(events) ? events : []).slice(0, 500)) {
    if (!e || typeof e.name !== 'string' || !Number.isFinite(Number(e.ms))) continue
    const at = Number(e.at), ok = Number.isFinite(at) && at > now - 6 * HOUR && at <= now + MIN
    let meta = e.meta && typeof e.meta === 'object' ? e.meta : null
    if (meta && JSON.stringify(meta).length > 2000) meta = { truncated: true, keys: Object.keys(meta).slice(0, 20) }
    push({ at: ok ? at : now, kind: 'client', name: e.name.slice(0, 120), ms: Math.max(0, Number(e.ms)), meta }); n++
  }
  return n
}

let bgCursor = Math.floor(Date.now() / MIN)
export function flush(now = Date.now()) {
  const minute = Math.floor(now / MIN)
  for (const b of backgroundMinutes(bgCursor, minute)) push({ at: b.minute * MIN, kind: 'background', name: b.name, ms: b.ms, meta: { calls: b.calls, maxMs: Math.round(b.max) } })
  bgCursor = minute
  checkConfig(now)
  if (!queue.length) return 0
  const rows = queue.splice(0)
  tx(() => { for (const r of rows) run(`insert into trace_events (at, build_id, kind, name, ms, status, db_ms, db_calls, spans, meta) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    r.at, buildId, r.kind, r.name, Math.round(r.ms * 10) / 10, r.status ?? null, r.dbMs == null ? null : Math.round(r.dbMs * 10) / 10, r.dbCalls ?? null,
    r.spans ? JSON.stringify(r.spans.map(s => ({ name: s.name, start: Math.round(s.start), ms: Math.round(s.ms * 10) / 10 }))) : null, r.meta == null ? null : JSON.stringify(r.meta)) })
  return rows.length
}

// ---- condensing: raw → hourly summary → gone ----

const pct = (sorted: number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length))] : 0
const r1 = (n: number) => Math.round(n * 10) / 10
const parse = (s: string | null) => { if (!s) return null; try { return JSON.parse(s) } catch { return null } }
function where(spans: Span[] | null, top = 5) {
  const by = new Map<string, { calls: number; ms: number }>()
  for (const s of spans ?? []) { const a = by.get(s.name) ?? { calls: 0, ms: 0 }; a.calls++; a.ms += s.ms; by.set(s.name, a) }
  return [...by].sort((a, b) => b[1].ms - a[1].ms).slice(0, top).map(([name, a]) => ({ name, calls: a.calls, ms: r1(a.ms) }))
}

type Ev = { id: number; at: number; build_id: number | null; kind: string; name: string; ms: number; status: number | null; db_ms: number | null; spans: string | null; meta: string | null }
export function summarize(evs: Ev[]) {
  const ms = evs.map(e => e.ms).sort((a, b) => a - b)
  const spanAgg = new Map<string, { calls: number; ms: number }>()
  let calls = 0, errors = 0, dbMs = 0
  for (const e of evs) {
    const m = parse(e.meta)
    calls += e.kind === 'background' ? Number(m?.calls) || 1 : 1
    if ((e.status ?? 0) >= 500 || m?.error || m?.neverSent) errors++
    dbMs += e.db_ms ?? 0
    for (const w of where(parse(e.spans), 50)) { const a = spanAgg.get(w.name) ?? { calls: 0, ms: 0 }; a.calls += w.calls; a.ms += w.ms; spanAgg.set(w.name, a) }
  }
  const slowest = [...evs].sort((a, b) => b.ms - a.ms).slice(0, 3).map(e => ({ at: e.at, ms: r1(e.ms), status: e.status, where: where(parse(e.spans)), meta: parse(e.meta) }))
  return {
    n: evs.length, calls, errors, total_ms: r1(ms.reduce((a, b) => a + b, 0)),
    p50: r1(pct(ms, 50)), p90: r1(pct(ms, 90)), p95: r1(pct(ms, 95)), p99: r1(pct(ms, 99)), max: r1(ms.at(-1) ?? 0), db_ms: r1(dbMs),
    top_spans: [...spanAgg].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8).map(([name, a]) => ({ name, calls: a.calls, ms: r1(a.ms) })), slowest,
  }
}

// Condense every whole hour of raw events older than the raw TTL, then drop expired summaries and
// builds nothing refers to. Hour by hour, so a backlog never holds the event loop for long.
export function condense(now = Date.now(), maxHours = 6) {
  const cutoff = Math.floor((now - RAW_HOURS * HOUR) / HOUR) * HOUR
  let hours = 0
  while (hours < maxHours) {
    const first = get<{ at: number }>(`select min(at) at from trace_events where at < ? and kind != 'config'`, cutoff)
    if (first?.at == null) break
    const hour = Math.floor(first.at / HOUR) * HOUR
    const evs = all<Ev>('select id, at, build_id, kind, name, ms, status, db_ms, spans, meta from trace_events where at >= ? and at < ?', hour, hour + HOUR)
    const groups = new Map<string, Ev[]>()
    for (const e of evs) { if (e.kind === 'config') continue; const k = `${e.build_id}\u0000${e.kind}\u0000${e.name}`; const l = groups.get(k) ?? []; l.push(e); groups.set(k, l) }
    tx(() => {
      for (const [k, g] of groups) {
        const [b, kind, name] = k.split('\u0000'), s = summarize(g), build = b === 'null' ? null : Number(b)
        const old = get<any>('select * from trace_rollups where hour = ? and build_id is ? and kind = ? and name = ?', hour, build, kind, name)
        // A second pass over the same hour (late client events): add counts, keep the worse percentiles.
        const m = old ? { ...s, n: s.n + old.n, calls: s.calls + old.calls, errors: s.errors + old.errors, total_ms: s.total_ms + old.total_ms, db_ms: s.db_ms + old.db_ms,
          p50: Math.max(s.p50, old.p50), p90: Math.max(s.p90, old.p90), p95: Math.max(s.p95, old.p95), p99: Math.max(s.p99, old.p99), max: Math.max(s.max, old.max) } : s
        run(`insert or replace into trace_rollups (hour, build_id, kind, name, n, calls, errors, total_ms, p50, p90, p95, p99, max, db_ms, top_spans, slowest) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          hour, build, kind, name, m.n, m.calls, m.errors, m.total_ms, m.p50, m.p90, m.p95, m.p99, m.max, m.db_ms, JSON.stringify(s.top_spans), JSON.stringify(s.slowest))
      }
      // Settings changes are rare and small: keep them as long as summaries.
      run(`delete from trace_events where at >= ? and at < ? and kind != 'config'`, hour, hour + HOUR)
    })
    hours++
  }
  const keepFrom = now - SUMMARY_DAYS * 24 * HOUR
  run('delete from trace_rollups where hour < ?', keepFrom)
  run('delete from trace_events where at < ?', keepFrom)
  run(`delete from trace_builds where started_at < ? and id != ? and id not in (select distinct build_id from trace_rollups where build_id is not null) and id not in (select distinct build_id from trace_events where build_id is not null)`, keepFrom, buildId ?? -1)
  return hours
}

let started = false
export function startTraceStore() {
  if (started || UNDER_TEST) return
  started = true
  recordBuild()
  onTraceDone(recordRequest)
  onLoopSample(l => push({ at: l.at, kind: 'loop', name: 'event loop delay', ms: l.max, meta: { p50: r1(l.p50), p99: r1(l.p99) } }))
  setInterval(() => { try { flush() } catch (e) { console.error('[traces] flush', e) } }, 5000).unref()
  setInterval(() => { try { condense() } catch (e) { console.error('[traces] condense', e) } }, 10 * MIN).unref()
  setTimeout(() => { try { condense() } catch {} }, 60_000).unref()
}

// ---- reading ----

export type Q = { action?: string; from?: number; to?: number; hours?: number; name?: string; kind?: string; build?: number; id?: number; limit?: number; bucket?: string; now?: number }
const like = (s?: string) => `%${(s ?? '').replace(/[%_]/g, m => '\\' + m)}%`

function range(q: Q) {
  const now = q.now ?? Date.now()
  const to = q.to ?? now
  const from = q.from ?? to - (q.hours ?? 24) * HOUR
  return { from, to, now }
}

function filters(q: Q, col = 'at') {
  const w: string[] = [], p: any[] = []
  if (q.name) { w.push(`name like ? escape '\\'`); p.push(like(q.name)) }
  if (q.kind) { w.push('kind = ?'); p.push(q.kind) }
  if (q.build) { w.push('build_id = ?'); p.push(q.build) }
  return { sql: w.length ? ' and ' + w.join(' and ') : '', p, col }
}

function buildLabel(b: any) {
  if (!b) return null
  const since = parse(b.commits_since) ?? [], dirty = parse(b.dirty_files) ?? []
  return { id: b.id, startedAt: new Date(b.started_at).toISOString(), sha: b.sha?.slice(0, 9) ?? null, subject: b.subject, branch: b.branch,
    newCommits: since.length, commits: since.slice(0, 15), uncommittedFiles: dirty, uncommittedHash: b.dirty_hash, configHash: b.config_hash }
}

export function builds(q: Q) {
  const { from, to } = range(q)
  // Builds running at any point in the window: started in it, or the last one started before it.
  const rows = all<any>(`select * from trace_builds where started_at <= ? and (started_at >= ? or id = (select max(id) from trace_builds where started_at < ?)) order by id`, to, from, from)
  const out = rows.map((b, i) => {
    const label = buildLabel(b)!
    // What changed in settings vs the build before it.
    const prev = get<any>('select config from trace_builds where id < ? order by id desc limit 1', b.id)
    const a = parse(prev?.config) ?? {}, c = parse(b.config) ?? {}
    const configChanged = prev ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(c)])].filter(k => a[k] !== c[k]).map(k => [k, [a[k], c[k]]])) : null
    return { ...label, until: rows[i + 1] ? new Date(rows[i + 1].started_at).toISOString() : null, configChanged }
  })
  const changes = all<any>(`select at, build_id, meta from trace_events where kind = 'config' and at between ? and ? order by at`, from, to).map(e => ({ at: new Date(e.at).toISOString(), build: e.build_id, changed: parse(e.meta) }))
  return { window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() }, builds: out, settingsChanges: changes }
}

// Per (kind, name): raw events where still kept, plus hourly summaries for older hours.
function groupStats(q: Q, by: 'name' | 'build' = 'name') {
  const { from, to } = range(q), f = filters(q)
  const key = (e: { kind: string; name: string; build_id: number | null }) => by === 'build' ? `${e.build_id}\u0000${e.kind}\u0000${e.name}` : `${e.kind}\u0000${e.name}`
  const raw = new Map<string, Ev[]>()
  for (const e of all<Ev>(`select id, at, build_id, kind, name, ms, status, db_ms, spans, meta from trace_events where at between ? and ? and kind != 'config'${f.sql}`, from, to, ...f.p)) {
    const k = key(e); const l = raw.get(k) ?? []; l.push(e); raw.set(k, l)
  }
  const out = new Map<string, any>()
  for (const [k, evs] of raw) { const s = summarize(evs); out.set(k, { kind: evs[0].kind, name: evs[0].name, build: evs[0].build_id, ...s, source: 'raw' }) }
  const rolls = all<any>(`select * from trace_rollups where hour >= ? and hour < ?${f.sql}`, Math.floor(from / HOUR) * HOUR, to, ...f.p)
  for (const r of rolls) {
    const k = key({ kind: r.kind, name: r.name, build_id: r.build_id })
    const o = out.get(k)
    const spans = parse(r.top_spans) ?? [], slow = parse(r.slowest) ?? []
    if (!o) { out.set(k, { kind: r.kind, name: r.name, build: r.build_id, n: r.n, calls: r.calls, errors: r.errors, total_ms: r.total_ms, p50: r.p50, p90: r.p90, p95: r.p95, p99: r.p99, max: r.max, db_ms: r.db_ms, top_spans: spans, slowest: slow, source: 'summary', _w: r.n }); continue }
    // Merge: counts add; p50 weighted by count; tail percentiles take the worse (conservative).
    const w = o._w ?? o.n
    o.p50 = r1((o.p50 * w + r.p50 * r.n) / Math.max(1, w + r.n)); o._w = w + r.n
    o.n += r.n; o.calls += r.calls; o.errors += r.errors; o.total_ms += r.total_ms; o.db_ms += r.db_ms
    o.p90 = Math.max(o.p90, r.p90); o.p95 = Math.max(o.p95, r.p95); o.p99 = Math.max(o.p99, r.p99); o.max = Math.max(o.max, r.max)
    const agg = new Map<string, any>(o.top_spans.map((s: any) => [s.name, { ...s }]))
    for (const s of spans) { const a = agg.get(s.name) ?? { name: s.name, calls: 0, ms: 0 }; a.calls += s.calls; a.ms += s.ms; agg.set(s.name, a) }
    o.top_spans = [...agg.values()].sort((a, b) => b.ms - a.ms).slice(0, 8)
    o.slowest = [...o.slowest, ...slow].sort((a, b) => b.ms - a.ms).slice(0, 3)
    if (o.source !== 'raw+summary') o.source = o.source === 'summary' ? 'summary' : 'raw+summary'
  }
  return [...out.values()].map(({ _w, ...o }) => ({ ...o, total_ms: r1(o.total_ms), db_ms: r1(o.db_ms) }))
}

const isoAt = (x: any) => ({ ...x, at: x.at ? new Date(x.at).toISOString() : x.at })

// Plain-language reading: what cost the most time, what was slowest, what users waited on.
function diagnose(groups: any[], hours: number) {
  const out: string[] = []
  const req = groups.filter(g => g.kind === 'request'), bg = groups.filter(g => g.kind === 'background'), cl = groups.filter(g => g.kind === 'client')
  const loop = groups.find(g => g.kind === 'loop')
  const chat = cl.find(g => g.name === 'chat.open')
  if (chat) out.push(`Opening a chat (user-visible): p50 ${Math.round(chat.p50)}ms, p95 ${Math.round(chat.p95)}ms, max ${Math.round(chat.max)}ms over ${chat.n} opens.`)
  const queued = cl.filter(g => g.name.startsWith('api ') && g.slowest.some((s: any) => (s.meta?.queuedMs ?? 0) > 500))
  if (queued.length) out.push(`The app window waited for a free connection before sending requests (browser's 6-per-host limit): ${queued.slice(0, 4).map(g => g.name.slice(4)).join(', ')}. Look for long-running requests holding connections at the same time.`)
  const lt = cl.find(g => g.name === 'longtask')
  if (lt && lt.n) out.push(`The app window's UI thread was blocked ${lt.n}× (long tasks), ${Math.round(lt.total_ms)}ms in total, worst ${Math.round(lt.max)}ms.`)
  if (loop && loop.p99 > 200) out.push(`Server event loop delay: p95 of 10s maxima ${Math.round(loop.p95)}ms, worst ${Math.round(loop.max)}ms. Every request waits behind that.`)
  for (const g of [...req].sort((a, b) => b.p95 * Math.log2(b.n + 1) - a.p95 * Math.log2(a.n + 1)).slice(0, 3).filter(g => g.p95 > 500)) {
    const top = g.top_spans[0]
    out.push(`${g.name}: p95 ${Math.round(g.p95)}ms over ${g.n} calls${top ? `; most time in ${top.name} (${Math.round(top.ms)}ms over ${top.calls} calls)` : ''}.`)
  }
  const bgTop = [...bg].sort((a, b) => b.total_ms - a.total_ms)[0]
  if (bgTop && bgTop.total_ms > 10_000) out.push(`Biggest background cost: ${bgTop.name}, ${(bgTop.total_ms / 1000).toFixed(0)}s over ${bgTop.calls} calls (${(bgTop.total_ms / 1000 / 3600 / hours * 100).toFixed(1)}% of wall time).`)
  const err = req.filter(g => g.errors).sort((a, b) => b.errors - a.errors)[0]
  if (err) out.push(`Most server errors: ${err.name}, ${err.errors} of ${err.n}.`)
  if (!out.length) out.push(groups.length ? 'Nothing slow stands out in this window.' : 'No traces in this window.')
  return out
}

export function query(q: Q) {
  const action = q.action ?? 'summary', limit = Math.max(1, Math.min(200, q.limit ?? 20))
  const { from, to } = range(q)
  const window = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), rawKeptHours: RAW_HOURS, summaryKeptDays: SUMMARY_DAYS }
  if (action === 'builds') return builds(q)
  if (action === 'get') {
    const e = get<Ev>('select * from trace_events where id = ?', q.id ?? -1)
    if (!e) return { error: `No raw trace ${q.id}: raw events are kept ${RAW_HOURS}h, then only hourly summaries remain (action=summary or slowest with a time range).` }
    const spans = (parse(e.spans) ?? []).sort((a: any, b: any) => a.start - b.start)
    return { ...isoAt(e), spans, where: where(spans, 12), meta: parse(e.meta), build: buildLabel(get('select * from trace_builds where id = ?', e.build_id)) }
  }
  if (action === 'slowest') {
    const f = filters(q)
    const raw = all<Ev>(`select id, at, build_id, kind, name, ms, status, db_ms, spans, meta from trace_events where at between ? and ? and kind not in ('config', 'background', 'loop')${f.sql} order by ms desc limit ?`, from, to, ...f.p, limit)
      .map(e => ({ id: e.id, at: new Date(e.at).toISOString(), build: e.build_id, kind: e.kind, name: e.name, ms: r1(e.ms), status: e.status, where: where(parse(e.spans)), meta: parse(e.meta) }))
    // Older hours only have the 3 slowest per hour and name.
    const old = all<any>(`select hour, build_id, kind, name, slowest from trace_rollups where hour >= ? and hour < ? and kind not in ('background', 'loop')${f.sql}`, Math.floor(from / HOUR) * HOUR, to, ...f.p)
      .flatMap(r => (parse(r.slowest) ?? []).map((s: any) => ({ id: null, at: new Date(s.at).toISOString(), build: r.build_id, kind: r.kind, name: r.name, ms: s.ms, status: s.status, where: s.where, meta: s.meta, fromSummary: true })))
    return { window, slowest: [...raw, ...old].sort((a, b) => b.ms - a.ms).slice(0, limit) }
  }
  if (action === 'timeline') {
    const bucket = q.bucket === 'minute' ? MIN : q.bucket === 'day' ? 24 * HOUR : HOUR, f = filters(q)
    const pts = new Map<number, number[]>(), rolled = new Map<number, any>()
    for (const e of all<any>(`select at, ms from trace_events where at between ? and ? and kind != 'config'${f.sql}`, from, to, ...f.p)) { const b = Math.floor(e.at / bucket) * bucket; const l = pts.get(b) ?? []; l.push(e.ms); pts.set(b, l) }
    for (const r of all<any>(`select hour, n, p50, p95, max, total_ms from trace_rollups where hour >= ? and hour < ?${f.sql}`, Math.floor(from / HOUR) * HOUR, to, ...f.p)) {
      const b = Math.floor(r.hour / bucket) * bucket, o = rolled.get(b) ?? { n: 0, p50w: 0, p95: 0, max: 0, total: 0 }
      o.n += r.n; o.p50w += r.p50 * r.n; o.p95 = Math.max(o.p95, r.p95); o.max = Math.max(o.max, r.max); o.total += r.total_ms; rolled.set(b, o)
    }
    const keys = [...new Set([...pts.keys(), ...rolled.keys()])].sort((a, b) => a - b)
    const series = keys.map(b => {
      const ms = (pts.get(b) ?? []).sort((x, y) => x - y), o = rolled.get(b)
      const n = ms.length + (o?.n ?? 0)
      return { at: new Date(b).toISOString(), n, p50: r1(ms.length ? pct(ms, 50) : o.p50w / Math.max(1, o.n)), p95: r1(Math.max(pct(ms, 95), o?.p95 ?? 0)), max: r1(Math.max(ms.at(-1) ?? 0, o?.max ?? 0)), totalMs: r1(ms.reduce((a, x) => a + x, 0) + (o?.total ?? 0)) }
    })
    // Builds starting inside the window, to line the series up against code changes.
    const marks = all<any>('select id, started_at, sha, subject from trace_builds where started_at between ? and ? order by started_at', from, to).map(b => ({ build: b.id, at: new Date(b.started_at).toISOString(), sha: b.sha?.slice(0, 9), subject: b.subject }))
    return { window, name: q.name ?? null, kind: q.kind ?? null, bucket: q.bucket ?? 'hour', series, builds: marks }
  }
  if (action === 'compare') {
    // The same operations side by side per build: did a change make them slower?
    const groups = groupStats(q, 'build')
    const byName = new Map<string, any[]>()
    for (const g of groups) { const k = `${g.kind} ${g.name}`; const l = byName.get(k) ?? []; l.push(g); byName.set(k, l) }
    const ids = [...new Set(groups.map(g => g.build))].filter(b => b != null)
    const meta = new Map(ids.map(id => [id, buildLabel(get('select * from trace_builds where id = ?', id))]))
    const rows = [...byName].filter(([, l]) => l.length > 1 || q.name).map(([k, l]) => ({ op: k, byBuild: l.sort((a, b) => (a.build ?? 0) - (b.build ?? 0)).map(g => ({ build: g.build, sha: meta.get(g.build)?.sha ?? null, n: g.n, p50: g.p50, p95: g.p95, max: g.max, errors: g.errors })) }))
      .map(r => { const b = r.byBuild, first = b[0], last = b.at(-1)!; return { ...r, p95Change: first && last && first.p95 ? `${Math.round((last.p95 / first.p95 - 1) * 100)}%` : null } })
      .sort((a, b) => Math.abs(parseInt(b.p95Change ?? '0')) - Math.abs(parseInt(a.p95Change ?? '0'))).slice(0, limit)
    return { window, builds: [...meta.values()], operations: rows }
  }
  if (action === 'spans') {
    // Where time goes across everything: each span name (SQL, gh, subprocess) over all requests,
    // plus background work, which is already one name per row.
    const f = filters(q), agg = new Map<string, { calls: number; ms: number; inRequests: number; background: number; max: number }>()
    const add = (name: string, calls: number, ms: number, bg: boolean, max: number) => { const a = agg.get(name) ?? { calls: 0, ms: 0, inRequests: 0, background: 0, max: 0 }; a.calls += calls; a.ms += ms; if (bg) a.background += ms; else a.inRequests += ms; a.max = Math.max(a.max, max); agg.set(name, a) }
    for (const e of all<any>(`select kind, name, ms, spans, meta from trace_events where at between ? and ? and kind in ('request', 'background')${f.sql}`, from, to, ...f.p)) {
      if (e.kind === 'background') { const m = parse(e.meta); add(e.name, Number(m?.calls) || 1, e.ms, true, Number(m?.maxMs) || e.ms); continue }
      for (const s of parse(e.spans) ?? []) add(s.name, 1, s.ms, false, s.ms)
    }
    for (const r of all<any>(`select kind, name, calls, total_ms, max, top_spans from trace_rollups where hour >= ? and hour < ? and kind in ('request', 'background')${f.sql}`, Math.floor(from / HOUR) * HOUR, to, ...f.p)) {
      if (r.kind === 'background') add(r.name, r.calls, r.total_ms, true, r.max)
      else for (const s of parse(r.top_spans) ?? []) add(s.name, s.calls, s.ms, false, 0)
    }
    return { window, note: 'Request spans are kept for requests of at least 50ms; older hours keep each route\'s top 8 spans.', spans: [...agg].sort((a, b) => b[1].ms - a[1].ms).slice(0, limit).map(([name, a]) => ({ name, calls: a.calls, totalMs: r1(a.ms), inRequestsMs: r1(a.inRequests), backgroundMs: r1(a.background), avgMs: r1(a.ms / Math.max(1, a.calls)), maxMs: r1(a.max) })) }
  }
  // summary
  const groups = groupStats(q)
  const hours = Math.max(1 / 60, (to - from) / HOUR)
  const pick = (kind: string, n: number) => groups.filter(g => g.kind === kind).sort((a, b) => b.p95 * Math.log2(b.n + 1) - a.p95 * Math.log2(a.n + 1)).slice(0, n)
    .map(({ slowest, ...g }) => ({ ...g, slowest: slowest.slice(0, 1).map(isoAt) }))
  const bt = groups.filter(g => g.kind === 'background').sort((a, b) => b.total_ms - a.total_ms).slice(0, 10).map(({ slowest, p50, p90, p95, p99, ...g }) => g)
  const loop = groups.find(g => g.kind === 'loop')
  const counts = get<any>(`select count(*) raw, min(at) oldest from trace_events`)
  const sums = get<any>(`select count(*) n, min(hour) oldest from trace_rollups`)
  return {
    diagnosis: diagnose(groups, hours), window,
    builds: builds(q).builds.map(b => ({ id: b.id, startedAt: b.startedAt, until: b.until, sha: b.sha, subject: b.subject, newCommits: b.newCommits, uncommittedFiles: b.uncommittedFiles.length, configChanged: b.configChanged })),
    client: pick('client', limit), requests: pick('request', limit), background: bt,
    eventLoop: loop ? { samples: loop.n, p50: loop.p50, p95: loop.p95, max: loop.max } : null,
    storage: { rawEvents: counts?.raw ?? 0, rawOldest: counts?.oldest ? new Date(counts.oldest).toISOString() : null, summaries: sums?.n ?? 0, summaryOldest: sums?.oldest ? new Date(sums.oldest).toISOString() : null },
  }
}
