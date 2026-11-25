// Worktrees: every checkout perch or its agents make lives in <repo parent>/.perch-worktrees/
// (shepherds and deep audits per PR, autoresearch runs, self-fixes, delegate helpers). This module
// creates helper worktrees, takes stock of all of them, and removes the ones nothing needs any
// more, so they don't pile up on the laptop (103 had built up before this existed).
//
// Removal never loses work: a worktree with uncommitted changes is kept (or stashed first when an
// agent forces it), a branch survives its worktree, and a detached HEAD with commits nowhere else
// gets a perch-rescue/<name> branch before its checkout goes.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { chats } from './chat.ts'
import { all, get } from './db.ts'
import { localRepos } from './search.ts'
import { machineLine, maxHelpers } from './owner.ts'

const exec = promisify(execFile)
const git = (cwd: string, args: string[], timeout = 120_000) =>
  exec('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { maxBuffer: 50e6, timeout }).then(r => r.stdout.trim())

export const DIR_NAME = '.perch-worktrees'
const H = 3600_000, D = 24 * H

// What this Mac can take (owner.ts machine: cores and memory, one Docker daemon shared by every checkout). Helpers
// with their own worktree count against MAX_HELPER_WORKTREES while running; a new worktree needs
// MIN_FREE_GB of disk (a PostHog checkout is a few GB before node_modules).
export const LIMITS = { maxHelperWorktrees: maxHelpers, minFreeGb: 25 }

// How long a worktree must sit untouched before the sweep removes it, by kind.
const IDLE: Record<Kind, number> = { pr: 1 * D, helper: 1 * D, autoresearch: 3 * D, selffix: 3 * D, other: 14 * D }
const OPEN_PR_IDLE = 7 * D
const STASH_AFTER = 14 * D

export type Kind = 'pr' | 'helper' | 'autoresearch' | 'selffix' | 'other'
export type Worktree = {
  path: string; name: string; repo: string | null; kind: Kind; branch: string | null; head: string | null
  pr: string | null; prState: string | null; dirty: number | null; unique: number | null
  noise?: string | null // uncommitted state that isn't work (generated agent config, a half-finished checkout)
  lastUsed: number; running: string[]; conversations: string[]
  keep: string | null // why it stays; null = the sweep may remove it
}

// Uncommitted state that is not anyone's work, so it must not pin a checkout forever (it pinned
// ~190 of 208 on 2026-11-24, filling the disk):
// - agent tool config the repo's own tooling writes into every checkout (.codex/, .agents/);
// - a checkout that never finished or was half-emptied: thousands of tracked files missing from
//   disk and nothing else changed. Every one of those files is still in HEAD.
// Everything else counts as work and keeps the checkout (or is stashed when removal is forced).
const GENERATED = /^"?(\.codex|\.agents)(\/|"?$)/
const BROKEN_CHECKOUT_MIN = 1000
export function classifyStatus(porcelain: string): { work: number; noise: string | null } {
  const lines = porcelain.split('\n').filter(Boolean)
  const paths = lines.map(l => ({ xy: l.slice(0, 2), path: l.slice(3).split(' -> ').pop()! }))
  const generated = paths.filter(p => GENERATED.test(p.path)).length
  const rest = paths.filter(p => !GENERATED.test(p.path))
  const deletions = rest.filter(p => p.xy === ' D' || p.xy === 'D ' || p.xy === 'DD').length
  const broken = rest.length >= BROKEN_CHECKOUT_MIN && deletions === rest.length
  const notes = [generated ? `${generated} generated agent config file${generated === 1 ? '' : 's'}` : '', broken ? `half-finished checkout (${deletions} tracked files missing, all still in HEAD)` : ''].filter(Boolean)
  return { work: broken ? 0 : rest.length, noise: notes.join('; ') || null }
}

const roots = () => [...new Set(localRepos().map(r => join(dirname(r.path), DIR_NAME)))].filter(existsSync)

