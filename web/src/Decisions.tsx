// Decisions: the only things perch needs from you. Each is one question with options and perch's
// recommendation; answering sends it back to the conversation that owns the work, which carries on.
// Shown at the top of Home (all of them) and at the top of a conversation (its own), plus the
// project graph for conversations that drive multi-PR work.
import { useEffect, useRef, useState } from 'react'
import { ago, post, shell, useLive } from './api'
import { Popover } from './Popover'
import { WorkstreamSummary, type Workstream } from './ProjectPlan'

// Decisions show only when the user has asked to be asked (settings.decisions.askMe, off by default).
// Off, perch takes every recommendation at once and agents decide, so there is nothing to show.
export function useShowDecisions() {
  const { data } = useLive<any>('/api/settings', ['settings'])
  return !!data?.decisions?.askMe
}

export type Decision = {
  id: string; key: string; created_at: number; source: string; conversation_id: string | null; url: string | null
  title: string; context: string | null; options: string[]; recommendation: string | null; status: string
  stakes?: 'high' | 'low'; auto_at?: number | null; answer?: string | null; answered_at?: number | null
}
type ProjectPr = { url: string; title: string | null; phase: string; outcome: string | null; after: string[] }
export type Project = { id: string; conversation_id: string; goal: string; done_when: string | null; status: string; prs: ProjectPr[]; workstreams?: Workstream[]; decisions: Decision[]; done: boolean }

