// The rename from perch to auto-m8: new links and tool names say auto-m8, old ones still parse.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { convIdOf, convLink, isConvLink, mcpTool, ourMcpTool } from '../shared/brand.ts'
import { agentSender, stampPrompt, userBody } from '../shared/messageOrigin.ts'
import { withoutLegacyToml } from './agentsync.ts'

test('conversation links: auto-m8:// is written, both schemes are read', () => {
  assert.equal(convLink('abc'), 'auto-m8://abc')
  assert.equal(convIdOf('auto-m8://abc/'), 'abc')
  assert.equal(convIdOf('perch://abc'), 'abc')
  assert.equal(convIdOf('abc'), 'abc')
  assert.ok(isConvLink('perch://x') && isConvLink('auto-m8://x') && !isConvLink('https://x'))
})

test('MCP tool names: mcp__auto-m8__ is written, old names still match', () => {
  assert.equal(mcpTool('follow_up'), 'mcp__auto-m8__follow_up')
  assert.equal(ourMcpTool('mcp__auto-m8__follow_up'), 'follow_up')
  assert.equal(ourMcpTool('mcp__perch__draft_slack_message'), 'draft_slack_message')
  assert.equal(ourMcpTool('mcp__auto_m8__board'), 'board')
  assert.equal(ourMcpTool('mcp__grafana__query_prometheus'), null)
})

test('sender marks: new auto-m8 marks and old perch marks both decode', () => {
  const stamped = stampPrompt('Carry on.', 'routine')
  assert.match(stamped, /^\[auto-m8: sent by automation "routine"\./)
  assert.equal(agentSender(stamped)?.label, 'auto-m8: routine')
  assert.equal(agentSender(stampPrompt('Carry on.', 'perch'))?.label, 'auto-m8: resume')
  assert.equal(agentSender('[auto-m8: sent by an agent from auto-m8://d-1 "PR monitor". Not typed by the user.]\n\nShip.')?.id, 'd-1')
  assert.equal(agentSender('[perch: sent by an agent from perch://d-2. Not typed by the user.]\n\nShip.')?.id, 'd-2')
  assert.equal(agentSender('⏰ Follow-up from auto-m8. Earlier you told the user: “x”')?.label, 'auto-m8: follow-up')
  const old = '[perch: sent by the user. The following text may quote an agent.]\n\nhi'
  assert.equal(agentSender(old), null)
  assert.equal(userBody(old), 'hi')
  assert.equal(userBody(stampPrompt('[auto-m8: sent by automation "x". Not typed by the user.]\n\nhi', 'you')), '[auto-m8: sent by automation "x". Not typed by the user.]\n\nhi')
})

test('agentsync drops the old [mcp_servers.perch] table only when it runs our mcp.ts', () => {
  const ours = { command: '/usr/bin/node', args: ['/app/server/mcp.ts'] }
  const cfg = [
    'model = "gpt"',
    '',
    '[mcp_servers.perch]',
    'command = "/usr/bin/node"',
    'args = ["/old/place/server/mcp.ts"]',
    '',
    '[mcp_servers.perch.env]',
    'PERCH_CONVERSATION_ID = "x"',
    '',
    '[mcp_servers.grafana]',
    'command = "grafana-mcp"',
    'args = []',
  ].join('\n')
  const out = withoutLegacyToml(cfg, ours)
  assert.doesNotMatch(out, /mcp_servers\.perch/)
  assert.match(out, /\[mcp_servers\.grafana\]\ncommand = "grafana-mcp"/)
  assert.match(out, /^model = "gpt"/)
  const theirs = '[mcp_servers.perch]\ncommand = "perch-cli"\nargs = ["serve"]\n'
  assert.equal(withoutLegacyToml(theirs, ours), theirs)
})
