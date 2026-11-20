// Live latency traces for perch itself, so an agent can say why perch is slow right now.
// Every API request is a trace (AsyncLocalStorage carries it through awaits); every SQLite call
// made inside it is a span. SQLite calls outside any request (timers, chat streams) are counted
// as background. Alongside: event-loop delay every 10s and requests still in flight. All in memory,
// bounded (last hour), a few microseconds per query. Stalls with their CPU profile summary are in
// the availability table (stallprof.ts); the report joins them in.
// Read it with GET /api/latency or the perch MCP tool `latency`.
import { AsyncLocalStorage } from 'node:async_hooks'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

export type Span = { name: string; start: number; ms: number }
export type Trace = { id: number; at: number; name: string; ms: number; status?: number; spans: Span[]; dbMs: number; dbCalls: number; done: boolean }

const als = new AsyncLocalStorage<Trace>()
const MAX_SPANS = 200, KEEP_TRACES = 3000, HOUR = 3600_000
let nextId = 1
const finished: Trace[] = []
const inFlight = new Set<Trace>()

// /api/conversations/86a5…/turns → /api/conversations/:id/turns, so routes aggregate.
export function routeOf(method: string, path: string) {
  const p = path.split('/').map(s => (/^[0-9a-f-]{16,}$/i.test(s) || /^\d+$/.test(s) || /%|@|\./.test(s) || s.length > 40) ? ':id' : s).join('/')
  return `${method} ${p}`
}

export function startTrace(name: string, now = Date.now()): Trace {
  const t: Trace = { id: nextId++, at: now, name, ms: 0, spans: [], dbMs: 0, dbCalls: 0, done: false }
  inFlight.add(t)
  return t
}
export const runInTrace = <T>(t: Trace, fn: () => T) => als.run(t, fn)
export function endTrace(t: Trace, status?: number, now = Date.now()) {
  if (t.done) return
  t.done = true; t.ms = now - t.at; t.status = status
  inFlight.delete(t)
  finished.push(t)
  while (finished.length > KEEP_TRACES || (finished.length && now - finished[0].at > HOUR)) finished.shift()
}

// SQL as a span name: whitespace folded, literals kept short.
const names = new Map<string, string>()
const sqlName = (sql: string) => { let n = names.get(sql); if (n === undefined) { if (names.size > 2000) names.clear(); n = sql.replace(/\s+/g, ' ').trim().slice(0, 120); names.set(sql, n) } return n }
type Agg = { n: number; ms: number; max: number }
const background = new Map<number, Map<string, Agg>>() // minute → sql → totals
const bump = (m: Map<string, Agg>, k: string, ms: number) => { const a = m.get(k) ?? { n: 0, ms: 0, max: 0 }; a.n++; a.ms += ms; a.max = Math.max(a.max, ms); m.set(k, a) }

// Called by db.ts around every query.
export function recordDb(kind: string, sql: string, ms: number, now = Date.now()) {
  const t = als.getStore()
  if (t && !t.done) {
    t.dbMs += ms; t.dbCalls++
    if (t.spans.length < MAX_SPANS) t.spans.push({ name: `db.${kind} ${sqlName(sql)}`, start: now - ms - t.at, ms })
    return
  }
  const minute = Math.floor(now / 60_000)
  let m = background.get(minute)
  if (!m) { m = new Map(); background.set(minute, m); for (const k of background.keys()) if (k < minute - 60) background.delete(k) }
  bump(m, `db.${kind} ${sqlName(sql)}`, ms)
}

// Any other piece of work worth timing (a subprocess, a gh call, a scan): a span in the current
// trace, or background totals when there is none.
export async function span<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const t = als.getStore(), start = performance.now()
  try { return await fn() } finally {
    const ms = performance.now() - start
    if (t && !t.done) { if (t.spans.length < MAX_SPANS) t.spans.push({ name, start: Date.now() - ms - t.at, ms }) }
    else { const minute = Math.floor(Date.now() / 60_000); const m = background.get(minute) ?? new Map(); background.set(minute, m); bump(m, name, ms) }
  }
}

