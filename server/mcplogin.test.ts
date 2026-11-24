import { test } from 'node:test'
import assert from 'node:assert/strict'
import { friendly, serverLabel, serverNeedingAuth } from './errors.ts'
import { McpAuthError, needsAuthIn } from './mcplogin.ts'

test('an MCP server needing OAuth becomes an authorize prompt, not "That failed"', () => {
  const raw = 'slack_send_message_draft is not available in this session. The Slack MCP server (plugin:slack:slack) needs authorization, and this session is non-interactive'
  assert.equal(serverNeedingAuth(raw), 'plugin:slack:slack')
  const f = friendly(new Error(raw))
  assert.equal(f.authorize, 'plugin:slack:slack')
  assert.equal(f.message, 'Slack needs you to authorize it.')
  assert.equal(friendly(new McpAuthError('plugin:slack:slack', 'Slack')).authorize, 'plugin:slack:slack')
  assert.equal(serverNeedingAuth('claude.ai Gmail connector needs authentication'), 'claude.ai Gmail')
  assert.equal(serverLabel('claude.ai Gmail'), 'Gmail')
  assert.equal(serverNeedingAuth('PostHog 401 authentication_failed'), null)
})

test('init event: picks out the servers that need auth', () => {
  const ev = { type: 'system', subtype: 'init', mcp_servers: [{ name: 'plugin:slack:slack', status: 'needs-auth' }, { name: 'grafana', status: 'connected' }] }
  assert.deepEqual(needsAuthIn(ev, /slack/i), ['plugin:slack:slack'])
  assert.deepEqual(needsAuthIn(ev, /grafana/i), [])
  assert.deepEqual(needsAuthIn({ type: 'assistant' }, /slack/i), [])
})
