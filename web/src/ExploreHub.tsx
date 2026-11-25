// Explore's landing page: pick what to explore (canvases, competitor products, codebases), then a
// sortable gallery of each, with an info panel that links back to the chats behind every item.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ago, useLive } from './api'
import { useRepos } from './ExploreRuntime'
import './explorehub.css'

type ChatRef = { id: string; title: string; role: string; at: number }
type Canvas = { id: string; name: string; about: string | null; pinned: number; created_by: string | null; updated_at: number; opened_at: number | null; ttl_seconds: number | null; expires_at: number | null; kinds: Record<string, number>; errors: number; tiles: { id: string; kind: string; title: string; x: number; y: number; w: number; h: number }[]; chats: ChatRef[] }
type Product = { id: string; name: string; url: string; docs_url: string; trial_url: string; scope: string; context: string; sandbox: boolean; created_at: number; data_scale: string; method: string; items: number; status: Record<string, number>; covered: number; coverage: number; depth: string; first_at: number | null; last_at: number | null; evidence: number; screenshots: number; cover: string | null; chats: ChatRef[] }
type Ev = { id: string; item_id: string; source: string; summary: string; url: string; captured_at: number; shot: boolean; friction: string | null; expected: string | null; chat: string | null; conv: string | null }
type Item = { id: string; title: string; kind: string; url: string; status: string; notes: string; capability: string; depth: number; evidence: Ev[] }

type Nav = { onSection: (id: string | null) => void; onOpenChat: (id: string) => void; onOpenBoard: (id: string) => void; onStart: (prompt?: string) => void }
const img = (id: string) => `/api/product-research/evidence/${encodeURIComponent(id)}/image`
const date = (t: number | null) => t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
const until = (t: number | null) => { if (!t) return ''; const s = (t - Date.now()) / 1000; return s <= 60 ? 'soon' : s < 3600 ? `in ${Math.round(s / 60)}m` : s < 86400 ? `in ${Math.round(s / 3600)}h` : `in ${Math.round(s / 86400)}d` }
// The board in miniature: tiles where they sit on its 12-column grid.
function Thumb({ tiles }: { tiles: Canvas['tiles'] }) {
  if (!tiles.length) return <div className="exh-thumb"><span className="muted small">empty</span></div>
  const rows = Math.max(8, ...tiles.map(t => t.y + t.h))
  return <div className="exh-thumb"><svg viewBox={`0 0 12 ${rows}`} preserveAspectRatio="xMidYMin meet">{tiles.map(t => (
    <g key={t.id} className={`k-${t.kind}`}><rect x={t.x + .1} y={t.y + .1} width={Math.max(.4, t.w - .2)} height={Math.max(.4, t.h - .2)} rx=".25" />
      <text x={t.x + .35} y={t.y + .85} fontSize=".55">{t.title.slice(0, Math.max(4, t.w * 3))}</text></g>))}</svg></div>
}
const pct = (x: number) => `${Math.round(x * 100)}%`
const ROLE: Record<string, string> = { created: 'made it', shown: 'showed it', edited: 'edited it', tile: 'on a tile', docs: 'read docs', product: 'used the product', sandbox: 'used the trial' }

function Back({ onSection, to = null, label = 'Explore' }: { onSection: Nav['onSection']; to?: string | null; label?: string }) {
  return <button className="link small exh-back" onClick={() => onSection(to)}>← {label}</button>
}
function Chats({ chats, onOpenChat, empty = 'No linked chats recorded.' }: { chats: ChatRef[]; onOpenChat: (id: string) => void; empty?: string }) {
  if (!chats.length) return <div className="muted small">{empty}</div>
  return <ul className="exh-chats">{chats.map(c => <li key={c.id + c.role}><button className="link" onClick={() => onOpenChat(c.id)} title={c.title}>{c.title}</button><span className="muted small"> · {ROLE[c.role] ?? c.role} · {ago(c.at)}</span></li>)}</ul>
}

