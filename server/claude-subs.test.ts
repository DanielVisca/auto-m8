import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.PERCH_CLAUDE_SUBS_DIR = mkdtempSync(join(tmpdir(), 'subs-'))
const A = await import('./account.ts')
const R = await import('./router.ts')
const now = Date.now()
const week = (pct: number, blocked = false) => ({ at: now, blocked, windows: [{ key: 'seven_day', label: 'week', pct, resetsAt: now + 3 * 86400_000 }] })

test('one subscription: everything runs on main', () => {
  assert.equal(A.pickSub('sonnet'), 'main')
})

test('a second subscription shares the main folder, but not the login', () => {
  const s = A.addSub('Max plan')
  assert.equal(s.id, 'max-plan')
  assert.ok(existsSync(s.dir))
  for (const n of ['projects', 'skills']) if (existsSync(join(A.mainDir(), n))) assert.ok(lstatSync(join(s.dir, n)).isSymbolicLink(), n)
  assert.ok(!existsSync(join(s.dir, '.credentials.json')))
})

test('Auto stays on the warm subscription while it is on pace, then moves to the one with room', () => {
  A.noteClaudeUsage(week(0.2), 'main')
  A.noteClaudeUsage(week(0.1), 'max-plan')
  assert.equal(A.pickSub('opus', 'max-plan'), 'max-plan') // warm cache wins while both have room
  assert.equal(A.pickSub('opus'), 'main') // a new chat starts on the first in your order
  A.noteClaudeUsage({ ...week(0.97), at: now + 1 }, 'main') // main far ahead of its pacing budget
  assert.equal(A.pickSub('opus', 'main'), 'max-plan')
})

test('a cap on one subscription moves the tier, not the router: it is only capped when every one is', () => {
  A.noteClaudeUsage({ ...week(0.2), at: now + 2 }, 'main')
  R.markCapped('opus', now + 3_600_000, 'main')
  assert.equal(R.isCapped('opus'), false)
  assert.equal(A.pickSub('opus', 'main'), 'max-plan')
  R.markCapped('all', now + 3_600_000, 'max-plan')
  assert.equal(R.isCapped('opus'), true)
  assert.equal(R.isCapped('sonnet'), false) // main still has Sonnet
  assert.equal(A.pickSub('sonnet', 'max-plan'), 'main')
  A.clearCaps()
})

test('a pin wins while it can work, and a switched-off subscription is never picked', () => {
  A.updateSub('max-plan', { pinned: true })
  assert.equal(A.pickSub('sonnet', 'main'), 'max-plan')
  A.noteClaudeUsage({ ...week(1, true), at: now + 3 }, 'max-plan') // out on its own limits
  assert.equal(A.pickSub('sonnet', 'max-plan'), 'main')
  A.updateSub('max-plan', { pinned: false, enabled: false })
  A.noteClaudeUsage({ ...week(0.1), at: now + 4 }, 'max-plan')
  A.noteClaudeUsage({ ...week(0.99), at: now + 4 }, 'main')
  assert.equal(A.pickSub('sonnet', 'main'), 'main')
})

test('order can be changed and a subscription removed', () => {
  A.updateSub('max-plan', { enabled: true, move: -1 })
  assert.deepEqual(A.subs().map(s => s.id), ['max-plan', 'main'])
  A.removeSub('max-plan')
  assert.deepEqual(A.subs().map(s => s.id), ['main'])
})
