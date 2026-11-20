// AI spend across every account, at API prices: perch chats (yours and its automations), terminal
// Claude Code, Claude Desktop, PostHog Code, and your PostHog scouts in the cloud.
import { useEffect, useState } from 'react'
import { ago, post, useLive } from './api'
import { Viz } from './Viz'
import { PrSpendTimeline } from './PrSpendTimeline'

const money = (n: number) => n < 0.01 ? (n ? '<$0.01' : '$0') : n >= 1000 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(2)}`
const tok = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(0)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n)
const model = (m: string) => {
  const c = m.match(/^claude-(opus|sonnet|haiku|fable|mythos)-([\d-]+)/)
  return c ? `${c[1][0].toUpperCase()}${c[1].slice(1)} ${c[2].replace(/-/g, '.')}` : m.replace(/:latest$/, '')
}
const isLocalM = (m: string) => !/^(claude-|opus|sonnet|haiku|fable|mythos)/.test(m)
const mname = (m: string) => isLocalM(m) ? `${model(m)} (local)` : model(m)
const dur = (ms?: number | null) => !ms ? '–' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`
const ratio = (r?: number | null) => r == null ? '–' : r < 1 ? `−${Math.round((1 - r) * 100)}%` : `+${Math.round((r - 1) * 100)}%`
const OUT: Record<string, string> = { same: 'var(--green, #3a3)', partial: 'var(--yellow, #c90)', different: 'var(--red, #c33)' }
const VERDICT: Record<string, [string, string]> = { cheaper: ['could be cheaper', '#3a3'], 'right-cost': ['right cost', '#888'], inconclusive: ['inconclusive', '#c90'], 'matches-control': ['matches control', '#7a3'], running: ['replaying…', '#58f'], error: ['failed', '#c33'] }
const SRC = ['perch', 'terminal', 'desktop', 'posthog-code']
const NAME: Record<string, string> = { perch: 'Mothership', terminal: 'Terminal', desktop: 'Desktop', 'posthog-code': 'PostHog Code', scouts: 'Scouts' }

function Row({ label, cost, extra, href }: { label: string; cost: number; extra?: string; href?: string }) {
  const body = <><span className="grow ellipsis" title={label}>{label}</span>{extra != null && <span className="muted">{extra}</span>}<b>{money(cost)}</b></>
  return href ? <a className="usage-row small" href={href}>{body}</a> : <div className="usage-row small">{body}</div>
}

