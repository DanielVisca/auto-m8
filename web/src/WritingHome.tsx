// Writing home (Explore → Writing, and #writing): one place to write, review, draft and share.
// Your docs, the shelf of drafted posts and captured ideas an agent keeps, docs waiting on review
// comments, and where finished pieces can go. Everything opens in the docs editor.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Marked } from 'marked'
import { ago, api, post, shell, toast, useLive } from './api'
import './writing.css'

type Doc = { id: string; path: string; title: string; status: 'draft' | 'final'; agent_text: 'allowed' | 'blocked'; updated_at: number; open_comments?: number; research?: number; exists: boolean; excerpt: string; image: string | null }
type ShelfPost = { slug: string; title: string; point: string; status: string; words: number; draft: string; worksheet: string | null; updated_at: number; excerpt: string; image: string | null }
type Idea = { file: string; path: string; title: string; point: string; captured: string; updated_at: number }
type Dest = { id: string; name: string; status: 'ready' | 'planned'; how: string }
export type WritingData = {
  docs: Doc[]; dir: string; reviews: number; destinations: Dest[]
  shelf: null | { dir: string; readme: string | null; posts: ShelfPost[]; ideas: Idea[]; last_run: { file: string; path: string; at: number } | null }
}
export const useWriting = () => useLive<WritingData>('/api/explore/writing', ['docs'], undefined, 60_000).data

const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')
const ready = (s: string) => /draft-for-edit|ready|final/i.test(s)
// Previews render markdown as plain reading text: raw HTML dropped, links shown as their words.
const md = new Marked({ gfm: true, renderer: { html: () => '', link: ({ text }) => text, image: () => '' } })
function Preview({ text, image }: { text: string; image: string | null }) {
  const html = useMemo(() => md.parse(text || '', { async: false }) as string, [text])
  return (
    <div className="wh-preview">
      {image && <img src={image} alt="" loading="lazy" onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />}
      {text ? <div className="wh-preview-text" dangerouslySetInnerHTML={{ __html: html }} /> : !image && <div className="muted small">Empty</div>}
    </div>
  )
}

