// The activity panel under a chat's live browser view: spans for what the agent does in its window
// (tool calls, the steps inside them) and for what the page does back (failed, erroring or slow
// requests), plus events (page changes, dialogs, takeovers). Each entry can carry details for its
// expanded row and a concern: something an attentive watcher would flag, said in plain words.
// In memory only, per window; a restart starts a fresh panel.

export type FeedLevel = 'ok' | 'warn' | 'bad'
export type FeedItem = {
  id: string
  at: number // start
  kind: 'tool' | 'step' | 'nav' | 'net' | 'note'
  text: string
  level?: FeedLevel
  ms?: number // duration; absent while running or for instant events
  running?: boolean
  concern?: string
  error?: string // one line, shown under the label when it failed
  req?: string // a page request's id in the window: its headers and body load when the row opens
  links?: { label: string; url: string }[] // e.g. the request's backend logs
  detail?: Record<string, string>
  children?: FeedItem[]
}

const feeds = new Map<string, FeedItem[]>()
export const feedListeners = new Set<(owner: string, item: FeedItem) => void>()
let seq = 0
const MAX = 150

const clip = (t: string, n = 240) => t.length > n ? t.slice(0, n - 1) + '…' : t

// Add an entry (or replace one with the same id) and tell the live views.
export function feed(owner: string, item: Omit<FeedItem, 'id' | 'at'> & { id?: string; at?: number }): FeedItem {
  const it: FeedItem = { ...item, id: item.id ?? `f${++seq}`, at: item.at ?? Date.now(), text: clip(item.text) }
  if (it.ms != null && !it.running && !it.concern) it.concern = concernFor(owner, it)
  const list = feeds.get(owner) ?? []
  const i = list.findIndex(x => x.id === it.id)
  if (i >= 0) list[i] = it; else list.push(it)
  if (list.length > MAX) list.splice(0, list.length - MAX)
  feeds.set(owner, list)
  feedListeners.forEach(f => { try { f(owner, it) } catch {} })
  return it
}
export const feedFor = (owner: string) => feeds.get(owner) ?? []
export const clearFeed = (owner: string) => { feeds.delete(owner) }

// ---------- concerns ----------
// What "surprisingly long" means: a usual ceiling per kind of work, and how this exact thing (same
// action on the same host) went earlier in this window. Either one can raise a concern.
export const EXPECT_MS: Record<string, number> = {
  open: 8000, snapshot: 3000, look: 3000, screenshot: 4000, read: 3000, fetch: 8000, eval: 3000,
  act: 10000, replay: 8000, overlay: 6000,
  step: 3000, 'step:navigate': 8000,
  'net:Document': 6000, 'net:XHR': 3000, 'net:Fetch': 3000,
}
const fmt = (ms: number) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
// The key that groups "the same thing": kind, action and host, e.g. "tool:fetch:us.posthog.com".
export const keyOf = (it: Pick<FeedItem, 'kind' | 'detail' | 'text'>) => `${it.kind}:${it.detail?.action ?? it.detail?.type ?? ''}:${it.detail?.host ?? ''}`
const expectFor = (it: FeedItem) => {
  const d = it.detail ?? {}
  if (it.kind === 'tool') return EXPECT_MS[d.action ?? ''] ?? 5000
  if (it.kind === 'step') return EXPECT_MS[`step:${d.action ?? ''}`] ?? (d.action === 'wait' ? Infinity : EXPECT_MS.step)
  if (it.kind === 'net') return EXPECT_MS[`net:${d.type ?? ''}`] ?? 5000
  return Infinity
}
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }

export function concernFor(owner: string, it: FeedItem, history: FeedItem[] = feedFor(owner)): string | undefined {
  const key = keyOf(it)
  const same = history.filter(x => x.id !== it.id && keyOf(x) === key && !x.running)
  // Failing again and again: worth saying even when each failure is quick.
  if (it.level === 'bad') {
    let n = 1
    for (let i = history.length - 1; i >= 0 && n < 5; i--) { const x = history[i]; if (x.id === it.id || x.running) continue; if (keyOf(x) !== key) continue; if (x.level === 'bad') n++; else break }
    if (n >= 3) return `Failed ${n} times in a row`
  }
  if (it.ms == null) return
  const prior = same.map(x => x.ms).filter((m): m is number => m != null && m > 0)
  if (prior.length >= 3) {
    const m = median(prior)
    const x = it.ms / m
    if (x > 3 && it.ms - m > 1500) return `${fmt(it.ms)}: ${x > 20 ? 'much' : `${Math.round(x)}×`} slower than usual here (usually ${fmt(m)})`
  }
  const exp = expectFor(it)
  if (it.ms > exp) return `${fmt(it.ms)}: longer than expected (usually under ${fmt(exp)})`
}
