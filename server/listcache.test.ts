// The chat list rebuilds at once for writes you'd see, and lazily for background churn (2026-11-16).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run } from './db.ts'
import { list, listBuilds } from './conversations.ts'

const builds = () => listBuilds
test('background writes reuse the list; a label or state change rebuilds it at once', () => {
  run(`insert or ignore into conversations (id, source, title, started_at, updated_at, messages) values ('lc-1', 'claude', 'one', ?, ?, 3)`, Date.now(), Date.now())
  list({ limit: 50, focus: false } as any)
  const b0 = builds()
  for (let i = 0; i < 5; i++) { run(`update conversations set updated_at = ? where id = 'lc-1'`, Date.now() + i); list({ limit: 50, focus: false } as any) } // indexing churn
  assert.equal(builds(), b0, 'indexing writes must not rebuild every row on each call')
  run(`insert into labels (conversation_id, label) values ('lc-1', 'urgent')`)
  const r = list({ limit: 50, focus: false } as any)
  assert.equal(builds(), b0 + 1, 'a label must show at once')
  assert.deepEqual(r.conversations.find((c: any) => c.id === 'lc-1')?.labels, ['urgent'])
  run(`insert or replace into user_state (id, state) values ('lc-1', 'later')`)
  list({ limit: 50, focus: false } as any)
  assert.equal(builds(), b0 + 2, 'a state change must show at once')
})