// ── Landing ──────────────────────────────────────────────────────────────────────────────────
export function ExploreHub(nav: Nav) {
  const canvases = useLive<{ boards: Canvas[] }>('/api/explore/canvases', ['canvas']).data?.boards ?? []
  const products = useLive<{ products: Product[] }>('/api/explore/competitors', ['product-research']).data?.products ?? []
  const repos = useRepos()
  const recent = useMemo(() => { try { return JSON.parse(localStorage.getItem('perch.explore.repos') ?? '[]') as string[] } catch { return [] } }, [])
  const lastOpened = Math.max(0, ...canvases.map(c => c.opened_at ?? 0))
  const lastResearch = Math.max(0, ...products.map(p => p.last_at ?? 0))
  const shots = products.map(p => p.cover).filter(Boolean).slice(0, 4) as string[]
  return (
    <div className="page exh">
      <h2>Explore</h2>
      <div className="muted small">Pick what to look through.</div>
      <div className="exh-tiles">
        <button className="exh-tile" onClick={() => nav.onSection('canvases')}>
          <div className="exh-tile-art exh-art-canvas">{canvases.slice(0, 6).map(c => <span key={c.id}>{c.name}</span>)}</div>
          <b>Canvases</b>
          <span className="muted small">{canvases.length} boards · {canvases.filter(c => c.ttl_seconds != null).length} temporary{lastOpened ? ` · last opened ${ago(lastOpened)}` : ''}</span>
          <span className="small">Every board, sortable, with the chats that made it.</span>
        </button>
        <button className="exh-tile" onClick={() => nav.onSection('competitors')}>
          <div className="exh-tile-art exh-art-shots">{shots.length ? shots.map(s => <img key={s} src={img(s)} alt="" loading="lazy" />) : <span className="muted">No screenshots yet</span>}</div>
          <b>Competitor products</b>
          <span className="muted small">{products.length} products · {products.reduce((n, p) => n + p.screenshots, 0)} screenshots{lastResearch ? ` · last explored ${ago(lastResearch)}` : ''}</span>
          <span className="small">How far we mapped each one, screenshots and a quick tour.</span>
        </button>
        <button className="exh-tile" onClick={() => nav.onSection('code')}>
          <div className="exh-tile-art exh-art-code"><svg viewBox="0 0 120 60" aria-hidden><g stroke="currentColor" fill="none" opacity=".6"><path d="M20 30 L60 12 M20 30 L60 48 M60 12 L100 30 M60 48 L100 30 M60 12 L60 48" /></g>{[[20, 30], [60, 12], [60, 48], [100, 30]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r="6" fill="var(--accent)" />)}</svg></div>
          <b>Codebases</b>
          <span className="muted small">{repos.length} repos on this Mac{recent.length ? ` · ${recent.length} mapped recently` : ''}</span>
          <span className="small">Architecture map: what each part is built on, and how it grew.</span>
        </button>
      </div>
    </div>
  )
}

// ── Gallery shell: search, sort, filter, grid, info panel ────────────────────────────────────
function Gallery<T extends { id: string }>({ title, intro, items, sorts, filters, search, card, info, actions, onSection }: {
  title: string; intro: string; items: T[]; sorts: [string, (a: T, b: T) => number][]; filters: [string, (t: T) => boolean][]; search: (t: T) => string
  card: (t: T, select: () => void, selected: boolean) => ReactNode; info: (t: T) => ReactNode; actions?: ReactNode; onSection: Nav['onSection']
}) {
  const key = `perch.explore.gallery.${title}`
  const saved = (() => { try { return JSON.parse(localStorage.getItem(key) ?? '{}') } catch { return {} } })()
  const [sort, setSort] = useState<string>(saved.sort ?? sorts[0][0])
  const [filter, setFilter] = useState<string>(saved.filter ?? filters[0][0])
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  useEffect(() => localStorage.setItem(key, JSON.stringify({ sort, filter })), [key, sort, filter])
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const list = items.filter(filters.find(f => f[0] === filter)?.[1] ?? (() => true))
    .filter(t => { const h = search(t).toLowerCase(); return words.every(w => h.includes(w)) })
    .sort(sorts.find(s => s[0] === sort)?.[1] ?? (() => 0))
  const picked = items.find(t => t.id === sel)
  return (
    <div className="page exh exh-gallery-page">
      <Back onSection={onSection} />
      <div className="row-flex exh-head"><h2 className="grow">{title}</h2>{actions}</div>
      <div className="muted small">{intro}</div>
      <div className="row-flex exh-bar">
        <input className="grow" placeholder="Search" value={q} onChange={e => setQ(e.target.value)} />
        <div className="exh-seg" role="group" aria-label="Filter">{filters.map(([f]) => <button key={f} className={`small ${f === filter ? 'on' : ''}`} onClick={() => setFilter(f)}>{f}</button>)}</div>
        <label className="small muted">Sort <select className="small" value={sort} onChange={e => setSort(e.target.value)}>{sorts.map(([s]) => <option key={s}>{s}</option>)}</select></label>
      </div>
      <div className={`exh-body ${picked ? 'with-info' : ''}`}>
        <div className="exh-grid">{list.map(t => card(t, () => setSel(sel === t.id ? null : t.id), sel === t.id))}{!list.length && <div className="muted">Nothing matches.</div>}</div>
        {picked && <aside className="exh-info"><button className="link small exh-close" onClick={() => setSel(null)} aria-label="Close info">✕</button>{info(picked)}</aside>}
      </div>
    </div>
  )
}

