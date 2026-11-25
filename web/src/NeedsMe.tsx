import { useState } from 'react'
import { ago, post, useLive } from './api'

type Item = { id: string; title: string; source: string; context: string; status: 'needs_you' | 'checking' | 'agent' | 'resolved' | 'dismissed'; evidence: string | null; human_action: string | null; conversation_id: string | null; reviewer_id: string | null; url: string | null; checked_at: number | null; next_check_at: number; created_at: number; updated_at: number }
export type NeedsData = { items: Item[]; history: Item[]; counts: { needs_you: number; checking: number; agent: number }; sync: { cloudAt: number; cloudError: string | null } }
const labels = { needs_you: 'Needs you', checking: 'Checking', agent: 'Following through', resolved: 'Resolved', dismissed: 'Not needed' }

function NeedRow({ item: n, onOpen, reload }: { item: Item; onOpen: (id: string) => void; reload: () => void }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const { data: detail } = useLive<{ history: { id: number; at: number; status: string; evidence: string; actor: string }[] }>(open ? `/api/needs/${n.id}` : '', ['home'])
  const active = !['resolved', 'dismissed'].includes(n.status)
  const shepherd = n.title.match(/You are the shepherd for ([\w/#.-]+)/)?.[1]
  const title = shepherd ? `PR shepherd: ${shepherd}` : n.title
  const sourceUrl = n.url || n.evidence?.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0]
  const act = async (action: string) => { setBusy(true); setError(''); try { await post(`/api/needs/${n.id}/${action}`); reload() } catch (e) { setError(String(e)) } finally { setBusy(false) } }
  return <article className={`need-row need-${n.status}`}>
    <div className="row-flex"><strong className="grow">{n.human_action || title}</strong><span className="chip">{labels[n.status]}</span></div>
    {n.human_action && <div className="small muted">{title}</div>}
    {n.evidence && <p className="need-evidence small">{n.evidence.length > 220 ? `${n.evidence.slice(0, 220)}…` : n.evidence}</p>}
    <div className="small muted">{n.source} · raised {ago(n.created_at)} ago{n.checked_at ? ` · checked ${ago(n.checked_at)} ago` : ' · first check pending'}{active && <> · next check {n.next_check_at <= Date.now() ? 'queued' : new Date(n.next_check_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</>}</div>
    <div className="need-actions">
      {n.conversation_id && <button className="link small" onClick={() => onOpen(n.conversation_id!)}>Open work</button>}
      {sourceUrl && /^https?:\/\//.test(sourceUrl) && <a className="small" href={sourceUrl} target="_blank" rel="noreferrer">Source ↗</a>}
      {n.reviewer_id && <button className="link small" onClick={() => onOpen(n.reviewer_id!)}>Agent check</button>}
      <button className="link small" onClick={() => setOpen(!open)}>{open ? 'Hide details' : 'Why / history'}</button>
      <button className="link small" disabled={busy} onClick={() => act('recheck')}>Check again</button>
      {active && <><button className="link small" disabled={busy} onClick={() => act('resolve')}>I resolved it</button><button className="link small muted" disabled={busy} onClick={() => act('dismiss')}>Not needed</button></>}
    </div>
    {error && <div className="bad small" role="alert">{error}</div>}
    {open && <div className="need-detail small"><p>{n.context}</p>{detail?.history?.map(e => <div className="need-event" key={e.id}><span className="muted">{new Date(e.at).toLocaleString()} · {labels[e.status as keyof typeof labels] ?? e.status}</span><div>{e.evidence}</div></div>)}</div>}
  </article>
}

export function NeedsMe({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, reload, error } = useLive<NeedsData>('/api/needs', ['home', 'conversations'])
  const [tab, setTab] = useState<'needs_you' | 'agents' | 'history'>('needs_you')
  // Collapsed by default: a one-line count, expanded only when you ask (remembered).
  const [expanded, setExpandedS] = useState(() => { try { return localStorage.getItem('perch.needs.expanded') === '1' } catch { return false } })
  const setExpanded = (v: boolean) => { setExpandedS(v); try { localStorage.setItem('perch.needs.expanded', v ? '1' : '0') } catch {} }
  const head = (summary: string) => <div className="card-head"><h3 className="grow"><button className="link need-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '▾' : '▸'} Needs me</button>{!expanded && summary && <span className="muted small"> · {summary}</span>}</h3><a className="small" href="#needs">Open list ↗</a></div>
  if (!data) return <section className="card needs-me">{head('')}{expanded && <div className="muted small">{error ? String(error) : 'Loading…'}</div>}</section>
  const agents = data.counts.checking + data.counts.agent
  const summary = [data.counts.needs_you ? `${data.counts.needs_you} need you` : 'nothing needs you', agents ? `${agents} with agents` : ''].filter(Boolean).join(' · ')
  if (!expanded) return <section className="card needs-me needs-collapsed">{head(summary)}</section>
  const rows = tab === 'history' ? data.history : data.items.filter(n => tab === 'needs_you' ? n.status === 'needs_you' : n.status !== 'needs_you')
  return <section className="card needs-me">
    {head(summary)}
    <p className="muted small">Agents check first and move work forward. Only actions that still require you stay here.</p>
    <div className="tabs need-tabs" role="tablist" aria-label="Needs me status">
      {([['needs_you', `Needs you · ${data.counts.needs_you}`], ['agents', `Agents · ${data.counts.checking + data.counts.agent}`], ['history', `Resolved / not needed · ${data.history.length}`]] as const).map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>)}
    </div>
    {data.sync.cloudError && <div className="small bad" role="status">PostHog check needs a retry; existing items are kept. {data.sync.cloudError}</div>}
    {!rows.length && <p className="muted small">{tab === 'needs_you' ? data.counts.checking ? `${data.counts.checking} items still being checked. No action confirmed for you yet.` : 'Nothing currently needs you.' : tab === 'history' ? 'Resolved items will stay here with their evidence.' : 'No agent checks pending.'}</p>}
    {rows.map(n => <NeedRow key={n.id} item={n} onOpen={onOpen} reload={reload} />)}
    <div className="muted small need-sync">PostHog scouts: {data.sync.cloudAt ? `checked ${ago(data.sync.cloudAt)} ago` : 'first sync pending'} · Local blockers checked every minute</div>
  </section>
}
