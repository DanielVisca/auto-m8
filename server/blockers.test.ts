import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockerFor, blockerInText, serverLabel } from '../web/src/blockers.ts'
import { friendly } from './errors.ts'

// Real texts from chats and background jobs (Nov 2026).
test('lapsed Claude sign-ins become a claude-login blocker', () => {
  for (const t of [
    'Failed to authenticate: OAuth session expired and could not be refreshed', // 302 chat failures in 2 days, matched nothing before
    'Not logged in · Please run /login',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
    'Invalid API key · Please run /login',
  ]) assert.equal(blockerFor(t)?.kind, 'claude-login', t)
})

test('other connections get their own fix', () => {
  assert.equal(blockerFor('Codex is signed out (codex login)')?.kind, 'codex-login')
  const m = blockerFor('The Slack MCP server (plugin:slack:slack) needs authorization')
  assert.equal(m?.kind, 'mcp-auth'); assert.equal(m?.server, 'plugin:slack:slack')
  assert.equal(blockerFor('You are not logged into any GitHub hosts. To log in, run: gh auth login')?.kind, 'gh-login')
  assert.equal(blockerFor('No PostHog personal API key')?.kind, 'posthog-key')
  assert.equal(blockerFor('spawn claude ENOENT')?.kind, 'claude-missing')
})

test('network blips, caps and prose are not blockers', () => {
  for (const t of [
    "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
    'API Error: Your computer went to sleep mid-response. The response above may be incomplete.',
    "You've hit your limit · resets 5pm",
    'The analytics MCP is disconnected in this session, so I\'ll query the API through the browser instead.',
  ]) assert.equal(blockerFor(t), null, t)
  assert.equal(blockerInText('A long reply that explains how /login works. '.repeat(20)), null)
  // An agent's progress note quoting the error drew a sign-in button under it.
  assert.equal(blockerInText('Signed-out Claude prints "Not logged in · Please run /login". The app already matches that, so the text you saw comes from somewhere else.'), null)
  assert.equal(blockerInText('Not logged in · Please run /login')?.kind, 'claude-login')
})

test('background jobs read the OAuth expiry as a sign-in, not a generic failure', () => {
  const f = friendly(new Error('Failed to authenticate: OAuth session expired and could not be refreshed'), 'Organising folders')
  assert.equal(f.setup, true)
  assert.match(f.message, /isn't logged in/)
})

test('MCP servers are named by the server, not the plugin bundle', () => {
  assert.equal(serverLabel('plugin:slack:slack'), 'Slack')
  assert.equal(serverLabel('plugin:design:figma'), 'Figma')
  assert.equal(serverLabel('claude.ai Slack'), 'Slack')
})
