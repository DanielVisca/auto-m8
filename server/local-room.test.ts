import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localRoom } from './local.ts'

const GB = 1024 ** 3
test('a 19 GB model is not loaded for housekeeping when the Mac has 9 GB available', () => {
  assert.equal(localRoom({ availBytes: 9 * GB, load1: 4, cores: 15, modelBytes: 19 * GB, loaded: false }), false)
})
test('it loads when there is room for weights plus headroom', () => {
  assert.equal(localRoom({ availBytes: 30 * GB, load1: 4, cores: 15, modelBytes: 19 * GB, loaded: false }), true)
})
test('an already loaded model is used unless the machine is strained', () => {
  assert.equal(localRoom({ availBytes: 5 * GB, load1: 4, cores: 15, modelBytes: 19 * GB, loaded: true }), true)
  assert.equal(localRoom({ availBytes: 2 * GB, load1: 4, cores: 15, modelBytes: 19 * GB, loaded: true }), false)
  assert.equal(localRoom({ availBytes: 20 * GB, load1: 75, cores: 15, modelBytes: 19 * GB, loaded: true }), false)
})
test('unknown memory means no local model', () => {
  assert.equal(localRoom({ loaded: true }), false)
})
test('background context comes in two fixed sizes so Ollama does not reload the model per job', async () => {
  const { ctxFor } = await import('./local.ts')
  assert.equal(ctxFor('short'), 16384)
  assert.equal(ctxFor('x'.repeat(40_000)), 16384)
  assert.equal(ctxFor('x'.repeat(60_000)), 32768)
  assert.equal(ctxFor('x'.repeat(500_000)), 32768)
})
