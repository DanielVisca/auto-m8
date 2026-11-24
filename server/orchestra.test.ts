// watch stop: the MCP tool sends stop: [ids]; reading only targets stopped nothing (2026-11-14).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { all, run } from './db.ts'
import { stopTargets, unwatch, watch } from './orchestra.ts'

const active = (owner: string) => all<any>('select target from watches where owner = ? and active = 1 order by target', owner).map(r => r.target)

test('stopTargets: stop arrays, legacy stop:true + targets, and all', () => {
  assert.deepEqual(stopTargets({ stop: ['a', 'perch://b'] }), ['a', 'perch://b'])
  assert.deepEqual(stopTargets({ stop: true, targets: ['a'] }), ['a'])
  assert.deepEqual(stopTargets({ stop: ['a'], targets: ['a', 'c'] }), ['a', 'c'])
  assert.equal(stopTargets({ stop: 'all' }), 'all')
})

test('stop: [ids] (raw, auto-m8:// and perch://) actually deactivates those watches and reports how many', () => {
  const owner = 'owner-stop-test'
  for (const id of ['conv-1', 'conv-2', 'conv-3']) run(`insert or ignore into conversations (id, source, started_at, updated_at, messages) values (?, 'claude', 0, 0, 0)`, id)
  watch({ owner, targets: ['conv-1', 'conv-2', 'conv-3'] })
  assert.deepEqual(active(owner), ['conv-1', 'conv-2', 'conv-3'])
  assert.equal(unwatch(owner, stopTargets({ stop: ['auto-m8://conv-1', 'perch://conv-2'] })), 2)
  assert.deepEqual(active(owner), ['conv-3'])
  assert.equal(unwatch(owner, stopTargets({ stop: ['conv-1'] })), 0) // already stopped: honest zero
  assert.equal(unwatch(owner, stopTargets({ stop: 'all' })), 1)
  assert.deepEqual(active(owner), [])
})