// Event-loop delay: p50/p99/max for each 10s.
type Loop = { at: number; p50: number; p99: number; max: number }
const loops: Loop[] = []
let loopTimer: NodeJS.Timeout | null = null
export function startLatency() {
  if (loopTimer) return
  const h = monitorEventLoopDelay({ resolution: 20 }); h.enable()
  loopTimer = setInterval(() => {
    loops.push({ at: Date.now(), p50: h.percentile(50) / 1e6, p99: h.percentile(99) / 1e6, max: h.max / 1e6 })
    if (loops.length > 360) loops.shift()
    h.reset()
  }, 10_000)
  loopTimer.unref()
}

const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))] }
const r = (n: number) => Math.round(n)

// Group a trace's spans by name: where its time went.
export function breakdown(t: Trace, top = 6) {
  const by = new Map<string, Agg>()
  for (const s of t.spans) bump(by, s.name, s.ms)
  return [...by].sort((a, b) => b[1].ms - a[1].ms).slice(0, top).map(([name, a]) => ({ name, calls: a.n, ms: r(a.ms) }))
}

export type Machine = { severity?: string; reasons?: { label: string; detail: string }[]; load?: number; cores?: number; memory?: any; processes?: any[] } | null
export type Stall = { at: number; ms: number; cause: string; detail: string }

export function report(o: { seconds: number; machine?: Machine; stalls?: Stall[]; route?: string; now?: number }) {
  const now = o.now ?? Date.now(), from = now - o.seconds * 1000
  const win = finished.filter(t => t.at >= from && (!o.route || t.name.includes(o.route)))
  const routes = new Map<string, Trace[]>()
  for (const t of win) { const l = routes.get(t.name) ?? []; l.push(t); routes.set(t.name, l) }
  const byRoute = [...routes].map(([name, ts]) => {
    const ms = ts.map(t => t.ms), total = ms.reduce((a, b) => a + b, 0), db = ts.reduce((a, t) => a + t.dbMs, 0)
    return { route: name, n: ts.length, p50: r(pct(ms, 50)), p95: r(pct(ms, 95)), p99: r(pct(ms, 99)), max: r(Math.max(...ms)), dbShare: total ? Math.round(100 * db / total) : 0 }
  }).sort((a, b) => b.p95 * Math.log2(b.n + 1) - a.p95 * Math.log2(a.n + 1)).slice(0, 15)
  const slowest = [...win].sort((a, b) => b.ms - a.ms).slice(0, 8).map(t => ({ route: t.name, at: new Date(t.at).toISOString(), ms: r(t.ms), status: t.status, dbMs: r(t.dbMs), dbCalls: t.dbCalls, where: breakdown(t) }))
  const live = [...inFlight].filter(t => !t.name.endsWith('/api/events') && !t.name.includes(' /ws/')).sort((a, b) => a.at - b.at).slice(0, 10)
    .map(t => ({ route: t.name, runningMs: now - t.at, dbMs: r(t.dbMs), where: breakdown(t, 3) }))
  const bg = new Map<string, Agg>()
  for (const [minute, m] of background) if (minute * 60_000 >= from - 60_000) for (const [k, a] of m) { const b = bg.get(k) ?? { n: 0, ms: 0, max: 0 }; b.n += a.n; b.ms += a.ms; b.max = Math.max(b.max, a.max); bg.set(k, b) }
  const backgroundTop = [...bg].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8).map(([name, a]) => ({ name, calls: a.n, ms: r(a.ms), maxMs: r(a.max) }))
  const lw = loops.filter(l => l.at >= from - 10_000)
  const loop = lw.length ? { p50: r(pct(lw.map(l => l.p50), 50)), p99: r(Math.max(...lw.map(l => l.p99))), max: r(Math.max(...lw.map(l => l.max))), series: lw.slice(-30).map(l => [Math.round(l.at / 1000), r(l.max)]) } : null
  const stalls = (o.stalls ?? []).filter(s => s.at >= from)
  const base = { window: `${o.seconds}s`, requests: win.length, eventLoop: loop, inFlight: live, routes: byRoute, slowest, background: backgroundTop, stalls, machine: o.machine ?? null }
  return { diagnosis: diagnose(base), ...base }
}

