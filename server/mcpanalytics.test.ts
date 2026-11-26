// MCP analytics events carry structure only: tool name, timing, error flag, argument names and, for look,
// action and step kinds. Never argument values or result text.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ingestHost, lookProps, toolCallEvent } from './mcpanalytics.ts'

test('a tool call event carries no argument values or result text', () => {
  const args = { action: 'act', steps: [{ do: 'type', ref: 'e3', value: 'secret draft to Ben' }, { do: 'press', key: 'Enter' }], path: '/#chat/abc-123' }
  const result = '1. type textbox "Message" = "secret draft to Ben"\n2. FAILED press : refused: Enter in a message box sends it'
  const e = toolCallEvent('look', args, 812.4, true, result, 'phc_x')
  const json = JSON.stringify(e)
  assert.ok(!json.includes('secret draft'), 'typed text must not leave')
  assert.ok(!json.includes('abc-123'), 'ids in paths must not leave')
  assert.equal(e.event, 'mcp_tool_call')
  assert.equal(e.properties.$mcp_tool_name, 'look')
  assert.equal(e.properties.$mcp_duration_ms, 812)
  assert.equal(e.properties.$mcp_is_error, true)
  assert.deepEqual(e.properties.$mcp_parameters, { keys: ['action', 'path', 'steps'] })
  assert.deepEqual(e.properties.look_step_kinds, ['type', 'press'])
  assert.equal(e.properties.look_failed_steps, 1)
  assert.equal(e.properties.look_refused, true)
})

test('look targets are coarse', () => {
  assert.equal(lookProps({ board_id: 'b1' }, '').look_target, 'board')
  assert.equal(lookProps({ text: '```tile' }, '').look_action, 'picture')
  assert.equal(lookProps({ action: 'open', path: '/#explore' }, '').look_target, 'page:explore')
  assert.equal(lookProps({}, "Can't look: the auto-m8 desktop app isn't running").look_no_app, true)
})

test('cloud hosts send to their ingestion host', () => {
  assert.equal(ingestHost('https://us.posthog.com'), 'https://us.i.posthog.com')
  assert.equal(ingestHost('https://eu.posthog.com'), 'https://eu.i.posthog.com')
  assert.equal(ingestHost('https://ph.example.com'), 'https://ph.example.com')
})
