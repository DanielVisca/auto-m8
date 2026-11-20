import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isLoopback, setRemoteOnlyPort } from './remote.ts'
import { run } from './db.ts'
import { beat, getDraft, handoff, putDraft, pushKey } from './mobile.ts'

const req = (localPort: number, localAddress = '127.0.0.1') => ({ socket: { localPort, localAddress, remoteAddress: localAddress }, headers: {} }) as any

test('the tailnet listener is never treated as the Mac, even though it is on 127.0.0.1', () => {
  setRemoteOnlyPort(4877)
  assert.equal(isLoopback(req(4777)), true)
  assert.equal(isLoopback(req(4877)), false)
})

const tick = () => { const t = Date.now(); while (Date.now() <= t + 1) {} }
test('handoff offers what another device looked at more recently', () => {
  setRemoteOnlyPort(4877)
  const mac = req(4777)
  beat(mac, '#home', '')
  assert.equal(handoff(mac), null)
  tick()
  // A remote request without a cookie is device "unknown"; pretend it is paired.
  run(`insert or ignore into devices (id, name, token_hash) values ('unknown', 'iPhone', 'x')`)
  beat(req(4877), '#chat/abc', 'Fix the widget')
  const h = handoff(mac)
  assert.equal(h?.view, '#chat/abc')
  assert.equal(h?.title, 'Fix the widget')
  tick()
  beat(mac, '#chat/abc', '')
  assert.equal(handoff(mac), null)
})

test('drafts are shared and cleared when emptied', () => {
  putDraft(req(4777), 'c1', 'half a thought')
  assert.equal(getDraft('c1')?.text, 'half a thought')
  putDraft(req(4777), 'c1', '')
  assert.equal(getDraft('c1'), null)
})

test('push keys are made once and kept', () => {
  const k = pushKey()
  assert.ok(k.length > 40)
  assert.equal(pushKey(), k)
})

test('a revoked device is not offered for handoff', () => {
  const mac = req(4777)
  run(`delete from devices where id = 'unknown'`)
  tick()
  beat(req(4877), '#chat/zzz', 'Gone phone')
  assert.equal(handoff(mac), null)
})
