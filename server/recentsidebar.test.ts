// "More recent" pages through the chats you've been in, past the ones already in Now.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { run } from './db.ts'
import { markSeen } from './conversations.ts'
import { recentPage, sidebar } from './sidebar.ts'

test('recent pages continue after Now, newest first, only ones you opened', () => {
  const base = Date.now() - 60_000
  for (let i = 0; i < 12; i++) {
    const id = `recent-${i}`
    run(`insert into conversations (id, source, title, first_prompt, started_at, updated_at, messages, status) values (?, 'claude', ?, ?, ?, ?, 2, 'completed')`, id, id, id, base + i, base + i)
    markSeen(id)
  }
  run(`insert into conversations (id, source, title, first_prompt, started_at, updated_at, messages, status) values ('never-opened', 'claude', 'x', 'x', ?, ?, 2, 'completed')`, base + 99, base + 99)
  const now = sidebar().now.map(c => c.id)
  assert.equal(now.length, 5)
  const p1 = recentPage(0, 4), p2 = recentPage(4, 4)
  const ids = [...p1.conversations, ...p2.conversations].map(c => c.id)
  assert.deepEqual(ids, ['recent-6', 'recent-5', 'recent-4', 'recent-3', 'recent-2', 'recent-1', 'recent-0'])
  assert.ok(!ids.some(id => now.includes(id)), 'repeats a chat already in Now')
  assert.ok(!ids.includes('never-opened'))
  assert.equal(p1.total, 7)
})
