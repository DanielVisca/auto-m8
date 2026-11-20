import assert from 'node:assert/strict'
import { test } from 'node:test'
import { run, get } from './db.ts'
import { autolinkPr, planForPrompt, prUrls } from './prroute.ts'

const URL = 'https://github.com/acme/app/pull/77'
const conv = (id: string, updated = Date.now()) => run(`insert or replace into conversations (id, source, title, updated_at, started_at) values (?, 'claude', ?, ?, ?)`, id, id, updated, Date.now())

test('extracts distinct PR urls', () => assert.deepEqual(prUrls(`look ${URL} and ${URL} then https://github.com/a/b/pull/2`), [URL, 'https://github.com/a/b/pull/2']))

test('a PR link continues the conversation that opened it', () => {
  conv('opener'); run('insert or replace into conversation_prs (conversation_id, url, created) values (?, ?, 1)', 'opener', URL)
  assert.equal(planForPrompt(`check ${URL}`).reuse, 'opener')
})

test('a stale opener is context, not a reuse', () => {
  conv('opener', Date.now() - 30 * 86_400_000)
  const p = planForPrompt(`check ${URL}`)
  assert.equal(p.reuse, null); assert.ok(p.contextIds.includes('opener'))
})

test('conversations sharing a PR get linked', () => {
  conv('other'); run('insert or replace into conversation_prs (conversation_id, url, created) values (?, ?, 0)', 'other', URL)
  autolinkPr('other', URL)
  assert.ok(get('select 1 from links where (a = ? and b = ?) or (a = ? and b = ?)', 'other', 'opener', 'opener', 'other'))
})
