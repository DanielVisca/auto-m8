// Prompts that run on a schedule or when a webhook arrives. They run on this machine, so a
// schedule only fires while the laptop is awake; for always-on work, send it to a PostHog scout.
import { randomBytes, randomUUID } from 'node:crypto'
import { all, get, run } from './db.ts'
import { send } from './chat.ts'
import { link } from './context.ts'
import { trackRun } from './autopilot.ts'
import { recordOrigin } from './origin.ts'
import { isPaused } from './pausehold.ts'

export type Routine = {
  id: string; name: string; prompt: string; cwd: string; cron: string | null; webhook_secret: string | null
  conversation_id: string | null; mode: 'resume' | 'fresh'; enabled: number; last_run_at: number | null; last_status: string | null
  created_at?: number | null
}

// Five-field cron (minute hour day-of-month month day-of-week) with *, lists, ranges and steps.
export function cronMatches(expr: string, d: Date): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const values = [d.getMinutes(), d.getHours(), d.getDate(), d.getMonth() + 1, d.getDay()]
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
  return fields.every((f, i) => f.split(',').some(part => {
    const [range, stepStr] = part.split('/')
    const step = stepStr ? Number(stepStr) : 1
    let [lo, hi] = range === '*' ? ranges[i] : range.split('-').map(Number)
    hi ??= stepStr ? ranges[i][1] : lo
    const v = i === 4 && values[i] === 0 && lo === 7 ? 7 : values[i] // Sunday is 0 or 7
    return v >= lo && v <= hi && (v - lo) % step === 0
  }))
}

// The latest minute at or before `now`, within `lookbackMin`, that the schedule wanted a run.
export function lastDue(expr: string, now: Date, lookbackMin = CATCH_UP_MIN): Date | null {
  const start = Math.floor(now.getTime() / 60_000) * 60_000
  for (let i = 0; i <= lookbackMin; i++) {
    const d = new Date(start - i * 60_000)
    if (cronMatches(expr, d)) return d
  }
  return null
}

// A slot missed while perch was restarting or the laptop slept still runs once, if it is at most
// this old. Older slots are dropped: a 09:00 report is not worth running at 17:00.
const CATCH_UP_MIN = 6 * 60

// Due when the latest scheduled slot came after the routine's last run (or its creation, so a
// new routine doesn't fire for a slot from before it existed).
export function isDue(r: Pick<Routine, 'enabled' | 'cron' | 'last_run_at'> & { created_at?: number | null }, now: Date) {
  if (!r.enabled || !r.cron) return false
  const due = lastDue(r.cron, now)
  return !!due && due.getTime() > (r.last_run_at ?? r.created_at ?? 0)
}

export function listRoutines() {
  return all<Routine>('select * from routines order by created_at desc')
}

export function saveRoutine(r: Partial<Routine>) {
  const id = r.id ?? randomUUID()
  const existing = get<Routine>('select * from routines where id = ?', id)
  const v = { ...existing, ...r, id } as Routine
  run(`insert into routines (id, name, prompt, cwd, cron, webhook_secret, conversation_id, mode, enabled, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set name = excluded.name, prompt = excluded.prompt, cwd = excluded.cwd, cron = excluded.cron,
         conversation_id = excluded.conversation_id, mode = excluded.mode, enabled = excluded.enabled`,
    id, v.name ?? 'Routine', v.prompt ?? '', v.cwd ?? null, v.cron || null, existing?.webhook_secret ?? randomBytes(16).toString('hex'),
    v.conversation_id ?? null, v.mode ?? 'resume', v.enabled ?? 1, existing ? (existing as any).created_at : Date.now())
  return get<Routine>('select * from routines where id = ?', id)!
}

export function deleteRoutine(id: string) { run('delete from routines where id = ?', id) }

export function fire(r: Routine, payload?: unknown, manual = false) {
  const prompt = payload === undefined ? r.prompt : `${r.prompt}\n\n<webhook-payload>\n${JSON.stringify(payload, null, 2).slice(0, 20000)}\n</webhook-payload>`
  try {
    const resumeId = r.mode === 'resume' ? r.conversation_id ?? undefined : undefined
    recordOrigin(`routine:${r.id}`, { kind: 'routine', label: r.name, evidence: 'routine configured in this auto-m8 profile' })
    const id = send({ manual, by: 'routine', originParent: `routine:${r.id}`, id: resumeId, cwd: r.cwd || undefined, prompt, context: true })
    trackRun(r.id, id) // autopilot follows every run to its end
    if (r.mode === 'resume' && !r.conversation_id) run('update routines set conversation_id = ? where id = ?', id, r.id)
    if (r.mode === 'fresh' && r.conversation_id) link(id, r.conversation_id, 'continues', `routine ${r.name}`)
    run('update routines set last_run_at = ?, last_status = ? where id = ?', Date.now(), 'started', r.id)
    return id
  } catch (e: any) {
    run('update routines set last_run_at = ?, last_status = ? where id = ?', Date.now(), `error: ${e.message}`, r.id)
    throw e
  }
}

export function startScheduler() {
  let lastMinute = -1
  setInterval(() => {
    if (isPaused()) return // paused: slots missed meanwhile run once on resume if still recent
    const now = new Date()
    const minute = Math.floor(now.getTime() / 60_000)
    if (minute === lastMinute) return
    lastMinute = minute
    for (const r of listRoutines()) if (isDue(r, now)) {
      try { fire(r) } catch (e) { console.error('[routine]', r.name, e) }
    }
  }, 10_000).unref()
}
