// Search everywhere. Two tiers on one page: instant results from every local source (grouped,
// folded), and for real questions a search agent whose work stays out of the way: a scope
// breadcrumb, one pill per parallel agent, folded steps, then a short answer with citations.
import { useEffect, useRef, useState } from 'react'
import { ago, api, post, useLive } from './api'
import { Markdown } from './Chat'
import { toolLabel, toolSummary } from './stream'
import { Brand } from './Brand'

const SOURCE_BRAND: Record<string, string> = { conversations: 'claude', code: 'git', mac: 'finder', skills: 'claude-mark', github: 'github', applenotes: 'notes' }

type Hit = { title: string; sub?: string; snippet?: string; href?: string; open?: { kind: 'conversation' | 'file' | 'skill' | 'applenote'; id: string; line?: number } }
type Group = { source: string; label: string; hits: Hit[]; ms: number; error?: string }
type AgentPill = { id: string; label: string; done: boolean; steps: number; last?: string }
type AgentState = { scopes: string[]; answer: string; steps: { name: string; sum: string }[]; agents: AgentPill[]; running: boolean; started: number; cost?: number; ms?: number; error?: string }

const MODES = [['auto', 'Auto'], ['fast', '⚡ Fast'], ['balanced', '◎ Balanced'], ['deep', '🔬 Deep']] as const
const empty = (): AgentState => ({ scopes: [], answer: '', steps: [], agents: [], running: true, started: Date.now() })
export const looksLikeQuestion = (q: string) => /\?$|^(what|where|when|why|how|which|who|did|does|do|have|was|is there|can|find|show)\b/i.test(q.trim()) || q.trim().split(/\s+/).length > 5

export function Search({ initial, onOpen }: { initial: { q: string; mode?: string; agent?: string }; onOpen: (id: string) => void }) {
  const [q, setQ] = useState(initial.q)
  const [mode, setMode] = useState(initial.mode ?? (initial.agent === 'deep' ? 'deep' : 'auto'))
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [agentId, setAgentId] = useState<string | null>(initial.agent ?? null)
  const [picked, setPicked] = useState<{ mode: string; why: string } | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const runQuick = async (text: string, only?: string) => {
    setSearching(true)
    const r = await api.get<{ results: Group[] }>(`/api/search/quick?q=${encodeURIComponent(text)}${only ? `&sources=${only}` : ''}`)
    setGroups(g => only && g ? [...r.results, ...g.filter(x => !r.results.some(y => y.source === x.source))] : r.results)
    setSearching(false)
  }
  const runAgent = async (text: string, m = initial.agent === 'deep' && !picked ? 'deep' : mode) => {
    const r = await post<{ id: string; mode: string; why: string }>('/api/search', { q: text, mode: m })
    setPicked({ mode: r.mode, why: r.why })
    setAgentId(r.id)
  }
  const submit = (force = false) => {
    const text = q.trim()
    if (!text) return
    setAgentId(null)
    runQuick(text)
    if (force || looksLikeQuestion(text) || mode !== 'auto') runAgent(text)
  }
  useEffect(() => { if (initial.q) submit(!!initial.agent || initial.mode === 'agent') ; input.current?.focus() }, []) // eslint-disable-line
  // The cheap sources update as you type; everything else on Enter.
  useEffect(() => {
    if (q.trim().length < 3) return
    const t = setTimeout(() => runQuick(q.trim(), 'conversations,notes,skills'), 250)
    return () => clearTimeout(t)
  }, [q])

  return (
    <div className="page search">
      <div className="search-bar">
        <input ref={input} value={q} placeholder="Search everything, or ask a question…" onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(e.metaKey) }} />
        <button className="primary" onClick={() => submit(true)} title="Search everywhere and ask Claude  ⌘↵">✦ Ask</button>
      </div>
      <div className="row-flex">
        <div className="seg">{MODES.map(([k, l]) => <button key={k} className={mode === k ? 'on' : ''} onClick={() => setMode(k)}
          title={{ auto: 'auto-m8 picks from the question', fast: 'one or two sources, under a minute', balanced: 'the likely sources, widens once', deep: 'parallel agents, upstream source, cross-checked' }[k]}>{l}</button>)}</div>
        {picked && <span className="muted small">{mode === 'auto' ? `auto → ${picked.mode} (${picked.why})` : picked.mode}</span>}
        {searching && <span className="muted small">searching…</span>}
      </div>

      {agentId && <AgentRun id={agentId} onOpen={onOpen} />}
      {groups && <Results groups={groups} onOpen={onOpen} />}
      {!groups && !agentId && <Recent onPick={text => { setQ(text); setTimeout(() => submit(), 0) }} onOpen={onOpen} />}
    </div>
  )
}

