// Charts and tables inside a chat. Two ways in:
// 1. Data query tool results draw themselves (vizFromTool): a Grafana range query becomes a line chart
//    (stackable), a histogram (_bucket with `le`) a heatmap with p50/p95/p99, an instant query a stat
//    tile or bars, PostHog SQL a table.
// 2. An agent writes a ```chart block holding JSON (VizSpec) or a ```vega-lite block for anything else.
import { useEffect, useMemo, useRef, useState } from 'react'

type Point = [number, number] // [unix seconds or x index, value]
type Series = { name: string; points: Point[]; axis?: 'right' }
type Common = { title?: string; link?: string }
export type VizSpec = Common & (
  | { type: 'line' | 'area'; unit?: string; rightUnit?: string; stack?: boolean; series: Series[] }
  | { type: 'bar'; unit?: string; bars: { label: string; value: number }[] }
  | { type: 'table'; columns: string[]; rows: (string | number | null)[][] }
  | { type: 'stat'; unit?: string; stats: { label: string; value: number; unit?: string; baseline?: number; spark?: number[] }[] }
  | { type: 'heatmap'; unit?: string; buckets: string[]; times: number[]; cells: number[][] }
  | { type: 'vega-lite'; spec: any })
type Of<T extends VizSpec['type']> = Extract<VizSpec, { type: T }>
type LineSpec = Extract<VizSpec, { series: Series[] }>

const PALETTE = ['#2f6fdb', '#d97706', '#1a7f37', '#a23bc4', '#cf222e', '#0f8a8a', '#7a5c00', '#e05297', '#5b6b7f', '#3fa34d']
const MAX_SERIES = 10

