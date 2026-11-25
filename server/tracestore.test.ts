import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { db } from './db.ts'
import { condense, flatConfig, flush, query, RAW_HOURS, recordBuild, recordClient, recordRequest, SUMMARY_DAYS } from './tracestore.ts'

const HOUR = 3600_000
const NOW = Date.UTC(2026, 10, 25, 12)

beforeEach(() => { db.exec('delete from trace_events; delete from trace_rollups; delete from trace_builds') })

const req = (at: number, name: string, ms: number, spans: { name: string; ms: number }[] = [], status = 200) =>
  recordRequest({ id: 1, at, name, ms, status, spans: spans.map(s => ({ ...s, start: 0 })), dbMs: 0, dbCalls: 0, done: true, path: name.split(' ')[1] })

test('feature toggles are kept, personal and layout data are not', () => {
  const c = flatConfig({ autonomy: { enabled: true, reason: 'x' }, window: { bounds: { x: 1 }, autoMini: false }, owner: { name: 'Ana' }, chat: { cwd: '/Users/a', model: 'opus' }, browser: { sites: { 'a.com': 'trusted' } } })
  assert.deepEqual(c, { 'autonomy.enabled': true, 'window.autoMini': false, 'chat.model': 'opus' })
})

test('raw events land with their build and are queryable', () => {
  const b = recordBuild(NOW - 2 * HOUR)
  req(NOW - HOUR, 'GET /api/railyard', 20_000, [{ name: 'gh api graphql', ms: 14_000 }])
  req(NOW - HOUR, 'GET /api/conversations/:id/messages', 5)
  recordClient([{ at: NOW - HOUR, name: 'chat.open', ms: 150_000, meta: { via: 'full' } }, { at: NOW - HOUR, name: 'api /api/conversations/:id/messages', ms: 150_000, meta: { queuedMs: 149_000, neverSent: true } }], NOW)
  flush(NOW)
  const s: any = query({ now: NOW, hours: 24 })
  assert.equal((db.prepare(`select count(*) n from trace_events where kind in ('request', 'client')`).get() as any).n, 4)
  assert.ok(s.diagnosis.some((d: string) => d.startsWith('Opening a chat')))
  assert.ok(s.diagnosis.some((d: string) => /waited for a free connection/.test(d)))
  assert.ok(s.diagnosis.some((d: string) => /railyard.*gh api graphql/.test(d)))
  const slow: any = query({ now: NOW, hours: 24, action: 'slowest', kind: 'request' })
  assert.equal(slow.slowest[0].name, 'GET /api/railyard')
  assert.equal(slow.slowest[0].build, b)
  const one: any = query({ action: 'get', id: slow.slowest[0].id })
  assert.equal(one.where[0].name, 'gh api graphql')
  assert.equal(one.build.id, b)
})

test('expired raw events condense into hourly summaries, which expire in turn', () => {
  recordBuild(NOW - 100 * HOUR)
  const old = NOW - (RAW_HOURS + 5) * HOUR
  for (let i = 1; i <= 100; i++) req(old + i * 1000, 'GET /api/home', i, i === 100 ? [{ name: 'db.all select', ms: 80 }] : [])
  req(NOW - HOUR, 'GET /api/home', 7)
  flush(NOW)
  assert.equal(condense(NOW), 1)
  const raw = db.prepare(`select count(*) n from trace_events where kind = 'request'`).get() as any
  assert.equal(raw.n, 1, 'only the recent event stays raw')
  const r = db.prepare(`select * from trace_rollups where kind = 'request'`).get() as any
  assert.equal(r.n, 100); assert.equal(r.max, 100); assert.equal(r.p50, 51)
  assert.equal(JSON.parse(r.top_spans)[0].name, 'db.all select')
  assert.equal(JSON.parse(r.slowest)[0].ms, 100)

  // The summary still answers questions about that hour, merged with raw where both exist.
  const s: any = query({ now: NOW, hours: RAW_HOURS + 10, kind: 'request' })
  const home = s.requests.find((g: any) => g.name === 'GET /api/home')
  assert.equal(home.n, 101); assert.equal(home.source, 'raw+summary'); assert.equal(home.max, 100)
  const tl: any = query({ now: NOW, hours: RAW_HOURS + 10, action: 'timeline', name: '/api/home' })
  assert.equal(tl.series.length, 2)

  // Past the summary TTL it's gone.
  condense(NOW + SUMMARY_DAYS * 24 * HOUR + HOUR)
  assert.equal((db.prepare('select count(*) n from trace_rollups').get() as any).n, 0)
})

test('compare lines the same operation up per build', () => {
  recordBuild(NOW - 3 * HOUR)
  req(NOW - 2.5 * HOUR, 'GET /api/home', 100)
  flush(NOW - 2.5 * HOUR)
  recordBuild(NOW - 2 * HOUR)
  req(NOW - HOUR, 'GET /api/home', 300)
  flush(NOW)
  const c: any = query({ now: NOW, hours: 24, action: 'compare', name: '/api/home' })
  assert.equal(c.operations[0].byBuild.length, 2)
  assert.equal(c.operations[0].p95Change, '200%')
})

test('client events are bounded and validated', () => {
  assert.equal(recordClient([{ name: 'x', ms: NaN } as any, null as any, { name: 'ok', ms: 1, meta: { big: 'y'.repeat(5000) } }], NOW), 1)
  flush(NOW)
  const m = JSON.parse((db.prepare(`select meta from trace_events where name = 'ok'`).get() as any).meta)
  assert.equal(m.truncated, true)
})
