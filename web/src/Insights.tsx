import { toolLabel } from './stream'
import { useState } from 'react'
import { useLive } from './api'
import { PrFlow } from './PrFlow'
import { Models } from './Race'

type A = {
  servers: { server: string; calls: number; errors: number; conversations: number }[]
  tools: { name: string; server: string | null; calls: number; errors: number }[]
  daily: { day: string; calls: number; mcp_calls: number }[]
  sources: { day: string; source: string; n: number }[]
  hours: { hour: number; n: number }[]
  repeats: { prefix: string; n: number; last: number; ids: string }[]
  projects: { cwd: string; n: number; messages: number }[]
  skills: { name: string; calls: number }[]
  agents: { name: string; calls: number }[]
  mcp?: { tool: string; action: string; calls: number; errors: number; avg_ms: number; max_ms: number; refused: number; no_app: number; conversations: number }[]
}

function Bars({ rows, label, value, extra }: { rows: any[]; label: (r: any) => string; value: (r: any) => number; extra?: (r: any) => React.ReactNode }) {
  const max = Math.max(1, ...rows.map(value))
  return (
    <div className="bars">
      {rows.map((r, i) => (
        <div key={i} className="bar-row">
          <span className="bar-label ellipsis" title={label(r)}>{label(r)}</span>
          <span className="bar-track"><span className="bar" style={{ width: `${(100 * value(r)) / max}%` }} /></span>
          <span className="bar-value">{value(r)}{extra?.(r)}</span>
        </div>
      ))}
    </div>
  )
}

export function Insights({ onOpen }: { onOpen: (id: string) => void }) {
  const [tab, setTab] = useState(() => { try { return localStorage.getItem('perch.insights.tab') ?? 'prs' } catch { return 'prs' } })
  const pick = (t: string) => { setTab(t); try { localStorage.setItem('perch.insights.tab', t) } catch {} }
  return (
    <div className="page">
      <div className="tabs">{[['prs', 'PRs'], ['models', 'Models'], ['usage', 'Agent usage']].map(([id, l]) => <button key={id} className={`tab${tab === id ? ' on' : ''}`} onClick={() => pick(id)}>{l}</button>)}</div>
      {tab === 'prs' ? <PrFlow onOpen={onOpen} /> : tab === 'models' ? <Models /> : <Usage onOpen={onOpen} />}
    </div>
  )
}

