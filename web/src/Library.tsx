import { useState } from 'react'
import { ago, api, humanCron, post, useLive } from './api'
import { useProfiles } from './Profile'
import { ScoutTable } from './ScoutTimetable'

export function Library() {
  const [tab, setTab] = useState<'skills' | 'scouts'>('skills')
  const st = useLive<any>('/api/status', ['status']).data
  // The skill store and scouts live in PostHog. Without a key, say so once instead of showing errors.
  if (st && !st.posthog?.hasKey) return (
    <div className="page">
      <section className="card">
        <h3>Skill store and scouts</h3>
        <div className="muted small">These come from PostHog: a shared store of agent skills, and scouts that run on a schedule in PostHog's cloud. Add a PostHog personal API key in Settings → Connections to use them. Your own skills in ~/.claude/skills work in every chat either way.</div>
      </section>
    </div>
  )
  return (
    <div className="page">
      <div className="tabs">
        <button className={tab === 'skills' ? 'on' : ''} onClick={() => setTab('skills')}>Skill store</button>
        <button className={tab === 'scouts' ? 'on' : ''} onClick={() => setTab('scouts')}>Scouts</button>
      </div>
      {tab === 'skills' ? <Skills /> : <Scouts />}
    </div>
  )
}

const NeedsKey = ({ error }: { error: string }) => (
  <div className="card muted">{/API key/.test(error) ? 'Add a PostHog personal API key in Settings to browse this.' : error}</div>
)

