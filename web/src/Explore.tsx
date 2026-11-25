// Architecture explorer: a map of a repo built from its files and git history, so you can see what is built on
// what, watch it evolve, drill into the evidence, ask a chat that's handed exactly what you're looking at,
// and sketch "what if" changes. The map is deterministic; the chat explains and must cite files.
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, post, sendChat, shortPath, toast } from './api'
import { MiniChat } from './Mini'
import './explore.css'

type Evidence = { file: string; line: number; text: string; github?: string | null; local?: string }
type Edge = { from: string; to: string; kind: 'fk' | 'import'; weight: number; evidence: Evidence[] }
type Node = { id: string; name: string; path: string; files: number; models: string[]; role: 'focus' | 'dependency' | 'dependent' | 'both' | 'second'; score: number; hub: boolean }
type GraphRes = { repo: string; sha: string; focus: string | null; nodes: Node[]; edges: Edge[]; hidden: { dependencies: number; dependents: number; second: number; hubs: string[] }; total: number; names: string[]; remote: { owner: string; name: string } | null }
type Commit = { sha: string; date: string; author: string; subject: string; pr: number | null; url: string | null }
type Ev = { date: string; kind: 'concept' | 'edge'; id: string; from?: string; to?: string; approx: boolean; source: string; commit: Commit }
type Timeline = { status: 'running' | 'done'; done: number; total: number; source: string; shallow: boolean; since: string | null; events: Ev[]; milestones: Record<string, Commit[]>; error?: string }
type Op = { op: 'remove'; id: string } | { op: 'add'; id: string; name?: string; dependsOn?: string[]; usedBy?: string[] }
type DreamRes = { removed: string[]; added: { id: string; name: string }[]; broken: { id: string; loses: { to: string; kind: string; weight: number }[] }[]; affected: { id: string; depth: number; via: string }[]; orphaned: string[]; edgesAdded: Edge[]; warnings: string[]; summary: string }

const W = 1000, H = 640
const qs = (o: Record<string, string | null | undefined>) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join('&')
const recentRepos = (): string[] => { try { return JSON.parse(localStorage.getItem('perch.explore.repos') ?? '[]') } catch { return [] } }
const label = (id: string) => id.split('/').pop() ?? id
const radius = (files: number) => Math.min(26, 7 + 2.6 * Math.log2(files + 1))

// Left: what the focus is built on. Right: what's built on it. Middle: the focus, and links both ways.
function layout(nodes: Node[]) {
  const pos = new Map<string, { x: number; y: number }>()
  const cols: Record<string, Node[]> = { dependency: [], bothL: [], center: [], bothR: [], dependent: [] }
  let flip = false
  for (const n of [...nodes].sort((a, b) => b.score - a.score)) {
    if (n.role === 'both') { (flip ? cols.bothR : cols.bothL).push(n); flip = !flip }
    else if (n.role === 'focus' || n.role === 'second') cols.center.push(n)
    else cols[n.role].push(n)
  }
  // Focus first in the middle column, second-hop below it.
  cols.center.sort((a, b) => (a.role === 'focus' ? 0 : 1) - (b.role === 'focus' ? 0 : 1))
  const xs: Record<string, number> = { dependency: 110, bothL: 300, center: 500, bothR: 700, dependent: 890 }
  if (!nodes.some(n => n.role === 'focus')) {
    // No focus: a circle, biggest first.
    nodes.forEach((n, i) => { const a = (i / nodes.length) * Math.PI * 2 - Math.PI / 2; pos.set(n.id, { x: W / 2 + Math.cos(a) * 380, y: H / 2 + Math.sin(a) * 260 }) })
    return pos
  }
  for (const [k, list] of Object.entries(cols)) list.forEach((n, i) => pos.set(n.id, { x: xs[k] + (list.length > 7 ? (i % 2 ? 28 : -28) : 0), y: (H / (list.length + 1)) * (i + 1) }))
  return pos
}

