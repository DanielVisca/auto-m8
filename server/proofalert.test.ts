import { test } from 'node:test'
import assert from 'node:assert/strict'
process.env.PERCH_DB ??= ':memory:'
const { proofAlerts } = await import('./mobile.ts')
const row = (o: any) => ({ url: 'https://github.com/PostHog/posthog/pull/1', state: 'concerns', healthy: 'pass', contained: 'pass', works: 'pass', used: 'pass', ...o })
test('health or blast-radius concern is P0', () => {
  assert.equal(proofAlerts([row({ contained: 'concern' })], new Set())[0].p, 0)
  assert.equal(proofAlerts([row({ healthy: 'concern' })], new Set())[0].p, 0)
})
test('works concern alone is P1, told ones and proven are skipped', () => {
  const a = proofAlerts([row({ works: 'concern' })], new Set())
  assert.equal(a[0].p, 1)
  assert.equal(proofAlerts([row({ works: 'concern' })], new Set([a[0].key])).length, 0)
  assert.equal(proofAlerts([row({ state: 'proven' })], new Set()).length, 0)
})