export function SpendCard() {
  const [days, setDays] = useState(30)
  const [sub, setSub] = useState('') // '' = every subscription; otherwise a subscription id (Team, Personal)
  const { data: u, reload } = useLive<any>(`/api/spend?days=${days}${sub ? `&subscription=${sub}` : ''}`, ['chats'])
  const subName = sub ? (u?.subscriptions?.find((x: any) => x.id === sub)?.label ?? sub) : ''
  return (
    <section className="card">
      <div className="row-flex"><h3 className="grow">AI spend</h3>
        <button onClick={async () => { await post('/api/spend/rescan'); setTimeout(reload, 8000) }}>Rescan</button>
        <select aria-label="Subscription" value={sub} onChange={e => setSub(e.target.value)}>
          <option value="">All subscriptions</option>{(u?.subscriptions ?? []).map((x: any) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
        <select value={days} onChange={e => setDays(Number(e.target.value))}>{[1, 7, 30, 90, 365].map(d => <option key={d} value={d}>{d === 1 ? 'today' : `${d} days`}</option>)}</select></div>
      <div className="muted small">What everything you run would cost at API prices, per Claude subscription (Team, Personal) and per account: Mothership, Claude Code in a terminal or Desktop, PostHog Code, and your PostHog scouts. Subscriptions aren't billed per token, so this is the value you get from them and where it goes.</div>
      {!u ? <div className="muted small">…</div> : (
        <>
          <div className="stats">
            <div className="stat"><b>{money(u.cost)}</b><span>{sub ? subName : 'all subscriptions'}, {days === 1 ? 'today' : `${days} days`}</span></div>
            {!sub && u.subscriptions.map((x: any) => (
              <div key={x.id} className="stat" role="button" tabIndex={0} style={{ cursor: 'pointer' }} title={`Show only ${x.label}`}
                onClick={() => setSub(x.id)} onKeyDown={e => e.key === 'Enter' && setSub(x.id)}>
                <b>{money(x.cost)}</b><span>{x.label} · {tok(x.tokens)} tokens</span>
              </div>
            ))}
          </div>
          {u.accounts.filter((a: any) => a.cost > 0).map((a: any) => (
            <div key={a.id}>
              <div className="section-head" style={{ color: a.color }}>{a.label}</div>
              {days > 1 && <Viz spec={{
                type: 'area', stack: true, unit: 'USD', title: 'Per day, by where it ran (scouts not included)',
                series: SRC.filter(k => a.daily.some((d: any) => d[k])).map(k => ({ name: NAME[k], points: a.daily.map((d: any) => [Math.round(d.day / 1000), d[k] ?? 0] as [number, number]) })),
              }} />}
              <div className="usage-cols">
                <div><h4>Where it ran</h4>
                  {a.sources.map((s: any) => <Row key={s.source} label={s.label} cost={s.cost} extra={s.source === 'scouts' ? `${s.msgs} runs` : `${s.msgs.toLocaleString()} calls`} />)}
                  {a.subagentCost > 0 && <div className="muted small">{money(a.subagentCost)} of it in subagents</div>}
                </div>
                {a.perchBy.length > 0 && <div><h4>Mothership: who started it</h4>{a.perchBy.map((b: any) => <Row key={b.by} label={b.by === 'you' ? 'You' : b.by} cost={b.cost} />)}</div>}
                <div><h4>By model</h4>{a.models.filter((m: any) => m.cost > 0).map((m: any) => <Row key={m.model} label={model(m.model)} cost={m.cost} extra={tok(m.tokens)} />)}</div>
                <div><h4>By project</h4>{a.projects.map((p: any) => <Row key={p.project} label={p.project} cost={p.cost} />)}</div>
                <div><h4>Costliest sessions</h4>{a.sessions.map((s: any) => <Row key={s.id} label={s.title} cost={s.cost} extra={NAME[s.source] ?? s.source} href={`#chat/${encodeURIComponent(s.id)}`} />)}</div>
                {(a.scouts.length > 0 || a.scoutsError) && <div><h4>Scouts</h4>
                  {a.scouts.map((s: any) => <Row key={s.skill} label={s.name} cost={s.usd} extra={`${s.runs} runs`} />)}
                  {a.scoutsUntracked > 0 && <div className="muted small">{a.scoutsUntracked} runs reported no spend</div>}
                  {a.scoutsError && !a.scouts.length && <div className="muted small">Couldn't read scouts: {a.scoutsError}</div>}
                </div>}
              </div>
            </div>
          ))}
          <div className="muted small">
            {u.scan.running ? 'Reading transcripts… ' : u.scan.at ? `Transcripts read ${ago(u.scan.at)} ago (${u.scan.files} files). ` : 'The first read of transcripts starts shortly after launch. '}
            {u.oldest ? `History from ${new Date(u.oldest).toLocaleDateString()}, kept even after Claude Code prunes old transcripts. ` : ''}
            Not included: claude.ai chats, and PostHog cloud tasks other than scouts.
          </div>
        </>
      )}
    </section>
  )
}

// Per PR: what each of your PRs cost, from investigation to verified in production, with averages
// per stage and a drilldown into every chat, review and scout run that went into one PR.
const BUCKETS: [string, string, string][] = [
  ['investigate', 'Investigate', '#8b7cf6'], ['write', 'Write', '#3b82f6'], ['shepherd', 'Shepherd', '#14b8a6'],
  ['review', 'Review bots', '#f59e0b'], ['validate', 'Prod verify', '#22c55e'], ['monitor', 'Other scouts', '#94a3b8']]
const CLOUD = new Set(['review', 'validate', 'monitor']) // filled from PostHog, not local transcripts
const COLOR = Object.fromEntries(BUCKETS.map(([k, , c]) => [k, c]))
const LABEL = Object.fromEntries(BUCKETS.map(([k, l]) => [k, l]))
const R = { textAlign: 'right' as const }

function StackBar({ buckets, total, height = 8 }: { buckets: any; total: number; height?: number }) {
  return <div style={{ display: 'flex', height, borderRadius: 3, overflow: 'hidden', background: 'var(--bg3)' }}>
    {BUCKETS.map(([k]) => buckets[k]?.usd > 0 && <div key={k} title={`${LABEL[k]} ${money(buckets[k].usd)}`} style={{ width: `${(buckets[k].usd / total) * 100}%`, background: COLOR[k] }} />)}
  </div>
}

function PrDetail({ url, days }: { url: string; days: number }) {
  const [allHistory, setAllHistory] = useState(true)
  const { data: d, error, reload } = useLive<any>(`/api/spend/pr?url=${encodeURIComponent(url)}&days=${allHistory ? 'all' : days}&timeline=1`, ['chats'], undefined, 60_000)
  return (
    <div style={{ padding: '8px 4px 14px', width: 'calc(100cqw - 12px)', maxWidth: '100%', boxSizing: 'border-box' }}>
      <div className="row-flex small" style={{ marginBottom: 8 }}>
        <span className="grow muted">{allHistory ? 'All recorded history for this PR' : `Spend in the last ${days} days`}{d ? ` · ${money(d.total)}` : ''}</span>
        <select aria-label="PR spend history period" value={allHistory ? 'all' : 'window'} onChange={e => setAllHistory(e.target.value === 'all')}>
          <option value="all">All history</option><option value="window">Last {days} days</option>
        </select>
      </div>
      {error && <div className="small bad">Couldn't load spend history: {error} <button onClick={reload}>Retry</button></div>}
      {!d ? <div className="muted small pad">Loading spend history…</div> : <>
      <PrSpendTimeline key={`${url}:${allHistory}:${days}`} timeline={d.timeline} stages={BUCKETS} untimedUsd={d.untimedUsd} />
      {d.cloudError && <div className="muted small" title={d.cloudError}>Cloud review and scout spend couldn't be loaded. This history includes the available recorded spend.</div>}
      <StackBar buckets={d.buckets} total={d.total} height={12} />
      <div className="row-flex small" style={{ gap: 14, flexWrap: 'wrap', margin: '6px 0 10px' }}>
        {BUCKETS.filter(([k]) => d.buckets[k]).map(([k, l, c]) => <span key={k}><span style={{ color: c }}>■</span> {l} <b>{money(d.buckets[k].usd)}</b> <span className="muted">{Math.round(d.buckets[k].usd / d.total * 100)}% · {d.buckets[k].n} {d.buckets[k].n === 1 ? 'item' : 'items'} · {tok(Math.round(d.buckets[k].tokens))} tok{d.buckets[k].ms ? ` · ${dur(d.buckets[k].ms)} agent time` : ''}</span></span>)}
        <a href={d.url} target="_blank" rel="noreferrer">Open on GitHub ↗</a>
      </div>
      {BUCKETS.filter(([k]) => d.buckets[k]).map(([k, l, c]) => (
        <div key={k} style={{ marginBottom: 8 }}>
          <div className="section-head" style={{ color: c }}>{l}</div>
          {d.items.filter((i: any) => i.bucket === k).sort((a: any, b: any) => b.usd - a.usd).map((i: any, n: number) => {
            const body = <>
              <span className="muted" style={{ width: 92, flex: 'none' }}>{i.at ? new Date(i.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</span>
              <span className="grow ellipsis" title={i.label}>{i.label}</span>
              <span className="muted ellipsis" style={{ maxWidth: '45%' }} title={i.detail}>{i.detail}</span>
              <span className="muted" style={{ width: 56, flex: 'none', ...R }} title={i.wallMs ? `${dur(i.wallMs)} first to last call` : undefined}>{i.ms ? dur(i.ms) : ''}</span>
              <b style={{ width: 64, ...R }}>{money(i.usd)}</b></>
            return i.href ? <a key={i.id + n} className="usage-row small" href={i.href}>{body}</a> : <div key={i.id + n} className="usage-row small">{body}</div>
          })}
        </div>
      ))}
      <ShadowPanel url={d.url ?? url} />
      </>}
    </div>
  )
}

// Shadow mode: the PR's writing chat replayed on other models, judged against what merged.
function ShadowPanel({ url }: { url: string }) {
  const { data: s } = useLive<any>(`/api/shadow/pr?url=${encodeURIComponent(url)}`, ['shadow'])
  const [err, setErr] = useState<string | null>(null)
  const go = async () => { setErr(null); const r = await post<any>('/api/shadow/run', { url }); if (r?.error) setErr(r.error) }
  const o = s?.run?.original, v = s?.verdict
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--bg3)', paddingTop: 8 }}>
      <div className="row-flex small"><div className="section-head grow">Shadow mode: same outcome for less?</div>
        {v && VERDICT[v.kind] && <span style={{ color: VERDICT[v.kind][1] }}>{VERDICT[v.kind][0]}</span>}
        <button className="small" disabled={v?.kind === 'running'} onClick={go}>{s?.run ? 'Run again' : 'Run shadow test'}</button></div>
      {err && <div className="small" style={{ color: '#c33' }}>{err}</div>}
      {!s?.run ? <div className="muted small">Replays the chat that wrote this PR on the original model (control), cheaper ones and your local models (free; run one at a time), in parallel worktrees at the PR's base commit, then a judge compares each diff with what merged.</div> : <>
        {v && <div className="small" style={{ margin: '4px 0' }}>{v.text}</div>}
        {o?.mode && <div className="muted small">{o.mode === 'fork' ? `Same context: each model continues the original conversation from just before its first code change (${o.checkpoint?.reason?.slice(0, 80) ?? ''}), compared with what the original spent from there.` : `Isolated: each model gets your messages${o.fetchedChars ? ' plus what the original read from Slack, GitHub and monitoring' : ''}, no conversation history.`} Judged against the PR {(o.judgedAgainst ?? []).join('; ') || 'as merged'}.</div>}
        {s.run.error && <div className="small" style={{ color: '#c33' }}>{s.run.error}</div>}
        <table className="small" style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={{ textAlign: 'left' }}>Model</th><th style={{ textAlign: 'left' }}>Outcome</th><th style={R}>Cost</th><th style={R}>vs original</th><th style={R}>Time</th><th style={R}>vs original</th><th style={R}>Turns</th><th style={{ textAlign: 'left' }}>Judge</th></tr></thead>
          <tbody>
            {o && <tr><td><b>Original</b> <span className="muted">{o.model ? model(o.model) : ''}</span></td><td>merged</td><td style={R}>{money(o.write.usd)}</td><td style={R}>·</td><td style={R} title={`${dur(o.write.wallMs)} first to last call`}>{dur(o.write.activeMs)}</td><td style={R}>·</td><td /><td className="muted ellipsis" style={{ maxWidth: 260 }} title={o.writeLabel}>{o.writeLabel}</td></tr>}
            {s.trials.map((t: any) => <tr key={t.id}>
              <td>{mname(t.model)}{t.control ? <span className="muted"> (control)</span> : ''}{o?.mode === 'fork' && t.mode === 'brief' ? <span className="muted" title="The forked conversation didn't fit this model's context window, so it got the rebuilt brief"> (brief)</span> : ''}</td>
              <td style={{ color: OUT[t.outcome] }}>{t.status === 'done' ? `${t.outcome} · ${t.score}` : t.status === 'error' ? <span style={{ color: '#c33' }} title={t.error}>error</span> : t.status === 'skipped' ? <span className="muted" title={t.error}>didn't fit</span> : t.status}</td>
              <td style={R}>{t.usd == null ? '…' : t.usd === 0 && isLocalM(t.model) ? 'free' : money(t.usd)}</td><td style={R}>{ratio(t.costRatio)}</td>
              <td style={R}>{dur(t.duration_ms)}</td><td style={R}>{ratio(t.timeRatio)}</td><td style={R}>{t.turns ?? ''}</td>
              <td className="muted ellipsis" style={{ maxWidth: 260 }} title={[t.judge?.why, t.summary ? `Replay said: ${t.summary}` : '', t.judge?.missing?.length ? `Missing: ${t.judge.missing.join('; ')}` : '', t.diff_stat, t.error].filter(Boolean).join('\n')}>{t.judge?.why ?? t.error ?? t.diff_stat ?? ''}</td>
            </tr>)}
          </tbody>
        </table>
        {o && <div className="muted small" style={{ marginTop: 4 }}>Whole PR: {money(o.total)}, {dur(o.totalMs)} agent time over {Object.keys(o.stages).length} stages ({Object.entries(o.stages).map(([k, x]: any) => `${LABEL[k] ?? k} ${money(x.usd)}${x.activeMs ? ` / ${dur(x.activeMs)}` : ''}`).join(', ')}). {o.prs?.length > 1 ? `The chat that wrote this opened ${o.prs.length} PRs here (${o.prs.map((u: string) => '#' + u.split('/').pop()).join(', ')}), so the replay is judged against all of them at the chat's full cost. ` : ''}The replay gets all your messages up front, with no tests or network, so it has hindsight the original didn't.</div>}
      </>}
    </div>
  )
}

// Every (PR shape, model) pair is a hypothesis; each replay of a PR with that shape verifies it or not.
function Hypotheses() {
  const { data: o } = useLive<any>('/api/shadow', ['shadow'], undefined, 60_000)
  if (!o) return null
  const hs = o.hypotheses ?? []
  const STATUS: Record<string, string> = { supported: '#3a3', refuted: '#c33', mixed: '#c90', testing: '#58f' }
  const saved = hs.reduce((a: number, h: any) => a + h.savedUsd, 0), savedMs = hs.reduce((a: number, h: any) => a + h.savedMs, 0)
  return (
    <div style={{ marginTop: 14 }}>
      <h4 style={{ margin: '0 0 4px' }}>Shadow mode hypotheses</h4>
      <div className="muted small">Shipped PRs are replayed on cheaper models in the background ({o.settings.perDay} a day, costliest first, preferring shapes that still need trials; {o.running} running now), or on demand from a PR above. A hypothesis is supported after 3+ replays with ≥80% the same outcome at under 70% of the cost. Replays where the original model couldn't reproduce itself don't count.{hs.length ? ` Same-outcome replays so far would have saved ${money(saved)} and ${dur(savedMs)}.` : ''}</div>
      {o.cloudGate?.paused && <div className="small" style={{ marginTop: 4, color: '#c90' }}>Cloud shadow runs paused: {o.cloudGate.reason} {o.cloudGate.resumesAt ? `Resumes automatically after ${new Date(o.cloudGate.resumesAt).toLocaleString()}.` : 'Resumes automatically when usage reports room.'} Local replays can still run when the Mac is quiet; their judging waits for cloud capacity.</div>}
      {o.localGate && <div className="small" style={{ marginTop: 4, color: '#58f' }} title={o.localGate.reason}>
        {o.localGate.waiting} local replay{o.localGate.waiting > 1 ? 's' : ''} ({mname(o.localGate.model)}) waiting for a quiet Mac: {o.localGate.quiet ? 'quiet now, starting' : `${o.localGate.quietMins ?? 0} of ${o.settings.quietMinutes ?? 20} quiet minutes${o.localGate.reason ? ` · ${o.localGate.reason}` : ''}`}.</div>}
      {!hs.length ? <div className="muted small" style={{ marginTop: 4 }}>{o.runs.length ? `${o.runs.length} run${o.runs.length > 1 ? 's' : ''} so far, none with a usable control yet.` : 'No shadow runs yet.'}</div> :
        <table className="small" style={{ width: '100%', borderCollapse: 'collapse', marginTop: 4 }}>
          <thead><tr><th style={{ textAlign: 'left' }}>Status</th><th style={{ textAlign: 'left' }}>Shape</th><th style={{ textAlign: 'left' }}>Model</th><th style={R}>Same outcome</th><th style={R}>Cost</th><th style={R}>Time</th><th style={R}>Saved</th><th style={{ textAlign: 'left' }}>Verifications</th></tr></thead>
          <tbody>{hs.map((h: any) => <tr key={h.shape + h.model} title={h.statement}>
            <td style={{ color: STATUS[h.status] }}>{h.status}{h.needs ? <span className="muted"> ({h.needs} more)</span> : ''}</td><td>{h.shape}</td><td>{mname(h.model)}</td>
            <td style={R}>{h.same}/{h.trials}</td><td style={R}>{ratio(h.costRatio)}</td><td style={R}>{ratio(h.timeRatio)}</td><td style={R}>{money(h.savedUsd)} · {dur(h.savedMs)}</td>
            <td>{h.evidence.map((e: any) => <a key={e.url} href={e.url} target="_blank" rel="noreferrer" title={`${e.outcome} ${e.score} · cost ${ratio(e.costRatio)} · time ${ratio(e.timeRatio)}`} style={{ color: OUT[e.outcome], marginRight: 6 }}>#{e.url.split('/').pop()}</a>)}</td>
          </tr>)}</tbody>
        </table>}
    </div>
  )
}

export function PrSpendCard() {
  const [days, setDays] = useState(30)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState('total')
  const [open, setOpen] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const { data: u, reload } = useLive<any>(`/api/spend/prs?days=${days}`, ['chats'])
  const { data: sh } = useLive<any>('/api/shadow', ['shadow'])
  // The PostHog query behind Review bots and the scout columns can outlast the first response:
  // ask again until it lands instead of leaving those columns blank.
  const cloudLoading = !!u?.cloudError && /still loading/i.test(u.cloudError)
  useEffect(() => { if (!cloudLoading) return; const t = setTimeout(reload, 6000); return () => clearTimeout(t) }, [u, cloudLoading, reload])
  const rows = !u ? [] : u.list
    .filter((p: any) => !q || `${p.repo}#${p.number} ${p.title ?? ''}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a: any, b: any) => sort === 'total' ? b.total - a.total : sort === 'number' ? b.number - a.number : (b.buckets[sort]?.usd ?? 0) - (a.buckets[sort]?.usd ?? 0))
  const shown = more || q ? rows : rows.slice(0, 25)
  const th = (k: string, l: string, right = true) => <th style={{ ...(right ? R : {}), cursor: 'pointer', whiteSpace: 'nowrap' }} onClick={() => setSort(k)}>{l}{sort === k ? ' ↓' : ''}</th>
  return (
    <section className="card">
      <div className="row-flex"><h3 className="grow">AI spend per PR</h3>
        <select value={days} onChange={e => setDays(Number(e.target.value))}>{[7, 30, 90, 365].map(d => <option key={d} value={d}>{d} days</option>)}</select></div>
      <div className="muted small">Tokens at API prices for each PR you opened: the chats that investigated it, the chat that wrote it (and its helpers), the shepherd (reviews, CI, merge, prod checks), Review Hog and Stamphog, and the scouts that checked it in production. Every chat and run counts once: one that touched several PRs is split evenly between them.</div>
      {!u ? <div className="muted small">…</div> : (
        <>
          <div className="stats">
            <div className="stat"><b>{money(u.total)}</b><span>{u.prs} PRs · {days} days</span></div>
            <div className="stat"><b>{money(u.perPr.mean)}</b><span>average per PR</span></div>
            <div className="stat"><b>{money(u.perPr.median)}</b><span>median per PR</span></div>
            <div className="stat"><b>{money(u.perMerged.median)}</b><span>median per merged PR ({u.merged})</span></div>
            <div className="stat"><b>{money(u.perPr.p90)}</b><span>90th percentile PR</span></div>
          </div>
          <h4>Per stage</h4>
          <table className="small cell-grid" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={{ textAlign: 'left' }}>Stage</th><th style={R}>Total</th><th style={R}>Share</th><th style={R}>PRs with it</th><th style={R}>Average when it happens</th><th style={R}>Median</th><th style={R}>Average over all PRs</th><th style={R}>Median agent time</th></tr></thead>
            <tbody>{BUCKETS.filter(([k]) => u.totals[k] > 0).map(([k, l, c]) => { const b = u.perBucket[k]; return (
              <tr key={k}><td><span style={{ color: c }}>■</span> {l}</td><td style={R}>{money(u.totals[k])}</td><td style={R}>{Math.round(u.totals[k] / u.total * 100)}%</td>
                <td style={R}>{b.n} of {u.prs}</td><td style={R}>{money(b.mean)}</td><td style={R}>{money(b.median)}</td><td style={R}><b>{money(b.meanAll)}</b></td><td style={R}>{dur(b.msMedian)}</td></tr>) })}</tbody>
          </table>
          <div className="row-flex" style={{ marginTop: 12 }}><h4 className="grow" style={{ margin: 0 }}>PRs</h4>
            <input placeholder="filter by repo, number or title" value={q} onChange={e => setQ(e.target.value)} style={{ width: 240 }} /></div>
          <div style={{ overflowX: 'auto', containerType: 'inline-size' }}><table className="small cell-grid" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{th('number', 'PR', false)}<th style={{ width: 90 }} />{BUCKETS.map(([k, l]) => th(k, l))}{th('total', 'Total')}<th style={R}>Agent time</th><th style={R}>Shadow</th></tr></thead>
            <tbody>{shown.map((p: any) => [
              <tr key={p.url} onClick={() => setOpen(open === p.url ? null : p.url)} style={{ cursor: 'pointer', background: open === p.url ? 'var(--bg2)' : undefined }}>
                <td className="ellipsis" style={{ maxWidth: 300 }}>{open === p.url ? '▾' : '▸'} {p.repo.split('/')[1]}#{p.number} <span className="muted">{p.title ?? ''}</span>{p.state && p.state !== 'MERGED' ? <span className="muted"> · {p.draft ? 'draft' : p.state.toLowerCase()}</span> : null}</td>
                <td><StackBar buckets={p.buckets} total={p.total} /></td>
                {BUCKETS.map(([k]) => <td key={k} style={R} className={p.buckets[k] ? '' : 'muted'} title={!p.buckets[k] && cloudLoading && CLOUD.has(k) ? 'Loading from PostHog' : undefined}>{p.buckets[k] ? money(p.buckets[k].usd) : cloudLoading && CLOUD.has(k) ? '…' : '·'}</td>)}
                <td style={R}><b>{money(p.total)}</b></td>
                <td style={R} className="muted">{dur(p.ms)}</td>
                <td style={R}>{(() => { const v = sh?.summaries?.[p.url]; return v && VERDICT[v.kind] ? <span style={{ color: VERDICT[v.kind][1] }} title={v.text}>{v.kind === 'cheaper' ? `−${money(v.savedUsd)}` : VERDICT[v.kind][0]}</span> : <span className="muted">·</span> })()}</td>
              </tr>,
              open === p.url && <tr key={p.url + ':d'}><td colSpan={BUCKETS.length + 5}><PrDetail url={p.url} days={days} /></td></tr>,
            ])}</tbody>
          </table></div>
          <Hypotheses />
          {!q && rows.length > 25 && <button className="link small" onClick={() => setMore(!more)}>{more ? 'Show top 25' : `Show all ${rows.length}`}</button>}
          <div className="muted small">
            {money(u.local.unattributed)} of {money(u.local.total)} local spend isn't tied to any PR; {money(u.otherPrs)} went to others' PRs you discussed.
            {cloudLoading ? ' Loading Review bot and scout spend from PostHog…' : u.cloudError ? ` Couldn't read PostHog: ${u.cloudError}.` : ' Scout runs use their billed cost; Review Hog and Stamphog report model tokens only (through PostHog LLM analytics), so they read low.'}
            {' '}Review bots run on PostHog's bill, not your subscription. Not included: GitHub Actions minutes and third-party review bots.
          </div>
        </>
      )}
    </section>
  )
}
