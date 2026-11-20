import assert from 'node:assert/strict'
import { test } from 'node:test'
import { learningGate, learningGates } from './learning-budget.ts'
import type { Usage } from './usage.ts'

const now = 1_800_000_000_000
const usage = (windows: Partial<Usage['windows'][number]>[], extra = {}): Usage => ({ at: now, windows: windows.map(w => ({ key: 'five_hour', label: '5h', pct: 0.8, resetsAt: now + 1000, ...w })), ...extra })
const snapshot = (claude: Usage | null = null, codex: Usage | null = null) => ({ claude, codex })

test('experiments yield at 80%, before foreground routing, independently per provider', () => {
  const u = snapshot(usage([{ pct: 0.8 }]), usage([{ pct: 0.79, key: 'm10080' }]))
  assert.equal(learningGate('claude-sonnet-5-5', u, now)?.paused, true)
  assert.equal(learningGate('codex:gpt-6-astra', u, now)?.paused, false)
  assert.equal(learningGates(['claude-sonnet-5-5', 'codex:gpt-6-astra', 'qwen3-coder:30b'], u, now).length, 1)
  assert.equal(learningGate('qwen3-coder:30b', u, now), null)
})

test('every applicable window must have room; the latest blocking reset wins', () => {
  const u = snapshot(usage([{ pct: 1 }, { key: 'seven_day', label: 'week', pct: 0.88, resetsAt: now + 9000 }]))
  assert.equal(learningGate('claude-opus-5-5', u, now)?.resumesAt, now + 9000)
  assert.equal(learningGate('claude-opus-5-5', u, now + 1000)?.paused, true)
  assert.equal(learningGate('claude-opus-5-5', u, now + 9000)?.paused, false)
})

test('old high usage holds until reset; new lower usage releases immediately', () => {
  const high = usage([{ pct: 0.95 }], { at: now - 7 * 86400_000 })
  assert.equal(learningGate('claude:sonnet', snapshot(high), now)?.paused, true)
  assert.equal(learningGate('claude:sonnet', snapshot(high), now + 1000)?.paused, false)
  assert.equal(learningGate('claude:sonnet', snapshot(usage([{ pct: 0.3 }])), now)?.paused, false)
})

test('paid credits never override conserving included capacity for experiments', () => {
  assert.equal(learningGate('gpt-6.1-sol', snapshot(null, usage([{ key: 'm10080', pct: 1 }], { creditsAvailable: true })), now)?.paused, true)
})

test('tier-specific limits do not block unrelated Claude models', () => {
  const u = snapshot(usage([{ key: 'seven_day_sonnet', label: 'Sonnet week' }]))
  assert.equal(learningGate('claude-sonnet-5-5', u, now)?.paused, true)
  assert.equal(learningGate('claude-opus-5-5', u, now)?.paused, false)
})

test('missing usage is not an invented cap, malformed reset cannot release a known cap', () => {
  assert.equal(learningGate('claude-opus-5-5', snapshot(), now)?.paused, false)
  const g = learningGate('claude-opus-5-5', snapshot(usage([{ resetsAt: NaN }])), now)!
  assert.equal(g.paused, true)
  assert.equal(g.resumesAt, null)
  assert.equal(learningGate('claude-opus-5-5', snapshot(usage([{ pct: NaN }])), now)?.paused, false)
})
