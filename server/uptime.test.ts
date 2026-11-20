import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run } from './db.ts'
import { availability, noteBoot, noteOutage, noteStop, recordAvailability, writeReason } from './uptime.ts'

test('a stop with a reason, then a boot, then the page reporting the gap, reads as one explained restart', () => {
  run('delete from availability')
  noteBoot(900) // first start
  writeReason('new chat routes')
  noteStop('SIGTERM')
  noteBoot(1200)
  noteOutage({ ms: 4000, fromPid: 1, toPid: process.pid })
  const a = availability()
  assert.equal(a.restarts, 2)
  assert.equal(a.outages, 1)
  assert.equal(a.downMs, 4000)
  assert.match(a.recent[0].detail, /SIGTERM: new chat routes/)
})

test('a boot with no stop before it is a crash; same pid is a freeze or a drop; sleep is not counted', () => {
  run('delete from availability')
  noteBoot(900)
  noteBoot(900)
  assert.match(availability().recent[0].cause, /died without stopping/)
  recordAvailability('stall', 5000, 'GET /api/x')
  noteOutage({ ms: 6000, fromPid: 7, toPid: 7 })
  noteOutage({ ms: 9000, fromPid: 7, toPid: 7, slept: true })
  noteOutage({ ms: 100, fromPid: 7, toPid: 8 }) // too short to notice
  const a = availability()
  assert.equal(a.outages, 1)
  assert.equal(a.recent.find(r => r.kind === 'outage' && r.cause !== 'mac-asleep').cause, 'frozen')
  assert.equal(a.stalls, 1)
})
