import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { humanCron, useLive } from './api'

// The Railyard's scout timetable, merged with the scout list (Library → Scouts).
type Run = { at: number; done?: number | null; status: string; emitted: number; url: string | null; summary?: string | null; failure?: string | null; findings?: string[]; cost?: number | null; perch?: string | null }
type Scout = { name: string; skill: string; enabled: boolean; cron: string | null; everyMin: number | null; lastRunAt: number | null; runs: Run[] }
type RoutineRun = { at: number; done: number | null; status: string; conversation: string | null; detail: string | null; cost?: number | null }
type Routine = { id?: string; name: string; cron: string; enabled: boolean; lastRunAt: number | null; lastStatus: string | null; runs?: RoutineRun[]; week?: { runs: number; usd: number | null; untracked: number } }

const H = 3600e3
function cronPeriod(c: string | null): number | null {
  if (!c) return null
  const [mi, ho, dom, , dow] = c.trim().split(/\s+/)
  const cnt = (f: string) => f.split(',').length
  const stepOf = (f: string) => { const m = f?.match(/\/(\d+)$/); return m ? +m[1] : null }
  if (dow && dow !== '*') {
    if (stepOf(ho)) return stepOf(ho)! * H
    if (dow === '1-5' && ho !== '*') return (24 * H) / cnt(ho) // weekdays: the gap on a working day, not the week averaged ("34h")
    const days = dow.includes('-') ? (([a, b]) => b - a + 1)(dow.split('-').map(Number)) : cnt(dow)
    return (7 * 24 * H) / days
  }
  if (dom && dom !== '*') return (stepOf(dom) || 30) * 24 * H
  if (ho !== '*') return stepOf(ho) ? stepOf(ho)! * H : (24 * H) / cnt(ho)
  return (60 * 60e3) / (mi.includes('/') ? 60 / stepOf(mi)! : cnt(mi))
}
function period(s: Scout) {
  const cp = cronPeriod(s.cron); if (cp) return cp
  if (s.everyMin) return s.everyMin * 60e3
  const r = s.runs.map(x => x.at).sort((a, b) => b - a)
  const gaps = r.slice(0, -1).map((t, i) => t - r[i + 1]).filter(g => g > 60e3).sort((a, b) => a - b)
  return gaps.length >= 2 ? gaps[Math.floor(gaps.length / 2)] : 1440 * 60e3
}
const per = (ms: number) => ms < 90 * 60e3 ? `${Math.round(ms / 60e3)}m` : ms < 36 * H ? `${Math.round(ms / H)}h` : `${Math.round(ms / 24 / H)}d`
function ago(t: number | null | undefined) {
  if (!t) return '—'
  const s = (Date.now() - t) / 1e3
  return (s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${(s / 3600).toFixed(s < 36000 ? 1 : 0)}h` : `${Math.round(s / 86400)}d`) + ' ago'
}
const failed = (st: string) => st === 'failed' || st === 'error'
const dur = (a: number, b?: number | null) => { if (!b) return ''; const s = (b - a) / 1e3; return s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h` }

// Scout summaries are markdown from an agent: render only links, code, bold and bullets, everything else as text.
function Md({ text }: { text: string }) {
  const inline = (line: string, k: number) => {
    const out: ReactNode[] = []
    const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|(https?:\/\/[^\s)]+)/g
    let last = 0, m: RegExpExecArray | null, i = 0
    while ((m = re.exec(line))) {
      if (m.index > last) out.push(line.slice(last, m.index))
      const key = `${k}.${i++}`
      if (m[1]) out.push(<a key={key} href={m[2]} target="_blank" rel="noreferrer">{m[1]}</a>)
      else if (m[3]) out.push(<code key={key}>{m[3]}</code>)
      else if (m[4]) out.push(<b key={key}>{m[4]}</b>)
      else out.push(<a key={key} href={m[5]} target="_blank" rel="noreferrer">{m[5].replace(/^https?:\/\//, '').slice(0, 48)}</a>)
      last = re.lastIndex
    }
    if (last < line.length) out.push(line.slice(last))
    return out
  }
  return <div className="run-md">{text.split('\n').filter(l => l.trim()).map((l, k) => {
    const b = l.match(/^\s*[-*]\s+(.*)/)
    return b ? <div key={k} className="run-li">• {inline(b[1], k)}</div> : <p key={k}>{inline(l, k)}</p>
  })}</div>
}

type Hover = { el: HTMLElement; body: ReactNode }
// One hover card for every run mark: opens on hover, stays while the pointer is on the card (so its links work),
// and closes shortly after the pointer leaves both.
function useRunHover() {
  const [h, setH] = useState<Hover | null>(null)
  const t = useRef<number | undefined>(undefined)
  const show = (el: HTMLElement, body: ReactNode) => { clearTimeout(t.current); t.current = window.setTimeout(() => setH({ el, body }), 120) }
  const hide = () => { clearTimeout(t.current); t.current = window.setTimeout(() => setH(null), 200) }
  const keep = () => clearTimeout(t.current)
  let card: ReactNode = null
  if (h && h.el.isConnected) {
    const a = h.el.getBoundingClientRect(), w = Math.min(440, innerWidth - 16)
    const left = Math.max(8, Math.min(a.left + a.width / 2 - w / 2, innerWidth - w - 8))
    const below = innerHeight - a.bottom > 260 || a.top < innerHeight / 2
    card = createPortal(
      <div className="run-card" onMouseEnter={keep} onMouseLeave={hide}
        style={{ left, width: w, ...(below ? { top: a.bottom + 6 } : { bottom: innerHeight - a.top + 6 }), maxHeight: (below ? innerHeight - a.bottom : a.top) - 16 }}>
        {h.body}
      </div>, document.body)
  }
  return { show, hide, card }
}

function RunCard({ r, scout }: { r: Run; scout: string }) {
  const bad = failed(r.status)
  const head = r.status === 'in_progress' ? 'Running now' : bad ? 'Failed' : r.emitted ? `Found ${r.emitted}` : 'Nothing to report'
  return (
    <>
      <div className="run-head">
        <b style={{ color: bad ? '#ef4444' : r.emitted ? '#22c55e' : undefined }}>{head}</b>
        <span className="muted small"> · {scout} · {new Date(r.at).toLocaleString()}{r.done ? ` · took ${dur(r.at, r.done)}` : ''}{r.cost != null ? ` · $${r.cost.toFixed(2)}` : ''}</span>
      </div>
      {bad && <div className="run-fail">{r.failure || 'PostHog gave no failure reason; open the run to see its log.'}</div>}
      {r.summary ? <Md text={r.summary} /> : !bad && r.status !== 'in_progress' && <div className="muted small">No summary on this run.</div>}
      {!!r.findings?.length && <div className="muted small run-ids">{r.findings.join(' · ')}</div>}
      <div className="run-actions">
        {r.perch && <button className="small" onClick={() => window.dispatchEvent(new CustomEvent('perch-open', { detail: r.perch }))}>Open in auto-m8</button>}
        {r.url && <a className="small" href={r.url} target="_blank" rel="noreferrer">Open in PostHog ↗</a>}
        <span className="muted small">or click the mark</span>
      </div>
    </>
  )
}

function RoutineCard({ x, name }: { x: RoutineRun; name: string }) {
  const bad = x.status === 'error' || x.status === 'stalled'
  const head = bad ? (x.status === 'stalled' ? 'Stalled' : 'Failed') : x.status === 'running' ? 'Running now' : x.status === 'noop' ? 'Nothing to do' : 'Done'
  return (
    <>
      <div className="run-head">
        <b style={{ color: bad ? '#ef4444' : undefined }}>{head}</b>
        <span className="muted small"> · {name} · {new Date(x.at).toLocaleString()}{x.done ? ` · took ${dur(x.at, x.done)}` : ''}{x.cost != null ? ` · $${x.cost.toFixed(2)}` : ''}</span>
      </div>
      {x.detail ? (bad ? <div className="run-fail">{x.detail}</div> : <Md text={x.detail} />) : <div className="muted small">No detail recorded.</div>}
      <div className="run-actions">
        <span className="muted small">{x.conversation ? 'click the mark to open its chat' : 'no chat was kept for this run'}</span>
      </div>
    </>
  )
}

type Config = { id: string; skill_name: string; display_name?: string; description?: string; enabled?: boolean; status?: string; run_cron_schedule?: string | null; run_interval_minutes?: number | null; last_run_at?: string | null; consecutive_failure_count?: number; pause_reason?: string | null; owners?: { first_name: string }[]; mine?: boolean }
type TeamRun = { run_id: string; skill_name: string; status: string; emitted_count?: number; created_at: string; posthog_url?: string | null; summary?: string | null; failure_reason?: string | null; perch_id?: string | null }

const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString()}`

// One table for the Scouts tab: each scout's cadence, last runs (newest right), 7-day cost, health and Run now.
// Runs come from the Railyard snapshot (your scouts, last 10 each), falling back to the team runs feed.
export function ScoutTable({ scouts, runs, showRoutines, sortByCadence, cost, msg, onRun, onOpenRun }: {
  scouts: Config[]; runs: TeamRun[]; showRoutines: boolean; sortByCadence: boolean
  cost: (c: Config) => { label: string; title: string } | undefined | 0
  msg: Record<string, string>; onRun: (c: Config) => void; onOpenRun: (r: TeamRun) => void
}) {
  const { data: ry } = useLive<{ scouts: Scout[]; routines: Routine[] }>('/api/railyard', [], undefined, 60_000)
  const rySkill = new Map((ry?.scouts ?? []).map(s => [s.skill, s]))
  const byUrl = new Map(runs.filter(r => r.posthog_url).map(r => [r.posthog_url!, r]))
  const rows = scouts.map(c => {
    const y = rySkill.get(c.skill_name)
    const marks: (Run & { team?: TeamRun })[] = y?.runs.length
      ? y.runs.map(r => ({ ...r, team: r.url ? byUrl.get(r.url) : undefined }))
      : runs.filter(r => r.skill_name === c.skill_name).slice(0, 10).map(r => ({ at: Date.parse(r.created_at), status: r.status, emitted: r.emitted_count ?? 0, url: r.posthog_url ?? null, team: r }))
    const s: Scout = { name: c.display_name || c.skill_name, skill: c.skill_name, enabled: c.enabled !== false && c.status !== 'paused', cron: c.run_cron_schedule ?? null, everyMin: c.run_interval_minutes ?? null, lastRunAt: Date.parse(c.last_run_at ?? '') || null, runs: marks }
    return { c, s, marks, p: period(s) }
  })
  if (sortByCadence) rows.sort((a, b) => a.p - b.p)
  // Drill in: the run's chat in auto-m8 when it was imported, else the PostHog task run.
  const open = (m: Run & { team?: TeamRun }) => m.perch ? window.dispatchEvent(new CustomEvent('perch-open', { detail: m.perch })) : m.team ? onOpenRun(m.team) : m.url && window.open(m.url, '_blank')
  const hover = useRunHover()
  return (
    <section className="card scout-tt">
      <div className="muted small">Last runs, newest right · ● found something · ✕ failed · grey · = nothing to do (local) · hover a mark for what it found or why it failed, click to drill in</div>
      <table>
        <thead><tr><th>scout</th><th className="tt-wide">every</th><th>last</th><th className="tt-mid">runs</th><th className="tt-wide">7d</th><th /></tr></thead>
        <tbody>
          {rows.map(({ c, s, marks, p }) => {
            const tip = [c.description, c.owners?.length ? `owners: ${c.owners.map(o => o.first_name).join(', ')}` : '', c.pause_reason ? `paused: ${c.pause_reason}` : ''].filter(Boolean).join('\n\n')
            const k = cost(c)
            return (
              <tr key={c.id}>
                <td title={tip} style={s.enabled ? undefined : { opacity: 0.5 }}>
                  <div className="tt-name">{s.name}{!s.enabled && <span className="chip">paused</span>}{c.mine === false && c.owners?.length ? <span className="muted small"> · {c.owners.map(o => o.first_name).join(', ')}</span> : null}</div>
                  {c.description && <div className="muted small ellipsis tt-desc">{c.description}</div>}
                </td>
                <td className="tt-wide" title={c.run_cron_schedule ? humanCron(c.run_cron_schedule) : undefined}>{per(p)}</td>
                <td>{ago(marks[0]?.at || s.lastRunAt)}</td>
                <td className="tt-runs tt-mid">
                  {marks.slice(0, 10).reverse().map((r, i) => (
                    <span key={i} className="clickable" onClick={() => open(r)}
                      onMouseEnter={e => hover.show(e.currentTarget, <RunCard r={{ ...r, summary: r.summary ?? r.team?.summary, failure: r.failure ?? r.team?.failure_reason }} scout={s.name} />)}
                      onMouseLeave={hover.hide}
                      style={{ color: r.status === 'in_progress' ? 'var(--accent)' : failed(r.status) ? '#ef4444' : '#22c55e', animation: r.status === 'in_progress' ? 'pulse 1.4s infinite' : undefined }}>
                      {failed(r.status) ? '✕' : r.emitted ? '●' : '·'}
                    </span>
                  ))}
                  {!marks.length && <span className="muted small">no runs</span>}
                </td>
                <td className="tt-wide" title={k ? k.title : undefined}>{k ? k.label : <span className="muted">—</span>}</td>
                <td className="tt-act">
                  {(c.consecutive_failure_count ?? 0) > 0 && <span className="bad small" title={`${c.consecutive_failure_count} failures in a row`}>{c.consecutive_failure_count}✕ </span>}
                  {msg[c.id] && <span className="muted small">{msg[c.id]} </span>}
                  <button className="small" onClick={() => onRun(c)}>Run now</button>
                </td>
              </tr>
            )
          })}
          {showRoutines && ry?.routines.map(r => {
            const rr = r.runs ?? []
            const p = cronPeriod(r.cron)
            return (
              <tr key={`r:${r.id ?? r.name}`}>
                <td style={r.enabled ? undefined : { opacity: 0.5 }} title={`${r.name}\nlocal routine: runs on this Mac${r.enabled ? '' : ' (off)'}`}>
                  <div className="tt-name">⌂ {r.name}<span className="chip">local</span>{!r.enabled && <span className="chip">off</span>}</div>
                </td>
                <td className="tt-wide" title={`${r.cron} · ${humanCron(r.cron)}`}>{p ? per(p) : r.cron}</td>
                <td>{ago(rr[0]?.at || r.lastRunAt)}</td>
                <td className="tt-runs tt-mid">
                  {rr.slice(0, 10).reverse().map((x, i) => {
                    const bad = x.status === 'error' || x.status === 'stalled'
                    return (
                      <span key={i} className={x.conversation ? 'clickable' : undefined}
                        onClick={() => x.conversation && window.dispatchEvent(new CustomEvent('perch-open', { detail: x.conversation }))}
                        onMouseEnter={e => hover.show(e.currentTarget, <RoutineCard x={x} name={r.name} />)}
                        onMouseLeave={hover.hide}
                        style={{ color: x.status === 'running' ? 'var(--accent)' : bad ? '#ef4444' : x.status === 'noop' ? 'var(--muted)' : '#22c55e', animation: x.status === 'running' ? 'pulse 1.4s infinite' : undefined }}>
                        {bad ? '✕' : '·'}
                      </span>
                    )
                  })}
                  {!rr.length && <span className={r.lastStatus === 'error' ? 'bad small' : 'muted small'}>{r.lastStatus ?? 'no runs'}</span>}
                </td>
                <td className="tt-wide" title={r.week?.runs ? `${r.week.runs} runs in the last 7 days at API prices${r.week.untracked > 0 ? `, ${r.week.untracked} without spend data` : ''}` : undefined}>
                  {r.week?.runs && r.week.usd != null ? usd(r.week.usd) : <span className="muted">—</span>}
                </td><td />
              </tr>
            )
          })}
        </tbody>
      </table>
      {hover.card}
    </section>
  )
}
