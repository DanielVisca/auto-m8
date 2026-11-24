// A plan's workstreams, at the top of the conversation that drives it: each one's north star with a
// progress bar from baseline to target and a sparkline of its readings, its gate (what it waits on),
// the agents and autoresearch runs working on it, and its PRs. Everything comes from measurements
// perch stores (project action=record, linked autoresearch runs), so it can't go stale like a note.
import './project.css'
import { post, useLive } from './api'
import { convLink } from '../../shared/brand.ts'

export type Workstream = {
  key: string; name: string; north_star: string | null; metric: string | null; unit: string | null; direction: 'minimize' | 'maximize'
  baseline: number | null; target: number | null; measure: string | null; after: string[]; status: string
  gate: 'open' | 'blocked'; waiting_on: string[]; current: number | null; best: number | null; progress: number | null; met: boolean
  readings: { value: number; at: number; source: string | null; note: string | null }[]
  agents: { kind: string; id: string; name: string; status: string | null; metric?: string | null }[]
  prs: { url: string; title: string | null; phase: string; checks: string | null; review: string | null }[]
}

const short = (u: string) => u.replace('https://github.com/', '').replace('/pull/', '#')
const fmt = (v: number | null, unit: string | null) => v == null ? '–' : `${Math.abs(v) >= 100 ? Math.round(v) : +v.toFixed(2)}${unit ? ` ${unit}` : ''}`
const open = (id: string) => window.dispatchEvent(new CustomEvent('perch-open', { detail: id }))

function Spark({ w }: { w: Workstream }) {
  const vs = w.readings.map(r => r.value)
  if (vs.length < 2) return <svg className="ws-spark" />
  const all = w.target != null ? [...vs, w.target] : vs
  const lo = Math.min(...all), hi = Math.max(...all), W = 90, H = 22
  const y = (v: number) => hi === lo ? H / 2 : H - 2 - ((v - lo) / (hi - lo)) * (H - 4)
  const pts = vs.map((v, i) => `${(i / (vs.length - 1)) * W},${y(v)}`).join(' ')
  return (
    <svg className="ws-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {w.target != null && <line x1={0} x2={W} y1={y(w.target)} y2={y(w.target)} className="ws-spark-target" />}
      <polyline points={pts} className="ws-spark-line" />
    </svg>
  )
}

function state(w: Workstream) {
  if (w.status === 'done') return { label: 'done', cls: 'done' }
  if (w.met) return { label: 'target met', cls: 'met' }
  if (w.gate === 'blocked') return { label: `waits on ${w.waiting_on.join(', ')}`, cls: 'blocked' }
  if (w.agents.some(a => a.status === 'running')) return { label: 'working', cls: 'working' }
  return { label: 'open', cls: 'open' }
}

function Row({ w }: { w: Workstream }) {
  const s = state(w)
  const pct = w.progress == null ? null : Math.round(w.progress * 100)
  const last = w.readings[w.readings.length - 1]
  return (
    <div className={`ws ws-${s.cls}`}>
      <div className="ws-head">
        <span className="ws-key">{w.key}</span>
        <span className="ws-name grow" title={w.measure ? `measure: ${w.measure}` : undefined}>{w.name}</span>
        <span className={`ws-badge ws-badge-${s.cls}`}>{s.label}</span>
      </div>
      {w.north_star && <div className="muted small ws-north">{w.north_star}</div>}
      <div className="ws-metric">
        <div className="ws-bar" title={pct == null ? 'needs a baseline, a target and a reading' : `${pct}% of the way from baseline to target`}>
          <div className="ws-bar-fill" style={{ width: `${pct ?? 0}%` }} />
        </div>
        <Spark w={w} />
        <span className="small ws-nums">
          {w.metric && <span className="muted">{w.metric}: </span>}
          <b>{fmt(w.current, w.unit)}</b>
          <span className="muted"> · base {fmt(w.baseline, w.unit)} · target {w.direction === 'minimize' ? '≤' : '≥'} {fmt(w.target, w.unit)}{pct != null ? ` · ${pct}%` : ''}</span>
        </span>
      </div>
      {w.agents.length > 0 && (
        <div className="ws-links small">
          {w.agents.map(a => (
            <button key={a.id} className={`link ws-agent ws-agent-${a.status ?? 'idle'}`} onClick={() => open(a.id)} title={convLink(a.id)}>
              {a.kind === 'autoresearch' ? '⟳ ' : ''}{a.name}{a.status ? ` · ${a.status}` : ''}
            </button>
          ))}
        </div>
      )}
      {w.prs.length > 0 && (
        <div className="ws-prs small">
          {w.prs.map(x => (
            <div key={x.url} className="ws-pr">
              <a href={x.url} target="_blank" rel="noreferrer">{short(x.url)}</a>
              <span className="grow ellipsis muted" title={x.title ?? ''}>{x.title}</span>
              <span className={`ws-phase ws-phase-${x.phase.toLowerCase().replace(/[^a-z]+/g, '-').replace(/-$/, '')}`}>{x.phase}</span>
            </div>
          ))}
        </div>
      )}
      {last?.note && <div className="muted small ws-last">last: {last.note}{last.source ? ` (${last.source})` : ''}</div>}
    </div>
  )
}

