import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseClaudeUsage, parseCodexUsage } from './usage.ts'
import { subscriptionBudget } from './subscription-budget.ts'

test('real Codex credit telemetry keeps a full included week available', () => {
  const now = Date.now()
  const rl = { limit_id: 'codex', primary: { used_percent: 100, window_minutes: 10080, resets_at: (now + 86400_000) / 1000 }, secondary: null, credits: { has_credits: true, unlimited: false, balance: null }, plan_type: 'self_serve_business_prolite' }
  const usage = parseCodexUsage(rl, now)!
  assert.equal(usage.creditsAvailable, true)
  assert.equal(usage.windows[0].minutes, 10080)
  assert.equal(subscriptionBudget(usage, '', now).exhausted, false)
  assert.equal(subscriptionBudget(parseCodexUsage({ ...rl, credits: null }, now), '', now).exhausted, true)
  assert.equal(subscriptionBudget(parseCodexUsage({ ...rl, spend_control_reached: true }, now), '', now).exhausted, true)
})

test('unrelated model buckets and malformed telemetry cannot replace the plan allowance', () => {
  assert.equal(parseCodexUsage(null, Date.now()), null)
  assert.equal(parseCodexUsage({ primary: { used_percent: '100' } }, Date.now()), null)
  assert.equal(parseCodexUsage({ limit_id: 'other-model', primary: { used_percent: 100, window_minutes: 10080, resets_at: 2000000000 } }, Date.now()), null)
})

test('a Claude 5h window at 100% stays usable while extra usage is allowed', () => {
  const now = Date.now(), reset = (now + 3 * 3600_000) / 1000
  // Modeled on the events Claude Code streamed on 2026-11-17 while the plan was on extra usage.
  const ev = (overageStatus: string | undefined, status = 'allowed_warning') => ({ type: 'rate_limit_event', rate_limit_info: {
    status, rateLimitType: 'overage', overageStatus, isUsingOverage: true,
    unifiedWindows: { five_hour: { utilization: 1, resetsAt: reset, status: 'rejected' }, seven_day: { utilization: 0.1, resetsAt: reset + 86400, status: 'allowed' } },
  } })
  assert.equal(subscriptionBudget(parseClaudeUsage(ev('allowed_warning'), now), 'opus', now).exhausted, false)
  assert.equal(subscriptionBudget(parseClaudeUsage(ev('allowed'), now), 'opus', now).exhausted, false)
  // No extra usage, or extra usage used up: Claude refuses, so perch must route elsewhere.
  assert.equal(subscriptionBudget(parseClaudeUsage(ev(undefined), now), 'opus', now).exhausted, true)
  assert.equal(subscriptionBudget(parseClaudeUsage(ev('rejected', 'rejected'), now), 'opus', now).exhausted, true)
})
