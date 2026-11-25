import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run } from './db.ts'
import { AGENT_MARK, marked, relay } from './relay.ts'

test('agent-sent messages carry a marker naming the sender', () => {
  run(`insert or replace into conversations (id, source, title, first_prompt, updated_at) values ('drv-1', 'claude', 'Ana "pair"', 'x', 0)`)
  const m = marked('drv-1', 'Ship it.').match(AGENT_MARK)
  assert.ok(m)
  assert.equal(m[1], 'drv-1')
  assert.equal(m[2], 'Ana  pair ')
  assert.equal(marked('drv-1', 'Ship it.').slice(m[0].length), 'Ship it.')
})

test('relay refuses itself, unknown and non-Claude conversations', () => {
  assert.throws(() => relay({ from: 'a', to: 'a', message: 'hi' }), /own conversation/)
  assert.throws(() => relay({ from: 'a', to: 'nope', message: 'hi' }), /No conversation/)
  run(`insert or replace into conversations (id, source, updated_at) values ('task:1', 'posthog-task', 0)`)
  assert.throws(() => relay({ from: 'a', to: 'task:1', message: 'hi' }), /only Claude Code/)
})

test('PR diffs turn into events', async () => {
  const { diffPr } = await import('./orchestra.ts')
  const s = { repo: 'PostHog/posthog', number: 1, title: 't', failing: ['lint'], approvedBy: ['ben'], changesBy: [], url: 'https://github.com/PostHog/posthog/pull/1' }
  const base = { state: 'open', checks: 'running', failing: [], review: 'review required', unresolved: 0, head: 'a', stage: null }
  const evs = (cur: any) => diffPr(base, { ...base, ...cur }, s).map(e => e[0])
  assert.deepEqual(evs({ checks: 'failing', failing: ['lint'] }), ['ci_red'])
  assert.deepEqual(evs({ checks: 'passing', review: 'approved' }), ['ci_green', 'approved'])
  assert.deepEqual(evs({ state: 'merged' }), ['merged'])
  assert.deepEqual(evs({ head: 'b', unresolved: 2 }), ['new_commit', 'new_threads'])
  assert.deepEqual(evs({}), [])
})

test('watch and board for an owner', async () => {
  const { watch, watchesOf, board, push, pendingFor } = await import('./orchestra.ts')
  run(`insert or replace into conversations (id, source, title, first_prompt, updated_at) values ('wk-1', 'claude', 'worker', 'x', ${Date.now()})`)
  watch({ owner: 'drv-1', targets: ['wk-1'] })
  assert.equal(watchesOf('drv-1').length, 1)
  assert.throws(() => watch({ owner: 'drv-1', targets: ['missing'] }), /No conversation/)
  push('drv-1', 'wk-1', 'turn_end', 'done')
  assert.equal(pendingFor('drv-1').length, 1)
  const text = await board('drv-1')
  assert.match(text, /auto-m8:\/\/wk-1 "worker"/)
  assert.match(text, /Events not yet delivered \(1\)/)
})

test('sentIn reads agent-sent messages under both the auto-m8 and old perch markers', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { sentIn } = await import('./relay.ts')
  const f = join(mkdtempSync(join(tmpdir(), 'relay-')), 't.jsonl')
  const line = (uuid: string, text: string) => JSON.stringify({ type: 'user', uuid, timestamp: '2026-11-24T10:00:00Z', message: { content: text } })
  writeFileSync(f, [
    line('u1', '[auto-m8: sent by an agent from auto-m8://aaa "Driver". Not typed by the user.]\n\nShip it.'),
    line('u2', '[perch: sent by an agent from perch://bbb. Not typed by the user.]\n\nOld one.'),
    line('u3', 'a message the user typed'),
  ].join('\n'))
  const got = sentIn(f)
  assert.deepEqual(got.map(m => [m.from, m.preview]), [['aaa', 'Ship it.'], ['bbb', 'Old one.']])
})
