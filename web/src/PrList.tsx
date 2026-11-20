// The sidebar's PR view, like GitHub's: every open PR in one list, newest first, nothing folded
// away. Group by area (the workstreams Claude filed them into: "Metrics", "MCP analytics") if you
// like, and filter to the ones closest to merging.
import { useState } from 'react'
import { ago, post, toast, useLive } from './api'
import { PrMenu } from './Home'
import { type Agent, AgentAvatar, AgentStack, agentLine } from './Agents'

export type SidePr = { head?: string; base?: string; url: string; number: number; title: string; repo: string; author: string; mine: boolean; draft: boolean; state: string; review: string | null; checks: string | null
  createdAt?: number; updatedAt: number; mergedAt: number | null; direct: boolean; teams: string[]; action: string | null; workers: any[]; agents: Agent[]; conversations: number; lastTalk: number | null; snoozed: boolean }
type Data = { me: string; fetchedAt: number; sorting: boolean; scout: Agent | null; sections: { id: string; title: string; icon: string | null; working: number; needs: number; prs: SidePr[] }[] }
type Sort = 'newest' | 'updated' | 'oldest'

const saved = <T,>(key: string, init: T): T => { try { return (localStorage.getItem(key) as T) ?? init } catch { return init } }
const keep = (key: string, v: string) => { try { localStorage.setItem(key, v) } catch {} }

