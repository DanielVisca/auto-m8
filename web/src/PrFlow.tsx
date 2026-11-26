// Where your PRs go: a flow from area → review → outcome, band width = PRs.
// Bands carry the outcome's colour all the way from the area, so "what does metrics turn into"
// reads left to right. The list under it is the table view, and what a click on the chart filters.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ago, post, useLive } from './api'
import { AgentRun } from './Search'
import { PrBadge } from './List'
import { AgentStack, usePrAgents } from './Agents'
import { FOCUS, HOLDER, RailLine, STN, type LinePick, type Train } from './RailLine'

type P = { areaKey?: string; url: string; number: number; title: string; repo: string; area: string; review: Review; outcome: Outcome; why: string; last: number; checks: string | null; created: number; merged: number | null; draft: boolean; conversation: string | null; reason?: string }
type Review = 'draft' | 'waiting' | 'changes' | 'approved' | 'none'
type Outcome = 'merged' | 'moving' | 'needs-you' | 'stalled' | 'stale' | 'abandoned'
type Flow = { days: number; prs: P[]; medianMergeHours: number | null; fetchedAt: number; refreshing?: boolean }

const REVIEWS: [Review, string][] = [['draft', 'Draft'], ['waiting', 'Waiting on review'], ['changes', 'Changes requested'], ['approved', 'Approved'], ['none', 'No review']]
// Status colours (fixed): validated adjacent in this order, light and dark. Every outcome is labelled.
export const OUTCOMES: { id: Outcome; label: string; icon: string; hint: string }[] = [
  { id: 'merged', label: 'Merged', icon: '✓', hint: 'shipped' },
  { id: 'moving', label: 'Moving', icon: '→', hint: 'worked on in the last 3 days' },
  { id: 'needs-you', label: 'Needs you', icon: '!', hint: 'changes requested, red CI, or approved and green but not merged' },
  { id: 'stalled', label: 'Stalled', icon: '‖', hint: 'no commits or reviews for 3–14 days' },
  { id: 'stale', label: 'Stale', icon: '○', hint: 'nothing for over 14 days' },
  { id: 'abandoned', label: 'Abandoned', icon: '×', hint: 'closed without merging' },
]
const MAX_AREAS = 10
type Sel = { area?: string; review?: Review; outcome?: Outcome } | null
const matches = (p: P, s: Sel) => !s || ((!s.area || p.areaKey === s.area) && (!s.review || p.review === s.review) && (!s.outcome || p.outcome === s.outcome))

