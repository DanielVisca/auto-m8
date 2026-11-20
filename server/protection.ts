// Idle agents the reaper must leave alone: scouts, routines and shepherds, and any agent with work
// pending inside its own process. A ScheduleWakeup, a cron job or a background command / Monitor
// lives in the `claude -p` process; stop it and the schedule or the result is gone, and the next
// message doesn't bring it back. (Added after the reaper went live 2026-11-17: idle agents include
// our scouts and ongoing work, which must not break.)
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'

// Kinds perch itself starts and wakes. Helpers and searches report once and finish: not protected.
const FREE_KINDS = new Set(['helper', 'search', 'test'])
export const protectedKind = (kind: string | null | undefined) => !!kind && !FREE_KINDS.has(kind)

// Perch wakes these kinds itself with a resuming message, so their process only needs to stay up
// for a quick follow-up, not forever. On 2026-11-18, 37 of 73 idle agents were protected by kind
// alone (24 shepherds), swap hit 19 of 20 GB and macOS paused Chrome. So kind protection lapses
// after KIND_IDLE_MS and whenever the Mac is strained; pendingWork() still protects real in-process work.
export const KIND_IDLE_MS = 30 * 60_000
export const kindProtected = (kind: string | null | undefined, idleMs: number, strained: boolean) =>
  protectedKind(kind) && !strained && idleMs < KIND_IDLE_MS

const BACKGROUND_MS = 60 * 60_000 // a background job or Monitor counts for an hour after it started
const WAKEUP_GRACE_MS = 2 * 60_000

// Why this transcript tail says work is still pending, or null. Lines are Claude Code JSONL.
export function pendingWork(tail: string, now = Date.now()): string | null {
  let wakeUntil = 0, crons = 0, background = 0
  for (const line of tail.split('\n')) {
    if (!line.includes('"tool_use"')) continue
    if (!/ScheduleWakeup|CronCreate|CronDelete|"Monitor"|run_in_background/.test(line)) continue
    let d: any; try { d = JSON.parse(line) } catch { continue } // the first line of a tail may be cut
    const at = Date.parse(d.timestamp) || 0
    for (const b of Array.isArray(d.message?.content) ? d.message.content : []) {
      if (b?.type !== 'tool_use') continue
      if (b.name === 'ScheduleWakeup') wakeUntil = Math.max(wakeUntil, at + Number(b.input?.delaySeconds ?? 0) * 1000)
      else if (b.name === 'CronCreate') crons++
      else if (b.name === 'CronDelete') crons = Math.max(0, crons - 1)
      else if (b.name === 'Monitor' || b.input?.run_in_background === true) background = Math.max(background, at)
    }
  }
  if (wakeUntil + WAKEUP_GRACE_MS > now) return 'wakeup scheduled'
  if (crons > 0) return 'cron job'
  if (background && now - background < BACKGROUND_MS) return 'background job'
  return null
}

// Last 400 KB of a transcript: enough for the recent tool calls without reading a 50 MB file.
export function transcriptTail(path: string | null | undefined, bytes = 400_000): string {
  try {
    if (!path || !existsSync(path)) return ''
    const size = statSync(path).size, start = Math.max(0, size - bytes)
    const fd = openSync(path, 'r')
    try { const buf = Buffer.alloc(size - start); readSync(fd, buf, 0, buf.length, start); return buf.toString('utf8') } finally { closeSync(fd) }
  } catch { return '' }
}