// ── Canvases ─────────────────────────────────────────────────────────────────────────────────
export function CanvasGallery(nav: Nav) {
  const items = useLive<{ boards: Canvas[] }>('/api/explore/canvases', ['canvas']).data?.boards ?? []
  const lastTouch = (c: Canvas) => Math.max(c.opened_at ?? 0, c.updated_at)
  return <Gallery<Canvas> title="Canvases" intro="Every board. Click one to open it; ⓘ shows when it was used and the chats that made, showed or edited it."
    onSection={nav.onSection} items={items}
    sorts={[['Last opened', (a, b) => (b.opened_at ?? 0) - (a.opened_at ?? 0) || b.updated_at - a.updated_at], ['Last changed', (a, b) => b.updated_at - a.updated_at], ['Name', (a, b) => a.name.localeCompare(b.name)], ['Most tiles', (a, b) => b.tiles.length - a.tiles.length], ['Most chats', (a, b) => b.chats.length - a.chats.length]]}
    filters={[['All', () => true], ['Kept', c => c.ttl_seconds == null], ['Temporary', c => c.ttl_seconds != null], ['On Home', c => !!c.pinned]]}
    search={c => [c.name, c.about ?? '', ...c.tiles.map(t => t.title), ...c.chats.map(x => x.title)].join(' ')}
    actions={<button className="small" onClick={() => nav.onOpenBoard('')}>Manage boards</button>}
    card={(c, select, selected) => (
      <div key={c.id} className={`exh-card ${selected ? 'sel' : ''}`}>
        <button className="exh-card-main" onClick={() => nav.onOpenBoard(c.id)} title={c.about ?? c.name}>
          <Thumb tiles={c.tiles} />
          <b className="ellipsis">{c.name}</b>
          <span className="muted small">{c.tiles.length} tiles{c.errors ? ` · ${c.errors} failing` : ''} · {c.opened_at ? `opened ${ago(c.opened_at)}` : `changed ${ago(c.updated_at)}`}</span>
          <span className="exh-tags">{c.pinned ? <i>on Home</i> : null}{c.ttl_seconds != null ? <i className="warn">temporary · expires {until(c.expires_at)}</i> : null}{c.chats[0] && <i className="ellipsis">from {c.chats[0].title}</i>}</span>
        </button>
        <button className="exh-i" onClick={select} title="Info" aria-label={`Info about ${c.name}`}>ⓘ</button>
      </div>
    )}
    info={c => (
      <div className="exh-info-body">
        <h3>{c.name}</h3>
        {c.about && <p className="small">{c.about}</p>}
        <dl>
          <dt>Last opened</dt><dd>{c.opened_at ? `${ago(c.opened_at)} ago · ${date(c.opened_at)}` : 'not recorded yet'}</dd>
          <dt>Last changed</dt><dd>{ago(c.updated_at)} ago · {date(c.updated_at)}</dd>
          <dt>Lifetime</dt><dd>{c.ttl_seconds == null ? 'Kept' : `Temporary, expires ${date(c.expires_at)}`}{c.pinned ? ' · on Home' : ''}</dd>
          <dt>Tiles</dt><dd>{Object.entries(c.kinds).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}</dd>
        </dl>
        <h4>Chats</h4>
        <Chats chats={c.chats} onOpenChat={nav.onOpenChat} empty={c.created_by === 'perch' ? 'Made automatically by auto-m8.' : 'Made by hand, or before chat links were recorded.'} />
        <h4>Tiles</h4>
        <ul className="exh-list small">{c.tiles.map(t => <li key={t.id}><span className="muted">{t.kind}</span> {t.title}</li>)}</ul>
        <button onClick={() => nav.onOpenBoard(c.id)}>Open canvas</button>
        <span className="muted small"> last touched {ago(lastTouch(c))}</span>
      </div>
    )} />
}

