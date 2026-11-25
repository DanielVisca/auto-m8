// Worktree cleanup must never lose work: dirty checkouts stay unless forced (then stashed),
// branches survive, detached commits get a rescue branch.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import './delegate.ts'
import './optimize.ts'
import './shepherd.ts'
import { classifyStatus, createHelper, inspect, remove } from './worktrees.ts'

const sh = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', '-C', cwd, ...a], { encoding: 'utf8' }).trim()
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'perch-wt-'))), dir = join(root, 'app')
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  writeFileSync(join(dir, 'a.txt'), 'a'); sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'init')
  return dir
}

test('a helper worktree gets its own branch and survives removal as a branch', async () => {
  const dir = repo()
  const w = await createHelper(dir, '0123abcd-0000-0000-0000-000000000000')
  assert.equal(w.branch, 'perch/helper-0123abcd')
  assert.ok(w.dir.endsWith('/.perch-worktrees/app-helper-0123abcd'))
  writeFileSync(join(w.dir, 'b.txt'), 'b'); sh(w.dir, 'add', '.'); sh(w.dir, 'commit', '-qm', 'helper work')
  const info = await inspect(w.dir)
  assert.equal(info.kind, 'helper'); assert.equal(info.dirty, 0); assert.equal(info.unique, 1)
  const r = await remove(w.dir)
  assert.ok(r.ok, r.note); assert.ok(!existsSync(w.dir))
  assert.match(sh(dir, 'log', '--oneline', 'perch/helper-0123abcd'), /helper work/)
})

test('a dirty worktree is kept unless forced, and forcing stashes the changes', async () => {
  const dir = repo()
  const w = await createHelper(dir, 'feedbeef-0000-0000-0000-000000000000')
  writeFileSync(join(w.dir, 'wip.txt'), 'not committed')
  assert.equal((await inspect(w.dir)).keep, '1 uncommitted change')
  assert.equal((await remove(w.dir)).ok, false)
  const r = await remove(w.dir, { force: true })
  assert.ok(r.ok); assert.match(sh(dir, 'stash', 'list'), /before worktree cleanup/)
})

test('detached commits found nowhere else get a rescue branch', async () => {
  const dir = repo()
  const wt = join(dir, '..', '.perch-worktrees', 'app-pr7')
  sh(dir, 'worktree', 'add', '-q', '--detach', wt, 'HEAD')
  writeFileSync(join(wt, 'c.txt'), 'c'); sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'detached work')
  const info = await inspect(wt)
  assert.equal(info.kind, 'pr'); assert.equal(info.branch, null); assert.equal(info.unique, 1)
  const r = await remove(wt)
  assert.ok(r.ok); assert.match(sh(dir, 'log', '--oneline', 'perch-rescue/app-pr7'), /detached work/)
})

test('only perch worktrees can be removed', async () => {
  assert.equal((await remove(repo())).ok, false)
})

test('generated agent config and half-finished checkouts are not work', () => {
  assert.deepEqual(classifyStatus(' M .codex/config.toml\n?? .codex/agents/\n?? .agents/skills/x/\n'), { work: 0, noise: '3 generated agent config files' })
  const missing = Array.from({ length: 1200 }, (_, i) => ` D frontend/f${i}.ts`).join('\n')
  assert.equal(classifyStatus(missing).work, 0)
  // A few deletions, or deletions next to an edit, are someone's work.
  assert.equal(classifyStatus(' D a.ts\n D b.ts').work, 2)
  assert.equal(classifyStatus(missing + '\n M real.ts').work, 1201)
  assert.equal(classifyStatus(' M .codex/config.toml\n M src/app.ts').work, 1)
})

test('a checkout with only generated agent config is removed without a stash', async () => {
  const dir = repo()
  const w = await createHelper(dir, 'c0dec0de-0000-0000-0000-000000000000')
  execFileSync('mkdir', ['-p', join(w.dir, '.codex', 'agents')]); writeFileSync(join(w.dir, '.codex', 'agents', 'r.toml'), 'x')
  const info = await inspect(w.dir)
  assert.equal(info.dirty, 0); assert.match(info.noise ?? "", /generated/)
  const r = await remove(w.dir)
  assert.ok(r.ok, r.note); assert.match(r.note, /dropped 1 generated agent config file/)
  assert.equal(sh(dir, 'stash', 'list'), '')
})
