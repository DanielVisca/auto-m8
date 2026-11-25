import assert from 'node:assert/strict'
import { test } from 'node:test'
import { helperMode } from './delegate.ts'

test('helpers that may edit inherit the parent permission mode, plan stays read-only', () => {
  assert.equal(helperMode(undefined, 'auto'), 'auto')
  assert.equal(helperMode('acceptEdits', 'auto'), 'auto')
  assert.equal(helperMode('plan', 'auto'), 'plan')
  assert.equal(helperMode(undefined, 'plan', 'auto'), 'auto')       // a planning parent still gets a working helper
  assert.equal(helperMode(undefined, undefined, 'auto'), 'auto')    // parent not running in auto-m8: user default
  assert.equal(helperMode(undefined, undefined, 'default'), 'acceptEdits')
  assert.equal(helperMode(undefined, 'bypassPermissions'), 'bypassPermissions')
})
