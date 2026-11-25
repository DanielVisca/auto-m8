import { useRef, useState, type ReactNode } from 'react'
import { ago, post, useLive } from './api'

type Item = { id: string; title: string; source: string; context: string; status: 'needs_you' | 'checking' | 'agent' | 'resolved' | 'dismissed'; evidence: string | null; human_action: string | null; conversation_id: string | null; reviewer_id: string | null; url: string | null; checked_at: number | null; next_check_at: number; created_at: number; updated_at: number }
export type NeedsData = { items: Item[]; history: Item[]; counts: { needs_you: number; checking: number; agent: number }; sync: { cloudAt: number; cloudError: string | null } }
const labels = { needs_you: 'Needs you', checking: 'Checking', agent: 'Following through', resolved: 'Resolved', dismissed: 'Not needed' }

// Turn machine text into something you can read at a glance: GitHub URLs become
// "repo #123" pills, file paths become their last name, backticks go.
const TOKEN = /(https?:\/\/github\.com\/[\w.-]+\/([\w.-]+)\/(?:pull|issues)\/(\d+)[^\s)]*|https?:\/\/[^\s)]+|~?\/(?:[\w.@-]+\/)+([\w.@-]+)|`([^`]+)`)/g
const shortRepo = (r: string) => r.replace(/^posthog-/, '')
export function human(text: string): ReactNode[] {
  const out: ReactNode[] = []; let last = 0, m: RegExpExecArray | null, k = 0
  TOKEN.lastIndex = 0
  while ((m = TOKEN.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const [all, , repo, num, file, code] = m
    if (repo && num) out.push(<a key={k++} className="need-pill" href={all} target="_blank" rel="noreferrer">{shortRepo(repo)} #{num}</a>)
    else if (all.startsWith('http')) { let host = all; try { host = new URL(all).hostname.replace(/^www\./, '') } catch {} out.push(<a key={k++} className="need-pill" href={all} target="_blank" rel="noreferrer">{host} ↗</a>) }
    else if (file) out.push(<code key={k++} title={all}>{file}</code>)
    else if (code) out.push(<code key={k++}>{code}</code>)
    last = m.index + all.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
// First sentence only, so a card reads in one breath (the rest sits behind More).
const firstSentence = (s: string, max = 160) => { const t = s.replace(/\s+/g, ' ').trim(); const cut = t.search(/[.!?](\s|$)(?![^(]*\))/); const one = cut > 20 ? t.slice(0, cut + 1) : t; return one.length > max ? `${one.slice(0, max).replace(/\s+\S*$/, '')}…` : one }
const view = (n: Item) => {
  const shepherd = n.title.match(/You are the shepherd for ([\w/#.-]+)/)?.[1]
  const title = shepherd ? `PR shepherd: ${shepherd}` : n.title
  const headline = n.human_action || title
  return { title, headline, sub: n.human_action && title !== headline ? firstSentence(title) : '', sourceUrl: n.url || n.evidence?.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0] || null }
}
const who = (s: string) => s === 'you' ? 'you' : s.split(/\s*·\s*/)[0]

function Details({ n, onOpen, busy, act }: { n: Item; onOpen: (id: string) => void; busy: boolean; act: (a: string) => void }) {
  const { data: detail } = useLive<{ history: { id: number; at: number; status: string; evidence: string; actor: string }[] }>(`/api/needs/${n.id}`, ['home'])
  return <div className="need-detail small">
    {n.evidence && <><div className="muted need-label">Latest check {n.checked_at ? `· ${ago(n.checked_at)} ago` : ''}</div><p>{human(n.evidence)}</p></>}
    {n.context && <><div className="muted need-label">Why it's here</div><p>{human(n.context)}</p></>}
    <div className="need-actions">
      {n.reviewer_id && <button className="link small" onClick={() => onOpen(n.reviewer_id!)}>Agent check</button>}
      <button className="link small" disabled={busy} onClick={() => act('recheck')}>Check again</button>
      <span className="muted">from {n.source} · raised {ago(n.created_at)} ago</span>
    </div>
    {!!detail?.history?.length && <><div className="muted need-label">History</div>{detail.history.map(e => <div className="need-event" key={e.id}><span className="muted">{new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · {labels[e.status as keyof typeof labels] ?? e.status}</span><div>{human(e.evidence)}</div></div>)}</>}
  </div>
}

function useAct(n: Item, reload: () => void) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const act = async (action: string) => { setBusy(true); setError(''); try { await post(`/api/needs/${n.id}/${action}`); reload() } catch (e) { setError(String(e)) } finally { setBusy(false) } }
  return { busy, error, act }
}

// Compact list row: headline, one muted line, the few buttons you actually use.
function NeedRow({ item: n, onOpen, reload }: { item: Item; onOpen: (id: string) => void; reload: () => void }) {
  const [open, setOpen] = useState(false)
  const { busy, error, act } = useAct(n, reload)
  const v = view(n), active = !['resolved', 'dismissed'].includes(n.status)
  return <article className={`need-row need-${n.status}`}>
    <div className="row-flex"><strong className="grow">{human(firstSentence(v.headline, 200))}</strong>{n.status !== 'needs_you' && <span className="chip">{labels[n.status]}</span>}</div>
    {v.sub && <div className="small muted">{human(v.sub)}</div>}
    <div className="need-actions">
      {n.conversation_id && <button className="link small" onClick={() => onOpen(n.conversation_id!)}>Open work</button>}
      {active && <><button className="link small" disabled={busy} onClick={() => act('resolve')}>Done</button><button className="link small muted" disabled={busy} onClick={() => act('dismiss')}>Not needed</button></>}
      <button className="link small muted" onClick={() => setOpen(!open)}>{open ? 'Less' : 'More'}</button>
      <span className="small muted grow-right">{who(n.source)} · {ago(n.created_at)}</span>
    </div>
    {error && <div className="bad small" role="alert">{error}</div>}
    {open && <Details n={n} onOpen={onOpen} busy={busy} act={act} />}
  </article>
}

// One decision at a time. Swipe (or drag) right = done, left = not needed; Later moves it to the back.
function DecisionDeck({ items, onOpen, reload }: { items: Item[]; onOpen: (id: string) => void; reload: () => void }) {
  const [skipped, setSkipped] = useState<string[]>([])
  const order = [...items.filter(n => !skipped.includes(n.id)), ...skipped.map(id => items.find(n => n.id === id)).filter((n): n is Item => !!n)]
  const n = order[0]
  const [dx, setDx] = useState(0), [leaving, setLeaving] = useState<0 | 1 | -1>(0), [more, setMore] = useState(false)
  const start = useRef<{ x: number; y: number; id: number } | null>(null)
  const { busy, error, act } = useAct(n ?? items[0], reload)
  if (!n) return null
  const v = view(n), i = items.indexOf(n)
  const next = () => { setDx(0); setLeaving(0); setMore(false) }
  const decide = (dir: 1 | -1 | 0) => {
    if (busy) return
    if (dir === 0) { setSkipped(s => [...s.filter(id => id !== n.id), n.id]); next(); return }
    setLeaving(dir)
    setTimeout(async () => { await act(dir > 0 ? 'resolve' : 'dismiss'); setSkipped(s => s.filter(id => id !== n.id)); next() }, 180)
  }
  const THRESH = 110
  const onDown = (e: React.PointerEvent) => { if ((e.target as HTMLElement).closest('a,button,.need-detail')) return; start.current = { x: e.clientX, y: e.clientY, id: e.pointerId }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) }
  const onMove = (e: React.PointerEvent) => { if (start.current?.id === e.pointerId) setDx(e.clientX - start.current.x) }
  const onUp = () => { if (!start.current) return; start.current = null; if (dx > THRESH) decide(1); else if (dx < -THRESH) decide(-1); else setDx(0) }
  const x = leaving ? leaving * 600 : dx
  const hint = dx > 40 ? 'done' : dx < -40 ? 'dismiss' : ''
  return <div className="need-deck" tabIndex={0} onKeyDown={e => { if (e.target !== e.currentTarget) return; if (e.key === 'ArrowRight') decide(1); else if (e.key === 'ArrowLeft') decide(-1); else if (e.key === 'ArrowDown') decide(0) }}>
    <div className="need-progress" aria-label={`${i + 1} of ${items.length}`}>{items.map(it => <span key={it.id} className={it.id === n.id ? 'on' : skipped.includes(it.id) ? 'skipped' : ''} />)}<span className="muted small">{i + 1} of {items.length}</span></div>
    <div className="need-stack">
      {order[1] && <div className="need-card ghost" aria-hidden />}
      <article key={n.id} className={`need-card ${hint}`} style={{ transform: `translateX(${x}px) rotate(${x / 40}deg)`, transition: start.current ? 'none' : 'transform .18s ease, opacity .18s', opacity: leaving ? 0 : 1 }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div className="need-stamp left">Not needed</div><div className="need-stamp right">Done</div>
        <div className="small muted need-card-meta">{who(n.source)} · waiting {ago(n.created_at)}</div>
        <h4 className="need-card-title">{human(firstSentence(v.headline, 220))}</h4>
        {v.sub && <p className="need-card-sub">{human(v.sub)}</p>}
        <div className="need-card-links">
          {n.conversation_id && <button className="link" onClick={() => onOpen(n.conversation_id!)}>Open the work →</button>}
          {v.sourceUrl && /^https?:\/\//.test(v.sourceUrl) && !v.headline.includes(v.sourceUrl) && human(v.sourceUrl)}
          <button className="link muted small" onClick={() => setMore(!more)}>{more ? 'Less' : 'More details'}</button>
        </div>
        {more && <Details n={n} onOpen={onOpen} busy={busy} act={act} />}
      </article>
    </div>
    {error && <div className="bad small" role="alert">{error}</div>}
    <div className="need-decide">
      <button disabled={busy} onClick={() => decide(-1)} title="Swipe left or ←">✕ Not needed</button>
      <button disabled={busy || items.length < 2} onClick={() => decide(0)} title="↓">Later</button>
      <button className="primary" disabled={busy} onClick={() => decide(1)} title="Swipe right or →">✓ Done</button>
    </div>
  </div>
}

export function NeedsMe({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, reload, error } = useLive<NeedsData>('/api/needs', ['home', 'conversations'])
  const [tab, setTab] = useState<'needs_you' | 'agents' | 'history'>('needs_you')
  // Collapsed by default: a one-line count, expanded only when you ask (remembered).
  const [expanded, setExpandedS] = useState(() => { try { return localStorage.getItem('perch.needs.expanded') === '1' } catch { return false } })
  const setExpanded = (v: boolean) => { setExpandedS(v); try { localStorage.setItem('perch.needs.expanded', v ? '1' : '0') } catch {} }
  const [mode, setModeS] = useState<'cards' | 'list'>(() => { try { return localStorage.getItem('perch.needs.mode') === 'list' ? 'list' : 'cards' } catch { return 'cards' } })
  const setMode = (v: 'cards' | 'list') => { setModeS(v); try { localStorage.setItem('perch.needs.mode', v) } catch {} }
  const head = (summary: string) => <div className="card-head"><h3 className="grow"><button className="link need-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '▾' : '▸'} Needs me</button>{!expanded && summary && <span className="muted small"> · {summary}</span>}</h3><a className="small" href="#needs">Open list ↗</a></div>
  if (!data) return <section className="card needs-me">{head('')}{expanded && <div className="muted small">{error ? String(error) : 'Loading…'}</div>}</section>
  const agents = data.counts.checking + data.counts.agent
  const summary = [data.counts.needs_you ? `${data.counts.needs_you} need you` : 'nothing needs you', agents ? `${agents} with agents` : ''].filter(Boolean).join(' · ')
  if (!expanded) return <section className="card needs-me needs-collapsed">{head(summary)}</section>
  const rows = tab === 'history' ? data.history : data.items.filter(n => tab === 'needs_you' ? n.status === 'needs_you' : n.status !== 'needs_you')
  const deck = tab === 'needs_you' && mode === 'cards' && rows.length > 0
  return <section className="card needs-me">
    {head(summary)}
    <div className="row-flex need-bar">
      <div className="tabs need-tabs grow" role="tablist" aria-label="Needs me status">
        {([['needs_you', `Needs you · ${data.counts.needs_you}`], ['agents', `Agents · ${agents}`], ['history', `Done · ${data.history.length}`]] as const).map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      {tab === 'needs_you' && rows.length > 0 && <button className="link small muted" onClick={() => setMode(mode === 'cards' ? 'list' : 'cards')}>{mode === 'cards' ? 'Show as list' : 'One at a time'}</button>}
    </div>
    {data.sync.cloudError && <div className="small bad" role="status">PostHog check needs a retry; existing items are kept.</div>}
    {!rows.length && <p className="muted small">{tab === 'needs_you' ? data.counts.checking ? `${data.counts.checking} items still being checked. Nothing confirmed for you yet.` : 'Nothing needs you. 🎉' : tab === 'history' ? 'Resolved items stay here with their evidence.' : 'No agent checks pending.'}</p>}
    {deck ? <DecisionDeck items={rows} onOpen={onOpen} reload={reload} /> : rows.map(n => <NeedRow key={n.id} item={n} onOpen={onOpen} reload={reload} />)}
  </section>
}
