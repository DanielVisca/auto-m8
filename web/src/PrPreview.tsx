// The PR at a glance: what it says, what it touches, checks, and what reviewers still want.
// Threads whose code has since changed ("outdated") are counted separately: likely already fixed.
import { useEffect, useState } from 'react'
import { ago, useLive } from './api'
import { Markdown } from './Chat'
import { Brand, sourceBrand } from './Brand'
import { AgentRows, usePrAgents } from './Agents'

// inPage: on the PR's own page, which already shows the title, the agents and the conversations.
export function PrPreviewCard({ url, inPage, brief }: { url: string; inPage?: boolean; brief?: { title?: string; author?: string } }) {
  // Paints the last copy of this PR at once (browser cache), then swaps in GitHub's answer when it lands.
  const { data: cached, error, loading, stale } = useLive<any>(`/api/pr/preview?url=${encodeURIComponent(url)}`)
  const p = stale ? undefined : cached
  const agents = usePrAgents(url)
  // Title and owner show at once from the brief the pill already holds (fetched only when there is none); the rest fills in.
  const [fetched, setFetched] = useState<any>(null)
  useEffect(() => { if (brief?.author) return; let live = true; fetch(`/api/pr/brief?url=${encodeURIComponent(url)}`).then(r => r.ok ? r.json() : null).then(d => live && setFetched(d)).catch(() => {}); return () => { live = false } }, [url, brief?.author])
  const b = brief?.author ? brief : fetched
  if (error && !p) return <div className="pr-card muted small">{error}</div>
  if (!p) return (
    <div className="pr-card">
      {b?.title && !inPage && <div className="pr-card-head"><b>{b.title}</b></div>}
      {b?.author && <div className="pr-owner small"><Avatar login={b.author} /><span>opened by <b>{b.author}</b></span></div>}
      <div className="muted small">Loading the rest…</div>
    </div>)
  const blocking = (p.reviews ?? []).filter((r: any) => r.state === 'CHANGES_REQUESTED')
  const chk = p.checks.failing.length ? 'bad' : p.checks.state === 'SUCCESS' ? 'ok' : 'pending'
  return (
    <div className="pr-card">
      {!inPage && <div className="pr-card-head"><b className="grow">{p.title}</b><Freshness loading={loading} fetchedAt={p.fetchedAt} error={error} hasData /></div>}
      {p.author && <div className="pr-owner small"><Avatar login={p.author} /><span>opened by <b>{p.author}</b></span></div>}
      <div className="pr-pills small">
        <span className={`pr-pill st-${p.state}`}>{p.state}</span>
        {p.review && <span className={`pr-pill rv-${p.review}`}>{p.review === 'APPROVED' ? '✓ approved' : p.review === 'CHANGES_REQUESTED' ? '! changes' : '⧗ review'}</span>}
        <span className={`pr-pill ck-${chk}`} title={p.checks.failing.join('\n')}>{chk === 'bad' ? `✗ ${p.checks.failing.length}` : chk === 'ok' ? '✓ checks' : '• checks'}</span>
        <Diff add={p.additions} del={p.deletions} />
        <span className="muted grow right">{ago(Date.parse(p.updatedAt))} ago</span>
      </div>
      <div className="muted small ellipsis" title={`${p.head} → ${p.base}`}>{p.head} → {p.base}</div>
      {!inPage && <div className="small pr-watch">{agents.length ? <AgentRows list={agents} /> : <span className="muted">○ No agent is on this PR right now.</span>}</div>}
      {(blocking.length > 0 || p.open.length > 0) && (
        <div className="pr-section">
          <h4>Unresolved review comments <span className="muted">{blocking.length + p.open.length}</span></h4>
          {/* Review comments look like GitHub: the reviewer's face and a rule down the side. */}
          {blocking.map((r: any, i: number) => (
            <div key={'r' + i} className="pr-comment blocking small">
              <div className="pr-comment-head"><Avatar login={r.author} /><b>{r.author}</b></div>
              <div className="pr-md"><Markdown text={r.body} /></div>
            </div>))}
          {p.open.slice(0, 5).map((t: any, i: number) => (
            <div key={i} className="pr-comment small">
              <div className="pr-comment-head"><Avatar login={t.author} /><b>{t.author}</b>
                <a className="ellipsis grow pr-path" href={t.url ?? p.url} target="_blank" rel="noreferrer" title={`${t.path ?? 'PR'}${t.line ? `:${t.line}` : ''} on GitHub`}><code>{String(t.path ?? 'conversation').split('/').pop()}{t.line ? `:${t.line}` : ''}</code></a>
                {t.replies > 0 && <span className="muted">↩ {t.replies}</span>}</div>
              <div className="pr-md pr-thread-body"><Markdown text={t.body} /></div>
            </div>))}
          {p.open.length > 5 && <a className="muted small" href={p.url} target="_blank" rel="noreferrer">+{p.open.length - 5} more on GitHub</a>}
        </div>
      )}
      {p.outdated > 0 && <div className="muted small">{p.outdated} unresolved thread{p.outdated > 1 ? 's are' : ' is'} outdated: the code under {p.outdated > 1 ? 'them' : 'it'} changed, so probably fixed.</div>}
      {!blocking.length && !p.open.length && <div className="small ok-text">No unresolved review threads.</div>}
      {!inPage && p.conversations?.length > 0 && (
        <div className="pr-section"><h4>Conversations about it</h4>
          {/* Conversations look like perch: a tile with the app it lives in. */}
          <div className="pr-convs">{p.conversations.map((c: any) => (
            <a key={c.id} className="small pr-conv" href={`#${c.source === "posthog-task" ? "task" : "chat"}/${encodeURIComponent(c.id)}`} title="Open in auto-m8">
              <Brand id={sourceBrand(c)} size={14} /><span className="ellipsis grow">{String(c.title ?? '').replace(/^\[[^\]]*\]\s*/, '')}</span>
              {c.status === 'in_progress' && <span className="dot s-running" />}<span className="muted">{ago(c.updated_at)}</span>
            </a>))}</div>
        </div>)}
      {p.body && <div className="pr-section"><h4>Description</h4><div className="pr-body pr-md"><Markdown text={p.body} /></div></div>}
      <details className="pr-section pr-files">
        <summary className="small"><span className="muted">{p.changedFiles} file{p.changedFiles === 1 ? '' : 's'}</span> <Diff add={p.additions} del={p.deletions} /></summary>
        {p.files.slice(0, 40).map((f: any) => {
          const parts = String(f.path ?? '').split('/'), name = parts.pop()
          return <div key={f.path} className="small pr-file" title={f.path}><span className="ellipsis grow"><span className="muted">{parts.join('/')}/</span>{name}</span><Diff add={f.additions} del={f.deletions} /></div>
        })}
        {p.changedFiles > 40 && <a className="muted small" href={`${p.url}/files`} target="_blank" rel="noreferrer">+{p.changedFiles - 40} more on GitHub</a>}
      </details>
    </div>
  )
}

