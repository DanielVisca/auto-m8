import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runTextJobs, type TextJob } from './job-fallback.ts'

function job() {
  let emit!: (ev: any) => void, starts = 0, stops = 0
  const run: TextJob = listener => { starts++; emit = listener; return () => { stops++ } }
  return { run, emit: (ev: any) => emit(ev), starts: () => starts, stops: () => stops }
}

test('failed local and capped cloud answers cannot corrupt the final structured response', () => {
  const local = job(), claude = job(), codex = job(), out: any[] = []
  runTextJobs([local.run, claude.run, codex.run], ev => out.push(ev))
  local.emit({ type: 'stream_event', text: 'partial local JSON' })
  local.emit({ type: 'result', is_error: true, result: '' })
  local.emit({ type: 'perch_done', code: 1 })
  claude.emit({ type: 'result', is_error: true, result: 'usage limit' })
  claude.emit({ type: 'perch_done', code: 0 })
  const answer = { type: 'result', is_error: false, result: '{"ok":true}' }
  codex.emit(answer); codex.emit({ type: 'perch_done', code: 0 })
  local.emit({ type: 'perch_done', code: 1 })
  assert.deepEqual(out, [answer, { type: 'perch_done', code: 0 }])
  assert.equal(codex.starts(), 1)
})

test('cancelling after a handoff stops the active provider and never launches the next', () => {
  const local = job(), claude = job(), codex = job(), out: any[] = []
  const cancel = runTextJobs([local.run, claude.run, codex.run], ev => out.push(ev))
  local.emit({ type: 'perch_done', code: 1 }); cancel()
  claude.emit({ type: 'perch_done', code: 130 })
  assert.equal(claude.stops(), 1)
  assert.equal(codex.starts(), 0)
  assert.deepEqual(out, [])
})

test('a successful first job does not spend another provider; total failure reports one failure', () => {
  const other = job(), events: any[] = []
  const success: TextJob = emit => { emit({ type: 'result', result: 'done' }); emit({ type: 'perch_done', code: 0 }); return () => {} }
  runTextJobs([success, other.run], ev => events.push(ev))
  assert.equal(other.starts(), 0)
  assert.equal(events.length, 2)
  const failure = job(), out: any[] = []
  runTextJobs([failure.run], ev => out.push(ev))
  failure.emit({ type: 'perch_done', code: 1, error: 'unavailable' })
  assert.equal(out.length, 1)
})
