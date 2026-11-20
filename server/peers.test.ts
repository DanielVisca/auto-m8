import assert from 'node:assert/strict'
import { test } from 'node:test'
import { helperEngine } from './delegate.ts'
import { markCapped, wantsCodex } from './router.ts'

// Own file: the router keeps its usage caps in module state, so this needs a fresh process.
test('Claude and Codex cover for each other in auto', () => {
  assert.equal(wantsCodex('opus', true).codex, false, 'nothing capped: Claude keeps it')
  assert.equal(wantsCodex('sonnet', false).codex, false)
  markCapped('opus', Date.now() + 60_000)
  assert.equal(wantsCodex('opus', true).codex, true, 'heavy work with Opus capped: Codex beats stepping down to Sonnet')
  assert.equal(wantsCodex('opus', false).codex, false, 'Codex out: Claude steps down instead')
  assert.equal(wantsCodex('sonnet', true).codex, false)
  markCapped('all', Date.now() + 60_000)
  assert.equal(wantsCodex('haiku', true).codex, true, 'every Claude model capped: Codex')
  assert.equal(wantsCodex('haiku', false).codex, false)
})

test('a helper can run on either engine', () => {
  assert.equal(helperEngine(undefined), 'auto')
  assert.equal(helperEngine('claude'), 'claude:sonnet')
  assert.equal(helperEngine('Codex'), 'codex')
  assert.equal(helperEngine('codex:gpt-6.1-sol'), 'codex:gpt-6.1-sol')
  assert.equal(helperEngine('claude:opus'), 'claude:opus')
  assert.throws(() => helperEngine('gemini'))
})
