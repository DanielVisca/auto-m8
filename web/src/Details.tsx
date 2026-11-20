import { useState } from 'react'
import { SHOW_LABELS, ago, api, post, titleOf, useLive, type Conversation, type PR } from './api'
import { PrBadge, StateMenu } from './List'
import { OpenIn } from './OpenIn'
import { PrPreviewCard } from './PrPreview'
import { Brand } from './Brand'
import { FilesSection } from './Files'

type Detail = Conversation & {
  prs: (PR & { created: number })[]
  links: { kind: string; note: string | null; other: string; dir: string; title: string | null; source: string | null; updated_at: number | null }[]
  tools: { name: string; server: string | null; n: number; errors: number }[]
  siblings: { id: string; title: string; updated_at: number; branch: string | null }[]
}

const KIND: Record<string, string> = { context: 'pulled in', continues: 'continues', related: 'related', manual: 'linked', branch: 'branch', rewound: 'rewound from', started: 'started' }

export function Details({ id, onOpen, onMakeRoutine }: { id: string; onOpen: (id: string) => void; onMakeRoutine: (c: Conversation) => void }) {
  const { data: c } = useLive<Detail>(`/api/conversations/${encodeURIComponent(id)}`, ['conversations'])
  const [picking, setPicking] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  if (!c || (c as any).error) return <div className="details muted pad">…</div>
  const created = c.prs.filter(p => p.created)
  const mentioned = c.prs.filter(p => !p.created)
  return (
    <div className="details">
      <section>
        <div className="d-title">{titleOf(c)}</div>
        <div className="d-meta muted small">
          {c.source}{c.cwd ? ` · ${c.cwd.replace(/^\/Users\/[^/]+/, '~')}` : ''}{c.branch ? ` · ${c.branch}` : ''}
          <br />started {ago(c.started_at)} ago · active {ago(c.updated_at)} · {c.messages} messages
        </div>
        <div className="d-row"><StateMenu c={c} /><OpenIn id={c.id} />{c.reason && <span className="reason small">{c.reason}{c.reason.startsWith('perch flagged') && <button className="linklike small" title="Not worth my attention: stop flagging it until it moves again" onClick={e => { e.stopPropagation(); post(`/api/conversations/${encodeURIComponent(c.id)}/not-needed`) }}> · not needed</button>}</span>}</div>
      </section>

      {SHOW_LABELS && <Labels c={c} />}


      <section>
        <h4>Pull requests</h4>
        {!c.prs.length && <div className="muted small">None yet. PRs opened or linked here show up with live status.</div>}
        {created.length > 0 && <MergePlan urls={created.map(p => p.url)} onOpen={onOpen} />}
        {mentioned.length > 0 && <details><summary className="muted small">{mentioned.length} mentioned</summary>{mentioned.map(p => <div key={p.url} className="d-pr"><PrBadge pr={p} full /></div>)}</details>}
      </section>

      <section>
        <h4>Connected conversations <button className="link small" onClick={() => setPicking(!picking)}>{picking ? 'cancel' : '+ link'}</button></h4>
        {picking && <LinkPicker from={c.id} onDone={() => setPicking(false)} />}
        {!c.links.length && !picking && <div className="muted small">Pull context into a new chat, or link one by hand, and the thread shows up here.</div>}
        {c.links.map(l => (
          <div key={l.other + l.kind} className="d-link">
            <button className="link grow ellipsis" onClick={() => onOpen(l.other)}>{l.dir === 'out' ? '→' : '←'} {l.title ?? l.other.slice(0, 8)}</button>
            <span className="muted small">{l.kind === 'started' ? (l.dir === 'in' ? 'started from' : 'started') : (KIND[l.kind] ?? l.kind)}</span>
            <button className="icon small" title="Remove link" onClick={() => api.send('DELETE', `/api/conversations/${encodeURIComponent(c.id)}/links/${encodeURIComponent(l.other)}`)}>×</button>
          </div>
        ))}
      </section>

      <ChatUsage id={c.id} />

      <FilesSection id={c.id} />

      <Evidence id={c.id} />

      <Lifecycle id={c.id} />

      <section>
        <h4>Note</h4>
        <textarea className="note" rows={2} placeholder="Why this matters, what's next…" value={note ?? c.note ?? ''}
          onChange={e => setNote(e.target.value)} onBlur={() => { if (note !== null) post(`/api/conversations/${encodeURIComponent(c.id)}/state`, { note }) }} />
      </section>

      {c.source !== 'posthog-task' && (
        <section>
          <h4>Automate</h4>
          <button onClick={() => onMakeRoutine(c)}>Run on a schedule or webhook…</button>
        </section>
      )}

      {c.tools.length > 0 && (
        <section>
          <h4>Tools used</h4>
          {c.tools.map(t => (
            <div key={t.name} className="d-tool small"><span className="grow ellipsis">{t.name.replace(/^mcp__/, '')}</span><span className="muted">{t.n}{t.errors ? <b className="bad"> · {t.errors} err</b> : null}</span></div>
          ))}
        </section>
      )}
    </div>
  )
}

