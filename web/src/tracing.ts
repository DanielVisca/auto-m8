// Client-side timings for auto-m8's durable traces (server/tracestore.ts): what the user actually
// waited on, which the server can't see. API requests that were slow or sat queued in the browser
// (it allows 6 connections per host; 2026-11-25 chats hung on "Loading…" because slow Railyard
// requests held them all), long tasks blocking the UI thread, page loads, and explicit marks like
// chat.open. Batched every 10s; sent with sendBeacon when the page goes away.
type Ev = { at: number; name: string; ms: number; meta?: Record<string, unknown> }
const q: Ev[] = []
const view = () => (location.hash || '#home').split(/[?/]/)[0].slice(0, 40)

export function traceUi(name: string, ms: number, meta?: Record<string, unknown>) {
  if (q.length < 1000) q.push({ at: Date.now() - ms, name, ms: Math.round(ms), meta: { view: view(), ...meta } })
}

// Same shape as the server's route names (latency.ts routeOf), so both sides line up.
export const routeOf = (path: string) => path.split('/').map(s => (/^[0-9a-f-]{16,}$/i.test(s) || /^\d+$/.test(s) || /%|@|\./.test(s) || s.length > 40) ? ':id' : s).join('/')

function send(beacon = false) {
  if (!q.length) return
  const body = JSON.stringify({ events: q.splice(0, 500) })
  if (beacon && navigator.sendBeacon) { navigator.sendBeacon('/api/traces/client', new Blob([body], { type: 'application/json' })); return }
  fetch('/api/traces/client', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {})
}

let started = false
export function startTracing() {
  if (started || typeof PerformanceObserver === 'undefined') return
  started = true
  const observe = (type: string, fn: (e: any) => void) => { try { new PerformanceObserver(l => l.getEntries().forEach(fn)).observe({ type, buffered: true } as any) } catch {} }
  observe('resource', (e: PerformanceResourceTiming) => {
    const u = new URL(e.name, location.href)
    if (u.origin !== location.origin || !u.pathname.startsWith('/api/') || u.pathname.startsWith('/api/traces') || u.pathname === '/api/events') return
    // requestStart 0: never sent (aborted while waiting for a connection).
    const neverSent = !e.requestStart
    const queued = neverSent ? e.duration : e.requestStart - e.startTime
    if (e.duration < 300 && queued < 100) return
    traceUi(`api ${routeOf(u.pathname)}`, e.duration, {
      queuedMs: Math.round(queued), serverMs: neverSent ? null : Math.round(e.responseStart - e.requestStart), downloadMs: neverSent ? null : Math.round(e.responseEnd - e.responseStart),
      kb: Math.round((e.encodedBodySize || 0) / 1024), ...(neverSent ? { neverSent: true } : {}),
    })
  })
  observe('longtask', (e: PerformanceEntry) => { if (e.duration >= 200) traceUi('longtask', e.duration) })
  observe('navigation', (e: PerformanceNavigationTiming) => {
    if (e.loadEventEnd) traceUi('page.load', e.loadEventEnd, { domContentLoadedMs: Math.round(e.domContentLoadedEventEnd), type: e.type })
  })
  setInterval(() => send(), 10_000)
  addEventListener('pagehide', () => send(true))
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') send(true) })
}
