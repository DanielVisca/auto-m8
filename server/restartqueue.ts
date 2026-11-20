// Coalesced restarts. Agents restart perch to load new server code; on 2026-11-16 that was 32 restarts
// in 6 hours (median 3.8s gap each, ~25 of them in four hours of overload). A request within WINDOW_MS of
// this server starting, or while one is already queued, joins one restart at the end of the window
// with every reason recorded. `now` (scripts/restart.sh --now) restarts at once, taking the queue along.
export const WINDOW_MS = 180_000
type Opts = { windowMs?: number; uptimeMs?: () => number; clock?: () => number; restart: (reason: string) => void; timer?: (f: () => void, ms: number) => unknown; cancel?: (t: unknown) => void }
export type RestartReply = { queued: true; at: number; reasons: number } | { queued: false; reason: string }

export function restartQueue(o: Opts) {
  const windowMs = o.windowMs ?? WINDOW_MS, uptime = o.uptimeMs ?? (() => performance.now()), clock = o.clock ?? Date.now
  const timer = o.timer ?? ((f, ms) => setTimeout(f, ms)), cancel = o.cancel ?? (t => clearTimeout(t as any))
  let q: { at: number; reasons: string[]; t: unknown } | null = null
  const take = (reason?: string) => { const all = [...(q?.reasons ?? []), ...(reason ? [reason] : [])]; if (q) cancel(q.t); q = null; return all.join(' · ') }
  return {
    request(reason: string, now = false): RestartReply {
      if (!now && (q || uptime() < windowMs)) {
        if (!q) { const at = clock() + Math.max(0, windowMs - uptime()); q = { at, reasons: [], t: timer(() => o.restart(take()), at - clock()) } }
        if (!q.reasons.includes(reason)) q.reasons.push(reason)
        return { queued: true, at: q.at, reasons: q.reasons.length }
      }
      return { queued: false, reason: take(reason) }
    },
    pending: () => q ? { at: q.at, reasons: [...q.reasons] } : null,
  }
}
