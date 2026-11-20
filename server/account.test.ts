import assert from 'node:assert/strict'
import { test } from 'node:test'
import { billing, claudeEnv, claudeOut, clearCaps, outUntil } from './account.ts'
import { clearAnthropicKey, setAnthropicKey } from './keychain.ts'
import { allCapped, available, markCapped } from './router.ts'
import { noteClaude, usageNow } from './usage.ts'

// Own file: caps and usage live in module state.
test('claude runs on its own login by default; an API key is passed as ANTHROPIC_API_KEY', () => {
  assert.equal(billing(), 'login')
  assert.deepEqual(claudeEnv(), {}, 'nothing is added on the Claude Code login')
  setAnthropicKey('sk-ant-api03-test')
  assert.equal(billing(), 'api')
  assert.deepEqual(claudeEnv(), { ANTHROPIC_API_KEY: 'sk-ant-api03-test' })
  clearAnthropicKey()
  assert.equal(billing(), 'login')
  assert.deepEqual(claudeEnv(), {})
})

test('Claude is out while every model is capped, and back after the reset', () => {
  clearCaps()
  assert.equal(claudeOut(), false)
  markCapped('all', Date.now() + 60_000)
  assert.equal(allCapped(), true)
  assert.equal(available('opus'), null)
  assert.equal(claudeOut(), true)
  assert.equal(claudeOut(Date.now() + 61_000), false)
  clearCaps()
  assert.equal(available('opus'), 'opus')
})

test('a usage window claude reports as rejected (no extra usage) marks it out until the reset', () => {
  clearCaps()
  const reset = Date.now() + 3_600_000
  noteClaude({ rate_limit_info: { status: 'rejected', overageStatus: 'rejected', unifiedWindows: { five_hour: { utilization: 1, resetsAt: reset / 1000 } } } }, Date.now())
  assert.equal(usageNow().claude?.windows[0].pct, 1)
  assert.equal(outUntil(), reset)
  // With extra usage allowed, a full window still counts as usable.
  noteClaude({ rate_limit_info: { status: 'allowed', overageStatus: 'allowed', unifiedWindows: { five_hour: { utilization: 1, resetsAt: reset / 1000 } } } }, Date.now() + 1)
  assert.equal(claudeOut(), false)
})