function Results({ groups, onOpen }: { groups: Group[]; onOpen: (id: string) => void }) {
  const withHits = groups.filter(g => g.hits.length)
  const [open, setOpen] = useState<Set<string>>(new Set())
  useEffect(() => { setOpen(new Set(withHits.slice(0, 2).map(g => g.source))) }, [groups.map(g => g.source + g.hits.length).join()]) // eslint-disable-line
  const openHit = (h: Hit) => {
    if (h.open?.kind === 'conversation') onOpen(h.open.id)
    else if (h.open?.kind === 'file') post('/api/open-file', { path: h.open.id, line: h.open.line })
    else if (h.open?.kind === 'skill') location.hash = '#library'
    else if (h.open?.kind === 'applenote') post(`/api/applenotes/${encodeURIComponent(h.open.id)}/open`)
    else if (h.href) window.open(h.href, '_blank')
  }
  return (
    <div className="groups">
      <div className="src-strip">
        {groups.map(g => (
          <button key={g.source} className={`chip-btn ${open.has(g.source) ? 'on' : ''} ${g.hits.length ? '' : 'none'}`} title={g.error ?? `${g.ms} ms`}
            onClick={() => setOpen(o => { const n = new Set(o); n.has(g.source) ? n.delete(g.source) : n.add(g.source); return n })}>
            {SOURCE_BRAND[g.source] && <Brand id={SOURCE_BRAND[g.source]} size={13} />}{g.label}<span className="count">{g.error ? '!' : g.hits.length}</span>
          </button>
        ))}
      </div>
      {withHits.filter(g => open.has(g.source)).map(g => (
        <section key={g.source} className="group">
          <div className="section-head group-head">{SOURCE_BRAND[g.source] && <Brand id={SOURCE_BRAND[g.source]} size={12} />}{g.label} · {g.hits.length}</div>
          {g.hits.map((h, i) => (
            <div key={i} className="hit" onClick={() => openHit(h)}>
              <div className="hit-top"><span className="hit-title ellipsis">{h.title}</span>{h.sub && <span className="muted small ellipsis">{h.sub}</span>}</div>
              {h.snippet && <div className="muted small hit-snip" dangerouslySetInnerHTML={{ __html: snippetHtml(h.snippet) }} />}
            </div>
          ))}
        </section>
      ))}
      {!withHits.length && <div className="muted small">Nothing in the instant sources. ✦ Ask sends an agent wider: Slack, meetings, GitHub and upstream source.</div>}
    </div>
  )
}

const snippetHtml = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!).replace(/«/g, '<mark>').replace(/»/g, '</mark>')