// A PR in the details panel: the badge, and its full preview one click away.

function Labels({ c }: { c: Detail }) {
  const [v, setV] = useState('')
  const [spread, setSpread] = useState(false)
  const add = () => {
    if (!v.trim()) return
    post('/api/labels', { ids: spread ? [c.id, ...c.siblings.map(s => s.id)] : [c.id], add: [v] })
    setV('')
  }
  return (
    <section>
      <h4>Labels</h4>
      <div className="chips">
        {c.labels.map(l => <span key={l} className="label">#{l} <button onClick={() => post('/api/labels', { ids: [c.id], remove: [l] })}>×</button></span>)}
        <input className="label-input" value={v} placeholder="+ label" onChange={e => setV(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add() }} />
      </div>
      {c.siblings.length > 0 && (
        <label className="toggle small" title={c.siblings.map(s => s.title).join('\n')}>
          <input type="checkbox" checked={spread} onChange={e => setSpread(e.target.checked)} /> also label {c.siblings.length} related (same branch, PRs, links)
        </label>
      )}
    </section>
  )
}

function LinkPicker({ from, onDone }: { from: string; onDone: () => void }) {
  const [q, setQ] = useState('')
  const { data } = useLive<{ conversations: Conversation[] }>(q.length > 1 ? `/api/conversations?q=${encodeURIComponent(q)}&sort=relevance&limit=8` : null)
  return (
    <div className="picker">
      <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search a conversation to link…" />
      {(data?.conversations ?? []).filter(c => c.id !== from).map(c => (
        <button key={c.id} className="picker-row" onClick={() => { post(`/api/conversations/${encodeURIComponent(from)}/links`, { to: c.id, kind: 'manual' }); onDone() }}>
          {titleOf(c)} <span className="muted small">{ago(c.updated_at)}</span>
        </button>
      ))}
    </div>
  )
}

// The data this conversation stands on: each query its agent ran, the numbers it got, and a link
// to open the same query in Grafana or PostHog. Newest first; it updates as the chat goes.
type Ev = { at: number | null; source: 'grafana' | 'posthog'; tool: string; title: string; query: string; numbers: { label: string; value: string }[]; link: string | null; linkLabel: string }
function Evidence({ id }: { id: string }) {
  const { data } = useLive<{ evidence: Ev[] }>(`/api/conversations/${encodeURIComponent(id)}/evidence`, ['conversations', 'chats'])
  const [all, setAll] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const ev = data?.evidence ?? []
  if (!ev.length) return null
  return (
    <section>
      <h4>Evidence <span className="muted small">{ev.length} quer{ev.length === 1 ? 'y' : 'ies'}</span></h4>
      {(all ? ev : ev.slice(0, 5)).map((e, i) => (
        <div key={i} className="evidence">
          <div className="ev-head" onClick={() => setOpen(open === i ? null : i)} title={e.query}>
            <Brand id={e.source} size={13} />
            <code className={`ev-q${open === i ? ' full' : ''}`}>{open === i ? e.query : e.title}</code>
          </div>
          {e.numbers.length > 0 && <div className="ev-nums">{e.numbers.slice(0, open === i ? 12 : 3).map((n, j) => <span key={j} className="ev-num" title={n.label}><b>{n.value}</b> <span className="muted">{n.label}</span></span>)}</div>}
          <div className="ev-foot small muted"><span>{e.tool}{e.at ? ` · ${ago(e.at)} ago` : ''}</span>{e.link && <a href={e.link} target="_blank" rel="noreferrer">{e.linkLabel} ↗</a>}</div>
        </div>
      ))}
      {ev.length > 5 && <button className="link small" onClick={() => setAll(!all)}>{all ? 'show fewer' : `all ${ev.length}`}</button>}
    </section>
  )
}

// The PRs of this piece of work, in the order to merge them, each with its one next step and who
// owns it, and on top, in one line, what's needed from you to get it all merged.
type PlanItem = { url: string; number: number; title: string; repo: string; root: string; depth: number; parent: number | null; step: { owner: 'you' | 'agent' | 'wait' | 'done'; text: string } }
const OWNER = { you: 'You', agent: 'Agent', wait: 'Wait', done: 'Done' }
function MergePlan({ urls, onOpen }: { urls: string[]; onOpen: (id: string) => void }) {
  const { data, error } = useLive<{ summary: string; items: PlanItem[]; agentFixable: string[] }>(`/api/prs/plan?urls=${encodeURIComponent(urls.join(','))}`, ['conversations'])
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (error) return <div className="muted small">{error}</div>
  if (!data) return <div className="muted small">Working out the merge order…</div>
  const fixAll = async () => {
    setBusy(true)
    const r = await post<any>('/api/prs/orchestrate', { prs: data.items.filter(i => data.agentFixable.includes(i.url)).map(i => ({ url: i.url, title: i.title })), where: 'here', goal: 'both' })
    setBusy(false)
    if (r.conversationId) onOpen(r.conversationId)
  }
  let n = 0
  return (
    <div className="plan">
      {data.summary && <div className="plan-summary small"><b>Needed from you:</b> {data.summary}</div>}
      <ol className="plan-steps">
        {data.items.map(i => {
          const num = i.step.owner === 'done' ? null : ++n
          return (
            <li key={i.url} className={`plan-step o-${i.step.owner}`} style={{ marginLeft: i.depth * 12 }}>
              <div className="row-flex plan-row" onClick={() => setOpen(open === i.url ? null : i.url)}>
                <span className="plan-num">{num ?? '✓'}</span>
                <span className="grow ellipsis" title={i.title}><a href={i.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>#{i.number}</a> {i.title.replace(/^\w+(\([^)]*\))?!?:\s*/, '')}</span>
                <span className={`plan-owner o-${i.step.owner}`}>{OWNER[i.step.owner]}</span>
              </div>
              <div className="plan-text small">{i.step.text}{i.parent ? <span className="muted"> · stacked on #{i.parent}</span> : null}</div>
              {open === i.url && <PrPreviewCard url={i.url} />}
            </li>
          )
        })}
      </ol>
      {data.agentFixable.length > 0 && <button className="small" disabled={busy} onClick={fixAll} title="One agent fixes them all (CI, conflicts, review threads), stacks bottom-up">{busy ? 'starting…' : `⚡ Let an agent fix ${data.agentFixable.length === 1 ? 'it' : `the ${data.agentFixable.length}`}`}</button>}
    </div>
  )
}

// What this conversation cost, on which models, and any model switch that had to reload the whole
// context. API-equivalent figures: not billed on a subscription, but they track your plan's limits.
const modelName = (m: string) => { const c = m.match(/^claude-(opus|sonnet|haiku|fable)/)?.[1]; return c ? c[0].toUpperCase() + c.slice(1) : m.replace(/:latest$/, '') }
const money = (n: number) => n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`
const ktok = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`
function ChatUsage({ id }: { id: string }) {
  const { data: u } = useLive<any>(`/api/conversations/${encodeURIComponent(id)}/usage`, ['conversations', 'chats'])
  if (!u || !u.turns) return null
  return (
    <section>
      <h4>Usage <span className="muted small">{u.measured ? money(u.cost) : 'tokens only'}{u.context ? ` · ${ktok(u.context)} context` : ''}</span></h4>
      {u.byModel.map((m: any) => (
        <div key={m.model} className="usage-row small">
          <span className="grow">{modelName(m.model)}</span>
          <span className="muted">{m.turns} {u.measured ? 'turn' : 'reply'}{m.turns === 1 ? '' : 's'}</span>
          <b>{m.cost != null ? money(m.cost) : ktok(m.tokens)}</b>
        </div>
      ))}
      {u.switches.length > 0 && (
        <div className="usage-switches small">
          {u.switches.map((w: any, i: number) => <div key={i} className="warn" title="The new model had no cache of this conversation, so the whole context was loaded again">⇄ switch to {modelName(w.model)} reloaded {ktok(w.tokens)} tokens (~{money(w.cost)})</div>)}
        </div>
      )}
      <div className="muted small">{u.measured ? 'What this would cost on the API. On your plan it isn’t billed, but it counts toward your usage limits.' : 'Run outside perch, so no cost was reported; tokens from its transcript.'}</div>
    </section>
  )
}

// How perch closed this chat out: outcome, what it saved to memory (with a pointer back here), loose ends.
function Lifecycle({ id }: { id: string }) {
  const { data: h } = useLive<any>(`/api/lifecycle/${encodeURIComponent(id)}`, ['conversations'])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const run = async () => {
    setBusy(true); setErr('')
    const r: any = await post(`/api/lifecycle/${encodeURIComponent(id)}/harvest`).catch((e: any) => ({ error: String(e) }))
    if (r?.error) setErr(r.error)
    setBusy(false)
  }
  const files: string[] = h && !h.none ? JSON.parse(h.memories || '[]') : []
  return (
    <section>
      <h4>Lifecycle <button className="link small" disabled={busy} onClick={run} title="Read this chat, save anything worth remembering to memory, and close it if it's done">{busy ? 'closing out…' : h && !h.none ? 'close out again' : 'close out now'}</button></h4>
      {(!h || h.none) && !busy && <div className="muted small">When this goes quiet for 2 days, perch closes it out: saves anything worth remembering to memory, with a link back here, and archives it. Unfinished work goes to Needs me instead.</div>}
      {h && !h.none && <div className="small">
        <div><b>{h.outcome === 'unfinished' ? 'Went stale unfinished' : h.outcome === 'abandoned' ? 'Closed (abandoned)' : 'Closed (complete)'}</b> <span className="muted">· {ago(h.harvested_at)} ago</span></div>
        {h.summary && <div>{h.summary}</div>}
        {h.loose_ends && <div className="warn">Loose end: {h.loose_ends}</div>}
        <div className="muted">{files.length ? <>Saved to memory: {files.map(f => <code key={f} title={`${h.memory_dir}/${f}`}>{f} </code>)}</> : 'Nothing worth keeping in memory.'}</div>
      </div>}
      {err && <div className="bad small">{err}</div>}
    </section>
  )
}
