// Pause all: one button stops every agent and scout perch runs on its own; this page shows what is
// on, what a pause holds, and brings it all back. Your own chats are never touched.
import { useState } from 'react'
import { ago, humanCron, post, useLive } from './api'

const since = (ts: number) => ago(ts) === 'now' ? 'just now' : `${ago(ts)} ago`

type Overview = {
  paused: boolean; since: number | null; reason: string | null; covers: string[]; notCovered: string[]
  runningNow: { id: string; by: string; title: string | null }[]
  interrupted: { id: string; by: string | null; title: string | null }[]
  held: { id: number; at: number; by: string; conversation_id: string | null; prompt: string }[]
  routines: { id: string; name: string; cron: string | null; enabled: number; last_run_at: number | null; last_status: string | null; paused_reason: string | null; holds: boolean }[]
  shepherds: { url: string; conversation_id: string | null; source: string | null }[]
  watches: { owner: string; n: number; targets: string; title: string | null; queued: number }[]
  followUps: { id: string; conversation_id: string; text: string; due_at: number | null; pr_url: string | null; title: string | null; overdue: boolean }[]
  cloud: { conversation_id: string; task_id: string; url: string | null; status: string }[]
  counts: Record<string, number>
}

export function usePause() {
  const { data, reload } = useLive<Overview>('/api/pause', ['home', 'conversations', 'settings'], undefined, 15000)
  return { data, reload }
}

// The strip across the top while paused, and the button that pauses.
export function PauseBar({ onOpen }: { onOpen: () => void }) {
  const { data, reload } = usePause()
  // A fresh install starts with autonomy off: that is a choice, not a pause, so no strip until something was paused.
  if (!data?.paused || (!data.since && !data.held.length && !data.interrupted.length)) return null
  return (
    <div className="pause-bar" style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 12px', background: 'var(--accent)', color: '#fff', fontSize: 13 }}>
      <b>⏸ Agents and scouts are paused</b>
      <span className="grow" style={{ flex: 1, opacity: 0.85 }}>{data.since ? `since ${since(data.since)} · ` : ''}{data.counts.held} held · {data.counts.routines} routines and {data.counts.shepherds} shepherds waiting</span>
      <button onClick={onOpen}>What's paused</button>
      <button className="primary" onClick={async () => { await post('/api/resume'); reload() }}>Resume all</button>
    </div>
  )
}

const Group = ({ title, hint, n, children }: { title: string; hint?: string; n: number; children: React.ReactNode }) => (
  <section className="card">
    <div className="card-head"><h3>{title}</h3><span className="muted small">{n}{hint ? ` · ${hint}` : ''}</span></div>
    {n ? children : <div className="muted small">None.</div>}
  </section>
)