const clock = (ts: number) => {
  if (!ts) return ''
  const d = new Date(ts), t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? `at ${t}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(600)
  useLayoutEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

export function PrFlow({ onOpen }: { onOpen: (id: string) => void }) {
  const [days, setDays] = useState(() => { try { const v = localStorage.getItem('perch.prflow.days'); return v != null && !isNaN(Number(v)) ? Number(v) : 90 } catch { return 90 } })
  const [owner, setOwner] = useState<string>(() => { try { return localStorage.getItem('perch.prflow.owner') ?? '' } catch { return '' } })
  const { data, loading, stale, reload } = useLive<Flow>(`/api/insights/prs?days=${days}`, ['prflow' as any], undefined, 60_000, true)
  const [kicked, setKicked] = useState(false)
  const refresh = async () => { setKicked(true); try { await post(`/api/insights/prs/refresh?days=${days}`) } finally { setKicked(false); reload() } }
  const [sel, setSel] = useState<Sel>(null)
  const [summary, setSummary] = useState<{ id: string; key: string } | null>(null)
  const [hover, setHover] = useState<Sel>(null)
  // A station picked on the line view: its PRs fill the list and the summary, like a flow selection.
  const [line, setLine] = useState<(LinePick & { trains: Train[] }) | null>(null)
  // A legend filter on the line ("needs you", a holder, stuck…). Remembered, so the line can open filtered.
  const [focus, setFocusS] = useState<string | null>(() => { try { const v = localStorage.getItem('perch.line.focus'); return v && FOCUS[v] ? v : null } catch { return null } })
  const setFocus = (f: string | null) => { setFocusS(f); try { localStorage.setItem('perch.line.focus', f ?? '') } catch {} }
  // Which picture the chart card shows: the flow (where PRs end up) or the Railyard's line (where open PRs sit now).
  const [viz, setViz] = useState<'flow' | 'line'>(() => { try { return localStorage.getItem('perch.prflow.viz') === 'line' ? 'line' : 'flow' } catch { return 'flow' } })
  const save = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch {} }
  const owners = useMemo(() => [...new Set((data?.prs ?? []).map(p => p.repo.split('/')[0]))], [data])
  // Default to the org with most PRs, so old personal repos don't crowd the work view.
  const own = owner || (owners.includes('PostHog') ? 'PostHog' : 'all')
  const prs = useMemo(() => {
    const list = (data?.prs ?? []).filter(p => own === 'all' || p.repo.startsWith(own + '/'))
    const counts = new Map<string, number>()
    for (const p of list) counts.set(p.area, (counts.get(p.area) ?? 0) + 1)
    const top = new Set([...counts].sort((a, b) => b[1] - a[1]).slice(0, MAX_AREAS).map(x => x[0]))
    return list.map(p => ({ ...p, areaKey: top.has(p.area) ? p.area : 'Other' }))
  }, [data, own])
  if (!data) return <div className="pad muted">Reading your PRs from GitHub… the first time takes about a minute.</div>
  if ((data as any).error) return <div className="pad muted">{(data as any).error}</div>

  const needsUrls = new Set(prs.filter(p => p.outcome === 'needs-you').map(p => p.url))
  const n = (o: Outcome) => prs.filter(p => p.outcome === o).length
  const shown = prs.filter(p => matches(p, sel))
  const byUrl = new Map(prs.map(p => [p.url, p]))
  // Line trains as list rows: reuse the flow's row when the PR is in range, and say where it sits on the line.
  const fromTrain = (t: Train): P => {
    const where = [`${HOLDER[t.holder]?.[1] ?? t.holder}${t.red ? ', stuck' : ''}`, t.signal.length ? `waiting on ${t.signal.map(u => '#' + u.split('/').pop()).join(', ')}` : '', t.decision ? `decision: ${t.decision.title}` : '', t.proof ? `proof ${t.proof.state.replace('_', ' ')}` : ''].filter(Boolean).join(' · ')
    const p = byUrl.get(t.url)
    const merged = ['deploy', 'check2', 'verified', 'proven'].includes(t.station)
    return { ...(p ?? { url: t.url, number: t.number, title: t.title, repo: t.repo, area: t.repo, areaKey: t.repo, review: 'none' as Review, last: Date.now(), checks: null, created: 0, merged: null, draft: t.station === 'draft', conversation: null }),
      outcome: p?.outcome ?? (merged ? 'merged' : 'moving'), why: where, reason: p?.why || t.detail }
  }
  const lineOn = viz === 'line' && line
  const attention = lineOn ? line.trains.map(fromTrain) : sel ? shown : prs.filter(p => ['needs-you', 'stalled', 'stale'].includes(p.outcome))
  const order: Outcome[] = ['needs-you', 'stalled', 'moving', 'stale', 'merged', 'abandoned']
  if (!lineOn) attention.sort((a, b) => order.indexOf(a.outcome) - order.indexOf(b.outcome) || a.last - b.last)
  const h = data.medianMergeHours
  const label = lineOn ? ['The line', line.station ? STN[line.station] ?? line.station : '', line.focus ? FOCUS[line.focus] : ''].filter(Boolean).join(' → ') : sel ? [sel.area, OUTCOMES.find(o => o.id === sel.outcome)?.label].filter(Boolean).join(' → ') : 'Needs your attention'
  const summarize = async () => {
    // What shipped in the same areas, so the agent can say what sets this selection apart.
    const areas = new Set(attention.map(p => p.areaKey))
    const contrast = !lineOn && sel?.outcome !== 'merged' ? prs.filter(p => p.outcome === 'merged' && areas.has(p.areaKey)).slice(0, 60) : []
    const r = await post<{ id: string }>('/api/insights/prs/summarize', { label, prs: attention, contrast })
    setSummary({ id: r.id, key: label })
  }
  return (
    <div className={stale ? 'flow-body is-stale' : 'flow-body'} aria-busy={stale}>
      <div className="row-flex flow-head">
        <h2 className="grow">Where your PRs go</h2>
        {owners.length > 1 && <select value={own} onChange={e => { setOwner(e.target.value); save('perch.prflow.owner', e.target.value); setSel(null) }}>
          <option value="all">All repos</option>{owners.map(o => <option key={o} value={o}>{o}</option>)}</select>}
        <select value={days} onChange={e => { setDays(Number(e.target.value)); save('perch.prflow.days', e.target.value); setSel(null) }}>
          {[0, 7, 30, 90, 180].map(d => <option key={d} value={d}>{d === 0 ? 'today' : `opened in ${d} days`}</option>)}</select>
        <span className="muted small flow-fresh" role="status" title={data.fetchedAt ? `Fetched from GitHub ${new Date(data.fetchedAt).toLocaleString()}. Refreshes on its own when older than 3 minutes.` : undefined}>
          {stale ? (loading ? `loading ${days === 0 ? 'today' : `opened in ${days} days`}…` : 'couldn’t load that range, showing the last one')
            : <>updated {clock(data.fetchedAt)}{ago(data.fetchedAt) && ` · ${ago(data.fetchedAt) === 'now' ? 'just now' : `${ago(data.fetchedAt)} ago`}`}{(data.refreshing || kicked) && ' · refreshing…'}</>}
        </span>
        <button className={`icon flow-refresh${data.refreshing || kicked ? ' spinning' : ''}`} onClick={refresh} disabled={data.refreshing || kicked || stale} title="Refresh from GitHub now" aria-label="Refresh from GitHub now">↻</button>
      </div>
      <div className="stats">
        <div className="stat"><b>{n('merged')}</b><span>shipped</span></div>
        <div className="stat"><b>{h == null ? '–' : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`}</b><span>median to merge</span></div>
        <div className="stat"><b>{n('needs-you')}</b><span>need you</span></div>
        <div className="stat"><b>{n('stalled') + n('stale')}</b><span>stalled or stale</span></div>
        <div className="stat"><b>{n('abandoned')}</b><span>abandoned</span></div>
      </div>
      <section className="card">
        <div className="row-flex flow-viz-head">
          <span className="grow muted small">{viz === 'flow' ? 'Where PRs opened in this range ended up' : 'The line, now: every open PR at its station · colour = who holds it'}</span>
          <div className="seg">{([['flow', 'Flow'], ['line', 'The line']] as const).map(([k, l]) => <button key={k} className={viz === k ? 'on' : ''} onClick={() => { setViz(k); save('perch.prflow.viz', k); setLine(null); setSel(null) }}>{l}</button>)}</div>
        </div>
        {viz === 'line' ? <RailLine picked={line?.station ?? null} focus={focus} onFocus={setFocus} needs={needsUrls} onPick={(pk, trains) => setLine(pk ? { ...pk, trains } : null)} /> : <>
        <Sankey prs={prs} sel={sel} hover={hover} setHover={setHover} onPick={s => setSel(cur => JSON.stringify(cur) === JSON.stringify(s) ? null : s)} />
        <div className="flow-legend small">
          {OUTCOMES.map(o => <span key={o.id} title={o.hint}><i className={`sw o-${o.id}`} />{o.icon} {o.label}</span>)}
        </div>
        </>}
      </section>
      <section className="card">
        <div className="row-flex">
          <h3 className="grow">{label}</h3>
          {attention.length > 0 && summary?.key !== label && <button className="link small" onClick={summarize} title="A short read of these PRs: what got done, what was dropped, and the patterns">✦ Summarize</button>}
          {(lineOn || sel) && line?.focus !== 'needs' && <button className="link small" onClick={() => { if (lineOn) { setLine(null); setFocus(viz === 'line' ? 'needs' : null) } else setSel(null) }}>show what needs you</button>}
        </div>
        {summary?.key === label && <div className="pr-summary"><button className="icon pr-summary-x" onClick={() => setSummary(null)} title="Close the summary">×</button><AgentRun id={summary.id} onOpen={onOpen} /></div>}
        {!attention.length && <div className="muted small">Nothing here.</div>}
        {attention.slice(0, 60).map(p => {
          // Hovering the tag or the PR says why this one is here, e.g. "CI is red", not the category's definition.
          const reason = p.reason ?? p.why
          const tip = reason || OUTCOMES.find(o => o.id === p.outcome)?.hint
          return (
          <div key={p.url} className="line flow-row">
            <span className={`flow-tag o-${p.outcome}`} title={tip}>{OUTCOMES.find(o => o.id === p.outcome)?.icon} {OUTCOMES.find(o => o.id === p.outcome)?.label}</span>
            <span className="grow ellipsis" title={reason || undefined}><PrBadge pr={{ url: p.url, number: p.number, title: p.title, repo: p.repo, state: p.outcome === 'merged' ? 'MERGED' : p.outcome === 'abandoned' ? 'CLOSED' : 'OPEN', draft: p.draft ? 1 : 0, review: null, checks: p.checks } as any} full reason={reason ? { label: OUTCOMES.find(o => o.id === p.outcome)?.label ?? 'Why', text: reason } : undefined} /></span>
            {['needs-you', 'stalled', 'stale'].includes(p.outcome) && <Watched url={p.url} />}
            <span className="muted small nowrap">{p.area} · {p.why || (p.merged ? `merged ${ago(p.merged)} ago` : `${ago(p.last)} ago`)}</span>
            {p.conversation && <button className="link small" onClick={() => onOpen(p.conversation!)}>open</button>}
          </div>
        )})}
        {attention.length > 60 && <div className="muted small">+{attention.length - 60} more</div>}
      </section>
    </div>
  )
}

