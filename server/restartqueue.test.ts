import { test } from 'node:test'
import assert from 'node:assert/strict'
import { restartQueue } from './restartqueue.ts'

test('restarts within the window coalesce into one, keeping every reason; --now goes at once with the queue', () => {
  let up = 30_000, t = 1_000_000, fired: string[] = [], pending: (() => void) | null = null
  const q = restartQueue({ windowMs: 180_000, uptimeMs: () => up, clock: () => t, restart: r => fired.push(r), timer: (f) => { pending = f; return 1 }, cancel: () => { pending = null } })
  const a = q.request('code A'), b = q.request('code B'), c = q.request('code A')
  assert.deepEqual(a, { queued: true, at: t + 150_000, reasons: 1 })
  assert.deepEqual(b, { queued: true, at: t + 150_000, reasons: 2 })
  assert.equal(c.queued && c.reasons, 2) // the same reason twice counts once
  pending!()
  assert.deepEqual(fired, ['code A · code B'])
  assert.equal(q.pending(), null)
  up = 500_000 // long after the window, nothing queued: immediate
  assert.deepEqual(q.request('code C'), { queued: false, reason: 'code C' })
  up = 10_000; q.request('code D') // queued again
  assert.deepEqual(q.request('urgent', true), { queued: false, reason: 'code D · urgent' })
  assert.equal(pending, null, 'the queued timer is cancelled when --now takes its reasons')
})
