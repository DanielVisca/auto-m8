// "The line, now" from the Railyard tile: every open PR as a dot at its station, coloured by who holds it.
// Shown in Insights → PRs as an alternative to the flow chart. Data: /api/railyard.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLive } from './api'
import { Popover } from './Popover'
import { PrPreviewCard } from './PrPreview'
import { openPr } from './PrPill'

type Proof = { state: string; live?: string; healthy?: string; used?: string; works?: string; contained?: string }
export type Train = { url: string; number: number; title: string; repo: string; station: string; holder: string; red?: boolean; working?: boolean; size?: number | null; signal: string[]; decision?: { title: string } | null; proof?: Proof | null; outcome?: string; verifyDueAt?: number | null; detail?: string }
type Ry = { at: number; stations: string[]; trains: Train[]; lanes: { live: boolean }[]; scouts: { runs: { status: string }[] }[]; crossing: { since: number | null }[] }

export const HOLDER: Record<string, [string, string]> = { you: ['#f59e0b', 'you'], agent: ['#8b5cf6', 'agent driving'], ci: ['#94a3b8', 'CI running'], reviewer: ['#06b6d4', 'waiting on reviewer'], merge: ['#22c55e', 'ready to merge'], prod: ['#3b82f6', 'in production / checks'], idle: ['#6b7280', 'parked'] }
export const STN: Record<string, string> = { draft: 'draft', ci: 'CI', review: 'review', approved: 'approved', deploy: 'deploy + check 1', check2: '+2h check', verified: 'verified', proven: 'proven' }
const ORDER: Record<string, number> = { you: 0, agent: 1, merge: 2, reviewer: 3, ci: 4, prod: 5, idle: 6 }
const PROOF: Record<string, string> = { pass: '✅', concern: '⚠️', no_signal: '🔇', pending: '⏳', n_a: '➖' }