// Follows a search session over the chat socket and reduces it to what's worth seeing.
export function AgentRun({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const [s, setS] = useState<AgentState>(empty)
  const [steer, setSteer] = useState('')
  const [voted, setVoted] = useState<number | null>(null)
  useEffect(() => {
    setS(empty()); setVoted(null)
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/chat/${id}`)
    let text = ''
    const agents = new Map<string, AgentPill>()
    ws.onmessage = e => {
      const ev = JSON.parse(e.data)
      setS(prev => {
        const n = { ...prev }
        if (ev.type === 'perch_state') n.running = ev.state === 'running'
        if (ev.type === 'perch_user') { text = ''; n.answer = ''; n.running = true }
        if (ev.parent_tool_use_id) {
          // Inside a subagent: count its steps on its pill.
          const pill = agents.get(ev.parent_tool_use_id)
          if (pill && ev.type === 'assistant') for (const b of ev.message?.content ?? []) if (b.type === 'tool_use') { pill.steps++; pill.last = toolLabel(b.name) }
          n.agents = [...agents.values()]
          return n
        }
        if (ev.type === 'stream_event' && ev.event?.type === 'content_block_start' && ev.event.content_block?.type === 'tool_use') text = '' // narration before a tool isn't the answer
        if (ev.type === 'stream_event' && ev.event?.delta?.type === 'text_delta') {
          text += ev.event.delta.text
          const scopes = [...text.matchAll(/^Scope:\s*(.+)$/gm)].map(m => m[1].trim())
          if (scopes.length) n.scopes = [...new Set([...prev.scopes, ...scopes])]
          n.answer = text.replace(/^Scope:.*$/gm, '').replace(/<!--perch[\s\S]*?(-->|$)/, '').trim()
        }
        if (ev.type === 'assistant') for (const b of ev.message?.content ?? []) {
          if (b.type !== 'tool_use') continue
          if (b.name === 'Agent' || b.name === 'Task') agents.set(b.id, { id: b.id, label: b.input?.description ?? 'agent', done: false, steps: 0 })
          else n.steps = [...prev.steps, { name: toolLabel(b.name), sum: toolSummary(b.name, b.input) }]
          n.agents = [...agents.values()]
        }
        if (ev.type === 'user') for (const b of ev.message?.content ?? []) {
          const pill = b.type === 'tool_result' && agents.get(b.tool_use_id)
          if (pill) { pill.done = true; n.agents = [...agents.values()] }
        }
        if (ev.type === 'result') { n.running = false; n.cost = ev.total_cost_usd; n.ms = ev.duration_ms; if (ev.is_error) n.error = String(ev.result ?? 'failed') }
        if (ev.type === 'perch_error') { n.error = ev.message; n.running = false }
        return n
      })
    }
    return () => ws.close()
  }, [id])

  const send = (text: string) => { post(`/api/search/${id}/steer`, { text }); setSteer('') }
  const vote = (v: 1 | -1) => { setVoted(v); post(`/api/search/${id}/feedback`, { value: v }) }
  // Following a citation counts as the answer having helped.
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a')
    const href = a?.getAttribute('href') ?? ''
    if (!a) return
    if (href.startsWith('perch-file://')) {
      e.preventDefault(); e.stopPropagation()
      const [path, line] = decodeURIComponent(href.slice('perch-file://'.length)).split('#L')
      post('/api/open-file', { path, line: line ? Number(line) : undefined })
    }
    post(`/api/search/${id}/feedback`, { value: 'opened' })
  }
  const secs = Math.round(((s.ms ?? (Date.now() - s.started)) / 1000))
  return (
    <section className="card agent-run">
      <div className="run-head">
        <span className={`dot ${s.running ? 's-running' : s.error ? 'bad' : 'ok'}`} />
        <div className="scopes grow">{s.scopes.length ? s.scopes.map((sc, i) => <span key={i} className="scope">{i > 0 && '→ '}{sc}</span>) : <span className="muted small">{s.running ? 'deciding where to look…' : ''}</span>}</div>
        <span className="muted small">{s.steps.length} steps · {secs}s{s.cost ? ` · $${s.cost.toFixed(2)}` : ''}</span>
      </div>
      {s.agents.length > 0 && (
        <div className="pills">{s.agents.map(a => <span key={a.id} className={`pill ${a.done ? 'done' : ''}`} title={a.last ? `last: ${a.last}` : ''}>{a.done ? '✓' : <i className="spin" />} {a.label}<span className="muted"> {a.steps}</span></span>)}</div>
      )}
      {s.steps.length > 0 && (
        <details className="steps-fold"><summary className="muted small">what it looked at</summary>
          {s.steps.map((st, i) => <div key={i} className="small step"><b>{st.name}</b> <span className="muted">{st.sum}</span></div>)}
        </details>
      )}
      {s.error && <div className="bad small">{s.error}</div>}
      {s.answer && <div className="answer" onClickCapture={onClick}><Markdown text={s.answer} /></div>}
      <div className="run-foot">
        {s.running ? (
          <>
            <button className="chip-btn" onClick={() => send('faster')} title="Wrap up with what it has">⚡ Faster</button>
            <button className="chip-btn" onClick={() => send('deeper')} title="Widen, add parallel agents, read sources">🔬 Deeper</button>
            <button className="chip-btn" onClick={() => send('stop')} title="Answer now">■ Answer now</button>
          </>
        ) : (
          <>
            <button className={`chip-btn ${voted === 1 ? 'on' : ''}`} onClick={() => vote(1)} title="Found it (teaches the playbook)">👍</button>
            <button className={`chip-btn ${voted === -1 ? 'on' : ''}`} onClick={() => vote(-1)} title="Missed (teaches the playbook)">👎</button>
            <button className="link small" onClick={() => onOpen(id)}>continue as a chat</button>
          </>
        )}
        <input className="grow steer" value={steer} placeholder={s.running ? 'Steer: “only the charts repo”, “check Slack too”…' : 'Follow up…'}
          onChange={e => setSteer(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && steer.trim()) send(steer.trim()) }} />
      </div>
    </section>
  )
}

function Recent({ onPick, onOpen }: { onPick: (q: string) => void; onOpen: (id: string) => void }) {
  const { data } = useLive<{ runs: any[] }>('/api/search/history')
  if (!data?.runs.length) return <div className="muted small">Search looks across your conversations, notes, every repo on this Mac, Spotlight, skills and GitHub at once. Questions also start an agent that can read Slack, meetings and upstream source.</div>
  return (
    <section className="card">
      <h4>Recent searches</h4>
      {data.runs.slice(0, 12).map(r => (
        <div key={r.id} className="conv-line">
          <span className={`dot ${r.feedback === 1 || r.opened ? 'ok' : r.feedback === -1 ? 'bad' : 'pending'}`} />
          <span className="grow ellipsis" onClick={() => onPick(r.q)}>{r.q}</span>
          <span className="muted small">{r.mode} · {ago(r.started_at)}</span>
          <button className="link small" onClick={() => onOpen(r.conversation_id)}>answer</button>
        </div>
      ))}
    </section>
  )
}