export function Explore({ initialRepo, onOpenChat }: { initialRepo?: string; onOpenChat: (id: string) => void }) {
  const [repo, setRepo] = useState(() => initialRepo || recentRepos()[0] || '')
  const [repoInput, setRepoInput] = useState(repo)
  const [focus, setFocus] = useState(() => localStorage.getItem('perch.explore.focus') ?? '')
  const [focusInput, setFocusInput] = useState(focus)
  const [hubs, setHubs] = useState(false)
  const [allLinks, setAllLinks] = useState(false)
  const [g, setG] = useState<GraphRes | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [tl, setTl] = useState<Timeline | null>(null)
  const [step, setStep] = useState<number | null>(null) // null = now
  const [playing, setPlaying] = useState(false)
  const [active, setActive] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [dreaming, setDreaming] = useState(false)
  const [ops, setOps] = useState<Op[]>([])
  const [dreamRes, setDreamRes] = useState<DreamRes | null>(null)
  const [chatId, setChatId] = useState<string | null>(() => repo ? localStorage.getItem(`perch.explore.chat.${repo}`) : null)
  const [lastCtx, setLastCtx] = useState('')
  const [ask, setAsk] = useState('')
  const drag = useRef<{ x: number; y: number; x2: number; y2: number } | null>(null)
  const [box, setBox] = useState<{ x: number; y: number; x2: number; y2: number } | null>(null)
  const svg = useRef<SVGSVGElement>(null)

  useEffect(() => {
    if (!repo) return
    let gone = false
    setLoading(true); setErr(''); setTl(null); setStep(null); setPlaying(false)
    api.get<GraphRes>(`/api/explore/graph?${qs({ repo, focus, hubs: hubs ? '1' : '' })}`)
      .then(r => { if (gone) return; setG(r); localStorage.setItem('perch.explore.repos', JSON.stringify([r.repo, ...recentRepos().filter(x => x !== r.repo && x !== repo)].slice(0, 8))); localStorage.setItem('perch.explore.focus', focus) })
      .catch(e => !gone && setErr(String(e?.message ?? e)))
      .finally(() => !gone && setLoading(false))
    return () => { gone = true }
  }, [repo, focus, hubs])
  useEffect(() => { setChatId(repo ? localStorage.getItem(`perch.explore.chat.${repo}`) : null); setLastCtx('') }, [repo])

  // History loads in the background (GitHub calls on shallow clones take a while): poll until it's done.
  useEffect(() => {
    if (!g) return
    let gone = false, t: ReturnType<typeof setTimeout>
    const load = () => api.get<Timeline>(`/api/explore/timeline?${qs({ repo: g.repo, focus: g.focus })}`).then(r => { if (gone) return; setTl({ ...r, events: [...r.events] }); if (r.status === 'running') t = setTimeout(load, 1500) }).catch(() => {})
    load()
    return () => { gone = true; clearTimeout(t) }
  }, [g?.repo, g?.sha, g?.focus])

  const ids = useMemo(() => new Set(g?.nodes.map(n => n.id) ?? []), [g])
  const events = useMemo(() => (tl?.events ?? []).filter(e => e.kind === 'concept' ? ids.has(e.id) : ids.has(e.from!) && ids.has(e.to!)), [tl, ids])
  const intro = useMemo(() => new Map(events.map(e => [e.id, e.date])), [events])
  // One step per commit: a concept and the links estimated from it arrive together.
  const steps = useMemo(() => { const out: Ev[][] = []; for (const e of events) { const last = out[out.length - 1]; if (last && last[0].commit.sha === e.commit.sha) last.push(e); else out.push([e]) } return out }, [events])
  const group = step == null ? null : steps[Math.min(step, steps.length - 1)] ?? null
  const at = group ? group.find(e => e.kind === 'concept') ?? group[0] : null
  const T = group ? group[group.length - 1].date : null
  const visible = (id: string) => !T || !intro.has(id) || intro.get(id)! <= T
  const edgeVisible = (e: Edge) => visible(e.from) && visible(e.to) && (!T || !intro.has(`${e.from}→${e.to}`) || intro.get(`${e.from}→${e.to}`)! <= T)
  const fresh = (id: string) => !!group && group.some(e => e.id === id)
  // Only the links that explain the focus are drawn; links between neighbours turn a view into a hairball.
  // Clicking a concept draws its links too. With no focus, only the strongest links.
  const drawn = useMemo(() => {
    if (!g || allLinks) return null
    const F = new Set(g.nodes.filter(n => n.role === 'second').map(n => n.id))
    if (!g.nodes.some(n => n.role === 'focus')) return new Set([...g.edges].sort((a, b) => b.weight - a.weight).slice(0, 40))
    const ok = new Set(g.nodes.filter(n => n.role === 'focus').map(n => n.id))
    // Two-hop nodes: just their strongest link back into the view, so you can see why they're here.
    const why = g.nodes.filter(n => n.role === 'second').map(n => g.edges.filter(e => (e.from === n.id || e.to === n.id) && !F.has(e.from === n.id ? e.to : e.from)).sort((a, b) => b.weight - a.weight)[0]).filter(Boolean)
    return new Set([...g.edges.filter(e => ok.has(e.from) || ok.has(e.to)), ...why])
  }, [g, allLinks])

  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => setStep(s => { const n = (s ?? -1) + 1; if (n >= steps.length) { setPlaying(false); return null } return n }), 1800)
    return () => clearInterval(t)
  }, [playing, steps.length])

  useEffect(() => {
    if (!g || !ops.length) { setDreamRes(null); return }
    post<DreamRes>('/api/explore/dream', { repo: g.repo, focus: g.focus, ops }).then(setDreamRes).catch(e => toast(String(e?.message ?? e), { kind: 'error' }))
  }, [ops, g?.repo, g?.focus])

  const pos = useMemo(() => {
    const p = layout(g?.nodes ?? [])
    // Dreamed-up nodes sit in the top band, so they never land on a real one.
    ops.filter(o => o.op === 'add').forEach((o, i) => p.set(o.id, { x: 200 + i * 150, y: 36 }))
    return p
  }, [g, ops])
  const removed = new Set(dreamRes?.removed ?? []), broken = new Set(dreamRes?.broken.map(b => b.id) ?? []), affected = new Set(dreamRes?.affected.map(a => a.id) ?? [])

  const pick = (id: string, multi: boolean) => {
    setActive(id)
    setSelected(s => multi ? (s.includes(id) ? s.filter(x => x !== id) : [...s, id]) : [id])
  }
  const svgPoint = (e: React.PointerEvent) => { const r = svg.current!.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H } }

  // What the chat is told about the current view: facts from the map with their sources, and how to treat them.
  const context = () => {
    if (!g) return ''
    const sel = selected.length ? selected : active ? [active] : g.nodes.filter(n => n.role === 'focus').map(n => n.id)
    const lines = [`[Architecture explorer] repo ${g.repo} at ${g.sha.slice(0, 12)}${g.focus ? `, focus “${g.focus}”` : ''}${T ? `, timeline paused at ${T.slice(0, 10)}` : ''}.`]
    for (const id of sel) {
      const n = g.nodes.find(x => x.id === id); if (!n) continue
      lines.push(`- ${n.id} (${n.files} files${n.models.length ? `; models: ${n.models.slice(0, 12).join(', ')}` : ''})`)
      for (const e of g.edges.filter(e => e.from === id || e.to === id).sort((a, b) => b.weight - a.weight).slice(0, 6))
        lines.push(`  ${e.from} → ${e.to} (${e.kind}, ${e.weight} file${e.weight === 1 ? '' : 's'}), e.g. ${e.evidence[0] ? `${e.evidence[0].file}:${e.evidence[0].line} \`${e.evidence[0].text.slice(0, 140)}\`` : ''}`)
    }
    if (dreamRes) lines.push(`Dream in progress: ${dreamRes.summary}`)
    lines.push('This map comes from imports and foreign keys only, so it can miss runtime links (Celery tasks, Kafka topics, HTTP calls, signals). Verify what you say against the code in this repo and cite file:line; say when you are unsure instead of guessing.')
    return lines.join('\n')
  }
  const send = async (q: string) => {
    if (!g || !q.trim()) return
    const ctx = context()
    const prompt = ctx === lastCtx ? q.trim() : `${ctx}\n\n${q.trim()}`
    try {
      if (chatId) await sendChat({ id: chatId, prompt })
      else {
        const r = await sendChat<{ id: string }>({ prompt, cwd: g.repo, noRoute: true })
        setChatId(r.id); localStorage.setItem(`perch.explore.chat.${g.repo}`, r.id)
      }
      setLastCtx(ctx); setAsk('')
    } catch (e: any) { toast(String(e?.message ?? e), { kind: 'error' }) }
  }
  const newChat = () => { if (g) localStorage.removeItem(`perch.explore.chat.${g.repo}`); setChatId(null); setLastCtx('') }

  const saveDream = async (plan: boolean) => {
    if (!g || !dreamRes) return
    const name = prompt('Name this dream', ops.map(o => o.op === 'remove' ? `remove ${label(o.id)}` : `add ${o.name ?? o.id}`).join(', '))
    if (name == null) return
    const r = await post<{ id: string; path: string }>('/api/explore/dream/save', { repo: g.repo, sha: g.sha, focus: g.focus, name, ops, result: dreamRes })
    toast(`Saved dream ${r.id}`, { kind: 'ok' })
    if (plan) {
      const p = `${context()}\n\nI saved a design “dream” at ${r.path}: ${name}.\nOps: ${JSON.stringify(ops)}\nWhat the map says would happen: ${dreamRes.summary}\nBroken: ${dreamRes.broken.map(b => `${b.id} (loses ${b.loses.map(l => `${l.to} via ${l.kind}`).join(', ')})`).join('; ') || 'none'}\nAffected further out: ${dreamRes.affected.map(a => a.id).join(', ') || 'none'}\n\nTurn this into an implementation plan, but don't change any code yet. First check the map against the code (it only sees imports and foreign keys, so look for runtime links too: tasks, Kafka topics, API calls, frontend routes). Then list the work packages in order, the data migrations, and the production checks that would show impact before and after (queries and where to run them). Call out anything that makes this a bad idea.`
      const c = await sendChat<{ id: string }>({ prompt: p, cwd: g.repo, noRoute: true })
      onOpenChat(c.id)
    }
  }

  const nodeById = (id: string) => g?.nodes.find(n => n.id === id)
  const focusNames = g?.nodes.filter(n => n.role === 'focus').map(n => label(n.id)) ?? []

  return (
    <div className="explore">
      <div className="explore-bar">
        <input className="explore-repo" list="explore-repos" value={repoInput} placeholder="Repo path, e.g. ~/Development/posthog" onChange={e => setRepoInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') setRepo(repoInput.trim()) }} />
        <datalist id="explore-repos">{recentRepos().map(r => <option key={r} value={r} />)}</datalist>
        <input className="explore-focus" list="explore-names" value={focusInput} placeholder="Focus on a concept: dashboard, insight, alert…" onChange={e => setFocusInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { setRepo(repoInput.trim()); setFocus(focusInput.trim()); setActive(null); setSelected([]) } }} />
        <datalist id="explore-names">{g?.names.slice(0, 2000).map(n => <option key={n} value={n} />)}</datalist>
        <button onClick={() => { setRepo(repoInput.trim()); setFocus(focusInput.trim()); setActive(null); setSelected([]) }}>Map</button>
        <label className="small"><input type="checkbox" checked={hubs} onChange={e => setHubs(e.target.checked)} /> show shared foundations</label>
        <label className="small"><input type="checkbox" checked={allLinks} onChange={e => setAllLinks(e.target.checked)} /> all links</label>
        <button className={dreaming ? 'primary' : ''} onClick={() => { setDreaming(!dreaming); if (dreaming) setOps([]) }} title="Sketch a change: remove or add concepts and see what breaks">{dreaming ? 'Leave dream mode' : 'Dream mode'}</button>
      </div>
      {!repo && <div className="card muted">Pick a git repo to map. Everything on the map comes from its files and history: each concept, link, date and author can be traced to a file or commit.</div>}
      {err && <div className="card bad">{err}</div>}
      {g && (
        <div className="explore-main">
          <div className="explore-stage">
            <div className="explore-legend small muted">
              {g.focus ? <>Left: what {focusNames.join(', ') || g.focus} is built on · Right: what's built on it · Middle: links both ways</> : <>The {g.nodes.length} most connected of {g.total} modules. Focus on one to see what it's built on.</>}
              {' · '}<span className="lg-fk">━</span> foreign key <span className="lg-imp">┅</span> import · {shortPath(g.repo)} @ {g.sha.slice(0, 8)}
              {loading && <> · <i className="spin" /> mapping…</>}
            </div>
            <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="explore-svg"
              onPointerDown={e => { if (e.target === svg.current) { const p = svgPoint(e); drag.current = { x: p.x, y: p.y, x2: p.x, y2: p.y } } }}
              onPointerMove={e => { if (drag.current) { const p = svgPoint(e); drag.current = { ...drag.current, x2: p.x, y2: p.y }; setBox({ ...drag.current }) } }}
              onPointerUp={e => {
                const b = drag.current; drag.current = null; setBox(null)
                if (!b) return
                // Drag a box to put several concepts in the chat's context at once.
                if (Math.abs(b.x2 - b.x) < 6 && Math.abs(b.y2 - b.y) < 6) { if (!e.shiftKey) { setSelected([]); setActive(null) } return }
                const [x1, x2, y1, y2] = [Math.min(b.x, b.x2), Math.max(b.x, b.x2), Math.min(b.y, b.y2), Math.max(b.y, b.y2)]
                const inside = g.nodes.filter(n => { const p = pos.get(n.id)!; return p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2 && visible(n.id) }).map(n => n.id)
                setSelected(s => e.shiftKey ? [...new Set([...s, ...inside])] : inside)
              }}>
              <defs>
                <marker id="ex-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--muted)" /></marker>
                <marker id="ex-arrow-fk" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--accent)" /></marker>
              </defs>
              {[...g.edges, ...(dreamRes?.edgesAdded ?? [])].map((e, i) => {
                const a = pos.get(e.from), b = pos.get(e.to)
                if (!a || !b || !edgeVisible(e)) return null
                if (drawn && e.evidence.length && !drawn.has(e) && e.from !== active && e.to !== active) return null
                const rb = radius(nodeById(e.to)?.files ?? 1) + 3
                const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1
                const ex = b.x - (dx / len) * rb, ey = b.y - (dy / len) * rb
                // Curve the fk and import links between the same pair apart, so both stay visible.
                const bend = e.kind === 'fk' ? 0.12 : -0.08
                const mx = (a.x + ex) / 2 - dy * bend, my = (a.y + ey) / 2 + dx * bend
                const hot = active && (e.from === active || e.to === active)
                const gone = removed.has(e.from) || removed.has(e.to)
                const isNew = !e.evidence.length
                return <path key={i} d={`M${a.x},${a.y} Q${mx},${my} ${ex},${ey}`}
                  className={`ex-edge ${e.kind} ${hot ? 'hot' : ''} ${gone ? 'gone' : ''} ${isNew ? 'dreamed' : ''} ${fresh(`${e.from}→${e.to}`) ? 'fresh' : ''}`}
                  strokeWidth={Math.min(6, 0.8 + Math.log2(e.weight + 1))} markerEnd={`url(#${e.kind === 'fk' ? 'ex-arrow-fk' : 'ex-arrow'})`}>
                  <title>{`${e.from} → ${e.to}\n${e.kind === 'fk' ? 'foreign key' : 'import'} in ${e.weight} file${e.weight === 1 ? '' : 's'}\n${e.evidence.slice(0, 3).map(x => `${x.file}:${x.line}  ${x.text.slice(0, 100)}`).join('\n')}`}</title>
                </path>
              })}
              {g.nodes.map(n => {
                const p = pos.get(n.id)!
                const show = visible(n.id)
                if (!show && T) return null
                const r = radius(n.files)
                const cls = ['ex-node', n.role, n.hub ? 'hub' : '', active === n.id ? 'active' : '', selected.includes(n.id) ? 'sel' : '', removed.has(n.id) ? 'gone' : '', broken.has(n.id) ? 'broken' : '', affected.has(n.id) ? 'affected' : '', fresh(n.id) ? 'fresh' : '', T && !intro.has(n.id) ? 'undated' : ''].join(' ')
                return (
                  <g key={n.id} className={cls} transform={`translate(${p.x},${p.y})`} onPointerDown={e => e.stopPropagation()}
                    onClick={e => pick(n.id, e.shiftKey || e.metaKey)}
                    onContextMenu={e => { e.preventDefault(); if (dreaming) setOps(o => o.some(x => x.op === 'remove' && x.id === n.id) ? o.filter(x => !(x.op === 'remove' && x.id === n.id)) : [...o, { op: 'remove', id: n.id }]) }}>
                    <circle r={r} />
                    <text y={r + 13} textAnchor="middle">{label(n.id)}</text>
                    <title>{`${n.id}\n${n.files} files${n.models.length ? `\nmodels: ${n.models.slice(0, 10).join(', ')}${n.models.length > 10 ? '…' : ''}` : ''}${intro.has(n.id) ? `\nfirst seen ${intro.get(n.id)!.slice(0, 10)}` : ''}`}</title>
                  </g>
                )
              })}
              {ops.filter((o): o is Extract<Op, { op: 'add' }> => o.op === 'add').map(o => { const p = pos.get(o.id)!; return <g key={o.id} className="ex-node dreamed" transform={`translate(${p.x},${p.y})`}><circle r={12} /><text y={26} textAnchor="middle">{o.name ?? o.id}</text></g> })}
              {box && <rect className="ex-box" x={Math.min(box.x, box.x2)} y={Math.min(box.y, box.y2)} width={Math.abs(box.x2 - box.x)} height={Math.abs(box.y2 - box.y)} />}
            </svg>
            {g.focus && (g.hidden.dependencies + g.hidden.dependents + g.hidden.hubs.length > 0) && (
              <div className="small muted explore-hidden">
                Not drawn: {g.hidden.dependencies} more it builds on, {g.hidden.dependents} more built on it{g.hidden.second ? `, ${g.hidden.second} two hops out` : ''}.
                {g.hidden.hubs.length > 0 && <> {g.hidden.hubs.length} shared foundations used by almost everything (<span title={g.hidden.hubs.join('\n')}>{g.hidden.hubs.slice(0, 4).map(label).join(', ')}{g.hidden.hubs.length > 4 ? '…' : ''}</span>) are hidden; tick “show shared foundations” to draw them.</>}
              </div>
            )}
            <TimelineBar tl={tl} steps={steps} step={step} setStep={s => { setPlaying(false); setStep(s) }} playing={playing} setPlaying={setPlaying} at={at} />
          </div>
          <aside className="explore-side">
            {dreaming && <DreamPanel g={g} ops={ops} setOps={setOps} res={dreamRes} active={active} onSave={saveDream} />}
            {active ? <NodePanel repo={g.repo} id={active} milestones={tl?.milestones[active]} introduced={events.find(e => e.kind === 'concept' && e.id === active)}
              onFocus={id => { setFocus(id); setFocusInput(id); setActive(null); setSelected([]) }}
              onAsk={() => send(`Explain ${active}: what it is responsible for, how its data is stored, and why it depends on the modules it does. Start from the docs and models listed.`)}
              onRemove={() => { setDreaming(true); setOps(o => [...o, { op: 'remove', id: active }]) }} />
              : !dreaming && <div className="card muted small">Click a concept to see what it is, what it's built on, what's built on it, and where that's written. Shift-click or drag a box to select several, then ask about them below. Press play on the timeline to watch the system grow.</div>}
            <div className="explore-chat card">
              <div className="explore-chat-head small">
                <b>Ask</b>
                <span className="muted ellipsis">{(selected.length ? selected : active ? [active] : []).map(label).join(', ') || (g.focus ? `focus: ${g.focus}` : 'whole map')}{T ? ` · at ${T.slice(0, 10)}` : ''}</span>
                {chatId && <><button className="link small" onClick={() => onOpenChat(chatId)}>open chat</button><button className="link small" onClick={newChat}>new</button></>}
              </div>
              <textarea value={ask} placeholder="Ask about what you've selected. The map's evidence is sent with it, and the agent is told to check the code and cite files." onChange={e => setAsk(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(ask) } }} />
              {chatId && <div className="explore-reply"><MiniChat id={chatId} bare readOnly="Reply from the box above, so it carries what you're looking at." /></div>}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

function TimelineBar({ tl, steps, step, setStep, playing, setPlaying, at }: { tl: Timeline | null; steps: Ev[][]; step: number | null; setStep: (s: number | null) => void; playing: boolean; setPlaying: (p: boolean) => void; at: Ev | null }) {
  if (!tl) return <div className="explore-tl small muted">Loading history…</div>
  const n = steps.length
  const extra = step == null ? 0 : (steps[step]?.length ?? 1) - 1
  return (
    <div className="explore-tl">
      <div className="explore-tl-controls">
        <button className="small" disabled={!n} onClick={() => setStep(step == null ? 0 : Math.max(0, step - 1))}>◀ Prev</button>
        <button className="small" disabled={!n} onClick={() => { if (step == null) setStep(0); setPlaying(!playing) }}>{playing ? '❚❚ Pause' : '▶ Play'}</button>
        <button className="small" disabled={!n} onClick={() => setStep(step == null ? 0 : step + 1 >= n ? null : step + 1)}>{step == null ? 'From the start ▶' : 'Next ▶'}</button>
        <input type="range" min={0} max={n} value={step == null ? n : step} onChange={e => { const v = Number(e.target.value); setStep(v >= n ? null : v) }} disabled={!n} />
        <span className="small muted">{step == null ? 'Now' : `${step + 1} / ${n}`}</span>
      </div>
      {at ? (
        <div className="explore-caption">
          <b>{at.date.slice(0, 7)}</b>{at.approx ? ' ≈' : ''} — {at.kind === 'concept' ? <><b>{label(at.id)}</b> appears</> : <><b>{label(at.from!)}</b> starts building on <b>{label(at.to!)}</b></>}
          {' '}by {at.commit.author}{at.commit.url ? <> · <a href={at.commit.url} target="_blank" rel="noreferrer">{at.commit.pr ? `#${at.commit.pr}` : at.commit.sha.slice(0, 8)}</a></> : null}: <span className="muted">{at.commit.subject}</span>
          <div className="tiny muted">{at.source}{extra > 0 ? ` · +${extra} more link${extra === 1 ? '' : 's'} at this step` : ''}</div>
        </div>
      ) : (
        <div className="small muted">
          {tl.status === 'running' ? <><i className="spin" /> Reading history {tl.done}/{tl.total}{tl.source ? ` from ${tl.source}` : ''}…</> : `${n} moments in the history of this view. Press play to watch it grow.`}
          {tl.status === 'done' && tl.source && <> Source: {tl.source}.</>}
          {tl.shallow && <> Dates marked ≈ are estimates: this clone is shallow, and a module that moved folders shows when it moved.</>}
          {tl.error && <> {tl.error}</>}
        </div>
      )}
    </div>
  )
}

function NodePanel({ repo, id, milestones, introduced, onFocus, onAsk, onRemove }: { repo: string; id: string; milestones?: Commit[]; introduced?: Ev; onFocus: (id: string) => void; onAsk: () => void; onRemove: () => void }) {
  const [d, setD] = useState<any>(null)
  const [more, setMore] = useState<Record<string, boolean>>({})
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => { setD(null); api.get(`/api/explore/node?${qs({ repo, id })}`).then(setD).catch(e => setD({ error: String(e?.message ?? e) })) }, [repo, id])
  if (!d) return <div className="card small muted"><i className="spin" /> Loading {id}…</div>
  if (d.error) return <div className="card bad small">{d.error}</div>
  const openLocal = (file: string, line?: number) => post('/api/explore/open', { repo, file, line }).catch(e => toast(String(e?.message ?? e), { kind: 'error' }))
  const Loc = ({ x }: { x: { file: string; line?: number; github?: string | null } }) => (
    <span className="ex-loc"><button className="link" title="Open in your editor" onClick={() => openLocal(x.file, x.line)}>{x.file}{x.line ? `:${x.line}` : ''}</button>{x.github && <a className="muted" href={x.github} target="_blank" rel="noreferrer" title="On GitHub at the mapped commit"> ↗</a>}</span>
  )
  const Edges = ({ title, list, other }: { title: string; list: any[]; other: 'from' | 'to' }) => {
    const all = more[title], shown = all ? list : list.slice(0, 5)
    return (
      <div className="ex-sec">
        <h5>{title} <span className="muted">{list.length}</span></h5>
        {!list.length && <div className="muted small">Nothing.</div>}
        {shown.map(e => {
          const k = `${title}:${e[other]}:${e.kind}`
          return (
            <div key={k} className="small">
              <button className="link" onClick={() => setOpen(open === k ? null : k)}>{open === k ? '▾' : '▸'}</button>{' '}
              <button className="link" onClick={() => onFocus(e[other])} title="Focus the map here">{e[other]}</button>{' '}
              <span className={`muted ex-kind ${e.kind}`}>{e.kind === 'fk' ? 'foreign key' : 'import'} · {e.weight}</span>
              {open === k && <div className="ex-evidence">{e.evidence.map((x: any, i: number) => <div key={i}><Loc x={x} /><code>{x.text}</code></div>)}{e.weight > e.evidence.length && <div className="muted tiny">+{e.weight - e.evidence.length} more files</div>}</div>}
            </div>
          )
        })}
        {list.length > 5 && <button className="link small" onClick={() => setMore(m => ({ ...m, [title]: !all }))}>{all ? 'fewer' : `+${list.length - 5} more`}</button>}
      </div>
    )
  }
  return (
    <div className="card explore-node">
      <div className="ex-title"><b>{d.concept.name}</b> <span className="muted small">{d.concept.path} · {d.concept.files} files</span></div>
      <div className="ex-actions small">
        <button className="small" onClick={onAsk}>Ask about this</button>
        <button className="small" onClick={() => onFocus(d.concept.id)}>Focus here</button>
        <button className="small" onClick={onRemove}>What if I remove this?</button>
        {d.tree && <a className="small" href={d.tree} target="_blank" rel="noreferrer">GitHub ↗</a>}
      </div>
      {introduced && <div className="small ex-sec">First seen <b>{introduced.date.slice(0, 10)}</b>{introduced.approx ? ' ≈' : ''} by {introduced.commit.author}{introduced.commit.url && <> · <a href={introduced.commit.url} target="_blank" rel="noreferrer">{introduced.commit.pr ? `#${introduced.commit.pr}` : introduced.commit.sha.slice(0, 8)}</a></>} <span className="muted">{introduced.commit.subject}</span><div className="tiny muted">{introduced.source}</div></div>}
      {d.docs.length > 0 && <div className="ex-sec"><h5>Read first</h5>{d.docs.map((x: any) => <div key={x.file} className="small"><Loc x={x} /></div>)}</div>}
      {d.models.length > 0 && (
        <div className="ex-sec"><h5>Data models <span className="muted">{d.models.length}</span></h5>
          {d.models.slice(0, more.models ? 999 : 8).map((m: any) => {
            const rels = d.relations.filter((r: any) => r.model === m.name)
            return <div key={m.name} className="small"><b>{m.name}</b> <Loc x={m} />{rels.length > 0 && <span className="muted"> → {[...new Set(rels.map((r: any) => `${r.target}${r.kind !== 'fk' ? ` (${r.kind})` : ''}`))].join(', ')}</span>}</div>
          })}
          {d.models.length > 8 && <button className="link small" onClick={() => setMore(m => ({ ...m, models: !m.models }))}>{more.models ? 'fewer' : `+${d.models.length - 8} more`}</button>}
        </div>
      )}
      <Edges title="Built on" list={d.dependsOn} other="to" />
      <Edges title="Built on it" list={d.usedBy} other="from" />
      {milestones && milestones.length > 0 && <div className="ex-sec"><h5>Biggest changes</h5>{milestones.map(c => <div key={c.sha} className="small"><span className="muted">{c.date.slice(0, 10)}</span> {c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.pr ? `#${c.pr}` : c.sha.slice(0, 8)}</a> : null} {c.subject} <span className="muted">· {c.author}</span></div>)}</div>}
      {d.recent.length > 0 && <div className="ex-sec"><h5>Recent commits</h5>{d.recent.slice(0, 5).map((c: Commit) => <div key={c.sha} className="small ellipsis"><span className="muted">{c.date.slice(0, 10)}</span> {c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.pr ? `#${c.pr}` : c.sha.slice(0, 8)}</a> : null} {c.subject}</div>)}</div>}
      {d.largest.length > 0 && <div className="ex-sec"><h5>Largest source files</h5>{d.largest.slice(0, 5).map((x: any) => <div key={x.file} className="small"><Loc x={x} /> <span className="muted">{Math.round(x.size / 1024)} KB</span></div>)}</div>}
    </div>
  )
}

