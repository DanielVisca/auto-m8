import React, { useEffect, useRef, useState } from 'react'
import { SHOW_LABELS, ago, baseName, post, STATES, titleOf, useLive, type Conversation, type PR, type State, type Term } from './api'
import { escapeSnippet } from './Chat'
import { FocusBanner } from './Focus'
import { Popover } from './Popover'
import { PrPreviewCard } from './PrPreview'
import { Brand, sourceBrand } from './Brand'
import { PrAgents } from './Agents'

const SOURCE_LABEL: Record<string, string> = { claude: 'Claude Code', 'posthog-code': 'PostHog Code', 'posthog-task': 'PostHog task', cursor: 'Cursor', import: 'Copied from another profile' }

// Hovering a PR badge for a moment shows its preview; moving into the card keeps it open.
export { usePrAgents as usePrWorkers } from './Agents'
// A half-recorded PR (no link) shows nothing rather than taking the panel down.
// `reason`: why the PR is in the list it's shown in (e.g. "CI is red"), put at the top of its hover card.
export function PrBadge({ pr, full, reason }: { pr: PR; full?: boolean; reason?: { label: string; text: string } }) {
  return pr?.url ? <PrBadgeHover pr={pr} full={full} reason={reason} /> : null
}

function PrBadgeHover({ pr, full, reason }: { pr: PR; full?: boolean; reason?: { label: string; text: string } }) {
  const ref = useRef<HTMLAnchorElement>(null)
  const [hover, setHover] = useState(false)
  const timer = useRef<any>(null)
  const enter = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setHover(true), 450) }
  const leave = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setHover(false), 250) }
  return (
    <>
      <PrBadgeLink pr={pr} full={full} aRef={ref} onEnter={enter} onLeave={leave} />
      {hover && (
        <Popover anchor={ref} open={hover} onClose={() => setHover(false)} width={440}>
          <div onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={leave}><PrPreviewCard url={pr.url} reason={reason} /></div>
        </Popover>
      )}
    </>
  )
}

function PrBadgeLink({ pr, full, aRef, onEnter, onLeave }: { pr: PR; full?: boolean; aRef: React.RefObject<HTMLAnchorElement | null>; onEnter: () => void; onLeave: () => void }) {
  const state = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.draft ? 'draft' : pr.state ? 'open' : 'unknown'
  const flag = pr.state === 'OPEN' && (pr.checks === 'FAILURE' || pr.checks === 'ERROR') ? '✗' : pr.review === 'CHANGES_REQUESTED' ? '!' : pr.review === 'APPROVED' ? '✓' : ''
  const n = pr.number ?? pr.url?.split('/').pop()
  return (
    <a ref={aRef} onMouseEnter={onEnter} onMouseLeave={onLeave} className={`pr ${state}`} href={pr.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
      title={`${pr.repo ?? ''} #${n} ${pr.title ?? ''}\n${state}${pr.review ? ` · review ${pr.review.toLowerCase()}` : ''}${pr.checks ? ` · checks ${pr.checks.toLowerCase()}` : ''}`}>
      #{n}{flag && <b>{flag}</b>}<PrAgents url={pr.url} size={13} />{full && pr.title ? <span className="pr-title"> {pr.title}</span> : null}
    </a>
  )
}

export function StateMenu({ c }: { c: Conversation }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const set = (state: State | null) => { post(`/api/conversations/${encodeURIComponent(c.id)}/state`, { state }); setOpen(false) }
  const manual = c.state && c.state_auto === 0
  return (
    <div className="state-menu" onClick={e => e.stopPropagation()}>
      <button ref={ref} className={`state-pill s-${c.effective}`} onClick={() => setOpen(!open)} title={manual ? 'Set by you' : 'Automatic'}>
        {STATES.find(s => s.id === c.effective)?.label}{manual ? ' •' : ''}
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)}>
        <div className="menu">
          {STATES.filter(s => !['running', 'idle'].includes(s.id)).map(s => (
            <button key={s.id} onClick={() => set(s.id)} title={s.hint}><span className={`dot s-${s.id}`} /> {s.label}</button>
          ))}
          <hr />
          <button onClick={() => set(null)} title="Let auto-m8 decide from activity and PRs">Automatic</button>
          <button onClick={() => { post(`/api/conversations/${encodeURIComponent(c.id)}/state`, { pinned: !c.pinned }); setOpen(false) }}>{c.pinned ? 'Unpin' : 'Pin'}</button>
        </div>
      </Popover>
    </div>
  )
}