const compact = (n: number, unit = '') => {
  if (!Number.isFinite(n)) return String(n)
  const bytes = unit === 'bytes', secs = unit === 's' || unit === 'seconds'
  if (secs && Math.abs(n) < 1 && n !== 0) return Math.abs(n) >= 1e-3 ? `${+(n * 1e3).toPrecision(3)} ms` : `${+(n * 1e6).toPrecision(3)} µs`
  if (unit === '%' || unit === 'percent') return `${+n.toPrecision(3)}%`
  const k = bytes ? 1024 : 1000
  const sfx = bytes ? ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] : ['', 'k', 'M', 'B', 'T']
  let i = 0, v = n
  while (Math.abs(v) >= k && i < sfx.length - 1) { v /= k; i++ }
  const s = n === 0 ? '0' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : +v.toPrecision(3) + ''
  return `${s}${sfx[i] ? (bytes ? ' ' : '') + sfx[i] : ''}${unit && !bytes ? ` ${secs ? 's' : unit}` : ''}`
}
const isTime = (x: number) => x > 1e9 && x < 1e10
const fmtX = (x: number, span: number) => {
  if (!isTime(x)) return String(+x.toPrecision(4))
  const d = new Date(x * 1000)
  return span > 2 * 86400 ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
const labelOf = (m: Record<string, string> | undefined) => Object.entries(m ?? {}).filter(([k]) => k !== '__name__').map(([k, v]) => `${k}=${v}`).join(', ') || m?.__name__ || 'value'
const guessUnit = (expr: string) => /bytes/i.test(expr) ? 'bytes' : /_seconds/i.test(expr) && !/_count\b/.test(expr) ? 's' : ''
const leNum = (le: string) => le === '+Inf' ? Infinity : Number(le)

// Histogram buckets (cumulative counts by `le`) at one instant → per-bucket counts, sorted by le.
function deCumulate(byLe: Map<string, number>) {
  const les = [...byLe.keys()].sort((a, b) => leNum(a) - leNum(b))
  return les.map((le, i) => ({ le, n: Math.max(0, byLe.get(le)! - (i ? byLe.get(les[i - 1])! : 0)), cum: byLe.get(le)! }))
}
// Same interpolation as Prometheus' histogram_quantile.
export function quantile(q: number, b: { le: string; cum: number }[]) {
  const total = b.at(-1)?.cum ?? 0
  if (!total) return NaN
  const rank = q * total
  for (let i = 0; i < b.length; i++) {
    if (b[i].cum >= rank) {
      const hi = leNum(b[i].le), lo = i ? leNum(b[i - 1].le) : 0, prev = i ? b[i - 1].cum : 0
      if (hi === Infinity) return lo
      return lo + (hi - lo) * ((rank - prev) / Math.max(b[i].cum - prev, 1e-12))
    }
  }
  return NaN
}

function fromPromData(data: any[], expr: string, link?: string): VizSpec | null {
  if (!data.length) return null
  const title = expr.replace(/\s+/g, ' ').slice(0, 140)
  const unit = guessUnit(expr)
  const range = data.some(s => Array.isArray(s.values))
  const hist = data.length > 1 && data.every(s => s.metric?.le !== undefined)
  if (hist) {
    // Sum across any other labels so there's one histogram.
    if (range) {
      const times = [...new Set(data.flatMap(s => s.values.map((p: any) => Number(p[0]))))].sort((a, b) => a - b)
      const at = new Map<number, Map<string, number>>(times.map(t => [t, new Map()]))
      for (const s of data) for (const [t, v] of s.values) { const m = at.get(Number(t))!; m.set(s.metric.le, (m.get(s.metric.le) ?? 0) + Number(v)) }
      const cols = times.map(t => deCumulate(at.get(t)!))
      const buckets = cols[0]?.map(b => b.le) ?? []
      return { type: 'heatmap', title, link, unit, buckets, times, cells: buckets.map((_, i) => cols.map(c => c[i]?.n ?? 0)) }
    }
    const byLe = new Map<string, number>()
    for (const s of data) byLe.set(s.metric.le, (byLe.get(s.metric.le) ?? 0) + Number(s.value?.[1]))
    return { type: 'bar', title, link, bars: deCumulate(byLe).map(b => ({ label: `≤ ${b.le === '+Inf' ? '+Inf' : compact(leNum(b.le), unit)}`, value: b.n })) }
  }
  if (range) return { type: 'line', title, unit, link, series: data.filter(s => Array.isArray(s.values)).map(s => ({ name: labelOf(s.metric), points: s.values.map((p: any) => [Number(p[0]), Number(p[1])] as Point).filter((p: Point) => Number.isFinite(p[1])) })) }
  const vals = data.map(s => ({ label: labelOf(s.metric), value: Number(s.value?.[1]) })).filter(b => Number.isFinite(b.value))
  if (!vals.length) return null
  if (vals.length <= 4) return { type: 'stat', title, unit, link, stats: vals }
  return { type: 'bar', title, unit, link, bars: vals.sort((a, b) => b.value - a.value) }
}

// A tool result that can be drawn, or null.
export function vizFromTool(name: string, input: any, result: string | undefined): VizSpec | null {
  if (!result || /^Error/.test(result)) return null
  if (name.startsWith('mcp__grafana__') && /query_prometheus$|query_loki_logs$/.test(name)) {
    let r: any
    try { r = JSON.parse(result) } catch { return null }
    const data: any[] = Array.isArray(r?.data) ? r.data : r?.data?.result ?? []
    // Loki only draws for metric queries (count_over_time, rate…), which come back shaped like Prometheus.
    if (!data.every(s => s && typeof s === 'object' && s.metric && (Array.isArray(s.values) || Array.isArray(s.value)))) return null
    return fromPromData(data, String(input?.expr ?? input?.logql ?? ''), r.exploreUrl)
  }
  // PostHog MCP: `call execute-sql {...}` returns "col|col\nv|v".
  if (/^mcp__.*posthog.*__exec$/i.test(name) && /^call\s+execute-sql\b/.test(String(input?.command ?? ''))) {
    const lines = result.trim().split('\n').filter(Boolean)
    if (lines.length < 3 || !lines[0].includes('|')) return null
    const [head, ...body] = lines.map(l => l.split('|'))
    if (body.some(r => r.length !== head.length)) return null
    let sql = ''
    try { sql = JSON.parse(String(input.command).replace(/^call\s+execute-sql\s*/, '')).query ?? '' } catch {}
    return { type: 'table', title: sql.replace(/\s+/g, ' ').slice(0, 140), columns: head, rows: body.slice(0, 500) }
  }
  return null
}

// Splits Markdown into text, ```chart / ```vega-lite blocks, and ```tile blocks (HTML that runs inline).
export type MessagePart = { kind: 'md'; text: string } | { kind: 'chart'; spec: VizSpec | null; raw: string } | { kind: 'tile'; info: string; body: string }
export function splitCharts(text: string): MessagePart[] {
  if (!/```(chart|vega-lite|vegalite|tile|artifact)/.test(text)) return [{ kind: 'md', text }]
  const out: MessagePart[] = []
  const re = /^```(chart|vega-lite|vegalite|tile|artifact)([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm
  let last = 0, m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ kind: 'md', text: text.slice(last, m.index) })
    if (m[1] === 'tile' || m[1] === 'artifact') out.push({ kind: 'tile', info: m[2].trim(), body: m[3] })
    else out.push({ kind: 'chart', spec: parseSpec(m[3], m[1] !== 'chart'), raw: m[3] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ kind: 'md', text: text.slice(last) })
  return out
}
export function parseSpec(raw: string, vega = false): VizSpec | null {
  let s: any
  try { s = JSON.parse(raw) } catch { return null }
  if (!s || typeof s !== 'object') return null
  if (vega || /vega-lite/.test(String(s.$schema ?? ''))) return { type: 'vega-lite', spec: s }
  if (s.type === 'vega-lite' && s.spec) return { type: 'vega-lite', title: s.title, link: s.link, spec: s.spec }
  if ((s.type === 'line' || s.type === 'area') && Array.isArray(s.series)) return { ...s, series: s.series.map((x: any) => ({ name: String(x.name ?? ''), axis: x.axis === 'right' ? 'right' : undefined, points: (x.points ?? []).map((p: any) => [Number(p[0]), Number(p[1])]) })) }
  if (s.type === 'bar' && Array.isArray(s.bars)) return { ...s, bars: s.bars.map((b: any) => ({ label: String(b.label), value: Number(b.value) })) }
  if (s.type === 'table' && Array.isArray(s.columns) && Array.isArray(s.rows)) return s
  if (s.type === 'stat' && Array.isArray(s.stats)) return { ...s, stats: s.stats.map((x: any) => ({ label: String(x.label ?? ''), value: Number(x.value), unit: x.unit, baseline: x.baseline === undefined ? undefined : Number(x.baseline), spark: Array.isArray(x.spark) ? x.spark.map(Number) : undefined })) }
  if (s.type === 'heatmap' && Array.isArray(s.buckets) && Array.isArray(s.times) && Array.isArray(s.cells)) return s
  return null
}

export function Viz({ spec, raw }: { spec: VizSpec | null; raw?: string }) {
  if (!spec) return <div className="viz"><div className="viz-head small muted">Couldn't read this chart</div>{raw && <pre className="small">{raw.slice(0, 2000)}</pre>}</div>
  return (
    <div className="viz">
      {(spec.title || spec.link) && <div className="viz-head">
        {spec.title && <span className="viz-title" title={spec.title}>{spec.title}</span>}
        {spec.link && <a className="small" href={spec.link} onClick={e => { e.preventDefault(); window.open(spec.link, '_blank') }}>{/grafana/.test(spec.link) ? 'Open in Grafana ↗' : 'Open ↗'}</a>}
      </div>}
      {spec.type === 'line' || spec.type === 'area' ? <LineChart spec={spec} />
        : spec.type === 'bar' ? <Bars spec={spec} />
        : spec.type === 'stat' ? <Stats spec={spec} />
        : spec.type === 'heatmap' ? <Heatmap spec={spec} />
        : spec.type === 'vega-lite' ? <VegaLite spec={spec.spec} />
        : <Table spec={spec as Of<'table'>} />}
    </div>
  )
}

const W = 640, H = 200, L = 52, T = 8, B = 22
const nice = (lo: number, hi: number): [number, number] => { if (!Number.isFinite(lo)) lo = 0; if (!Number.isFinite(hi) || hi === lo) hi = lo + 1; return [lo, hi + (hi - lo) * 0.05] }

function LineChart({ spec }: { spec: LineSpec }) {
  const [hidden, setHidden] = useState<Set<number>>(new Set())
  const [stack, setStack] = useState(!!spec.stack)
  const [hover, setHover] = useState<number | null>(null)
  const ref = useRef<SVGSVGElement>(null)
  const all = spec.series.filter(s => s.points.length)
  const series = all.slice(0, MAX_SERIES)
  const dual = series.some(s => s.axis === 'right') && series.some(s => s.axis !== 'right')
  const stacked = stack && series.length > 1 && !dual
  const R = dual ? 72 : 10
  const g = useMemo(() => {
    const shown = series.map((s, i) => ({ s, i })).filter(x => !hidden.has(x.i))
    const xs = [...new Set(shown.flatMap(x => x.s.points.map(p => p[0])))].sort((a, b) => a - b)
    // Stacked: each series sits on the running total at each x.
    const base = new Map<number, number>()
    const drawn = shown.map(({ s, i }) => ({ s, i, pts: s.points.map(([x, y]) => { const b = stacked ? base.get(x) ?? 0 : 0; if (stacked) base.set(x, b + y); return { x, y, top: b + y, bot: b } }) }))
    const left = drawn.filter(d => !dual || d.s.axis !== 'right').flatMap(d => d.pts)
    const right = drawn.filter(d => dual && d.s.axis === 'right').flatMap(d => d.pts)
    const ly = nice(Math.min(0, ...left.map(p => p.top)), Math.max(...left.map(p => p.top)))
    const ry = nice(Math.min(0, ...right.map(p => p.top)), Math.max(...right.map(p => p.top)))
    return { xs, drawn, ly, ry, x0: xs[0] ?? 0, x1: xs.at(-1) ?? 1 }
  }, [spec, hidden, stacked])
  if (!all.length) return <div className="small muted pad">No data</div>
  const { xs, drawn, ly, ry, x0, x1 } = g
  const sx = (x: number) => L + (x1 === x0 ? 0.5 : (x - x0) / (x1 - x0)) * (W - L - R)
  const scale = ([a, b]: [number, number]) => (y: number) => T + (1 - (y - a) / (b - a)) * (H - T - B)
  const sy = scale(ly), syr = scale(ry)
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const onMove = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect()
    const x = x0 + ((e.clientX - r.left) / r.width * W - L) / (W - L - R) * (x1 - x0)
    let best = xs[0], d = Infinity
    for (const v of xs) { const dd = Math.abs(v - x); if (dd < d) { d = dd; best = v } }
    setHover(best ?? null)
  }
  const hx = hover !== null ? sx(hover) : 0
  const tip = hover !== null ? drawn.map(d => ({ ...d, v: d.pts.find(p => p.x === hover)?.y })).filter(t => t.v !== undefined).sort((a, b) => b.v! - a.v!) : []
  const color = (i: number) => PALETTE[i % PALETTE.length]
  const isRight = (s: Series) => dual && s.axis === 'right'
  return (
    <div className="viz-line">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ticks.map((f, i) => { const t = ly[0] + f * (ly[1] - ly[0]); return <g key={i}><line x1={L} x2={W - R} y1={sy(t)} y2={sy(t)} className="viz-grid" /><text x={L - 6} y={sy(t) + 3} textAnchor="end" className="viz-axis">{compact(t, spec.unit)}</text></g> })}
        {dual && ticks.map((f, i) => { const t = ry[0] + f * (ry[1] - ry[0]); return <text key={'r' + i} x={W - R + 6} y={syr(t) + 3} className="viz-axis">{compact(t, spec.rightUnit)}</text> })}
        {ticks.map((f, i) => { const t = x0 + f * (x1 - x0); return <text key={'x' + i} x={sx(t)} y={H - 6} textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'} className="viz-axis">{fmtX(t, x1 - x0)}</text> })}
        {drawn.map(({ s, i, pts }) => {
          const y = isRight(s) ? syr : sy
          const line = pts.map((p, j) => `${j ? 'L' : 'M'}${sx(p.x)},${y(p.top)}`).join(' ')
          const fill = spec.type === 'area' || stacked
          return (
            <g key={i}>
              {fill && <path d={line + ' ' + [...pts].reverse().map(p => `L${sx(p.x)},${y(p.bot)}`).join(' ') + ' Z'} fill={color(i)} opacity={stacked ? 0.35 : 0.12} />}
              <path d={line} fill="none" stroke={color(i)} strokeWidth={1.6} strokeDasharray={isRight(s) ? '5 3' : undefined} vectorEffect="non-scaling-stroke" />
            </g>
          )
        })}
        {hover !== null && <line x1={hx} x2={hx} y1={T} y2={H - B} className="viz-cross" />}
      </svg>
      {hover !== null && tip.length > 0 && (
        <div className="viz-tip" style={{ left: `${(hx / W) * 100}%`, transform: hx > W / 2 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)' }}>
          <div className="muted">{fmtX(hover, x1 - x0)}</div>
          {tip.slice(0, 8).map(t => <div key={t.i}><span className="viz-sw" style={{ background: color(t.i) }} />{t.s.name}: <b>{compact(t.v!, isRight(t.s) ? spec.rightUnit : spec.unit)}</b></div>)}
          {stacked && tip.length > 1 && <div className="muted">total: <b>{compact(tip.reduce((n, t) => n + t.v!, 0), spec.unit)}</b></div>}
        </div>
      )}
      {(series.length > 1 || series[0].name !== 'value') && (
        <div className="viz-legend small">
          {series.length > 1 && !dual && <button className="viz-toggle" onClick={() => setStack(!stack)} title="Stack the series to see the total">{stacked ? '▤ stacked' : '∿ lines'}</button>}
          {series.map((s, i) => (
            <button key={i} className={hidden.has(i) ? 'off' : ''} title="Click to hide; alt-click to show only this one"
              onClick={e => setHidden(h => e.altKey ? new Set(series.map((_, j) => j).filter(j => j !== i)) : (n => (n.has(i) ? n.delete(i) : n.add(i), n))(new Set(h)))}>
              <span className="viz-sw" style={{ background: color(i) }} />{s.name}{isRight(s) ? ' (right axis)' : ''}
            </button>
          ))}
          {all.length > MAX_SERIES && <span className="muted">+{all.length - MAX_SERIES} more series not drawn</span>}
        </div>
      )}
    </div>
  )
}

function Stats({ spec }: { spec: Of<'stat'> }) {
  return (
    <div className="viz-stats">
      {spec.stats.map((s, i) => {
        const unit = s.unit ?? spec.unit
        const delta = s.baseline !== undefined && s.baseline !== 0 ? (s.value - s.baseline) / Math.abs(s.baseline) : null
        return (
          <div key={i} className="viz-stat">
            <div className="viz-stat-val">{compact(s.value, unit)}</div>
            {s.label !== 'value' && <div className="viz-stat-label small muted" title={s.label}>{s.label}</div>}
            {delta !== null && <div className={`small ${Math.abs(delta) < 0.005 ? 'muted' : delta > 0 ? 'viz-up' : 'viz-down'}`}>{delta > 0 ? '▲' : delta < 0 ? '▼' : '■'} {+Math.abs(delta * 100).toPrecision(2)}% vs {compact(s.baseline!, unit)}</div>}
            {s.spark && s.spark.length > 1 && <Spark values={s.spark} color={PALETTE[i % PALETTE.length]} />}
          </div>
        )
      })}
    </div>
  )
}
function Spark({ values, color }: { values: number[]; color: string }) {
  const lo = Math.min(...values), hi = Math.max(...values), w = 100, h = 24
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${(i / (values.length - 1)) * w},${h - 2 - (hi === lo ? 0.5 : (v - lo) / (hi - lo)) * (h - 4)}`).join(' ')
  return <svg className="viz-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none"><path d={d} fill="none" stroke={color} strokeWidth={1.4} vectorEffect="non-scaling-stroke" /></svg>
}

function Heatmap({ spec }: { spec: Of<'heatmap'> }) {
  const [mode, setMode] = useState<'heatmap' | 'percentiles'>('heatmap')
  const [hover, setHover] = useState<{ t: number; b: number } | null>(null)
  const { buckets, times, cells } = spec
  if (!times.length || !buckets.length) return <div className="small muted pad">No data</div>
  const toggle = <div className="viz-legend small"><button className="viz-toggle" onClick={() => setMode(mode === 'heatmap' ? 'percentiles' : 'heatmap')}>{mode === 'heatmap' ? '▦ heatmap · show p50/p95/p99' : '∿ p50/p95/p99 · show heatmap'}</button></div>
  if (mode === 'percentiles') {
    const cols = times.map((_, t) => { let cum = 0; return buckets.map((le, b) => ({ le, cum: (cum += cells[b][t] ?? 0) })) })
    const series = [0.5, 0.95, 0.99].map(q => ({ name: `p${q * 100}`, points: times.map((t, j) => [t, quantile(q, cols[j])] as Point).filter(p => Number.isFinite(p[1])) }))
    return <>{toggle}<LineChart spec={{ type: 'line', unit: spec.unit, series }} /></>
  }
  const max = Math.max(...cells.flat(), 1e-12)
  const R = 10, cw = (W - L - R) / times.length, ch = (H - T - B) / buckets.length
  const label = (le: string) => le === '+Inf' ? '+Inf' : compact(leNum(le), spec.unit)
  const step = Math.ceil(buckets.length / 8)
  const span = times.at(-1)! - times[0]
  return (
    <div className="viz-line">
      {toggle}
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onMouseLeave={() => setHover(null)}>
        {buckets.map((le, b) => b % step === 0 && <text key={le} x={L - 6} y={H - B - b * ch - ch / 2 + 3} textAnchor="end" className="viz-axis">{label(le)}</text>)}
        {[0, 0.5, 1].map((f, i) => { const j = Math.min(times.length - 1, Math.round(f * (times.length - 1))); return <text key={i} x={L + j * cw + cw / 2} y={H - 6} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'} className="viz-axis">{fmtX(times[j], span)}</text> })}
        {cells.map((row, b) => row.map((v, t) => v > 0 && (
          <rect key={`${b}-${t}`} x={L + t * cw} y={H - B - (b + 1) * ch} width={cw + 0.5} height={ch + 0.5} fill="#2f6fdb" opacity={0.08 + 0.92 * Math.sqrt(v / max)} onMouseEnter={() => setHover({ t, b })} />
        )))}
        {hover && <rect x={L + hover.t * cw} y={H - B - (hover.b + 1) * ch} width={cw} height={ch} fill="none" className="viz-cross" />}
      </svg>
      {hover && <div className="viz-tip" style={{ left: `${((L + hover.t * cw) / W) * 100}%`, top: 30, transform: hover.t > times.length / 2 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)' }}>
        <div className="muted">{fmtX(times[hover.t], span)}</div>
        <div>{hover.b ? label(buckets[hover.b - 1]) : '0'} – {label(buckets[hover.b])}: <b>{compact(cells[hover.b][hover.t])}</b></div>
      </div>}
    </div>
  )
}

function Bars({ spec }: { spec: Of<'bar'> }) {
  const max = Math.max(...spec.bars.map(b => Math.abs(b.value)), 1e-12)
  return (
    <div className="viz-bars">
      {spec.bars.slice(0, 40).map((b, i) => (
        <div key={i} className="viz-bar">
          <span className="viz-bar-label" title={b.label}>{b.label}</span>
          <span className="viz-bar-track"><span style={{ width: `${(Math.abs(b.value) / max) * 100}%` }} /></span>
          <span className="viz-bar-val">{compact(b.value, spec.unit)}</span>
        </div>
      ))}
      {spec.bars.length > 40 && <div className="small muted">+{spec.bars.length - 40} more</div>}
    </div>
  )
}

function Table({ spec }: { spec: Of<'table'> }) {
  const [sort, setSort] = useState<{ col: number; desc: boolean } | null>(null)
  const rows = useMemo(() => {
    if (!sort) return spec.rows
    const num = (v: any) => (v === null || v === '' || isNaN(Number(v)) ? null : Number(v))
    return [...spec.rows].sort((a, b) => {
      const x = a[sort.col], y = b[sort.col], nx = num(x), ny = num(y)
      const c = nx !== null && ny !== null ? nx - ny : String(x ?? '').localeCompare(String(y ?? ''))
      return sort.desc ? -c : c
    })
  }, [spec.rows, sort])
  return (
    <div className="viz-table">
      <table>
        <thead><tr>{spec.columns.map((c, i) => <th key={i} onClick={() => setSort(s => ({ col: i, desc: s?.col === i ? !s.desc : true }))}>{c}{sort?.col === i ? (sort.desc ? ' ↓' : ' ↑') : ''}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={typeof v === 'number' || (v !== null && v !== '' && !isNaN(Number(v))) ? 'num' : ''}>{v === null ? '' : String(v)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

// Anything else, as Vega-Lite, loaded on first use (it's large). A spec can't fetch data or open
// links: the loader refuses every URL, so a chart only shows the data written into it.
function VegaLite({ spec }: { spec: any }) {
  const ref = useRef<HTMLDivElement>(null)
  const [err, setErr] = useState<string | null>(null)
  const key = JSON.stringify(spec)
  useEffect(() => {
    let view: { finalize(): void } | null = null, dead = false
    setErr(null)
    ;(async () => {
      try {
        const [{ default: embed }, vega] = await Promise.all([import('vega-embed'), import('vega')])
        if (dead || !ref.current) return
        const css = getComputedStyle(document.documentElement)
        const v = (n: string) => css.getPropertyValue(n).trim()
        const fg = v('--fg'), muted = v('--muted'), line = v('--line')
        const loader = vega.loader()
        loader.sanitize = async () => { throw new Error('Mothership charts only use inline data (data.values)') }
        // Vega reports a refused load asynchronously and draws nothing, so catch external data up front.
        const external = (o: any): boolean => !!o && typeof o === 'object' && (Object.entries(o).some(([k, v]) => (k === 'url' && typeof v === 'string') || external(v)))
        if (external(spec.data) || external(spec.datasets) || ['layer', 'concat', 'hconcat', 'vconcat'].some(k => Array.isArray(spec[k]) && spec[k].some((x: any) => external(x?.data))))
          throw new Error('it loads data from a URL; Mothership charts only use inline data (data.values)')
        const s = { ...spec }
        if (!['facet', 'concat', 'hconcat', 'vconcat', 'repeat'].some(k => k in s) && s.width === undefined) s.width = 'container'
        const r = await embed(ref.current, s, {
          actions: false, renderer: 'svg', loader,
          config: {
            background: 'transparent', font: '-apple-system, BlinkMacSystemFont, sans-serif',
            axis: { labelColor: muted, titleColor: muted, gridColor: line, domainColor: line, tickColor: line, labelFontSize: 10, titleFontSize: 11 },
            legend: { labelColor: fg, titleColor: muted, labelFontSize: 11 },
            title: { color: fg, fontSize: 12, anchor: 'start' },
            view: { stroke: 'transparent' },
            range: { category: PALETTE },
          } as any,
        })
        if (dead) r.finalize(); else view = r
      } catch (e: any) { if (!dead) setErr(String(e?.message ?? e)) }
    })()
    return () => { dead = true; view?.finalize() }
  }, [key])
  return <>{err && <div className="small bad">Couldn't draw this Vega-Lite chart: {err}</div>}<div ref={ref} className="viz-vega" /></>
}