// ── Competitor products ──────────────────────────────────────────────────────────────────────
const NEW_RESEARCH = 'Research a competitor product with the product_research tool and the auto-m8 browser. Product: <name and URL>. Set the product (url, docs_url, trial_url, scope, context, sandbox, and method = the skill or approach you use), map its pages, features and workflows as items, capture screenshots as evidence, and record data_scale: what data we sent to a trial and at what scale, or "none".'
const continueResearch = (p: Product) => `Continue the product research on ${p.name} (product_id ${p.id}) with the product_research tool and the auto-m8 browser. Start with action=next, work through the queued items, capture evidence with screenshots, and explain any blockers. Coverage now: ${p.covered}/${p.items} items (${p.depth}). Keep method and data_scale on the product up to date.`

function Coverage({ p }: { p: Product }) {
  const order: [string, string][] = [['tested', 'ok'], ['observed', 'accent'], ['documented', 'doc'], ['blocked', 'bad'], ['not_found', 'bad'], ['queued', 'q']]
  return <div className="exh-cov" title={order.filter(([s]) => p.status[s]).map(([s]) => `${p.status[s]} ${s}`).join(' · ')}>
    {order.map(([s, c]) => p.status[s] ? <span key={s} className={`c-${c}`} style={{ flex: p.status[s] }} /> : null)}
  </div>
}
function Meta({ p }: { p: Product }) {
  return <dl>
    <dt>Explored</dt><dd>{p.first_at ? `${date(p.first_at)} → ${date(p.last_at)}` : 'not yet'}</dd>
    <dt>Coverage</dt><dd>{p.covered}/{p.items} items ({pct(p.coverage)}) · deepest: {p.depth}</dd>
    <dt>Status</dt><dd>{Object.entries(p.status).map(([s, n]) => `${n} ${s.replace('_', ' ')}`).join(', ') || '—'}</dd>
    <dt>Access</dt><dd>{p.sandbox ? 'Trial/sandbox account' : p.status.tested || p.status.observed ? 'Live product or public demo' : 'Docs only so far'}</dd>
    <dt>Data sent</dt><dd>{p.data_scale || <span className="muted">not recorded</span>}</dd>
    <dt>Method</dt><dd>{p.method || <span className="muted">not recorded</span>}</dd>
    <dt>Evidence</dt><dd>{p.evidence} captures · {p.screenshots} screenshots</dd>
    <dt>Scope</dt><dd className="small">{p.scope}</dd>
    <dt>Context</dt><dd className="small">{p.context}</dd>
  </dl>
}
function Links({ p }: { p: Product }) {
  return <span className="exh-links small">
    <a href={p.url} target="_blank" rel="noreferrer">Product ↗</a>
    {p.docs_url && <a href={p.docs_url} target="_blank" rel="noreferrer">Docs ↗</a>}
    {p.trial_url && <a href={p.trial_url} target="_blank" rel="noreferrer">Trial ↗</a>}
  </span>
}

