// "Welcome back": what needs you, what to pick up, what's slipping, your PR stacks, and the
// notepad. Two modes for two kinds of day: Drive (push existing work through) and Create.
import { useEffect, useRef, useState } from 'react'
import { SHOW_LABELS, ago, api, post, titleOf, useLive, type Conversation, type PR } from './api'
import { PrBadge } from './List'
import { FocusBanner } from './Focus'
import { Autopilot } from './Autopilot'
import { useBoards } from './Boards'
import { toast } from './api'
import { ProjectView, type Decision, type Project } from './Decisions'
import { Setup } from './Setup'
import { NeedsMe, type NeedsData } from './NeedsMe'

type Pick = { id?: string; pr?: string; title: string; why: string }
type Brief = { greeting: string; mode: 'drive' | 'create'; pickup: Pick[]; dropping: Pick[]; groups: { label: string; ids: string[]; why: string }[]; fromNotes: string[]; created_at: number; error?: string }
type Stack = { repo: string; prs: (PR & { convs: string[]; updated_at: number; head?: string })[] }
type HomeData = {
  day: string; note: { body: string }; recentNotes: { day: string; body: string }[]
  running: Conversation[]; needsMe: Conversation[]; active: Conversation[]; returned: Conversation[]
  stacks: Stack[]; stale: (PR & { updated_at: number })[]; later: number; brief: Brief | null; briefing: boolean
  focus: { name: string; query: string }[] | null
  zen: boolean
  decisions?: Decision[]; projects?: Project[]; interventions?: NeedsData
}

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

// The calm start: one box to start something, the chat you were last in, and a few tiles.
// Everything else (brief, needs-you, PR stacks, projects, notepad) sits one click away.
export function Home({ onOpen, onStart, onBoard, settings, onTerminal }: { onOpen: (id: string) => void; onStart: (prompt?: string) => void; onBoard: (id: string | null) => void; settings?: any; onTerminal?: (cmd: string, title: string) => void }) {
  const boardList = useBoards().data?.boards ?? []
  const { data } = useLive<HomeData>('/api/home', ['conversations', 'home', 'settings'])
  const [all, setAllS] = useState(() => { try { return localStorage.getItem('perch.home.all') === '1' } catch { return false } })
  const setAll = (v: boolean) => { setAllS(v); try { localStorage.setItem('perch.home.all', v ? '1' : '0') } catch {} }
  const [text, setText] = useState('')
  if (all) return <><div className="home-back"><button className="link small" onClick={() => setAll(false)}>← Back to start</button></div><Everything onOpen={onOpen} onStart={onStart} /></>
  if (!data) return <div className="pad muted">…</div>
  // Where you left off: your most recently touched chat that isn't running right now.
  const last = [...data.needsMe, ...data.active].filter(c => !c.origin).sort((a, b) => b.updated_at - a.updated_at)[0]
  const tiles: { key: string; title: string; why: string; go: () => void }[] = []
  for (const p of data.brief && !data.brief.error ? data.brief.pickup ?? [] : []) {
    if (tiles.length >= 3 || (p.id && p.id === last?.id)) continue
    tiles.push({ key: p.id || p.pr || p.title, title: p.title, why: p.why, go: () => p.id ? onOpen(p.id) : p.pr && window.open(p.pr, '_blank') })
  }
  for (const c of data.needsMe) {
    if (tiles.length >= 3) break
    if (c.id === last?.id || tiles.some(t => t.key === c.id)) continue
    tiles.push({ key: c.id, title: titleOf(c), why: c.reason || 'Waiting on you', go: () => onOpen(c.id) })
  }
  const waiting = data.interventions?.counts.needs_you ?? 0
  const submit = () => { const t = text.trim(); onStart(t || undefined) }
  return (
    <div className="page start">
      {onTerminal && <Setup settings={settings} onTerminal={onTerminal} />}
      <h1 className="start-hello">{greeting()}</h1>
      <div className="start-box">
        <textarea autoFocus rows={2} value={text} placeholder="What are we working on?" onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }} />
        <button className="primary" onClick={submit}>{text.trim() ? 'Start' : 'New chat'}</button>
      </div>
      <NeedsMe onOpen={onOpen} />
      {last && (
        <button className="start-resume" onClick={() => onOpen(last.id)}>
          <span className="muted small">Pick up where you left off · {ago(last.updated_at)} ago</span>
          <span className="start-resume-title">{titleOf(last)}</span>
          {last.reason && <span className="muted small ellipsis">{last.reason}</span>}
        </button>
      )}
      {tiles.length > 0 && (
        <div className="start-tiles">
          {tiles.map(t => (
            <button key={t.key} className="start-tile" onClick={t.go}>
              <span className="start-tile-title">{t.title}</span>
              <span className="muted small start-tile-why">{t.why}</span>
            </button>
          ))}
        </div>
      )}
      <div className="start-all row-flex">
        {boardList.filter(b => b.pinned).map(b => <button key={b.id} className="link small" onClick={() => onBoard(b.id)} title={b.tiles.map(t => t.title).join(' · ')}>▦ {b.name}</button>)}
        {boardList.length > 0 && <button className="link small muted" onClick={() => onBoard(null)}>Boards</button>}
        <button className="link small" onClick={() => setAll(true)}>
          {waiting > 0 ? `${waiting} waiting on you · ` : ''}See everything →
        </button>
      </div>
    </div>
  )
}

