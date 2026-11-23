import { useCallback, useEffect, useRef, useState } from 'react'

export type PR = { url: string; created?: number; state?: string; draft?: number; review?: string; checks?: string; number?: number; repo?: string; title?: string }
export type Conversation = {
  id: string; source: 'claude' | 'posthog-code' | 'posthog-task'; title: string | null; first_prompt: string | null
  cwd: string | null; branch: string | null; started_at: number; updated_at: number; messages: number
  status: string | null; url: string | null; origin: string | null
  state: string | null; state_auto: number | null; pinned: number | null; note: string | null
  effective: State; prs: PR[]; link_count: number; snippet?: string; labels: string[]; snooze_until: number | null; returned?: boolean; reason?: string | null; slack_url?: string | null
}
export type State = 'running' | 'waiting' | 'active' | 'later' | 'idle' | 'done' | 'archived' | 'hidden'
export type Term = { id: string; title: string; cwd: string; cmd?: string; conversationId?: string; exited: boolean; createdAt: number; owner?: string; needsUser?: string; state?: string }
export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; id: string; name: string; input: any; result?: string; isError?: boolean; json?: string; done?: { status: string; summary?: string; at?: number } }
export type Item =
  | { kind: 'user'; text: string; ts?: number; uuid?: string }
  | { kind: 'assistant'; blocks: Block[]; ts?: number; mid?: string; uuid?: string; model?: string; activity?: { tools: string[]; omitted?: number } }
  | { kind: 'result'; ok: boolean; text: string; cost?: number; ms?: number; denials?: number; switched?: { tokens: number; cost: number } }
  | { kind: 'error'; text: string }
  | { kind: 'notice'; text: string } // auto-m8's own note in the thread: a model change, a usage cap

// perch restarts take a few seconds (an agent loading new server code, a crash, the menu). Requests
// in that gap wait for it to come back instead of failing; only a gap longer than OUTAGE_TOAST_MS
// says "perch isn't reachable". Every gap is reported once perch answers again, so Settings →
// Health → Availability shows how often and why.
const OUTAGE_TOAST_MS = 20_000
let downSince = 0, knownPid: number | undefined, slept = false, waiting: Promise<boolean> | null = null
const delay = (ms: number) => new Promise(r => setTimeout(r, ms))
function noteDown() { if (!downSince) { downSince = Date.now(); slept = false } }
export const perchDownFor = () => downSince ? Date.now() - downSince : 0
// Resolves true as soon as /api/health answers (within maxMs), reporting the gap it ends.
export function waitForPerch(maxMs = OUTAGE_TOAST_MS): Promise<boolean> {
  if (waiting) return waiting
  waiting = (async () => {
    const end = Date.now() + maxMs
    while (Date.now() < end) {
      try {
        const r = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(3000) })
        if (r.ok) { noteUp(await r.json()); return true }
      } catch {}
      await delay(500)
    }
    return false
  })().finally(() => { waiting = null })
  return waiting
}
function noteUp(h: { pid?: number }) {
  if (downSince) {
    const body = { ms: Date.now() - downSince, fromPid: knownPid, toPid: h.pid, slept }
    downSince = 0
    fetch('/api/availability', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
  }
  knownPid = h.pid ?? knownPid
}
if (typeof window !== 'undefined') {
  fetch('/api/health').then(r => r.json()).then(h => { knownPid = h.pid }).catch(() => {})
  // A Mac that slept drops every connection; that gap isn't perch's fault, so it's marked.
  let tick = Date.now()
  setInterval(() => { if (Date.now() - tick > 5000 && downSince) slept = true; tick = Date.now() }, 1000)
}

const unreachable = () => toast('auto-m8 isn’t reachable right now.', { action: 'It comes back on its own (the app restarts it); if it doesn’t within a minute, use auto-m8 → Restart.' })
export const api = {
  get: <T = any>(path: string) => fetch(path).then(r => r.json() as Promise<T>),
  send: async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
    const attempt = () => fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    let r: Response, t0 = Date.now()
    try { r = await attempt() } catch (e) {
      noteDown()
      // A refused connection fails at once and never reached perch, so it's safe to send again. One
      // that dropped mid-request may have been done already: don't repeat it, say so.
      const neverSent = Date.now() - t0 < 1500
      if (!await waitForPerch()) { unreachable(); throw e }
      if (!neverSent) { toast('auto-m8 restarted while that was being sent.', { action: 'Check it went through; try again if not.' }); throw e }
      try { r = await attempt() } catch (e2) { unreachable(); throw e2 }
    }
    const data = await r.json().catch(() => ({ error: `auto-m8 answered ${r.status}` }))
    if (!r.ok && (data as any)?.error) toast((data as any).error, { action: (data as any).action })
    return data as T
  },
}
export const post = <T = any>(path: string, body?: unknown) => api.send<T>('POST', path, body ?? {})