// +/− in green and red, with GitHub's five-block bar for the balance.
function Diff({ add, del }: { add: number; del: number }) {
  const total = add + del, g = total ? Math.round((5 * add) / total) : 0
  return (
    <span className="pr-diff" title={`${add} added, ${del} removed`}>
      <span className="ok-text">+{add}</span> <span className="bad">−{del}</span>
      <span className="pr-blocks">{Array.from({ length: 5 }, (_, i) => <i key={i} className={!total ? '' : i < g ? 'a' : 'd'} />)}</span>
    </span>
  )
}

function Avatar({ login }: { login?: string }) {
  if (!login) return null
  return <img className="pr-avatar" src={`https://github.com/${login.replace(/\[bot\]$/, '')}.png?size=40`} alt="" onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }} />
}

// How fresh the PR on screen is: the cached copy shows at once, with "pulling update" while GitHub answers.
export function Freshness({ loading, fetchedAt, error, hasData }: { loading: boolean; fetchedAt?: number; error?: string | null; hasData: boolean }) {
  if (!hasData) return null
  if (loading) return <span className="muted small nowrap pr-fresh" title="Showing the last copy while the latest comes from GitHub"><span className="spin" /> Pulling update…</span>
  if (error) return <span className="muted small nowrap pr-fresh" title={error}>⚠ couldn’t refresh{fetchedAt ? ` · ${ago(fetchedAt)} old` : ''}</span>
  return fetchedAt ? <span className="muted small nowrap pr-fresh" title={new Date(fetchedAt).toLocaleString()}>updated {ago(fetchedAt) === 'now' ? 'just now' : `${ago(fetchedAt)} ago`}</span> : null
}
