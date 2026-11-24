import assert from 'node:assert/strict'
import { test } from 'node:test'
import { armFor, banditPick, betaSample, calibration, constraintReasons, ledgerRow, model, remainingHours, shrunk, value } from './learn.ts'

// Deterministic generator so the bandit and sampler tests don't flake.
const lcg = (seed = 1) => () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32

test('betaSample: mean of Beta(8, 2) is about 0.8', () => {
  const r = lcg(7); let s = 0
  for (let i = 0; i < 4000; i++) s += betaSample(8, 2, r)
  assert.ok(Math.abs(s / 4000 - 0.8) < 0.02, String(s / 4000))
})

test('shrunk: few observations stay near the prior, many follow the data', () => {
  assert.ok(Math.abs(shrunk(1, 1, 0.5) - 0.6) < 1e-9)
  assert.ok(shrunk(90, 100, 0.5) > 0.85)
})

test('armFor: a fixed order that both arms appear in and never changes for a day', () => {
  const days = Array.from({ length: 28 }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`)
  const arms = days.map(armFor)
  assert.equal(armFor('2026-12-01'), arms[0])
  const learned = arms.filter(a => a === 'learned').length
  assert.ok(learned > 6 && learned < 22, String(learned))
})

test('ledgerRow: open PRs and unresolved proofs are censored, not failures', () => {
  const base = { url: 'u', repo: 'PostHog/posthog', area: 'metrics', created: 0, closed: null }
  const open = ledgerRow({ ...base, merged: null, outcome: 'moving' }, null, null, null)
  assert.equal(open.shipped, null)
  const day = 86400_000
  const quiet = ledgerRow({ ...base, merged: 3600_000, outcome: 'merged' }, { total: 2, ms: 1 }, { state: 'not_yet', works: 'no_signal' }, 'claude-opus-5-5', 3600_000 + 2 * day)
  assert.equal(quiet.shipped, 1); assert.equal(quiet.proven, null); assert.equal(quiet.hoursToMerge, 1)
  // past the 7-day proof window a not_yet PR was never proven: an outcome (0), with no verdict time
  const never = ledgerRow({ ...base, merged: 3600_000, outcome: 'merged' }, null, { state: 'not_yet', works: 'no_signal', updated_at: 5 }, null, 3600_000 + 8 * day)
  assert.equal(never.proven, 0); assert.equal(never.verdictAt, null); assert.equal(never.hoursToVerdict, null)
  const bad = ledgerRow({ ...base, merged: 1, outcome: 'merged' }, null, { state: 'concerns', updated_at: 7200_000 }, null)
  assert.equal(bad.proven, 0); assert.equal(bad.hoursToVerdict, 2)
  assert.equal(ledgerRow({ ...base, merged: null, outcome: 'abandoned' }, null, null, null).shipped, 0)
})

test('remainingHours: conditional on how long the PR has already waited', () => {
  const hours = [1, 2, 3, 10, 20, 40]
  assert.equal(remainingHours(hours, 0), 6.5)   // median of all
  assert.equal(remainingHours(hours, 15), 15)   // median of {20, 40} = 30, minus 15
  assert.equal(remainingHours(hours, 100), 100) // past every observation: assume as long again
})

test('value: an area that ships and proves more ranks higher at equal age', () => {
  const mk = (area: string, merged: boolean, proven: 0 | 1 | null, i: number) =>
    ({ url: `${area}${i}`, repo: 'PostHog/posthog', area, created: 0, merged: merged ? 10 * 3600_000 : null, closed: null, outcome: merged ? 'merged' : 'abandoned',
       usd: 1, activeMs: 0, model: null, proof: null, works: null, contained: null, verdictAt: null, shipped: (merged ? 1 : 0) as 0 | 1, proven,
       hoursToMerge: merged ? 10 : null, hoursToVerdict: null, arm: 'control' })
  const rows = [...Array.from({ length: 10 }, (_, i) => mk('good', true, 1, i)), ...Array.from({ length: 10 }, (_, i) => mk('bad', i < 4, i < 4 ? 0 : null, i))]
  const m = model(rows)
  assert.ok(value(m, 'good', 0, 3600_000).score > value(m, 'bad', 0, 3600_000).score)
})

test('calibration: needs 20 closed PRs, and finds signal when areas really differ', () => {
  assert.equal(calibration([]).skill, null)
  const rows: any[] = []
  for (let i = 0; i < 30; i++) rows.push({ area: 'a', shipped: 1 }, { area: 'b', shipped: i < 3 ? 1 : 0 })
  assert.ok(calibration(rows).skill! > 0.3)
})

test('constraintReasons: names each limit that was hit', () => {
  assert.deepEqual(constraintReasons({ claudePct: 0.5, codexPct: 0, strained: false, helpers: 1, helperCap: 6, shepherdCapped: 0 }), [])
  assert.deepEqual(constraintReasons({ claudePct: 0.85, codexPct: 0, strained: true, helpers: 6, helperCap: 6, shepherdCapped: 2 }), ['claude-quota', 'machine', 'helpers', 'shepherd-cap'])
})

test('banditPick: explores without data, exploits a cheap model that keeps matching', () => {
  const none = banditPick(['claude-sonnet-5-5', 'claude-haiku-5-5'], new Map(), lcg(3))
  assert.equal(none.chosen.length, 1)
  const stats = new Map([['claude-haiku-5-5', { s: 9, n: 10, costRatios: [0.1] }], ['claude-sonnet-5-5', { s: 1, n: 10, costRatios: [0.4] }]])
  const r = lcg(5); let haiku = 0
  for (let i = 0; i < 200; i++) if (banditPick(['claude-sonnet-5-5', 'claude-haiku-5-5'], stats, r).chosen[0] === 'claude-haiku-5-5') haiku++
  assert.ok(haiku > 180, String(haiku))
})