function DreamPanel({ g, ops, setOps, res, active, onSave }: { g: GraphRes; ops: Op[]; setOps: (f: (o: Op[]) => Op[]) => void; res: DreamRes | null; active: string | null; onSave: (plan: boolean) => void }) {
  const [name, setName] = useState('')
  const [deps, setDeps] = useState<string[]>([])
  const toggle = (id: string) => setDeps(d => d.includes(id) ? d.filter(x => x !== id) : [...d, id])
  return (
    <div className="card explore-dream">
      <div className="ex-title"><b>Dream mode</b> <span className="muted small">a sketch on the map, nothing changes in code</span></div>
      <div className="small muted">Right-click a concept to remove it. To add one, name it and pick what it's built on.</div>
      <div className="ex-sec small">
        <input value={name} placeholder="New concept, e.g. query layer" onChange={e => setName(e.target.value)} />
        <div className="ex-chips">{g.nodes.map(n => <button key={n.id} className={`chip ${deps.includes(n.id) ? 'on' : ''}`} onClick={() => toggle(n.id)}>{label(n.id)}</button>)}</div>
        <button className="small" disabled={!name.trim()} onClick={() => { setOps(o => [...o, { op: 'add', id: `dream:${name.trim()}`, name: name.trim(), dependsOn: deps }]); setName(''); setDeps([]) }}>Add, built on {deps.length || 'nothing'}</button>
        {active && <button className="small" onClick={() => setOps(o => [...o, { op: 'remove', id: active }])}>Remove {label(active)}</button>}
      </div>
      {ops.length > 0 && <div className="ex-sec small">{ops.map((o, i) => <div key={i}>{o.op === 'remove' ? `− ${o.id}` : `+ ${o.name} → ${(o.dependsOn ?? []).map(label).join(', ') || 'nothing'}`} <button className="link" onClick={() => setOps(x => x.filter((_, j) => j !== i))}>undo</button></div>)}</div>}
      {res && (
        <div className="ex-sec small">
          <div>{res.summary}</div>
          {res.broken.length > 0 && <div><span className="ex-key broken" /> needs rework: {res.broken.slice(0, 15).map(b => <span key={b.id} title={b.loses.map(l => `loses ${l.to} (${l.kind}, ${l.weight})`).join('\n')}>{label(b.id)}{b.loses.some(l => l.kind === 'fk') ? ' (data)' : ''} </span>)}{res.broken.length > 15 ? `+${res.broken.length - 15} more` : ''}</div>}
          {res.affected.length > 0 && <div><span className="ex-key affected" /> build on those: {res.affected.slice(0, 12).map(a => label(a.id)).join(', ')}{res.affected.length > 12 ? ` +${res.affected.length - 12} more` : ''}</div>}
          {res.orphaned.length > 0 && <div>left with no links: {res.orphaned.map(label).join(', ')}</div>}
          <div className="muted tiny">Counted across the whole repo ({g.total} modules), not just what's drawn. Runtime links (tasks, topics, HTTP) aren't on the map.</div>
          <div className="ex-actions"><button className="small" onClick={() => onSave(false)}>Save dream</button><button className="small primary" onClick={() => onSave(true)}>Turn into a plan</button></div>
        </div>
      )}
    </div>
  )
}
