// Follow-up promises: which PR a reminder waits on, and when a reminder is not needed at all.
// Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { db, get } from './db.ts'
import { addPromise, detectPromise } from './promises.ts'

const pr = (url: string, state: string, checks: string | null = null, review: string | null = null) =>
  db.prepare('insert or replace into prs (url, number, state, checks, review) values (?, ?, ?, ?, ?)')
    .run(url, Number(url.split('/').pop()), state, checks, review)

const openPromise = (conversationId: string) =>
  get<any>(`select text, pr_url, until, due_at from promises where conversation_id = ? and status = 'open' order by created_at desc limit 1`, conversationId)

test('a promise that names no PR does not attach a PR linked to the chat', () => {
  const url = 'https://github.com/PostHog/posthog/pull/9101'
  pr(url, 'OPEN', 'PENDING')
  detectPromise('conv-no-guess', "I'll let you know when CI finishes", [url])
  const p = openPromise('conv-no-guess')
  assert.ok(p, 'the promise is still kept')
  assert.equal(p.pr_url, null)
  assert.equal(p.until, null)
})

test('a promise attaches the PR it names by number', () => {
  const url = 'https://github.com/PostHog/posthog/pull/9102'
  pr(url, 'OPEN', 'PENDING')
  detectPromise('conv-named', "I'll check back on #9102 in 30 minutes", [url])
  const p = openPromise('conv-named')
  assert.equal(p.pr_url, url)
  assert.equal(p.until, 'checks')
})

test('a second promise from the text is skipped while the agent has its own follow-up open', () => {
  addPromise({ conversation_id: 'conv-own', text: 'the agent registered this one', source: 'tool', due_at: Date.now() + 60_000 })
  const result = detectPromise('conv-own', "I'll check back in 10 minutes", [])
  assert.equal(result, null)
  assert.equal(openPromise('conv-own').text, 'the agent registered this one')
})

test('a promise about a PR that already merged is not kept', () => {
  const url = 'https://github.com/PostHog/posthog/pull/9103'
  pr(url, 'MERGED')
  const result = detectPromise('conv-merged', "Once #9103 merges I'll update the next PR", [url])
  assert.equal(result, null)
  assert.equal(openPromise('conv-merged'), undefined)
})