export function PrList({ selected, onOpen, onOpenConversation }: { selected: string | null; onOpen: (url: string) => void; onOpenConversation: (id: string) => void }) {
  const { data, error, reload } = useLive<Data>('/api/prs/sidebar', ['prs', 'chats'])
  const [q, setQ] = useState('')
  const [only, setOnly] = useState<string | null>(null)
  const [byArea, setByAreaS] = useState(() => saved<string>('perch.prlist.group', '') === 'area')
  const [sort, setSortS] = useState<Sort>(() => saved<Sort>('perch.prlist.sort', 'newest'))
  const setByArea = (v: boolean) => { setByAreaS(v); keep('perch.prlist.group', v ? 'area' : '') }
  const setSort = (v: Sort) => { setSortS(v); keep('perch.prlist.sort', v) }
  const [menu, setMenu] = useState<{ x: number; y: number; pr: string; title: string; draft?: boolean; red?: boolean } | null>(null)
  if (!data) return <div className="pad muted small">{error ?? 'Reading your PRs from GitHub…'}</div>
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const kind = only ? KINDS.find(k => k.id === only) : null
  const match = (p: SidePr) => (!kind || kind.test(p)) && words.every(w => `${p.title} ${p.repo} #${p.number} ${p.teams.join(' ')} ${p.author}`.toLowerCase().includes(w))
  const all = data.sections.flatMap(x => x.prs)
  const areaOf = new Map(data.sections.flatMap(x => x.prs.map(p => [p.url, x] as const)))
  const opened = (p: SidePr) => p.createdAt ?? p.updatedAt
  // "Ready to merge" orders by how close each is; otherwise the sort you picked.
  const order = (a: SidePr, b: SidePr) => (only === 'ready' ? closeness(a) - closeness(b) : 0)
    || (sort === 'updated' ? b.updatedAt - a.updatedAt : sort === 'oldest' ? opened(a) - opened(b) : opened(b) - opened(a))
  // Where a PR sits in a stack (1/2 at the bottom), as GitHub shows it.
  const stackPos = new Map<string, string>()
  for (const it of stacked(all)) if (it.kind === 'stack') it.prs.forEach((p, i) => stackPos.set(p.url, `${i + 1}/${it.prs.length}`))
  const shown = all.filter(match).sort(order)
  const groups = byArea
    ? data.sections.map(s => ({ s, prs: shown.filter(p => areaOf.get(p.url) === s) })).filter(g => g.prs.length)
    : [{ s: null, prs: shown }]

  const row = (p: SidePr) => {
    const r = red(p)
    return (
      <div key={p.url} className={`pr-row gh${selected === p.url ? ' active' : ''}`} onClick={() => onOpen(p.url)}
        onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, pr: p.url, title: p.title, draft: p.draft, red: r }) }}>
        <div className="row-top">
          <span className={`pr-state ${p.state === 'MERGED' ? 'merged' : p.draft ? 'draft' : 'open'}`} title={p.state === 'MERGED' ? 'merged' : p.draft ? 'draft' : 'open'} />
          <span className="row-title" title={p.title}>{p.title}</span>
          <AgentStack list={p.agents} size={18} />
        </div>
        <div className="row-meta small muted">
          <span className="nowrap">#{p.number} · {p.repo.split('/')[1]} · opened {ago(opened(p))} ago</span>
          {stackPos.has(p.url) && <span className="nowrap" title="Position in its stack (1 is the bottom)">· ⧉ {stackPos.get(p.url)}</span>}
          {reviewText(p) && <span className={`nowrap ${p.review === 'CHANGES_REQUESTED' ? 'bad' : ''}`}>· {reviewText(p)}</span>}
          {checksMark(p.checks)}
          {p.action && p.action !== 'review it' && <ActionMark action={p.action} />}
          {p.conversations > 0 && <span className="nowrap" title={`${p.conversations} conversation${p.conversations > 1 ? 's' : ''} about it`}>💬{p.conversations}</span>}
        </div>
        {p.agents[0] && p.agents[0].state !== 'waiting' && <div className={`pr-agent-line ${p.agents[0].state}`} title={p.agents.map(a => `${a.name}: ${agentLine(a)}`).join('\n')}><b>{p.agents[0].name}</b> {agentLine(p.agents[0])}</div>}
      </div>
    )
  }
  return (
    <div className="pr-list">
      <div className="pr-list-search row-flex">
        <input className="grow" value={q} placeholder="Filter PRs" onChange={e => setQ(e.target.value)} />
        <button className="icon" onClick={() => fetch('/api/prs/sidebar?fresh=1').then(reload)} title={`Updated ${ago(data.fetchedAt)} ago. Refresh from GitHub`}>↻</button>
      </div>
      {data.scout && <div className={`pr-scout ${data.scout.state}`} title={`${data.scout.name}: ${agentLine(data.scout)}\n(${data.scout.proof})`}>
        <AgentAvatar a={data.scout} size={20} /><div className="grow" style={{ minWidth: 0 }}><div className="small ellipsis"><b>{data.scout.name}</b></div><div className="tiny muted ellipsis">{agentLine(data.scout)}</div></div></div>}
      <div className="pr-counts">{KINDS.map(k => { const n = all.filter(k.test).length; return n || k.id === 'open' ? (
        <button key={k.id} className={`pr-count ${k.cls}${only === k.id ? ' on' : ''}`} onClick={() => setOnly(only === k.id || k.id === 'open' ? null : k.id)} title={k.hint}><b>{n}</b> {k.label}</button>) : null })}
        {(only === 'red' || only === 'changes') && <FixAll prs={all.filter(KINDS.find(k => k.id === only)!.test)} goal={only === 'red' ? 'ci' : 'comments'} onOpen={onOpenConversation} />}</div>
      <div className="pr-view-bar small">
        <span className="seg">
          <button className={byArea ? '' : 'on'} onClick={() => setByArea(false)}>All</button>
          <button className={byArea ? 'on' : ''} onClick={() => setByArea(true)}>By area</button>
        </span>
        {byArea && <button className="icon" onClick={() => post('/api/prs/resort', {})} title="Let Claude sort your PRs into areas again (PRs you moved by hand stay put)">⇅</button>}
        <span className="grow" />
        <select value={sort} onChange={e => setSort(e.target.value as Sort)} disabled={only === 'ready'} title={only === 'ready' ? 'Closest to merging first' : 'Sort'}>
          <option value="newest">Newest</option><option value="updated">Recently updated</option><option value="oldest">Oldest</option>
        </select>
      </div>
      {byArea && data.sorting && <div className="pad muted small">Sorting your PRs into areas…</div>}
      <div className="pr-list-scroll">
        {groups.map(({ s, prs }) => (
          <div key={s?.id ?? 'all'} className="pr-group">
            {s && <div className="pr-group-head">{s.icon && <span className="pr-group-icon">{s.icon}</span>}<span className="ellipsis">{s.title}</span><span className="count">{prs.length}</span></div>}
            {prs.map(row)}
          </div>
        ))}
        {!shown.length && <div className="pad muted small">No PRs match.</div>}
      </div>
      {menu && <PrMenu target={menu} onClose={() => setMenu(null)} onOpen={onOpenConversation} onDone={reload} />}
    </div>
  )
}