function Usage({ onOpen }: { onOpen: (id: string) => void }) {
  const [days, setDays] = useState(30)
  const { data, loading, stale } = useLive<A>(`/api/analytics?days=${days}`, ['conversations'], undefined, 60_000, true)
  if (!data) return <div className="pad muted">…</div>
  const total = data.servers.reduce((n, s) => n + s.calls, 0)
  const conversations = data.sources.reduce((n, s) => n + s.n, 0)
  const err = (r: any) => r.errors ? <span className="bad small"> · {Math.round((100 * r.errors) / r.calls)}% err</span> : null
  const maxDay = Math.max(1, ...data.daily.map(d => d.calls))
  return (
    <>
      <div className="row-flex">
        <h2 className="grow">Your agent usage</h2>
        {(stale || loading) && <span className="muted small" role="status">{stale ? (loading ? `loading ${days === 1 ? 'today' : `${days} days`}…` : 'couldn’t load that range, showing the last one') : 'refreshing…'}</span>}
        <select value={days} onChange={e => setDays(Number(e.target.value))}>{[1, 7, 30, 90, 365].map(d => <option key={d} value={d}>{d === 1 ? 'today' : `${d} days`}</option>)}</select>
      </div>
      <div className={stale ? 'is-stale' : undefined} aria-busy={stale}>
      <div className="stats">
        <div className="stat"><b>{conversations}</b><span>conversations</span></div>
        <div className="stat"><b>{total}</b><span>tool calls</span></div>
        <div className="stat"><b>{data.servers.filter(s => s.server !== 'built-in').reduce((n, s) => n + s.calls, 0)}</b><span>MCP calls</span></div>
      </div>
      <Speed days={days} />
      <section className="card">
        <h3>Tool calls per day</h3>
        <div className="spark">{data.daily.map(d => <span key={d.day} title={`${d.day}: ${d.calls} calls, ${d.mcp_calls} MCP`} style={{ height: `${(100 * d.calls) / maxDay}%` }}><i style={{ height: `${d.calls ? (100 * d.mcp_calls) / d.calls : 0}%` }} /></span>)}</div>
        <div className="muted small">Darker part = MCP calls.</div>
      </section>
      <div className="two">
        <section className="card"><h3>MCP servers</h3><Bars rows={data.servers} label={r => r.server} value={r => r.calls} extra={err} /></section>
        <section className="card"><h3>Top tools</h3><Bars rows={data.tools.slice(0, 15)} label={r => toolLabel(r.name)} value={r => r.calls} extra={err} /></section>
      </div>
      {!!data.mcp?.length && (
        <section className="card">
          <h3>auto-m8 tools: what agents did</h3>
          <Bars rows={data.mcp.slice(0, 20)} label={r => r.action ? `${r.tool} · ${r.action}` : r.tool} value={r => r.calls}
            extra={r => <span className="muted small"> · {r.avg_ms < 1000 ? `${r.avg_ms}ms` : `${(r.avg_ms / 1000).toFixed(1)}s`} avg{err(r)}{r.refused ? <span className="warn"> · {r.refused} refused</span> : null}{r.no_app ? <span className="warn"> · {r.no_app} app not running</span> : null}</span>} />
          <div className="muted small">From auto-m8's own MCP process, kept on this Mac. Recorded since Nov 26.</div>
        </section>
      )}
      {(data.skills.length > 0 || data.agents.length > 0) && (
        <div className="two">
          <section className="card"><h3>Skills you used</h3>{data.skills.length ? <Bars rows={data.skills} label={r => r.name} value={r => r.calls} /> : <div className="muted small">None in this window.</div>}</section>
          <section className="card"><h3>Subagents</h3>{data.agents.length ? <Bars rows={data.agents} label={r => r.name} value={r => r.calls} /> : <div className="muted small">None in this window.</div>}</section>
        </div>
      )}
      <section className="card">
        <h3>What you keep asking</h3>
        <div className="muted small">Conversations that open the same way: candidates for a skill, a routine or a scout.</div>
        {!data.repeats.length && <div className="muted small">Nothing repeated yet in this window.</div>}
        {data.repeats.map(r => (
          <div key={r.prefix} className="line">
            <b>{r.n}×</b><span className="grow ellipsis">{r.prefix}…</span>
            {r.ids.split(',').slice(0, 4).map(id => <button key={id} className="link small" onClick={() => onOpen(id)}>open</button>)}
          </div>
        ))}
      </section>
      <div className="two">
        <section className="card"><h3>Projects</h3><Bars rows={data.projects} label={r => r.cwd.replace(/^\/Users\/[^/]+/, '~')} value={r => r.n} /></section>
        <section className="card"><h3>When you start conversations</h3><Bars rows={Array.from({ length: 24 }, (_, h) => ({ h, n: data.hours.find(x => x.hour === h)?.n ?? 0 })).filter(r => r.n)} label={r => `${r.h}:00`} value={r => r.n} /></section>
      </div>
      </div>
    </>
  )
}

type S = { n: number; median: number | null; p75: number | null; ttft: number | null; corrected: number; down: number; up: number; failed: number; subagents: number; cost: number | null }
type Speeds = { days: number; overall: { normal: S; turbo: S }; byIntent: { intent: string; normal: S; turbo: S }[]; sources: { perch: number; transcript: number } }
const dur = (ms: number | null) => ms == null ? '–' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3600_000 ? `${(ms / 60_000).toFixed(ms < 600_000 ? 1 : 0)}m` : `${(ms / 3600_000).toFixed(1)}h`
// Held up: no correction in your next message, no 👎, no failure.
const missRate = (s: S) => s.n ? (s.corrected + s.down + s.failed) / s.n : null
const pct = (x: number | null) => x == null ? '–' : `${Math.round(100 * x)}%`
const INTENT_LABEL: Record<string, string> = { pr: 'PRs & CI', review: 'Reviews', fix: 'Fixes', build: 'Building', research: 'Questions', write: 'Writing', other: 'Other' }

