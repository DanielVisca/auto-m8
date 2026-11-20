import { useState } from 'react'

type Point = { at: number; usd: number; total: number; buckets: Record<string, number> }
type Timeline = { points: Point[]; total: number; until: number }
const money = (n: number) => n > 0 && n < 0.01 ? '<$0.01' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
const date = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const W = 800, H = 190, L = 64, R = 14, T = 12, B = 30

export function PrSpendTimeline({ timeline, stages, untimedUsd = 0 }: {
  timeline?: Timeline; stages: [string, string, string][]; untimedUsd?: number
}) {
  const [hover, setHover] = useState<number | null>(null)
  if (!timeline) return <div className="muted small">Loading spend history…</div>
  const { points, total, until } = timeline
  if (!points.length) return <div className="muted small">No timestamped spend recorded for this period.</div>
  const start = Math.min(points[0].at - 1, until - 60_000), end = until
  const sx = (at: number) => L + (at - start) / (end - start) * (W - L - R)
  const sy = (usd: number) => T + (1 - usd / (total * 1.08 || 1)) * (H - T - B)
  const base = sy(0)
  const line = `M${L},${base} ` + points.map(p => `H${sx(p.at)} V${sy(p.total)}`).join(' ') + ` H${W - R}`
  const selected = hover === null ? null : points[Math.min(hover, points.length - 1)]
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const at = start + ((e.clientX - box.left) / box.width * W - L) / (W - L - R) * (end - start)
    // Show the most recent increase at the cursor, never a future charge in a quiet period.
    let lo = 0, hi = points.length
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid].at <= at) lo = mid + 1; else hi = mid }
    setHover(Math.max(0, lo - 1))
  }
  return <div className="viz" style={{ maxWidth: 'none', margin: '10px 0 14px' }}>
    <div className="row-flex small" style={{ marginBottom: 6 }}>
      <b className="grow">Spend over time</b><span className="muted">Cumulative</span><b>{money(total)}</b>
    </div>
    <div className="viz-line">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }}
        role="slider" aria-label="Spend history; use left and right arrows to explore increases"
        aria-valuemin={0} aria-valuemax={points.length - 1} aria-valuenow={hover ?? points.length - 1}
        aria-valuetext={selected ? `${date(selected.at)}: ${money(selected.total)}, increased by ${money(selected.usd)}` : `${money(total)} through now`}
        tabIndex={0} onPointerMove={move} onPointerLeave={() => setHover(null)} onBlur={() => setHover(null)}
        onKeyDown={e => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
          e.preventDefault()
          setHover(i => e.key === 'Home' ? 0 : e.key === 'End' ? points.length - 1 : Math.max(0, Math.min(points.length - 1, (i ?? points.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1))))
        }}>
        {[0, 0.5, 1].map(f => <g key={f}>
          <line x1={L} x2={W - R} y1={sy(total * f)} y2={sy(total * f)} className="viz-grid" />
          <text x={L - 8} y={sy(total * f) + 4} textAnchor="end" className="viz-axis">{money(total * f)}</text>
        </g>)}
        <path d={`${line} V${base} H${L} Z`} fill="#3b82f6" opacity={0.12} />
        <path d={line} fill="none" stroke="#3b82f6" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {[0, 0.25, 0.5, 0.75, 1].map(f => {
          const at = start + f * (end - start)
          const label = f === 1 ? 'Now' : end - start > 2 * 86400_000
            ? new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : date(at)
          return <text key={f} x={sx(at)} y={H - 8} textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'} className="viz-axis">{label}</text>
        })}
        {selected && <g>
          <line x1={sx(selected.at)} x2={sx(selected.at)} y1={T} y2={base} className="viz-cross" />
          <circle cx={sx(selected.at)} cy={sy(selected.total)} r={3} fill="#3b82f6" />
        </g>}
      </svg>
    </div>
    <div className="row-flex small" style={{ minHeight: 24 }} aria-live="polite">
      {selected ? <>
        <span className="muted">{date(selected.at)}</span><b>+{money(selected.usd)}</b><span>{money(selected.total)} total</span>
        {stages.filter(([k]) => selected.buckets[k] > 0).map(([k, label, color]) => <span key={k}>
          <span style={{ color }}>■</span> {label} +{money(selected.buckets[k])}
        </span>)}
      </> : <span className="muted">{date(points[0].at)} → now · Hover or use arrow keys to see each increase.</span>}
    </div>
    <div className="muted small">Chats use individual call times; reviews and scouts use their recorded run time. Shared costs keep the same PR split.
      {untimedUsd > 0.005 && ` ${money(untimedUsd)} has no usable timestamp and isn't plotted.`}
    </div>
  </div>
}