// ---------- chat outbox: a message sent while perch is down waits, it is never lost ----------
// Each message is saved to localStorage before it goes out and removed only once perch answers.
// While perch is unreachable (restarting, the Mac waking) it retries, and a reload of the page sends
// what is left. The server drops a repeat of the same clientKey, so a retry never posts twice.
type Queued = { key: string; body: any; at: number }
const OUTBOX = 'perch.outbox'
const outboxSubs = new Set<(n: Queued[]) => void>()
const inFlight = new Map<string, Promise<any>>()
const readOutbox = (): Queued[] => { try { return JSON.parse(localStorage.getItem(OUTBOX) ?? '[]') } catch { return [] } }
const writeOutbox = (q: Queued[]) => { try { localStorage.setItem(OUTBOX, JSON.stringify(q)) } catch {} outboxSubs.forEach(f => f(q)) }
let wake: (() => void) | null = null
const outboxPause = (ms: number) => new Promise<void>(r => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r() } })
function deliver(q: Queued): Promise<any> {
  const running = inFlight.get(q.key)
  if (running) return running
  const p = (async () => {
    let wait = 1000, told = false
    for (;;) {
      try {
        const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...q.body, clientKey: q.key }) })
        if (r.status < 502) { // answered (even with an error): it is no longer ours to retry
          const data = await r.json().catch(() => ({ error: `auto-m8 answered ${r.status}` }))
          writeOutbox(readOutbox().filter(x => x.key !== q.key))
          if (!r.ok && data?.error) toast(data.error, { action: data.action })
          else if (told) toast('Queued message sent.', { kind: 'ok', ms: 3000 })
          return data
        }
      } catch { noteDown() }
      if (!told) { told = true; toast('auto-m8 is reconnecting: your message is queued and sends when it’s back.', { kind: 'info', ms: 5000 }) }
      await outboxPause(wait)
      wait = Math.min(wait * 2, 5000)
    }
  })().finally(() => inFlight.delete(q.key))
  inFlight.set(q.key, p)
  return p
}
export function sendChat<T = any>(body: any): Promise<T> {
  const q = { key: crypto.randomUUID(), body, at: Date.now() }
  writeOutbox([...readOutbox(), q])
  return deliver(q)
}
export function useOutbox() {
  const [q, setQ] = useState<Queued[]>(readOutbox)
  useEffect(() => { outboxSubs.add(setQ); return () => { outboxSubs.delete(setQ) } }, [])
  return q
}
if (typeof window !== 'undefined') {
  // Left over from before a reload or a restart of the app: send it now (anything older than a day is stale).
  setTimeout(() => {
    const left = readOutbox().filter(x => Date.now() - x.at < 864e5)
    writeOutbox(left)
    left.forEach(deliver)
  }, 0)
  addEventListener('storage', e => { if (e.key === OUTBOX) outboxSubs.forEach(f => f(readOutbox())) })
  addEventListener('online', () => wake?.())
}

// ---------- telling the user what went wrong, simply ----------
export type Toast = { id: number; message: string; action?: string; kind: 'error' | 'ok' | 'info' }
const toastSubs = new Set<(t: Toast[]) => void>()
let toasts: Toast[] = []
export function toast(message: string, opts: { action?: string; kind?: Toast['kind']; ms?: number } = {}) {
  const t = { id: Date.now() + Math.random(), message, action: opts.action, kind: opts.kind ?? 'error' }
  if (toasts.some(x => x.message === message)) return
  toasts = [...toasts.slice(-3), t]
  toastSubs.forEach(f => f(toasts))
  setTimeout(() => { toasts = toasts.filter(x => x.id !== t.id); toastSubs.forEach(f => f(toasts)) }, opts.ms ?? 7000)
}
export function useToasts() {
  const [list, setList] = useState<Toast[]>(toasts)
  useEffect(() => { toastSubs.add(setList); return () => { toastSubs.delete(setList) } }, [])
  return list
}

// Crashes in the page are reported to the server (Settings → Health) with where they happened.
export function reportError(where: string, e: unknown) {
  const err = e as any
  fetch('/api/client-errors', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ where, message: String(err?.message ?? err), stack: String(err?.stack ?? '').slice(0, 3000) }) }).catch(() => {})
}
if (typeof window !== 'undefined') {
  addEventListener('error', e => reportError('page', e.error ?? e.message))
  addEventListener('unhandledrejection', e => reportError('page', e.reason))
}

