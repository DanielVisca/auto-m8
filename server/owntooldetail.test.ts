// tool_calls.detail for auto-m8's own tools: the action, and look's shape. Never values or ids.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ownToolDetail } from './transcript.ts'

test('auto-m8 tools record their action only', () => {
  assert.equal(ownToolDetail('mcp__auto-m8__canvas', { action: 'create', name: 'Private board' }), 'create')
  assert.equal(ownToolDetail('mcp__perch__shepherd', { action: 'status', pr: 'https://github.com/x/y/pull/1' }), 'status')
  assert.equal(ownToolDetail('mcp__auto-m8__search_conversations', { query: 'secret' }), undefined)
  assert.equal(ownToolDetail('mcp__grafana__query_prometheus', { action: 'x' }), undefined)
})

test('look records its shape, not typed text or ids', () => {
  assert.equal(ownToolDetail('mcp__auto-m8__look', { board_id: 'b1' }), 'picture board')
  assert.equal(ownToolDetail('mcp__auto-m8__look', { text: '```tile' }), 'picture text')
  assert.equal(ownToolDetail('mcp__auto-m8__look', { action: 'open', path: '/#chat/abc-123' }), 'open chat')
  const act = ownToolDetail('mcp__auto-m8__look', { action: 'act', steps: [{ do: 'type', value: 'secret draft' }, { do: 'click', ref: 'e1' }, { do: 'type', value: 'more' }] })
  assert.equal(act, 'act type,click')
})
