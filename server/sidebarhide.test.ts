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
