import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lastJson, peerRank, pretty, readLog, sizing } from './race.ts'

test('readLog: Claude stream-json gives tools, cost, tokens and the result', () => {
  const log = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test x' } }] } },
    { type: 'result', total_cost_usd: 1.5, num_turns: 4, result: 'done', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 } },
    { type: 'perch_exit', code: 0, at: 1000 },
  ].map(x => JSON.stringify(x)).join('\n')
  const r = readLog(log)
  assert.deepEqual(r.tools, { Read: 1, 'Bash:pnpm': 1 })
  assert.equal(r.usd, 1.5); assert.equal(r.tokens, 115); assert.equal(r.turns, 4); assert.equal(r.result, 'done'); assert.equal(r.exit, 0)
})

test('readLog: Codex exec --json gives tools, tokens and the agent text', () => {
  const log = [
    { type: 'item.completed', item: { type: 'command_execution', command: "/bin/zsh -lc 'rg foo'" } },
    { type: 'item.completed', item: { type: 'file_change', changes: [] } },
    { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'grafana', tool: 'query' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'summary' } },
    { type: 'turn.completed', usage: { input_tokens: 50, output_tokens: 7 } },
  ].map(x => JSON.stringify(x)).join('\n')
  const r = readLog(log)
  assert.deepEqual(r.tools, { 'Bash:rg': 1, Edit: 1, mcp__grafana__query: 1 })
  assert.equal(r.tokens, 57); assert.equal(r.result, 'summary'); assert.equal(r.usd, 0)
})

test('lastJson: takes the final JSON object out of prose', () => {
  assert.deepEqual(lastJson('I looked. {"a":1} then {"score": 80, "issues": [{"x": {"y": 2}}]}'), { score: 80, issues: [{ x: { y: 2 } }] })
  assert.equal(lastJson('no json'), null)
})

test('peerRank: a failed check sinks a solution below passing ones regardless of score', () => {
  const entries = [{ id: 'a', model: 'opus', verify: { ok: false } }, { id: 'b', model: 'fable', verify: { ok: true } }]
  const reviews = [{ target: 'a', result: { score: 95 } }, { target: 'b', result: { score: 70, sufficient: true } }]
  const r = peerRank(entries, reviews)
  assert.equal(r[0].model, 'fable'); assert.equal(r[0].sufficientVotes, 1); assert.equal(r[1].score, 95)
})

test('sizing: overkill, right and underkill for the model you would have used', () => {
  const e = (model: string, usd: number, mins: number, sufficient: boolean) => ({ model, usd, duration_ms: mins * 60_000, sufficient })
  assert.equal(sizing('claude-opus-5-5', [e('claude-opus-5-5', 5, 20, true), e('claude-sonnet-5-5', 1, 15, true)])!.kind, 'overkill')
  assert.equal(sizing('claude-opus-5-5', [e('claude-opus-5-5', 5, 20, true), e('claude-sonnet-5-5', 4, 19, true)])!.kind, 'right')
  assert.equal(sizing('claude-sonnet-5-5', [e('claude-opus-5-5', 5, 20, true), e('claude-sonnet-5-5', 1, 15, false)])!.kind, 'underkill')
  assert.equal(sizing(null, []), null)
})

test('pretty: names for Claude and Codex models', () => {
  assert.equal(pretty('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(pretty('codex:gpt-6-astra'), 'GPT 6 Astra')
})
