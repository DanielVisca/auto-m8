import assert from 'node:assert/strict'
import { test } from 'node:test'
import { claudePeer, codexPeer, modelTier } from './model-tiers.ts'

const catalog = (...slugs: string[]) => slugs.map(slug => ({ slug, tier: modelTier(slug) }))
const models = catalog('gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna')

test('provider matching uses capability tiers for aliases and versioned model ids', () => {
  for (const model of ['haiku', 'claude:haiku', 'claude-haiku-5-5']) assert.equal(codexPeer(model, models, 'gpt-6-astra'), 'gpt-6-luna')
  for (const model of ['sonnet', 'claude-sonnet-5-5']) assert.equal(codexPeer(model, models, 'gpt-6-astra'), 'gpt-6.1-sol')
  for (const model of ['opus', 'fable', 'claude-fable-5-2']) assert.equal(codexPeer(model, models, 'gpt-6-luna'), 'gpt-6-astra')
  assert.equal(claudePeer('codex:gpt-6-astra'), 'opus')
  assert.equal(claudePeer('gpt-6.1-terra'), 'sonnet')
  assert.equal(claudePeer('gpt-6-luna'), 'haiku')
})

test('configured default breaks ties within the nearest tier, never across tiers', () => {
  assert.equal(codexPeer('sonnet', models, 'gpt-6.1-terra'), 'gpt-6.1-terra')
  assert.equal(codexPeer('sonnet', models, 'missing-model'), 'gpt-6.1-sol')
  assert.equal(codexPeer('haiku', catalog('gpt-7-luna', 'gpt-6-luna'), null), 'gpt-7-luna')
})

test('missing peer tiers choose the nearest available class, preferring capability on ties', () => {
  assert.equal(codexPeer('opus', catalog('gpt-6-luna', 'gpt-6.1-sol'), 'gpt-6-luna'), 'gpt-6.1-sol')
  assert.equal(codexPeer('sonnet', catalog('gpt-6-luna', 'gpt-6-astra'), 'gpt-6-luna'), 'gpt-6-astra')
  assert.equal(codexPeer('haiku', catalog('gpt-6-astra', 'gpt-6.1-sol'), 'gpt-6-astra'), 'gpt-6.1-sol')
  assert.equal(codexPeer('opus', catalog('gpt-6-luna'), null), 'gpt-6-luna')
  assert.equal(codexPeer('opus', [], 'configured-model'), 'configured-model')
  assert.equal(codexPeer('opus', [], null), undefined)
})
