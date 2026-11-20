// Evolve: every ask you make to agents, grouped into the jobs you keep handing them, with the
// skills perch wrote for those jobs (and how each is doing), work agents dropped, and a journal of
// what perch changed on its own.
import { useState } from 'react'
import { ago, api, post, useLive } from './api'

type UseCase = { id: string; name: string; description: string; status: string; covered_by: string | null; n: number; corrected: number | null; convs: number; last: number | null; recent: string[]; dropped: number; skill: { id: string; name: string; version: number } | null }
type Skill = { id: string; name: string; use_case: string | null; version: number; status: string; reason: string; updated_at: number; asked: number; loaded: number; turns: number; corrected: number; versions: { version: number; reason: string; at: number }[] }
type Dropped = { id: string; title: string; updated_at: number; stall: string | null; asks: number; status: string | null; source: string; last_ask: string; use_case: string | null; ours: number | null }
type Overview = {
  status: { running: boolean; step: string; lastRun: number; error: string }
  settings: { enabled: boolean; forge: boolean; tune: boolean; resume: boolean }
  totals: { asks: number; corrected: number; conversations: number; useCases: number; skills: number }
  byIntent: { intent: string; n: number; c: number }[]
  useCases: UseCase[]; skills: Skill[]; dropped: Dropped[]
  wishes: { kind: string; need: string; would_help: string; conversation_id: string | null; created_at: number }[]
  log: { at: number; kind: string; text: string }[]
}

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '–')
const why = (d: Dropped) => d.status === 'failed' ? 'task failed' : d.stall ? `stalled: ${d.stall}` : d.asks ? 'asked you something, no answer' : 'went quiet'

