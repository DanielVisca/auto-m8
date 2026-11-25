// Availability: every time the app couldn't reach perch, how long for, and why. "perch isn't
// reachable right now" was a mystery; on 2026-11-12 server.log showed 36 restarts in one evening,
// nearly all agents killing the server to load their new code. This keeps the evidence in one
// place (Settings → Health) so the top cause can be fixed instead of guessed at.
//
// Rows:
//   stop    this server is stopping: the signal or the reason given (ms = how long it had been up)
//   boot    a server started: ms = time to listening; cause = how the last one ended
//   stall   the event loop was blocked (ms), so every request and the health check waited
//   outage  the page couldn't reach perch for ms; cause = restart | frozen | unreachable
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { db, run, all, get } from './db.ts'
import { DATA_DIR } from './settings.ts'

db.exec(`create table if not exists availability (id integer primary key, at integer, kind text, ms integer, cause text, detail text, pid integer)`)
db.exec(`create index if not exists availability_at on availability(at)`)

// Whoever restarts perch on purpose (the app's menu, the shell after a hang, scripts/restart.sh)
// leaves one line here first; the next boot reads it as the reason.
export const REASON_FILE = join(DATA_DIR, 'restart-reason')

export function recordAvailability(kind: string, ms: number, cause: string, detail = '') {
  try { run('insert into availability (at, kind, ms, cause, detail, pid) values (?, ?, ?, ?, ?, ?)', Date.now(), kind, Math.round(ms), cause, detail.slice(0, 500), process.pid) } catch {}
}

// Called synchronously from the signal handler, so the row lands before the process goes.
export function noteStop(cause: string) {
  let reason = ''
  try { reason = readFileSync(REASON_FILE, 'utf8').trim() } catch {}
  recordAvailability('stop', performance.now(), cause, reason)
}

// How the previous server ended: its own stop row, or nothing at all (a crash, SIGKILL, or frozen
// and killed by the shell, which can't run handlers).
export function noteBoot(readyMs: number, split = '') {
  let reason = ''
  try { reason = readFileSync(REASON_FILE, 'utf8').trim(); rmSync(REASON_FILE) } catch {}
  const last = get<any>(`select kind, cause, detail, at from availability where kind in ('stop', 'boot') order by id desc limit 1`)
  const how = last?.kind === 'stop'
    ? (reason || last.detail ? `${last.cause}: ${reason || last.detail}` : `${last.cause} from another process (usually an agent restarting auto-m8 for new code)`)
    : last ? `died without stopping (crash, SIGKILL, or frozen)${reason ? `: ${reason}` : ''}` : 'first start'
  recordAvailability('boot', readyMs, how, split)
  console.log(`[boot] listening ${Math.round(readyMs)}ms after start (${split}); last server: ${how}`)
}

// The page tells us about each gap it saw. Same pid before and after: perch never restarted, so it
// was frozen (stall rows say by what) or the connection itself dropped.
export function noteOutage(b: { ms?: number; fromPid?: number; toPid?: number; slept?: boolean }) {
  const ms = Math.max(0, Math.min(Number(b.ms) || 0, 7 * 86400_000))
  if (ms < 300) return { ok: true }
  if (b.slept) return recordAvailability('outage', ms, 'mac-asleep'), { ok: true }
  const restarted = b.fromPid && b.toPid && b.fromPid !== b.toPid
  if (restarted) {
    const boot = get<any>(`select cause from availability where kind = 'boot' and pid = ? order by id desc limit 1`, b.toPid)
    recordAvailability('outage', ms, 'restart', boot?.cause ?? '')
  } else {
    const stall = get<any>(`select max(ms) ms from availability where kind = 'stall' and at >= ?`, Date.now() - ms - 5000)
    recordAvailability('outage', ms, stall?.ms ? 'frozen' : 'unreachable', stall?.ms ? `event loop blocked up to ${stall.ms}ms` : '')
  }
  return { ok: true }
}

export function availability(hours = 24) {
  const since = Date.now() - hours * 3600_000
  const rows = all<any>(`select at, kind, ms, cause, detail, pid from availability where at >= ? order by id desc limit 400`, since)
  const outages = rows.filter(r => r.kind === 'outage' && r.cause !== 'mac-asleep')
  const boots = rows.filter(r => r.kind === 'boot')
  const byCause: Record<string, number> = {}
  // Plain causes: "SIGTERM: <commit>" is scripts/restart.sh shipping new code; "from another process" is an agent killing it.
  const plain = (c: string) => /from another process/.test(c) ? 'killed by an agent or script' : /^SIGTERM:/.test(c) ? 'restarted to load new code' : c.replace(/:.*/, '')
  for (const b of boots) { const k = plain(b.cause); byCause[k] = (byCause[k] ?? 0) + 1 }
  // One bucket per hour, oldest first, for the uptime strip. Straight from SQL so the 400-row cap above doesn't clip it.
  const start = Math.floor(since / 3600_000) * 3600_000
  const hourly = Array.from({ length: hours + 1 }, (_, i) => ({ at: start + i * 3600_000, outages: 0, downMs: 0, restarts: 0 }))
  for (const r of all<any>(`select cast((at - ?) / 3600000 as integer) h, kind, count(*) n, sum(ms) ms from availability where at >= ? and (kind = 'boot' or (kind = 'outage' and cause != 'mac-asleep')) group by 1, 2`, start, since)) {
    const b = hourly[r.h]; if (!b) continue
    if (r.kind === 'boot') b.restarts = r.n; else { b.outages = r.n; b.downMs = r.ms }
  }
  return {
    hours,
    outages: outages.length,
    downMs: outages.reduce((s, r) => s + r.ms, 0),
    restarts: boots.length,
    byCause,
    stalls: rows.filter(r => r.kind === 'stall').length,
    bootMs: boots.length ? Math.round(boots.reduce((s, r) => s + r.ms, 0) / boots.length) : null,
    recent: rows.filter(r => r.kind === 'outage' || r.kind === 'boot').slice(0, 15),
    hourly,
  }
}

// Keep a month.
setInterval(() => { try { run('delete from availability where at < ?', Date.now() - 30 * 86400_000) } catch {} }, 6 * 3600_000).unref()

// For scripts/restart.sh and the shell.
export const writeReason = (r: string) => { try { writeFileSync(REASON_FILE, r) } catch {} }
