// The "Waiting" card under a turn: what the agent left running when it stopped (background
// agents, commands, workflows) and the timers it set (perch follow-ups, wakeups), whether each
// wait is still live or over, and why it's waiting. Click it for the list.
import { useEffect, useId, useState } from 'react'
import { waitsOf, type Wait } from '../../shared/waits.ts'
import { shortDuration, type Entry } from './chatActivity'
import { api } from './api'

export type PromiseRow = { id: string; text: string; due_at: number | null; pr_url: string | null; until: string | null; status: string; note: string | null; nudged_at: number | null; created_at: number }

// No word back from a background task for this long: the session that ran it is likely gone.
const LOST_MS = 12 * 3600_000

type Row = { wait: Wait; live: boolean; status: string; detail?: string; bad?: boolean }

const norm = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 400)
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const WHAT = { agent: 'Background agent', command: 'Background command', workflow: 'Workflow', 'follow-up': 'auto-m8 follow-up', wakeup: 'Wakeup timer' } as const
const ICON = { agent: '🤖', command: '⌘', workflow: '⚙', 'follow-up': '⏰', wakeup: '⏰' } as const

function rowOf(w: Wait, now: number, promises: PromiseRow[], exits: Record<string, { code: number; at: number }>): Row {
  if (w.kind === 'task') {
    const ex = w.state === 'live' ? exits[w.id] : undefined
    if (ex) return { wait: w, live: false, status: `${ex.code === 0 ? 'finished' : `exited with code ${ex.code}`} ${shortDuration(now - ex.at)} ago`, detail: 'Its log shows it ended; the completion notice never reached this chat.', bad: ex.code !== 0 }
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

type Progress = { marks: ('ok' | 'err' | 'repeat' | 'pending')[]; steps: number; errors: number; mood: 'smooth' | 'friction' | 'struggling'; why?: string; lastAt?: number }
const MOOD_LABEL = { smooth: 'Smooth', friction: 'Friction', struggling: 'Struggling' } as const

// The same bar and mood as the working card, for a background agent: one mark per tool call,
// the running one pulsing, and a dashed "more, unknown" mark while it's still going.
function AgentHealth({ p, live }: { p: Progress; live: boolean }) {
  if (!p.steps) return null
  const shown = p.marks.slice(-16)
  return <span className="work-health" title={`${p.steps} step${p.steps === 1 ? '' : 's'}${p.errors ? ` · ${p.errors} failed` : ''}${p.why ? ` · ${p.why}` : ''}`}>
    <span className="work-marks">
      {shown.map((m, i) => <i key={i} className={`mark-${m === 'pending' && !live ? 'ok' : m}`} />)}
      {live && <i className="mark-unknown" title="More may follow" />}
    </span>
    <span className={`work-mood mood-${p.mood}`} title={p.why}>{MOOD_LABEL[p.mood]}</span>
  </span>
}

type Step = { kind: 'text' | 'tool' | 'result' | 'prompt'; text: string; at?: string }
type Output =
  | { kind: 'log'; path: string; text: string; truncated: boolean; updatedAt: number; exitCode?: number }
  | { kind: 'transcript'; path: string; steps: Step[]; truncated: boolean; updatedAt: number; finished?: boolean; progress?: Progress }
  | { kind: 'workflow'; path: string; agents: { id: string; description: string; finished: boolean; last: string; updatedAt: number }[] }
  | { kind: 'missing'; path: string; reason: string }
  | { kind: 'error'; reason: string }

const STEP_ICON = { prompt: '✉', text: '💬', tool: '▸', result: '↳' } as const

// One wait opened up: what it was asked to do, and what it has written so far (refreshed while live).
function WaitDrill({ row }: { row: Row }) {
  const w = row.wait
  const [out, setOut] = useState<Output | null>(null)
  const path = w.kind === 'task' ? w.outputPath : undefined
  useEffect(() => {
    if (!path) return
    let stop = false
    const load = () => api.get<Output>(`/api/task-output?path=${encodeURIComponent(path)}`).then(o => { if (!stop) setOut(o) }).catch(e => { if (!stop) setOut({ kind: 'error', reason: String(e) }) })
    load()
    const t = row.live ? setInterval(load, 5000) : undefined
    return () => { stop = true; if (t) clearInterval(t) }
  }, [path, row.live])
  const pre = (t: string) => <pre className="wait-pre">{t}</pre>
  return <div className="wait-drill">
    {w.kind === 'task' && w.input && <><div className="wait-h">{w.what === 'agent' ? 'Prompt' : w.what === 'workflow' ? 'Workflow' : 'Command'} <span className="wait-tool">{w.tool}</span></div>{pre(w.input)}</>}
    {w.kind === 'timer' && <><div className="wait-h">Note</div>{pre(w.label)}{w.prUrl && <a href={w.prUrl} target="_blank" rel="noreferrer">{w.prUrl}</a>}</>}
    {w.kind === 'task' && w.done?.summary && <><div className="wait-h">Result</div>{pre(w.done.summary)}</>}
    {w.kind === 'task' && <>
      <div className="wait-h">Output{out && 'updatedAt' in out ? <span className="wait-tool"> updated {shortDuration(Date.now() - out.updatedAt)} ago</span> : null}{path && <span className="wait-tool" title={path}> · {path.split('/').slice(-2).join('/')}</span>}</div>
      {!path ? <div className="wait-detail">This task didn’t report an output file.</div>
        : !out ? <div className="wait-detail">Loading…</div>
        : out.kind === 'missing' || out.kind === 'error' ? <div className="wait-detail">{out.reason}</div>
        : out.kind === 'log' ? pre((out.truncated ? '…\n' : '') + (out.text.trim() || '(no output yet)'))
        : out.kind === 'transcript' ? <ol className="wait-steps">{out.truncated && <li className="wait-step">…earlier steps cut</li>}
            {out.steps.length ? out.steps.map((s, i) => <li key={i} className={`wait-step ${s.kind}`}><span aria-hidden="true">{STEP_ICON[s.kind]}</span><span>{s.text}</span></li>) : <li className="wait-step">(nothing yet)</li>}</ol>
        : <ul className="wait-steps">{out.agents.length ? out.agents.map(a => <li key={a.id} className="wait-step"><span className={`dot ${a.finished ? 'ok' : 'wait-live'}`} /><span><b>{a.description}</b>{a.last && <> — {a.last}</>}</span></li>) : <li className="wait-step">(no agents yet)</li>}</ul>}
    </>}
  </div>
}

export function WaitCard({ waits, promises }: { waits: Wait[]; promises: PromiseRow[] }) {
  const [open, setOpen] = useState(false)
  const [drill, setDrill] = useState<string | null>(null)
  const id = useId()
  const [now, setNow] = useState(Date.now)
  const [exits, setExits] = useState<Record<string, { code: number; at: number }>>({})
  const rows = waits.map(w => rowOf(w, now, promises, exits))
  // A live command whose log already says "[exited with code N]" is over, notice or not.
  const pending = waits.filter(w => w.kind === 'task' && w.state === 'live' && w.what === 'command' && w.outputPath && !exits[w.id])
  const pendingKey = pending.map(w => w.id).join(',')
  useEffect(() => {
    if (!pending.length) return
    let stop = false
    const check = () => pending.forEach(w => w.kind === 'task' && api.get<Output>(`/api/task-output?path=${encodeURIComponent(w.outputPath!)}`).then(o => {
      if (!stop && o.kind === 'log' && o.exitCode !== undefined) setExits(e => ({ ...e, [w.id]: { code: o.exitCode!, at: o.updatedAt } }))
    }).catch(() => {}))
    check()
    const t = setInterval(check, 20_000)
    return () => { stop = true; clearInterval(t) }
  }, [pendingKey])
  // Each background agent's progress (marks + mood), polled while it runs, read once when it's over.
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const agents = waits.filter(w => w.kind === 'task' && w.what === 'agent' && w.outputPath)
  const agentKey = agents.map(w => `${w.id}:${w.kind === 'task' && w.state}`).join(',')
  useEffect(() => {
    if (!agents.length) return
    let stop = false
    const load = (list: Wait[]) => list.forEach(w => w.kind === 'task' && api.get<Output>(`/api/task-output?summary=1&path=${encodeURIComponent(w.outputPath!)}`).then(o => {
      if (!stop && o.kind === 'transcript' && o.progress) setProgress(p => ({ ...p, [w.id]: o.progress! }))
    }).catch(() => {}))
    load(agents)
    const running = agents.filter(w => w.kind === 'task' && w.state === 'live')
    const t = running.length ? setInterval(() => load(running), 5000) : undefined
    return () => { stop = true; if (t) clearInterval(t) }
  }, [agentKey]) // eslint-disable-line
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
        <button className="wait-row-btn" aria-expanded={drill === r.wait.id} onClick={() => setDrill(d => d === r.wait.id ? null : r.wait.id)} title="Show what it ran and its output">
          <span className="wait-kind" title={WHAT[r.wait.what]}>{ICON[r.wait.what]}</span>
          <div className="wait-main">
            <div className="wait-label">{r.wait.label}</div>
            <div className="wait-status"><span className={`dot ${r.live ? 'wait-live' : r.bad ? 'bad' : 'ok'}`} />{WHAT[r.wait.what]} · {r.status}</div>
            {r.detail && drill !== r.wait.id && <div className="wait-detail">{r.detail}</div>}
          </div>
          {progress[r.wait.id] && <AgentHealth p={progress[r.wait.id]} live={r.live} />}
          <span className={`work-chevron${drill === r.wait.id ? ' open' : ''}`} aria-hidden="true">›</span>
        </button>
        {drill === r.wait.id && <WaitDrill row={r} />}
      </li>)}
    </ul>
  </div>
}
