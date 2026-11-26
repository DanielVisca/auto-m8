// auto-m8's MCP usage is recorded locally (mcp_events): tool, action, timing, outcome, and for look the
// structure of what it did. Never typed text or ids, even locally.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { all } from './db.ts'
import { lookProps, recordToolCall, toolCallRow } from './mcpanalytics.ts'

test('a look call row keeps structure, not typed text or ids', () => {
  const args = { action: 'act', steps: [{ do: 'type', ref: 'e3', value: 'secret draft to Ben' }, { do: 'press', key: 'Enter' }], path: '/#chat/abc-123' }
  const result = '1. type textbox "Message" = "secret draft to Ben"\n2. FAILED press : refused: Enter in a message box sends it'
  const r = toolCallRow('look', args, 812.4, true, result)
  const json = JSON.stringify(r)
  assert.ok(!json.includes('secret draft'))
  assert.ok(!json.includes('abc-123'))
  assert.equal(r.action, 'act')
  assert.equal(r.duration_ms, 812)
  assert.equal(r.is_error, 1)
  assert.deepEqual(JSON.parse(r.props!), { action: 'act', target: 'page:chat', steps: 2, step_kinds: ['type', 'press'], failed_steps: 1, refused: true })
})

test('other tools keep their action argument only', () => {
  const r = toolCallRow('canvas', { action: 'create', name: 'Private board name' }, 40, false, 'Made board')
  assert.equal(r.action, 'create')
  assert.equal(r.props, null)
  assert.ok(!JSON.stringify(r).includes('Private board'))
})

test('look targets are coarse', () => {
  assert.equal(lookProps({ board_id: 'b1' }, '').target, 'board')
  assert.equal(lookProps({ text: '```tile' }, '').action, 'picture')
  assert.equal(lookProps({ action: 'open', path: '/#explore' }, '').target, 'page:explore')
  assert.equal(lookProps({}, "Can't look: the auto-m8 desktop app isn't running").no_app, true)
})

test('recording writes a row to mcp_events', () => {
  recordToolCall('look', { board_id: 'b1' }, 1500, false, 'Rendered')
  const rows = all<any>('select tool, action, duration_ms, is_error from mcp_events where tool = ?', 'look')
  assert.deepEqual({ ...rows.at(-1) }, { tool: 'look', action: 'picture', duration_ms: 1500, is_error: 0 })
})