// Where the workstreams join: one line per gate, e.g. "ddia → ws1, ws4".
function Gates({ ws }: { ws: Workstream[] }) {
  const edges = new Map<string, string[]>()
  for (const w of ws) for (const a of w.after) edges.set(a, [...(edges.get(a) ?? []), w.key])
  if (!edges.size) return null
  const done = new Set(ws.filter(w => w.status === 'done').map(w => w.key))
  return (
    <div className="ws-gates small muted">
      {[...edges].map(([from, to]) => <span key={from} className={done.has(from) ? 'ws-gate-open' : ''}>{from} → {to.join(', ')}</span>)}
    </div>
  )
}

export function Workstreams({ ws }: { ws: Workstream[] }) {
  if (!ws?.length) return null
  const done = ws.filter(w => w.status === 'done' || w.met).length
  return (
    <div className="workstreams">
      <div className="ws-title small"><b>Workstreams</b> <span className="muted">{done}/{ws.length} at target</span></div>
      <Gates ws={ws} />
      {ws.map(w => <Row key={w.key} w={w} />)}
    </div>
  )
}

// One line per workstream for the top of the chat: name, a small bar and the value. The full plan
// lives in the plan tile (beside the chat or on any board); "Show plan" opens it.
export function WorkstreamSummary({ ws, conversationId }: { ws: Workstream[]; conversationId: string }) {
  if (!ws?.length) return null
  const done = ws.filter(w => w.status === 'done' || w.met).length
  return (
    <div className="ws-summary">
      <div className="ws-title small">
        <b>Workstreams</b> <span className="muted">{done}/{ws.length} at target</span>
        <button className="link small" onClick={() => post(`/api/projects/${encodeURIComponent(conversationId)}/plan-board`, {})}>Show plan</button>
      </div>
      <div className="ws-chips">
        {ws.map(w => {
          const s = state(w)
          return (
            <span key={w.key} className={`ws-chip ws-${s.cls}`} title={`${w.name}: ${s.label}${w.north_star ? ` · ${w.north_star}` : ''}`}>
              <span className="ws-key">{w.key}</span>
              <span className="ws-bar ws-bar-mini"><span className="ws-bar-fill" style={{ width: `${Math.round((w.progress ?? 0) * 100)}%` }} /></span>
              <span className="small">{w.status === 'done' ? '✓' : w.gate === 'blocked' ? '⏸' : fmt(w.current, w.unit)}</span>
            </span>
          )
        })}
      </div>
    </div>
  )
}

type PlanProject = { goal: string; done_when: string | null; status: string; prs: { url: string; title: string | null; phase: string }[]; workstreams?: Workstream[]; error?: string }

// The plan tile: the template every project shares. Goal and done-when, then every workstream with
// its north star, progress, sparkline, gate, agents and PRs, then the PRs not tied to a workstream.
export function PlanTile({ id }: { id: string }) {
  const { data: p } = useLive<PlanProject>(id ? `/api/projects/${encodeURIComponent(id)}` : null, ['home', 'conversations', 'prs'], undefined, 15_000)
  if (!id) return <div className="muted small plan-tile">This plan tile has no conversation.</div>
  if (!p) return <div className="muted small plan-tile">Loading…</div>
  if (p.error) return <div className="muted small plan-tile">No project in {convLink(id)}.</div>
  const tied = new Set((p.workstreams ?? []).flatMap(w => w.prs.map(x => x.url)))
  const loose = p.prs.filter(x => !tied.has(x.url))
  return (
    <div className="plan-tile">
      <div className="plan-goal">
        <button className="link" onClick={() => open(id)}><b>{p.goal}</b></button>
        {p.status === 'done' && <span className="ws-badge ws-badge-done">done</span>}
      </div>
      {p.done_when && <div className="muted small">Done when: {p.done_when}</div>}
      {p.workstreams?.length ? <Workstreams ws={p.workstreams} /> : <div className="muted small">No workstreams yet. Agents add them with the project tool (action=workstreams).</div>}
      {loose.length > 0 && (
        <div className="plan-prs small">
          <b>Other PRs</b>
          {loose.map(x => <div key={x.url}><a href={x.url} target="_blank" rel="noreferrer">{short(x.url)}</a> <span className="muted">{x.title} · {x.phase}</span></div>)}
        </div>
      )}
    </div>
  )
}
