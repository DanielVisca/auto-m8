// perch/plan follows what GitHub shows, not only what perch last recorded (2026-11-17, #135741).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planNeedsPost } from './shepherd.ts'

test('a stale pending on GitHub is corrected even when the record says success was posted', () => {
  const head = 'd7e2c942'
  assert.equal(planNeedsPost(`${head}:success`, { head, planState: 'pending' }, 'success'), true, 'GitHub shows pending: post success')
  assert.equal(planNeedsPost(`${head}:success`, { head, planState: null }, 'success'), true, 'status missing on GitHub: post it')
  assert.equal(planNeedsPost(`${head}:success`, { head, planState: 'success' }, 'success'), false, 'already right: no post')
  assert.equal(planNeedsPost(`old:success`, { head, planState: 'success' }, 'success'), true, 'new head: post for it')
  assert.equal(planNeedsPost(`${head}:success`, { head }, 'success'), false, 'GitHub state unknown: trust the record')
  assert.equal(planNeedsPost(`${head}:pending`, { head, planState: 'pending' }, 'success'), true, 'prerequisite became verified')
})
