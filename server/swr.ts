// Stale-while-revalidate for slow, read-only lookups (argocd, Grafana, PostHog, git across every repo).
// Why: the app window has only 6 connections to auto-m8. A request that waits 45s on `argocd app list` holds
// one of them, and a few of those queue everything else (opening a doc waited seconds behind them).
// So a slow lookup never holds a connection for long:
//   - fresh value: answered from memory.
//   - expired value: answered at once with the old value; one refresh runs in the background.
//   - nothing yet: waits up to `deadline` ms, then answers { pending: true } while the work carries on.
//     The client asks again shortly (each ask returns at once) until the value is there.
// Values are also written to disk, so a restart (frequent here) starts warm instead of cold.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export type Pending = { pending: true; since: number }
type Entry<T> = { at: number; v?: T; running?: Promise<T>; started?: number }

const mem = new Map<string, Entry<any>>()
let DIR: string | null = process.env.PERCH_DATA ? join(process.env.PERCH_DATA, 'swr') : null
export function setSwrDir(d: string | null) { DIR = d; if (d) mkdirSync(d, { recursive: true }) }
const fileOf = (key: string) => DIR && join(DIR, createHash('sha1').update(key).digest('hex').slice(0, 20) + '.json')
const MAX = 400

// Errors are answers too (shown in the panel) but never kept: the next ask tries again.
const isError = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) && 'error' in (v as any) && Object.keys(v as any).length <= 3

function load<T>(key: string): Entry<T> | undefined {
  const m = mem.get(key)
  if (m) return m
  const f = fileOf(key)
  if (!f || !existsSync(f)) return undefined
  try { const d = JSON.parse(readFileSync(f, 'utf8')); if (d?.key !== key) return undefined; const e = { at: d.at, v: d.v }; mem.set(key, e); return e } catch { return undefined }
}

function refresh<T>(key: string, e: Entry<T>, f: () => Promise<T>, persist: boolean): Promise<T> {
  if (e.running) return e.running
  e.started = Date.now()
  e.running = f().then(v => {
    if (!isError(v)) {
      e.v = v; e.at = Date.now()
      const file = persist && fileOf(key)
      if (file) try { writeFileSync(file, JSON.stringify({ key, at: e.at, v })) } catch {}
    } else if (e.v === undefined) e.v = v // nothing better to show yet; replaced by the next good answer
    return v
  }).finally(() => { e.running = undefined; if (e.v !== undefined && isError(e.v)) e.at = 0 })
  e.running.catch(() => {})
  return e.running
}

export async function swr<T>(key: string, ttl: number, f: () => Promise<T>, opts: { deadline?: number; persist?: boolean } = {}): Promise<T | Pending> {
  const persist = opts.persist ?? true
  let e = load<T>(key)
  if (!e) { e = { at: 0 }; mem.set(key, e); while (mem.size > MAX) mem.delete(mem.keys().next().value!) }
  const fresh = e.v !== undefined && !isError(e.v) && Date.now() - e.at < ttl
  if (fresh) return e.v as T
  const p = refresh(key, e, f, persist)
  if (e.v !== undefined && !isError(e.v)) return e.v as T // stale: answer now, the refresh lands for the next ask
  const deadline = opts.deadline ?? 1200
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<Pending>(res => { timer = setTimeout(() => res({ pending: true, since: e!.started ?? Date.now() }), deadline) })
  try { return await Promise.race([p, late]) } catch (err) { return { error: String((err as any)?.message ?? err) } as any } finally { clearTimeout(timer) }
}

// For tests.
export function _resetSwr() { mem.clear() }