export function CompetitorGallery(nav: Nav) {
  const items = useLive<{ products: Product[] }>('/api/explore/competitors', ['product-research']).data?.products ?? []
  return <Gallery<Product> title="Competitor products" intro="Products we mapped with the research tool: how far we got, how, and what's left. Open one for its map and a quick screenshot tour."
    onSection={nav.onSection} items={items}
    sorts={[['Last explored', (a, b) => (b.last_at ?? 0) - (a.last_at ?? 0)], ['Most complete', (a, b) => b.coverage - a.coverage], ['Least complete', (a, b) => a.coverage - b.coverage], ['Most screenshots', (a, b) => b.screenshots - a.screenshots], ['Name', (a, b) => a.name.localeCompare(b.name)]]}
    filters={[['All', () => true], ['Trial', p => p.sandbox], ['Tested', p => !!p.status.tested], ['Has blockers', p => !!(p.status.blocked || p.status.not_found)], ['Not started', p => !p.evidence]]}
    search={p => [p.name, p.url, p.scope, p.method, p.data_scale, ...p.chats.map(c => c.title)].join(' ')}
    actions={<button className="small" onClick={() => nav.onStart(NEW_RESEARCH)}>+ Research a product</button>}
    card={(p, select, selected) => (
      <div key={p.id} className={`exh-card ${selected ? 'sel' : ''}`}>
        <button className="exh-card-main" onClick={() => nav.onSection(`competitor:${p.id}`)}>
          <div className="exh-cover">{p.cover ? <img src={img(p.cover)} alt="" loading="lazy" /> : <span className="muted">No screenshots yet</span>}</div>
          <b className="ellipsis">{p.name}</b>
          <Coverage p={p} />
          <span className="muted small">{pct(p.coverage)} covered · {p.depth} · {p.last_at ? `explored ${ago(p.last_at)}` : 'not explored'}</span>
          <span className="exh-tags">{p.sandbox ? <i>trial</i> : null}{p.data_scale ? <i className="ellipsis">data: {p.data_scale}</i> : null}{p.status.blocked ? <i className="warn">{p.status.blocked} blocked</i> : null}</span>
        </button>
        <button className="exh-i" onClick={select} title="Info" aria-label={`Info about ${p.name}`}>ⓘ</button>
      </div>
    )}
    info={p => (
      <div className="exh-info-body">
        <h3>{p.name}</h3>
        <Links p={p} />
        <Meta p={p} />
        <h4>Chats that researched it</h4>
        <Chats chats={p.chats} onOpenChat={nav.onOpenChat} />
        <div className="row-flex" style={{ flexWrap: 'wrap' }}>
          <button onClick={() => nav.onSection(`competitor:${p.id}`)}>Open map</button>
          {p.screenshots > 0 && <button onClick={() => nav.onSection(`competitor:${p.id}:tour`)}>▶ Tour</button>}
          <button onClick={() => nav.onStart(continueResearch(p))}>Continue research</button>
        </div>
      </div>
    )} />
}

// ── One competitor: map + tour ───────────────────────────────────────────────────────────────
export function CompetitorPage({ id, tour: startTour, ...nav }: Nav & { id: string; tour?: boolean }) {
  const { data } = useLive<Product & { tree: Item[]; error?: string }>(`/api/explore/competitors/${encodeURIComponent(id)}`, ['product-research'])
  const [tab, setTab] = useState<'map' | 'tour'>(startTour ? 'tour' : 'map')
  const [sel, setSel] = useState<string | null>(null)
  if (!data) return <div className="pad muted">…</div>
  if (data.error) return <div className="page"><Back onSection={nav.onSection} to="competitors" label="Competitor products" /><div className="muted">{data.error}</div></div>
  const picked = data.tree.find(i => i.id === sel) ?? data.tree.find(i => i.evidence.length) ?? data.tree[0]
  const slides = data.tree.flatMap(it => it.evidence.filter(e => e.shot).map(e => ({ it, e })))
  return (
    <div className="page exh exh-product">
      <Back onSection={nav.onSection} to="competitors" label="Competitor products" />
      <div className="row-flex exh-head"><h2 className="grow">{data.name}</h2><Links p={data} /><button className="small" onClick={() => nav.onStart(continueResearch(data))}>Continue research</button></div>
      <div className="row-flex exh-sum small">
        <Coverage p={data} /><span>{data.covered}/{data.items} covered · {data.depth}</span>
        <span className="muted">{data.first_at ? `explored ${date(data.first_at)} → ${date(data.last_at)}` : 'not explored yet'}</span>
        {data.sandbox && <span className="exh-tags"><i>trial</i></span>}
        <span className="muted">data: {data.data_scale || 'not recorded'}</span>
        <span className="muted">method: {data.method || 'not recorded'}</span>
      </div>
      <div className="exh-seg" role="tablist"><button className={`small ${tab === 'map' ? 'on' : ''}`} onClick={() => setTab('map')}>Map</button><button className={`small ${tab === 'tour' ? 'on' : ''}`} onClick={() => setTab('tour')} disabled={!slides.length}>▶ Tour ({slides.length})</button></div>
      {tab === 'tour' ? <Tour slides={slides} onItem={i => { setSel(i); setTab('map') }} /> : (
        <div className="exh-map">
          <ul className="exh-tree">{data.tree.map(it => (
            <li key={it.id} style={{ paddingLeft: 8 + it.depth * 16 }} className={picked?.id === it.id ? 'sel' : ''}>
              <button onClick={() => setSel(it.id)}><span className={`st st-${it.status}`}>{it.status.replace('_', ' ')}</span><span className="ellipsis">{it.title}</span><span className="muted small">{it.kind}{it.evidence.some(e => e.shot) ? ' · 📷' : ''}</span></button>
            </li>))}
            {!data.tree.length && <li className="muted">No pages or workflows mapped yet.</li>}
          </ul>
          {picked && <div className="exh-item">
            <h3>{picked.title}</h3>
            <div className="small"><span className={`st st-${picked.status}`}>{picked.status.replace('_', ' ')}</span> {picked.kind}{picked.capability ? ` · ${picked.capability}` : ''} · <a href={picked.url} target="_blank" rel="noreferrer">open in product ↗</a></div>
            {picked.notes && <p className="small">{picked.notes}</p>}
            {[...picked.evidence].reverse().map(e => (
              <figure key={e.id} className="exh-ev">
                {e.shot && <a href={img(e.id)} target="_blank" rel="noreferrer"><img src={img(e.id)} alt={e.summary} loading="lazy" /></a>}
                <figcaption className="small">
                  <b>{e.source}</b> · {date(e.captured_at)} · {e.summary}
                  {e.expected && <div>Checked: “{e.expected}” ✓</div>}
                  {e.friction && <div className="muted">Friction: {e.friction}</div>}
                  <div><a href={e.url} target="_blank" rel="noreferrer">{e.url}</a>{e.conv && <> · <button className="link small" onClick={() => nav.onOpenChat(e.conv!)}>{e.chat ?? 'chat'}</button></>}</div>
                </figcaption>
              </figure>))}
            {!picked.evidence.length && <div className="muted small">No evidence captured for this item yet.</div>}
          </div>}
        </div>)}
    </div>
  )
}

