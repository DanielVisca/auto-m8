// The explorer's runtime pieces: picking repos, the sources it can reach, and where a concept runs right now.
// Every number links to the query that produced it; anything we can't reach says how to connect it.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ago, api, post, shortPath, toast } from './api'

// Explore answers outlive the page: a slow request (Argo CD, Grafana, ClickHouse) keeps going when you switch to a
// chat, and its answer is waiting when you come back. Past the TTL the old answer stays on screen while a fresh one loads.
const kept = new Map<string, { at: number; p: Promise<any>; v?: any }>()
// Slow lookups answer { pending: true } instead of holding one of the window's 6 connections (server/swr.ts):
// ask again, a little slower each time, until the answer is there. Each ask returns at once.
async function untilReady<T>(url: string): Promise<T> {
  for (let i = 0; ; i++) {
    const v = await api.get<any>(url)
    if (!v || v.pending !== true || i >= 60) return v
    await new Promise(r => setTimeout(r, Math.min(600 + i * 400, 4000)))
  }
}
export function keep<T = any>(url: string, ttl = 15 * 60_000): { p: Promise<T>; v?: T } {
  const k = kept.get(url)
  if (k && (k.v === undefined || Date.now() - k.at < ttl)) return k
  const e: { at: number; p: Promise<T>; v?: T } = { at: Date.now(), p: null as any, v: k?.v }
  e.p = untilReady<T>(url).then(v => { if ((v as any)?.error) kept.delete(url); else { e.v = v; e.at = Date.now() } return v }, err => { kept.delete(url); throw err })
  kept.set(url, e)
  return e
}

export type Repo = { path: string; name: string; remote: string | null; org: string | null; lastCommit: string | null; lastFetch: string | null; shallow: boolean; branch: string | null; behindOrigin: number | null }
const DAY = 864e5
const staleDays = (r: Repo) => r.lastFetch ? Math.floor((Date.now() - Date.parse(r.lastFetch)) / DAY) : null

export function useRepos() {
  const [repos, setRepos] = useState<Repo[]>([])
  useEffect(() => { const k = keep<Repo[]>('/api/explore/repos', 60_000); if (Array.isArray(k.v)) setRepos(k.v); k.p.then(r => Array.isArray(r) && setRepos(r)).catch(() => {}) }, [])
  return repos
}

