import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetSwr, setSwrDir, swr } from './swr.ts'

const later = <T,>(ms: number, v: T) => new Promise<T>(r => setTimeout(() => r(v), ms))

test('a slow first lookup answers pending at the deadline, then the value once it lands', async () => {
  setSwrDir(null); _resetSwr()
  let calls = 0
  const f = () => { calls++; return later(80, { n: 1 }) }
  assert.deepEqual(Object.keys(await swr('k1', 1000, f, { deadline: 10 }) as any).sort(), ['pending', 'since'])
  assert.equal((await swr('k1', 1000, f, { deadline: 10 }) as any).pending, true) // still the same run
  await later(100, null)
  assert.deepEqual(await swr('k1', 1000, f, { deadline: 10 }), { n: 1 })
  assert.equal(calls, 1)
})

test('an expired value is answered at once while one refresh runs', async () => {
  setSwrDir(null); _resetSwr()
  let n = 0
  const f = () => later(30, ++n)
  assert.equal(await swr('k2', 0, f), 1)
  const t0 = Date.now()
  assert.equal(await swr('k2', 0, f), 1) // stale, not waited for
  assert.equal(await swr('k2', 0, f), 1) // same refresh in flight, not a second one
  assert.ok(Date.now() - t0 < 20)
  await later(50, null)
  assert.equal(await swr('k2', 0, f), 2)
})

test('errors are shown but never kept over a good value, and are retried', async () => {
  setSwrDir(null); _resetSwr()
  let fail = true
  const f = async () => fail ? { error: 'argocd timed out' } : { ok: 1 }
  assert.deepEqual(await swr('k3', 60_000, f), { error: 'argocd timed out' })
  fail = false
  assert.deepEqual(await swr('k3', 60_000, f), { ok: 1 })
  fail = true
  assert.deepEqual(await swr('k3', 0, f), { ok: 1 }) // the refresh fails: the good value stays
  await later(5, null)
  assert.deepEqual(await swr('k3', 0, f), { ok: 1 })
})

test('a thrown error comes back as an error answer, not a crash', async () => {
  setSwrDir(null); _resetSwr()
  assert.deepEqual(await swr('k4', 1000, async () => { throw new Error('No such folder') }), { error: 'No such folder' })
})

test('values survive a restart through the disk copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swr-'))
  setSwrDir(dir); _resetSwr()
  assert.deepEqual(await swr('k5', 60_000, async () => [1, 2]), [1, 2])
  _resetSwr() // "restart": memory gone
  assert.deepEqual(await swr('k5', 60_000, async () => { throw new Error('should not run') }), [1, 2])
  setSwrDir(null)
})