function Everything({ onOpen, onStart }: { onOpen: (id: string) => void; onStart: (prompt?: string) => void }) {
  const { data, reload } = useLive<HomeData>('/api/home', ['conversations', 'home', 'settings'])
  const [mode, setMode] = useState<'drive' | 'create' | null>(() => (localStorage.getItem(`perch.mode.${new Date().toLocaleDateString('sv')}`) as any) ?? null)
  const [briefing, setBriefing] = useState(false)
  // Hooks stay above the early return below (React needs the same hooks on every render).
  const [menu, setMenu] = useState<{ x: number; y: number; pr?: string; id?: string; title: string } | null>(null)
  const openMenu = (e: React.MouseEvent, t: { pr?: string; id?: string; title: string }) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, ...t }) }
  const effectiveMode = mode ?? data?.brief?.mode ?? 'drive'
  const setDayMode = (m: 'drive' | 'create') => { setMode(m); try { localStorage.setItem(`perch.mode.${new Date().toLocaleDateString('sv')}`, m) } catch {} }
  if (!data) return <div className="pad muted">…</div>
  const b = data.brief
  const refreshBrief = async () => { setBriefing(true); await post('/api/brief'); setBriefing(false); reload() }

  const pickRow = (p: Pick, i: number) => (
    <div key={i} className="pick" onClick={() => p.id ? onOpen(p.id) : p.pr && window.open(p.pr, '_blank')} onContextMenu={e => openMenu(e, { pr: p.pr || undefined, id: p.id || undefined, title: p.title })}>
      <button className="pick-more" title="Not today, push it through, deep audit" onClick={e => openMenu(e, { pr: p.pr || undefined, id: p.id || undefined, title: p.title })}>⋯</button>
      <div className="pick-title">{p.title}{p.pr && p.id && <a className="small" href={p.pr} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}> PR ↗</a>}</div>
      <div className="muted small">{p.why}</div>
    </div>
  )

  return (
    <div className="page home">
      {menu && <PrMenu target={menu} onClose={() => setMenu(null)} onOpen={onOpen} onDone={reload} />}
      <div className="row-flex">
        <h2 className="grow">{greeting()}</h2>
        <div className="seg">
          <button className={effectiveMode === 'drive' ? 'on' : ''} onClick={() => setDayMode('drive')} title="Push what you've started through: PRs, reviews, blockers">Drive</button>
          <button className={effectiveMode === 'create' ? 'on' : ''} onClick={() => setDayMode('create')} title="Notes, ideas and new work first">Create</button>
        </div>
      </div>

      {data.zen && <FocusBanner focus={{ areas: data.focus ?? [] }} />}
      <NeedsMe onOpen={onOpen} />
      {(data.projects ?? []).filter((p, i, a) => a.findIndex(q => q.goal === p.goal) === i).map(p => <ProjectView key={p.id} p={p} onOpen={onOpen} />)}
      <section className="card brief">
        <div className="card-head">
          <h3>{b?.greeting && !b.error ? b.greeting : 'Your brief'}</h3>
          <span className="muted small">{b?.created_at ? `written ${ago(b.created_at)} ago` : ''}</span>
          <button disabled={briefing || data.briefing} onClick={refreshBrief}>{briefing || data.briefing ? 'Writing… (~30s)' : b ? 'Refresh' : 'Write my brief'}</button>
        </div>
        {b?.error && <div className="bad small">{b.error}</div>}
        {!b && !data.briefing && <div className="muted small">Claude reads your conversations, PRs and notes and suggests what to pick up and what's slipping. It writes one each morning on its own; turn that off in Settings.</div>}
        {b && !b.error && (
          <div className="brief-cols">
            <div>
              <h4>Pick up</h4>
              {b.pickup?.map(pickRow)}
              <button className="link small" onClick={() => onStart()}>or start something new →</button>
            </div>
            {b.dropping?.length > 0 && <div><h4>Slipping</h4>{b.dropping.map(pickRow)}</div>}
          </div>
        )}
      </section>

      {data.returned.length > 0 && (
        <section className="card">
          <h3>Back from snooze</h3>
          {data.returned.map(c => <ConvLine key={c.id} c={c} onOpen={onOpen} />)}
        </section>
      )}

      {effectiveMode === 'create' && <Notepad day={data.day} initial={data.note.body} big onStart={onStart} fromNotes={b?.fromNotes} />}

      <div className="two">
        <section className="card">
          <h3>Follow-ups</h3>
          <Promises onOpen={onOpen} />
          {data.running.length > 0 && <><h4>Running</h4>{data.running.map(c => <ConvLine key={c.id} c={c} onOpen={onOpen} />)}</>}
        </section>
        <section className="card">
          <h3>Your open PRs <span className="muted small">{data.stacks.reduce((n, s) => n + s.prs.length, 0)} in {data.stacks.length} stacks</span></h3>
          {data.stacks.slice(0, effectiveMode === 'drive' ? 12 : 5).map((s, i) => <StackView key={i} s={s} onOpen={onOpen} onMenu={openMenu} />)}
          {(data as any).snoozedPrs > 0 && <div className="muted small">{(data as any).snoozedPrs} snoozed for later.</div>}
          {data.stale.length > 0 && <div className="muted small">{data.stale.length} haven't moved in 5+ days.</div>}
        </section>
      </div>

      {!data.zen && <Autopilot onOpen={onOpen} />}

      {effectiveMode === 'drive' && <Notepad day={data.day} initial={data.note.body} onStart={onStart} fromNotes={b?.fromNotes} />}
      {data.later > 0 && <div className="muted small">{data.later} conversations are snoozed for later.</div>}
    </div>
  )
}

function ConvLine({ c, onOpen }: { c: Conversation; onOpen: (id: string) => void }) {
  return (
    <div className="conv-line" onClick={() => onOpen(c.id)}>
      <span className={`dot s-${c.effective}`} />
      <span className="grow ellipsis">{titleOf(c)}{c.reason ? <span className="muted small"> · {c.reason}</span> : null}</span>
      {SHOW_LABELS && c.labels?.slice(0, 1).map(l => <span key={l} className="label">#{l}</span>)}
      {c.prs.slice(0, 2).map(p => <PrBadge key={p.url} pr={p} />)}
      <span className="muted small">{ago(c.updated_at)}</span>
    </div>
  )
}

function StackView({ s, onOpen, onMenu }: { s: Stack; onOpen: (id: string) => void; onMenu: (e: React.MouseEvent, t: { pr?: string; id?: string; title: string }) => void }) {
  const [open, setOpen] = useState(false)
  const top = s.prs[s.prs.length - 1]
  const convs = [...new Set(s.prs.flatMap(p => p.convs))]
  return (
    <div className="stack">
      <div className="stack-head" onClick={() => setOpen(!open)} onContextMenu={e => onMenu(e, { pr: (s.prs.length > 1 ? s.prs[0] : top).url, id: convs[0], title: (s.prs.length > 1 ? s.prs[0] : top).title ?? '' })}>
        <span className="muted small">{s.repo.split('/')[1]}</span>
        <span className="grow ellipsis">{s.prs.length > 1 ? `${s.prs.length}-PR stack: ` : ''}{(s.prs.length > 1 ? s.prs[0] : top).title}</span>
        <span className="stack-badges">{s.prs.slice(0, 3).map(p => <PrBadge key={p.url} pr={p} />)}{s.prs.length > 3 && <span className="muted small">+{s.prs.length - 3}</span>}</span>
        {convs.length > 0 && <span className="muted small" title="Conversations that touched these PRs">💬{convs.length}</span>}
      </div>
      {open && (
        <div className="stack-body">
          {s.prs.map(p => <div key={p.url} className="small"><PrBadge pr={p} full /> <span className="muted">{ago(p.updated_at)}</span></div>)}
          {convs.map(id => <button key={id} className="link small" onClick={() => onOpen(id)}>open conversation {id.slice(0, 6)}</button>)}
        </div>
      )}
    </div>
  )
}


// The notepad: one note per day, saved as you type. Search finds it, and the brief reads it.
export function Notepad({ day, initial, big, onStart, fromNotes }: { day: string; initial: string; big?: boolean; onStart: (p?: string) => void; fromNotes?: string[] }) {
  const [text, setText] = useState(initial)
  const [saved, setSaved] = useState(true)
  const ta = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { setText(initial) }, [day]) // eslint-disable-line
  useEffect(() => {
    if (saved) return
    const t = setTimeout(() => api.send('PUT', `/api/notes/${day}`, { body: text }).then(() => setSaved(true)), 700)
    return () => clearTimeout(t)
  }, [text, saved, day])
  const selection = () => { const el = ta.current; return el && el.selectionEnd > el.selectionStart ? el.value.slice(el.selectionStart, el.selectionEnd) : '' }
  return (
    <section className={`card notepad ${big ? 'big' : ''}`}>
      <div className="card-head">
        <h3>Notepad <span className="muted small">{new Date(day + 'T12:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</span></h3>
        <span className="muted small">{saved ? 'saved' : '…'}</span>
        <button onClick={() => onStart(selection() || text)} title="Start a chat from the selected text (or the whole note)">Start chat from note</button>
      </div>
      <textarea ref={ta} value={text} placeholder="Jumbled thoughts, ideas, todos. Search finds these, and the brief reads them." rows={big ? 14 : 5}
        onChange={e => { setText(e.target.value); setSaved(false) }} />
      {fromNotes && fromNotes.length > 0 && (
        <div className="from-notes">
          <span className="muted small">Not started yet:</span>
          {fromNotes.map((n, i) => <button key={i} className="chip-btn" onClick={() => onStart(n)} title="Start a chat about this">{n}</button>)}
        </div>
      )}
    </section>
  )
}

const tomorrow = () => { const d = new Date(Date.now() + 86400_000); d.setHours(8, 0, 0, 0); return d.getTime() }

// What to do about one pick, slip or PR: deprioritise it, push it through, or audit it deeply.
export function PrMenu({ target, onClose, onOpen, onDone }: { target: { x: number; y: number; pr?: string; id?: string; title: string; draft?: boolean; red?: boolean }; onClose: () => void; onOpen: (id: string) => void; onDone: () => void }) {
  const [existing, setExisting] = useState<any[] | null>(null)
  const [busy, setBusy] = useState('')
  // Cloud shepherds, cloud CI fixes, StampHog and PostHog Review run through PostHog: only offered with a working key.
  const ph = !!useLive<any>('/api/status', ['status']).data?.posthog?.ok
  useEffect(() => {
    const c = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.ctx')) onClose() }
    setTimeout(() => addEventListener('mousedown', c), 0)
    return () => removeEventListener('mousedown', c)
  }, [onClose])
  const keys = [target.pr, target.id].filter(Boolean) as string[]
  const snooze = async (until: number, label: string) => { await post('/api/home/snooze', { keys, until, reason: label }); toast(`“${target.title.slice(0, 50)}” is out of the way ${label}.`, { kind: 'ok' }); onDone(); onClose() }
  const push = async (where: 'cloud' | 'here', force = false) => {
    setBusy('push')
    const r = await post<any>('/api/pr/push-through', { pr: target.pr, where, force })
    setBusy('')
    if (r.existing && !force) { setExisting(r.existing); return }
    if (r.message) toast(r.message, { kind: r.error ? 'error' : 'ok', action: r.runError ?? undefined })
    if (r.conversationId) onOpen(r.conversationId)
    onClose()
  }
  // StampHog and PostHog Review, through their own APIs; their refusals come back as plain words.
  const agent = async (name: 'stamphog' | 'reviewhog', mode?: string) => {
    setBusy(name + (mode ?? ''))
    const r = await post<any>('/api/pr/agent', { pr: target.pr, agent: name, mode })
    setBusy('')
    toast(r.message ?? (r.ok ? 'Started.' : 'That didn’t start.'), { kind: r.ok ? 'ok' : 'error' })
    if (r.ok) { onDone(); onClose() }
  }
  const fix = async (where: 'cloud' | 'here', force = false) => {
    setBusy('fix')
    const r = await post<any>('/api/pr/fix-ci', { pr: target.pr, where, force })
    setBusy('')
    if (r.existing && !force) {
      if (confirm(`${r.message}\n\n${r.existing.map((e: any) => `• ${e.title}`).join('\n')}\n\nStart another anyway?`)) return fix(where, true)
      return
    }
    if (r.message) toast(r.message, { kind: r.error ? 'error' : 'ok', action: r.runError ?? undefined })
    if (r.conversationId) onOpen(r.conversationId)
    onDone(); onClose()
  }
  const audit = async () => {
    setBusy('audit')
    const r = await post<any>('/api/pr/audit', { pr: target.pr })
    setBusy('')
    if (r.conversationId) { toast(r.message, { kind: 'ok' }); onOpen(r.conversationId) }
    onClose()
  }
  return (
    <div className="ctx" style={{ left: Math.min(target.x, innerWidth - 300), top: Math.min(target.y, innerHeight - 300) }}>
      <div className="ctx-head ellipsis">{target.title}</div>
      <button onClick={() => snooze(tomorrow(), 'until tomorrow')}>⏾ Not today</button>
      <button onClick={() => snooze(Date.now() + 7 * 86400_000, 'for a week')}>⏾ Snooze a week</button>
      <hr />
      {target.pr ? (
        <>
          {existing ? (
            <div className="ctx-sub">
              <span className="small">Already being shepherded:</span>
              {existing.slice(0, 3).map(e => <button key={e.id} onClick={() => { onOpen(e.id); onClose() }}>↗ {String(e.title).slice(0, 40)} <span className="muted small">{e.status ?? ''}</span></button>)}
              <button className="small" onClick={() => push('cloud', true)}>Start another anyway</button>
            </div>
          ) : (
            <>
              <div className="ctx-label">Add an agent</div>
              {ph && <button disabled={!!busy} onClick={() => push('cloud')} title="A shepherd in PostHog’s cloud drives it to merge through Trunk: review threads, CI, approval, merge queue. Keeps going while your laptop sleeps."><span className="agent-ico" aria-hidden>🐑</span> PR shepherd <span className="muted small">{busy === 'push' ? 'starting…' : 'push it to merge'}</span></button>}
              <button disabled={!!busy} className="small" onClick={() => push('here')}>{ph ? <>&nbsp;&nbsp;…or shepherd it here</> : <><span className="agent-ico" aria-hidden>🐑</span> PR shepherd <span className="muted small">push it to merge, on this Mac</span></>}</button>
            </>
          )}
          {ph && <button disabled={!!busy} onClick={() => fix('cloud')} title="Reads the failing checks’ logs, fixes the cause on the PR’s branch and pushes; flaky failures get a rerun instead">🔧 Fix CI <span className={`small ${target.red ? 'bad' : 'muted'}`}>{busy === 'fix' ? 'starting…' : target.red ? 'CI is red · cloud' : 'cloud'}</span></button>}
          <button disabled={!!busy} className="small" onClick={() => fix('here')} title="On this Mac, in its own worktree of the branch">{ph ? <>&nbsp;&nbsp;…or fix it here</> : <>🔧 Fix CI <span className="muted small">on this Mac</span></>}</button>
          {ph && <>
          <button disabled={!!busy || target.draft} onClick={() => agent('stamphog')}
            title={target.draft ? 'StampHog doesn’t review drafts: mark it ready first' : 'Reviews it now for approval. A pass posts a real GitHub approval; anything else, a comment.'}>
            <span className="agent-ico" aria-hidden>✓</span> StampHog <span className="muted small">{busy === 'stamphog' ? 'asking…' : target.draft ? 'not for drafts' : 'review for approval'}</span></button>
          <div className="ctx-row">
            <span><span className="agent-ico" aria-hidden>◉</span> PostHog Review</span>
            <button className="chip-btn" disabled={!!busy} onClick={() => agent('reviewhog', 'review_only')} title="Deep review, published to the PR">{busy === 'reviewhogreview_only' ? '…' : 'Deep'}</button>
            <button className="chip-btn" disabled={!!busy} onClick={() => agent('reviewhog', 'flash')} title="Standard review: quicker, lower-cost model">{busy === 'reviewhogflash' ? '…' : 'Standard'}</button>
            <button className="chip-btn" disabled={!!busy} onClick={() => agent('reviewhog', 'resolve_only')} title="Works the PR’s open review threads: may push fix commits to the branch and reply on threads. Only if the PR’s author opted in.">{busy === 'reviewhogresolve_only' ? '…' : 'Fix threads'}</button>
          </div>
          </>}
          <hr />
          <button disabled={!!busy} onClick={audit} title="For PRs stuck on pushback: gathers every review thread and CI failure, audits with your ddia-swarm skill, applies the fixes in its own worktree, asks before pushing">🔬 Deep audit & apply <span className="muted small">{busy === 'audit' ? 'preparing worktree…' : 'ddia-swarm'}</span></button>
          <button onClick={() => { window.open(target.pr, '_blank'); onClose() }}>↗ Open the PR</button>
        </>
      ) : <div className="muted small pad-s">No PR on this one: snooze it, or open the conversation.</div>}
      {target.id && <button onClick={() => { onOpen(target.id!); onClose() }}>💬 Open the conversation</button>}
    </div>
  )
}

// Agents that said they'd follow up and didn't: perch can't resume a terminal session or a cloud
// task on its own, so it asks. Promises in perch's own chats are followed up automatically.
function Promises({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, reload } = useLive<{ promises: any[] }>('/api/promises', ['conversations'])
  const late = (data?.promises ?? []).filter(p => p.status === 'waiting')
  if (!late.length) return null
  return (
    <>
      <h4>Promised to follow up</h4>
      {late.slice(0, 6).map(p => (
        <div key={p.id} className="line promise-line">
          <span className="grow ellipsis"><button className="link" onClick={() => onOpen(p.conversation_id)}>{String(p.title ?? '').replace(/^\[[^\]]*\]\s*/, '').slice(0, 70)}</button>
            <div className="muted small ellipsis" title={p.text}>“{p.text}” · {p.note}</div></span>
          <button className="small" onClick={async () => { await post(`/api/promises/${p.id}/nudge`); toast('Asked it to follow up now.'); reload() }}>Nudge</button>
          <button className="link small" onClick={async () => { await post(`/api/promises/${p.id}/drop`); reload() }}>drop</button>
        </div>
      ))}
    </>
  )
}
