import assert from 'node:assert/strict'
import { test } from 'node:test'
import { available, capFrom, markCapped, route, capScope, isCodex, isLocal } from './router.ts'

const r = (p: string, o: Partial<Parameters<typeof route>[1]> = {}) => route(p, { current: null, corrected: false, images: 0, turbo: false, ...o }).tier

test('auto picks a model for the job', () => {
  assert.equal(r('what does this flag do?'), 'haiku')
  assert.equal(r('add a retry to the uploader and update its tests'), 'sonnet')
  assert.equal(r('design the data model for per-team metric quotas'), 'opus')
  assert.equal(r('why does the consumer lag spike after deploys?'), 'opus')
  assert.equal(r('look at this', { images: 1 }), 'opus')
  assert.equal(r('anything', { turbo: true }), 'opus')
})

test('follow-ups keep the model; corrections step up', () => {
  assert.equal(r('continue', { current: 'opus' }), 'opus')
  assert.equal(r('ok go ahead', { current: 'haiku' }), 'haiku')
  assert.equal(r('no, that is wrong', { current: 'haiku', corrected: true }), 'sonnet')
  assert.equal(r('still failing', { current: 'opus', corrected: true }), 'opus')
})

test('usage caps: reset time from the message, and the next model down', () => {
  const t = capFrom('Claude AI usage limit reached|1793898000')
  assert.equal(t, 1793898000 * 1000)
  assert.ok(capFrom("You've hit your weekly limit · resets 3pm")! > Date.now())
  assert.equal(capFrom('some other error'), null)
  markCapped('opus', Date.now() + 60_000)
  assert.equal(available('opus'), 'sonnet')
  markCapped('sonnet', Date.now() + 60_000)
  assert.equal(available('opus'), 'haiku')
  markCapped('haiku', Date.now() + 60_000)
  assert.equal(available('opus'), null)
})

test('a large conversation stays on its model rather than reloading everything', () => {
  assert.equal(route('what time is it?', { current: 'opus', corrected: false, images: 0, turbo: false, context: 150_000 }).tier, 'opus')
  assert.equal(route('what time is it?', { current: 'opus', corrected: false, images: 0, turbo: false, context: 10_000 }).tier, 'haiku')
  assert.equal(route('design the sharding scheme', { current: 'haiku', corrected: false, images: 0, turbo: false, context: 150_000 }).tier, 'opus') // stepping up still happens
})

test('the account-wide spend cap is a cap on every Claude model, with its reset time', () => {
  const msg = "You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit · your 5-hour limit resets 1:50pm (America/Los_Angeles)"
  const until = capFrom(msg)
  assert.ok(until && until > Date.now())
  assert.equal(new Date(until!).getHours(), 13)
  assert.equal(capScope(msg), 'all')
  assert.equal(capScope('You have reached your Opus weekly limit'), 'opus')
  assert.equal(capFrom('Fixed the failing test'), null)
})

test('codex engines are neither Claude nor local', () => {
  assert.ok(isCodex('codex') && isCodex('codex:gpt-6-astra'))
  assert.ok(!isLocal('codex') && isLocal('qwen3-coder:30b'))
})
