import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effectiveState, needsReason } from './conversations.ts'
import { hookSignals } from './hookSignals.ts'

// A quiet terminal session: written to 10 minutes ago, nothing flagged it.
const row = (id: string, ago = 10 * 60_000) => ({ id, source: 'claude', updated_at: Date.now() - ago, prs: [], labels: [] })
const fire = (id: string, ev: string, extra: object = {}) => hookSignals.record({ session_id: id, hook_event_name: ev, ...extra })

test('hook signals drive Running and Needs me for terminal sessions', () => {
  fire('h1', 'PreToolUse', { tool_name: 'Bash' })
  assert.equal(effectiveState(row('h1'), new Set()), 'running') // a long tool call, past the 90s guess
  fire('h1', 'Notification', { message: 'Claude needs your permission to use Bash' })
  assert.equal(effectiveState(row('h1'), new Set()), 'waiting')
  assert.equal(needsReason(row('h1')), 'waiting for your permission: Bash')
  fire('h1', 'Notification', { message: 'Claude is waiting for your input' }) // the idle nudge is not a need
  assert.equal(effectiveState(row('h1'), new Set()), 'active')
  fire('h1', 'UserPromptSubmit')
  assert.equal(effectiveState(row('h1'), new Set()), 'running')
  fire('h1', 'Stop')
  assert.equal(effectiveState(row('h1'), new Set()), 'active')
})

test('a Stop beats the 90-second transcript guess, and a newer transcript beats the hook', () => {
  fire('h2', 'Stop')
  assert.equal(effectiveState(row('h2', 20_000), new Set()), 'active') // written 20s ago, but the hook said it stopped
  fire('h3', 'Notification', { message: 'Claude needs your permission to use Edit' })
  const later = { ...row('h3'), updated_at: Date.now() + 10_000 } // the transcript moved after the signal
  assert.equal(needsReason(later), null)
})

test('no signal: the transcript rules decide as before', () => {
  assert.equal(effectiveState(row('none', 20_000), new Set()), 'running')
  assert.equal(effectiveState(row('none'), new Set()), 'active')
})