// One EventSource for the whole app; components subscribe to the topics they care about.
type Topic = 'conversations' | 'chats' | 'terms' | 'status' | 'settings' | 'home' | 'autopilot' | 'folders' | 'errors' | 'autoresearch' | 'prflow' | 'canvas' | 'canvasdata' | 'prs' | 'evolve' | 'browser' | 'shadow' | 'race' | 'product-research'
const subs = new Map<Topic, Set<() => void>>()
let es: EventSource | null = null, dropped = false
function ensureEvents() {
  if (es) return
  es = new EventSource('/api/events')
  // Back after a drop (perch restarted, the Mac slept): whatever changed meanwhile was never sent,
  // so every view refetches once instead of staying stale or stuck on "reconnecting".
  es.onopen = () => { wake?.(); if (dropped) { dropped = false; subs.forEach(fs => fs.forEach(f => f())) } }
  es.onmessage = e => { const { what } = JSON.parse(e.data); subs.get(what)?.forEach(f => f()) }
  es.onerror = () => { es?.close(); es = null; dropped = true; noteDown(); waitForPerch(60_000).then(ok => setTimeout(ensureEvents, ok ? 0 : 2000)) }
}
export function onTopic(topic: Topic, f: () => void) {
  ensureEvents()
  if (!subs.has(topic)) subs.set(topic, new Set())
  subs.get(topic)!.add(f)
  return () => { subs.get(topic)!.delete(f) }
}

// Fetches a URL and refetches when any of the topics fire (debounced).
// poll: also reload every `poll` ms while the window is visible, and at once when it comes back
// into view, for data that changes without a perch event (GitHub, analytics).
// keep: when the url changes (a new filter), keep showing the last data while the new one loads,
// and report it as `stale` so the view can say what it is waiting for. Without it, data clears on url change.
// Stale-while-revalidate: the last good answer per url is kept in memory and in localStorage, so a view
// (Insights, Spend, Home...) paints at once with the last data, even after a reload, then updates when
// the fresh answer lands. Big or failed answers are never cached.
const CACHE_PREFIX = 'perch.swr:'
const CACHE_MAX_BYTES = 1_500_000 // the sidebar and Home are ~300-800 KB: the views most worth painting at once
const CACHE_MAX_ENTRIES = 80
const memCache = new Map<string, any>()
const etags = new Map<string, string>() // url -> ETag of the body memCache holds for it
function cacheGet(url: string | null): any {
  if (!url) return undefined
  if (memCache.has(url)) return memCache.get(url)
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + url)
    if (raw) { const d = JSON.parse(raw); memCache.set(url, d); return d }
  } catch {}
  return undefined
}
function cachePut(url: string, d: any) {
  memCache.set(url, d)
  try {
    const raw = JSON.stringify(d)
    if (raw.length > CACHE_MAX_BYTES) { localStorage.removeItem(CACHE_PREFIX + url); return }
    const idx: string[] = JSON.parse(localStorage.getItem(CACHE_PREFIX + '#index') ?? '[]').filter((u: string) => u !== url)
    // Storage full: drop the least recently stored answers until this one fits.
    for (;;) {
      try { localStorage.setItem(CACHE_PREFIX + url, raw); break } catch (e) { const old = idx.shift(); if (!old) throw e; localStorage.removeItem(CACHE_PREFIX + old) }
    }
    idx.push(url)
    while (idx.length > CACHE_MAX_ENTRIES) { const old = idx.shift()!; memCache.delete(old); localStorage.removeItem(CACHE_PREFIX + old) }
    localStorage.setItem(CACHE_PREFIX + '#index', JSON.stringify(idx))
  } catch { /* quota: the memory copy still works */ }
}

// A chat's saved thread, kept for the chats opened lately: reopening one paints from here at once,
// and the refetch sends its ETag, so an unchanged thread (often megabytes) isn't downloaded again.
const threads = new Map<string, { etag: string | null; items: any[] }>()
export const cachedThread = <T = any>(id: string): T[] | undefined => threads.get(id)?.items
export async function loadThread<T = any>(id: string): Promise<{ items: T[] }> {
  const c = threads.get(id)
  const r = await fetch(`/api/conversations/${id}/messages`, c?.etag ? { headers: { 'If-None-Match': c.etag } } : undefined)
  if (r.status === 304 && c) { threads.delete(id); threads.set(id, c); return { items: c.items } }
  const d = await r.json()
  if (r.ok && Array.isArray(d?.items)) {
    threads.delete(id); threads.set(id, { etag: r.headers.get('ETag'), items: d.items })
    for (const old of threads.keys()) { if (threads.size <= 12) break; threads.delete(old) }
  }
  return d
}