export async function freeGb(path: string) {
  try { const s = await statfs(path); return Math.round((s.bavail * s.bsize) / 1e9) } catch { return null }
}

function kindOf(name: string, branch: string | null): Kind {
  if (/-pr\d+$/.test(name)) return 'pr'
  if (/-helper-[0-9a-f]{8}$/.test(name) || branch?.startsWith('perch/helper-')) return 'helper'
  if (branch?.startsWith('autoresearch/')) return 'autoresearch'
  if (name.startsWith('perch-fix-')) return 'selffix'
  return 'other'
}

// The main checkout a worktree belongs to, from its .git file ("gitdir: <repo>/.git/worktrees/<n>").
function mainRepo(path: string) {
  try {
    const gitdir = readFileSync(join(path, '.git'), 'utf8').match(/gitdir:\s*(.+)/)?.[1]?.trim()
    if (!gitdir || !existsSync(gitdir)) return { repo: null, gitdir: null }
    return { repo: gitdir.split('/.git/worktrees/')[0], gitdir }
  } catch { return { repo: null, gitdir: null } }
}

const under = (cwd: string | null | undefined, path: string) => !!cwd && (cwd === path || cwd.startsWith(path + '/'))

// Inventory reads at low CPU priority, so a sweep never competes with the work you're doing.
const lowGit = (cwd: string, args: string[], timeout = 120_000) =>
  exec('nice', ['-n', '15', 'git', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { maxBuffer: 50e6, timeout }).then(r => r.stdout.trim())

// `git status` on a PostHog checkout costs seconds of CPU and disk; 128 of them every sweep made the
// Mac sluggish. A checkout's git state is reused while its index file is unchanged (commits,
// checkouts, staging and most git commands rewrite it), for up to REUSE_FOR. Unstaged edits don't
// touch the index, so the count can lag; that only affects display: remove() inspects fresh.
const REUSE_FOR = 6 * H
const memo = new Map<string, { touched: number; at: number; branch: string | null; head: string | null; dirty: number; noise: string | null; unique: number }>()

export async function inspect(path: string, opts: { reuse?: boolean } = {}): Promise<Worktree> {
  const name = basename(path)
  const { repo, gitdir } = mainRepo(path)
  const convs = all<{ id: string; updated_at: number }>('select id, updated_at from conversations where cwd = ? or cwd like ?', path, path + '/%')
  const running = [...chats.values()].filter(c => c.state === 'running' && under(c.cwd, path)).map(c => c.id)
  // Read the index's mtime before `git status`, which may rewrite it.
  let touched = 0
  try { touched = statSync(join(gitdir ?? path, 'index')).mtimeMs } catch { try { touched = statSync(path).mtimeMs } catch {} }
  const lastUsed = Math.max(touched, ...convs.map(c => c.updated_at ?? 0))
  const base: Worktree = { path, name, repo, kind: kindOf(name, null), branch: null, head: null, pr: null, prState: null, dirty: null, unique: null, lastUsed, running, conversations: convs.map(c => c.id), keep: null }
  if (!repo) return { ...base, keep: 'not linked to a git repo any more (orphan folder); check it by hand' }
  const m = memo.get(path)
  if (opts.reuse && m && m.touched === touched && Date.now() - m.at < REUSE_FOR) {
    Object.assign(base, { branch: m.branch, head: m.head, dirty: m.dirty, noise: m.noise, unique: m.unique, kind: kindOf(name, m.branch) })
  } else try {
    const g = opts.reuse ? lowGit : git
    const [branch, head] = await Promise.all([g(path, ['rev-parse', '--abbrev-ref', 'HEAD']), g(path, ['rev-parse', '--short', 'HEAD'])])
    base.branch = branch === 'HEAD' ? null : branch
    base.head = head
    base.kind = kindOf(name, base.branch)
    const status = classifyStatus(await g(path, ['status', '--porcelain'], 90_000))
    base.dirty = status.work
    base.noise = status.noise
    // Commits only this worktree has: not on any remote, PR ref or other local branch.
    const not = ['--not', ...(base.branch ? [`--exclude=${base.branch}`] : []), '--branches', '--remotes', '--glob=refs/perch/*']
    base.unique = Number(await g(path, ['rev-list', '--count', 'HEAD', ...not]))
    // Key on the index mtime after status, which may have refreshed it.
    let after = touched
    try { after = statSync(join(gitdir ?? path, 'index')).mtimeMs } catch {}
    memo.set(path, { touched: after, at: Date.now(), branch: base.branch, head: base.head, dirty: base.dirty, noise: base.noise ?? null, unique: base.unique })
  } catch {}
  if (base.kind === 'pr') {
    const n = Number(name.match(/-pr(\d+)$/)![1])
    const remote = localRepos().find(r => r.path === repo)?.remote ?? ''
    const slug = remote.match(/github\.com[:/](.+?)(\.git)?$/)?.[1]
    const pr = slug ? get<any>('select url, state from prs where repo = ? and number = ?', slug, n) : null
    base.pr = pr?.url ?? (slug ? `https://github.com/${slug}/pull/${n}` : null)
    base.prState = pr?.state ?? null
  }
  return { ...base, keep: keepReason(base) }
}

function keepReason(w: Worktree): string | null {
  if (w.running.length) return `an agent is working in it (${w.running.join(', ')})`
  if (w.dirty === null || w.unique === null) return 'could not read its git state'
  const idle = Date.now() - w.lastUsed
  // Leftover edits in the checkout of a PR that is merged or closed: kept two weeks so someone can
  // pick them up, then stashed (git stash list in the main repo, message names the PR) and the
  // multi-GB checkout freed.
  const finishedPr = w.kind === 'pr' && (w.prState === 'MERGED' || w.prState === 'CLOSED')
  if (w.dirty > 0 && !(finishedPr && idle > STASH_AFTER)) return `${w.dirty} uncommitted change${w.dirty === 1 ? '' : 's'}${finishedPr ? ` on a ${w.prState!.toLowerCase()} PR (stashed and removed after ${STASH_AFTER / D} days idle)` : ''}`
  if (w.kind === 'pr' && w.pr) {
    if (get(`select 1 from shepherd_watch where url = ? and enabled = 1`, w.pr)) return 'its PR is being shepherded'
    if (w.prState === 'OPEN' && idle < OPEN_PR_IDLE) return 'its PR is open and was used this week'
    if (w.prState !== 'OPEN' && idle < IDLE.pr) return 'used in the last day'
    return null
  }
  if (w.kind === 'helper') {
    if (get(`select 1 from delegations where worktree = ? and status in ('running', 'needs-help')`, w.path)) return 'its helper is still on the job'
  }
  if (w.kind === 'autoresearch' && get(`select 1 from autoresearch_runs where worktree = ? and status = 'running'`, w.path)) return 'its autoresearch run is still going'
  if (idle < IDLE[w.kind]) return `used in the last ${Math.round(IDLE[w.kind] / D)} day${IDLE[w.kind] === D ? '' : 's'}`
  return null
}

// ---------- inventory ----------
let cache: { at: number; list: Worktree[] } | null = null
let inflight: Promise<Worktree[]> | null = null

// Reading git state for ~100 checkouts takes minutes, so callers get the last snapshot right away
// (refreshed in the background once it is 10 minutes old) unless they ask for a fresh one.
export const snapshotAge = () => cache ? Date.now() - cache.at : null
export function inventory(opts: { fresh?: boolean } = {}): Promise<Worktree[]> {
  if (!opts.fresh && cache) { if (Date.now() - cache.at > 10 * 60_000) refresh().catch(() => {}); return Promise.resolve(cache.list) }
  return refresh()
}
function refresh(): Promise<Worktree[]> {
  if (inflight) return inflight
  inflight = (async () => {
    const paths = roots().flatMap(r => readdirSync(r).map(n => join(r, n))).filter(p => { try { return statSync(p).isDirectory() } catch { return false } })
    // `git status` on the PostHog monorepo takes seconds and is disk-bound: two at a time, reusing
    // what hasn't changed since the last pass.
    const out: Worktree[] = []
    for (let i = 0; i < paths.length; i += 2) out.push(...await Promise.all(paths.slice(i, i + 2).map(p => inspect(p, { reuse: true }))))
    for (const k of memo.keys()) if (!paths.includes(k)) memo.delete(k)
    cache = { at: Date.now(), list: out.sort((a, b) => b.lastUsed - a.lastUsed) }
    return cache.list
  })().finally(() => { inflight = null })
  return inflight
}

// ---------- removal ----------
export async function remove(path: string, opts: { force?: boolean; onlyIfIdle?: boolean } = {}): Promise<{ ok: boolean; note: string }> {
  if (!path.includes(`/${DIR_NAME}/`)) return { ok: false, note: `Only auto-m8 worktrees (under ${DIR_NAME}/) can be removed here.` }
  const w = await inspect(path)
  if (opts.onlyIfIdle && w.keep) return { ok: false, note: `kept: ${w.keep}` }
  if (!w.repo) return { ok: false, note: 'Not linked to a repo (orphan folder); not removing it automatically.' }
  if (w.running.length) return { ok: false, note: `An agent is working in it (${w.running.join(', ')}).` }
  const notes: string[] = []
  if (w.dirty) {
    if (!opts.force) return { ok: false, note: `${w.dirty} uncommitted changes. Commit them, or pass force to stash them first.` }
    await git(path, ['stash', 'push', '-u', '-m', `perch: ${w.name}${w.pr ? ` (${w.pr})` : ''} before worktree cleanup`])
    notes.push(`stashed ${w.dirty} changes in ${w.repo} (git stash list)`)
  }
  if (!w.branch && w.unique) {
    const rescue = `perch-rescue/${w.name}`
    await git(path, ['branch', '-f', rescue, 'HEAD'])
    notes.push(`kept its ${w.unique} commits on branch ${rescue}`)
  }
  await git(w.repo, ['worktree', 'remove', '--force', path], 300_000)
  await git(w.repo, ['worktree', 'prune']).catch(() => {})
  if (cache) cache.list = cache.list.filter(x => x.path !== path)
  if (w.noise && !w.dirty) notes.push(`dropped ${w.noise}`)
  if (w.branch) notes.push(`branch ${w.branch} kept`)
  return { ok: true, note: notes.join('; ') || 'removed' }
}

export type SweepResult = { at: number; removed: { path: string; note: string }[]; kept: number; failed: { path: string; error: string }[]; freeGb: number | null }
export let lastSweep: SweepResult | null = null
let sweeping = false

// Removes every worktree with no reason to stay. dryRun lists what would go.
export async function sweep(opts: { dryRun?: boolean } = {}): Promise<SweepResult & { wouldRemove?: Worktree[] }> {
  const list = await inventory({ fresh: !opts.dryRun || (snapshotAge() ?? Infinity) > 10 * 60_000 })
  const go = list.filter(w => !w.keep)
  const freeNow = await freeGb(roots()[0] ?? '/')
  if (opts.dryRun) return { at: Date.now(), removed: [], kept: list.length - go.length, failed: [], freeGb: freeNow, wouldRemove: go }
  if (sweeping) return lastSweep ?? { at: Date.now(), removed: [], kept: list.length, failed: [], freeGb: freeNow }
  sweeping = true
  const removed: SweepResult['removed'] = [], failed: SweepResult['failed'] = []
  try {
    for (const w of go) {
      try { const r = await remove(w.path, { onlyIfIdle: true, force: w.kind === 'pr' && w.prState !== 'OPEN' }); if (r.ok) removed.push({ path: w.path, note: r.note }); else if (!r.note.startsWith('kept:')) failed.push({ path: w.path, error: r.note }) }
      catch (e: any) { failed.push({ path: w.path, error: String(e?.message ?? e).slice(0, 300) }) }
    }
  } finally { sweeping = false }
  lastSweep = { at: Date.now(), removed, kept: list.length - go.length, failed, freeGb: await freeGb(roots()[0] ?? '/') }
  if (removed.length || failed.length) console.log(`worktrees: removed ${removed.length}, kept ${lastSweep.kept}, failed ${failed.length}`)
  return lastSweep
}

// ---------- helper worktrees ----------
export const helperWorktreesRunning = () =>
  get<{ n: number }>(`select count(*) n from delegations where worktree is not null and status in ('running', 'needs-help')`)?.n ?? 0

// A fresh worktree on a new branch from the HEAD of `cwd`'s repo. The parent's uncommitted
// changes are not in it.
export async function createHelper(cwd: string, id: string) {
  const top = await git(cwd, ['rev-parse', '--show-toplevel']).catch(() => '')
  if (!top) throw new Error(`${cwd} is not a git checkout, so there is nothing to make a worktree of. Delegate without worktree, or pass a repo as cwd.`)
  const running = helperWorktreesRunning()
  if (running >= LIMITS.maxHelperWorktrees) throw new Error(`${running} helpers are already working in their own worktrees; this Mac (${machineLine}, one Docker) shouldn't take more. Wait for one to report, or delegate without a worktree for read-only work.`)
  const root = join(dirname(top), DIR_NAME)
  mkdirSync(root, { recursive: true })
  let free = await freeGb(root)
  if (free !== null && free < LIMITS.minFreeGb) { await sweep().catch(() => {}); free = await freeGb(root) }
  if (free !== null && free < LIMITS.minFreeGb) throw new Error(`Only ${free} GB free on disk (need ${LIMITS.minFreeGb}). Clean up with the worktrees tool (action=list, then remove) first.`)
  const short = id.slice(0, 8), branch = `perch/helper-${short}`, dir = join(root, `${basename(top)}-helper-${short}`)
  const base = await git(top, ['rev-parse', '--short', 'HEAD'])
  const from = await git(top, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD')
  const dirtyParent = (await git(top, ['status', '--porcelain', '--untracked-files=no'], 90_000).catch(() => '')).split('\n').filter(Boolean).length
  await git(top, ['worktree', 'add', '-b', branch, dir, 'HEAD'], 600_000)
  cache = null
  return { dir, branch, base, from, repo: top, dirtyParent }
}

export function startSweeping() {
  // First pass two minutes after start (not to compete with startup), then hourly.
  setTimeout(() => { sweep().catch(e => console.error('worktrees sweep', e)) }, 2 * 60_000).unref()
  setInterval(() => { sweep().catch(e => console.error('worktrees sweep', e)) }, H).unref()
}

// A compact text view for agents.
export function describe(list: Worktree[], limit = 60) {
  const ago = (t: number) => { const h = (Date.now() - t) / H; return h < 1 ? 'now' : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago` }
  const go = list.filter(w => !w.keep).length
  const head = `${list.length} auto-m8 worktrees, ${go} removable now (the hourly sweep takes them), ${list.length - go} kept.`
  const rows = list.slice(0, limit).map(w => `- ${w.path} | ${w.kind}${w.pr ? ` ${w.pr} (${w.prState ?? '?'})` : ''} | ${w.branch ?? `detached ${w.head ?? '?'}`} | dirty ${w.dirty ?? '?'}${w.noise ? ` (ignored: ${w.noise})` : ''}, only-here commits ${w.unique ?? '?'} | used ${ago(w.lastUsed)}${w.running.length ? ` | RUNNING ${w.running.join(',')}` : ''} | ${w.keep ? `keep: ${w.keep}` : 'removable'}`)
  return [head, ...rows, list.length > limit ? `…and ${list.length - limit} more` : ''].filter(Boolean).join('\n')
}
