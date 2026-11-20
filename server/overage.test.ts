import assert from 'node:assert/strict'
import { test } from 'node:test'
import { codexOverage, overageLine } from './overage.ts'

const now = Date.UTC(2026, 10, 17, 12)
const sec = (ms: number) => Math.floor(ms / 1000)

// Shapes trimmed from real GET chatgpt.com/backend-api/wham/usage responses (Nov 2026).
const reset = sec(now) + 3 * 86400, monthEnd = sec(Date.UTC(2026, 11, 1))
const codex = (p: number, o: { credits?: any; spend?: any } = {}) => ({
  rate_limit: { limit_reached: p >= 100, primary_window: { used_percent: p, limit_window_seconds: 604800, reset_at: reset }, secondary_window: null },
  credits: o.credits ?? { has_credits: true, unlimited: false, overage_limit_reached: false, balance: null },
  spend_control: o.spend === undefined ? { reached: false, individual_limit: { unit: 'credit', limit: '25000', used: '5000', remaining: '20000', used_percent: 20, reset_at: monthEnd } } : o.spend,
})

test('codex: hidden under 80% with room left, or without any credits', () => {
  assert.equal(codexOverage(codex(50), now), null)
  assert.equal(codexOverage(codex(50, { credits: { has_credits: false, unlimited: false }, spend: null }), now), null)
  assert.equal(codexOverage(null, now), null)
})
test('codex: the real Nov 2026 state — plan window full and the workspace credit cap spent', () => {
  const s = codexOverage(codex(100, { spend: { reached: true, individual_limit: { unit: 'credit', limit: '25000', used: '25000.000000953674', remaining: '0', used_percent: 100, reset_at: monthEnd } } }), now)!
  assert.equal(s.unit, 'credits'); assert.equal(s.onCredits, true); assert.equal(s.exhausted, true); assert.equal(s.remaining, 0); assert.equal(s.limit, 25000)
  assert.equal(s.resetsAt, monthEnd * 1000)
  const l = overageLine(s, now)!
  assert.equal(l.text, 'Out of credits · resets Dec 1'); assert.equal(l.heat, 'hot'); assert.match(l.title, /25,000 of 25,000 credits used/)
})
test('codex: shown at 80% with the credits left of the workspace cap', () => {
  const s = codexOverage(codex(85), now)!
  assert.equal(s.onCredits, false); assert.equal(s.remaining, 20000); assert.equal(s.low, false)
  assert.equal(overageLine(s, now)!.text, 'Credits on · 20,000 of 25,000 left · resets Dec 1')
})
test('codex: low under 20% of the cap', () => {
  const s = codexOverage(codex(100, { spend: { reached: false, individual_limit: { limit: '25000', used: '21000', remaining: '4000', reset_at: monthEnd } } }), now)!
  assert.equal(s.low, true); assert.equal(s.exhausted, false); assert.equal(overageLine(s, now)!.heat, 'warm')
})
test('codex: no cap falls back to credits.balance; overage_limit_reached means exhausted', () => {
  const s = codexOverage(codex(100, { credits: { has_credits: true, unlimited: false, balance: '120' }, spend: null }), now)!
  assert.equal(s.remaining, 120); assert.equal(s.limit, undefined)
  assert.equal(codexOverage(codex(100, { credits: { has_credits: true, overage_limit_reached: true, balance: null }, spend: null }), now)!.exhausted, true)
})
test('codex: unlimited credits are never low', () => {
  const s = codexOverage(codex(100, { credits: { has_credits: true, unlimited: true, balance: null }, spend: null }), now)!
  assert.equal(s.remaining, undefined); assert.equal(s.low, false); assert.equal(s.onCredits, true)
})
