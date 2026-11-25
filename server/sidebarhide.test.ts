// Shepherd runs (PR watch, push-through) are automation: they stay out of the lists unless asked for.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { run } from './db.ts'
import { editLabels } from './conversations.ts'
import { list } from './conversations.ts'

test('shepherd conversations stay out of the lists unless asked for', () => {
  const now = Date.now()
  for (const [id, title] of [['thread-mine', 'My thread'], ['thread-shepherd', 'Shepherd: repo#1']]) {
    run(`insert into conversations (id, source, title, first_prompt, started_at, updated_at, messages, status) values (?, 'claude-code', ?, ?, ?, ?, 2, 'completed')`, id, title, title, now, now)
  }
  editLabels(['thread-shepherd'], ['shepherd'])
  const ids = (q?: string) => list({ q, limit: 500, focus: false }).conversations.map(c => c.id)
  assert.ok(ids().includes('thread-mine'))
  assert.ok(!ids().includes('thread-shepherd'))
  assert.ok(ids('is:auto').includes('thread-shepherd'))
})

test('a word search finds your chats, and agent runs only with is:any', () => {
  const now = Date.now()
  for (const [id, title] of [['search-mine', 'Flamingo rollout plan'], ['search-shepherd', 'Shepherd: flamingo rollout']]) {
    run(`insert into conversations (id, source, title, first_prompt, started_at, updated_at, messages, status) values (?, 'claude-code', ?, ?, ?, ?, 2, 'completed')`, id, title, title, now, now)
    run(`insert into search (id, title, body) values (?, ?, ?)`, id, title, title)
  }
  editLabels(['search-shepherd'], ['shepherd'])
  const r = list({ q: 'flamingo', limit: 500, focus: false })
  const ids = r.conversations.map(c => c.id)
  assert.ok(ids.includes('search-mine'))
  assert.ok(!ids.includes('search-shepherd'))
  assert.equal(r.counts.auto, 1)
  assert.ok(list({ q: 'flamingo is:any', limit: 500, focus: false }).conversations.some(c => c.id === 'search-shepherd'))
})
