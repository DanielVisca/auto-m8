// Git explorer: every branch gets the right fate, and stranded work (commits on no remote,
// uncommitted changes in a worktree) is counted.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import './delegate.ts'
import './optimize.ts'
import './shepherd.ts'
import { repoGit } from './gitexplorer.ts'

const sh = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', '-C', cwd, ...a], { encoding: 'utf8' }).trim()
const commit = (cwd: string, f: string) => { writeFileSync(join(cwd, f), f); sh(cwd, 'add', f); sh(cwd, 'commit', '-qm', f) }

test('git explorer sorts branches by fate and finds stranded work', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gx-')))
  const remote = join(root, 'remote.git'), repo = join(root, 'repo')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  sh(repo, 'remote', 'add', 'origin', remote)
  commit(repo, 'a'); sh(repo, 'push', '-q', '-u', 'origin', 'main'); sh(repo, 'remote', 'set-head', 'origin', 'main')
  sh(repo, 'checkout', '-qb', 'done'); commit(repo, 'b'); sh(repo, 'checkout', '-q', 'main'); sh(repo, 'merge', '-q', '--ff-only', 'done'); sh(repo, 'push', '-q', 'origin', 'main')
  sh(repo, 'checkout', '-qb', 'shared'); commit(repo, 'c'); sh(repo, 'push', '-q', '-u', 'origin', 'shared')
  sh(repo, 'checkout', '-qb', 'mine', 'main'); commit(repo, 'd'); commit(repo, 'e')
  sh(repo, 'branch', 'nothing', 'main')
  sh(repo, 'checkout', '-q', 'main')
  const wt = join(root, 'wt'); sh(repo, 'worktree', 'add', '-q', wt, 'shared'); writeFileSync(join(wt, 'c'), 'edited')

  const g = await repoGit(repo, { fresh: true })
  const fate = Object.fromEntries(g.branches.map(b => [b.name, b.fate]))
  assert.deepEqual(fate, { done: 'merged', shared: 'pushed', mine: 'local-only', nothing: 'merged' })
  assert.equal(g.branches.find(b => b.name === 'mine')!.unpushed, 2)
  assert.equal(g.summary.strandedCommits, 2)
  assert.equal(g.summary.strandedBranches, 1)
  const t = g.worktrees.find(w => w.path === wt)!
  assert.equal(t.branch, 'shared')
  assert.equal(t.dirty, 1)
  assert.equal(t.unique, 0)
})
