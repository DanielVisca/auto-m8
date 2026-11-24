import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { run } from './db.ts'
import { candidates, writeMemories } from './lifecycle.ts'

test('memories are written in the memory format with a pointer back, and indexed once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'))
  writeFileSync(join(dir, 'MEMORY.md'), '- [Old](old.md) — x\n')
  writeFileSync(join(dir, 'old.md'), '---\nname: old\n---\n\nold fact\n')
  const c = { id: 'conv-1', title: 'Flags for Ben', updated_at: Date.parse('2026-11-01') }
  const files = writeMemories(dir, c, { outcome: 'complete', summary: 's', memories: [
    { name: 'Team Cohort Gap!', type: 'reference', title: 'Team cohort gap', hook: 'cohort misses Ben', description: 'd', body: 'The cohort excludes some people.' },
    { name: 'bad', type: 'nonsense', body: 'x' },
  ], updates: [{ file: 'old.md', add: 'More on old.' }, { file: '../etc.md', add: 'no' }] })
  assert.deepEqual(files, ['team-cohort-gap.md', 'old.md'])
  const m = readFileSync(join(dir, 'team-cohort-gap.md'), 'utf8')
  assert.match(m, /^---\nname: team-cohort-gap\ndescription: d\nmetadata:\n {2}type: reference\n---/)
  assert.match(m, /Source: auto-m8:\/\/conv-1 \("Flags for Ben", 2026-11-01\)/)
  assert.match(readFileSync(join(dir, 'old.md'), 'utf8'), /More on old\.\nSource: auto-m8:\/\/conv-1/)
  const index = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
  assert.equal(index.split('\n').filter(Boolean).length, 2)
  assert.match(index, /- \[Team cohort gap\]\(team-cohort-gap\.md\) — cohort misses Ben/)
})

test('only quiet, unpinned chats you did not set by hand are candidates', () => {
  const old = Date.now() - 3 * 86400_000
  for (const id of ['q1', 'pinned', 'mine', 'fresh', 'helper1']) run(`insert or replace into conversations (id, source, path, updated_at) values (?, 'claude', '/x', ?)`, id, id === 'fresh' ? Date.now() : old)
  run(`insert or replace into user_state (id, pinned) values ('pinned', 1)`)
  run(`insert or replace into user_state (id, state, state_auto) values ('mine', 'active', 0)`)
  run(`insert or ignore into labels (conversation_id, label, auto, created_at) values ('helper1', 'helper', 1, 0)`)
  const ids = candidates().map(c => c.id)
  assert.ok(ids.includes('q1'))
  for (const id of ['pinned', 'mine', 'fresh', 'helper1']) assert.ok(!ids.includes(id), id)
})
