// What blocked the event loop. The stall logger only knows how long a stall was and which request
// came last, which is often just whatever arrived next; on 2026-11-14 stalls of 2-10s under load got
// a live server killed as hung three times and the cause was never on record. A sampling CPU
// profiler runs all the time (one sample per 10ms, negligible), restarted every 30s; when a stall
// over STALL_MS ends, the samples from inside it are summarised by self time into the stall row,
// and the profile is saved to <data>/hangs (open it in Chrome DevTools → Performance).
import { Session } from 'node:inspector'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './settings.ts'

const ROOT = `file://${join(import.meta.dirname, '..')}/`

export const STALL_MS = 3000
type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
export type Profile = { nodes: Node[]; startTime: number; endTime: number; samples: number[]; timeDeltas: number[] }

// Self time per function over the samples taken in the last `ms` of the profile, biggest first.
export function summarize(p: Profile, ms: number, top = 6): string {
  const byId = new Map(p.nodes.map(n => [n.id, n]))
  const from = p.endTime - ms * 1000
  const self = new Map<string, number>()
  let t = p.startTime, total = 0
  p.samples.forEach((id, i) => {
    t += p.timeDeltas[i] ?? 0
    if (t < from) return
    const f = byId.get(id)?.callFrame
    if (!f || f.functionName === '(idle)' || f.functionName === '(root)') return
    const where = f.url ? ` ${f.url.replace(ROOT, '').replace(/^file:\/\//, '')}:${f.lineNumber + 1}` : ''
    const k = `${f.functionName || '(anonymous)'}${where}`
    self.set(k, (self.get(k) ?? 0) + 1); total++
  })
  if (!total) return 'no samples (blocked outside JavaScript)'
  return [...self].sort((a, b) => b[1] - a[1]).filter(([, n]) => n / total >= 0.01).slice(0, top).map(([k, n]) => `${Math.round(100 * n / total)}% ${k}`).join(' · ')
}

let session: Session | null = null, lastSave = 0
const post = <T = any>(method: string, params?: object) => new Promise<T>((res, rej) => session!.post(method, params ?? {}, (e, r) => e ? rej(e) : res(r as T)))

export async function startStallProfiler(intervalUs = 10_000) {
  if (session || process.env.PERCH_STALL_PROFILER === '0') return
  session = new Session(); session.connect()
  await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: intervalUs }); await post('Profiler.start')
  setInterval(() => { restart().catch(() => {}) }, 30_000).unref() // keep each profile short
}
const restart = async () => { if (!session) return null; const { profile } = await post<{ profile: Profile }>('Profiler.stop'); await post('Profiler.start'); return profile }

// Called right after a stall ends: its samples are the newest in the running profile.
export async function explainStall(ms: number): Promise<string | null> {
  if (!session || ms < STALL_MS) return null
  const profile = await restart()
  if (!profile) return null
  const summary = summarize(profile, ms)
  if (Date.now() - lastSave > 60_000) {
    lastSave = Date.now()
    try {
      const dir = join(DATA_DIR, 'hangs'); mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `stall-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.round(ms)}ms.cpuprofile`), JSON.stringify(profile))
      const old = readdirSync(dir).filter(f => f.startsWith('stall-')).sort().slice(0, -20)
      for (const f of old) rmSync(join(dir, f), { force: true })
    } catch {}
  }
  return summary
}