type Seg = { key: string; area: string; outcome: Outcome; n: number; prs: P[]; x0: number; x1: number; y0: number; y1: number; t: number }
type Node = { id: string; col: number; label: string; n: number; y: number; h: number; sel: Sel; outcome?: Outcome }

function Sankey({ prs, sel, hover, setHover, onPick }: { prs: P[]; sel: Sel; hover: Sel; setHover: (s: Sel) => void; onPick: (s: Sel) => void }) {
  const [ref, W] = useWidth()
  const [tip, setTip] = useState<{ x: number; y: number; title: string; prs: P[] } | null>(null)
  const narrow = W < 520
  const H = narrow ? 320 : 380, NW = 10, PAD = 8
  // Left fits area names; right always fits "× Abandoned 999".
  const gutter = Math.min(150, Math.max(96, W * 0.22)), right = 118
  const xs = [gutter, W - right - NW]

  const layout = useMemo(() => {
    const N = prs.length
    if (!N) return null
    const areaCount = new Map<string, number>()
    for (const p of prs) areaCount.set(p.areaKey!, (areaCount.get(p.areaKey!) ?? 0) + 1)
    const areas = [...areaCount].sort((a, b) => (a[0] === 'Other' ? 1 : b[0] === 'Other' ? -1 : b[1] - a[1])).map(x => x[0])
    const outs = OUTCOMES.map(o => o.id).filter(o => prs.some(p => p.outcome === o))
    const cols: { id: string; label: string; sel: Sel; outcome?: Outcome; n: number }[][] = [
      areas.map(a => ({ id: `a:${a}`, label: a, sel: { area: a }, n: areaCount.get(a)! })),
      outs.map(o => ({ id: `o:${o}`, label: OUTCOMES.find(x => x.id === o)!.label, sel: { outcome: o }, outcome: o, n: prs.filter(p => p.outcome === o).length })),
    ]
    const most = Math.max(...cols.map(c => c.length))
    const k = (H - PAD * (most - 1)) / N
    const nodes = new Map<string, Node>()
    cols.forEach((c, ci) => {
      const used = c.reduce((s, x) => s + Math.max(2, x.n * k), 0) + PAD * (c.length - 1)
      let y = (H - used) / 2
      for (const x of c) { const h = Math.max(2, x.n * k); nodes.set(x.id, { ...x, col: ci, y, h }); y += h + PAD }
    })
    // One band per (area, outcome): out of each area in outcome order, into each outcome in area order,
    // so bands only cross where the work really goes somewhere else.
    const groups = new Map<string, P[]>()
    for (const p of prs) { const g = `${p.areaKey}|${p.outcome}`; groups.set(g, [...(groups.get(g) ?? []), p]) }
    const ai = (a: string) => areas.indexOf(a), oi = (o: Outcome) => outs.indexOf(o)
    const keys = [...groups.keys()].map(g => g.split('|') as [string, Outcome])
    const cursor = new Map<string, number>()
    const take = (id: string, h: number) => { const y = cursor.get(id) ?? nodes.get(id)!.y; cursor.set(id, y + h); return y }
    const y0 = new Map<string, number>()
    for (const [a, o] of [...keys].sort((x, y) => ai(x[0]) - ai(y[0]) || oi(x[1]) - oi(y[1]))) y0.set(`${a}|${o}`, take(`a:${a}`, groups.get(`${a}|${o}`)!.length * k))
    const bands: Seg[] = []
    for (const [a, o] of [...keys].sort((x, y) => oi(x[1]) - oi(y[1]) || ai(x[0]) - ai(y[0]))) {
      const list = groups.get(`${a}|${o}`)!, t = list.length * k
      bands.push({ key: `${a}|${o}`, area: a, outcome: o, n: list.length, prs: list, x0: xs[0] + NW, x1: xs[1], y0: y0.get(`${a}|${o}`)!, y1: take(`o:${o}`, t), t })
    }
    return { nodes: [...nodes.values()], bands }
  }, [prs, W, H])

  if (!layout) return <div ref={ref} className="muted small">No PRs in this window.</div>
  const band = (s: Seg) => { const m = (s.x0 + s.x1) / 2; return `M${s.x0},${s.y0} C${m},${s.y0} ${m},${s.y1} ${s.x1},${s.y1} L${s.x1},${s.y1 + s.t} C${m},${s.y1 + s.t} ${m},${s.y0 + s.t} ${s.x0},${s.y0 + s.t} Z` }
  const focus = hover ?? sel
  const lit = (s: Seg) => !focus || ((!focus.area || s.area === focus.area) && (!focus.outcome || s.outcome === focus.outcome))
  const show = (e: React.MouseEvent, title: string, list: P[]) => { const r = (e.currentTarget as Element).closest('svg')!.getBoundingClientRect(); setTip({ x: e.clientX - r.left, y: e.clientY - r.top, title, prs: list }) }
  // Labels: never overlap; pushed apart by at least one line.
  const placed = (col: number) => {
    const ns = layout.nodes.filter(n => n.col === col)
    let prev = -Infinity
    return ns.map(n => { const y = Math.max(n.y + n.h / 2, prev + 14); prev = y; return { n, y } })
  }
  return (
    <div ref={ref} className="sankey" onMouseLeave={() => { setHover(null); setTip(null) }}>
      <svg width={W} height={H + 8} viewBox={`0 -4 ${W} ${H + 8}`} role="img" aria-label="Flow of your pull requests from area, through review, to outcome">
        <defs>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" className="o-abandoned-fill" /><line x1="0" y1="0" x2="0" y2="6" className="hatch-line" /></pattern>
        </defs>
        {layout.bands.map(s => (
          <path key={s.key} d={band(s)} className={`band o-${s.outcome}${lit(s) ? (focus ? ' lit' : '') : ' dim'}`}
            onMouseMove={e => { setHover({ area: s.area, outcome: s.outcome }); show(e, `${s.area} → ${OUTCOMES.find(o => o.id === s.outcome)!.label}`, s.prs) }}
            onClick={() => onPick({ area: s.area, outcome: s.outcome })} />
        ))}
        {layout.nodes.map(n => (
          <g key={n.id} className="node" onClick={() => onPick(n.sel)}
            onMouseMove={e => { setHover(n.sel); show(e, n.label, prs.filter(p => matches(p, n.sel))) }}>
            <rect x={xs[n.col] - 4} y={n.y - 2} width={NW + 8} height={n.h + 4} fill="transparent" />
            <rect x={xs[n.col]} y={n.y} width={NW} height={n.h} rx={2} className={n.outcome ? `nfill o-${n.outcome}` : 'nfill neutral'} />
          </g>
        ))}
        {[0, 1].map(col => placed(col).map(({ n, y }) => (
          <text key={n.id} x={col === 0 ? xs[0] - 6 : xs[1] + NW + 6} y={Math.min(H, y)} dy="0.35em"
            textAnchor={col === 0 ? 'end' : 'start'} className="slabel" onClick={() => onPick(n.sel)}>
            {col === 1 && `${OUTCOMES.find(o => o.id === n.outcome)!.icon} `}{col === 1 ? n.label : trim(n.label, Math.floor(gutter / 6.6) - 3)} <tspan className="scount">{n.n}</tspan>
          </text>
        )))}
      </svg>
      {tip && (
        <div className="flow-tip" style={{ left: Math.min(tip.x + 12, W - 260), top: tip.y + 14 }}>
          <b>{tip.title}</b> · {tip.prs.length} PR{tip.prs.length === 1 ? '' : 's'}
          <div className="muted">{REVIEWS.map(([r, l]) => [l, tip.prs.filter(p => p.review === r).length] as const).filter(x => x[1]).map(([l, c]) => `${c} ${l.toLowerCase()}`).join(' · ')}</div>
          {tip.prs.slice(0, 5).map(p => <div key={p.url} className="ellipsis muted">#{p.number} {p.title}</div>)}
          <div className="muted">{tip.prs.length > 5 ? `+${tip.prs.length - 5} more · ` : ''}click to list them</div>
        </div>
      )}
    </div>
  )
}

const trim = (s: string, n: number) => s.length > n ? s.slice(0, Math.max(3, n - 1)) + '…' : s

// Open work either has an agent on it or it's sitting idle: say which.
function Watched({ url }: { url: string }) {
  const ws = usePrAgents(url)
  return ws.length ? <AgentStack list={ws} size={14} /> : <span className="small muted nowrap">idle</span>
}
