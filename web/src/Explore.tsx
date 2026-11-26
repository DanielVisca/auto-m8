// Architecture explorer: a map of a repo built from its files and git history, so you can see what is built on
// what, watch it evolve, drill into the evidence, ask a chat that's handed exactly what you're looking at,
// and sketch "what if" changes. The map is deterministic; the chat explains and must cite files.
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, post, sendChat, shell, shortPath, toast } from './api'
import { MiniChat } from './Mini'
import { Markdown } from './Chat'
import { DataSection, keep, RepoPicker, SourcesPanel, useRepos, WhereItRuns, type Runtime } from './ExploreRuntime'
import './explore.css'
import { GitExplorer } from './GitExplorer'

type Evidence = { file: string; line: number; text: string; github?: string | null; local?: string }
type Edge = { from: string; to: string; kind: 'fk' | 'import'; weight: number; evidence: Evidence[] }
type Node = { id: string; name: string; path: string; files: number; models: string[]; role: 'focus' | 'dependency' | 'dependent' | 'both' | 'second'; score: number; hub: boolean }
type GraphRes = { repo: string; sha: string; focus: string | null; nodes: Node[]; edges: Edge[]; hidden: { dependencies: number; dependents: number; second: number; hubs: string[] }; total: number; inside?: { folder: string; concept: string }; alsoIn?: { concept: string; folders: string[]; models: string[] }[]; names: string[]; remote: { owner: string; name: string } | null }
type Commit = { sha: string; date: string; author: string; subject: string; pr: number | null; url: string | null }
type Ev = { date: string; kind: 'concept' | 'edge'; id: string; from?: string; to?: string; approx: boolean; source: string; commit: Commit }
type Timeline = { status: 'running' | 'done'; done: number; total: number; source: string; shallow: boolean; since: string | null; events: Ev[]; milestones: Record<string, Commit[]>; error?: string }
type Op = { op: 'remove'; id: string } | { op: 'add'; id: string; name?: string; dependsOn?: string[]; usedBy?: string[] }
type DreamRes = { removed: string[]; added: { id: string; name: string }[]; broken: { id: string; loses: { to: string; kind: string; weight: number }[] }[]; affected: { id: string; depth: number; via: string }[]; orphaned: string[]; edgesAdded: Edge[]; warnings: string[]; summary: string }

const W = 1000, H = 640
// One color per selected concept, so with several selected you can tell whose links are whose.
// Distinct from the accent (foreign keys when one concept is selected) and readable on light and dark.
const PALETTE = ['#4f9cf9', '#e5484d', '#30a46c', '#a970ff', '#e93d82', '#12a594']
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

// Where you were, per repo, so leaving for a chat and coming back lands you in the same place.
type Saved = { focus?: string; active?: string | null; selected?: string[]; step?: number | null; hubs?: boolean; allLinks?: boolean; trail?: string[]; dreaming?: boolean; ops?: Op[]; sources?: boolean }
const stateKey = (r: string) => `perch.explore.state.${r}`
const loadSaved = (r: string): Saved => { try { return JSON.parse(localStorage.getItem(stateKey(r)) ?? '{}') } catch { return {} } }