const reviewText = (p: SidePr) => p.draft ? 'Draft' : p.review === 'APPROVED' ? 'Approved' : p.review === 'CHANGES_REQUESTED' ? 'Changes requested' : p.review === 'REVIEW_REQUIRED' ? 'Review required' : ''
function checksMark(c: string | null) {
  if (c === 'SUCCESS') return <span className="ck good" title="Checks pass">✓</span>
  if (c === 'FAILURE' || c === 'ERROR') return <span className="ck bad" title="Checks fail">✕</span>
  if (c === 'PENDING' || c === 'EXPECTED') return <span className="ck wait" title="Checks running">●</span>
  return null
}
// How far from merging: 0 is ready now. Drafts, red CI and requested changes aren't close.
function closeness(p: SidePr) {
  const green = p.checks === 'SUCCESS', approved = p.review === 'APPROVED'
  if (p.action === 'ready to merge') return 0
  if (approved && green) return 1 // open threads or a conflict
  if (approved) return 2 // checks still running
  if (green) return 3 // waiting on a review
  return 4
}
const closeEnough = (p: SidePr) => p.state === 'OPEN' && !p.draft && !red(p) && p.review !== 'CHANGES_REQUESTED'

// Stacks: a PR whose base branch is another listed PR's branch builds on it. Chains of 2+ become
// one row (bottom first inside), so a stack reads as one piece of work you can still open up.
type Item = { kind: 'pr'; pr: SidePr } | { kind: 'stack'; root: string; prs: SidePr[] }
function stacked(prs: SidePr[]): Item[] {
  const byHead = new Map(prs.map(p => [`${p.repo}:${p.head}`, p]))
  const parent = (p: SidePr) => byHead.get(`${p.repo}:${p.base}`)
  const kids = new Map<string, SidePr[]>()
  for (const p of prs) { const b = parent(p); if (b && b !== p) kids.set(b.url, [...(kids.get(b.url) ?? []), p]) }
  const used = new Set<string>()
  const out: Item[] = []
  for (const p of prs) {
    if (used.has(p.url)) continue
    let root = p
    for (let b = parent(root), i = 0; b && b !== root && i < 20; b = parent(b), i++) root = b
    const chain: SidePr[] = []
    const walk = (x: SidePr) => { if (used.has(x.url)) return; used.add(x.url); chain.push(x); for (const k of kids.get(x.url) ?? []) walk(k) }
    walk(root)
    if (!chain.includes(p)) { used.add(p.url); out.push({ kind: 'pr', pr: p }); continue }
    out.push(chain.length > 1 ? { kind: 'stack', root: root.url, prs: chain } : { kind: 'pr', pr: chain[0] })
  }
  return out
}
// The stack's state in one chip: anything red wins, then what's left to do, then ready.
function stackStatus(prs: SidePr[]) {
  const red = prs.filter(p => p.checks === 'FAILURE' || p.checks === 'ERROR').length
  const changes = prs.filter(p => p.review === 'CHANGES_REQUESTED').length
  const ready = prs.filter(p => p.action === 'ready to merge').length
  if (red) return <span className="pr-action bad">CI red in {red}</span>
  if (changes) return <span className="pr-action bad">changes in {changes}</span>
  if (ready === prs.length) return <span className="pr-action good">all ready</span>
  if (ready) return <span className="pr-action good">{ready}/{prs.length} ready</span>
  const drafts = prs.filter(p => p.draft).length
  return drafts ? <span className="muted small">{drafts} draft{drafts > 1 ? 's' : ''}</span> : null
}
const dedupeAgents = (list: any[]) => [...new Map(list.map(a => [a.key ?? a.name, a])).values()]

