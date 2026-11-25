import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signalsOf } from './wishes.ts'

const a = (blocks: any[]) => ({ kind: 'assistant' as const, blocks, ts: 1, uuid: 'u' })

test('a tool search that finds nothing is a wish; one blocked by servers still connecting is not', () => {
  const s = signalsOf('c', [a([
    { type: 'tool', id: 't1', name: 'ToolSearch', input: { query: 'select:mcp__argocd__app_get' }, result: 'No matching deferred tools found.' },
    { type: 'tool', id: 't2', name: 'ToolSearch', input: { query: 'grafana' }, result: 'No matching deferred tools found. Some MCP servers are still connecting: grafana' },
  ])])
  assert.equal(s.length, 1)
  assert.equal(s[0].signal, 'tool-miss')
  assert.match(s[0].text, /mcp__argocd__app_get/)
})

test('a tool that is not connected counts; a casing slip does not', () => {
  const s = signalsOf('c', [a([
    { type: 'tool', id: 't1', name: 'mcp__slack__draft', input: {}, isError: true, result: 'slack_send_message_draft is not available in this session' },
    { type: 'tool', id: 't2', name: 'bash', input: {}, isError: true, result: 'No such tool available: bash. Tool names are case-sensitive: call Bash instead.' },
  ])])
  assert.deepEqual(s.map(x => x.signal), ['unavailable'])
})

test('the agent saying it could not reach something is a wish, with its context', () => {
  const s = signalsOf('c', [a([{ type: 'text', text: 'Done. I can\'t reach the production PostHog MCP from this session, so I haven\'t published it.' }])])
  assert.equal(s.length, 1)
  assert.equal(s[0].signal, 'said')
  assert.match(s[0].text, /production PostHog MCP/)
})

test('user turns are never read: only what agents ran into', () => {
  assert.equal(signalsOf('c', [{ kind: 'user', text: "I can't see that flag in project 2" }]).length, 0)
})
