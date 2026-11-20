// Which idle agent processes to stop. Each idle `claude -p` keeps its MCP servers alive too
// (chrome-devtools, grafana, mcp-remote, python MCPs): roughly 300-400 MB per chat. On 2026-11-17
// 35-56 of them piled up, swap reached 16 of 19 GB and the server stalled 3-14s at a time, which
// showed up as chats opening blank. Three guards, so one failing (like the idle clock being reset by
// every restart, the cause that day) can't let them pile up again:
//  1. idle longer than the limit (settings.chat.idleMinutes)
//  2. more than MAX_IDLE idle processes: stop the least recently used beyond that
//  3. the Mac is short of memory or overloaded: stop anything idle a couple of minutes
// A chat someone has open (a listener), and a protected one (protection.ts: a scout, or work pending
// in its process), is never stopped by any rule and doesn't count toward the cap. The next message resumes a stopped chat.
export type IdleProc = { id: string; idleMs: number; watched: boolean; protectedWhy?: string | null }
export type Machine = { availBytes: number; load1: number; cores: number } | null | undefined

const GB = 1024 ** 3
export const MAX_IDLE = 8
export const GRACE_MS = 2 * 60_000

export const strained = (m: Machine) => !!m && (m.availBytes < 3 * GB || m.load1 > m.cores * 2)

export function toStop(idle: IdleProc[], opts: { limitMs: number; machine?: Machine; maxIdle?: number }): { id: string; why: string }[] {
  const max = opts.maxIdle ?? MAX_IDLE
  const out = new Map<string, string>()
  const stoppable = idle.filter(p => !p.watched && !p.protectedWhy)
  for (const p of stoppable) if (p.idleMs > opts.limitMs) out.set(p.id, 'idle limit')
  if (strained(opts.machine)) for (const p of stoppable) if (p.idleMs > GRACE_MS && !out.has(p.id)) out.set(p.id, 'machine under pressure')
  // Over the cap: oldest first, counting what's already being stopped and what can't be.
  let left = idle.filter(p => !p.protectedWhy).length - out.size
  for (const p of [...stoppable].sort((a, b) => b.idleMs - a.idleMs)) {
    if (left <= max) break
    if (out.has(p.id) || p.idleMs <= GRACE_MS) continue
    out.set(p.id, `over ${max} idle agents`); left--
  }
  return [...out].map(([id, why]) => ({ id, why }))
}
