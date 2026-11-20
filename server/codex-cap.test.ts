// Which Codex failures count as a cap (hand the chat to Claude, rest Codex for an hour). Run with `npm test`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// Read the pattern from source: importing codex.ts would probe the host's Codex install.
const src = readFileSync(new URL('./codex.ts', import.meta.url), 'utf8')
const CODEX_CAP = eval(src.match(/const CODEX_CAP = (\/.*\/[a-z]*)/)![1]) as RegExp

test('workspace spend caps and usage limits count as Codex caps', () => {
  for (const t of [
    'You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.',
    "You've hit your usage limit. Try again in 3 hours.",
    'Rate limit reached for requests',
    'spending limit reached',
  ]) assert.ok(CODEX_CAP.test(t), t)
})

test('ordinary failures are not caps', () => {
  for (const t of ['codex exited without completing the turn (code 1)', 'turn failed', 'sandbox denied write to /etc']) assert.equal(CODEX_CAP.test(t), false, t)
})

test('a workspace spend cap keeps Codex off for hours, a usage limit for an hour', () => {
  const pattern = src.match(/codexCapMs = \(problem: string\) => (\/.+\/i)\.test/)![1]
  const long = new RegExp(pattern.slice(1, -2), 'i')
  assert.ok(long.test('You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.'))
  assert.ok(!long.test('usage limit reached, try again in 20 minutes'))
})