export function useLive<T>(url: string | null, topics: Topic[] = [], initial?: T, poll?: number, keep = false) {
  const [data, setData] = useState<T | undefined>(() => cacheGet(url) ?? initial)
  const [dataUrl, setDataUrl] = useState<string | null>(() => (cacheGet(url) !== undefined ? url : null))
  const [inFlight, setInFlight] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const urlRef = useRef(url)
  urlRef.current = url
  const load = useCallback(() => {
    if (!urlRef.current) return
    const u = urlRef.current
    setInFlight(n => n + 1)
    // The server answers 304 when we already hold this exact body: no download, parse or re-render.
    const tag = memCache.has(u) ? etags.get(u) : undefined
    fetch(u, tag ? { headers: { 'If-None-Match': tag } } : undefined).then(async r => {
      if (r.status === 304) {
        if (!memCache.has(u)) { etags.delete(u); load(); return } // evicted meanwhile: fetch it whole
        if (urlRef.current === u) { setData(memCache.get(u)); setDataUrl(u); setError(null) }
        return
      }
      const d = await r.json().catch(() => ({ error: `auto-m8 answered ${r.status}` }))
      const etag = r.ok ? r.headers.get('ETag') : null
      etags.delete(u)
      if (etag && !(d && typeof d === 'object' && 'error' in d)) {
        memCache.set(u, d); etags.set(u, etag)
        // Bounded: bodies too big for localStorage (long threads) live only here.
        for (const old of etags.keys()) { if (etags.size <= CACHE_MAX_ENTRIES) break; etags.delete(old); memCache.delete(old) }
      }
      if (urlRef.current !== u) return
      if (!r.ok || (d && typeof d === 'object' && 'error' in d && Object.keys(d).length <= 3)) setError((d as any).error ?? `auto-m8 answered ${r.status}`) // keep the last good data
      else { setData(d); setDataUrl(u); setError(null); cachePut(u, d) }
    }).catch(() => {
      // Ride out a restart quietly (keep the last data); only a long gap is worth showing.
      noteDown()
      if (perchDownFor() > OUTAGE_TOAST_MS) setError('auto-m8 isn’t reachable right now; reconnecting.')
      waitForPerch().then(ok => { if (ok && urlRef.current === u) load() })
    }).finally(() => setInFlight(n => n - 1))
  }, [])
  useEffect(() => { const c = cacheGet(url); if (c !== undefined) { setData(c); setDataUrl(url) } else if (!keep || dataUrl === null) setData(initial); load() }, [url]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let t: any
    const debounced = () => { clearTimeout(t); t = setTimeout(load, 250) }
    const offs = topics.map(tp => onTopic(tp, debounced))
    return () => { offs.forEach(o => o()); clearTimeout(t) }
  }, [topics.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!poll) return
    const tick = () => { if (document.visibilityState === 'visible') load() }
    const i = setInterval(tick, poll)
    document.addEventListener('visibilitychange', tick)
    window.addEventListener('focus', tick)
    return () => { clearInterval(i); document.removeEventListener('visibilitychange', tick); window.removeEventListener('focus', tick) }
  }, [poll, load])
  // loading: a request is in flight (a poll or a filter change). stale: the data on screen is for a different url.
  return { data, error, reload: load, loading: inFlight > 0, stale: data !== undefined && dataUrl !== url }
}