function ago(t?: number | null) {
  if (!t) return '—'
  let s = (Date.now() - t) / 1e3
  const f = s < 0 ? 'in ' : '', e = s < 0 ? '' : ' ago'
  s = Math.abs(s)
  return f + (s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${(s / 3600).toFixed(s < 36000 ? 1 : 0)}h` : `${Math.round(s / 86400)}d`) + e
}
const trainText = (t: Train) => [
  `#${t.number} ${t.title}`,
  `${t.repo} · ${STN[t.station] ?? t.station}${t.red ? ' (stuck)' : ''}`,
  `held by: ${HOLDER[t.holder]?.[1] ?? t.holder}${t.working ? ' (agent working now)' : ''}`,
  t.size != null ? `diff: ${t.size} lines` : '',
  t.signal.length ? `waiting on after: ${t.signal.map(u => '#' + u.split('/').pop()).join(', ')}` : '',
  t.decision ? `DECISION: ${t.decision.title}` : '',
  t.proof ? `proof: ${t.proof.state.replace('_', ' ')} · ${(['live', 'healthy', 'used', 'works', 'contained'] as const).map(k => `${k} ${PROOF[t.proof![k] ?? ''] ?? '·'}`).join(' ')}` : '',
  t.outcome ?? '', t.verifyDueAt ? `next check ${ago(t.verifyDueAt)}` : '', t.detail ? `— ${t.detail.slice(0, 200)}` : '',
].filter(Boolean).join('\n')

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(800)
  useLayoutEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

// Clicking a station (its name, its circle or the empty space in its column) selects it, so the list
// and summary under the chart show those PRs, the same way a click on the flow chart filters them.
export function RailLine({ picked, onPick }: { picked?: string | null; onPick?: (station: string | null, trains: Train[]) => void } = {}) {
  const { data: D, error } = useLive<Ry>('/api/railyard', ['prflow' as any], undefined, 60_000)
  const [ref, W] = useWidth()
  // Hovering a dot opens the same PR preview card as PR pills, with the line's own context on top.
  const anchor = useRef<HTMLElement | null>(null)
  const [hover, setHover] = useState<Train | null>(null)
  const timer = useRef<any>(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const enter = (t: Train, el: Element) => { clearTimeout(timer.current); timer.current = setTimeout(() => { anchor.current = el as HTMLElement; setHover(t) }, 350) }
  const leave = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setHover(null), 250) }
  // Keep the picked station's PR list in step with the live data as it refreshes.
  const pickedKey = D && picked ? D.trains.filter(t => t.station === picked).map(t => t.url + t.holder + t.signal.length).join() : ''
  useEffect(() => { if (D && picked && onPick) onPick(picked, D.trains.filter(t => t.station === picked)) }, [pickedKey])
  if (!D) return <div ref={ref} className="muted small pad">{error ?? 'Loading the line…'}</div>
  const st = D.stations, step = W / st.length, pad = step / 2
  const at: Record<string, Train[]> = Object.fromEntries(st.map(s => [s, []]))
  D.trains.forEach(t => (at[t.station] ??= []).push(t))
  const r = (t: Train) => t.size == null ? 5 : Math.max(4, Math.min(11, 2.2 + Math.log10(t.size + 1) * 2.4))
  const perRow = Math.max(2, Math.floor(step / 24))
  let maxRows = 0
  st.forEach(s => { at[s].sort((a, b) => (ORDER[a.holder] ?? 9) - (ORDER[b.holder] ?? 9) || (b.size ?? 0) - (a.size ?? 0)); maxRows = Math.max(maxRows, Math.ceil(at[s].length / perRow)) })
  const y0 = 40, Ht = y0 + 30 + maxRows * 24 + 16
  const moving = D.trains.filter(t => t.station !== 'proven').length
  const verified = D.trains.filter(t => t.station === 'verified').length
  const proven = D.trains.filter(t => t.station === 'proven').length
  const driving = D.lanes.filter(l => l.live).length
  const scoutsOut = D.scouts.filter(s => s.runs[0]?.status === 'in_progress').length
  const waiting = D.crossing.length, oldest = D.crossing.find(x => x.since)?.since
  return (
    <div ref={ref} className="rail-line">
      <div className="rail-stats small">
        <span className={waiting ? 'rail-cross' : 'muted'}>{waiting ? `${waiting} at your crossing${oldest ? ` · oldest waiting ${ago(oldest).replace(' ago', '')}` : ''}` : 'Nothing waiting on you'}</span>
        <span className="muted"><b>{moving}</b> on the line · <b>{verified}</b> verified · <b>{proven}</b> proven · <b>{driving}</b> agents driving · <b>{scoutsOut}</b>/{D.scouts.length} scouts out</span>
      </div>
      <svg width={W} height={Ht} style={{ display: 'block', overflow: 'visible' }}>
        <line x1={pad} x2={W - pad} y1={y0} y2={y0} stroke="var(--line)" strokeWidth={6} strokeLinecap="round" />
        {st.map((s, i) => {
          const x = pad + i * step
          const on = picked === s, pick = () => onPick?.(on ? null : s, on ? [] : at[s])
          return (
            <g key={s} style={picked && !on ? { opacity: 0.4 } : undefined}>
              {onPick && <rect x={x - step / 2 + 2} y={0} width={step - 4} height={Ht} rx={6} className="clickable" onClick={pick}
                fill={on ? 'var(--accent)' : 'transparent'} fillOpacity={on ? 0.08 : 0}><title>{on ? 'Show what needs you again' : `Show the ${at[s].length} PRs at ${STN[s] ?? s} below`}</title></rect>}
              {s === 'deploy' && <><line x1={x - step / 2} x2={x - step / 2} y1={4} y2={Ht - 4} stroke="var(--line)" strokeDasharray="3 4" /><text x={x - step / 2 + 4} y={Ht - 4} fontSize={10.5} fill="var(--muted)">merge ↦ production</text></>}
              <circle cx={x} cy={y0} r={8} fill={on ? 'var(--accent)' : 'var(--bg)'} stroke={on ? 'var(--accent)' : 'var(--fg)'} strokeWidth={2.5} style={{ pointerEvents: 'none' }} />
              {/* Two lines (name, count) so neighbouring labels never run into each other. */}
              <text x={x} y={11} textAnchor="middle" fontSize={11} fontWeight={600} fill={on ? 'var(--accent)' : 'var(--fg)'} style={{ pointerEvents: 'none' }}>{STN[s] ?? s}</text>
              <text x={x} y={24} textAnchor="middle" fontSize={10.5} fill="var(--muted)" style={{ pointerEvents: 'none' }}>{at[s].length}</text>
              {at[s].map((t, k) => {
                const col = k % perRow, row = Math.floor(k / perRow)
                const cx = x + (col - (Math.min(perRow, at[s].length) - 1) / 2) * 22, cy = y0 + 30 + row * 24, rr = r(t)
                const c = HOLDER[t.holder]?.[0] ?? '#6b7280'
                return (
                  <g key={t.url} className="clickable" onClick={() => openPr(t.url)}
                    onMouseEnter={e => enter(t, e.currentTarget)} onMouseLeave={leave}>
                    {t.holder === 'you' && <circle cx={cx} cy={cy} r={rr + 3.5} fill="none" stroke="#f59e0b" strokeWidth={1.2} strokeDasharray="2 2" />}
                    <circle cx={cx} cy={cy} r={rr} fill={c} fillOpacity={t.holder === 'idle' ? 0.45 : 0.95} stroke={t.red ? 'var(--bad, #ef4444)' : 'none'} strokeWidth={2.5} style={t.working ? { animation: 'pulse 1.4s ease-in-out infinite' } : undefined} />
                    {t.signal.length > 0 && <rect x={cx + rr - 1} y={cy - rr - 4} width={4} height={9} rx={1} fill="#ef4444" />}
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>
      {hover && (
        <Popover anchor={anchor} open onClose={() => setHover(null)} width={440} align="start">
          <div onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={leave}>
            <div className="small muted" style={{ whiteSpace: 'pre-wrap', padding: '8px 12px 0' }}>{trainText(hover).split('\n').slice(1).join('\n')}</div>
            <PrPreviewCard url={hover.url} brief={{ title: hover.title }} />
          </div>
        </Popover>
      )}
      <div className="flow-legend small">
        {Object.values(HOLDER).map(([c, l]) => <span key={l}><i className="sw" style={{ background: c }} />{l}</span>)}
        <span className="muted">· pulsing = agent driving · red ring = stuck · ▮ = waiting on an after: PR to pass its first prod check · click a station to list it · size = diff</span>
      </div>
    </div>
  )
}