function Tour({ slides, onItem }: { slides: { it: Item; e: Ev }[]; onItem: (id: string) => void }) {
  const [i, setI] = useState(0)
  const [play, setPlay] = useState(false)
  const n = slides.length
  useEffect(() => {
    const f = (ev: KeyboardEvent) => {
      if ((ev.target as HTMLElement)?.closest('input,textarea,select,[contenteditable]')) return
      if (ev.key === 'ArrowRight') setI(x => (x + 1) % n)
      else if (ev.key === 'ArrowLeft') setI(x => (x - 1 + n) % n)
      else if (ev.key === ' ') { ev.preventDefault(); setPlay(p => !p) }
    }
    addEventListener('keydown', f); return () => removeEventListener('keydown', f)
  }, [n])
  useEffect(() => { if (!play) return; const t = setInterval(() => setI(x => (x + 1) % n), 3000); return () => clearInterval(t) }, [play, n])
  if (!n) return <div className="muted">No screenshots to show yet.</div>
  const { it, e } = slides[Math.min(i, n - 1)]
  return (
    <div className="exh-tour">
      <div className="exh-stage"><img src={img(e.id)} alt={e.summary} /></div>
      <div className="row-flex exh-tour-bar">
        <button className="small" onClick={() => setI((i - 1 + n) % n)} aria-label="Previous">←</button>
        <button className="small" onClick={() => setPlay(!play)}>{play ? '❚❚ Pause' : '▶ Play'}</button>
        <button className="small" onClick={() => setI((i + 1) % n)} aria-label="Next">→</button>
        <span className="muted small">{i + 1}/{n}</span>
        <div className="grow small exh-caption"><b>{it.title}</b> · {e.summary}</div>
        <button className="link small" onClick={() => onItem(it.id)}>Details</button>
        <a className="small" href={e.url} target="_blank" rel="noreferrer">Open ↗</a>
      </div>
      <div className="exh-strip">{slides.map((s, k) => <button key={s.e.id} className={k === i ? 'on' : ''} onClick={() => setI(k)} title={s.it.title}><img src={img(s.e.id)} alt="" loading="lazy" /></button>)}</div>
    </div>
  )
}