function Skills() {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState('new')
  const [days, setDays] = useState(30)
  const [mine, setMine] = useState<'' | 'created' | 'owned'>('')
  const [open, setOpen] = useState<string | null>(null)
  const [asked, setAsked] = useState<{ q: string; results: any[] } | null>(null)
  const [asking, setAsking] = useState(false)
  const params = new URLSearchParams({ q, sort, days: String(days), mine })
  const { data, error } = useLive<any>(`/api/skills?${params}`)
  const [store, setStore] = useState<{ busy?: boolean; ok?: boolean; message?: string; action?: string; needsPaste?: boolean } | null>(null)
  const [pasted, setPasted] = useState('')
  // The filter applies to Ask's picks too.
  const results: any[] = (asked?.results ?? data?.results ?? []).filter((s: any) => !asked || !mine || s.mine || (mine === 'owned' && s.coowned))
  const ask = async () => { if (!q.trim()) return; setAsking(true); const r = await post('/api/skills/ask', { question: q }); setAsked({ q, results: r.results ?? [] }); setAsking(false) }
  return (
    <>
      <div className="row-flex">
        <input className="grow" placeholder="Search skills, or describe what you want and Ask" value={q} onChange={e => { setQ(e.target.value); setAsked(null) }}
          onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) ask() }} />
        <button onClick={ask} disabled={asking || !q.trim()} title="Claude reads the whole catalogue and picks what fits  ⌘↵">{asking ? 'Asking…' : '✦ Ask'}</button>
      </div>
      <div className="row-flex">
        <div className="seg">
          {[['new', 'New'], ['updated', 'Updated'], ['top', 'Top (mine)'], ['name', 'A–Z']].map(([k, l]) => <button key={k} className={sort === k && !asked ? 'on' : ''} onClick={() => { setSort(k); setAsked(null) }}>{l}</button>)}
        </div>
        {sort === 'top' && <select value={days} onChange={e => setDays(Number(e.target.value))}>{[[7, 'this week'], [30, 'this month'], [365, 'this year'], [0, 'all time']].map(([d, l]) => <option key={d} value={d}>{l}</option>)}</select>}
        <select value={mine} onChange={e => setMine(e.target.value as any)} title="Whose skills">
          <option value="">everyone’s</option><option value="created">mine (created by me)</option><option value="owned">mine + co-owned</option>
        </select>
        <span className="grow" />
        <span className="muted small">{asked ? `${results.length} picked by Claude` : data?.total ? `${results.length} of ${data.total}` : ''}</span>
        <button disabled={store?.busy} title="Adds the whole PostHog skill store to Claude Code as a plugin" onClick={async () => {
          setStore({ busy: true, message: 'Installing the skill store in Claude Code…' })
          setStore(await post('/api/skills-store/install'))
        }}>{store?.busy ? 'Installing…' : 'Install store in Claude Code'}</button>
      </div>
      {store && (
        <div className={`card notice ${store.ok ? 'ok' : store.busy ? '' : 'warn-box'}`}>
          <b>{store.message}</b>{store.action && <span className="small">{store.action}</span>}
          {store.needsPaste && (
            <div className="row-flex">
              <input className="grow" value={pasted} placeholder="/plugin marketplace add https://x-access-token:…" onChange={e => setPasted(e.target.value)} />
              <button className="primary" disabled={!pasted.trim()} onClick={async () => { setStore({ busy: true, message: 'Installing…' }); setStore(await post('/api/skills-store/install-pasted', { command: pasted })) }}>Run it</button>
            </div>
          )}
        </div>
      )}
      {error && <NeedsKey error={error} />}
      <div className="muted small">“Top” counts how often you used each skill in your own transcripts. Org-wide usage lives in PostHog's MCP analytics.</div>
      <div className="grid">
        {results.map(s => (
          <div key={s.name} className={`card skill ${open === s.name ? 'open' : ''}`} onClick={() => setOpen(open === s.name ? null : s.name)}>
            <div className="row-flex"><b className="grow">{s.name}</b>{s.mine && <span className="chip ok">mine</span>}{s.coowned && <span className="chip" title="Someone else created it; you are an owner">co-owner</span>}{s.category && <span className="chip">{s.category}</span>}</div>
            <div className="muted small clamp">{s.why ?? s.description}</div>
            <div className="muted small">{s.my_uses ? `used ${s.my_uses}× · ` : ''}{s.updated_at ? `updated ${ago(Date.parse(s.updated_at))} ago` : ''}</div>
            {open === s.name && <SkillDetail name={s.name} />}
          </div>
        ))}
      </div>
      {!data && !error && <div className="muted small">Loading the catalogue…</div>}
      {data && !results.length && !error && <div className="muted">{sort === 'top' && !asked ? 'You haven’t used any store skills in this window. Try a longer one, or another sort.' : 'No skills match. Try ✦ Ask with a description.'}</div>}
    </>
  )
}

function SkillDetail({ name }: { name: string }) {
  const { data } = useLive<any>(`/api/skills/${encodeURIComponent(name)}`)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const { data: profs } = useProfiles()
  return (
    <div className="skill-detail" onClick={e => e.stopPropagation()}>
      <div className="row-flex">
        <button className="primary" disabled={busy} onClick={async () => {
          setBusy(true)
          const r = await post(`/api/skills/${encodeURIComponent(name)}/install`)
          setBusy(false)
          setMsg(r.installed ? { text: r.message, ok: true } : { text: `${r.error ?? 'Couldn’t install it.'} ${r.action ?? ''}`, ok: false })
        }}>{busy ? 'Installing…' : 'Install for Claude Code'}</button>
        {/* Into your other profile's Claude (e.g. Personal, which can't reach this store). */}
        {(profs?.profiles ?? []).filter(p => p.id !== profs?.current).map(p => (
          <button key={p.id} disabled={busy} title={`Install this skill in ${p.label}'s Claude Code: only the skill's files are copied`} onClick={async () => {
            setBusy(true)
            const r = await post<any>(`/api/skills/${encodeURIComponent(name)}/carry`, { to: p.id })
            setBusy(false)
            setMsg(r.installed ? { text: r.message, ok: true } : { text: r.error ?? 'Couldn’t copy it.', ok: false })
          }}>↪ Copy to {p.label}</button>
        ))}
        {msg && <span className={`small ${msg.ok ? 'ok-text' : 'bad'}`}>{msg.text}</span>}
      </div>
      {data?.files?.length > 0 && <div className="muted small">{data.files.length} bundled files: {data.files.slice(0, 6).map((f: any) => f.path).join(', ')}{data.files.length > 6 ? '…' : ''}</div>}
      <pre className="small">{(data?.body ?? '').slice(0, 6000) || 'Loading…'}</pre>
    </div>
  )
}