// Turbo vs normal, like for like: the same kinds of ask, timed from your message to the answer.
function Speed({ days }: { days: number }) {
  const { data } = useLive<Speeds>(`/api/insights/turns?days=${days}`, ['conversations', 'chats'], undefined, 60_000, true)
  if (!data) return null
  const { normal, turbo } = data.overall
  // Like for like: only kinds of ask with 3+ turns each way, weighted by how much turbo ran there.
  const fair = data.byIntent.filter(r => r.normal.n >= 3 && r.turbo.n >= 3 && r.normal.median && r.turbo.median)
  const w = fair.reduce((x, r) => x + r.turbo.n, 0)
  const faster = w ? fair.reduce((x, r) => x + r.turbo.n * (1 - r.turbo.median! / r.normal.median!), 0) / w : null
  const max = Math.max(1, ...data.byIntent.flatMap(r => [r.normal.median ?? 0, r.turbo.median ?? 0]))
  return (
    <section className="card">
      <h3>Speed: normal vs ⚡ turbo</h3>
      <div className="stats">
        <div className="stat"><b>{dur(normal.median)}</b><span>median turn, normal ({normal.n})</span></div>
        <div className="stat"><b>{dur(turbo.median)}</b><span>median turn, ⚡ turbo ({turbo.n})</span></div>
        <div className="stat"><b>{faster == null ? '–' : `${faster > 0 ? '−' : '+'}${Math.abs(Math.round(100 * faster))}%`}</b><span>{faster == null ? 'turbo vs normal: needs 3+ turbo turns of a kind' : `turbo vs normal, same kinds of ask (${w} turns)`}</span></div>
        <div className="stat"><b>{pct(missRate(normal))} / {pct(missRate(turbo))}</b><span>missed, normal / turbo</span></div>
      </div>
      <div>
        <div className="speed-legend small"><span><i className="sw speed-normal" />normal</span><span><i className="sw speed-turbo" />⚡ turbo</span><span className="muted grow right">median time per turn · hover for the slow end</span></div>
        <div className="speed-table">
          <div className="speed-row head small muted"><span>Kind of ask</span><span>Median time</span><span>Missed</span><span>Turns</span></div>
          {data.byIntent.map(r => (
            <div key={r.intent} className="speed-row">
              <span className="small">{INTENT_LABEL[r.intent] ?? r.intent}</span>
              <span className="speed-bars">
                {(['normal', 'turbo'] as const).map(k => (
                  <span key={k} className="speed-bar-row" title={`${k}: median ${dur(r[k].median)}, slowest quarter from ${dur(r[k].p75)}, first words after ${dur(r[k].ttft)}${r[k].subagents ? `, ${r[k].subagents.toFixed(1)} subagents per turn` : ''}`}>
                    {r[k].n ? <><span className={`speed-bar speed-${k}`} style={{ width: `${(100 * (r[k].median ?? 0)) / max}%` }} /><span className="small speed-val">{dur(r[k].median)}</span></> : <span className="muted small">no turns yet</span>}
                  </span>))}
              </span>
              <span className="small speed-miss">{pct(missRate(r.normal))}<br />{pct(missRate(r.turbo))}</span>
              <span className="small muted">{r.normal.n}<br />{r.turbo.n}</span>
            </div>))}
        </div>
        <div className="muted small">Missed = your next message corrected it, you rated it 👎, or it failed. {data.sources.transcript} turns are timed from Claude Code transcripts, {data.sources.perch} live in auto-m8. Rate answers with 👍/👎 to sharpen this.</div>
      </div>
    </section>
  )
}
