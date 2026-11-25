// "Is it actually ready to merge?" with the evidence, and the rounds it went through to get here.
import { useState } from 'react'
import { ago, post, toast, useLive } from './api'

type Check = { id: string; ok: boolean | null; label: string; detail: string }
type Round = { n: number; at: number; comments: number; reviewers: { who: string; bot: boolean; states: string[] }[]; answer: { commits: number; rebases: number; replies: number; labels: string[]; at: number | null } }
type Ship = { line: string | null; merge: string; how: string; on: string; off: string | null }
type J = { url: string; state: string; merged: number | null; ready: boolean; queued: { by: string; at: number } | null; ship?: Ship; checks: Check[]; opened: { at: number; commits: number }; rounds: Round[]; totals: { rounds: number; agentRounds: number; humanReviewers: string[] } }

const mark = (ok: boolean | null) => ok === true ? <span className="ok-text">✓</span> : ok === false ? <span className="bad">✗</span> : <span className="warn">•</span>
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

export function ReadyCard({ url }: { url: string }) {
  const { data: j, error, reload } = useLive<J>(`/api/pr/journey?url=${encodeURIComponent(url)}`, ['conversations'])
  const [busy, setBusy] = useState(false)
  if (error) return <section className="card"><div className="muted small">{error}</div></section>
  if (!j) return <section className="card"><div className="muted small">Checking whether it’s ready…</div></section>
  const left = j.checks.filter(c => c.ok !== true)
  const ship: Ship = j.ship ?? { line: null, merge: 'trunk', how: 'Comments /trunk merge: Trunk merges it once it passes in the queue', on: 'Add to merge queue', off: 'Remove from queue' }
  const queue = async (on: boolean) => {
    setBusy(true)
    const r = await post<any>('/api/pr/queue', { pr: url, on })
    setBusy(false)
    toast(r.message ?? (r.ok ? 'Done.' : 'That didn’t work.'), { kind: r.ok ? 'ok' : 'error' })
    fetch(`/api/pr/journey?url=${encodeURIComponent(url)}&fresh=1`).then(reload)
  }
  return (
    <section className={`card ready-card ${j.state !== 'OPEN' ? '' : j.ready ? 'is-ready' : 'not-ready'}`}>
      <div className="row-flex">
        <h3 className="grow">{j.state === 'MERGED' ? `Merged ${ago(j.merged)} ago` : j.state === 'CLOSED' ? 'Closed' : j.queued ? `In the merge queue · added by ${j.queued.by} ${ago(j.queued.at)} ago` : j.ready ? '✓ Ready to merge' : `Not ready yet · ${plural(left.length, 'thing')} left`}</h3>
        {j.state === 'OPEN' && (j.queued
          ? ship.off && <button disabled={busy} onClick={() => queue(false)} title={ship.merge === 'trunk' ? 'Comments /trunk unmerge' : ship.off}>{busy ? '…' : ship.off}</button>
          : <button className="primary" disabled={busy || !j.ready} onClick={() => queue(true)} title={j.ready ? ship.how : 'Every check below needs to pass first'}>{busy ? 'Working…' : ship.on}</button>)}
        <button className="icon" onClick={() => fetch(`/api/pr/journey?url=${encodeURIComponent(url)}&fresh=1`).then(reload)} title="Check again">↻</button>
      </div>
      {ship.line && <div className="muted small ship-line" title="How this repo reviews, merges, tests, deploys and is verified, detected from its last 30 merged PRs">{ship.line}{' '}
        <button className="link small" title="Detect it again now" onClick={() => fetch(`/api/ship-profile?repo=${encodeURIComponent(url.split('/').slice(3, 5).join('/'))}&refresh=1`).then(() => fetch(`/api/pr/journey?url=${encodeURIComponent(url)}&fresh=1`)).then(reload)}>↻</button></div>}
      {j.state === 'OPEN' && <div className="checklist">{j.checks.map(c => (
        <div key={c.id} className="small check-row">{mark(c.ok)}<span><b>{c.label}</b>{c.detail && <span className="muted"> · {c.detail}</span>}</span></div>))}</div>}
    </section>
  )
}

export function JourneyCard({ url }: { url: string }) {
  const { data: j } = useLive<J>(`/api/pr/journey?url=${encodeURIComponent(url)}`, ['conversations'])
  if (!j) return null
  const t = j.totals
  return (
    <section className="card">
      <h4>Journey <span className="muted">· {plural(t.rounds, 'review round')}{t.rounds ? `, ${t.agentRounds === t.rounds ? 'all by agents' : `${t.agentRounds} agent-only`}` : ''}{t.humanReviewers.length ? ` · people: ${t.humanReviewers.join(', ')}` : ' · no human reviews'}</span></h4>
      <ol className="journey">
        <li><span className="j-dot" /><div className="small"><b>Opened</b> <span className="muted">{ago(j.opened.at)} ago{j.opened.commits ? ` · ${plural(j.opened.commits, 'commit')}` : ''}</span></div></li>
        {j.rounds.map(r => {
          const verdict = (x: Round['reviewers'][number]) => x.states.includes('APPROVED') ? '✓' : x.states.includes('CHANGES_REQUESTED') ? '!' : ''
          const a = r.answer
          const answered = [a.commits && plural(a.commits, 'commit'), a.rebases && plural(a.rebases, 'rebase'), a.replies && plural(a.replies, 'reply'), ...a.labels.map(l => `label ${l}`)].filter(Boolean).join(', ')
          return (
            <li key={r.n}>
              <span className={`j-dot ${r.reviewers.some(x => !x.bot) ? 'human' : 'agent'}`} />
              <div className="small">
                <div><b>Round {r.n}</b> <span className="muted">{ago(r.at)} ago · {plural(r.comments, 'comment')}</span></div>
                <div className="j-who">{r.reviewers.map(x => <span key={x.who} className={`j-person ${x.bot ? 'bot' : 'human'}`} title={x.bot ? 'agent / bot' : 'person'}>{x.bot ? '🤖' : '👤'} {x.who}{verdict(x) && <b className={verdict(x) === '✓' ? 'ok-text' : 'bad'}> {verdict(x)}</b>}</span>)}</div>
                <div className="muted">{answered ? `→ answered with ${answered}` : '→ not answered yet'}</div>
              </div>
            </li>)
        })}
        {j.queued && <li><span className="j-dot queue" /><div className="small"><b>Queued</b> <span className="muted">by {j.queued.by} {ago(j.queued.at)} ago</span></div></li>}
        {j.merged && <li><span className="j-dot merged" /><div className="small"><b>Merged</b> <span className="muted">{ago(j.merged)} ago</span></div></li>}
      </ol>
    </section>
  )
}
