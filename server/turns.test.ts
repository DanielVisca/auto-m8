// Turn bookkeeping: why each turn ended, and messages Claude Code answered inside another turn.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.PERCH_DATA = mkdtempSync(join(tmpdir(), 'perch-turns-'))
const { get, run } = await import('./db.ts')
const t = await import('./turns.ts')
const turn = (conv: string, prompt: string) => get<any>('select id, ok, end_reason, finished_at from turns where conversation_id = ? and prompt_chars = ?', conv, prompt.length)

test('a message sent mid-turn and answered in that turn is settled, not abandoned', () => {
  t.startTurn('m1', 'first message', { turbo: false })
  t.startTurn('m1', 'second, sent mid-turn!', { turbo: false })
  t.turnEvent('m1', { type: 'result', is_error: false, total_cost_usd: 0.01 })
  assert.equal(turn('m1', 'first message').end_reason, 'result')
  assert.equal(turn('m1', 'second, sent mid-turn!').finished_at, null)
  assert.equal(t.settleTurns('m1'), 1)
  const s = turn('m1', 'second, sent mid-turn!')
  assert.equal(s.ok, 1); assert.equal(s.end_reason, 'merged')
  t.abandonTurns('m1', 'exited') // nothing open any more: nothing to abandon
  assert.equal(turn('m1', 'second, sent mid-turn!').end_reason, 'merged')
})

test('an abandoned turn says why', () => {
  t.startTurn('m2', 'will hang', { turbo: false })
  t.abandonTurns('m2', 'request hung')
  const a = turn('m2', 'will hang')
  assert.equal(a.ok, 0); assert.equal(a.end_reason, 'request hung')
})

test('Codex assistant text records a reply without streamed deltas, but API errors do not', () => {
  const id = t.startTurn('codex-text', 'hello', { turbo: false, model: 'codex' })
  const first = () => get<any>('select first_token_at from turns where id = ?', id).first_token_at
  t.turnEvent('codex-text', { type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'Usage limit' }] } }, id)
  assert.equal(first(), null)
  t.turnEvent('codex-text', { type: 'assistant', parent_tool_use_id: 'child', message: { content: [{ type: 'text', text: 'child reply' }] } }, id)
  assert.equal(first(), null)
  t.turnEvent('codex-text', { type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it' }] } }, id)
  assert.ok(first() > 0)
})

test('a recovered Codex result finishes its own turn without claiming an older orphan', () => {
  t.startTurn('codex-recover', 'old orphan', { turbo: false })
  const id = t.startTurn('codex-recover', 'new active turn', { turbo: false })
  const result = { type: 'result', is_error: false }
  t.turnEvent('codex-recover', result, id)
  assert.equal(turn('codex-recover', 'old orphan').finished_at, null)
  assert.equal(turn('codex-recover', 'new active turn').ok, 1)
  t.turnEvent('codex-recover', result, id)
  assert.equal(turn('codex-recover', 'old orphan').finished_at, null)
})

test('a process lost while Perch was down closes persisted turns without an in-memory queue', () => {
  run("insert into turns (id, conversation_id, sent_at, source) values ('restart-orphan', 'restart', ?, 'perch')", Date.now())
  t.abandonTurns('restart', 'died while perch was down')
  const row = get<any>("select * from turns where id = 'restart-orphan'")
  assert.equal(row.ok, 0)
  assert.equal(row.end_reason, 'died while perch was down')
})

test('a resumed process does not book the session history as one turn', () => {
  const usage = { input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 100_000 }
  // The chat already has history (turns imported from its transcript, no running totals), so
  // the process perch starts resumes it and its first total_cost_usd includes all of that history.
  run(`insert into turns (id, conversation_id, sent_at, finished_at, source) values ('old', 'resume', 1, 2, 'transcript')`)
  const b = t.startTurn('resume', 'second', { turbo: false })
  t.turnEvent('resume', { type: 'result', total_cost_usd: 250, usage, modelUsage: { 'claude-opus-5-5': { costUSD: 250 } } }, b)
  const cost = get<any>('select cost from turns where id = ?', b).cost
  assert.ok(cost > 0 && cost < 5, `resumed turn cost ${cost}`)
  // A brand-new chat's first result is all its own.
  const c = t.startTurn('fresh-chat', 'hi', { turbo: false })
  t.turnEvent('fresh-chat', { type: 'result', total_cost_usd: 40, usage, modelUsage: { 'claude-opus-5-5': { costUSD: 40 } } }, c)
  assert.equal(get<any>('select cost from turns where id = ?', c).cost, 40)
})
