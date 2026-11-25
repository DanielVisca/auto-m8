// Git explorer (Explore → Git): what's on this Mac and what became of it. Worktrees, branches, what is
// committed and pushed, what is stranded locally, and whether branches get merged or pile up.
// Read-only; the server reads git and caches for a few minutes.
import { useEffect, useMemo, useState } from 'react'
import { ago, sendChat, shortPath } from './api'
import './gitexplorer.css'

type Fate = 'merged' | 'open-pr' | 'closed-pr' | 'pushed' | 'local-only' | 'empty'
type Branch = { name: string; lastCommit: number; subject: string; author: string; mine: boolean; upstream: string | null; ahead: number | null; behind: number | null; gone: boolean; unpushed: number | null; approx?: boolean; merged: boolean; pr: { url: string; number: number; state: string } | null; worktree: string | null; current: boolean; fate: Fate; stale: boolean }
type Tree = { path: string; branch: string | null; head: string | null; dirty: number | null; unique: number | null; lastUsed: number; running: number; conversations: number; managed: boolean; keep: string | null; orphaned: boolean }
type Week = { week: number; opened: number; merged: number; closed: number }
type Summary = Record<Fate, number> & { total: number; stale: number; strandedBranches: number; strandedCommits: number; orphanedWorktrees: number; mergeRate: number | null }
type RepoGit = { path: string; name: string; slug: string | null; defaultBranch: string; at: number; ms: number; current: string | null; dirty: number | null; branches: Branch[]; worktrees: Tree[]; weeks: Week[]; prsKnown: boolean; summary: Summary; error?: string }
type Over = { path: string; name: string; summary?: Summary; current?: string | null; dirty?: number | null; error?: string; stranded?: { name: string; unpushed: number; lastCommit: number; subject: string }[]; orphaned?: Tree[] }

const FATES: { k: Fate; label: string; color: string; tip: string }[] = [
  { k: 'merged', label: 'merged', color: 'var(--ok)', tip: 'Merged into the default branch (or its PR merged). Safe to delete.' },
  { k: 'open-pr', label: 'open PR', color: 'var(--accent)', tip: 'Has an open pull request.' },
  { k: 'pushed', label: 'pushed, no PR', color: 'var(--warn)', tip: 'On GitHub but no PR of yours: forgotten, or someone else\'s branch you checked out.' },
  { k: 'closed-pr', label: 'closed unmerged', color: 'var(--muted)', tip: 'Its PR was closed without merging: abandoned.' },
  { k: 'local-only', label: 'local only', color: 'var(--bad)', tip: 'Has commits that are on no remote: lost if this Mac goes.' },
  { k: 'empty', label: 'no own commits', color: 'var(--line)', tip: 'Nothing beyond the default branch or its remote copy: nothing to lose.' },
]
const fateOf = (k: Fate) => FATES.find(f => f.k === k)!
// Branches agents make (helpers, shepherds, autoresearch, Codex, PostHog Code) vs ones you name yourself.
const AGENT = /^(perch\/|shepherd|codex\/|autoresearch\/|posthog-code\/|claude\/|worktree-|agent-|local\/)/
const isAgent = (b: string | null) => !!b && AGENT.test(b)
const qs = (o: Record<string, string>) => new URLSearchParams(o).toString()

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url)
  const j = await r.json()
  if (j?.error) throw new Error(j.error)
  return j
}

