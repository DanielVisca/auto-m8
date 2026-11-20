// A stalled agent (died mid tool call, stopped after a tool result, ended on an API error, never answered)
// is the agent's to pick back up, not a "Needs me" for the human. Every sweep this sends each recently
// stalled chat of yours one nudge to carry on, at most MAX_PER_DAY times a day so a chat that keeps dying
// can't loop. If it can't get unstuck it says so, and the attention judge decides whether you're needed.
import { send } from './chat.ts'
import { all, get, run } from './db.ts'
import { ownerName } from './owner.ts'

run(`create table if not exists stall_resumes (id text not null, updated_at integer not null, at integer not null, primary key (id, updated_at))`)

const QUIET = 5 * 60_000
const WINDOW = 86400_000
const MAX_PER_DAY = 2

type Row = { id: string; source: string; stall?: string | null; updated_at: number; effective: string; agent_kind?: string | null }

export function resumeStalls(rows: Row[], now = Date.now(), sendFn: typeof send = send): string[] {
  const done: string[] = []
  for (const r of rows) {
    if (!r.stall || r.source !== 'claude' || r.effective === 'running' || ['done', 'archived', 'hidden', 'later'].includes(r.effective)) continue
    if (r.agent_kind && r.agent_kind !== 'helper') continue // shepherds, routines, autopilot: perch wakes those itself
    if (r.updated_at > now - QUIET || r.updated_at < now - WINDOW) continue
    if (get<any>('select 1 from stall_resumes where id = ? and updated_at = ?', r.id, r.updated_at)) continue
    if ((get<any>('select count(*) n from stall_resumes where id = ? and at > ?', r.id, now - WINDOW)?.n ?? 0) >= MAX_PER_DAY) continue
    run('insert into stall_resumes (id, updated_at, at) values (?, ?, ?)', r.id, r.updated_at, now)
    try {
      sendFn({ id: r.id, by: 'perch', prompt: `This chat stalled (${r.stall}) and nobody else will pick it up. This is an instruction, not a notification: resume the task you were working on, finish it including its checks, and reply with the result. If something only ${ownerName()} can do blocks you, say exactly what in one line and stop.` })
      done.push(r.id)
    } catch (e) { console.error('resume stall', r.id, e) }
  }
  return done
}
