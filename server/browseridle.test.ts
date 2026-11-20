// Idle agent windows are closed; busy, taken-over, approval-waiting and recent ones are kept (2026-11-16).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run } from './db.ts'
import { approvals, idleWindows, IDLE_CLOSE_MS, setOwnerBusy } from './browser.ts'

test('only stale windows of quiet chats are picked; busy, taken over, waiting and recent ones stay', () => {
  const now = Date.now(), old = now - IDLE_CLOSE_MS - 60_000
  const row = (owner: string, at: number, paused = 0) => run('insert or replace into browser_sessions (owner, target_id, created_at, updated_at, paused) values (?, ?, ?, ?, ?)', owner, `t-${owner}`, at, at, paused)
  row('stale', old); row('busy', old); row('taken', old, 1); row('approval', old); row('recent', now - 60_000)
  setOwnerBusy(o => o === 'busy')
  approvals.set('a1', { owner: 'approval', state: 'pending' } as any)
  try { assert.deepEqual(idleWindows(now).sort(), ['stale']) } finally { approvals.delete('a1'); setOwnerBusy(() => false) }
})