export function ago(ts: number | null | undefined) {
  if (!ts) return ''
  const s = (Date.now() - ts) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export const titleOf = (c: Pick<Conversation, 'title' | 'first_prompt'>) => c.title || c.first_prompt || 'Untitled'
export const shortPath = (p?: string | null) => (p ? p.replace(/^\/Users\/[^/]+/, '~') : '')
export const baseName = (p?: string | null) => (p ? p.split('/').filter(Boolean).pop() ?? p : '')

// The Electron shell exposes a few window controls; in a browser they are absent.
export const shell: { switchProfile?: (id: string) => Promise<string>; mini?: (on: boolean) => Promise<'mini' | 'restored' | 'none'>; miniSize?: (s: 'pill' | 'card' | 'panel') => Promise<string>; onMiniSize?: (cb: (s: 'pill' | 'card' | 'panel' | 'none') => void) => () => void; tuck?: (on: boolean) => Promise<'tucked' | 'restored' | 'none'>; isElectron?: boolean; pin?: (on: boolean) => Promise<boolean>; preset?: (n: string) => void; buttons?: (on: boolean) => void; isPinned?: () => Promise<boolean>; theme?: (t: string) => void; badge?: (text: string) => void } =
  (window as any).perch ?? {}

export const STATES: { id: State; label: string; hint: string }[] = [
  { id: 'running', label: 'Running', hint: 'An agent is working on it right now' },
  { id: 'waiting', label: 'Waiting chat', hint: 'A chat marked waiting or returned from snooze; Needs me tracks verified human actions' },
  { id: 'active', label: 'Active', hint: 'Touched in the last few days' },
  { id: 'later', label: 'Later', hint: 'Snoozed: out of the way until it comes back' },
  { id: 'idle', label: 'Idle', hint: 'No activity for 4+ days' },
  { id: 'done', label: 'Done', hint: 'Finished, or every PR it opened is merged or closed' },
  { id: 'archived', label: 'Archived', hint: 'Out of the lists, still found by search' },
  { id: 'hidden', label: 'Hidden', hint: 'Gone for good: not in lists, search or suggestions' },
]

// Where a conversation can be opened: links open here (works on a phone too), apps open on the Mac.
export type OpenTarget = { target: string; label: string; href?: string }
export async function openTargets(id: string) { return (await api.get<{ targets: OpenTarget[] }>(`/api/conversations/${encodeURIComponent(id)}/open`)).targets }
export function openIn(id: string, t: OpenTarget) {
  if (t.href && !shell.isElectron) return window.open(t.href, '_blank')
  return post(`/api/conversations/${encodeURIComponent(id)}/open`, { target: t.target })
}

export const isDarkTheme = () => {
  const t = document.documentElement.dataset.theme
  return t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
}

export function streamSSE(path: string, body: unknown, onEvent: (ev: any) => void): () => void {
  const ctl = new AbortController()
  fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal }).then(async res => {
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i).replace(/^data: /, '')
        buf = buf.slice(i + 2)
        try { onEvent(JSON.parse(chunk)) } catch {}
      }
    }
  }).catch(() => {})
  return () => ctl.abort()
}

// "0 16 * * 5" → "Fridays at 16:00". Covers the shapes perch and autopilot write; anything
// stranger falls back to the raw expression rather than guessing.
const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
export function humanCron(cron: string | null | undefined): string {
  if (!cron) return ''
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5) return cron
  const [m, h, dom, mon, dow] = f
  const num = (s: string) => /^\d+$/.test(s)
  if (mon !== '*') return cron
  let day: string | null = null
  if (dom === '*' && dow === '*') day = 'every day'
  else if (dom === '*' && (dow === '1-5' || dow === 'MON-FRI')) day = 'weekdays'
  else if (dom === '*' && (dow === '0,6' || dow === '6,0')) day = 'weekends'
  else if (dom === '*' && /^[0-7](,[0-7])*$/.test(dow)) day = dow.split(',').map(d => DAYS[Number(d) % 7]).join(', ').replace(/, ([^,]*)$/, ' and $1')
  else if (num(dom) && dow === '*') day = `monthly on day ${dom}`
  if (!day) return cron
  const every = (s: string) => s.match(/^\*\/(\d+)$/)?.[1]
  if (every(m) && h === '*') return `every ${every(m)} minutes${day === 'every day' ? '' : `, ${day}`}`
  if (num(m) && h === '*') return `every hour${m !== '0' ? ` at :${m.padStart(2, '0')}` : ''}${day === 'every day' ? '' : `, ${day}`}`
  if (num(m) && every(h)) return `every ${every(h)} hours${day === 'every day' ? '' : `, ${day}`}`
  const at = (hh: string) => `${hh.padStart(2, '0')}:${m.padStart(2, '0')}`
  if (num(m) && /^\d+(,\d+)*$/.test(h)) {
    const times = h.split(',').map(at).join(' and ')
    return day === 'every day' ? `daily at ${times}` : `${day} at ${times}`
  }
  if (num(m) && /^\d+-\d+$/.test(h)) { const [a, b] = h.split('-'); return `hourly ${a.padStart(2, '0')}:${m.padStart(2, '0')}–${b.padStart(2, '0')}:${m.padStart(2, '0')}${day === 'every day' ? '' : `, ${day}`}` }
  return cron
}

// Labels still drive search (#label), folders and rules; they're just not shown for now.
export const SHOW_LABELS = false
