import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localFallbackCanReturn } from './chat.ts'

const week = (pct: number) => ({ windows: [{ key: 'seven_day', label: 'week', pct, resetsAt: Date.now() + 2 * 86400_000 }], at: Date.now() })
const deps = (o: { pinned?: string; claude?: boolean; codex?: boolean }) => ({
  engineFor: () => o.pinned ?? '',
  usageNow: () => ({ claude: week(0.5), codex: { ...week(1), creditsAvailable: false } }),
  available: (t: string) => (o.claude ? t : null) as any,
  codexReadySync: () => !!o.codex,
  localUpSync: () => true,
})

test('a chat Auto moved to the local model goes back once Claude is usable', () => {
  assert.equal(localFallbackCanReturn({ id: 'x', engine: 'qwen', tier: 'opus' }, deps({ claude: true })), true)
})
test('it stays on local while every subscription is still out', () => {
  assert.equal(localFallbackCanReturn({ id: 'x', engine: 'qwen', tier: 'opus' }, deps({})), false)
})
test('a chat you pinned to the local model is never moved', () => {
  assert.equal(localFallbackCanReturn({ id: 'x', engine: 'qwen', tier: 'opus' }, deps({ pinned: 'qwen', claude: true })), false)
})
test('chats not on the local model are not touched', () => {
  assert.equal(localFallbackCanReturn({ id: 'x', engine: '', tier: 'opus' }, deps({ claude: true })), false)
})
