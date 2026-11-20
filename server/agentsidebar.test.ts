// Threads perch's automation started stay out of your sections and show under Agent runs instead.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { run } from './db.ts'
import './promises.ts' // perch_started
import { backfillStartedBy, markSeen } from './conversations.ts'
import { sidebar } from './sidebar.ts'

test('agent-started threads go to Agent runs; yours stay in your sections', () => {
  const now = Date.now()
  for (const [id, title] of [['mine', 'My ask'], ['helper-run', 'Helper: x'], ['legacy-routine', 'Read-only. Summarise'], ['legacy-mine', 'Old ask']]) {
    run(`insert into conversations (id, source, title, first_prompt, started_at, updated_at, messages, status) values (?, 'claude', ?, ?, ?, ?, 2, 'completed')`, id, title, title, now, now)
    markSeen(id)
  }
  run(`insert into perch_started (id, at, by) values ('mine', ?, 'you'), ('helper-run', ?, 'helper')`, now, now)
  // Rows from before perch recorded who started them: worked out from routine runs, else yours.
  run(`insert into perch_started (id, at) values ('legacy-routine', ?), ('legacy-mine', ?)`, now, now)
  run(`create table if not exists routine_runs (id text primary key, routine_id text not null, conversation_id text, started_at integer, finished_at integer, outcome text, detail text, cost real)`)
  run(`insert into routine_runs (id, routine_id, conversation_id) values ('rr1', 'r1', 'legacy-routine')`)
  backfillStartedBy()

  const side = sidebar()
  const yours = [...side.now, ...side.needs, ...side.working, ...side.groups.flatMap(g => g.items)].map(c => c.id)
  const agents = side.agents.map(c => c.id)
  assert.ok(yours.includes('mine') && yours.includes('legacy-mine'))
  for (const id of ['helper-run', 'legacy-routine']) { assert.ok(!yours.includes(id), `${id} in your list`); assert.ok(agents.includes(id), `${id} not in agent runs`) }
  assert.equal(side.agents.find(c => c.id === 'helper-run')?.agent_kind, 'helper')

  // Writing in one makes it yours.
  run(`update perch_started set by = 'you' where id = 'helper-run'`)
  assert.ok(!sidebar().agents.map(c => c.id).includes('helper-run'))
})
