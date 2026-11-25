// Git explorer: an on-demand picture of your local git state, per repo and across all of them.
// Answers two questions:
// - Is there work stranded on this Mac? Branches with commits on no remote, worktrees with
//   uncommitted changes that nobody is using.
// - Do branches get merged, or do they pile up? Each branch gets a fate (merged, open PR, closed
//   PR, pushed without a PR, local only), plus a weekly trend of your PRs opened, merged and closed.
//
// Read-only: it never changes a repo. Results are cached for a few minutes because a big repo
// (hundreds of branches, 170+ worktrees) takes seconds to read.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { all } from './db.ts'
import { ghJson, ghOffline } from './gh.ts'
import { localRepos } from './search.ts'
import { chats } from './chat.ts'
import { DIR_NAME, inventory, snapshotAge, type Worktree } from './worktrees.ts'

const exec = promisify(execFile)
const git = (cwd: string, args: string[], timeout = 60_000) =>
  exec('nice', ['-n', '10', 'git', '-C', cwd, ...args], { maxBuffer: 50e6, timeout }).then(r => r.stdout.trim())

const DAY = 86_400_000
const STALE_DAYS = 14

export type Fate = 'merged' | 'open-pr' | 'closed-pr' | 'pushed' | 'local-only' | 'empty'
export type Branch = {
  name: string; lastCommit: number; subject: string; author: string; mine: boolean
  upstream: string | null; ahead: number | null; behind: number | null; gone: boolean
  unpushed: number | null // commits on no remote (only counted for branches that need it)
  approx?: boolean // shallow clone, history doesn't meet the default branch: only your own commits counted
  merged: boolean; pr: { url: string; number: number; state: string } | null
  worktree: string | null; current: boolean; fate: Fate; stale: boolean
}
export type Tree = {
  path: string; branch: string | null; head: string | null; dirty: number | null; unique: number | null
  lastUsed: number; running: number; conversations: number; managed: boolean; keep: string | null
  orphaned: boolean // has work (uncommitted or unique commits), nothing running, idle > STALE_DAYS
}
export type Week = { week: number; opened: number; merged: number; closed: number }
export type RepoGit = {
  path: string; name: string; slug: string | null; defaultBranch: string; at: number; ms: number
  current: string | null; dirty: number | null
  branches: Branch[]; worktrees: Tree[]; weeks: Week[]; prsKnown: boolean
  summary: Record<Fate, number> & { total: number; stale: number; strandedBranches: number; strandedCommits: number; orphanedWorktrees: number; mergeRate: number | null }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]) } }))
  return out
}

const slugOf = (remote: string | null) => remote?.match(/github\.com[:/](.+?)(\.git)?$/)?.[1] ?? null

