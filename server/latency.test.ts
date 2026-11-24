import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { _reset, diagnose, endTrace, recordDb, report, routeOf, runInTrace, span, startTrace } from './latency.ts'

beforeEach(() => _reset())

test('routes fold ids so they aggregate', () => {
  assert.equal(routeOf('GET', '/api/conversations/86a55864-b767-422e-9305-7adeaa38e3a5/turns'), 'GET /api/conversations/:id/turns')
  assert.equal(routeOf('POST', '/api/chat/123/rate'), 'POST /api/chat/:id/rate')
  assert.equal(routeOf('GET', '/api/home'), 'GET /api/home')
})

test('SQLite calls inside a request become spans of its trace, across awaits', async () => {
  const t = startTrace('GET /api/home')
  await runInTrace(t, async () => {
    recordDb('all', 'select * from conversations', 120)
    await new Promise(r => setTimeout(r, 5))
    recordDb('get', 'select 1', 3)
    await span('gh pr list', async () => { await new Promise(r => setTimeout(r, 5)) })
  })
  endTrace(t, 200)
  assert.equal(t.dbCalls, 2)
  assert.equal(Math.round(t.dbMs), 123)
  assert.deepEqual(t.spans.map(s => s.name.split(' ')[0]), ['db.all', 'db.get', 'gh'])
  const r = report({ seconds: 60 })
  assert.equal(r.requests, 1)
  assert.equal(r.routes[0].route, 'GET /api/home')
  assert.equal(r.slowest[0].where[0].name, 'db.all select * from conversations')
})

test('SQLite calls outside requests are background totals', () => {
  recordDb('all', 'select * from usage_msgs', 900)
  recordDb('all', 'select * from usage_msgs', 1600)
  const r = report({ seconds: 60 })
  assert.deepEqual(r.background[0], { name: 'db.all select * from usage_msgs', calls: 2, ms: 2500, maxMs: 1600 })
  assert.match(r.diagnosis.join(' '), /Background work outside requests: db.all select \* from usage_msgs took 2.5s/)
})

test('requests still running show up live and in the diagnosis', () => {
  const t = startTrace('GET /api/conversations/:id', Date.now() - 12_000)
  const r = report({ seconds: 60 })
  assert.equal(r.inFlight[0].route, 'GET /api/conversations/:id')
  assert.ok(r.inFlight[0].runningMs >= 12_000)
  assert.match(r.diagnosis.join(' '), /running over 5s now: GET \/api\/conversations\/:id 12s/)
  endTrace(t)
  assert.equal(report({ seconds: 60 }).inFlight.length, 0)
})

test('diagnosis leads with machine pressure, then freezes with their profile', () => {
  const d = diagnose({ requests: 10, eventLoop: { p50: 2, p99: 900, max: 5000 }, inFlight: [], routes: [], slowest: [], background: [],
    stalls: [{ at: Date.now(), ms: 5357, cause: 'GET /api/folders', detail: '37% all · 26% hydrate server/conversations.ts:151' }],
    machine: { severity: 'critical', reasons: [{ label: 'Swap', detail: '23.7 GB used' }] } })
  assert.match(d[0], /Mac under pressure \(critical\): Swap: 23.7 GB used/)
  assert.match(d[1], /froze 1× for 5.4s.*hydrate server\/conversations.ts:151/)
})

test('a slow route that is not SQLite or a blocked loop is called out as waiting on I/O', () => {
  const d = diagnose({ requests: 5, eventLoop: { p50: 1, p99: 20, max: 40 }, inFlight: [], background: [], stalls: [], machine: null,
    routes: [{ route: 'GET /api/pr/brief', n: 5, p95: 8200, dbShare: 3 }],
    slowest: [{ route: 'GET /api/pr/brief', ms: 8456, where: [{ name: 'gh pr list', ms: 8000 }] }] })
  assert.match(d[0], /GET \/api\/pr\/brief is slow: p95 8200ms.*gh pr list 8000ms.*waiting on I\/O/)
})

test('healthy window says so', () => {
  const t = startTrace('GET /api/health'); endTrace(t, 200)
  assert.deepEqual(report({ seconds: 60 }).diagnosis, ['No slowness: requests, event loop and machine look healthy in this window.'])
})

test('a normal machine is not reported as under pressure', () => {
  const d = diagnose({ requests: 3, eventLoop: null, inFlight: [], routes: [], slowest: [], background: [], stalls: [], machine: { severity: 'normal', reasons: [] } })
  assert.deepEqual(d, ['No slowness: requests, event loop and machine look healthy in this window.'])
})
