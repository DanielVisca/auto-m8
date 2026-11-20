// The "Waiting" card under a turn: what the agent left running when it stopped (background
// agents, commands, workflows) and the timers it set (perch follow-ups, wakeups), whether each
// wait is still live or over, and why it's waiting. Click it for the list.
import { useEffect, useId, useState } from 'react'
import { waitsOf, type Wait } from '../../shared/waits.ts'
import { shortDuration, type Entry } from './chatActivity'

export type PromiseRow = { id: string; text: string; due_at: number | null; pr_url: string | null; until: string | null; status: string; note: string | null; nudged_at: number | null; created_at: number }

// No word back from a background task for this long: the session that ran it is likely gone.
const LOST_MS = 12 * 3600_000

type Row = { wait: Wait; live: boolean; status: string; detail?: string; bad?: boolean }

const norm = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 400)
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const WHAT = { agent: 'Background agent', command: 'Background command', workflow: 'Workflow', 'follow-up': 'Mothership follow-up', wakeup: 'Wakeup timer' } as const
const ICON = { agent: '🤖', command: '⌘', workflow: '⚙', 'follow-up': '⏰', wakeup: '⏰' } as const

function rowOf(w: Wait, now: number, promises: PromiseRow[]): Row {
  if (w.kind === 'task') {
    if (w.state === 'live') {
      const age = w.startedAt ? now - w.startedAt : 0
      if (age > LOST_MS) return { wait: w, live: false, status: `no word back after ${shortDuration(age)}`, detail: 'The session that ran it probably ended before it finished.', bad: true }
      return { wait: w, live: true, status: w.startedAt ? `running ${shortDuration(age)}` : 'running' }
    }
    const ago = w.done?.at ? ` ${shortDuration(now - w.done.at)} ago` : ''
    return { wait: w, live: false, status: w.state === 'done' ? `finished${ago}` : `${w.done?.status ?? 'stopped'}${ago}`, detail: w.done?.summary, bad: w.state === 'failed' }
  }
  const cond = w.prUrl ? `when ${w.until} ${w.until === 'merged' ? 'happens' : 'finish'} on ${w.prUrl.replace(/^https:\/\/github\.com\//, '')}, or ` : ''
  const p = w.what === 'follow-up' ? [...promises].reverse().find(p => norm(p.text) === norm(w.label)) : undefined
  const due = p?.due_at ?? w.dueAt
  if (p) {
    if (p.nudged_at) return { wait: w, live: false, status: `fired ${clock(p.nudged_at)}`, detail: p.note ?? undefined }
    if (p.status === 'replaced') return { wait: w, live: false, status: 'replaced by a newer follow-up' }
    if (p.status === 'dropped') return { wait: w, live: false, status: 'cancelled' }
    if (p.status === 'kept' || p.status === 'settled') return { wait: w, live: false, status: 'done' }
    if (p.status === 'waiting') return { wait: w, live: true, status: 'due, still waiting on the PR', detail: p.note ?? undefined }
  }
  if (due && due > now) return { wait: w, live: true, status: `${cond}at ${clock(due)} (in ${shortDuration(due - now)})` }
  return { wait: w, live: false, status: due ? `fired ${clock(due)}` : 'over' }
}

// The waits a turn started: its tool calls, with when each was made.
export function turnWaits(entries: Entry[]): Wait[] {
  return waitsOf(entries.flatMap(({ item }) => item.kind === 'assistant' ? item.blocks.flatMap(b => b.type === 'tool' ? [{ block: b, ts: item.ts }] : []) : []))
}

export function WaitCard({ waits, promises }: { waits: Wait[]; promises: PromiseRow[] }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const [now, setNow] = useState(Date.now)
  const rows = waits.map(w => rowOf(w, now, promises))
  const live = rows.filter(r => r.live)
  // Tick while anything is live so countdowns and "running 4m" stay true.
  useEffect(() => { if (!live.length) return; const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t) }, [live.length])
  if (!rows.length) return null
  const tasks = live.filter(r => r.wait.kind === 'task'), timers = live.filter(r => r.wait.kind === 'timer')
  const nextDue = Math.min(...timers.map(r => (r.wait.kind === 'timer' && r.wait.dueAt) || Infinity))
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  const summary = live.length
    ? [tasks.length && plural(tasks.length, tasks.every(r => r.wait.kind === 'task' && r.wait.what === 'agent') ? 'background agent' : 'background task'),
       timers.length && (Number.isFinite(nextDue) ? `${timers.length > 1 ? plural(timers.length, 'timer') + ', next' : 'timer'} in ${shortDuration(Math.max(0, nextDue - now))}` : plural(timers.length, 'timer'))].filter(Boolean).join(' · ')
    : rows.some(r => r.bad) ? 'over · something didn’t finish' : `over · ${rows.length === 1 ? rows[0].status : plural(rows.length, 'wait') + ' done'}`
  return <div className={`msg wait-card ${live.length ? 'is-live' : 'is-past'}`}>
    <button className="wait-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(v => !v)}
      title={live.length ? 'The agent ended its turn but is waiting on these. It comes back when they finish.' : 'What this turn waited on'}>
      <span className={`wait-icon${live.length ? ' live' : ''}`} aria-hidden="true">{live.length ? '⏳' : rows.some(r => r.bad) ? '⚠' : '✓'}</span>
      <span className="work-title">{live.length ? 'Waiting' : 'Wait'}</span>
      <span className="work-meta">{summary}</span>
      <span className={`work-chevron${open ? ' open' : ''}`} aria-hidden="true">›</span>
    </button>
    <ul id={id} className="wait-list" hidden={!open}>
      {rows.map(r => <li key={r.wait.id} className={`wait-row${r.live ? ' live' : ''}${r.bad ? ' bad' : ''}`}>
        <span className="wait-kind" title={WHAT[r.wait.what]}>{ICON[r.wait.what]}</span>
        <div className="wait-main">
          <div className="wait-label">{r.wait.label}</div>
          <div className="wait-status"><span className={`dot ${r.live ? 'wait-live' : r.bad ? 'bad' : 'ok'}`} />{WHAT[r.wait.what]} · {r.status}</div>
          {r.detail && <div className="wait-detail">{r.detail}</div>}
        </div>
      </li>)}
    </ul>
  </div>
}
