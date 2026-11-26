// Recent's scope: "everywhere" counts chats you typed into outside auto-m8 (a terminal, the Claude
// desktop app, an @PostHog in Slack); "here" only what you opened or wrote in auto-m8. Automation is in neither.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { run } from './db.ts'
import { markSeen } from './conversations.ts'
import { recordOrigin } from './origin.ts'
import { applyLine, emptyMeta } from './transcript.ts'
import { recentPage, sidebar } from './sidebar.ts'

test('transcript meta records how the session started and when a person last typed', () => {
  const m = emptyMeta()
  applyLine(m, JSON.stringify({ type: 'user', entrypoint: 'cli', timestamp: '2026-11-25T10:00:00Z', message: { role: 'user', content: 'fix the build' } }))
  applyLine(m, JSON.stringify({ type: 'assistant', timestamp: '2026-11-25T10:01:00Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } }))
  applyLine(m, JSON.stringify({ type: 'user', timestamp: '2026-11-25T10:02:00Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }))
  applyLine(m, JSON.stringify({ type: 'user', isMeta: true, timestamp: '2026-11-25T10:03:00Z', message: { role: 'user', content: 'hook output' } }))
  assert.equal(m.entrypoint, 'cli')
  assert.equal(m.youAt, Date.parse('2026-11-25T10:00:00Z'), 'tool results and harness text are not you typing')
})

test('everywhere adds terminal, desktop and Slack asks; never scripts or automation', () => {
  const t = Date.now() - 30_000
  const add = (id: string, source: string, extra: Record<string, unknown> = {}) => {
    run(`insert into conversations (id, source, title, first_prompt, started_at, updated_at, messages, status, origin, entrypoint, you_at)
         values (?, ?, ?, ?, ?, ?, 2, 'completed', ?, ?, ?)`, id, source, id, id, t, t, extra.origin ?? null, extra.entrypoint ?? null, extra.you_at ?? null)
  }
  add('sc-terminal', 'claude', { entrypoint: 'cli', you_at: t })
  add('sc-desktop', 'claude', { entrypoint: 'claude-desktop', you_at: t })
  add('sc-script', 'claude', { entrypoint: 'sdk-cli', you_at: t }) // claude -p from a script
  add('task:sc-slack', 'posthog-task', { origin: 'slack' })
  add('task:sc-scout', 'posthog-task', { origin: 'signals_scout' })
  add('task:sc-mine', 'posthog-task', { origin: 'user_created' })
  add('task:sc-templated', 'posthog-task', { origin: 'user_created' })
  add('sc-here', 'claude', { entrypoint: 'sdk-cli' })
  recordOrigin('chat:sc-here', { kind: 'chat', evidence: 'test', owner: 'ana' })
  recordOrigin('chat:task:sc-templated', { kind: 'task', evidence: 'test', parent: 'chat:sc-here' })
  markSeen('sc-here')

  const ids = (scope: 'everywhere' | 'here') => {
    const s = sidebar(scope), r = recentPage(0, 200, scope)
    return new Set([...s.now, ...r.conversations].map(c => c.id).filter(id => id.includes('sc-')))
  }
  const every = ids('everywhere')
  for (const id of ['sc-terminal', 'sc-desktop', 'task:sc-slack', 'task:sc-mine', 'sc-here']) assert.ok(every.has(id), `${id} missing from everywhere`)
  for (const id of ['sc-script', 'task:sc-scout', 'task:sc-templated']) assert.ok(!every.has(id), `${id} should not be in everywhere`)
  assert.deepEqual([...ids('here')], ['sc-here'])
})
