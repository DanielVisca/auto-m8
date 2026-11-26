// Idle agent windows are closed; busy, taken-over, approval-waiting and recent ones are kept (2026-11-16).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run } from './db.ts'
import { approvals, idleWindows, IDLE_CLOSE_MS, park, setOwnerBusy } from './browser.ts'
import { get } from './db.ts'

test('only stale windows of quiet chats are picked; busy, taken over, waiting and recent ones stay', () => {
  const now = Date.now(), old = now - IDLE_CLOSE_MS - 60_000
  const row = (owner: string, at: number, paused = 0) => run('insert or replace into browser_sessions (owner, target_id, created_at, updated_at, paused) values (?, ?, ?, ?, ?)', owner, `t-${owner}`, at, at, paused)
  row('stale', old); row('busy', old); row('taken', old, 1); row('approval', old); row('recent', now - 60_000)
  setOwnerBusy(o => o === 'busy')
  approvals.set('a1', { owner: 'approval', state: 'pending' } as any)
  try { assert.deepEqual(idleWindows(now).sort(), ['stale']) } finally { approvals.delete('a1'); setOwnerBusy(() => false) }
})

test('parked windows keep their page and are not closed again', () => {
  const old = Date.now() - IDLE_CLOSE_MS - 60_000
  run('insert or replace into browser_sessions (owner, target_id, created_at, updated_at, url) values (?, ?, ?, ?, ?)', 'parked', 't-parked', old, old, 'https://example.com/a')
  park('parked', 'closed after 60 min idle')
  const r = get<any>('select target_id, url, parked_why from browser_sessions where owner = ?', 'parked')
  assert.deepEqual([r.target_id, r.url, r.parked_why], [null, 'https://example.com/a', 'closed after 60 min idle'])
  assert.ok(!idleWindows().includes('parked'))
})
