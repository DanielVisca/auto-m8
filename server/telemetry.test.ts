// Usage stats only ever carry allowlisted properties: numbers, booleans and short slugs. No text,
// prompts, repo names or paths. Also: the setup scan helpers and the unblocker cards.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { EVENTS, recent, sanitize, track } from './telemetry.ts'
import { mcpNames, scanRepos, suggestCwd } from './onboarding.ts'
import * as suggestions from './suggestions.ts'
import { updateSettings } from './settings.ts'

const BASE = new Set(['distinct_id', '$app_version', '$os', '$os_version', 'arch', '$lib', '$process_person_profile'])

test('every event carries only its allowlisted properties', () => {
  const hostile = { step: 'claude', engine: 'claude', feature: 'search', kind: 'mcp', reason_code: 'login_error', seconds: 12.4, seconds_since_first_open: 3,
    prompt: 'fix the bug in /Users/ana/secret-repo', repo: 'acme/secret', path: '/Users/ana/code', email: 'ana@example.com', text: 'hello' }
  for (const event of Object.keys(EVENTS)) {
    const e = sanitize(event, hostile)
    assert.ok(e, event)
    for (const k of Object.keys(e.properties)) assert.ok(BASE.has(k) || k in EVENTS[event], `${event} sent ${k}`)
    for (const v of Object.values(e.properties)) assert.ok(typeof v !== 'string' || !/[\s/@]/.test(v), `${event} sent text: ${v}`)
  }
})

test('text, paths and unknown events are dropped', () => {
  assert.equal(sanitize('chat_message', { text: 'hi' }), null)
  assert.equal(sanitize('setup_step_failed', { step: 'claude', reason_code: 'ENOENT: no such file /Users/ana' })!.properties.reason_code, undefined)
  assert.equal(sanitize('chat_started', { engine: 'acme/secret-repo' })!.properties.engine, undefined)
  assert.equal(sanitize('feature_used', { feature: 'something_else' }), null)
  assert.equal(sanitize('onboarding_completed', { seconds: 71.6 })!.properties.seconds, 72)
})

test('track never sends under test, but records the sanitized event', () => {
  track('suggestion_shown', { kind: 'missing_mcp', text: 'Your chats mention Sentry' })
  const last = recent.at(-1)!
  assert.equal(last.event, 'suggestion_shown')
  assert.equal(last.properties.text, undefined)
})

test('setup scan: repos, suggested folder and MCP names', () => {
  const root = mkdtempSync(join(tmpdir(), 'perch-scan-'))
  for (const r of ['Development/a', 'Development/b', 'Development/c', 'other/d', 'Development/deep/x/y/z']) mkdirSync(join(root, r, '.git'), { recursive: true })
  const repos = scanRepos([join(root, 'Development'), join(root, 'other')])
  assert.deepEqual(repos.map(r => r.slice(root.length + 1)).sort(), ['Development/a', 'Development/b', 'Development/c', 'other/d'])
  assert.equal(suggestCwd(repos).suggested, join(root, 'Development'))
  const names = mcpNames(JSON.stringify({ mcpServers: { grafana: { url: 'https://secret' } }, projects: { '/x': { mcpServers: { linear: {} } } } }), '[mcp_servers.sentry]\ncommand = "x"\n[mcp_servers."posthog"]\n')
  assert.deepEqual(names, { claude: ['grafana', 'linear'], codex: ['sentry', 'posthog'] })
})

test('suggestions: only with nudges on, and dismissed stays dismissed', () => {
  updateSettings({ nudges: { enabled: false } })
  suggestions.add('missing_mcp', 'sentry', 'Connect Sentry?', { label: 'Connect', chat: 'connect sentry' })
  assert.deepEqual(suggestions.active(), [])
  updateSettings({ nudges: { enabled: true } })
  assert.equal(suggestions.active()[0].key, 'sentry')
  suggestions.dismiss('missing_mcp', 'sentry')
  suggestions.add('missing_mcp', 'sentry', 'Connect Sentry again?', { label: 'Connect' })
  assert.deepEqual(suggestions.active(), [])
})
