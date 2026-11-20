import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { explainStall, startStallProfiler, summarize, type Profile } from './stallprof.ts'

test('summarize counts self time only inside the stall window, biggest first', () => {
  const f = (id: number, functionName: string, url = '', lineNumber = 0) => ({ id, callFrame: { functionName, url, lineNumber } })
  const p: Profile = { nodes: [f(1, '(root)'), f(2, 'listLabels', `file://${join(import.meta.dirname, 'main.ts')}`, 99), f(3, '(garbage collector)'), f(4, 'early')],
    startTime: 0, endTime: 10_000_000, samples: [4, 4, 2, 2, 2, 3], timeDeltas: [1_000_000, 1_000_000, 5_000_000, 1_000_000, 1_000_000, 1_000_000] }
  // the last 5s hold samples 2,2,2,3 (t = 7s..10s); 'early' (t = 1s, 2s) is outside
  assert.equal(summarize(p, 5000), '75% listLabels server/main.ts:100 · 25% (garbage collector)')
  assert.equal(summarize({ ...p, samples: [1], timeDeltas: [9_999_999] }, 5000), 'no samples (blocked outside JavaScript)')
})

test('a real blocking loop is named by the running profiler', async () => {
  await startStallProfiler(1000)
  function blockTheLoopOnPurpose() { const end = Date.now() + 3300; let x = 0; while (Date.now() < end) x++; return x }
  const t0 = performance.now(); blockTheLoopOnPurpose(); const ms = performance.now() - t0
  const why = await explainStall(ms)
  assert.match(why ?? '', /^\d+% blockTheLoopOnPurpose server\/stallprof\.test\.ts:\d+/, String(why))
})