export function Evolve({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, reload } = useLive<Overview>('/api/evolve', ['evolve', 'conversations'])
  const [busy, setBusy] = useState<string | null>(null)
  const [openSkill, setOpenSkill] = useState<string | null>(null)
  if (!data) return <div className="pad muted">…</div>
  const act = async (key: string, path: string, body?: any) => { setBusy(key); try { await post(path, body) } finally { setBusy(null); reload() } }
  const toggle = (k: 'enabled' | 'forge' | 'tune' | 'resume') => api.send('PUT', '/api/settings', { evolve: { ...data.settings, [k]: !data.settings[k] } }).then(reload)
  const s = data.status
  return (
    <div className="page">
      <div className="row-flex">
        <h2 className="grow">Evolve</h2>
        <span className="muted small">{s.running ? `${s.step || 'working'}…` : s.lastRun ? `last looked ${ago(s.lastRun)} ago` : 'looks every 4 hours'}</span>
        <button disabled={s.running} onClick={() => act('run', '/api/evolve/run')}>{s.running ? 'Working…' : 'Look now'}</button>
      </div>
      <div className="muted small">Mothership reads every ask you make to agents, groups them into the jobs you keep handing over, and writes a skill (perch-*) for each job you come back to. It watches each skill afterwards: it rewrites the ones agents don't load or get corrected on, and retires the ones nobody needs. Autopilot turns the same use cases into scheduled jobs.</div>
      <div className="row-flex small">
        {(['enabled', 'forge', 'tune', 'resume'] as const).map(k => (
          <label key={k}><input type="checkbox" checked={data.settings[k]} onChange={() => toggle(k)} /> {{ enabled: 'Always on', forge: 'Write new skills', tune: 'Tune and retire skills', resume: 'Resume dropped work' }[k]}</label>
        ))}
      </div>
      {s.error && <div className="bad small">{s.error}</div>}

      <div className="stats">
        <div className="stat"><b>{data.totals.asks}</b><span>asks, 30 days</span></div>
        <div className="stat"><b>{data.totals.conversations}</b><span>conversations</span></div>
        <div className="stat"><b>{pct(data.totals.corrected, data.totals.asks)}</b><span>corrected</span></div>
        <div className="stat"><b>{data.totals.useCases}</b><span>use cases</span></div>
        <div className="stat"><b>{data.totals.skills}</b><span>skills Mothership made</span></div>
        <div className="stat"><b>{data.dropped.length}</b><span>dropped</span></div>
      </div>

      <section className="card">
        <div className="card-head"><h3>Use cases</h3><span className="muted small">the jobs you hand to agents, last 30 days</span></div>
        {!data.useCases.length && <div className="muted small">Nothing grouped yet. “Look now” reads your conversations and groups your asks.</div>}
        <table className="evolve-table">
          <thead><tr><th>Job</th><th>Asks</th><th>Corrected</th><th>Dropped</th><th>Covered by</th><th /></tr></thead>
          <tbody>{data.useCases.map(u => (
            <tr key={u.id}>
              <td><b>{u.name}</b><div className="muted small">{u.description}</div>
                <div className="small">{u.recent.slice(0, 4).map(id => <button key={id} className="link small" onClick={() => onOpen(id)}>open</button>)}</div></td>
              <td>{u.n}<span className="muted small"> in {u.convs}</span></td>
              <td className={(u.corrected ?? 0) / Math.max(1, u.n) >= 0.3 ? 'bad' : ''}>{pct(u.corrected ?? 0, u.n)}</td>
              <td className={u.dropped ? 'bad' : ''}>{u.dropped || '–'}</td>
              <td className="small">{u.skill ? <span className="chip ok">{u.skill.name} v{u.skill.version}</span> : u.covered_by ? <span className="chip">{u.covered_by}</span> : <span className="muted">nothing</span>}</td>
              <td className="small">
                {!u.skill && <button disabled={busy === u.id} onClick={() => act(u.id, `/api/evolve/usecase/${u.id}/forge`)}>{busy === u.id ? 'Writing…' : 'Make skill'}</button>}
                {u.status !== 'ignored' && !u.skill && <button className="link small" onClick={() => act(`i${u.id}`, `/api/evolve/usecase/${u.id}/ignore`)}>ignore</button>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </section>

      <section className="card">
        <div className="card-head"><h3>Skills Mothership made</h3><span className="muted small">installed in your Claude skills folder; every agent can load them</span></div>
        {!data.skills.length && <div className="muted small">None yet. A job you ask for 3+ times in 3+ conversations, with no skill behind it, gets one.</div>}
        {data.skills.map(k => (
          <div key={k.id} className="sugg">
            <div className="sugg-head">
              <span className={`chip ${k.status === 'live' ? 'ok' : ''}`}>{k.status}</span>
              <b className="sugg-title">{k.name}</b><span className="muted small">v{k.version} · {k.use_case}</span>
            </div>
            <div className="small">Since this version: job asked {k.asked}×, skill loaded in {k.loaded} sessions{k.turns ? `, ${pct(k.corrected, k.turns)} of those turns corrected` : ''}.</div>
            <div className="muted small">{k.reason} · {ago(k.updated_at)} ago</div>
            <div className="sugg-actions">
              {k.status === 'live' ? <button onClick={() => act(k.id, `/api/evolve/skill/${k.id}/retire`)}>Retire</button> : <button onClick={() => act(k.id, `/api/evolve/skill/${k.id}/restore`)}>Restore</button>}
              {k.versions.length > 1 && <button className="link small" onClick={() => setOpenSkill(openSkill === k.id ? null : k.id)}>history</button>}
            </div>
            {openSkill === k.id && k.versions.map(v => (
              <div key={v.version} className="small row-flex">
                <span className="grow">v{v.version}: {v.reason} <span className="muted">({ago(v.at)} ago)</span></span>
                {v.version !== k.version && <button className="link small" onClick={() => act(k.id, `/api/evolve/skill/${k.id}/rollback`, { version: v.version })}>roll back to this</button>}
              </div>
            ))}
          </div>
        ))}
      </section>

      <section className="card">
        <div className="card-head"><h3>Dropped work</h3><span className="muted small">{data.settings.resume ? 'Mothership resumes its own sessions automatically, once each; terminal sessions wait for you' : 'agents that stopped before the job was done, and nobody came back'}</span></div>
        {!data.dropped.length && <div className="muted small">Nothing dropped in the last two weeks.</div>}
        {data.dropped.map(d => (
          <div key={d.id} className="sugg">
            <div className="sugg-head"><span className="chip">{why(d)}</span><b className="sugg-title ellipsis">{d.title}</b><span className="muted small">{ago(d.updated_at)} ago</span></div>
            <div className="muted small ellipsis">Last ask: {d.last_ask}{d.use_case ? ` · ${d.use_case}` : ''}</div>
            <div className="sugg-actions">
              <button onClick={() => onOpen(d.id)}>Open</button>
              {d.source !== 'posthog-task' && <button className="primary" disabled={busy === d.id} onClick={() => act(d.id, `/api/evolve/resume/${encodeURIComponent(d.id)}`)} title="The agent checks where things stand and finishes, or says what blocks it">Resume</button>}
            </div>
          </div>
        ))}
      </section>

      <section className="card">
        <div className="card-head"><h3>What agents wished they had</h3></div>
        {!data.wishes.length && <div className="muted small">No wishes logged yet.</div>}
        {data.wishes.map((w, i) => (
          <div key={i} className="small"><span className="chip">{w.kind}</span> {w.need}{w.would_help ? <span className="muted"> · {w.would_help}</span> : null}
            {w.conversation_id && <button className="link small" onClick={() => onOpen(w.conversation_id!)}>open</button>}</div>
        ))}
      </section>

      <section className="card">
        <div className="card-head"><h3>Journal</h3><span className="muted small">what Mothership did on its own</span></div>
        {data.log.map((l, i) => <div key={i} className="small"><span className="muted">{ago(l.at)} ago</span> <span className={`chip ${l.kind === 'error' ? 'bad' : ''}`}>{l.kind}</span> {l.text}</div>)}
      </section>
    </div>
  )
}
