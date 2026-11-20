// Side by side, to decide whether conversations belong together: what each was asked, where it
// ended, when, where (repo and branch), PRs and state, with Claude's verdict on top.
import { useEffect, useState } from 'react'
import { SHOW_LABELS, ago, post, useLive } from './api'
import { Brand, sourceBrand } from './Brand'
import { PrBadge } from './List'

type C = { id: string; title: string; source: string; origin: string | null; cwd: string | null; branch: string | null; started_at: number; updated_at: number; messages: number; effective: string; labels: string[]; prs: any[]; first: string; last: string; url: string | null }
type Verdict = { verdict: 'same' | 'related' | 'different'; confidence: number; why: string; keep: string; notes?: Record<string, string>; at: number }

const date = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function Compare({ ids, onOpen, onDone }: { ids: string[]; onOpen: (id: string) => void; onDone: () => void }) {
  const { data, reload } = useLive<{ conversations: C[]; linked: any[]; verdict: Verdict | null }>(`/api/compare?ids=${ids.map(encodeURIComponent).join(',')}`, ['conversations'])
  const [judging, setJudging] = useState(false)
  const [keep, setKeep] = useState<string | null>(null)
  const [done, setDone] = useState('')
  const v = data?.verdict
  useEffect(() => { if (data && !data.verdict && !judging) { setJudging(true); post('/api/compare/judge', { ids }).then(() => { setJudging(false); reload() }) } }, [data?.verdict === null]) // eslint-disable-line
  useEffect(() => { if (v?.keep && !keep) setKeep(v.keep) }, [v]) // eslint-disable-line
  if (!data) return <div className="pad muted">…</div>
  const convs = data.conversations
  const act = async (archiveOthers: boolean) => {
    await post('/api/compare/link', { ids, keep: keep ?? convs[0]?.id, archiveOthers })
    setDone(archiveOthers ? 'Linked. The others are archived and point to the one you kept.' : 'Linked. Each shows the others under Connected conversations.')
  }
  return (
    <div className="page compare">
      <div className="row-flex"><h2 className="grow">Compare {convs.length} conversations</h2><button className="link small" onClick={onDone}>close</button></div>
      <div className={`card verdict ${v ? `v-${v.verdict}` : ''}`}>
        {v ? (
          <>
            <b>{v.verdict === 'same' ? 'Looks like the same work' : v.verdict === 'related' ? 'Related, but not the same' : 'Different things that look alike'} <span className="muted small">{Math.round(v.confidence * 100)}% sure</span></b>
            <span className="small">{v.why}</span>
          </>
        ) : <span className="muted small">{judging ? 'Claude is reading them to judge whether they are the same work…' : '…'}</span>}
        {data.linked.length > 0 && <span className="muted small">Already linked: {data.linked.length} link{data.linked.length > 1 ? 's' : ''}.</span>}
      </div>
      <div className="compare-grid">
        {convs.map(c => (
          <div key={c.id} className={`card compare-card ${keep === c.id ? 'keep' : ''}`}>
            <div className="row-flex">
              <Brand id={sourceBrand(c)} size={14} />
              <button className="link compare-title" onClick={() => onOpen(c.id)}>{c.title}</button>
            </div>
            <div className="muted small">Started {date(c.started_at)} · last active {ago(c.updated_at)} ago · {c.messages} messages</div>
            <div className="muted small">{c.cwd ? c.cwd.replace(/^\/Users\/[^/]+/, '~') : c.origin ?? c.source}{c.branch ? ` · ${c.branch}` : ''} · <span className={`s-${c.effective}`} style={{ color: 'var(--c)' }}>{c.effective}</span></div>
            {(c.labels.length > 0 || c.prs.length > 0) && <div className="row-flex">{SHOW_LABELS && c.labels.map(l => <span key={l} className="label">#{l}</span>)}{c.prs.slice(0, 4).map(p => <PrBadge key={p.url} pr={p} />)}</div>}
            {v?.notes?.[c.id] && <div className="small unique">Unique: {v.notes[c.id]}</div>}
            <div className="compare-section"><h4>It started with</h4><div className="small clamp4">{c.first || '—'}</div></div>
            <div className="compare-section"><h4>Where it ended</h4><div className="small clamp4">{c.last || '—'}</div></div>
            <label className="toggle small"><input type="radio" name="keep" checked={keep === c.id} onChange={() => setKeep(c.id)} /> keep working in this one</label>
          </div>
        ))}
      </div>
      {done ? <div className="card notice ok"><b>{done}</b></div> : (
        <div className="row-flex">
          <button className="primary" onClick={() => act(false)} title="Connect them; nothing is archived">Link them</button>
          <button onClick={() => act(true)} title="Link them, keep the selected one, archive the rest">Consolidate into the kept one</button>
          <button className="link small" onClick={onDone}>keep separate</button>
        </div>
      )}
    </div>
  )
}
