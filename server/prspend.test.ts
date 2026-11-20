import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attribute, spendTimeline, type Graph } from './prspend.ts'

const A = 'https://github.com/posthog/posthog/pull/1', B = 'https://github.com/posthog/posthog/pull/2'
const g = (over: Partial<Graph> = {}): Graph => ({ by: new Map(), created: new Map(), mentioned: new Map(), shepherdOf: new Map(), parent: new Map(), linked: new Map(), ...over })

test('the chat that opened a PR is writing; several PRs share it', () => {
  assert.deepEqual(attribute('s', g({ created: new Map([['s', [A, B]]]) })), { role: 'write', prs: [A, B] })
})

test('shepherd sessions go to the PR they watch, even when they mention others', () => {
  const gr = g({ by: new Map([['s', 'shepherd']]), shepherdOf: new Map([['s', [A]]]), mentioned: new Map([['s', [A, B]]]) })
  assert.deepEqual(attribute('s', gr), { role: 'shepherd', prs: [A] })
})

test('helpers inherit the PRs of the chat that delegated them', () => {
  assert.deepEqual(attribute('h', g({ parent: new Map([['h', 'p']]), created: new Map([['p', [A]]]) })), { role: 'write', prs: [A] })
})

test('mentions count as investigation; links to the writer alone do not; nothing else is attributed', () => {
  assert.deepEqual(attribute('s', g({ mentioned: new Map([['s', [B]]]) })), { role: 'investigate', prs: [B] })
  assert.equal(attribute('s', g({ linked: new Map([['s', ['w']]]), created: new Map([['w', [A]]]) })), null)
  assert.equal(attribute('s', g()), null)
  const many = ['1', '2', '3', '4'].map(n => `https://github.com/posthog/posthog/pull/${n}`)
  assert.equal(attribute('s', g({ mentioned: new Map([['s', many]]) })), null) // an overview, not an investigation
})

test('every local dollar lands once: split sessions sum back to their cost, unlinked ones are reported apart', async () => {
  const { db } = await import('./db.ts')
  await import('./spend.ts')
  for (const sql of [
    'create table if not exists perch_started (id text primary key, at integer, by text)',
    'create table if not exists shepherd_watch (url text primary key, conversation_id text)',
    'create table if not exists delegations (id text primary key, parent text, child text)',
  ]) db.exec(sql)
  const now = Date.now()
  const msg = db.prepare('insert into usage_msgs (id, ts, account, source, session, model, in_tok, out_tok, cache_read, cache_write, cost) values (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?)')
  msg.run('m1', now - 6 * 3600_000, 'work', 'perch', 'writer', 'claude-opus-5-5', 6)
  msg.run('m5', now - 3600_000, 'work', 'perch', 'writer', 'claude-opus-5-5', 3) // opened A and B: 4.5 each
  msg.run('old', now - 45 * 86400_000, 'work', 'perch', 'writer', 'claude-opus-5-5', 20)
  msg.run('m2', now, 'work', 'perch', 'shep', 'claude-opus-5-5', 2)        // shepherd of A
  msg.run('m3', now, 'work', 'perch', 'looker', 'claude-opus-5-5', 1)      // mentions B
  msg.run('m4', now, 'work', 'perch', 'idle', 'claude-opus-5-5', 5)        // no PR
  const cp = db.prepare('insert into conversation_prs (conversation_id, url, created) values (?, ?, ?)')
  cp.run('writer', A, 1); cp.run('writer', B, 1); cp.run('shep', A, 0); cp.run('shep', B, 0); cp.run('looker', B, 0)
  db.prepare("insert into perch_started (id, at, by) values ('shep', 0, 'shepherd')").run()
  db.prepare("insert into shepherd_watch (url, conversation_id) values (?, 'shep')").run(A)
  const { prSpend, prSpendDetail } = await import('./prspend.ts')
  const r = await prSpend(30)
  close(r.total, 9 + 2 + 1)
  close(r.local.unattributed, 5)
  close(r.local.total, 17)
  const a = await prSpendDetail(A), b = await prSpendDetail(B)
  close((a as any).total, 4.5 + 2); close((b as any).total, 4.5 + 1)
  close(a.items.reduce((s: number, i: any) => s + i.usd, 0), (a as any).total)
  const detail = await prSpendDetail(A, 30, true)
  assert.ok('timeline' in detail)
  close(detail.timeline.total, detail.total)
  assert.deepEqual(detail.timeline.points.map(p => [p.at, p.usd, p.total]), [
    [now - 6 * 3600_000, 3, 3], [now - 3600_000, 1.5, 4.5], [now, 2, 6.5],
  ])
  // A rescan backfills a call after the model was cached: don't add it to the chart until the
  // summary refreshes too, even though its timestamp is inside the existing window.
  msg.run('backfill', now - 2 * 3600_000, 'work', 'perch', 'writer', 'claude-opus-5-5', 4)
  const cached = await prSpendDetail(A, 30, true)
  assert.ok('timeline' in cached)
  close(cached.timeline.total, cached.total)
  const lifetime = await prSpendDetail(A, null, true)
  assert.ok('timeline' in lifetime)
  close(lifetime.total, 18.5) // 10 old + 6.5 in-window + 2 backfilled
  close(lifetime.timeline.total, lifetime.total)
  assert.equal(lifetime.timeline.points[0].at, now - 45 * 86400_000)
  const empty = await prSpendDetail('https://github.com/posthog/posthog/pull/999999', 30, true)
  assert.ok('timeline' in empty)
  assert.deepEqual(empty.timeline.points, [])
})

test('timeline sorts increases, combines simultaneous stages, and keeps cloud run costs once', () => {
  const history = spendTimeline([
    { at: 3000, usd: 2, bucket: 'review' }, { at: 1000, usd: 1, bucket: 'write' },
    { at: 3000, usd: 0.5, bucket: 'validate' }, { at: 0, usd: 7, bucket: 'monitor' },
    { at: 6000, usd: 9, bucket: 'write' }, { at: 2000, usd: 0, bucket: 'write' },
  ], 5000)
  assert.deepEqual(history, { until: 5000, total: 3.5, points: [
    { at: 1000, usd: 1, total: 1, buckets: { write: 1 } },
    { at: 3000, usd: 2.5, total: 3.5, buckets: { review: 2, validate: 0.5 } },
  ] })
  assert.deepEqual(spendTimeline([], 5000), { until: 5000, total: 0, points: [] })
})
const close = (x: number, y: number) => assert.ok(Math.abs(x - y) < 1e-9, `${x} != ${y}`)
