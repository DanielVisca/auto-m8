// Writing home (Explore → Writing, and #writing): one place to write, review, draft and share.
// Your docs, the shelf of drafted posts and captured ideas an agent keeps, docs waiting on review
// comments, and where finished pieces can go. Everything opens in the docs editor.
import { useMemo, useState } from 'react'
import { ago, post, toast, useLive } from './api'
import './writing.css'

type Doc = { id: string; path: string; title: string; status: 'draft' | 'final'; agent_text: 'allowed' | 'blocked'; updated_at: number; open_comments?: number; research?: number; exists: boolean }
type ShelfPost = { slug: string; title: string; point: string; status: string; words: number; draft: string; worksheet: string | null; updated_at: number }
type Idea = { file: string; path: string; title: string; point: string; captured: string; updated_at: number }
type Dest = { id: string; name: string; status: 'ready' | 'planned'; how: string }
export type WritingData = {
  docs: Doc[]; dir: string; reviews: number; destinations: Dest[]
  shelf: null | { dir: string; readme: string | null; posts: ShelfPost[]; ideas: Idea[]; last_run: { file: string; path: string; at: number } | null }
}
export const useWriting = () => useLive<WritingData>('/api/explore/writing', ['docs'], undefined, 60_000).data

const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')
const ready = (s: string) => /draft-for-edit|ready|final/i.test(s)

export function WritingHome({ onOpenDoc, onStart, onBack }: { onOpenDoc: (id: string) => void; onStart: (prompt?: string) => void; onBack?: () => void }) {
  const data = useWriting()
  const [path, setPath] = useState('')
  const [q, setQ] = useState('')
  const [showAll, setShowAll] = useState(false)
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
        <Stat n={reviewing.reduce((n, d) => n + (d.open_comments ?? 0), 0)} label="open review comments" sub={`on ${reviewing.length} docs`} />
      </div>

      {reviewing.length > 0 && <section className="wh-sec">
        <h3>Waiting on you <span className="muted small">comments from reviewers and agents</span></h3>
        {reviewing.map(d => <DocRow key={d.id} d={d} onOpen={() => onOpenDoc(d.id)} />)}
      </section>}

      <section className="wh-sec">
        <h3>Your docs <span className="muted small">in {tilde(data.dir)}; any markdown file opens too</span></h3>
        <div className="row-flex wh-open">
          <input className="grow" value={path} placeholder="Open a .md file: ~/path/to/file.md" onChange={e => setPath(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && path.trim()) open({ path: path.trim() }) }} />
          <button disabled={!path.trim()} onClick={() => open({ path: path.trim() })}>Open</button>
        </div>
        {!mine.length && <div className="muted small">{q ? 'Nothing matches.' : 'No docs yet.'}</div>}
        {mine.slice(0, showAll ? 50 : 8).map(d => <DocRow key={d.id} d={d} onOpen={() => onOpenDoc(d.id)} onReview={() => review(d.path)} />)}
        {mine.length > 8 && <button className="link small" onClick={() => setShowAll(s => !s)}>{showAll ? 'Show fewer' : `Show all ${mine.length}`}</button>}
      </section>

      {shelf ? <>
        <section className="wh-sec">
          <h3>Drafted posts <span className="muted small">the blog shelf agents keep{shelf.last_run ? ` · last pass ${ago(shelf.last_run.at)}` : ''}</span>
            {shelf.readme && <button className="link small" onClick={() => open({ path: shelf.readme! })}>shelf notes</button>}</h3>
          <div className="wh-grid">{posts.map(p => (
            <div key={p.slug} className="wh-card">
              <button className="wh-card-main" onClick={() => open({ path: p.draft })} title={tilde(p.draft)}>
                <b>{p.title}</b>
                {p.point && <span className="muted small">{p.point}</span>}
                <span className="small"><span className={`chip small ${ready(p.status) ? 'final' : ''}`}>{p.status}</span> {p.words} words · {ago(p.updated_at)}</span>
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
          <h3>Ideas <span className="muted small">lessons agents noticed while working; the strongest become drafts</span></h3>
          {ideas.slice(0, 12).map(i => (
            <div key={i.file} className="writing-row wh-idea">
              <button className="link grow ellipsis" onClick={() => open({ path: i.path })} title={i.point || tilde(i.path)}><b>{i.title}</b>{i.point && <span className="muted small"> · {i.point}</span>}</button>
              <span className="muted small">{i.captured}</span>
              <button className="small" onClick={() => develop(i)}>Draft it</button>
            </div>))}
          {ideas.length > 12 && <div className="muted small">and {ideas.length - 12} more in {tilde(shelf.dir)}/inbox</div>}
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
export function WritingArt({ data }: { data?: WritingData }) {
  const seen = new Set<string>()
  const titles = [...(data?.docs ?? []).map(d => ({ k: d.path, t: d.title || 'Untitled', at: d.updated_at })), ...(data?.shelf?.posts ?? []).map(p => ({ k: p.draft, t: p.title, at: p.updated_at }))]
    .sort((a, b) => b.at - a.at).filter(x => !seen.has(x.k) && !!seen.add(x.k)).slice(0, 4)
  if (!titles.length) return <span className="muted">No writing yet</span>
  return <div className="wh-art">{titles.map((x, i) => <div key={i} className="wh-page"><b>{x.t}</b><i /><i /><i /></div>)}</div>
}