// A searchable list of the git repos on this Mac: name, org, and how stale the checkout is.
export function RepoPicker({ value, onPick, repos, placeholder, exclude = [], compact }: { value: string; onPick: (path: string) => void; repos: Repo[]; placeholder: string; exclude?: string[]; compact?: boolean }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { const f = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }; addEventListener('mousedown', f); return () => removeEventListener('mousedown', f) }, [])
  const list = useMemo(() => {
    const t = q.trim().toLowerCase()
    return repos.filter(r => !exclude.includes(r.path) && (!t || `${r.name} ${r.remote ?? ''} ${r.path}`.toLowerCase().includes(t))).slice(0, 40)
  }, [q, repos, exclude])
  const pick = (p: string) => { onPick(p); setOpen(false); setQ('') }
  const current = repos.find(r => r.path === value)
  return (
    <div className={`ex-picker ${compact ? 'compact' : ''}`} ref={box}>
      <input value={open ? q : current ? `${current.name}${current.remote ? `  ·  ${current.remote}` : ''}` : shortPath(value)} placeholder={placeholder}
        onFocus={() => { setOpen(true); setQ(''); setHi(0) }} onChange={e => { setQ(e.target.value); setHi(0) }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(list.length - 1, h + 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(0, h - 1)) }
          else if (e.key === 'Enter') { e.preventDefault(); if (list[hi]) pick(list[hi].path); else if (q.trim()) pick(q.trim().replace(/^~/, '')) }
          else if (e.key === 'Escape') setOpen(false)
        }} />
      {open && (
        <div className="ex-picker-list">
          {!list.length && <div className="muted small ex-picker-row">No match. Press Enter to use “{q}” as a path.</div>}
          {list.map((r, i) => {
            const d = staleDays(r)
            return (
              <button key={r.path} className={`ex-picker-row ${i === hi ? 'hi' : ''}`} onMouseEnter={() => setHi(i)} onMouseDown={e => { e.preventDefault(); pick(r.path) }}>
                <b>{r.name}</b> <span className="muted">{r.remote ?? 'no remote'}</span>
                <span className="grow" />
                {r.shallow && <span className="ex-badge" title="Shallow clone: history before the cut-off comes from GitHub">shallow</span>}
                {r.behindOrigin ? <span className={`ex-badge ${r.behindOrigin > 50 ? 'warn' : ''}`} title={`On branch ${r.branch ?? '?'}: ${r.behindOrigin.toLocaleString()} commits on the default branch (as of the last fetch, ${r.lastFetch?.slice(0, 10) ?? 'never'}) aren't in this checkout. The map shows the checkout, so pull or switch to main for today's system.`}>{r.behindOrigin.toLocaleString()} behind main</span>
                  : d != null && <span className={`ex-badge ${d > 14 ? 'warn' : ''}`} title={`Last fetched ${r.lastFetch?.slice(0, 10)}. The map shows the checkout, not what's on GitHub now.`}>fetched {d === 0 ? 'today' : `${d}d ago`}</span>}
                {r.lastCommit && <span className="ex-badge" title="Date of the newest commit in this checkout">{r.lastCommit.slice(0, 10)}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

type Connector = { id: string; name: string; status: 'connected' | 'expired' | 'missing' | 'error'; detail: string; fix?: { command?: string; how: string } }
async function connect(c: Connector, onOpenTerm?: (id: string) => void) {
  if (!c.fix?.command) return
  const r = await post<{ id: string }>('/api/terms', { prefill: c.fix.command, run: true, title: `Connect ${c.name}` })
  toast(`Opened a terminal to connect ${c.name}. Finish in the browser, then press Recheck.`, { kind: 'info' })
  onOpenTerm?.(r.id)
}

// What the explorer can see beyond the code, and how to connect what it can't.
export function SourcesPanel({ onClose, onOpenTerm }: { onClose: () => void; onOpenTerm?: (id: string) => void }) {
  const [cs, setCs] = useState<Connector[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [ch, setCh] = useState<any>(null)
  const load = (fresh = false) => { setBusy(true); api.get<Connector[]>(`/api/explore/connectors${fresh ? '?fresh=1' : ''}`).then(setCs).catch(e => toast(String(e?.message ?? e), { kind: 'error' })).finally(() => setBusy(false)) }
  useEffect(() => { load() }, [])
  return (
    <div className="card ex-sources">
      <div className="ex-title"><b>Sources</b> <span className="muted small">what the explorer can read beyond the code</span><span className="grow" /><button className="small" disabled={busy} onClick={() => load(true)}>{busy ? 'Checking…' : 'Recheck'}</button><button className="link small" onClick={onClose}>close</button></div>
      {!cs && <div className="small muted"><i className="spin" /> Checking connections…</div>}
      {cs?.map(c => (
        <div key={c.id} className="ex-src small">
          <span className={`ex-dot ${c.status}`} title={c.status} />
          <div className="grow">
            <b>{c.name}</b> <span className="muted">{c.status === 'connected' ? '' : c.status === 'expired' ? 'signed out' : c.status}</span>
            <div className="muted">{c.detail}</div>
            {c.status !== 'connected' && c.fix && <div>{c.fix.how} {c.fix.command && <><code>{c.fix.command}</code> <button className="small primary" onClick={() => connect(c, onOpenTerm)}>Connect</button></>}</div>}
          </div>
        </div>
      ))}
      <div className="ex-sec small">
        <h5>ClickHouse disks</h5>
        {!ch ? <button className="small" onClick={() => { setCh({ loading: true }); api.get('/api/explore/clickhouse').then(setCh).catch(e => setCh({ error: String(e?.message ?? e) })) }}>Load disk usage across the fleet</button>
          : ch.loading ? <span className="muted"><i className="spin" /> asking Prometheus…</span>
          : ch.error ? <span className="bad">{ch.error}</span>
          : <>
            <div>{ch.disks} disks · median <b>{pct(ch.median)}</b> used · <span className="muted">{ch.source}</span></div>
            <div className="muted tiny">Fullest (cache disks can run full on purpose; check the node's role before worrying):</div>
            {ch.fullest.map((f: any) => <div key={f.instance + f.disk}><span className={f.used > 0.9 ? 'bad' : f.used > 0.8 ? 'warn' : ''}>{pct(f.used)}</span> {f.instance} <span className="muted">{f.disk}</span></div>)}
            <div className="tiny">{ch.queries.map((q: any, i: number) => <a key={i} href={q.link} target="_blank" rel="noreferrer" title={q.query}>query {i + 1} ↗ </a>)}</div>
          </>}
      </div>
      <div className="muted tiny ex-sec">Each concept's Data section reads ClickHouse system tables through these Grafana datasources, instance types from posthog-cloud-infra terraform, and confirms them with AWS when SSO is connected.</div>
    </div>
  )
}

const pct = (v: number | null | undefined) => v == null ? '—' : `${Math.round(v * 1000) / 10}%`
const fmt = (v: number | string | null, unit?: string) => {
  if (v == null || v === '') return '—'
  const n = Number(v)
  if (unit === 'bytes') return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(0)} MB`
  if (unit === '%') return pct(n)
  return Math.abs(n) >= 100 ? Math.round(n).toLocaleString() : String(Math.round(n * 100) / 100)
}

type Fact = { label: string; value: number | string | null; unit?: string; source: string; query: string; link?: string }
type Code = { image: string; sha: string; repo: string; behind: number | null; ahead: number | null; github: string | null }
type App = { name: string; region: string; health?: string; sync?: string; deployedAt?: string; images?: string[]; chart?: string; namespace?: string; cluster?: string; code?: Code[]; error?: string }
type Dep = { base: string; origin: 'yours' | 'org' | 'third-party' | 'unknown'; apps: App[]; facts: Fact[]; chartPath?: string }
export type Runtime = { concept: string; tokens: string[]; argoError: string | null; grafana: string | null; deployments: Dep[]; matchedBy: string }

// Where a concept runs: the deployments, whose code they run, and live numbers from two metric sources side by side.
export function WhereItRuns({ concept, repos, org, onLoaded, bare, onSummary }: { concept: string; repos: string[]; org: string | null; onLoaded?: (r: Runtime | null) => void; bare?: boolean; onSummary?: (s: string) => void }) {
  const url = `/api/explore/runtime?concept=${encodeURIComponent(concept)}&repos=${encodeURIComponent(repos.join(','))}&org=${encodeURIComponent(org ?? '')}`
  const [r, setR] = useState<Runtime | { error: string } | null>(() => keep<Runtime>(url).v ?? null)
  const [showInfra, setShowInfra] = useState(false)
  useEffect(() => {
    const k = keep<Runtime>(url)
    setR(k.v ?? null); onLoaded?.(k.v ?? null)
    let gone = false
    k.p.then(x => { if (!gone) { setR(x); onLoaded?.(x) } }).catch(e => !gone && setR({ error: String(e?.message ?? e) }))
    return () => { gone = true }
  }, [url]) // eslint-disable-line
  useEffect(() => {
    if (!r) return onSummary?.('checking Argo CD…')
    if ('error' in r) return onSummary?.('error')
    const yours = r.deployments.filter(d => d.origin === 'yours').length, names = r.deployments.length - yours
    onSummary?.(yours ? `${yours} app${yours === 1 ? '' : 's'} run your code` : `no app of its own${names ? ` (${names} name match${names === 1 ? '' : 'es'})` : ''}`)
  }, [r]) // eslint-disable-line
  if (!r) return <div className="ex-sec small muted">{!bare && <h5>Where it runs</h5>}<i className="spin" /> Asking Argo CD and Grafana… (the first time takes up to a minute)</div>
  if ('error' in r) return <div className="ex-sec small">{!bare && <h5>Where it runs</h5>}<span className="bad">{r.error}</span></div>
  const mine = r.deployments.filter(d => d.origin !== 'third-party'), infra = r.deployments.filter(d => d.origin === 'third-party')
  return (
    <div className="ex-sec">
      {!bare && <h5>Where it runs</h5>}
      {!bare && <div className="tiny muted">Argo CD apps with “{r.tokens.join('”, “')}” in their name. Only ones marked <b>runs your code</b> are proven to run this repo (their image is tagged with one of its commits); the rest just share the name. Code that's part of a bigger app (like a Django product inside the main web app) has no app of its own, so it won't show here.</div>}
      {r.argoError && <div className="small bad">Argo CD: {r.argoError}. Open Sources to connect it.</div>}
      {!r.argoError && !r.deployments.length && <div className="small muted">No Argo CD app is named like this concept. It may run inside another service (look at what's built on it), or as a scheduled job.</div>}
      {mine.length > 0 && !mine.some(d => d.origin === 'yours') && <div className="small warn">None of these run code from your repos, so they're probably unrelated namesakes. This concept likely runs inside a larger app.</div>}
      {mine.map(d => <DepCard key={d.base} d={d} />)}
      {infra.length > 0 && (
        <div className="small muted">
          <button className="link small" onClick={() => setShowInfra(!showInfra)}>{showInfra ? '▾' : '▸'} {infra.length} third-party deployments named like it</button> (not your code: {infra.map(d => d.base).slice(0, 4).join(', ')}{infra.length > 4 ? '…' : ''})
          {showInfra && infra.map(d => <DepCard key={d.base} d={d} />)}
        </div>
      )}
      {!r.grafana && <div className="small muted">No Grafana connection, so no live numbers. Open Sources to see how to add one.</div>}
    </div>
  )
}

type TfHit = { key: string; value: string; file: string; line: number; context: string[]; matchedBy: string; link?: string }
type DataTable = { db: string; table: string; engine: string; cluster?: string | null; how: string[]; ds: string; host: string; bytes?: number | null; rows?: number | null; parts?: number | null; sizeScope?: string; query?: string; link?: string }
type DataCluster = { name: string; ds: string | null; shards: number | null; replicas: number | null; hosts: string[]; aws: string[]; terraform: TfHit[]
  disk: { nodes: number; max?: number; median?: number; fullest?: { instance: string; disk: string; used: number; role: string | null }[]; query?: string; link?: string; source?: string; note?: string } }
export type DataRes = { concept: string; tokens: string[]; grafana: string | null; clusters: DataCluster[]; tables: DataTable[]; problems: { source: string; error: string; fix?: string }[]
  datasources?: { name: string; host: string; tables: number; link: string }[]; infra: { path: string; behind: number | null; lastFetch: string | null; sha: string; files: number; types: number } | null; code: { files: number; names: number }; matchedBy?: string }

const bytes = (n: number | null | undefined) => n == null ? '—' : n >= 1e12 ? `${(n / 1e12).toFixed(1)} TB` : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(0)} MB`

// Datastores and tiers: which ClickHouse clusters and tables hold this concept's data, how big, how full, on what hardware.
export function DataSection({ concept, repos, bare, onSummary }: { concept: string; repos: string[]; bare?: boolean; onSummary?: (s: string) => void }) {
  const url = `/api/explore/data?concept=${encodeURIComponent(concept)}&repos=${encodeURIComponent(repos.join(','))}`
  const [r, setR] = useState<DataRes | { error: string } | null>(() => keep<DataRes>(url).v ?? null)
  const [all, setAll] = useState(false)
  useEffect(() => {
    const k = keep<DataRes>(url)
    setR(k.v ?? null)
    let gone = false
    k.p.then(x => { if (!gone) setR(x) }).catch(e => !gone && setR({ error: String(e?.message ?? e) }))
    return () => { gone = true }
  }, [url])
  useEffect(() => {
    onSummary?.(!r ? 'asking ClickHouse…' : 'error' in r ? 'error' : !r.tables.length ? 'no ClickHouse tables'
      : (() => {
        // Lead with the cluster that holds most of its own tables (named like it), not the first one found.
        const ownT = r.tables.filter((t: any) => t.how.some((h: string) => /^table name|db_table/.test(h)))
        const key = (n?: string | null) => String(n ?? '').replace(/_primary_replica$|_replica$/, '')
        const top = [...r.clusters].map(c => ({ c, b: ownT.filter((t: any) => key(t.cluster) === key(c.name)).reduce((n: number, t: any) => n + (t.bytes ?? 0), 0) })).sort((x, y) => y.b - x.b)[0]
        return `${r.tables.length} table${r.tables.length === 1 ? '' : 's'}${top ? ` · mostly ${key(top.c.name)}${top.c.disk.max != null ? `, ${pct(top.c.disk.max)} full` : ''}` : ''}`
      })())
  }, [r]) // eslint-disable-line
  if (!r) return <div className="ex-sec small muted">{!bare && <h5>Data</h5>}<i className="spin" /> Asking ClickHouse (system tables) and Prometheus…</div>
  if ('error' in r) return <div className="ex-sec small">{!bare && <h5>Data</h5>}<span className="bad">{r.error}</span></div>
  // Strongest evidence first (named in the concept's code), then the biggest: that's where its data really lives.
  const named = (t: any) => t.how.some((h: string) => h.startsWith('named in code'))
  // Its own tables are named like it (or are its models' db_table); a table its code merely mentions (the shared
  // events table, say) is data it reads, not data it holds, so it ranks after its own however big it is.
  const own = (t: any) => t.how.some((h: string) => /^table name|db_table/.test(h))
  const score = (t: any) => (own(t) ? 2 : 0) + (named(t) ? 1 : 0)
  const sorted = [...r.tables].sort((a: any, b: any) => score(b) - score(a) || (b.bytes ?? 0) - (a.bytes ?? 0))
  const tables = all ? sorted : sorted.slice(0, 8)
  // How much of this concept's data each cluster holds, so the cluster that matters comes first.
  const base = (n?: string | null) => String(n ?? '').replace(/_primary_replica$|_replica$/, '')
  const holds = (c: any) => {
    const here = r.tables.filter((t: any) => base(t.cluster) === base(c.name) || (t.host && c.hosts?.includes(t.host) && !t.cluster))
    const mine = here.filter(own)
    return { bytes: mine.reduce((n: number, t: any) => n + (t.bytes ?? 0), 0), named: mine.filter(named).reduce((n: number, t: any) => n + (t.bytes ?? 0) + 1, 0), tables: mine.length, codeTables: mine.filter(named).length, reads: here.filter(t => !own(t)).map((t: any) => t.table) }
  }
  const clusters = [...r.clusters].map((c: any) => ({ c, h: holds(c) })).sort((a, b) => b.h.named - a.h.named || b.h.bytes - a.h.bytes)
  return (
    <div className="ex-sec small">
      {!bare && <h5>Data <span className="muted" title={r.matchedBy}>· ClickHouse tables named in its code or like “{r.tokens.join('”, “')}”</span></h5>}
      {clusters.map(({ c, h }) => <ClusterCard key={c.name} c={c} h={h} />)}
      {!r.tables.length && <div className="muted" title={r.datasources?.length ? `Searched ${r.datasources.map(d => `${d.name}: ${d.tables} tables`).join(', ')}` : undefined}>None of its code names a ClickHouse table, and no table is named like it. Its data may live in Postgres (see its models under Code).</div>}
      {r.tables.length > 0 && (
        <table className="ex-facts ex-tables">
          <thead><tr><th>table</th><th>engine</th><th>size</th><th>rows</th><th>found by</th></tr></thead>
          <tbody>{tables.map(t => (
            <tr key={`${t.ds}:${t.db}.${t.table}`}>
              <td title={`${t.ds} → ${t.host}`}>{t.db}.{t.table}</td>
              <td className="muted">{t.engine}{t.cluster ? ` → ${t.cluster}` : ''}</td>
              <td>{t.link ? <a href={t.link} target="_blank" rel="noreferrer" title={`${t.sizeScope}\n${t.query}`}>{bytes(t.bytes)}</a> : '—'}</td>
              <td>{t.rows == null ? '—' : fmt(t.rows)}</td>
              <td className="muted tiny">{t.how.join('; ')}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {r.tables.length > 8 && <button className="link small" onClick={() => setAll(!all)}>{all ? 'fewer' : `+${r.tables.length - 8} more`}</button>}
      {r.infra && r.clusters.length > 0 && <div className="tiny muted">Tiers from {shortPath(r.infra.path)}@{r.infra.sha} ({r.infra.files} ClickHouse terraform files){r.infra.behind ? <span className={r.infra.behind > 50 ? 'warn' : ''}> · {r.infra.behind.toLocaleString()} commits behind main, so instance types may be out of date: pull it</span> : ''}.</div>}
      {r.problems.map((p, i) => <div key={i} className="tiny"><span className="bad">{p.source}:</span> {p.error}{p.fix && <> · fix: <code>{p.fix}</code></>}</div>)}
    </div>
  )
}

function DepCard({ d }: { d: Dep }) {
  const labels = [...new Set(d.facts.map(f => f.label))]
  const sources = [...new Set(d.facts.map(f => f.source))]
  const cell = (label: string, source: string) => d.facts.find(f => f.label === label && f.source === source)
  const badge = d.origin === 'yours' ? 'runs your code' : d.origin === 'org' ? 'name match only · built by your org' : d.origin === 'third-party' ? 'name match only · third-party' : 'name match only'
  return (
    <div className="ex-dep small">
      <div><b>{d.base}</b> <span className={`ex-badge ${d.origin}`}>{badge}</span>{d.chartPath && <span className="muted"> · chart {shortPath(d.chartPath)}</span>}</div>
      {d.apps.map(a => (
        <div key={a.name} className="ex-app">
          <span className={`ex-dot ${a.health === 'Healthy' ? 'connected' : a.error ? 'error' : 'expired'}`} title={`${a.health ?? '?'} · ${a.sync ?? '?'}`} />
          <span>{a.region}</span>
          {a.error ? <span className="bad"> {a.error}</span> : <span className="muted"> {a.health} · {a.sync}{a.deployedAt ? ` · deployed ${ago(Date.parse(a.deployedAt))} ago` : ''}{a.namespace ? ` · ${a.cluster}/${a.namespace}` : ''}</span>}
          {a.code?.map(c => (
            <div key={c.sha} className="ex-code">
              runs <a href={c.github ?? undefined} target="_blank" rel="noreferrer">{c.repo.split('/').pop()}@{c.sha.slice(0, 8)}</a>
              <span className="muted">{c.ahead ? ` · ${c.ahead} commits newer than your checkout (pull to map what's live)` : c.behind ? ` · your checkout has ${c.behind} commits not yet in prod` : c.ahead === 0 && c.behind === 0 ? ' · same as your checkout' : ''}</span>
            </div>
          ))}
          {!a.code?.length && a.images?.length ? <div className="muted tiny ex-code" title={a.images.join('\n')}>{a.images.length} image{a.images.length === 1 ? '' : 's'}: {a.images.map(i => i.split('/').pop()!.split('@')[0]).join(', ').slice(0, 120)}</div> : null}
        </div>
      ))}
      {labels.length > 0 && (
        <table className="ex-facts">
          <thead><tr><th /> {sources.map(s => <th key={s} title={s}>{s.split(' · ').pop() === 'posthog-prometheus' ? 'PostHog metrics' : s.split(' · ').pop()}</th>)}</tr></thead>
          <tbody>{labels.map(l => {
            const vs = sources.map(s => cell(l, s))
            const nums = vs.map(v => v?.value == null ? null : Number(v.value)).filter((n): n is number => n != null)
            // Where the two metric pipelines disagree by more than 10%, say so: that's a finding in itself.
            const off = nums.length === 2 && Math.max(...nums) > 0 && Math.abs(nums[0] - nums[1]) / Math.max(...nums) > 0.1
            return (
              <tr key={l} className={off ? 'off' : ''}><td>{l}</td>{vs.map((v, i) => <td key={i}>{v ? <a href={v.link} target="_blank" rel="noreferrer" title={`${v.source}\n${v.query}`}>{fmt(v.value, v.unit)}</a> : '—'}</td>)}</tr>
            )
          })}</tbody>
        </table>
      )}
      {labels.length > 0 && <div className="tiny muted">Live, last 5 minutes. Click a number for its query in Grafana. Rows in amber: the two metric pipelines disagree by over 10%.</div>}
    </div>
  )
}

// prod-us-iad-ch-1b-logs:9363 → 1b-logs: the part that tells nodes apart.
const shortNode = (s: string) => s.replace(/:\d+$/, '').replace(/^[a-z]+-[a-z]+-[a-z]+\d?-ch-/, '')
// What a terraform file provisions, from its folder: zookeeper-logs → ZooKeeper, clickhouse → ClickHouse nodes.
const roleOf = (file: string) => { const d = file.split('/').slice(-2, -1)[0] ?? ''; return /zookeeper/i.test(d) ? 'ZooKeeper' : /keeper/i.test(d) ? 'Keeper' : /clickhouse/i.test(d) ? 'ClickHouse nodes' : d }
const level = (v: number | null | undefined) => v == null ? '' : v > 0.9 ? 'bad' : v > 0.8 ? 'warn' : ''

// One cluster: how full it is at a glance, each node's fullest disk as a bar, and the hardware by role.
function ClusterCard({ c, h }: { c: any; h: { bytes: number; tables: number; codeTables: number; reads: string[] } }) {
  const [all, setAll] = useState(false)
  // One row per node: its fullest disk.
  const byNode = new Map<string, { node: string; disk: string; used: number }>()
  for (const f of c.disk.fullest ?? []) { const k = shortNode(f.instance), x = byNode.get(k); if (!x || f.used > x.used) byNode.set(k, { node: k, disk: f.disk, used: f.used }) }
  const nodes = [...byNode.values()].sort((a, b) => b.used - a.used), shown = all ? nodes : nodes.slice(0, 6)
  const hw = c.aws.length ? [{ role: 'ClickHouse nodes', value: c.aws.join(', '), tip: 'AWS describe-instances, now', link: null }]
    : c.terraform.map((t: any) => ({ role: roleOf(t.file), value: t.value, tip: `${t.key} · ${t.matchedBy}\n${t.file}:${t.line}`, link: t.link }))
  return (
    <div className="ex-dep ex-cluster">
      <div className="ex-cluster-head">
        <b title={c.ds ? `Seen via ${c.ds}` : undefined}>{c.name}</b>
        <span className="muted">{c.shards != null ? `${c.shards} shard${c.shards === 1 ? '' : 's'} · ${c.replicas} node${c.replicas === 1 ? '' : 's'}` : ''}</span>
        <span className="grow" />
        <span className="muted tiny" title={`${h.tables} of this concept's tables are on this cluster; ${h.codeTables} of them are named in its code`}>{h.bytes ? `its tables: ${bytes(h.bytes)}` : h.tables ? `${h.tables} table${h.tables === 1 ? '' : 's'}` : h.reads.length ? `reads ${h.reads.slice(0, 2).join(', ')}` : ''}{h.tables && !h.codeTables ? ' · name match only' : ''}</span>
        {c.disk.nodes ? <a className={`ex-full ${level(c.disk.max)}`} href={c.disk.link} target="_blank" rel="noreferrer" title={`Fullest disk in the cluster\n${c.disk.source}\n${c.disk.query}`}>{pct(c.disk.max)} full</a> : null}
      </div>
      {c.disk.nodes ? (
        <div className="ex-disks">
          {shown.map(n => (
            <div key={n.node} className="ex-disk" title={`${n.node} · ${n.disk} disk · ${pct(n.used)} used`}>
              <span className="ex-disk-name">{n.node} <span className="muted">{n.disk}</span></span>
              <span className="ex-bar"><i className={level(n.used)} style={{ width: `${Math.min(100, n.used * 100)}%` }} /></span>
              <span className={`ex-disk-pct ${level(n.used)}`}>{pct(n.used)}</span>
            </div>
          ))}
          {nodes.length > 6 && <button className="link tiny" onClick={() => setAll(!all)}>{all ? 'fewer' : `+${nodes.length - 6} more nodes`}</button>}
          <div className="tiny muted">median {pct(c.disk.median)} across {c.disk.nodes} disk{c.disk.nodes === 1 ? "" : "s"}</div>
        </div>
      ) : <div className="muted tiny">Disk: {c.disk.note}</div>}
      <div className="ex-hw">
        {!hw.length && <span className="muted tiny">Hardware: no terraform block names this cluster or its nodes</span>}
        {hw.map((h: any, i: number) => (
          <div key={i}>{h.role} <b>{h.value}</b> {h.link ? <a className="tiny muted" href={h.link} target="_blank" rel="noreferrer" title={h.tip}>terraform ↗</a> : <span className="tiny muted" title={h.tip}>ⓘ</span>}</div>
        ))}
      </div>
    </div>
  )
}