export function WritingHome({ onOpenDoc, onStart, onBack }: { onOpenDoc: (id: string) => void; onStart: (prompt?: string) => void; onBack?: () => void }) {
  const data = useWriting()
  const pub = usePublished()
  const [q, setQ] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [allIdeas, setAllIdeas] = useState(false)
  const open = async (body: { path?: string; title?: string }) => {
    const d = await post<{ id?: string; error?: string }>('/api/docs', body)
    if (d?.id) onOpenDoc(d.id); else toast(d?.error ?? 'Could not open that file')
  }
  const docs = data?.docs ?? [], shelf = data?.shelf
  const match = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase())
  const posts = useMemo(() => (shelf?.posts ?? []).filter(p => match(p.title + p.point)).sort((a, b) => Number(ready(b.status)) - Number(ready(a.status)) || b.updated_at - a.updated_at), [shelf, q])
  const ideas = (shelf?.ideas ?? []).filter(i => match(i.title + i.point))
  const mine = docs.filter(d => match(d.title + d.path))
  const reviewing = docs.filter(d => (d.open_comments ?? 0) > 0)
  const review = (p: string) => onStart(`Review my draft ${tilde(p)} with the auto-m8 doc tool. Leave comments only and don't edit the text: point out unclear sentences, claims that need a source (check the worksheet next to it if there is one), AI tells, and anything a reader without context would trip on.`)
  const develop = (i: Idea) => onStart(`Use the perch-blog-workshop skill to turn this captured idea into a short draft with an evidence worksheet: ${tilde(i.path)}. One point, my voice, no publishing.`)

  if (!data) return <div className="page wh"><h2>Writing</h2><div className="muted">Loading…</div></div>
  return (
    <div className="page wh">
      {onBack && <button className="link small exh-back" onClick={onBack}>← Explore</button>}
      <div className="wh-head">
        <div><h2>Writing</h2><div className="muted small">Posts, blogs, social posts and internal write-ups: draft, review, share.</div></div>
        <div className="row-flex">
          <input className="wh-search" value={q} placeholder="Filter…" onChange={e => setQ(e.target.value)} />
          <button className="primary" onClick={() => open({ title: 'Untitled' })}>+ New doc</button>
        </div>
      </div>

      <div className="wh-stats">
        <Stat n={docs.length} label="docs" />
        <Stat n={shelf?.posts.length ?? 0} label="drafted posts" sub={`${shelf?.posts.filter(p => ready(p.status)).length ?? 0} ready to edit`} />
        <Stat n={shelf?.ideas.length ?? 0} label="ideas captured" />
        <Stat n={pub?.pages?.length ?? 0} label="published pages" sub={pub?.pages ? `${fmt(pub.pages.reduce((n, p) => n + p.views30, 0))} views in 30 days` : undefined} />
        <Stat n={reviewing.reduce((n, d) => n + (d.open_comments ?? 0), 0)} label="open review comments" sub={`on ${reviewing.length} docs`} />
      </div>

      <Published pub={pub} />

      {reviewing.length > 0 && <section className="wh-sec">
        <h3>Waiting on you <span className="muted small">comments from reviewers and agents</span></h3>
        {reviewing.map(d => <DocRow key={d.id} d={d} onOpen={() => onOpenDoc(d.id)} />)}
      </section>}

      <section className="wh-sec">
        <h3>Your docs <span className="muted small">new ones go in {tilde(data.dir)}; any markdown file opens too</span></h3>
        <Finder onPick={p => open({ path: p })} roots={[data.dir, ...(shelf ? [shelf.dir] : [])]} />
        <div className="wh-grid">
          {mine.slice(0, showAll ? 50 : 6).map(d => (
            <div key={d.id} className="wh-card">
              <button className="wh-card-main" onClick={() => onOpenDoc(d.id)} title={d.path}>
                <b>{d.title || 'Untitled'}</b>
                <Preview text={d.excerpt} image={d.image} />
                <span className="small wh-meta"><span className={`chip small ${d.status}`}>{d.status}</span>{d.agent_text === 'blocked' && <span className="chip small" title="Agents may comment and research, not write">✍ yours only</span>}{!!d.open_comments && <span>💬 {d.open_comments}</span>}<span className="muted">{ago(d.updated_at)}</span></span>
                <span className="muted small ellipsis">{tilde(d.path)}</span>
              </button>
              <div className="wh-card-actions"><button className="small" onClick={() => review(d.path)}>Ask for review</button></div>
            </div>))}
          {!mine.length && <div className="muted small">{q ? 'Nothing matches.' : 'No docs yet.'}</div>}
        </div>
        {mine.length > 6 && <button className="link small" onClick={() => setShowAll(s => !s)}>{showAll ? 'Show fewer' : `Show all ${mine.length}`}</button>}
      </section>

      {shelf ? <>
        <section className="wh-sec">
          <h3>Drafted posts <span className="muted small">the blog shelf agents keep{shelf.last_run ? ` · last pass ${ago(shelf.last_run.at)}` : ''}</span>
            {shelf.readme && <button className="link small" onClick={() => open({ path: shelf.readme! })}>shelf notes</button>}</h3>
          <div className="wh-grid">{posts.map(p => (
            <div key={p.slug} className="wh-card">
              <button className="wh-card-main" onClick={() => open({ path: p.draft })} title={tilde(p.draft)}>
                <b>{p.title}</b>
                <Preview text={p.excerpt} image={p.image} />
                <span className="small wh-meta"><span className={`chip small ${ready(p.status) ? 'final' : ''}`}>{p.status}</span><span className="muted">{p.words} words · {ago(p.updated_at)}</span></span>
              </button>
              <div className="wh-card-actions">
                <button className="small" onClick={() => open({ path: p.draft })}>Edit</button>
                {p.worksheet && <button className="small" onClick={() => open({ path: p.worksheet! })}>Evidence</button>}
                <button className="small" onClick={() => review(p.draft)}>Ask for review</button>
              </div>
            </div>))}
            {!posts.length && <div className="muted small">{q ? 'Nothing matches.' : 'No drafts yet.'}</div>}
          </div>
        </section>
        <section className="wh-sec">
          <h3>Ideas <span className="muted small">{shelf.ideas.length} captured while agents worked; the strongest become drafts</span>
            {ideas.length > 2 && <button className="link small" onClick={() => setAllIdeas(a => !a)}>{allIdeas ? 'Show top 2' : `Show all ${ideas.length}`}</button>}</h3>
          {ideas.slice(0, allIdeas ? 60 : 2).map(i => (
            <div key={i.file} className="writing-row wh-idea">
              <button className="link grow ellipsis" onClick={() => open({ path: i.path })} title={i.point || tilde(i.path)}><b>{i.title}</b>{i.point && <span className="muted small"> · {i.point}</span>}</button>
              <span className="muted small">{i.captured}</span>
              <button className="small" onClick={() => develop(i)}>Draft it</button>
            </div>))}
          {allIdeas && ideas.length > 60 && <div className="muted small">and {ideas.length - 60} more in {tilde(shelf.dir)}/inbox</div>}
          {!ideas.length && <div className="muted small">{q ? 'Nothing matches.' : 'No ideas captured yet.'}</div>}
        </section>
      </> : <section className="wh-sec"><h3>Drafted posts and ideas</h3><div className="muted small">No shelf folder yet. Set PERCH_WRITING_SHELF to a folder with posts/&lt;slug&gt;/draft.md and inbox/*.md (or create ~/Documents/blog-workshop) and agents' drafts and ideas show here.</div></section>}

      <section className="wh-sec">
        <h3>Share and publish</h3>
        <div className="wh-grid">{(data.destinations ?? []).map(d => (
          <div key={d.id} className={`wh-card wh-dest ${d.status}`}>
            <b>{d.name} <span className={`chip small ${d.status === 'ready' ? 'final' : ''}`}>{d.status === 'ready' ? 'ready' : 'coming'}</span></b>
            <span className="muted small">{d.how}</span>
          </div>))}
        </div>
      </section>
    </div>
  )
}

// The open box: a dropdown finder. Empty shows markdown changed in the last two weeks; a word
// searches file names (Spotlight); a path (~/…) browses that folder. Arrow keys, Enter, Esc work.
// In the desktop app, Browse… opens the Finder sheet.
type Found = { path: string; name: string; dir: boolean; updated_at: number }
function Finder({ onPick, roots }: { onPick: (path: string) => void; roots: string[] }) {
  const [q, setQ] = useState(''), [open, setOpen] = useState(false), [sel, setSel] = useState(0)
  const [res, setRes] = useState<{ mode: string; folder?: string; items: Found[] } | null>(null)
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!open) return
    let live = true
    const t = setTimeout(() => api.get(`/api/explore/writing/find?q=${encodeURIComponent(q)}`).then(r => { if (live) { setRes(r); setSel(0) } }).catch(() => {}), q ? 150 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [q, open])
  const pick = (f: Found) => { if (f.dir) { setQ(tilde(f.path) + '/'); box.current?.focus() } else { setOpen(false); setQ(''); onPick(f.path) } }
  const items = res?.items ?? []
  const looksLikeFile = /^[~/].+\.(md|markdown|mdx|txt)$/i.test(q.trim())
  const browse = async () => { const p = await shell.pickFile?.(roots[0]); if (p) onPick(p) }
  const places = [...roots, '~/Documents', '~/Desktop', '~/Development'].map(tilde).filter((p, i, a) => a.indexOf(p) === i)
  return (
    <div className="wh-finder">
      <div className="row-flex">
        <input ref={box} className="grow" value={q} placeholder="Find a markdown file by name, or type a path like ~/Documents/" onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={e => { setQ(e.target.value); setOpen(true) }}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, items.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)) }
            else if (e.key === 'Escape') { setOpen(false); box.current?.blur() }
            else if (e.key === 'Enter') { e.preventDefault(); if (looksLikeFile && !items[sel]) { setOpen(false); onPick(q.trim()) } else if (items[sel]) pick(items[sel]) }
            else if (e.key === 'Tab' && items[sel]?.dir) { e.preventDefault(); pick(items[sel]) }
          }} />
        {shell.pickFile && <button onClick={browse} title="Choose a file in Finder">Browse…</button>}
      </div>
      {open && <div className="wh-drop" onMouseDown={e => e.preventDefault()}>
        <div className="wh-drop-places">{places.map(p => <button key={p} className="chip small" onClick={() => { setQ(p + '/'); box.current?.focus() }}>{p.split('/').pop() || p}</button>)}</div>
        <div className="muted small wh-drop-head">{!res ? 'Looking…' : res.mode === 'folder' ? tilde(res.folder ?? '') : res.mode === 'search' ? `Markdown files named like "${q}"` : 'Changed in the last two weeks'}</div>
        {items.map((f, i) => (
          <button key={f.path} className={`wh-drop-row ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => pick(f)} title={f.path}>
            <span>{f.dir ? '📁' : '📄'}</span><span className="grow ellipsis"><b>{f.name}</b>{res?.mode !== 'folder' && <span className="muted small"> {tilde(f.path.slice(0, f.path.length - f.name.length - 1))}</span>}</span>
            {!f.dir && <span className="muted small">{ago(f.updated_at)}</span>}
          </button>))}
        {res && !items.length && <div className="muted small wh-drop-head">{looksLikeFile ? 'Press Enter to open or create it.' : 'Nothing here.'}</div>}
      </div>}
    </div>
  )
}

function Stat({ n, label, sub }: { n: number; label: string; sub?: string }) {
  return <div className="wh-stat"><b>{n}</b><span className="small">{label}</span>{sub && <span className="muted small">{sub}</span>}</div>
}
function DocRow({ d, onOpen, onReview }: { d: Doc; onOpen: () => void; onReview?: () => void }) {
  return (
    <div className="writing-row">
      <button className="link grow ellipsis" onClick={onOpen} title={d.path}><b>{d.title || 'Untitled'}</b> <span className="muted small">{tilde(d.path)}</span></button>
      {d.agent_text === 'blocked' && <span className="chip small" title="Agents may comment and research, not write">✍ yours only</span>}
      <span className={`chip small ${d.status}`}>{d.status}</span>
      {!!d.open_comments && <span className="muted small">💬 {d.open_comments}</span>}
      <span className="muted small">{ago(d.updated_at)}</span>
      {onReview && <button className="small" onClick={onReview}>Ask for review</button>}
    </div>
  )
}

// Explore landing tile art: the most recent titles as stacked pages.
export function WritingArt({ data, posts = [] }: { data?: WritingData; posts?: string[] }) {
  const seen = new Set<string>()
  const titles = [...(data?.docs ?? []).map(d => ({ k: d.path, t: d.title || 'Untitled', at: d.updated_at })), ...(data?.shelf?.posts ?? []).map(p => ({ k: p.draft, t: p.title, at: p.updated_at }))]
    .sort((a, b) => b.at - a.at).filter(x => !seen.has(x.k) && !!seen.add(x.k))
  // Published posts lead, marked, then the most recent drafts.
  const pages = [...posts.map(t => ({ k: t, t, at: 0, live: true })), ...titles.map(x => ({ ...x, live: false }))].slice(0, 4)
  if (!pages.length) return <span className="muted">No writing yet</span>
  return <div className="wh-art">{pages.map((x, i) => <div key={i} className={`wh-page ${x.live ? 'live' : ''}`}>{x.live && <span className="wh-live">published</span>}<b>{x.t}</b><i /><i /><i /></div>)}</div>
}

// ── Published: pages on the site repo you created or have a byline on, with their views ──
type PubPage = { file: string; path: string; url: string; title: string; kind: 'article' | 'docs' | 'page'; byline: boolean; pr: number | null; published_at: number | null; weekly: number[]; views30: number; visitors30: number; total: number }
type Pub = { login: string; handle: string | null; repo: string; host: string; weeks: number[]; pages: PubPage[]; insight: string; pending_views?: boolean; views_error?: string; pending?: boolean; error?: string }
export function usePublished() {
  const [d, setD] = useState<Pub | null>(null)
  useEffect(() => {
    let live = true, t: ReturnType<typeof setTimeout>
    const ask = () => api.get<Pub>('/api/explore/writing/published').then(r => { if (!live) return; if (r && !r.pending) setD(r); t = setTimeout(ask, r?.pending || r?.pending_views ? 2500 : 15 * 60_000) }).catch(() => { if (live) t = setTimeout(ask, 30_000) })
    ask()
    return () => { live = false; clearTimeout(t) }
  }, [])
  return d
}
const fmt = (n: number) => n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
function Spark({ v }: { v: number[] }) {
  const max = Math.max(1, ...v), W = 100, H = 24
  const pts = v.map((y, i) => `${(i / Math.max(1, v.length - 1)) * W},${H - (y / max) * (H - 2) - 1}`).join(' ')
  return <svg className="wh-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden><polyline points={pts} /></svg>
}
// Weekly views, all your pages stacked by the top few and the rest.
function ViewsChart({ weeks, pages }: { weeks: number[]; pages: PubPage[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const top = pages.filter(p => p.total > 0).slice(0, 4)
  const rest = weeks.map((_, i) => pages.filter(p => !top.includes(p)).reduce((n, p) => n + (p.weekly[i] ?? 0), 0))
  const layers = [...top.map(p => ({ name: p.title, v: p.weekly })), { name: 'Other pages', v: rest }]
  const totals = weeks.map((_, i) => layers.reduce((n, l) => n + (l.v[i] ?? 0), 0))
  const max = Math.max(1, ...totals), W = 600, H = 150, x = (i: number) => (i / Math.max(1, weeks.length - 1)) * W, y = (n: number) => H - (n / max) * (H - 8)
  let base = weeks.map(() => 0)
  const paths = layers.map((l, k) => {
    const lo = base, hi = base.map((b, i) => b + (l.v[i] ?? 0)); base = hi
    const d = `M${hi.map((n, i) => `${x(i)},${y(n)}`).join(' L')} L${lo.map((n, i) => `${x(i)},${y(n)}`).reverse().join(' L')} Z`
    return <path key={k} d={d} className={`wh-layer l${k === layers.length - 1 ? 'x' : k}`} />
  })
  const h = hover ?? weeks.length - 1
  return (
    <div className="wh-chart">
      <div className="wh-chart-head small"><b>{fmt(totals[h] ?? 0)}</b> views the week of {weeks[h] ? new Date(weeks[h]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}{h === weeks.length - 1 ? ' (so far)' : ''}
        <span className="muted"> · peak {fmt(max)}/week</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onMouseLeave={() => setHover(null)}
        onMouseMove={e => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); setHover(Math.max(0, Math.min(weeks.length - 1, Math.round(((e.clientX - r.left) / r.width) * (weeks.length - 1))))) }}>
        {paths}
        <line x1={x(h)} x2={x(h)} y1={0} y2={H} className="wh-cursor" />
      </svg>
      <div className="wh-legend small">{layers.map((l, k) => <span key={k}><i className={`l${k === layers.length - 1 ? 'x' : k}`} />{l.name.length > 38 ? l.name.slice(0, 36) + '…' : l.name} <span className="muted">{fmt(l.v[h] ?? 0)}</span></span>)}</div>
    </div>
  )
}
function Published({ pub }: { pub: Pub | null }) {
  const [all, setAll] = useState(false)
  if (!pub) return <section className="wh-sec"><h3>Published</h3><div className="muted small">Finding what you published…</div></section>
  if (pub.error) return <section className="wh-sec"><h3>Published</h3><div className="muted small">Couldn't list published pages: {pub.error}</div></section>
  const pages = pub.pages, v30 = pages.reduce((n, p) => n + p.views30, 0), tot = pages.reduce((n, p) => n + p.total, 0)
  return (
    <section className="wh-sec">
      <h3>Published <span className="muted small">{pages.length} pages on {pub.host} you created or have a byline on · {fmt(v30)} views in 30 days · {fmt(tot)} in 26 weeks</span>
        <a className="link small" href={pub.insight} target="_blank" rel="noreferrer">See more in PostHog ↗</a></h3>
      {pub.views_error && <div className="muted small">Views unavailable: {pub.views_error}</div>}
      {pub.pending_views && <div className="muted small">Loading views…</div>}
      {pub.weeks.length > 0 && <ViewsChart weeks={pub.weeks} pages={pages} />}
      <div className="wh-pub">
        <div className="wh-pub-row wh-pub-head muted small"><span>Page</span><span>26 weeks</span><span>30d views</span><span>30d visitors</span><span>Published</span></div>
        {pages.slice(0, all ? 200 : 6).map(p => (
          <a key={p.file} className="wh-pub-row" href={p.url} target="_blank" rel="noreferrer" title={p.url}>
            <span className="ellipsis"><b>{p.title}</b> <span className={`chip small ${p.kind === 'article' ? 'final' : ''}`}>{p.byline ? 'your post' : p.kind}</span> <span className="muted small">{p.path}</span></span>
            <Spark v={p.weekly} />
            <span>{fmt(p.views30)}</span><span>{fmt(p.visitors30)}</span>
            <span className="muted small">{p.published_at ? new Date(p.published_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''}</span>
          </a>))}
      </div>
      {pages.length > 6 && <button className="link small" onClick={() => setAll(a => !a)}>{all ? 'Show top 6' : `Show all ${pages.length}`}</button>}
    </section>
  )
}