// One entry per real repo: worktree checkouts that localRepos() also finds fold into their main repo.
export async function repos(): Promise<{ path: string; name: string; slug: string | null }[]> {
  const seen = new Map<string, { path: string; name: string; slug: string | null }>()
  await pool(localRepos(), 8, async r => {
    try {
      const common = resolve(r.path, await git(r.path, ['rev-parse', '--git-common-dir'], 10_000))
      const main = common.endsWith('/.git') ? common.slice(0, -5) : common
      if (!seen.has(main) && existsSync(main)) seen.set(main, { path: main, name: main.split('/').pop()!, slug: slugOf(r.remote) })
    } catch {}
  })
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// Your PRs on GitHub for this repo, by head branch: one call, cached. Falls back to perch's prs table.
const prCache = new Map<string, { at: number; prs: any[] }>()
async function myPrs(slug: string): Promise<any[] | null> {
  const c = prCache.get(slug)
  if (c && Date.now() - c.at < 30 * 60_000) return c.prs
  if (ghOffline()) return c?.prs ?? null
  try {
    const prs = await ghJson<any[]>(['pr', 'list', '--repo', slug, '--author', '@me', '--state', 'all', '--limit', '400', '--json', 'number,url,state,headRefName,createdAt,mergedAt,closedAt'], { timeout: 60_000 })
    prCache.set(slug, { at: Date.now(), prs })
    return prs
  } catch { return c?.prs ?? null }
}

const cache = new Map<string, { at: number; v: RepoGit }>()
const inflight = new Map<string, Promise<RepoGit>>()
const FRESH_FOR = 10 * 60_000

export function repoGit(path: string, opts: { fresh?: boolean } = {}): Promise<RepoGit> {
  const c = cache.get(path)
  if (c && !opts.fresh && Date.now() - c.at < FRESH_FOR) return Promise.resolve(c.v)
  const running = inflight.get(path)
  if (running) return running
  const p = read(path).then(v => { cache.set(path, { at: Date.now(), v }); return v }).finally(() => inflight.delete(path))
  inflight.set(path, p)
  // Serve the last read at once while a refresh runs (stale-while-revalidate), unless asked fresh.
  return c && !opts.fresh ? Promise.resolve(c.v) : p
}

async function read(path: string): Promise<RepoGit> {
  const t0 = Date.now()
  if (!existsSync(join(path, '.git')) || !statSync(join(path, '.git')).isDirectory()) throw new Error(`${path} is not a main git checkout`)
  const remote = await git(path, ['remote', 'get-url', 'origin']).catch(() => '')
  const slug = slugOf(remote)
  const defaultBranch = (await git(path, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')) || (await git(path, ['rev-parse', '--abbrev-ref', '@{u}']).catch(() => '')) || 'HEAD'
  const me = await git(path, ['config', 'user.email']).catch(() => '')
  const [refs, mergedList, current, wtList] = await Promise.all([
    git(path, ['for-each-ref', 'refs/heads', '--format=%(refname:short)%09%(committerdate:unix)%09%(upstream:short)%09%(upstream:track)%09%(authoremail)%09%(authorname)%09%(contents:subject)']),
    git(path, ['branch', '--format=%(refname:short)', '--merged', defaultBranch]).catch(() => ''),
    git(path, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null),
    git(path, ['worktree', 'list', '--porcelain']).catch(() => ''),
  ])
  const merged = new Set(mergedList.split('\n').filter(Boolean))
  const remoteHeads = new Set((await git(path, ['for-each-ref', 'refs/remotes', '--format=%(refname:short)']).catch(() => '')).split('\n').map(r => r.replace(/^[^/]+\//, '')))

  // Worktrees: branch -> path, and the list itself.
  const trees: { path: string; branch: string | null }[] = []
  for (const block of wtList.split('\n\n')) {
    const p = block.match(/^worktree (.+)$/m)?.[1]
    if (!p || p === path) continue
    trees.push({ path: p, branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null })
  }
  const branchTree = new Map(trees.filter(t => t.branch).map(t => [t.branch!, t.path]))

  const prs = slug ? await myPrs(slug) : null
  const known = slug ? all<any>('select url, number, state, head from prs where repo = ? and head is not null', slug) : []
  const prByHead = new Map<string, any>()
  for (const p of known) prByHead.set(p.head, { url: p.url, number: p.number, state: p.state })
  // Several PRs can share a head name over time; the open or most recent one wins.
  for (const p of [...(prs ?? [])].sort((a, b) => a.number - b.number)) if (prByHead.get(p.headRefName)?.state !== 'OPEN') prByHead.set(p.headRefName, { url: p.url, number: p.number, state: p.state })

  const now = Date.now()
  const branches: Branch[] = refs.split('\n').filter(Boolean).map(line => {
    const [name, date, upstream, track, email, author, ...subj] = line.split('\t')
    const ahead = Number(track.match(/ahead (\d+)/)?.[1] ?? 0), behind = Number(track.match(/behind (\d+)/)?.[1] ?? 0)
    const pr = prByHead.get(name) ?? null
    return {
      name, lastCommit: Number(date) * 1000, subject: subj.join('\t'), author, mine: !!me && email.replace(/[<>]/g, '') === me,
      upstream: upstream || null, ahead: upstream ? ahead : null, behind: upstream ? behind : null, gone: track.includes('gone'),
      unpushed: upstream && upstream.endsWith('/' + name) && !track.includes('gone') ? ahead : null, // tracking another branch (often origin/master): counted below
      merged: merged.has(name) || pr?.state === 'MERGED', pr, worktree: branchTree.get(name) ?? null, current: name === current,
      fate: 'empty', stale: false,
    }
  })
  // Commits on no remote, for branches without a live upstream: not on the default branch nor on a
  // remote branch of the same name. (`--not --remotes` would be exact, but a big repo has ~30k remote
  // refs and that costs seconds per branch.)
  // A shallow clone's default branch stops at the shallow boundary, so a branch fetched with deeper
  // history would count every older commit (73k on the PostHog checkout): only count from the boundary on.
  let since: string[] = []
  try {
    const shallow = readFileSync(join(path, '.git/shallow'), 'utf8').split('\n').filter(Boolean)
    if (shallow.length) since = [`--since=${Math.min(...(await git(path, ['show', '-s', '--format=%ct', ...shallow])).split('\n').map(Number))}`]
  } catch {}
  // A branch whose history doesn't meet the shallow default branch at all (no merge base) still counts
  // months of other people's commits: then count only your own, and mark the number approximate.
  const approx = new Set<string>()
  const unpushed = async (ref: string, name: string | null) => {
    const args = ['rev-list', '--count', ...since, ref, `^${defaultBranch}`, ...(name && remoteHeads.has(name) ? [`^origin/${name}`] : [])]
    const n = await git(path, args).then(Number).catch(() => 0)
    if (n <= 200 || !since.length || await git(path, ['merge-base', ref, defaultBranch]).then(() => true, () => false)) return n
    approx.add(ref)
    return me ? git(path, [...args.slice(0, 2), `--author=${me}`, ...args.slice(2)]).then(Number).catch(() => 0) : n
  }
  await pool(branches.filter(b => b.unpushed === null && !b.merged), 8, async b => { b.unpushed = await unpushed(b.name, b.name) })
  for (const b of branches) {
    if (approx.has(b.name)) b.approx = true
    b.fate = b.merged ? 'merged'
      : b.pr?.state === 'OPEN' ? 'open-pr'
      : b.pr?.state === 'CLOSED' ? 'closed-pr'
      : (b.unpushed ?? 0) > 0 ? 'local-only'
      : (b.upstream && !b.gone) || remoteHeads.has(b.name) ? 'pushed'
      : 'empty'
    b.stale = b.fate !== 'merged' && now - b.lastCommit > STALE_DAYS * DAY
  }
  const defaultShort = defaultBranch.replace(/^origin\//, '')
  const shown = branches.filter(b => b.name !== defaultShort)

  // Worktree state: perch's inventory has the ones it manages; read the rest the same way.
  // auto-m8's own checkouts (.perch-worktrees) come from the worktree snapshot, which takes minutes to
  // build after a restart (the hourly sweep makes it): until it exists they show as "not checked yet".
  const inv = new Map((snapshotAge() !== null ? await inventory().catch(() => [] as Worktree[]) : [] as Worktree[]).map(w => [w.path, w]))
  const byName = new Map(branches.map(b => [b.name, b]))
  const wts: Tree[] = await pool(trees, 4, async t => {
    const managed = t.path.includes(`/${DIR_NAME}/`)
    const w = inv.get(t.path) ?? (!managed && existsSync(t.path) ? await light(path, t, byName.get(t.branch ?? ''), unpushed).catch(() => null) : null)
    const dirty = w?.dirty ?? null, unique = w?.unique ?? null
    const lastUsed = w?.lastUsed ?? 0
    return {
      path: t.path, branch: w?.branch ?? t.branch, head: w?.head ?? null, dirty, unique, lastUsed,
      running: w?.running.length ?? 0, conversations: w?.conversations.length ?? 0, managed, keep: w?.keep ?? (!existsSync(t.path) ? 'folder is gone; git still lists it (git worktree prune)' : managed ? 'not checked yet: auto-m8 is taking stock of its worktrees' : null),
      orphaned: !!w && !w.running.length && ((dirty ?? 0) > 0 || (unique ?? 0) > 0) && now - lastUsed > STALE_DAYS * DAY,
    }
  })
  const mainDirty = await git(path, ['status', '--porcelain', '--untracked-files=no']).then(s => s.split('\n').filter(Boolean).length).catch(() => null)

  // Weekly trend from your PRs: opened, merged, closed without merging (last 12 weeks).
  const weekOf = (iso: string) => { const d = new Date(iso); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime() }
  const start = weekOf(new Date(now - 11 * 7 * DAY).toISOString())
  const weeks: Week[] = Array.from({ length: 12 }, (_, i) => ({ week: weekOf(new Date(start + i * 7 * DAY + 2 * DAY).toISOString()), opened: 0, merged: 0, closed: 0 })) // re-snapped: DST shifts a plain 7-day step by an hour
  const bump = (iso: string | null | undefined, k: 'opened' | 'merged' | 'closed') => { if (!iso) return; const w = weeks.find(x => x.week === weekOf(iso)); if (w) w[k]++ }
  for (const p of prs ?? []) { bump(p.createdAt, 'opened'); if (p.mergedAt) bump(p.mergedAt, 'merged'); else if (p.state === 'CLOSED') bump(p.closedAt, 'closed') }

  const count = (f: Fate) => shown.filter(b => b.fate === f).length
  const stranded = shown.filter(b => b.fate === 'local-only')
  const decided = (prs ?? []).filter(p => p.state !== 'OPEN')
  return {
    path, name: path.split('/').pop()!, slug, defaultBranch, at: now, ms: Date.now() - t0,
    current, dirty: mainDirty,
    branches: shown.sort((a, b) => b.lastCommit - a.lastCommit), worktrees: wts.sort((a, b) => b.lastUsed - a.lastUsed), weeks, prsKnown: !!prs,
    summary: {
      merged: count('merged'), 'open-pr': count('open-pr'), 'closed-pr': count('closed-pr'), pushed: count('pushed'), 'local-only': count('local-only'), empty: count('empty'),
      total: shown.length, stale: shown.filter(b => b.stale).length,
      strandedBranches: stranded.length, strandedCommits: stranded.reduce((s, b) => s + (b.unpushed ?? 0), 0),
      orphanedWorktrees: wts.filter(w => w.orphaned).length,
      mergeRate: decided.length ? decided.filter(p => p.state === 'MERGED').length / decided.length : null,
    },
  }
}

// Every repo at once, for the overview: summaries only, plus the stranded work itself.
export async function overview(opts: { fresh?: boolean } = {}) {
  const list = await repos()
  const res = await pool(list, 3, async r => { try { return await repoGit(r.path, opts) } catch (e: any) { return { path: r.path, name: r.name, error: String(e.message ?? e) } as any } })
  return res.map((g: any) => g.error ? g : {
    path: g.path, name: g.name, slug: g.slug, at: g.at, summary: g.summary, current: g.current, dirty: g.dirty,
    stranded: g.branches.filter((b: Branch) => b.fate === 'local-only').slice(0, 20).map((b: Branch) => ({ name: b.name, unpushed: b.unpushed, lastCommit: b.lastCommit, subject: b.subject, worktree: b.worktree })),
    orphaned: g.worktrees.filter((w: Tree) => w.orphaned).slice(0, 20),
  })
}

// A worktree outside auto-m8's own folder, read cheaply: uncommitted tracked files, commits only it has
// (its branch's unpushed count, or for a detached HEAD the commits on no branch), and when it was last used.
const lightMemo = new Map<string, { touched: number; at: number; w: Worktree }>()
async function light(repo: string, t: { path: string; branch: string | null }, b: Branch | undefined, unpushed: (ref: string, name: string | null) => Promise<number>): Promise<Worktree> {
  let touched = 0
  try { const gd = (await git(t.path, ['rev-parse', '--absolute-git-dir'], 10_000)); touched = statSync(join(gd, 'index')).mtimeMs } catch { try { touched = statSync(t.path).mtimeMs } catch {} }
  const convs = all<{ id: string; updated_at: number }>('select id, updated_at from conversations where cwd = ? or cwd like ?', t.path, t.path + '/%')
  const running = [...chats.values()].filter(c => c.state === 'running' && !!c.cwd && (c.cwd === t.path || c.cwd.startsWith(t.path + '/'))).map(c => c.id)
  const m = lightMemo.get(t.path)
  let dirty: number, unique: number, head: string
  if (m && m.touched === touched && Date.now() - m.at < 3_600_000) ({ dirty, unique, head } = m.w as any)
  else {
    head = await git(t.path, ['rev-parse', '--short', 'HEAD']).catch(() => '')
    dirty = (await git(t.path, ['status', '--porcelain', '--untracked-files=no'], 60_000)).split('\n').filter(Boolean).length
    unique = b ? (b.unpushed ?? 0) : await unpushed('HEAD', null)
  }
  const w: Worktree = { path: t.path, name: basename(t.path), repo, kind: 'other', branch: t.branch, head, pr: null, prState: null, dirty, unique, lastUsed: Math.max(touched, ...convs.map(c => c.updated_at ?? 0)), running, conversations: convs.map(c => c.id), keep: null }
  lightMemo.set(t.path, { touched, at: Date.now(), w })
  return w
}