function Scouts() {
  const [q, setQ] = useState('')
  const [mine, setMine] = useState(true)
  const [sort, setSort] = useState('cadence')
  const { data, error, reload } = useLive<any>(`/api/scouts?${new URLSearchParams({ q, mine: mine ? '1' : '', sort: sort === 'cadence' ? 'recent' : sort })}`)
  const { data: runs } = useLive<any>('/api/scouts/runs')
  const configs: any[] = data?.results ?? []
  // Cost over the last 7 days for the scouts on screen (PostHog-side spend on their runs).
  const skillList = configs.map(c => c.skill_name).filter(Boolean).sort().join(',')
  const { data: spend } = useLive<any>(skillList ? `/api/scouts/spend?${new URLSearchParams({ skills: skillList, days: '7' })}` : null)
  const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString()}`
  const cost = (c: any) => spend?.by_skill?.[c.skill_name]
  // With "mine" on, only runs of the scouts listed above (yours), not the whole team's.
  const mineSkills = new Set(configs.map(c => c.skill_name))
  const runList: any[] = (Array.isArray(runs) ? runs : runs?.results ?? []).filter((r: any) => !mine || mineSkills.has(r.skill_name))
  const openRun = (r: any) => r.perch_id ? window.dispatchEvent(new CustomEvent('perch-open', { detail: r.perch_id })) : r.posthog_url && window.open(r.posthog_url, '_blank')
  const [msg, setMsg] = useState<Record<string, string>>({})
  return (
    <>
      <div className="row-flex">
        <input className="grow" placeholder="Search scouts" value={q} onChange={e => setQ(e.target.value)} />
        <div className="seg">{[['cadence', 'Every'], ['recent', 'Last run'], ['new', 'New'], ['name', 'A–Z'], ['cost', 'Cost']].map(([k, l]) => <button key={k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>{l}</button>)}</div>
        <label className="toggle"><input type="checkbox" checked={mine} onChange={e => setMine(e.target.checked)} /> mine</label>
      </div>
      <div className="muted small">Scouts run in PostHog's cloud on their own schedule, so they keep going while your laptop sleeps. Routines (under Automations) run here.</div>
      {error && <NeedsKey error={error} />}
      {spend && configs.length > 0 && <div className="small"><b>{usd(spend.total_usd)}</b> <span className="muted">spent by {mine ? 'your' : 'these'} {configs.length} scouts in the last 7 days</span></div>}
      {(configs.length > 0 || (mine && !q)) && (
        <ScoutTable
          scouts={sort === 'cost' ? [...configs].sort((a, b) => (cost(b)?.usd ?? 0) - (cost(a)?.usd ?? 0)) : configs}
          sortByCadence={sort === 'cadence'} runs={runList} showRoutines={mine && !q}
          cost={c => cost(c) && { label: usd(cost(c).usd), title: `${cost(c).runs} runs in the last 7 days${cost(c).untracked > 0 ? `, ${cost(c).untracked} without spend data` : ''}` }}
          msg={msg} onRun={async c => { const r = await post(`/api/scouts/${c.id}/run`); setMsg({ ...msg, [c.id]: r.error ?? 'started' }); reload() }}
          onOpenRun={openRun} />
      )}
      {data && !configs.length && !error && <div className="muted small">{mine ? 'No scouts of yours. Untick “mine” to see the team’s.' : 'No scouts match.'}</div>}
    </>
  )
}
