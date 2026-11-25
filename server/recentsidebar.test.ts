// "More recent" pages through the chats you've been in, past the ones already in Now.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { run } from './db.ts'
import { list, markSeen } from './conversations.ts'
import './turns.ts'
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

test('recent moves on your message and the finished answer, not while the agent is mid-turn', () => {
  const t0 = Date.now() - 50_000
  const add = (id: string) => { run(`insert into conversations (id, source, title, first_prompt, started_at, updated_at, messages) values (?, 'claude', ?, ?, ?, ?, 2)`, id, id, id, t0, t0); markSeen(id) }
  add('turn-a'); add('turn-b')
  const order = () => list({ limit: 1000 }).conversations.map(c => c.id).filter(id => id.startsWith('turn-'))
  // You asked A, then B. A's agent is still writing (its transcript keeps moving), B's is done.
  run(`insert into turns (id, conversation_id, sent_at, source) values ('ta', 'turn-a', ?, 'perch')`, t0 + 1000)
  run(`insert into turns (id, conversation_id, sent_at, finished_at, source) values ('tb', 'turn-b', ?, ?, 'perch')`, t0 + 2000, t0 + 3000)
  run(`update conversations set updated_at = ? where id = 'turn-a'`, t0 + 9000)
  assert.deepEqual(order(), ['turn-b', 'turn-a'])
  // A finishes: now it comes up.
  run(`update turns set finished_at = ? where id = 'ta'`, t0 + 10_000)
  assert.deepEqual(order(), ['turn-a', 'turn-b'])
  assert.equal(list({ limit: 1000 }).conversations.find(c => c.id === 'turn-a')?.activity_at, t0 + 10_000)
})