export function Paused({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, reload } = usePause()
  const [busy, setBusy] = useState(false)
  if (!data) return <div className="page muted">Loading…</div>
  const act = async (path: string, body?: unknown) => { setBusy(true); try { await post(path, body) } finally { setBusy(false); reload() } }
  const link = (id: string | null, text: string) => id ? <a href={`#chat/${encodeURIComponent(id)}`} onClick={e => { e.preventDefault(); onOpen(id) }}>{text}</a> : <>{text}</>
  const state = data.paused ? 'held' : 'on'
  return (
    <div className="page">
      <div className="row-flex">
        <h2 className="grow">{data.paused ? '⏸ Paused' : 'Pause all'}</h2>
        {data.paused
          ? <button className="primary" disabled={busy} onClick={() => act('/api/resume')}>Resume all</button>
          : <button className="primary" disabled={busy} onClick={() => act('/api/pause')}>Pause all agents and scouts</button>}
        {data.paused && <button disabled={busy} title="Turn everything back on without waking the chats the pause interrupted" onClick={() => act('/api/resume', { restart: false })}>Resume, don't restart chats</button>}
      </div>
      <div className="muted small">
        {data.paused
          ? `Paused ${data.since ? since(data.since) : ''}. Nothing below starts or wakes while this is on. ${data.interrupted.length ? `${data.interrupted.length} running chat${data.interrupted.length > 1 ? 's were' : ' was'} interrupted and restart on resume.` : ''}`
          : 'This is what is on right now. Pausing stops all of it, keeps the list, and one button brings it back.'}
      </div>
      <div className="card"><div className="small"><b>A pause stops</b>: {data.covers.join(' · ')}.</div><div className="small muted"><b>Not covered</b>: {data.notCovered.join(' · ')}.</div></div>

      <Group title="Running right now" n={data.runningNow.length} hint="started by an automation, not you">
        {data.runningNow.map(r => <div key={r.id} className="row-flex"><span className="dot s-running" /><span className="grow">{link(r.id, r.title ?? r.id)}</span><span className="chip">{r.by}</span></div>)}
      </Group>
      {data.paused && <Group title="Interrupted by the pause" n={data.interrupted.length} hint="restart on resume">
        {data.interrupted.map(r => <div key={r.id} className="row-flex"><span className="grow">{link(r.id, r.title ?? r.id)}</span><span className="chip">{r.by ?? 'agent'}</span></div>)}
      </Group>}
      {data.paused && <Group title="Held messages" n={data.held.length} hint="automations that tried to start or wake an agent">
        {data.held.map(h => <div key={h.id} className="row-flex small"><span className="muted">{ago(h.at)}</span><span className="chip">{h.by}</span><span className="grow">{h.prompt.split('\n')[0].slice(0, 140)}</span></div>)}
      </Group>}
      <Group title="Routines and local scouts" n={data.routines.filter(r => r.enabled).length} hint={state}>
        {data.routines.filter(r => r.enabled).map(r => <div key={r.id} className="row-flex"><span className={`dot ${data.paused ? 'pending' : 'ok'}`} /><b className="grow">{r.name}</b><span className="muted small">{r.cron ? humanCron(r.cron) : 'webhook only'}{r.last_run_at ? ` · last ${ago(r.last_run_at)} ago` : ''}</span></div>)}
      </Group>
      <Group title="PR shepherds" n={data.shepherds.length} hint={state}>
        {data.shepherds.map(s => <div key={s.url} className="row-flex small"><span className="grow">{link(s.conversation_id, s.url.replace('https://github.com/', ''))}</span><span className="chip">{s.source ?? 'auto'}</span></div>)}
      </Group>
      <Group title="Agents that keep others alive" n={data.watches.length} hint="watches wake the agent when something changes">
        {data.watches.map(w => <div key={w.owner} className="row-flex small"><span className="grow">{link(w.owner, w.title ?? w.owner)}</span><span className="muted">watching {w.n}{w.queued ? ` · ${w.queued} events queued` : ''}</span></div>)}
      </Group>
      <Group title="Follow-ups" n={data.followUps.length} hint="agents promised to come back">
        {data.followUps.map(f => <div key={f.id} className="row-flex small"><span className="grow">{link(f.conversation_id, f.text)}</span><span className={f.overdue ? 'bad' : 'muted'}>{f.due_at ? (f.overdue ? 'overdue ' : 'due ') + new Date(f.due_at).toLocaleString([], { hour: 'numeric', minute: '2-digit', weekday: 'short' }) : f.pr_url ? 'on a PR condition' : ''}</span>{!!data.paused || <button onClick={() => act(`/api/promises/${f.id}/drop`)}>Drop</button>}</div>)}
      </Group>
      <Group title="Cloud tasks handed off" n={data.cloud.length} hint="finish on their own">
        {data.cloud.map(c => <div key={c.task_id} className="row-flex small"><span className="grow">{link(c.conversation_id, c.task_id)}</span><span className="chip">{c.status}</span></div>)}
      </Group>
    </div>
  )
}

// The ⏸/▶ at the end of the bottom bar. Hover says exactly what a pause does (and what it doesn't),
// with live counts, straight away rather than after the system tooltip's delay.
export function PauseButton() {
  const { data, reload } = usePause()
  const paused = !!data?.paused
  const n = data?.counts ?? {}
  const covered = [
    n.shepherds ? `PR shepherds (${n.shepherds} PRs)` : 'PR shepherds',
    n.routines ? `routines and scheduled scouts (${n.routines})` : 'routines and scheduled scouts',
    n.followUps ? `agents' follow-ups (${n.followUps})` : "agents' follow-ups",
    'watches, self drive, autopilot and stall nudges',
  ]
  return (
    <span className="pause-wrap">
      <button className={`nav-icon${paused ? ' on' : ''}`} aria-label={paused ? 'Resume all automation' : 'Pause all automation'}
        onClick={async () => { await post(paused ? '/api/resume' : '/api/pause'); reload() }}>{paused ? '▶' : '⏸'}</button>
      <span className="pause-tip" role="tooltip">
        {paused ? <>
          <span><b>Paused{data?.since ? ` ${since(data.since)}` : ''}</b>. Click to resume all automation.</span>
          <span>Everything auto-m8 runs on its own starts again{data?.interrupted?.length ? `, and the ${data.interrupted.length} chat${data.interrupted.length === 1 ? '' : 's'} the pause stopped pick${data.interrupted.length === 1 ? 's' : ''} up where ${data.interrupted.length === 1 ? 'it' : 'they'} left off` : ''}.{n.held ? ` ${n.held} message${n.held === 1 ? ' was' : 's were'} held while paused.` : ''}</span>
        </> : <>
          <span><b>Pause all automation</b>: stop every agent and scout auto-m8 runs on its own, to save tokens or take back control.</span>
          <span>Stops {covered.join(', ')}.{n.running ? ` ${n.running} agent chat${n.running === 1 ? '' : 's'} running now ${n.running === 1 ? 'stops and picks' : 'stop and pick'} up again when you resume.` : ' Agent chats running at the time stop, and pick up again when you resume.'}</span>
          <span className="muted">Your own chats keep working. Scouts in PostHog cloud and cloud tasks aren't covered.</span>
        </>}
      </span>
    </span>
  )
}