// Plain-language reading of the numbers, most likely cause first.
export function diagnose(x: { requests: number; eventLoop: { p50: number; p99: number; max: number } | null; inFlight: { route: string; runningMs: number; dbMs: number }[]; routes: { route: string; n: number; p95: number; dbShare: number }[]; slowest: { route: string; ms: number; where: { name: string; ms: number }[] }[]; background: { name: string; ms: number; calls: number }[]; stalls: Stall[]; machine: Machine }) {
  const out: string[] = []
  const m = x.machine
  if (m && m.severity && m.severity !== 'ok') out.push(`Mac under pressure (${m.severity}): ${(m.reasons ?? []).map(r => `${r.label}: ${r.detail.replace(/\.+$/, '')}`).join('; ')}. Everything in Mothership slows when the machine swaps or is CPU-starved; fix that first (top processes are in machine.processes).`)
  const stalls = x.stalls.filter(s => !/asleep|suspended/.test(s.cause))
  if (stalls.length) {
    const ms = stalls.reduce((a, s) => a + s.ms, 0)
    const named = stalls.filter(s => s.detail).sort((a, b) => b.ms - a.ms)[0]
    out.push(`Event loop froze ${stalls.length}× for ${(ms / 1000).toFixed(1)}s in total (every request waits during a freeze).${named ? ` Longest profiled: ${r(named.ms)}ms during ${named.cause}: ${named.detail}` : ''}`)
  } else if (x.eventLoop && x.eventLoop.p99 > 200) out.push(`Event loop is busy: p99 delay ${x.eventLoop.p99}ms, max ${x.eventLoop.max}ms. Synchronous work is blocking requests; see background and slowest.where.`)
  const stuck = x.inFlight.filter(t => t.runningMs > 5000)
  if (stuck.length) out.push(`${stuck.length} request${stuck.length > 1 ? 's' : ''} running over 5s now: ${stuck.slice(0, 3).map(t => `${t.route} ${(t.runningMs / 1000).toFixed(0)}s`).join(', ')}.`)
  for (const rt of x.routes.filter(rt => rt.p95 > 1000).slice(0, 3)) {
    const s = x.slowest.find(t => t.route === rt.route)
    const top = s?.where[0]
    // Name a span only when it explains a real part of the call; otherwise the time is untraced.
    const named = top && s && top.ms >= s.ms * 0.2 ? ` Biggest cost in its slowest call: ${top.name} ${top.ms}ms.` : s ? ` Its slowest call (${s.ms}ms) spent most of its time outside traced spans.` : ''
    const frozen = x.stalls.some(st => !/asleep|suspended/.test(st.cause)) || (x.eventLoop && x.eventLoop.p99 > 200)
    out.push(`${rt.route} is slow: p95 ${rt.p95}ms over ${rt.n} calls, ${rt.dbShare}% in SQLite.${named}${rt.dbShare < 20 ? frozen ? ' Event-loop freezes in this window add to every request, so part of this is waiting behind them.' : ' Little of it is SQLite or a blocked loop, so it is waiting on I/O (a subprocess, gh, network or a lock).' : ''}`)
  }
  const bg = x.background[0]
  if (bg && bg.ms > 2000) out.push(`Background work outside requests: ${bg.name} took ${(bg.ms / 1000).toFixed(1)}s over ${bg.calls} calls in this window.`)
  if (!out.length) out.push(x.requests ? 'No slowness: requests, event loop and machine look healthy in this window.' : 'No requests in this window yet; widen seconds or open Mothership.')
  return out
}

// Tests reset state between cases.
export function _reset() { finished.length = 0; inFlight.clear(); background.clear(); loops.length = 0 }
