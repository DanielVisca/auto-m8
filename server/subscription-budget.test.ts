import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chooseProvider, subscriptionBudget } from './subscription-budget.ts'
import type { Usage } from './usage.ts'

const now = Date.UTC(2026, 10, 16, 19)
const week = (pct: number, daysLeft = 4, more: Partial<Usage> = {}): Usage => ({ at: now, windows: [{ key: 'seven_day', label: 'week', pct, resetsAt: now + daysLeft * 86400_000 }], ...more })
const choose = (claude: Usage | null, codex: Usage | null, extra: Partial<Parameters<typeof chooseProvider>[0]> = {}) => chooseProvider({ claude, codex, tier: 'opus', now, claudeReady: true, codexReady: true, localReady: true, ...extra })

test('an allowance at 65% with five days left switches to the healthier subscription before 95%', () => {
  const choice = choose(week(0.65, 5), week(0.2, 5))
  assert.equal(choice.provider, 'codex')
  assert.equal(choice.conserve, true)
})

test('a full included allowance with existing credits is still usable, unless a spend control blocks it', () => {
  const credits = week(1, 4, { creditsAvailable: true })
  assert.equal(subscriptionBudget(credits, '', now).exhausted, false)
  assert.equal(choose(week(1), credits).provider, 'codex')
  assert.equal(choose(week(1), { ...credits, blocked: true }).provider, 'local')
})

test('both subscriptions actually exhausted selects the local fallback; soft pressure alone preserves quality', () => {
  assert.equal(choose(week(1), week(1)).provider, 'local')
  assert.notEqual(choose(week(0.94), week(0.97)).provider, 'local')
  assert.equal(choose(week(1), week(0.8), { codexReady: false }).provider, 'local')
})

test('warm conversations stay put until a meaningful budget difference warrants switching', () => {
  assert.equal(choose(week(0.5), week(0.51), { current: 'codex' }).provider, 'codex')
  assert.equal(choose(week(0.1), week(0.8), { current: 'codex' }).provider, 'claude')
  assert.equal(choose(week(0.1), week(0.2)).provider, 'claude')
})

test('reset, stale and malformed observations cannot exclude a working subscription', () => {
  const expired = week(1, -1)
  assert.equal(subscriptionBudget(expired, 'opus', now).pressure, 0)
  assert.equal(choose(expired, week(0.6)).provider, 'claude')
  assert.equal(subscriptionBudget(week(1, 3, { at: now - 31 * 60_000 }), '', now).exhausted, false)
  assert.equal(subscriptionBudget({ at: now, windows: [{ key: 'm10080', label: 'week', pct: NaN, resetsAt: NaN }] }, '', now).pressure, 0)
  assert.equal(choose(null, null).conserve, false)
})

test('model-specific and short-window limits apply only to the appropriate work', () => {
  const opus: Usage = { at: now, windows: [{ key: 'seven_day_opus', label: 'Opus week', pct: 1, resetsAt: now + 86400_000 }] }
  assert.equal(subscriptionBudget(opus, 'sonnet', now).exhausted, false)
  assert.equal(subscriptionBudget(opus, 'opus', now).exhausted, true)
  const short: Usage = { at: now, windows: [{ key: 'five_hour', label: '5h', pct: 0.96, resetsAt: now + 3600_000 }] }
  assert.equal(choose(short, week(0.1)).provider, 'codex')
  assert.equal(choose(week(0.96, 0.01), week(0.1)).provider, 'codex')
})