// Titles without the conventional-commit prefix: "feat(metrics): count queries" reads as
// "count queries", with a small mark for the kind of change. The full title is on hover.
const CC = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/
export const shortTitle = (t: string) => { const m = t.match(CC); return m ? m[3].charAt(0).toUpperCase() + m[3].slice(1) : t }
const TYPES: Record<string, [string, string]> = { feat: ['✦', 'feature'], fix: ['🩹', 'fix'], chore: ['⚙', 'chore'], docs: ['📄', 'docs'], refactor: ['♻', 'refactor'], test: ['🧪', 'tests'], perf: ['⚡', 'performance'], ci: ['⚙', 'CI'], revert: ['↩', 'revert'], build: ['⚙', 'build'], style: ['✎', 'style'] }
export function TypeMark({ title }: { title: string }) {
  const m = title.match(CC)
  const t = m && TYPES[m[1].toLowerCase()]
  return t ? <span className="type-mark" title={`${t[1]}${m![2] ? ` · ${m![2]}` : ''}`}>{t[0]}</span> : null
}
// The next step as an icon, the words on hover.
export function ActionMark({ action }: { action: string }) {
  const [icon, cls] = /CI is red/.test(action) ? ['✕', 'bad'] : /changes/.test(action) ? ['!', 'bad'] : action === 'ready to merge' ? ['✓', 'good']
    : /^approved/.test(action) ? [`✓ ${(action.match(/(\d+) open/) ?? [])[1] ?? '!'}`, 'ask'] : /review/.test(action) ? ['👀', 'ask'] : ['•', 'ask']
  return <span className={`action-mark ${cls}`} title={action}>{icon}</span>
}

const red = (p: SidePr) => p.checks === 'FAILURE' || p.checks === 'ERROR'
const KINDS: { id: string; label: string; cls: string; hint: string; test: (p: SidePr) => boolean }[] = [
  { id: 'open', label: 'open', cls: '', hint: 'All your open PRs', test: p => p.state === 'OPEN' && !p.draft },
  { id: 'draft', label: 'drafts', cls: '', hint: 'Drafts', test: p => p.draft },
  { id: 'ready', label: 'ready to merge', cls: 'good', hint: 'Closest to merging first: ready now, then approved with threads left, approved with checks running, green waiting on review', test: closeEnough },
  { id: 'red', label: 'CI red', cls: 'bad', hint: 'Failing checks', test: p => !p.draft && red(p) },
  { id: 'changes', label: 'changes', cls: 'bad', hint: 'A reviewer requested changes', test: p => p.review === 'CHANGES_REQUESTED' },
]

// Fix every PR in the filtered list at once. PRs with an agent already at work are left alone.
function FixAll({ prs, goal, onOpen }: { prs: SidePr[]; goal: 'ci' | 'comments'; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const todo = prs.filter(p => !(p.agents ?? []).some((a: any) => a.state === 'working'))
  const busyN = prs.length - todo.length
  if (!prs.length) return null
  const go = async (where: 'here' | 'cloud') => {
    const what = goal === 'ci' ? 'fix CI on' : 'address review comments on'
    if (!confirm(`${where === 'here' ? 'One agent here will' : `${todo.length} cloud agents will`} ${what} ${todo.length} PR${todo.length > 1 ? 's' : ''}, pushing commits to their branches.${busyN ? `\n\n${busyN} already have an agent working and are left out.` : ''}`)) return
    setBusy(true)
    const r = await post<any>('/api/prs/orchestrate', { prs: todo.map(p => ({ url: p.url, title: p.title, head: p.head, base: p.base, checks: p.checks, review: p.review, action: p.action, draft: p.draft })), where, goal })
    setBusy(false); setOpen(false)
    if (r.message) toast(r.message, { kind: r.error ? 'error' : 'ok' })
    if (r.conversationId) onOpen(r.conversationId)
  }
  return (
    <span className="fix-all">
      <button className="pr-count fix" disabled={busy || !todo.length} onClick={() => setOpen(!open)} title={todo.length ? `Put agents on ${todo.length === 1 ? 'it' : `all ${todo.length}`}` : 'Every one already has an agent working'}>{busy ? 'starting…' : todo.length === prs.length ? `⚡ Fix these ${todo.length}` : `⚡ Fix ${todo.length} of ${prs.length}`}</button>
      {open && (
        <span className="fix-all-menu">
          <button onClick={() => go('here')} title="One turbo agent on this Mac sees them all: stacks bottom-up, the rest in parallel, each in its own worktree; it checks back on CI after pushing">One agent across all · here</button>
          <button onClick={() => go('cloud')} title="A separate cloud agent per PR; keeps going while the laptop sleeps">A cloud agent per PR</button>
        </span>
      )}
    </span>
  )
}