function Row({ c, active, selected, onOpen, onMenu, onSelect }: {
  c: Conversation; active: boolean; selected: boolean; onOpen: (c: Conversation) => void
  onMenu: (e: React.MouseEvent, c: Conversation) => void; onSelect: (e: React.MouseEvent, c: Conversation) => void
}) {
  const snoozed = c.state === 'later' && c.snooze_until && c.snooze_until > Date.now()
  // Touch screens have no right-click: a long press opens the same menu.
  const press = useRef<{ t: any; fired: boolean } | null>(null)
  const touch = {
    onTouchStart: (e: React.TouchEvent) => {
      const { clientX, clientY } = e.touches[0]
      press.current = { fired: false, t: setTimeout(() => { press.current!.fired = true; navigator.vibrate?.(10); onMenu({ clientX, clientY } as React.MouseEvent, c) }, 480) }
    },
    onTouchMove: () => { clearTimeout(press.current?.t) },
    onTouchEnd: (e: React.TouchEvent) => { clearTimeout(press.current?.t); if (press.current?.fired) e.preventDefault() },
  }
  // Pinned rows sit inside a padded box, so they have room for one pill fewer.
  const maxPrs = c.pinned ? 2 : 3
  return (
    <div className={`row ${active ? 'active' : ''} ${selected ? 'selected' : ''} ${c.pinned ? 'pinned' : ''} ${(c as any).unread && !active ? 'unread' : 'read'} ${['archived', 'done', 'hidden'].includes(c.effective) ? 'dim' : ''}`} {...touch}
      onClick={e => (e.metaKey || e.shiftKey ? onSelect(e, c) : onOpen(c))} onContextMenu={e => { e.preventDefault(); onMenu(e, c) }}>
      <div className="row-top">
        <span className={`dot s-${c.effective}`} title={c.effective} />
        <span className="row-title">{c.returned ? '↩ ' : ''}{(c as any).automated ? '🤖 ' : ''}{titleOf(c).replace(/^\[sandbox_prompt:[^\]]*\]\s*/, '')}</span>
        <span className="muted small" title={snoozed ? `snoozed until ${new Date(c.snooze_until!).toLocaleString()}` : ''}>{snoozed ? `⏾ ${ago(2 * Date.now() - c.snooze_until!)}` : ago(c.activity_at ?? c.updated_at)}</span>
      </div>
      {c.snippet && <div className="snippet small" dangerouslySetInnerHTML={{ __html: escapeSnippet(c.snippet) }} />}
      {c.reason && <div className="reason small">{c.reason}{c.reason.startsWith('auto-m8 flagged') && <button className="linklike small" title="Not worth my attention: stop flagging it until it moves again" onClick={e => { e.stopPropagation(); post(`/api/conversations/${encodeURIComponent(c.id)}/not-needed`) }}> · not needed</button>}</div>}
      <div className="row-meta conv-meta">
        {(c as any).promise && <PromiseMark p={(c as any).promise} />}
        {c.source === 'claude' && (c as any).models?.length
          ? <ModelStack models={(c as any).models} local={(c as any).local_engine} />
          : <Brand id={sourceBrand(c)} size={13} title={c.source === 'posthog-task' && c.origin === 'slack' ? 'Asked in Slack' : SOURCE_LABEL[c.source]} />}
        {(c as any).has_browser && <Brand id="chrome" size={13} title="Has an Agent Chrome window open" />}
        <span className="muted small ellipsis" title={c.source === 'posthog-task' ? '' : `Folder it ran in: ${c.cwd ?? '?'}${c.branch ? `\nBranch: ${c.branch}` : ''}`}>{c.source === 'posthog-task' ? (c.origin ?? 'task') : [(c as any).place, c.branch && !['main', 'master', 'HEAD'].includes(c.branch) ? c.branch : ''].filter(Boolean).join(' · ')}</span>
        {(c as any).agent_kind && c.source !== 'posthog-task' && <span className="label" title="Started by auto-m8's automation, not you. Write in it and it becomes yours.">{(c as any).agent_kind}</span>}
        {SHOW_LABELS && c.labels?.slice(0, 2).map(l => <span key={l} className="label">#{l}</span>)}
        {c.link_count > 0 && <span className="muted small" title={`Linked to ${c.link_count} other conversation${c.link_count > 1 ? 's' : ''} (same PR, follow-ups, or ones an agent used). Open it to see them.`}>⇄{c.link_count}</span>}
        <span className="grow" />
        {c.prs.length > 0 && <span className="row-prs">
          {c.prs.slice(0, maxPrs).map(pr => <PrBadge key={pr.url} pr={pr} />)}
          {c.prs.length > maxPrs && <span className="muted small pr-more">+{c.prs.length - maxPrs}</span>}
        </span>}
      </div>
    </div>
  )
}

const FILTERS: { id: string; label: string; states: State[] }[] = [
  { id: 'now', label: 'Now', states: ['running', 'waiting', 'active'] },
  { id: 'waiting', label: 'Waiting chats', states: ['waiting'] },
  { id: 'running', label: 'Running', states: ['running'] },
  { id: 'later', label: 'Later', states: ['later'] },
  { id: 'done', label: 'Done', states: ['done'] },
  { id: 'all', label: 'All', states: [] },
  { id: 'archived', label: 'Archived', states: ['archived'] },
  { id: 'hidden', label: 'Hidden', states: ['hidden'] },
  { id: 'auto', label: 'Automated', states: [] },
]

const SEARCH_HELP = `Words and "phrases" search titles, messages, labels, notes, branches and PR titles.
Filters: #label  -#label  in:claude | code | task  where:slack | cloud | mac | auto-m8 | ollama  state:waiting  repo:posthog  pr:1234  project:dash  is:pinned  older:7d  newer:2d
Ask a question in plain words and use "Ask Claude" for an answer from your history.`

export function List({ selectedId, onOpen, terms, selectedTerm, onOpenTerm, searchRef, onMenu, onAsk, onSearchEverywhere }: {
  selectedId: string | null; onOpen: (c: Conversation) => void
  terms: Term[]; selectedTerm: string | null; onOpenTerm: (id: string) => void; searchRef: React.RefObject<HTMLInputElement | null>
  onMenu: (x: number, y: number, items: Conversation[]) => void; onAsk: (q: string) => void; onSearchEverywhere: (q: string) => void
}) {
  const [q, setQ] = useState(() => sessionStorage.getItem('perch.q') ?? '')
  // Browsing is organised by state (see Organised); searching looks everywhere. No filter chips.
  const [filter, setFilter] = useState('now')
  const [sort, setSort] = useState(() => localStorage.getItem('perch.sort') ?? 'updated')
  const [debounced, setDebounced] = useState(q)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const lastClicked = useRef<string | null>(null)
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 180); try { sessionStorage.setItem('perch.q', q) } catch {} return () => clearTimeout(t) }, [q])
  useEffect(() => { try { localStorage.setItem('perch.filter', filter); localStorage.setItem('perch.sort', sort) } catch {} }, [filter, sort])
  useEffect(() => { const f = () => { setFilter('all'); setSort('updated'); setQ('') }; window.addEventListener('perch-recent', f); return () => window.removeEventListener('perch-recent', f) }, [])

  const searching = debounced.trim().length > 0
  const f = FILTERS.find(x => x.id === filter) ?? FILTERS[0]
  const params = new URLSearchParams({ sort: searching && sort === 'updated' ? 'relevance' : sort })
  // Agent runs (shepherds, helpers, scouts) stay out of a search unless you add them.
  const [withAgents, setWithAgents] = useState(() => localStorage.getItem('perch.searchAgents') === '1')
  useEffect(() => { try { localStorage.setItem('perch.searchAgents', withAgents ? '1' : '0') } catch {} }, [withAgents])
  const autoQ = filter === 'auto' ? ' is:auto' : searching && withAgents && !/\bis:(any|auto)\b/.test(debounced) ? ' is:any' : ''
  if (searching || autoQ) params.set('q', debounced + autoQ)
  // A search looks everywhere unless you pick a filter other than Now.
  if (f.states.length && !(searching && filter === 'now')) params.set('states', f.states.join(','))
  const { data } = useLive<{ conversations: Conversation[]; counts: Record<string, number>; focus: { areas: { name: string; query: string }[]; hidden: number } | null }>(`/api/conversations?${params}`, ['conversations', 'chats', 'settings'])
  const { data: labelData } = useLive<{ labels: { label: string; n: number }[] }>('/api/labels', ['conversations'])
  const counts = data?.counts ?? {}
  const count = (x: typeof FILTERS[number]) => x.id === 'auto' ? counts.auto ?? null : x.states.length ? x.states.reduce((n, s) => n + (counts[s] ?? 0), 0) : null
  const rows = data?.conversations ?? []
  const looksLikeQuestion = /\?$|^(what|where|when|why|how|which|who|did|have|was|is there)\b/i.test(debounced.trim()) || debounced.trim().split(/\s+/).length > 4

  const select = (e: React.MouseEvent, c: Conversation) => {
    const next = new Set(selected)
    if (e.shiftKey && lastClicked.current) {
      const a = rows.findIndex(r => r.id === lastClicked.current), b = rows.findIndex(r => r.id === c.id)
      for (const r of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(r.id)
    } else if (next.has(c.id)) next.delete(c.id)
    else next.add(c.id)
    lastClicked.current = c.id
    setSelected(next)
  }
  const menu = (e: React.MouseEvent, c: Conversation) => {
    const items = selected.has(c.id) ? rows.filter(r => selected.has(r.id)) : [c]
    onMenu(e.clientX, e.clientY, items)
  }
  const toggleLabel = (l: string) => {
    const tag = `#${l}`
    setQ(q.includes(tag) ? q.replace(tag, '').replace(/\s+/g, ' ').trim() : `${q} ${tag}`.trim())
  }

  return (
    <div className="list">
      <div className="list-search">
        <input ref={searchRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search everything  ⌘K" title={SEARCH_HELP}
          onKeyDown={e => {
            if (e.key === 'Escape') { setQ(''); (e.target as HTMLInputElement).blur() }
            if (e.key === 'Enter' && e.metaKey && q.trim()) onAsk(q.trim())
            else if (e.key === 'Enter' && q.trim()) onSearchEverywhere(q.trim())
          }} />
      </div>
      <FocusBanner focus={data?.focus ?? (document.querySelector('.app.zen') ? { areas: [] } : null)} hidden={data?.focus?.hidden} />
      {searching && (
        <div className="ask-rows">
          <button className="ask-row" onClick={() => onSearchEverywhere(debounced.trim())} title="Repos, this Mac, notes, skills, GitHub  ↵">⌕ Everywhere</button>
          <button className={`ask-row grow ${looksLikeQuestion ? 'strong' : ''}`} onClick={() => onAsk(debounced.trim())} title="An agent that searches everything, Slack and upstream source too  ⌘↵">
            ✦ Ask: <span className="ellipsis">“{debounced.trim()}”</span>
          </button>
        </div>
      )}
      {false && <div className="filters">
        {FILTERS.filter(x => (x.id !== 'hidden' || counts.hidden || filter === 'hidden') && (x.id !== 'auto' || counts.auto || filter === 'auto')).map(x => (
          // zen keeps just Now and Needs me (CSS hides the rest)
          <button key={x.id} className={`chip-btn ${filter === x.id ? 'on' : ''} ${['now', 'waiting'].includes(x.id) ? 'zen-keep' : ''}`} onClick={() => setFilter(x.id)} title={STATES.find(s => s.id === x.states[0])?.hint}>
            {x.label}{count(x) ? <span className="count">{count(x)}</span> : null}
          </button>
        ))}
      </div>}
      {SHOW_LABELS && (labelData?.labels.length ?? 0) > 0 && (
        <div className="filters labels-row">
          {labelData!.labels.filter(l => l.label !== 'search').slice(0, 12).map(l => (
            <button key={l.label} className={`label-btn ${q.includes('#' + l.label) ? 'on' : ''}`} onClick={() => toggleLabel(l.label)}>#{l.label}<span className="count">{l.n}</span></button>
          ))}
        </div>
      )}
      <div className="list-opts">
        {searching && <select value={sort} onChange={e => setSort(e.target.value)} title="Sort">
          <option value="updated">{searching ? 'Best match' : 'Recent activity'}</option>
          <option value="created">Newest</option>
          <option value="state">State</option>
          <option value="prs">Has PRs</option>
          <option value="messages">Longest</option>
          <option value="title">Title</option>
        </select>}
        {searching && (withAgents || (counts.auto ?? 0) > 0) && (
          <label className="small muted" title="Shepherds, helpers, routines and scouts. Off: only chats you started and talk in.">
            <input type="checkbox" checked={withAgents} onChange={e => setWithAgents(e.target.checked)} /> agent runs{!withAgents && counts.auto ? ` (${counts.auto})` : ''}
          </label>
        )}
        {selected.size > 0 && (
          <span className="selection">
            {selected.size} selected
            <button className="link small" onClick={e => onMenu(e.clientX, e.clientY, rows.filter(r => selected.has(r.id)))}>actions</button>
            <button className="link small" onClick={() => setSelected(new Set())}>clear</button>
          </span>
        )}
      </div>
      <div className="list-body">
        {terms.length > 0 && !searching && (
          <div className="section">
            <div className="section-head">Terminals</div>
            {terms.map(t => (
              <div key={t.id} className={`row term-row ${selectedTerm === t.id ? 'active' : ''}`} onClick={() => onOpenTerm(t.id)}>
                <div className="row-top"><span className={`dot ${t.exited ? 's-done' : 's-running'}`} /><span className="row-title">⌘_ {t.title}</span></div>
              </div>
            ))}
          </div>
        )}
        {searching && rows.map(c => <Row key={c.id} c={c} active={c.id === selectedId} selected={selected.has(c.id)} onOpen={onOpen} onMenu={menu} onSelect={select} />)}
        {searching && data && !rows.length && <div className="muted pad small">No matches. Try fewer words, or Ask Claude.</div>}
        {!searching && <Organised selectedId={selectedId} selected={selected} onOpen={onOpen} onMenu={menu} onSelect={select} onSearch={setQ} />}
      </div>
    </div>
  )
}

// Past the few in Now: the rest of the chats you've been in, newest first. Expands into a scroll box
// that loads 15 more each time you reach its bottom. Refreshes in place when the sidebar does.
function MoreRecent({ open, onToggle, refresh, row }: { open: boolean; onToggle: () => void; refresh: unknown; row: (c: Conversation) => React.JSX.Element }) {
  const [items, setItems] = useState<Conversation[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const loading = useRef(false)
  const count = useRef(0)
  const load = async (offset: number, limit: number, replace: boolean) => {
    if (loading.current) return
    loading.current = true
    try {
      const r = await fetch(`/api/sidebar/recent?offset=${offset}&limit=${limit}`).then(r => r.json())
      if (!Array.isArray(r?.conversations)) return
      setTotal(r.total)
      setItems(cur => { const next = replace ? r.conversations : [...cur, ...r.conversations.filter((c: Conversation) => !cur.some(x => x.id === c.id))]; count.current = next.length; return next })
    } catch {} finally { loading.current = false }
  }
  // First open loads a page; after that, a sidebar refresh reloads what's already shown so order and dots stay current.
  useEffect(() => { if (open) load(0, Math.max(15, count.current), true) }, [open, refresh]) // eslint-disable-line react-hooks/exhaustive-deps
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (total !== null && items.length < total && el.scrollTop + el.clientHeight > el.scrollHeight - 80) load(items.length, 15, false)
  }
  return (
    <>
      <button className="link small work-more" onClick={onToggle} title="Chats you've been in, past the ones above. Scroll to load more.">
        {open ? 'Fewer recent' : `More recent${total ? ` (${total})` : ''}`}
      </button>
      {open && (
        <div className="recent-more" onScroll={onScroll}>
          {items.map(row)}
          {total !== null && items.length < total && <div className="muted small pad-s">Scroll for more…</div>}
          {total === 0 && <div className="muted small pad-s">Nothing else recent.</div>}
        </div>
      )}
    </>
  )
}

// An agent's promise to follow up, held by perch: when it's due, and whether it came due unanswered.
function PromiseMark({ p }: { p: any }) {
  const overdue = p.status === 'waiting'
  const when = p.due_at ? (p.due_at > Date.now() ? `due in ${ago(Date.now() - (p.due_at - Date.now()))}` : `due ${ago(p.due_at)} ago`) : ''
  const tip = `Promised: “${p.text}”\n${p.pr_url ? `Waits for ${p.until ?? 'checks'} on #${p.pr_url.split('/').pop()}, ` : ''}${when}${p.nudged_at ? '\nauto-m8 already followed up' : ''}${overdue ? `\n${p.note ?? ''} It hasn’t followed up: nudge it from Home.` : ''}`
  return <span className={`promise${overdue ? ' overdue' : ''}`} title={tip} onClick={e => e.stopPropagation()}>⏰{overdue ? ' overdue' : ''}</span>
}

// Browsing, organised by state: the few you were just in, what needs you, what's working,
// then everything else still open grouped by the work it's about (a PR, a stack, a repo).
// Finished work archives itself; search finds it.
type Group = { key: string; kind: 'pr' | 'stack' | 'repo'; title: string; url?: string; items: Conversation[]; last: number }
type Side = { pinned: Conversation[]; now: Conversation[]; needs: Conversation[]; working: Conversation[]; groups: Group[]; archived: number; agents?: (Conversation & { parent?: { id: string; title: string } })[] }
function Organised({ selectedId, selected, onOpen, onMenu, onSelect, onSearch }: { selectedId: string | null; selected: Set<string>; onOpen: (c: Conversation) => void
  onMenu: (e: React.MouseEvent, c: Conversation) => void; onSelect: (e: React.MouseEvent, c: Conversation) => void; onSearch: (q: string) => void }) {
  const { data } = useLive<Side>('/api/sidebar', ['conversations', 'chats'])
  const [open, setOpen] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem('perch.side.open') ?? '{}') } catch { return {} } })
  const toggle = (k: string) => { const v = { ...open, [k]: !open[k] }; setOpen(v); try { localStorage.setItem('perch.side.open', JSON.stringify(v)) } catch {} }
  if (!data) return <div className="muted pad small">…</div>
  const row = (c: Conversation) => <Row key={c.id} c={c} active={c.id === selectedId} selected={selected.has(c.id)} onOpen={onOpen} onMenu={onMenu} onSelect={onSelect} />
  return (
    <>
      {data.pinned?.length > 0 && <div className="section pinned-section"><div className="section-head pinned-head">📌 Pinned <span className="count">{data.pinned.length}</span></div>{data.pinned.map(row)}</div>}
      <div className="section">{data.now.map(row)}<MoreRecent open={!!open.recent} onToggle={() => toggle('recent')} refresh={data} row={row} /></div>
      {data.needs.length > 0 && <div className="section"><button className="section-head needs toggle" onClick={() => toggle('waiting')}>Waiting chats <span className="count">{data.needs.length}</span> <span className="muted">{open.waiting ? '▾' : '▸'}</span></button>{open.waiting && data.needs.map(row)}</div>}
      {data.working.length > 0 && (
        <div className="section">
          <button className="section-head toggle" onClick={() => toggle('working')}><span className="dot s-running" /> {data.working.length} agent{data.working.length > 1 ? 's' : ''} working <span className="muted">{open.working ? '▾' : '▸'}</span></button>
          {open.working && data.working.map(row)}
        </div>
      )}
      {/* Threads perch's automation started (helpers, shepherds, routines, autopilot fixes): out of the way, one click to drill in. */}
      {(data.agents?.length ?? 0) > 0 && (() => {
        const agents = data.agents!, running = agents.filter(c => c.effective === 'running').length
        return (
          <div className="section">
            <div className="section-head row-flex">
              <button className="toggle grow" style={{ background: "none", border: 0, cursor: "pointer", padding: 0 }} onClick={() => toggle('agents')} title="Threads auto-m8 started for you: helpers, shepherds, routines, autopilot fixes. Write in one and it moves into your list.">
                🤖 Agent runs <span className="count">{agents.length}</span>{running > 0 && <> · <span className="dot s-running" /> {running} running</>} <span className="muted">{open.agents ? '▾' : '▸'}</span>
              </button>
              <button className="link small" onClick={() => onSearch('is:auto')} title="Every agent run, including finished ones">all</button>
            </div>
            {open.agents && agents.slice(0, 20).map(c => (
              <div key={c.id}>
                {row(c)}
                {c.parent && <button className="linklike small muted agent-parent" onClick={() => onOpen({ id: c.parent!.id } as Conversation)} title="The conversation that started this helper">↳ from {c.parent.title || 'a conversation'}</button>}
              </div>
            ))}
            {open.agents && agents.length > 20 && <button className="link small work-more" onClick={() => onSearch('is:auto')}>{agents.length - 20} more</button>}
          </div>
        )
      })()}
    </>
  )
}

// The same organised list (pinned, recent, needs you, working, by work) for the side panel:
// a click opens the chat in the panel; right-click and multi-select stay in the full window.
export function SideList({ onOpen, onSearch }: { onOpen: (id: string) => void; onSearch: (q: string) => void }) {
  return <Organised selectedId={null} selected={new Set()} onOpen={c => onOpen(c.id)} onMenu={() => {}} onSelect={(_, c) => onOpen(c.id)} onSearch={onSearch} />
}

// Models a chat ran on, stacked like the agents on a PR: the one it is on now first and on top.
const MODEL_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex (ChatGPT plan)', ollama: 'a local Ollama model' }
function ModelStack({ models, local }: { models: string[]; local?: string | null }) {
  const name = (m: string) => MODEL_NAME[m] + (m === 'ollama' && local ? ` (${local})` : '')
  const title = models.length > 1 ? `On ${name(models[0])} now; also ran on ${models.slice(1).map(name).join(', ')}` : `Ran on ${name(models[0])}`
  return (
    <span className="agent-stack model-stack" title={title}>
      {models.map((m, i) => <span key={m} className="agent-av" style={{ width: 16, height: 16, zIndex: models.length - i }}><Brand id={m} size={11} /></span>)}
    </span>
  )
}