const short = (u: string) => u.replace('https://github.com/', '').replace('/pull/', '#')
// The option perch would take: the recommendation's leading option text.
const recOption = (d: Decision) => d.recommendation ? ([...d.options].sort((a, b) => b.length - a.length).find(o => d.recommendation!.toLowerCase().startsWith(o.toLowerCase())) ?? null) : null
// "in 2h 10m": how long you have before perch takes its recommendation.
function left(at: number) {
  const m = Math.max(0, Math.round((at - Date.now()) / 60_000))
  return m < 1 ? 'any moment' : m < 60 ? `in ${m}m` : `in ${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
}
export function Deadline({ d }: { d: Decision }) {
  const [, tick] = useState(0)
  useEffect(() => { const t = setInterval(() => tick(x => x + 1), 60_000); return () => clearInterval(t) }, [])
  if (!d.auto_at) return <span className="muted small">waits for you</span>
  const pick = recOption(d) ?? d.recommendation
  return <span className="muted small" title={new Date(d.auto_at).toLocaleString()}>Mothership picks {pick ? <b>{pick.length > 40 ? `${pick.slice(0, 40)}…` : pick}</b> : 'for you'} {left(d.auto_at)}</span>
}

function DecisionCard({ d, onOpen, showOwner }: { d: Decision; onOpen?: (id: string) => void; showOwner?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const answer = async (a: string) => { if (!a.trim()) return; setBusy(true); try { await post(`/api/decisions/${d.id}/answer`, { answer: a }) } finally { setBusy(false) } }
  const rec = (o: string) => !!d.recommendation && d.recommendation.toLowerCase().startsWith(o.toLowerCase())
  return (
    <div className="decision">
      <div className="decision-title">{d.title}</div>
      <div className="muted small">
        {d.source} · {ago(d.created_at)} ago · <Deadline d={d} />
        {d.url && <> · <a href={d.url} target="_blank" rel="noreferrer">{short(d.url)} ↗</a></>}
        {showOwner && d.conversation_id && onOpen && <> · <button className="link small" onClick={() => onOpen(d.conversation_id!)}>open the work</button></>}
        {d.context && <> · <button className="link small" onClick={() => setOpen(!open)}>{open ? 'less' : 'why'}</button></>}
      </div>
      {open && d.context && <pre className="decision-context small">{d.context}</pre>}
      {d.recommendation && <div className="small">Mothership recommends: <b>{d.recommendation}</b></div>}
      <div className="decision-options">
        {d.options.map(o => <button key={o} disabled={busy} className={rec(o) ? 'primary' : ''} onClick={() => answer(o)}>{o}</button>)}
        <input disabled={busy} placeholder={d.options.length ? 'or answer in your words…' : 'your answer…'} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') answer(text) }} />
      </div>
    </div>
  )
}

export function DecisionList({ decisions, onOpen, showOwner = true, title = 'Decisions' }: { decisions: Decision[]; onOpen?: (id: string) => void; showOwner?: boolean; title?: string }) {
  if (!decisions.length) return null
  return (
    <section className="card decisions">
      <h3>{title} <span className="muted small">{decisions.length}</span></h3>
      {decisions.map(d => <DecisionCard key={d.id} d={d} onOpen={onOpen} showOwner={showOwner} />)}
    </section>
  )
}

export function ProjectView({ p, onOpen }: { p: Project; onOpen?: (id: string) => void }) {
  const SHOW_DECISIONS = useShowDecisions()
  const done = p.prs.filter(x => x.phase === 'verified' || x.phase === 'proven' || x.phase === 'closed').length
  return (
    <section className="card project">
      <div className="card-head">
        <h3 className="grow">{onOpen ? <button className="link" onClick={() => onOpen(p.conversation_id)}>{p.goal}</button> : p.goal}</h3>
        <span className="muted small">{done}/{p.prs.length} PRs done{SHOW_DECISIONS && p.decisions.length ? ` · ${p.decisions.length} waiting on you` : ''}</span>
      </div>
      {p.done_when && <div className="muted small">Done when: {p.done_when}</div>}
      <div className="project-prs">
        {p.prs.map(x => (
          <div key={x.url} className={`project-pr phase-${x.phase.toLowerCase().replace(/[^a-z]+/g, '-').replace(/-$/, '')}`}>
            <a href={x.url} target="_blank" rel="noreferrer">{short(x.url)}</a>
            <span className="grow small">{x.title}</span>
            <span className="small phase">{x.phase}</span>
            {x.after.length > 0 && <span className="muted small">after {x.after.map(short).join(', ')}</span>}
          </div>
        ))}
      </div>
      <WorkstreamSummary ws={p.workstreams ?? []} conversationId={p.conversation_id} />
    </section>
  )
}

// The top of a conversation: the project it drives, if any. Its decisions sit by the chat box (DecisionStrip).
export function ConversationDecisions({ id }: { id: string }) {
  const { data: project } = useLive<Project & { error?: string }>(`/api/projects/${encodeURIComponent(id)}`, ['home', 'conversations', 'prs'], undefined, 20_000) // readings arrive from the MCP process, which emits no topic
  if (!project || project.error) return null
  return <div className="conv-decisions"><ProjectView p={project} /></div>
}

// Just above the chat box, where your eyes already are: this conversation's big decisions, one slim
// line each, answerable in a click.
export function DecisionStrip({ id }: { id: string }) {
  const { data } = useLive<{ decisions: Decision[] }>(`/api/decisions?conversation=${encodeURIComponent(id)}`, ['home', 'conversations'])
  const ds = data?.decisions ?? []
  if (!ds.length) return null
  // One: its options right there. Several: one line each, options when you click a line.
  return <div className="decision-strip">{ds.map(d => <StripRow key={d.id} d={d} compact={ds.length > 1} />)}</div>
}
function StripRow({ d, compact = false, onOpen }: { d: Decision; compact?: boolean; onOpen?: (id: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(!compact)
  const [text, setText] = useState('')
  const answer = async (a: string) => { if (!a.trim()) return; setBusy(true); try { await post(`/api/decisions/${d.id}/answer`, { answer: a }) } finally { setBusy(false) } }
  const rec = recOption(d)
  return (
    <div className="strip-row">
      <div className="strip-line">
        <span className="flag">⚑</span>
        <button className="link strip-title" onClick={() => { if (!picking) setPicking(true); else setOpen(!open) }} title={d.title}>{d.title}</button>
        <Deadline d={d} />
        {onOpen && d.conversation_id && <button className="link small" onClick={() => onOpen(d.conversation_id!)}>open</button>}
      </div>
      {open && <>
        {d.context && <pre className="decision-context small">{d.context}</pre>}
        {d.recommendation && <div className="small">Mothership recommends: <b>{d.recommendation}</b></div>}
      </>}
      {picking && <div className="decision-options">
        {d.options.map(o => <button key={o} disabled={busy} className={`small ${o === rec ? 'primary' : ''}`} onClick={() => answer(o)}>{o}</button>)}
        {(open || !d.options.length) && <input disabled={busy} placeholder="or answer in your words…" value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') answer(text) }} />}
        {!open && (d.context || d.recommendation) && <button className="link small" onClick={() => setOpen(true)}>why</button>}
      </div>}
    </div>
  )
}

// Top-right of the window: a small flag with how many big decisions wait on you (also on the dock
// icon). Opens the decisions and a log of what perch decided for you, which you can change.
export function DecisionFlag({ onOpen }: { onOpen?: (id: string) => void }) {
  const { data } = useLive<{ decisions: Decision[]; decided?: Decision[] }>('/api/decisions?log=1', ['home', 'conversations'])
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const ds = data?.decisions ?? [], log = data?.decided ?? []
  useEffect(() => { shell.badge?.(ds.length ? String(ds.length) : '') }, [ds.length])
  const soonest = ds.filter(d => d.auto_at).sort((a, b) => a.auto_at! - b.auto_at!)[0]
  return <>
    <button ref={ref} className={`icon no-drag decision-flag ${ds.length ? 'on-flag' : ''}`} onClick={() => setOpen(!open)}
      title={ds.length ? `${ds.length} decision${ds.length > 1 ? 's' : ''} for you${soonest ? `; Mothership picks the first ${left(soonest.auto_at!)}` : ''}` : `Nothing for you to decide. Mothership decided ${log.length} lately.`}>
      ⚑{ds.length ? <span className="flag-n">{ds.length}</span> : null}
    </button>
    <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={460}>
      <div className="decision-pop">
        {ds.length ? <div className="decision-strip in-pop">
          <div className="muted small">For you to decide · Mothership picks its recommendation if you don't answer in time</div>
          {ds.map(d => <StripRow key={d.id} d={d} compact onOpen={onOpen ? id => { setOpen(false); onOpen(id) } : undefined} />)}
        </div> : <div className="muted small pad">Nothing for you to decide.</div>}
        {log.length > 0 && <details className="decided-log">
          <summary className="muted small">Mothership decided {log.length} for you in the last 3 days</summary>
          {log.map(d => <DecidedRow key={d.id} d={d} onOpen={onOpen ? id => { setOpen(false); onOpen(id) } : undefined} />)}
        </details>}
      </div>
    </Popover>
  </>
}
function DecidedRow({ d, onOpen }: { d: Decision; onOpen?: (id: string) => void }) {
  const [changing, setChanging] = useState(false)
  const [text, setText] = useState('')
  const change = async (a: string) => { if (!a.trim()) return; await post(`/api/decisions/${d.id}/answer`, { answer: a }); setChanging(false) }
  const others = d.options.filter(o => o !== d.answer)
  return (
    <div className="decided">
      <div className="small"><span className="muted">{ago(d.answered_at ?? d.created_at)} ago · {d.stakes === 'low' ? 'small' : 'no answer in time'}</span> {d.title}</div>
      <div className="small">→ <b>{d.answer || 'left to the agent'}</b>
        {' · '}<button className="link small" onClick={() => setChanging(!changing)}>change</button>
        {d.conversation_id && onOpen && <> · <button className="link small" onClick={() => onOpen(d.conversation_id!)}>open</button></>}
      </div>
      {changing && <div className="decision-options">
        {others.map(o => <button key={o} className="small" onClick={() => change(o)}>{o}</button>)}
        <input placeholder="your call…" value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') change(text) }} />
      </div>}
    </div>
  )
}
