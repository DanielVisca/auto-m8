// Insights → Models: what races and shadow runs say about which model is good at what, and how
// often the model you reach for is more (or less) than the task needed. Every number drills into
// the race it came from: diffs, reviews, adjudications, check output, tools used.
import { useState } from 'react'
import { api, post, useLive } from './api'

const money = (n?: number | null) => n == null ? '–' : n < 0.01 ? (n ? '<$0.01' : '$0') : `$${n.toFixed(2)}`
const dur = (ms?: number | null) => !ms ? '–' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 60_000).toFixed(ms < 600_000 ? 1 : 0)} min`
const pct = (x?: number | null) => x == null ? '–' : `${Math.round(100 * x)}%`
const name = (m?: string | null) => {
  if (!m) return '–'
  if (m.startsWith('codex:')) return m.slice(6).replace(/^gpt-/, 'GPT ').replace(/-(\w)/g, (_, c) => ` ${c.toUpperCase()}`)
  const c = m.match(/^claude-(\w+)-([\d-]+)/)
  return c ? `${c[1][0].toUpperCase()}${c[1].slice(1)} ${c[2].replace(/-/g, '.')}` : m
}
const R = { textAlign: 'right' as const }
const SIZE: Record<string, string> = { overkill: '#c90', right: '#3a3', underkill: '#c33' }
const SEV: Record<string, string> = { high: '#c33', medium: '#c90', low: 'var(--muted, #888)' }

export function Models() {
  const { data: o } = useLive<any>('/api/race', ['race', 'shadow', 'settings', 'conversations'], undefined, 60_000)
  const [open, setOpen] = useState<string | null>(null)
  if (!o) return <div className="pad muted">…</div>
  const s = o.sizing
  return (
    <>
      <div className="row-flex"><h2 className="grow">Models: who is good at what</h2>{o.running ? <span className="small" style={{ color: '#58f' }}>{o.running} {o.running === 1 ? 'race' : 'races'} running</span> : null}</div>
      <div className="muted small">From model races (one task, several models, cross-review, one merged answer) and shadow replays of PRs you shipped. Perch spots suitable coding requests and has the working agent scope and start a race automatically.</div>
      {o.automatic && <section className="card">
        {o.automatic.enabled && o.automatic.subscriptionGates?.map((g: any, i: number) => <div key={i} className="small" style={{ color: '#c90', marginBottom: 6 }}>Automatic races paused: {g.reason} {g.resumesAt ? `Available again after ${new Date(g.resumesAt).toLocaleString()}.` : 'Resumes when usage reports room.'}</div>)}
        <div className="row-flex"><h3 className="grow">Automatic races</h3>
          <button className="small" onClick={() => api.send('PUT', '/api/settings', { raceAuto: { enabled: !o.automatic.enabled } })}>{o.automatic.enabled ? 'Turn off' : 'Turn on'}</button>
        </div>
        <div className="small muted">{o.automatic.pausedByAutonomy ? 'Paused: autonomy is off' : !o.automatic.enabled ? 'Off' : o.automatic.subscriptionGates?.length ? 'Paused to preserve subscription capacity' : 'On'} · up to {o.automatic.perDay} per 24 hours · up to {o.automatic.maxConcurrent} at a time · {o.automatic.cooldownHours * 60} min between races in each chat · {o.automatic.models.map(name).join(' + ')}. Routine edits, urgent work and automated messages stay with their agent. Results return to the original chat.</div>
        {o.automatic.recent.length ? <details style={{ marginTop: 8 }}><summary className="small">Recent selection decisions ({o.automatic.recent.length})</summary>
          {o.automatic.recent.map((c: any) => <div key={c.id} className="small" style={{ marginTop: 8 }}>
            <b>{c.status === 'selected' ? 'scoping' : c.status}</b> · {c.prompt.slice(0, 160)}
            <div className="muted">Selected for: {c.reason}{c.outcome ? ` · ${c.outcome}` : ''}</div>
            {c.run_id && <button className="link small" onClick={() => setOpen(c.run_id)}>View race evidence</button>}
          </div>)}
        </details> : <div className="small muted" style={{ marginTop: 6 }}>Watching for the next suitable request.</div>}
      </section>}
      <div className="stats">
        <div className="stat"><b>{o.races}</b><span>finished races</span></div>
        <div className="stat"><b style={{ color: SIZE.overkill }}>{s.total ? pct(s.overkill / s.total) : '–'}</b><span>overkill: something cheaper was enough ({s.overkill})</span></div>
        <div className="stat"><b style={{ color: SIZE.right }}>{s.total ? pct(s.right / s.total) : '–'}</b><span>right-sized ({s.right})</span></div>
        <div className="stat"><b style={{ color: SIZE.underkill }}>{s.total ? pct(s.underkill / s.total) : '–'}</b><span>underkill: your pick wasn't enough ({s.underkill})</span></div>
      </div>

      <section className="card">
        <h3>Scoreboard</h3>
        {!o.models.length ? <div className="muted small">No finished races yet.</div> :
          <div style={{ overflowX: 'auto' }}><table className="small" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={{ textAlign: 'left' }}>Model</th><th style={R} title="Races won (the merge's pre-merge winner)">Wins</th><th style={R} title="Mean score the other models gave its work">Peer score</th><th style={R} title="Judged shippable on its own">Enough alone</th><th style={R}>Checks passed</th><th style={R}>Median time</th><th style={R}>Median cost</th><th style={R}>Median tokens</th><th style={R} title="Share of the issues it raised in reviews that the merge judged valid">Review precision</th><th style={R} title="Valid issues others found in its work">Valid issues against</th><th style={{ textAlign: 'left' }}>Size of its changes</th><th style={{ textAlign: 'left' }}>Tools it reached for</th></tr></thead>
            <tbody>{o.models.map((m: any) => <tr key={m.model}>
              <td><b>{name(m.model)}</b></td><td style={R}>{m.wins}/{m.races}</td><td style={R}>{m.peerScore?.toFixed(0) ?? '–'}</td><td style={R}>{m.enough}/{m.races}</td>
              <td style={R}>{m.checks ? `${m.checksPassed}/${m.checks}` : '–'}</td><td style={R}>{dur(m.medianMs)}</td><td style={R}>{m.model.startsWith('codex:') ? 'plan' : money(m.medianUsd)}</td><td style={R}>{m.medianTokens ? `${Math.round(m.medianTokens / 1000)}k` : '–'}</td>
              <td style={R}>{pct(m.reviewPrecision)} <span className="muted">({m.raisedValid}/{m.judged})</span></td><td style={R}>{m.against}</td>
              <td className="muted">{Object.entries(m.sizes).map(([k, n]) => `${k} ${n}`).join(' · ') || '–'}</td>
              <td className="muted ellipsis" style={{ maxWidth: 260 }} title={m.topTools.map(([k, n]: any) => `${k} ×${n}`).join(', ')}>{m.topTools.slice(0, 4).map(([k, n]: any) => `${k.replace(/^mcp__/, '')} ×${n}`).join(', ')}</td>
            </tr>)}</tbody>
          </table></div>}
        {o.models.some((m: any) => m.strengths.length || m.weaknesses.length) && <div className="grid2" style={{ marginTop: 10 }}>
          {o.models.map((m: any) => <div key={m.model}><h4 style={{ margin: '4px 0' }}>{name(m.model)}</h4>
            {m.strengths.slice(0, 5).map((x: any, i: number) => <div key={'s' + i} className="small"><span style={{ color: '#3a3' }}>➕</span> {x.text} <button className="link small muted" onClick={() => setOpen(x.race)}>race</button></div>)}
            {m.weaknesses.slice(0, 5).map((x: any, i: number) => <div key={'w' + i} className="small"><span style={{ color: '#c33' }}>➖</span> {x.text} <button className="link small muted" onClick={() => setOpen(x.race)}>race</button></div>)}
          </div>)}
        </div>}
      </section>

      <section className="card">
        <h3>Over- and underkill</h3>
        <div className="muted small">Race: the model your chat was using vs the cheapest/fastest contestant that was enough alone (30%+ cheaper or faster counts). Shadow: a cheaper model reached the same merged outcome.</div>
        {!s.items.length ? <div className="muted small">Nothing yet.</div> : s.items.map((x: any, i: number) => <div key={i} className="small" style={{ marginTop: 3 }}>
          <span style={{ color: SIZE[x.kind] }}>{x.kind}</span> · {x.source === 'race' ? <button className="link small" onClick={() => setOpen(x.id)}>race {x.id.slice(0, 8)}</button> : <a href={x.id} target="_blank" rel="noreferrer">#{x.id.split('/').pop()}</a>} · {x.text}
        </div>)}
      </section>

      <section className="card">
        <h3>Races</h3>
        <StartRace />
        {o.list.map((r: any) => <div key={r.id} style={{ borderTop: '1px solid var(--border, #333)', padding: '6px 0' }}>
          <div className="row-flex" style={{ cursor: 'pointer' }} onClick={() => setOpen(open === r.id ? null : r.id)}>
            <span className="grow small ellipsis">{open === r.id ? '▾' : '▸'} {r.task.split('\n')[0]}</span>
            <span className="small muted">{r.models.map((m: any) => name(m.model)).join(' · ')}</span>
            <span className="small" style={{ marginLeft: 8, color: r.status === 'error' ? '#c33' : r.status === 'running' ? '#58f' : undefined }}>{r.status === 'running' ? r.phase : r.status === 'done' ? `🏆 ${name(r.winner)}` : 'error'}</span>
          </div>
          {open === r.id && <RaceDetail id={r.id} />}
        </div>)}
        {open && !o.list.some((r: any) => r.id === open) && <RaceDetail id={open} />}
      </section>
    </>
  )
}

function StartRace() {
  const [show, setShow] = useState(false)
  const [f, setF] = useState({ task: '', cwd: '', models: '', verify: '' })
  const [msg, setMsg] = useState<string | null>(null)
  if (!show) return <button className="small" onClick={() => setShow(true)}>Start a race</button>
  const go = async () => {
    const r = await post<any>('/api/race', { task: f.task, cwd: f.cwd || undefined, verify: f.verify || undefined, models: f.models ? f.models.split(/[,\s]+/).filter(Boolean) : undefined })
    setMsg(r?.error ?? `Started ${r.models.map(name).join(', ')} from ${r.base}.`)
    if (!r?.error) setShow(false)
  }
  return (
    <div className="card" style={{ margin: '6px 0' }}>
      <textarea placeholder="The task, self-contained" value={f.task} onChange={e => setF({ ...f, task: e.target.value })} rows={4} style={{ width: '100%' }} />
      <div className="row-flex" style={{ gap: 6 }}>
        <input placeholder="repo path (default: your chat folder)" value={f.cwd} onChange={e => setF({ ...f, cwd: e.target.value })} className="grow" />
        <input placeholder="models (default opus, fable, codex:gpt-6-astra)" value={f.models} onChange={e => setF({ ...f, models: e.target.value })} className="grow" />
        <input placeholder="check command (optional)" value={f.verify} onChange={e => setF({ ...f, verify: e.target.value })} className="grow" />
        <button className="small" disabled={!f.task.trim()} onClick={go}>Race</button><button className="small link" onClick={() => setShow(false)}>cancel</button>
      </div>
      {msg && <div className="small muted">{msg}</div>}
    </div>
  )
}

function RaceDetail({ id }: { id: string }) {
  const { data: d } = useLive<any>(`/api/race/run?id=${id}`, ['race'])
  const [diff, setDiff] = useState<string | null>(null)
  if (!d) return <div className="muted small">…</div>
  if (d.error && !d.id) return <div className="small bad">{d.error}</div>
  const f = d.findings ?? {}
  const byId = Object.fromEntries(d.entries.map((e: any) => [e.id, e]))
  const adj = (vid: string, i: number) => (f.adjudication ?? []).find((a: any) => a.review === vid && a.issue === i)
  return (
    <div style={{ padding: '6px 0 6px 14px' }}>
      <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{d.task.slice(0, 1500)}</div>
      <div className="small muted" style={{ marginTop: 4 }}>{d.status === 'running' ? `Phase: ${d.phase}` : d.error ? <span className="bad">{d.error}</span> : <>Final: <code>{d.final_branch}</code> by {name(d.synth)}{d.final_verify ? ` · check ${d.final_verify.ok ? 'passed' : 'FAILED'}` : ''} · total {money(d.usd)}{d.report ? <> · report <code>{d.report}</code></> : null}</>}</div>
      {f.summary && <div className="small" style={{ marginTop: 4 }}>{f.summary}</div>}
      {d.sizing && <div className="small" style={{ marginTop: 4 }}><span style={{ color: SIZE[d.sizing.kind] }}>{d.sizing.kind}</span>: {d.sizing.text}</div>}
      <table className="small" style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6 }}>
        <thead><tr><th style={{ textAlign: 'left' }}>Model</th><th>Status</th><th style={R}>Rank</th><th style={R}>Peer</th><th style={R}>Check</th><th style={R}>Time</th><th style={R}>Cost</th><th style={R}>Tokens</th><th style={R}>Turns</th><th style={R}>Valid issues raised</th><th style={R}>Valid against</th><th>Enough</th><th>Size</th><th>Change</th></tr></thead>
        <tbody>{d.entries.map((e: any) => <tr key={e.id} title={e.summary ?? e.error ?? ''}>
          <td><b>{name(e.model)}</b>{f.winner === e.model ? ' 🏆' : ''}</td><td className={e.status === 'error' ? 'bad' : 'muted'}>{e.status}{e.error ? `: ${e.error.slice(0, 60)}` : ''}</td>
          <td style={R}>{e.rank ?? '–'}</td><td style={R}>{e.peerScore?.toFixed(0) ?? '–'}</td>
          <td style={R} title={e.verify?.output}>{e.verify ? <span style={{ color: e.verify.ok ? '#3a3' : '#c33' }}>{e.verify.ok ? 'pass' : 'fail'}</span> : '–'}</td>
          <td style={R}>{dur(e.duration_ms)}</td><td style={R}>{e.model.startsWith('codex:') ? 'plan' : money(e.usd)}</td><td style={R}>{e.tokens ? `${Math.round(e.tokens / 1000)}k` : '–'}</td><td style={R}>{e.turns ?? '–'}</td>
          <td style={R}>{e.issuesRaisedValid}/{e.issuesJudged}</td><td style={R}>{e.issuesAgainstValid}</td><td>{e.sufficient == null ? '–' : e.sufficient ? 'yes' : 'no'}</td><td>{e.size ?? '–'}</td>
          <td>{e.diff ? <button className="link small" onClick={() => setDiff(diff === e.id ? null : e.id)}>{e.diff_stat || 'diff'}</button> : '–'}{e.branch ? <span className="muted"> · <code>{e.branch}</code></span> : null}</td>
        </tr>)}</tbody>
      </table>
      {diff && <pre className="small" style={{ maxHeight: 400, overflow: 'auto', background: 'var(--bg2)', padding: 6 }}>{byId[diff]?.diff}</pre>}
      {d.entries.some((e: any) => e.strengths.length || e.weaknesses.length) && <div className="grid2" style={{ marginTop: 6 }}>{d.entries.map((e: any) => <div key={e.id}>
        <h4 style={{ margin: '4px 0' }}>{name(e.model)}</h4>
        {e.strengths.map((x: string, i: number) => <div key={'s' + i} className="small"><span style={{ color: '#3a3' }}>➕</span> {x}</div>)}
        {e.weaknesses.map((x: string, i: number) => <div key={'w' + i} className="small"><span style={{ color: '#c33' }}>➖</span> {x}</div>)}
        {f.taken?.[e.model]?.length ? <div className="small muted">Final took: {f.taken[e.model].join('; ')}</div> : null}
        <div className="small muted">Tools: {Object.entries(e.tools ?? {}).sort((a: any, b: any) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ×${n}`).join(', ') || '–'}</div>
      </div>)}</div>}
      {d.reviews.length > 0 && <><h4 style={{ margin: '8px 0 2px' }}>Reviews</h4>
        {d.reviews.map((v: any) => <details key={v.id} className="small">
          <summary>{name(byId[v.reviewer]?.model)} on {name(byId[v.target]?.model)}: {v.result ? `${v.result.score} · ${v.result.vs_mine} than mine · ${v.result.sufficient ? 'enough' : 'not enough'} · ${v.result.issues?.length ?? 0} issues` : v.status}{v.error ? ` (${v.error.slice(0, 80)})` : ''}</summary>
          {(v.result?.issues ?? []).map((x: any, i: number) => { const a = adj(v.id, i); return <div key={i} style={{ marginLeft: 12 }}>
            <span style={{ color: SEV[x.severity] }}>{x.severity}</span> {x.kind}{x.file ? <code> {x.file}</code> : null}: {x.claim} {a ? <b style={{ color: a.valid ? '#3a3' : '#c33' }}>{a.valid ? '✓ valid' : '✗ rejected'}</b> : <span className="muted">not adjudicated</span>}{a?.note ? <span className="muted"> ({a.note})</span> : null}
            {x.evidence ? <div className="muted" style={{ marginLeft: 12 }}>{x.evidence}</div> : null}</div> })}
          {v.result?.strengths?.length ? <div style={{ marginLeft: 12 }} className="muted">Better than mine: {v.result.strengths.join('; ')}</div> : null}
        </details>)}</>}
      {f.lessons?.length ? <><h4 style={{ margin: '8px 0 2px' }}>Lessons</h4>{f.lessons.map((l: string, i: number) => <div key={i} className="small">• {l}</div>)}</> : null}
    </div>
  )
}