export function Explore({ initialRepo, onOpenChat, popout }: { initialRepo?: string; onOpenChat: (id: string) => void; popout?: boolean }) {
  const [repo, setRepo] = useState(() => initialRepo || recentRepos()[0] || '')
  const [saved0] = useState(() => loadSaved(initialRepo || recentRepos()[0] || ''))
  const restoring = useRef(true)
  const [repoInput, setRepoInput] = useState(repo)
  const repos = useRepos()
  // A workspace: the repo you map plus related ones (deploy charts, infra, services) used to tell where its code runs.
  const wsKey = (r: string) => `perch.explore.ws.${r}`
  const [ws, setWs] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(wsKey(repo)) ?? '[]') } catch { return [] } })
  useEffect(() => { try { setWs(JSON.parse(localStorage.getItem(wsKey(repo)) ?? '[]')) } catch { setWs([]) } }, [repo])
  const saveWs = (next: string[]) => { setWs(next); localStorage.setItem(wsKey(repo), JSON.stringify(next)) }
  const [sources, setSources] = useState(!!saved0.sources)
  const [runtime, setRuntime] = useState<Runtime | null>(null)
  const [focus, setFocusState] = useState(() => saved0.focus ?? localStorage.getItem('perch.explore.focus') ?? '')
  // Focus history, so "Focus here" can always be undone with Back.
  const [trail, setTrail] = useState<string[]>(saved0.trail ?? [])
  const setFocus = (f: string) => { if (f === focus) return; setTrail(t => [...t, focus].slice(-20)); setFocusState(f) }
  const goBack = () => { const prev = trail[trail.length - 1]; if (prev == null) return; setTrail(t => t.slice(0, -1)); setFocusState(prev); setFocusInput(prev); setActive(null); setSelected([]) }
  const clearFocus = () => { setFocus(''); setFocusInput(''); setActive(null); setSelected([]) }
  // Everything back to the whole map, now. Keeps the repo, its workspace and its chat.
  const resetAll = () => { setFocusState(''); setFocusInput(''); setTrail([]); setActive(null); setSelected([]); setStep(null); setPlaying(false); setDreaming(false); setOps([]); setEdgeCard(null); setHubs(false); setAllLinks(false); setSources(false) }
  // Each repo keeps its own place: switching repos picks up where you left that one.
  const switchRepo = (p: string) => {
    const sv = loadSaved(p)
    restoring.current = true
    setRepoInput(p); setRepo(p); setFocusState(sv.focus ?? ''); setFocusInput(sv.focus ?? ''); setTrail(sv.trail ?? []); setActive(sv.active ?? null); setSelected(sv.selected ?? [])
    setStep(sv.step ?? null); setHubs(!!sv.hubs); setAllLinks(!!sv.allLinks); setDreaming(!!sv.dreaming); setOps(sv.ops ?? []); setSources(!!sv.sources); setEdgeCard(null)
  }
  const popOut = () => {
    const url = `${location.origin}/?popout=explore#explore/${encodeURIComponent(repo)}`
    const sh = shell as any
    // In the app: its own window. Before the app is restarted with that ability, or in a browser: a browser window.
    if (sh.popout) sh.popout(url)
    else window.open(url.replace('127.0.0.1', 'localhost'), '_blank')
  }
  const [focusInput, setFocusInput] = useState(focus)
  const [hubs, setHubs] = useState(!!saved0.hubs)
  const [allLinks, setAllLinks] = useState(!!saved0.allLinks)
  const [g, setG] = useState<GraphRes | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [tl, setTl] = useState<Timeline | null>(null)
  const [step, setStep] = useState<number | null>(saved0.step ?? null) // null = now
  const [playing, setPlaying] = useState(false)
  const [active, setActive] = useState<string | null>(saved0.active ?? null)
  const [hovered, setHovered] = useState<string | null>(null)
  // The link under the mouse (or pinned by a click), with where to show its card.
  const [edgeCard, setEdgeCard] = useState<{ e: Edge; x: number; y: number; pinned: boolean } | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const cardAt = (ev: React.MouseEvent, e: Edge, pinned: boolean) => { const r = stageRef.current!.getBoundingClientRect(); setEdgeCard(c => c?.pinned && !pinned ? c : { e, x: Math.min(ev.clientX - r.left, r.width - 450), y: Math.min(ev.clientY - r.top, r.height - 220), pinned }) }
  const [selected, setSelected] = useState<string[]>(saved0.selected ?? [])
  const [dreaming, setDreaming] = useState(!!saved0.dreaming)
  const [gitView, setGitView] = useState(() => localStorage.getItem('perch.explore.git') === '1')
  const toggleGit = () => { const v = !gitView; setGitView(v); localStorage.setItem('perch.explore.git', v ? '1' : '0') }
  const [ops, setOps] = useState<Op[]>(saved0.ops ?? [])
  const [dreamRes, setDreamRes] = useState<DreamRes | null>(null)
  const [chatId, setChatId] = useState<string | null>(() => repo ? localStorage.getItem(`perch.explore.chat.${repo}`) : null)
  const [lastCtx, setLastCtx] = useState('')
  const [ask, setAsk] = useState('')
  // The Ask box can fold its reply away so the panel above gets the room; the side panel's width is draggable. Both persist.
  const [replyHidden, setReplyHidden] = useState(() => localStorage.getItem('perch.explore.replyHidden') === '1')
  const toggleReply = (v = !replyHidden) => { setReplyHidden(v); localStorage.setItem('perch.explore.replyHidden', v ? '1' : '0') }
  const [sideW, setSideW] = useState(() => Number(localStorage.getItem('perch.explore.sideW')) || 380)
  const resizeSide = (e: React.PointerEvent) => {
    e.preventDefault()
    const main = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect()
    let w = sideW
    const move = (ev: PointerEvent) => { w = Math.round(Math.max(260, Math.min(main.width - 320, main.right - ev.clientX))); setSideW(w) }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.style.cursor = ''; localStorage.setItem('perch.explore.sideW', String(w)) }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const drag = useRef<{ x: number; y: number; x2: number; y2: number } | null>(null)
  const [box, setBox] = useState<{ x: number; y: number; x2: number; y2: number } | null>(null)
  const svg = useRef<SVGSVGElement>(null)

  useEffect(() => {
    if (!repo) return
    let gone = false
    // The first load after coming back keeps your place on the timeline; later changes start from now.
    setLoading(true); setErr(''); setTl(null); if (!restoring.current) setStep(null); restoring.current = false; setPlaying(false)
    api.get<GraphRes>(`/api/explore/graph?${qs({ repo, focus, hubs: hubs ? '1' : '' })}`)
      .then(r => { if (gone) return; setG(r); post('/api/explore/summary/warm', { repo: r.repo, ids: r.nodes.slice().sort((a, b) => (a.role === 'focus' ? -1 : 0) - (b.role === 'focus' ? -1 : 0) || b.score - a.score).map(n => n.id).slice(0, 10) }).catch(() => {}); localStorage.setItem('perch.explore.repos', JSON.stringify([r.repo, ...recentRepos().filter(x => x !== r.repo && x !== repo)].slice(0, 8))); localStorage.setItem('perch.explore.focus', focus) })
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

  useEffect(() => {
    if (repo) localStorage.setItem(stateKey(repo), JSON.stringify({ focus, active, selected, step, hubs, allLinks, trail, dreaming, ops, sources } satisfies Saved))
  }, [repo, focus, active, selected, step, hubs, allLinks, trail, dreaming, ops, sources])
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
  // Spotlight: what's hovered, else what's selected. Its neighbours stay bright; everything else fades.
  // While stepping through the story, the concept that just appeared takes the stage (unless you've picked something):
  // its links arriving in this step are drawn green, and the older concepts it tied into stay bright.
  const storyIds = useMemo(() => !group ? [] : [...new Set(group.filter(e => e.kind === 'concept').map(e => e.id).concat(group.some(e => e.kind === 'concept') ? [] : group.map(e => e.from!)))], [group])
  const story = !hovered && !selected.length && !active && storyIds.length > 0
  const spot = useMemo(() => new Set(hovered ? [hovered] : selected.length ? selected : active ? [active] : storyIds), [hovered, selected, active, storyIds])
  // The caption's "what it tied into": its links that exist at this point in time, strongest first (a foreign key counts 5x).
  const storyLinks = useMemo(() => {
    if (!g || !at || at.kind !== 'concept') return null
    const id = at.id, live = g.edges.filter(e => (e.from === id || e.to === id) && edgeVisible(e))
    const pick = (l: Edge[], other: (e: Edge) => string) => {
      const m = new Map<string, { id: string; fk: boolean; w: number }>()
      for (const e of l) { const o = other(e), x = m.get(o) ?? { id: o, fk: false, w: 0 }; x.fk ||= e.kind === 'fk'; x.w += e.weight * (e.kind === 'fk' ? 5 : 1); m.set(o, x) }
      return [...m.values()].sort((a, b) => b.w - a.w)
    }
    return { on: pick(live.filter(e => e.from === id), e => e.to), by: pick(live.filter(e => e.to === id), e => e.from) }
  }, [g, at, T]) // eslint-disable-line
  const colorOf = useMemo(() => new Map(selected.length > 1 ? selected.map((id, i) => [id, PALETTE[i % PALETTE.length]] as const) : []), [selected])
  // Find on the map: typing filters to matching concepts; selecting one brings its links back as usual.
  const [findOpen, setFindOpen] = useState(false)
  const [find, setFind] = useState('')
  const found = useMemo(() => {
    const q = find.trim().toLowerCase().replace(/[-_\s]/g, '')
    if (!g || !q) return null
    const norm = (x: string) => x.toLowerCase().replace(/[-_\s]/g, '')
    // Best first: exact name, name starting with it, name containing it, then a model named like it.
    const rank = (n: Node) => { const nm = norm(label(n.id)); return nm === q || nm === q + 's' ? 0 : nm.startsWith(q) ? 1 : norm(n.id).includes(q) ? 2 : n.models.some(m => norm(m).includes(q)) ? 3 : 9 }
    return new Set(g.nodes.map(n => [n, rank(n)] as const).filter(([, r]) => r < 9).sort((a, b) => a[1] - b[1]).map(([n]) => n.id))
  }, [g, find])
  // Nothing on this map matches: say where it is in the rest of the repo (modules first, then models), one click to focus.
  const elsewhere = useMemo(() => {
    if (!g || !found || found.size) return []
    const q = find.trim().toLowerCase().replace(/[-_\s]/g, '')
    const norm = (x: string) => x.toLowerCase().replace(/[-_\s]/g, '')
    const on = new Set(g.nodes.flatMap(n => [n.id, ...n.models]))
    const rank = (x: string) => { const l = norm(x.split('/').pop()!); return (x.includes('/') ? 0 : 3) + (l === q || l === q + 's' ? 0 : l.startsWith(q) ? 1 : 2) }
    const w = q.replace(/(ies|s)$/, '')
    return g.names.filter(x => !on.has(x) && norm(x.split('/').pop()!).includes(w)).sort((a, b) => rank(a) - rank(b) || a.length - b.length).slice(0, 8)
  }, [g, found, find])
  const near = useMemo(() => new Set(g ? g.edges.filter(e => spot.has(e.from) || spot.has(e.to)).flatMap(e => [e.from, e.to]) : []), [g, spot])
  const clearSel = () => { setSelected([]); setActive(null) }
  useEffect(() => { const f = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest('input,textarea')) clearSel() }; addEventListener('keydown', f); return () => removeEventListener('keydown', f) }, [])
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
    if (runtime && sel.length === 1) {
      lines.push(`Live (from Argo CD and Grafana, just now) for ${runtime.concept}:`)
      for (const d of runtime.deployments.filter(d => d.origin !== 'third-party').slice(0, 4)) {
        lines.push(`  ${d.base} (${d.origin}): ${d.apps.map(a => `${a.region} ${a.health ?? ''}${a.code?.[0] ? ` runs ${a.code[0].repo.split('/').pop()}@${a.code[0].sha.slice(0, 10)}` : ''}`).join('; ')}`)
        const f = d.facts.filter(x => x.source.endsWith('VictoriaMetrics') && x.value != null).map(x => `${x.label} ${Math.round(Number(x.value) * 100) / 100}`)
        if (f.length) lines.push(`    ${f.join(', ')} (query in Grafana: ${d.facts[0]?.query ?? ''})`)
      }
    }
    if (ws.length) lines.push(`Related repos in this workspace: ${ws.join(', ')}.`)
    if (dreamRes) lines.push(`Dream in progress: ${dreamRes.summary}`)
    lines.push('This map comes from imports and foreign keys only, so it can miss runtime links (Celery tasks, Kafka topics, HTTP calls, signals). Verify what you say against the code in this repo and cite file:line; say when you are unsure instead of guessing.')
    return lines.join('\n')
  }
  const send = async (q: string) => {
    if (!g || !q.trim()) return
    toggleReply(false)
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
        <div className="explore-repo"><RepoPicker value={repo} repos={repos} placeholder="Pick a repo: type to search, or paste a path" onPick={switchRepo} /></div>
        <input className="explore-focus" list="explore-names" value={focusInput} placeholder="Focus on a concept: dashboard, insight, alert…" onChange={e => setFocusInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { setRepo(repoInput.trim()); setFocus(focusInput.trim()); setActive(null); setSelected([]) } }} />
        <datalist id="explore-names">{g?.names.slice(0, 2000).map(n => <option key={n} value={n} />)}</datalist>
        <button onClick={() => { setRepo(repoInput.trim()); setFocus(focusInput.trim()); setActive(null); setSelected([]) }}>Map</button>
        {trail.length > 0 && <button onClick={goBack} title={`Back to ${trail[trail.length - 1] || 'the whole map'}`}>← Back</button>}
        {focus && <button onClick={clearFocus} title="Clear the focus and show the whole map">✕ Whole map</button>}
        <label className="small"><input type="checkbox" checked={hubs} onChange={e => setHubs(e.target.checked)} /> show shared foundations</label>
        <label className="small"><input type="checkbox" checked={allLinks} onChange={e => setAllLinks(e.target.checked)} /> all links</label>
        <button className={sources ? 'primary' : ''} onClick={() => setSources(!sources)} title="What the explorer can read beyond code: Argo CD, Grafana, AWS…">Sources</button>
        <button className={dreaming ? 'primary' : ''} onClick={() => { setDreaming(!dreaming); if (dreaming) setOps([]) }} title="Sketch a change: remove or add concepts and see what breaks">{dreaming ? 'Leave dream mode' : 'Dream mode'}</button>
        <button className={gitView ? 'primary' : ''} onClick={toggleGit} title="Git: worktrees, branches, what's committed and pushed, stranded local work, and whether branches get merged">⑂ Git</button>
        <button onClick={resetAll} title="Back to the whole map: clears the focus, selection, timeline position and dream. Keeps the repo, workspace and chat.">↺ Reset</button>
        {!popout && <button onClick={popOut} title="Open the explorer in its own window, to keep it on another screen">⧉ Pop out</button>}
      </div>
      {repo && (
        <div className="explore-ws small">
          <span className="muted" title="Related repos: used to tell which deployments run your code, and to give the chat more context">Workspace:</span>
          <span className="chip on">{repos.find(r => r.path === repo)?.name ?? repo.split('/').pop()}</span>
          {ws.map(w => <span key={w} className="chip">{w.split('/').pop()} <button className="link" title="Remove from workspace" onClick={() => saveWs(ws.filter(x => x !== w))}>×</button></span>)}
          <div className="ex-ws-add"><RepoPicker compact value="" repos={repos} exclude={[repo, ...ws]} placeholder="+ add a related repo (charts, infra, a service…)" onPick={p => saveWs([...ws, p])} /></div>
        </div>
      )}
      {gitView ? <GitExplorer repo={repo} onPickRepo={switchRepo} onOpenChat={onOpenChat} /> : <>
      {!repo && <div className="card muted">Pick a git repo to map. Everything on the map comes from its files and history: each concept, link, date and author can be traced to a file or commit.</div>}
      {err && <div className="card bad">{err}</div>}
      {g && (
        <div className="explore-main" style={{ '--ex-side': `${sideW}px` } as React.CSSProperties}>
          <div className="explore-stage">
            <div className="explore-legend small muted">
              {g.focus ? <>Left: what {focusNames.join(', ') || g.focus} is built on · Right: what's built on it · Middle: links both ways</> : <>The {g.nodes.length} most connected of {g.total} modules. Focus on one to see what it's built on.</>}
              {' · '}<span className="lg-fk" title="A model in one module has a foreign key to a table in another: a database-level link, the hardest kind to undo">●━ thick solid, dot at start: foreign key (database link)</span> <span className="lg-imp" title="Code in one module imports another module">┅ thin dashed: code import</span> · arrows point at what it's built on · hover a link for details · {shortPath(g.repo)} @ {g.sha.slice(0, 8)}
              {loading && <> · <i className="spin" /> mapping…</>}
              {(() => { const me = repos.find(r => r.path === g.repo); return me?.behindOrigin && me.behindOrigin > 50 ? <div className="warn">⚠ This checkout is on branch {me.branch} and {me.behindOrigin.toLocaleString()} commits behind main, so the map shows an older system. Pull or switch to main for today's.</div> : null })()}
            </div>
            <div className="ex-svgwrap" ref={stageRef}>
            <div className={`ex-find ${findOpen ? 'open' : ''}`} onPointerDown={e => e.stopPropagation()}>
              {findOpen ? <>
                <input autoFocus value={find} placeholder="Find on this map…" onChange={e => { setFind(e.target.value); setSelected([]); setActive(null) }}
                  onKeyDown={e => {
                    if (e.key === 'Escape') { e.stopPropagation(); setFind(''); setFindOpen(false) }
                    else if (e.key === 'Enter' && found?.size) { const id = [...found][0]; setActive(id); setSelected([id]) }
                  }} />
                {found && <span className="tiny muted">{found.size} match{found.size === 1 ? '' : 'es'}</span>}
                {found && !found.size && find.trim() && <button className="link tiny" onClick={() => { setFocus(find.trim()); setFocusInput(find.trim()); setFind(''); setFindOpen(false) }} title="Not on this map: focus the whole repo on it">search the repo →</button>}
                {elsewhere.length > 0 && <div className="ex-find-more small">
                  <div className="tiny muted">Not on this map. In the repo:</div>
                  {elsewhere.map(x => <button key={x} className="link small" title={x.includes('/') ? `Focus ${x}` : `Model ${x}: focus the module it lives in`} onClick={() => { setFocus(x); setFocusInput(x); setFind(''); setFindOpen(false) }}>{x}</button>)}
                </div>}
                <button className="link small" title="Close (Esc)" onClick={() => { setFind(''); setFindOpen(false) }}>×</button>
              </> : <button className="ex-find-btn" title="Find a concept on this map" onClick={() => setFindOpen(true)}>⌕</button>}
            </div>
            <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="explore-svg"
              onPointerDown={e => { if (e.target === svg.current) { const p = svgPoint(e); drag.current = { x: p.x, y: p.y, x2: p.x, y2: p.y } } }}
              onPointerMove={e => { if (drag.current) { const p = svgPoint(e); drag.current = { ...drag.current, x2: p.x, y2: p.y }; setBox({ ...drag.current }) } }}
              onPointerUp={e => {
                const b = drag.current; drag.current = null; setBox(null)
                if (!b) return
                // Drag a box to put several concepts in the chat's context at once.
                if (Math.abs(b.x2 - b.x) < 6 && Math.abs(b.y2 - b.y) < 6) { setEdgeCard(null); if (!e.shiftKey) { setSelected([]); setActive(null) } return }
                const [x1, x2, y1, y2] = [Math.min(b.x, b.x2), Math.max(b.x, b.x2), Math.min(b.y, b.y2), Math.max(b.y, b.y2)]
                const inside = g.nodes.filter(n => { const p = pos.get(n.id)!; return p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2 && visible(n.id) }).map(n => n.id)
                setSelected(s => e.shiftKey ? [...new Set([...s, ...inside])] : inside)
              }}>
              <defs>
                <marker id="ex-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--muted)" /></marker>
                {PALETTE.map((c, i) => <marker key={`d${c}`} id={`ex-dot-${i}`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5"><circle cx="5" cy="5" r="4" fill={c} /></marker>)}
                <marker id="ex-dot-fk" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5"><circle cx="5" cy="5" r="4" fill="var(--accent)" /></marker>
                {PALETTE.map((c, i) => <marker key={c} id={`ex-arrow-${i}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill={c} /></marker>)}
                <marker id="ex-arrow-ok" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--ok)" /></marker>
                <marker id="ex-arrow-fk" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--accent)" /></marker>
              </defs>
              {[...g.edges, ...(dreamRes?.edgesAdded ?? [])].map((e, i) => {
                const a = pos.get(e.from), b = pos.get(e.to)
                if (!a || !b || !edgeVisible(e)) return null
                // A selected (or hovered) concept gets the stage: only its links are drawn, unless "all links" is on,
                // where the rest stay as faint context.
                const lit = spot.size > 0 && (spot.has(e.from) || spot.has(e.to))
                if (spot.size && !lit && !allLinks && !story) return null
                if (found?.size && !spot.size && !(found.has(e.from) && found.has(e.to))) return null
                if (!spot.size && drawn && e.evidence.length && !drawn.has(e)) return null
                const rb = radius(nodeById(e.to)?.files ?? 1) + 3
                const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1
                const ex = b.x - (dx / len) * rb, ey = b.y - (dy / len) * rb
                // Curve the fk and import links between the same pair apart, so both stay visible.
                const bend = e.kind === 'fk' ? 0.12 : -0.08
                const mx = (a.x + ex) / 2 - dy * bend, my = (a.y + ey) / 2 + dx * bend
                const hot = lit
                // Several selected: color the link by the selected concept it belongs to (solid/dashed still says fk/import).
                const pc = lit ? colorOf.get(e.from) ?? colorOf.get(e.to) : undefined
                const gone = removed.has(e.from) || removed.has(e.to)
                const isNew = !e.evidence.length
                const d = `M${a.x},${a.y} Q${mx},${my} ${ex},${ey}`
                const w = Math.min(6, 0.8 + Math.log2(e.weight + 1)) * (e.kind === 'fk' ? 1.6 : 1)
                // A link arriving in this step of the story: green, so you see what the newcomer attached to.
                const arrived = fresh(`${e.from}→${e.to}`) || (story && lit)
                return <g key={i}>
                  {/* A foreign key stays recognizable in any color: thicker, solid, with a dot where the link starts. */}
                  <path d={d}
                    className={`ex-edge ${e.kind} ${hot ? 'hot' : ''} ${spot.size && !lit ? 'faded' : ''} ${gone ? 'gone' : ''} ${isNew ? 'dreamed' : ''} ${fresh(`${e.from}→${e.to}`) ? 'fresh' : ''} ${edgeCard?.e === e ? 'carded' : ''}`}
                    style={pc ? { stroke: pc, opacity: 0.9 } : arrived ? { stroke: 'var(--ok)', opacity: 1 } : undefined}
                    strokeWidth={w} markerStart={e.kind === 'fk' ? `url(#${pc ? `ex-dot-${PALETTE.indexOf(pc)}` : 'ex-dot-fk'})` : undefined}
                    markerEnd={`url(#${pc ? `ex-arrow-${PALETTE.indexOf(pc)}` : arrived ? 'ex-arrow-ok' : e.kind === 'fk' ? 'ex-arrow-fk' : 'ex-arrow'})`} />
                  {/* A wide invisible stroke, so a thin link is easy to hover and click. */}
                  {!(spot.size && !lit) && <path d={d} className="ex-hit" onPointerDown={ev => ev.stopPropagation()}
                    onMouseEnter={ev => cardAt(ev, e, false)} onMouseMove={ev => cardAt(ev, e, false)} onMouseLeave={() => setEdgeCard(c => c?.pinned ? c : null)}
                    onClick={ev => { ev.stopPropagation(); cardAt(ev, e, true) }} />}
                </g>
              })}
              {g.nodes.map(n => {
                const p = pos.get(n.id)!
                const show = visible(n.id)
                if (!show && T) return null
                if (found?.size && !found.has(n.id) && !spot.has(n.id) && !(spot.size && near.has(n.id))) return null
                const r = radius(n.files)
                const cls = ['ex-node', n.role, n.hub ? 'hub' : '', active === n.id ? 'active' : '', selected.includes(n.id) ? 'sel' : '', removed.has(n.id) ? 'gone' : '', broken.has(n.id) ? 'broken' : '', affected.has(n.id) ? 'affected' : '', fresh(n.id) ? 'fresh' : '', T && !intro.has(n.id) ? 'undated' : '', spot.size && !spot.has(n.id) && !near.has(n.id) ? 'faded' : ''].join(' ')
                return (
                  <g key={n.id} className={cls} transform={`translate(${p.x},${p.y})`} onPointerDown={e => e.stopPropagation()}
                    onClick={e => pick(n.id, e.shiftKey || e.metaKey)} onMouseEnter={() => setHovered(n.id)} onMouseLeave={() => setHovered(h => h === n.id ? null : h)}
                    onContextMenu={e => { e.preventDefault(); if (dreaming) setOps(o => o.some(x => x.op === 'remove' && x.id === n.id) ? o.filter(x => !(x.op === 'remove' && x.id === n.id)) : [...o, { op: 'remove', id: n.id }]) }}>
                    <circle r={r} style={colorOf.has(n.id) ? { stroke: colorOf.get(n.id), strokeWidth: 3.5, strokeDasharray: 'none' } : undefined} />
                    <text y={r + 13} textAnchor="middle">{label(n.id)}</text>
                    <title>{`${n.id}\n${n.files} files${n.models.length ? `\nmodels: ${n.models.slice(0, 10).join(', ')}${n.models.length > 10 ? '…' : ''}` : ''}${intro.has(n.id) ? `\nfirst seen ${intro.get(n.id)!.slice(0, 10)}` : ''}`}</title>
                  </g>
                )
              })}
              {ops.filter((o): o is Extract<Op, { op: 'add' }> => o.op === 'add').map(o => { const p = pos.get(o.id)!; return <g key={o.id} className="ex-node dreamed" transform={`translate(${p.x},${p.y})`}><circle r={12} /><text y={26} textAnchor="middle">{o.name ?? o.id}</text></g> })}
              {box && <rect className="ex-box" x={Math.min(box.x, box.x2)} y={Math.min(box.y, box.y2)} width={Math.abs(box.x2 - box.x)} height={Math.abs(box.y2 - box.y)} />}
            </svg>
            {g.nodes.length === 0 && (
              <div className="ex-empty card small">
                {g.inside ? <>“{g.focus}” isn't a module of its own: it's the folder <code>{g.inside.folder}</code> inside <b>{g.inside.concept}</b>.</> : <>Nothing matches “{g.focus}”. Try a shorter name (dashboard, insight, alert) or a module path from the list.</>}
                <div className="ex-actions">{g.inside && <button className="small primary" onClick={() => { setFocus(g.inside!.concept); setFocusInput(g.inside!.concept) }}>Focus {label(g.inside.concept)}</button>}{trail.length > 0 && <button className="small" onClick={goBack}>← Back</button>}<button className="small primary" onClick={clearFocus}>Show the whole map</button></div>
              </div>
            )}
            {edgeCard && <EdgeCard c={edgeCard} repo={g.repo} onClose={() => setEdgeCard(null)} />}
            </div>
            {(selected.length > 0 || active) && (
              <div className="small explore-spot">
                Showing links of {(selected.length ? selected : [active!]).map((id, i) => <span key={id}>{i ? ', ' : ''}<b style={colorOf.has(id) ? { color: colorOf.get(id) } : undefined}>{colorOf.has(id) ? '● ' : ''}{label(id)}</b></span>)} ({near.size ? near.size - spot.size : 0} connected)
                {' · '}<button className="link small" onClick={clearSel}>show everything</button> <span className="muted">(Esc, or click empty space · shift-click to add)</span>
              </div>
            )}
            {g.focus && (g.hidden.dependencies + g.hidden.dependents + g.hidden.hubs.length > 0) && (
              <div className="small muted explore-hidden">
                Not drawn: {g.hidden.dependencies} more it builds on, {g.hidden.dependents} more built on it{g.hidden.second ? `, ${g.hidden.second} two hops out` : ''}.
                {g.hidden.hubs.length > 0 && <> {g.hidden.hubs.length} shared foundations used by almost everything (<span title={g.hidden.hubs.join('\n')}>{g.hidden.hubs.slice(0, 4).map(label).join(', ')}{g.hidden.hubs.length > 4 ? '…' : ''}</span>) are hidden; tick “show shared foundations” to draw them.</>}
              </div>
            )}
            {g.focus && (g.alsoIn?.length ?? 0) > 0 && (
              <div className="small muted explore-hidden">
                “{g.focus}” also lives inside other modules:{' '}
                {g.alsoIn!.map((a, i) => <span key={a.concept}>{i ? ' · ' : ''}<button className="link small" title={[...a.folders.map(f => `${a.concept}/${f}/`), ...a.models.map(m => `model ${m}`)].join('\n')} onClick={() => { setFocus(a.concept); setFocusInput(a.concept) }}>{label(a.concept)}</button> <span>({[...a.folders.map(f => f + '/'), ...a.models].slice(0, 3).join(', ')}{a.folders.length + a.models.length > 3 ? '…' : ''})</span></span>)}
              </div>
            )}
            <TimelineBar tl={tl} steps={steps} step={step} setStep={s => { setPlaying(false); setStep(s) }} playing={playing} setPlaying={setPlaying} at={at} links={storyLinks} onPick={id => pick(id, false)} />
          </div>
          <div className="explore-resize" title="Drag to resize the panel · double-click to reset" onPointerDown={resizeSide} onDoubleClick={() => { setSideW(380); localStorage.removeItem('perch.explore.sideW') }} />
          <aside className="explore-side">
            <div className="explore-side-top">
            {sources && <SourcesPanel onClose={() => setSources(false)} onOpenTerm={id => { location.hash = `#term/${encodeURIComponent(id)}` }} />}
            {dreaming && <DreamPanel g={g} ops={ops} setOps={setOps} res={dreamRes} active={active} onSave={saveDream} />}
            {active ? <NodePanel repo={g.repo} id={active} workspace={[g.repo, ...ws]} org={g.remote?.owner ?? null} onRuntime={setRuntime} milestones={tl?.milestones[active]} introduced={events.find(e => e.kind === 'concept' && e.id === active)}
              onFocus={id => { setFocus(id); setFocusInput(id); setActive(null); setSelected([]) }}
              onAsk={() => send(`Explain ${active}: what it is responsible for, how its data is stored, and why it depends on the modules it does. Start from the docs and models listed.`)}
              onRemove={() => { setDreaming(true); setOps(o => [...o, { op: 'remove', id: active }]) }} />
              : !dreaming && <div className="card muted small">Click a concept to see what it is, what it's built on, what's built on it, and where that's written. Shift-click or drag a box to select several, then ask about them below. Press play on the timeline to watch the system grow.</div>}
            </div>
            <div className={`explore-chat card ${chatId && replyHidden ? 'folded' : ''}`}>
              <div className="explore-chat-head small">
                {chatId && <button className="link small ex-reply-fold" title={replyHidden ? 'Show the reply' : 'Hide the reply, keep the ask box'} onClick={() => toggleReply()}>{replyHidden ? '▸' : '▾'}</button>}
                <b>Ask</b>
                <span className="muted ellipsis">{(selected.length ? selected : active ? [active] : []).map(label).join(', ') || (g.focus ? `focus: ${g.focus}` : 'whole map')}{T ? ` · at ${T.slice(0, 10)}` : ''}</span>
                {chatId && <><button className="link small" onClick={() => onOpenChat(chatId)}>open chat</button><button className="link small" onClick={newChat}>new</button></>}
              </div>
              <textarea value={ask} placeholder="Ask about what you've selected. The map's evidence is sent with it, and the agent is told to check the code and cite files." onChange={e => setAsk(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(ask) } }} />
              {chatId && !replyHidden && <div className="explore-reply"><MiniChat id={chatId} bare readOnly="Reply from the box above, so it carries what you're looking at." /></div>}
            </div>
          </aside>
        </div>
      )}
      </>}
    </div>
  )
}

type Link = { id: string; fk: boolean; w: number }
function TimelineBar({ tl, steps, step, setStep, playing, setPlaying, at, links, onPick }: { tl: Timeline | null; steps: Ev[][]; step: number | null; setStep: (s: number | null) => void; playing: boolean; setPlaying: (p: boolean) => void; at: Ev | null; links: { on: Link[]; by: Link[] } | null; onPick: (id: string) => void }) {
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
          {links && (links.on.length > 0 || links.by.length > 0) && (
            <div className="ex-story-links small">
              {([['Built on', links.on], ['Used by', links.by]] as const).filter(([, l]) => l.length).map(([t, l]) => (
                <div key={t}><span className="muted">{t}:</span> {l.slice(0, 5).map((x, i) => <span key={x.id}>{i ? ', ' : ''}<button className="link" onClick={() => onPick(x.id)} title={`${x.id}\nClick to select it`}>{label(x.id)}</button>{x.fk ? <span className="ex-kind fk" title="Foreign key: a database link"> fk</span> : ''}</span>)}{l.length > 5 ? <span className="muted"> +{l.length - 5} more</span> : ''}</div>
              ))}
            </div>
          )}
          {links && !links.on.length && !links.by.length && <div className="small muted">No links to anything that existed yet: it arrived on its own.</div>}
          <div className="tiny muted">{at.source}{extra > 0 ? ` · +${extra} more link${extra === 1 ? '' : 's'} at this step` : ''} · <span style={{ color: 'var(--ok)' }}>green</span>: its links, to what existed then</div>
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

// A section that starts closed and says in one line what's inside; remembers if you opened it.
function Section({ id, title, summary, hint, children }: { id: string; title: string; summary?: React.ReactNode; hint?: string; children: React.ReactNode }) {
  const key = `perch.explore.open.${id}`
  const [open, setOpen] = useState(() => localStorage.getItem(key) === '1')
  return (
    <details className="ex-fold" open={open} onToggle={e => { const o = (e.target as HTMLDetailsElement).open; setOpen(o); localStorage.setItem(key, o ? '1' : '0') }}>
      <summary><b>{title}</b> <span className="muted">{summary}</span>{hint && <span className="ex-i" title={hint}>ⓘ</span>}</summary>
      <div className="ex-fold-body">{children}</div>
    </details>
  )
}

function NodePanel({ repo, id, workspace, org, onRuntime, milestones, introduced, onFocus, onAsk, onRemove }: { repo: string; id: string; workspace: string[]; org: string | null; onRuntime: (r: Runtime | null) => void; milestones?: Commit[]; introduced?: Ev; onFocus: (id: string) => void; onAsk: () => void; onRemove: () => void }) {
  const [d, setD] = useState<any>(() => keep(`/api/explore/node?${qs({ repo, id })}`).v ?? null)
  const [more, setMore] = useState<Record<string, boolean>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [runs, setRuns] = useState('')
  const [data, setData] = useState('')
  // "What is this": the team's own words now, a short AI summary when it's ready (cached per version of the folder).
  const [sum, setSum] = useState<any>(null)
  // Usage side note: only for PostHog app products with traffic; nothing otherwise.
  const [use, setUse] = useState<any>(() => keep(`/api/explore/usage?${qs({ repo, id })}`).v ?? null)
  useEffect(() => { let gone = false; const k = keep(`/api/explore/usage?${qs({ repo, id })}`); setUse(k.v ?? null); k.p.then(x => !gone && setUse(x)).catch(() => {}); return () => { gone = true } }, [repo, id])
  useEffect(() => {
    let gone = false, tries = 0, t: ReturnType<typeof setTimeout>
    setSum(null)
    const load = () => api.get(`/api/explore/summary?${qs({ repo, id })}`).then((x: any) => { if (gone) return; setSum(x); if (x.status === 'generating' && ++tries < 40) t = setTimeout(load, 2500) }).catch(e => !gone && setSum({ status: 'error', error: String(e?.message ?? e) }))
    load()
    return () => { gone = true; clearTimeout(t) }
  }, [repo, id])
  // Ignore an answer for a concept you've already clicked away from (a slow cold load could overwrite the newer one).
  useEffect(() => { let gone = false; const k = keep(`/api/explore/node?${qs({ repo, id })}`); setD(k.v ?? null); k.p.then(x => !gone && setD(x)).catch(e => !gone && setD({ error: String(e?.message ?? e) })); return () => { gone = true } }, [repo, id])
  if (!d) return <div className="card small muted"><i className="spin" /> Loading {id}…</div>
  if (d.error) return <div className="card bad small">{d.error}</div>
  const openLocal = (file: string, line?: number) => post('/api/explore/open', { repo, file, line }).catch(e => toast(String(e?.message ?? e), { kind: 'error' }))
  const Loc = ({ x }: { x: { file: string; line?: number; github?: string | null } }) => (
    <span className="ex-loc"><button className="link" title="Open in your editor" onClick={() => openLocal(x.file, x.line)}>{x.file}{x.line ? `:${x.line}` : ''}</button>{x.github && <a className="muted" href={x.github} target="_blank" rel="noreferrer" title="On GitHub at the mapped commit"> ↗</a>}</span>
  )
  const Edge = ({ e, other, k }: { e: any; other: 'from' | 'to'; k: string }) => (
    <div className="small">
      <button className="link" onClick={() => setOpen(open === k ? null : k)} title="Show the lines of code behind this link">{open === k ? '▾' : '▸'}</button>{' '}
      <button className="link" onClick={() => onFocus(e[other])} title={`${e[other]}\nClick to focus the map here`}>{label(e[other])}</button>{' '}
      <span className={`muted ex-kind ${e.kind}`} title={e.kind === 'fk' ? 'Foreign key: a database link between their tables' : `Imported by ${e.weight} file${e.weight === 1 ? '' : 's'}`}>{e.kind === 'fk' ? 'fk' : ''} {e.weight}</span>
      {open === k && <div className="ex-evidence">{e.evidence.map((x: any, i: number) => <div key={i}><Loc x={x} /><code>{x.text}</code></div>)}{e.weight > e.evidence.length && <div className="muted tiny">+{e.weight - e.evidence.length} more files</div>}</div>}
    </div>
  )
  // Specific links first; plumbing that most of the repo uses goes in one line at the end.
  const Edges = ({ title, list, other }: { title: string; list: any[]; other: 'from' | 'to' }) => {
    const specific = list.filter(e => !e.hub), hubs = list.filter(e => e.hub)
    const all = more[title], shown = all ? specific : specific.slice(0, 6)
    return (
      <>
        {!list.length && <div className="muted small">Nothing.</div>}
        {shown.map(e => <Edge key={`${e[other]}:${e.kind}`} e={e} other={other} k={`${title}:${e[other]}:${e.kind}`} />)}
        {specific.length > 6 && <button className="link small" onClick={() => setMore(m => ({ ...m, [title]: !all }))}>{all ? 'fewer' : `+${specific.length - 6} more`}</button>}
        {hubs.length > 0 && (
          <div className="small muted ex-hubs">
            <button className="link small" onClick={() => setMore(m => ({ ...m, [title + ':hubs']: !m[title + ':hubs'] }))} title="Modules used by most of the repo (UI kit, utils, the Team model). Real, but they say little about this concept.">{more[title + ':hubs'] ? '▾' : '▸'} {hubs.length} shared foundation{hubs.length === 1 ? '' : 's'}</button>
            {' '}{!more[title + ':hubs'] && hubs.slice(0, 4).map(e => label(e[other])).join(', ')}{!more[title + ':hubs'] && hubs.length > 4 ? '…' : ''}
            {more[title + ':hubs'] && hubs.map(e => <Edge key={`${e[other]}:${e.kind}`} e={e} other={other} k={`${title}:${e[other]}:${e.kind}`} />)}
          </div>
        )}
      </>
    )
  }
  // Count modules, not links: a module with both a foreign key and an import is one module.
  const other = (e: any) => e.from === d.concept.id ? e.to : e.from
  const specificCount = (l: any[]) => new Set(l.filter(e => !e.hub).map(other)).size
  const allCount = (l: any[]) => new Set(l.map(other)).size
  return (
    <div className="card explore-node">
      <div className="ex-title"><b title={d.concept.path}>{d.concept.name}</b>{d.tree && <a className="small muted" href={d.tree} target="_blank" rel="noreferrer" title="Open this folder on GitHub"> ↗</a>}</div>
      <div className="ex-chips small">
        <span className="ex-chip" title={`${d.concept.path}\n${d.concept.files} files tracked by git`}>{d.concept.files} files</span>
        {introduced && <a className="ex-chip" href={introduced.commit.url ?? undefined} target="_blank" rel="noreferrer" title={`First seen ${introduced.date.slice(0, 10)} by ${introduced.commit.author}\n${introduced.commit.subject}\n${introduced.source}${introduced.approx ? '\n≈ estimate: this clone is shallow' : ''}`}>since {introduced.date.slice(0, 7)}{introduced.approx ? ' ≈' : ''}</a>}
        <span className="ex-chip" title={`Built on ${allCount(d.dependsOn)} modules: ${specificCount(d.dependsOn)} specific, ${allCount(d.dependsOn) - specificCount(d.dependsOn)} shared foundations`}>built on {specificCount(d.dependsOn)}</span>
        <span className="ex-chip" title={`${allCount(d.usedBy)} modules build on it: ${specificCount(d.usedBy)} specific, ${allCount(d.usedBy) - specificCount(d.usedBy)} shared foundations`}>used by {specificCount(d.usedBy)}</span>
      </div>
      <div className="ex-what small">
        {sum?.ai && <div title={`AI summary (${sum.ai.model}), written only from this module's docs, models and largest files${sum.ai.sources?.length ? `:\n${sum.ai.sources.join('\n')}` : ''}\nRedone when the folder changes.`}><div className="ex-what-md"><Markdown text={sum.ai.text} /></div><span className="ex-badge">AI</span></div>}
        {sum?.own && <div className="muted" title={`In the team's own words, from ${sum.own.file}`}>“{sum.own.text}” <span className="tiny">{sum.own.file.split('/').pop()}</span></div>}
        {sum?.status === 'generating' && <div className="muted"><i className="spin" /> writing a short summary…</div>}
        {sum?.status === 'error' && !sum?.own && <div className="muted tiny" title={sum.error}>No summary yet (couldn't write one).</div>}
      </div>
      {use?.applies && <UsageLine u={use} />}
      <div className="ex-actions small">
        <button className="small" onClick={onAsk} title="Ask the chat about this concept; it gets the map's evidence and is told to cite files">Ask</button>
        <button className="small" onClick={() => onFocus(d.concept.id)} title="Re-center the map on this concept">Focus</button>
        <button className="small" onClick={onRemove} title="Dream mode: see what would break if this were removed">What if removed?</button>
      </div>
      <Section id="runs" title="Where it runs" summary={runs} hint="Argo CD apps with the concept's name in theirs. Only “runs your code” is proven (the image is tagged with a commit in your repo); others just share the name. A module inside a bigger app (a Django product in the web app) has no app of its own.">
        <WhereItRuns concept={d.concept.id} repos={workspace} org={org} onLoaded={onRuntime} bare onSummary={setRuns} />
      </Section>
      <Section id="data" title="Data" summary={data} hint="ClickHouse tables its code names (or named like it), read from system tables via Grafana; disk fullness from Prometheus; instance types from terraform. Click any number for its query.">
        <DataSection concept={d.concept.id} repos={workspace} bare onSummary={setData} />
      </Section>
      <Section id="builton" title="Built on" summary={`${specificCount(d.dependsOn)} specific${allCount(d.dependsOn) > specificCount(d.dependsOn) ? ` + ${allCount(d.dependsOn) - specificCount(d.dependsOn)} shared` : ''}`} hint="Modules this one imports or has foreign keys to. ▸ shows the lines of code; click a name to focus the map there.">
        <Edges title="Built on" list={d.dependsOn} other="to" />
      </Section>
      <Section id="usedby" title="Built on it" summary={`${specificCount(d.usedBy)} specific${allCount(d.usedBy) > specificCount(d.usedBy) ? ` + ${allCount(d.usedBy) - specificCount(d.usedBy)} shared` : ''}`} hint="Modules that import this one or have foreign keys to it: what would feel a change here.">
        <Edges title="Built on it" list={d.usedBy} other="from" />
      </Section>
      <Section id="code" title="Code" summary={[d.docs.length ? `${d.docs.length} docs` : '', d.models.length ? `${d.models.length} models` : '', d.largest.length ? 'largest files' : ''].filter(Boolean).join(' · ')} hint="Where to start reading: the team's own notes, the data models (with what they point at), and the biggest files.">
        {d.docs.length > 0 && <div className="ex-sub"><div className="ex-subh">Read first</div>{d.docs.map((x: any) => <div key={x.file} className="small"><Loc x={x} /></div>)}</div>}
        {d.models.length > 0 && (
          <div className="ex-sub"><div className="ex-subh">Data models</div>
            {d.models.slice(0, more.models ? 999 : 8).map((m: any) => {
              const rels = d.relations.filter((r: any) => r.model === m.name)
              return <div key={m.name} className="small"><b>{m.name}</b> <Loc x={m} />{rels.length > 0 && <span className="muted"> → {[...new Set(rels.map((r: any) => `${r.target}${r.kind !== 'fk' ? ` (${r.kind})` : ''}`))].join(', ')}</span>}</div>
            })}
            {d.models.length > 8 && <button className="link small" onClick={() => setMore(m => ({ ...m, models: !m.models }))}>{more.models ? 'fewer' : `+${d.models.length - 8} more`}</button>}
          </div>
        )}
        {d.largest.length > 0 && <div className="ex-sub"><div className="ex-subh">Largest files</div>{d.largest.slice(0, 5).map((x: any) => <div key={x.file} className="small"><Loc x={x} /> <span className="muted">{Math.round(x.size / 1024)} KB</span></div>)}</div>}
      </Section>
      <Section id="history" title="History" summary={introduced ? `since ${introduced.date.slice(0, 7)}${introduced.approx ? ' ≈' : ''} · ${d.recent.length ? `last change ${d.recent[0].date.slice(0, 10)}` : ''}` : d.recent.length ? `last change ${d.recent[0].date.slice(0, 10)}` : ''} hint="When it appeared and who added it, its biggest changes (in the history this clone has), and its latest commits.">
        {introduced && <div className="small ex-sub">First seen <b>{introduced.date.slice(0, 10)}</b>{introduced.approx ? ' ≈' : ''} by {introduced.commit.author}{introduced.commit.url && <> · <a href={introduced.commit.url} target="_blank" rel="noreferrer">{introduced.commit.pr ? `#${introduced.commit.pr}` : introduced.commit.sha.slice(0, 8)}</a></>} <span className="muted">{introduced.commit.subject}</span><div className="tiny muted">{introduced.source}</div></div>}
        {milestones && milestones.length > 0 && <div className="ex-sub"><div className="ex-subh" title="By lines changed, in the history this checkout has">Biggest changes</div>{milestones.map(c => <div key={c.sha} className="small ellipsis" title={`${c.subject} · ${c.author}`}><span className="muted">{c.date.slice(0, 10)}</span> {c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.pr ? `#${c.pr}` : c.sha.slice(0, 8)}</a> : null} {c.subject}</div>)}</div>}
        {d.recent.length > 0 && <div className="ex-sub"><div className="ex-subh">Recent commits</div>{d.recent.slice(0, 5).map((c: Commit) => <div key={c.sha} className="small ellipsis" title={`${c.subject} · ${c.author}`}><span className="muted">{c.date.slice(0, 10)}</span> {c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.pr ? `#${c.pr}` : c.sha.slice(0, 8)}</a> : null} {c.subject}</div>)}</div>}
      </Section>
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

// What a link is, in words, with the lines of code that make it. Hover to peek; click the link to pin and use the links.
function EdgeCard({ c, repo, onClose }: { c: { e: Edge; x: number; y: number; pinned: boolean }; repo: string; onClose: () => void }) {
  const { e } = c
  const fk = e.kind === 'fk'
  const open = (file: string, line?: number) => post('/api/explore/open', { repo, file, line }).catch(err => toast(String(err?.message ?? err), { kind: 'error' }))
  const left = Math.max(8, c.x + 14), top = Math.max(8, c.y + 14)
  return (
    <div className={`ex-edgecard small ${c.pinned ? 'pinned' : ''}`} style={{ left, top }} onPointerDown={ev => ev.stopPropagation()}>
      <div className="ex-edgecard-head"><b>{label(e.from)}</b> <span className="muted">is built on</span> <b>{label(e.to)}</b>{c.pinned && <button className="link small" onClick={onClose}>×</button>}</div>
      <div className={fk ? 'ex-kind fk' : 'muted'}>
        {fk ? `Foreign key: a model in ${label(e.from)} references a table in ${label(e.to)} (${e.weight} relation${e.weight === 1 ? '' : 's'}). A database link: removing it needs a migration.`
          : `Code import: ${e.weight} file${e.weight === 1 ? '' : 's'} in ${label(e.from)} import from ${label(e.to)}.`}
      </div>
      <div className="ex-evidence">
        {e.evidence.slice(0, c.pinned ? 5 : 3).map((x, i) => (
          <div key={i}>
            {c.pinned ? <button className="link" onClick={() => open(x.file, x.line)} title="Open in your editor">{x.file}:{x.line}</button> : <span className="muted">{x.file}:{x.line}</span>}
            <code>{x.text.slice(0, 220)}</code>
          </div>
        ))}
        {e.weight > e.evidence.length && <div className="muted tiny">+{e.weight - e.evidence.length} more {fk ? 'relations' : 'files'}</div>}
        {!e.evidence.length && <div className="muted tiny">Added in this dream, so there's no code behind it yet.</div>}
      </div>
      {!c.pinned && <div className="muted tiny">Click the link to pin this and open files.</div>}
    </div>
  )
}

// One quiet line: weekly users now, its 26-week shape as a sparkline, and where it ranks among products.
function UsageLine({ u }: { u: any }) {
  const pts: number[] = u.weeks.map((w: any) => w.users)
  const max = Math.max(1, ...pts), W = 90, H = 18
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${(i / Math.max(1, pts.length - 1)) * W},${H - (v / max) * (H - 2) - 1}`).join(' ')
  const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)
  const shape = `${u.trend}${u.spiky ? ', spiky' : ''}${u.change != null && u.trend !== 'steady' ? ` (${u.change > 0 ? '+' : ''}${Math.round(u.change * 100)}%)` : ''}`
  const tip = `${u.source}\nWeekly users, last ${pts.length} complete weeks (from ${u.weeks[0].week})${u.rank ? `\nRank among ${u.of} products by users in the last 4 weeks: #${u.rank}` : ''}\n${u.weeks.map((w: any) => `${w.week}: ${k(w.users)}`).join('\n')}`
  return (
    <div className="ex-usage small muted" title={tip}>
      <span>≈<b>{k(u.latest)}</b> weekly users</span>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}><path d={d} fill="none" stroke="var(--accent)" strokeWidth="1.5" /></svg>
      <span>{shape}</span>
      {u.rank && <span>· #{u.rank} of {u.of} products</span>}
      {pts.length < 20 && <span>· pages since {u.weeks[0].week.slice(0, 7)}</span>}
    </div>
  )
}
