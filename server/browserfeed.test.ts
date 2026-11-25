import { test } from 'node:test'
import assert from 'node:assert/strict'
import { concernFor, feed, feedFor, clearFeed, type FeedItem } from './browserfeed.ts'

const fetchSpan = (id: string, ms: number, extra: Partial<FeedItem> = {}): FeedItem =>
  ({ id, at: 0, kind: 'tool', text: 'fetch us.posthog.com/api', ms, detail: { action: 'fetch', host: 'us.posthog.com' }, ...extra })

test('a call slower than its usual ceiling is flagged in plain words', () => {
  assert.equal(concernFor('o', fetchSpan('a', 2000), []), undefined)
  assert.match(concernFor('o', fetchSpan('a', 25_700), [])!, /^26s: longer than expected \(usually under 8\.0s\)$/)
})

test('a call far slower than the same call earlier is flagged against that history', () => {
  const hist = [fetchSpan('1', 900), fetchSpan('2', 1100), fetchSpan('3', 1000)]
  assert.match(concernFor('o', fetchSpan('x', 4500), hist)!, /5× slower than usual here \(usually 1\.0s\)/)
  // the same call on another host has no history to compare against
  assert.equal(concernFor('o', fetchSpan('x', 4500, { detail: { action: 'fetch', host: 'example.com' } }), hist), undefined)
})

test('repeated failures of the same thing are flagged even when quick', () => {
  const bad = (id: string) => fetchSpan(id, 100, { level: 'bad' })
  assert.equal(concernFor('o', bad('3'), [bad('1')]), undefined)
  assert.equal(concernFor('o', bad('3'), [bad('1'), bad('2')]), 'Failed 3 times in a row')
  // a success in between resets the count
  assert.equal(concernFor('o', bad('4'), [bad('1'), bad('2'), fetchSpan('ok', 100)]), undefined)
})

test('a running span is updated in place and gets its concern when it finishes', () => {
  clearFeed('w')
  const s = feed('w', { kind: 'tool', text: 'fetch', running: true, detail: { action: 'fetch', host: 'h' } })
  assert.equal(feedFor('w').length, 1)
  feed('w', { ...s, running: false, ms: 32_000, level: 'bad' })
  const list = feedFor('w')
  assert.equal(list.length, 1)
  assert.equal(list[0].running, false)
  assert.match(list[0].concern!, /longer than expected/)
})

test('waiting steps are never called slow', () => {
  const wait: FeedItem = { id: 'w', at: 0, kind: 'step', text: 'waited', ms: 60_000, detail: { action: 'wait' } }
  assert.equal(concernFor('o', wait, []), undefined)
})

test('a huge ratio over a tiny usual time reads as "much slower", not a silly multiple', () => {
  const hist = [fetchSpan('1', 4), fetchSpan('2', 5), fetchSpan('3', 4)]
  assert.match(concernFor('o', fetchSpan('x', 9000), hist)!, /^9\.0s: much slower than usual here \(usually 4ms\)$/)
})

test('an idle window is freezable only when nothing needs it', async () => {
  const B = await import('./browser.ts')
  const now = Date.now()
  const s: any = { owner: 'idle-test', frozen: false, crashed: false, paused: false, shown: false, frames: new Set(), lastUsed: now - B.FREEZE_MS - 1000 }
  assert.equal(B.freezable(s, now), true)
  assert.equal(B.freezable({ ...s, lastUsed: now - 1000 }, now), false, 'used recently')
  assert.equal(B.freezable({ ...s, frames: new Set([() => {}]) }, now), false, 'someone is watching')
  assert.equal(B.freezable({ ...s, paused: true }, now), false, 'taken over')
  assert.equal(B.freezable({ ...s, shown: true }, now), false, 'open in Chrome')
  B.callStarted('idle-test')
  assert.equal(B.freezable(s, now), false, 'a call is running')
  B.callEnded('idle-test')
  assert.equal(B.freezable(s, now), true)
  B.keepAwakeChecks.add(o => o === 'idle-test')
  assert.equal(B.freezable(s, now), false, 'overlay keeps it awake')
})