export function GitExplorer({ repo, onPickRepo, onOpenChat }: { repo: string; onPickRepo: (p: string) => void; onOpenChat: (id: string) => void }) {
  const [g, setG] = useState<RepoGit | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [fates, setFates] = useState<Set<Fate>>(new Set())
  const [who, setWho] = useState<'all' | 'you' | 'agents'>('all')
  const [q, setQ] = useState('')
  const [over, setOver] = useState<Over[] | null>(null)
  const [overLoading, setOverLoading] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const load = (fresh = false) => {
    if (!repo) return
    setLoading(true); setErr(null)
    getJson<RepoGit>(`/api/git/repo?${qs({ path: repo, ...(fresh ? { fresh: '1' } : {}) })}`).then(setG, e => setErr(String(e.message ?? e))).finally(() => setLoading(false))
  }
  useEffect(() => { setG(null); load() }, [repo]) // eslint-disable-line
  const loadOver = (fresh = false) => { setOverLoading(true); getJson<{ repos: Over[] }>(`/api/git/overview${fresh ? '?fresh=1' : ''}`).then(r => setOver(r.repos), e => setErr(String(e.message ?? e))).finally(() => setOverLoading(false)) }

  const shown = useMemo(() => (g?.branches ?? []).filter(b =>
    (!fates.size || fates.has(b.fate)) && (who === 'all' || (who === 'agents') === isAgent(b.name)) && (!q || (b.name + ' ' + b.subject).toLowerCase().includes(q.toLowerCase()))), [g, fates, who, q])
  const toggle = (f: Fate) => { const n = new Set(fates); n.has(f) ? n.delete(f) : n.add(f); setFates(n) }

  const triage = async () => {
    if (!g) return
    const stranded = g.branches.filter(b => b.fate === 'local-only')
    const orphans = g.worktrees.filter(w => w.orphaned)
    const p = `Triage the stranded local git work in ${g.path} (default branch ${g.defaultBranch}). Don't delete, push or change anything yet.\n\nLocal-only branches (commits on no remote):\n${stranded.slice(0, 80).map(b => `- ${b.name}: ${b.unpushed} commit(s), last ${new Date(b.lastCommit).toISOString().slice(0, 10)}${b.worktree ? `, checked out at ${b.worktree}` : ''}: ${b.subject}`).join('\n') || 'none'}\n\nWorktrees with uncommitted or unique work, idle 2+ weeks:\n${orphans.map(w => `- ${w.path} (${w.branch ?? 'detached'}): ${w.dirty ?? '?'} uncommitted, ${w.unique ?? '?'} unique commits`).join('\n') || 'none'}\n\nFor each, look at the actual diff and say: keep (and how: push / open a PR), already landed another way (squash-merged, superseded: name the PR or commit), or safe to drop. Group the answer by those three, smallest first, then give the exact git commands for the drop list so I can approve them in one go.`
    const c = await sendChat<{ id: string }>({ prompt: p, cwd: g.path, noRoute: true })
    onOpenChat(c.id)
  }

  if (!repo) return <div className="card muted">Pick a repo above to see its branches and worktrees.</div>
  const s = g?.summary
  const maxWeek = Math.max(1, ...(g?.weeks ?? []).map(w => Math.max(w.opened, w.merged + w.closed)))
  const trees = (g?.worktrees ?? []).filter(w => showAll || w.orphaned || (w.dirty ?? 0) > 0 || (w.unique ?? 0) > 0 || !!w.keep?.startsWith('folder is gone'))

  return (
    <div className="gx">
      <div className="gx-bar">
        <b>{g?.name ?? shortPath(repo)}</b>
        {g && <span className="muted small">on <code>{g.current}</code>{g.dirty ? <> · <span className="warn">{g.dirty} uncommitted in the main checkout</span></> : null} · read {ago(g.at)} ago in {(g.ms / 1000).toFixed(1)}s</span>}
        <span className="gx-sp" />
        <button className="small" disabled={loading} onClick={() => load(true)} title="Read git again now (a big repo takes ~30s)">{loading ? 'Reading git…' : '↻ Refresh'}</button>
        <button className="small" disabled={!g || !s?.strandedBranches && !s?.orphanedWorktrees} onClick={triage} title="An agent reads each stranded branch and idle worktree and sorts them into keep / already landed / safe to drop. Changes nothing.">Triage stranded work with an agent</button>
        <button className="small" onClick={() => { if (!over) loadOver(); else setOver(null) }}>{over ? 'Hide all repos' : 'All repos'}</button>
      </div>
      {err && <div className="card bad">{err}</div>}
      {!g && !err && <div className="card muted">Reading branches, PRs and worktrees… a big repo (hundreds of branches, 100+ worktrees) can take a minute the first time; after that it opens at once.</div>}

      {(over || overLoading) && (
        <div className="card gx-over">
          <div className="gx-h">Every repo on this Mac {overLoading && <span className="muted small">reading… (about a minute the first time)</span>} <button className="link small" onClick={() => loadOver(true)}>refresh</button></div>
          {over && <table className="gx-table">
            <thead><tr><th>repo</th><th title="Branches with commits on no remote">local only</th><th title="Commits only on this Mac">stranded commits</th><th title="Worktrees with uncommitted or unique work, idle 2+ weeks, no agent in them">idle worktrees with work</th><th title="Unmerged, no commit in 2 weeks">stale</th><th>branches</th><th title="Of your PRs that were closed, how many merged">merge rate</th></tr></thead>
            <tbody>{[...over].sort((a, b) => ((b.summary?.strandedCommits ?? 0) + 50 * (b.summary?.orphanedWorktrees ?? 0)) - ((a.summary?.strandedCommits ?? 0) + 50 * (a.summary?.orphanedWorktrees ?? 0))).map(r => (
              <tr key={r.path} className={r.path === repo ? 'on' : ''} onClick={() => onPickRepo(r.path)} title={r.path}>
                <td><b>{r.name}</b>{over.filter(o => o.name === r.name).length > 1 && <span className="muted small"> {shortPath(r.path)}</span>}{r.error && <span className="bad small"> {r.error}</span>}{r.dirty ? <span className="warn small"> · {r.dirty} uncommitted</span> : null}</td>
                <td className={r.summary?.strandedBranches ? 'bad' : 'muted'}>{r.summary?.strandedBranches ?? '–'}</td>
                <td className={r.summary?.strandedCommits ? 'bad' : 'muted'}>{r.summary?.strandedCommits ?? '–'}</td>
                <td className={r.summary?.orphanedWorktrees ? 'warn' : 'muted'}>{r.summary?.orphanedWorktrees ?? '–'}</td>
                <td>{r.summary?.stale ?? '–'}</td>
                <td>{r.summary?.total ?? '–'}</td>
                <td>{r.summary?.mergeRate != null ? `${Math.round(r.summary.mergeRate * 100)}%` : '–'}</td>
              </tr>))}</tbody>
          </table>}
        </div>
      )}

      {g && s && <>
        <div className="gx-tiles">
          <Tile label="stranded commits" value={s.strandedCommits} sub={`in ${s.strandedBranches} local-only branch${s.strandedBranches === 1 ? '' : 'es'}`} bad={s.strandedCommits > 0} onClick={() => setFates(new Set(['local-only']))} />
          <Tile label="idle worktrees with work" value={s.orphanedWorktrees} sub={`of ${g.worktrees.length} worktrees`} bad={s.orphanedWorktrees > 0} />
          <Tile label="stale branches" value={s.stale} sub="unmerged, untouched 2+ weeks" />
          <Tile label="merge rate" value={s.mergeRate != null ? `${Math.round(s.mergeRate * 100)}%` : '–'} sub={g.prsKnown ? 'of your closed PRs, merged' : 'GitHub not reachable'} />
          <Tile label="branches" value={s.total} sub={`${s.merged} merged · ${s['open-pr']} open PR`} />
        </div>

        <div className="card">
          <div className="gx-h">What became of each branch <span className="muted small">click to filter</span></div>
          <div className="gx-fatebar">{FATES.map(f => s[f.k] ? <div key={f.k} title={`${f.label}: ${s[f.k]} · ${f.tip}`} onClick={() => toggle(f.k)} style={{ flex: s[f.k], background: f.color, opacity: fates.size && !fates.has(f.k) ? 0.3 : 1 }} /> : null)}</div>
          <div className="gx-legend small">{FATES.map(f => <button key={f.k} className={'gx-chip' + (fates.has(f.k) ? ' on' : '')} title={f.tip} onClick={() => toggle(f.k)}><i style={{ background: f.color }} />{f.label} <b>{s[f.k]}</b></button>)}</div>
        </div>

        {g.prsKnown && <div className="card">
          <div className="gx-h">Your PRs per week <span className="muted small">opened vs merged and closed unmerged, last 12 weeks</span></div>
          <div className="gx-weeks">{g.weeks.map(w => (
            <div key={w.week} className="gx-week" title={`Week of ${new Date(w.week).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: ${w.opened} opened, ${w.merged} merged, ${w.closed} closed unmerged`}>
              <div className="gx-cols">
                <div style={{ height: `${(w.opened / maxWeek) * 100}%`, background: 'var(--accent)' }} />
                <div className="gx-stack"><div style={{ height: `${(w.closed / maxWeek) * 100}%`, background: 'var(--muted)' }} /><div style={{ height: `${(w.merged / maxWeek) * 100}%`, background: 'var(--ok)' }} /></div>
              </div>
              <span className="muted">{new Date(w.week).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}</span>
            </div>))}</div>
          <div className="small muted"><i className="gx-dot" style={{ background: 'var(--accent)' }} /> opened <i className="gx-dot" style={{ background: 'var(--ok)' }} /> merged <i className="gx-dot" style={{ background: 'var(--muted)' }} /> closed unmerged</div>
        </div>}

        <div className="card">
          <div className="gx-h">Worktrees <span className="muted small">{showAll ? `all ${g.worktrees.length}` : `${trees.length} with work in them (of ${g.worktrees.length})`}</span> <button className="link small" onClick={() => setShowAll(!showAll)}>{showAll ? 'only ones with work' : 'show all'}</button></div>
          {trees.length ? <table className="gx-table">
            <thead><tr><th>path</th><th>branch</th><th title="Tracked files changed and not committed">uncommitted</th><th title="Commits on no remote">unpushed</th><th>last used</th><th /></tr></thead>
            <tbody>{trees.map(w => (
              <tr key={w.path} className={w.orphaned ? 'gx-orphan' : ''} title={w.keep ?? ''}>
                <td><span data-path={w.path} data-dir="1" title={`${w.path} (right-click: Show in Finder)`}>{shortPath(w.path)}</span></td>
                <td><code>{w.branch ?? (w.head ? `detached ${w.head}` : '?')}</code></td>
                <td className={w.dirty ? 'warn' : 'muted'}>{w.dirty ?? '?'}</td>
                <td className={w.unique ? 'bad' : 'muted'}>{w.unique ?? '?'}</td>
                <td>{ago(w.lastUsed)}</td>
                <td className="small">{w.running ? <span className="ok">agent working</span> : w.orphaned ? <span className="bad">idle with work</span> : w.managed ? <span className="muted">auto-m8</span> : ''}{w.keep?.startsWith('folder is gone') || w.keep?.startsWith('not checked') ? <span className="muted"> {w.keep}</span> : null}</td>
              </tr>))}</tbody>
          </table> : <div className="muted small">No worktree has uncommitted or unpushed work.</div>}
        </div>

        <div className="card">
          <div className="gx-h">Branches <span className="muted small">{shown.length} of {g.branches.length}, newest first</span>
            <span className="gx-sp" />
            {(['all', 'you', 'agents'] as const).map(k => <button key={k} className={'gx-chip' + (who === k ? ' on' : '')} onClick={() => setWho(k)} title={k === 'agents' ? 'Branches agents made: perch/, shepherd, codex/, posthog-code/, autoresearch/…' : ''}>{k}</button>)}
            <input className="gx-q" placeholder="filter" value={q} onChange={e => setQ(e.target.value)} />
            {fates.size > 0 && <button className="link small" onClick={() => setFates(new Set())}>clear filter</button>}
          </div>
          <table className="gx-table">
            <thead><tr><th>branch</th><th>fate</th><th>last commit</th><th title="Commits on no remote">unpushed</th><th>PR</th><th>last commit message</th></tr></thead>
            <tbody>{shown.slice(0, 400).map(b => { const f = fateOf(b.fate); return (
              <tr key={b.name} className={b.stale ? 'gx-stale' : ''}>
                <td><code>{b.name}</code>{b.current && <span className="gx-chip on small">checked out</span>}{b.worktree && <span className="muted small" title={b.worktree}> ⑂ worktree</span>}</td>
                <td><span className="gx-fate" title={f.tip}><i style={{ background: f.color }} />{f.label}</span>{b.gone && <span className="muted small" title="Its remote branch was deleted (usually after the PR merged)"> · remote deleted</span>}</td>
                <td title={new Date(b.lastCommit).toLocaleString()}>{ago(b.lastCommit)}{b.stale && <span className="muted small"> stale</span>}</td>
                <td className={b.fate === 'local-only' ? 'bad' : 'muted'} title={b.approx ? 'Approximate: this shallow clone has no common history between this branch and the default branch, so only your own commits are counted' : ''}>{b.fate === 'merged' ? '' : b.approx ? `~${b.unpushed}` : b.unpushed ?? ''}</td>
                <td>{b.pr ? <a href={b.pr.url} target="_blank" rel="noreferrer">#{b.pr.number}</a> : ''}</td>
                <td className="muted small gx-subj" title={`${b.subject} (${b.author})`}>{b.subject}</td>
              </tr>) })}</tbody>
          </table>
          {shown.length > 400 && <div className="muted small">Showing the newest 400; filter to see the rest.</div>}
        </div>
      </>}
    </div>
  )
}

function Tile({ label, value, sub, bad, onClick }: { label: string; value: number | string; sub: string; bad?: boolean; onClick?: () => void }) {
  return <div className={'card gx-tile' + (onClick ? ' click' : '')} onClick={onClick}><div className="small muted">{label}</div><div className={'gx-big' + (bad ? ' bad' : '')}>{value}</div><div className="small muted">{sub}</div></div>
}
