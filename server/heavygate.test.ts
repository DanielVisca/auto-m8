import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.PERCH_HEAVY_DIR = mkdtempSync(join(tmpdir(), 'heavy-'))
const { classify, hook } = await import('./heavygate.ts')
const W = '/Users/x/Development/.perch-worktrees/posthog-pr1'

test('classifies heavy commands in big repos only', () => {
  assert.equal(classify('pnpm exec tsc --noEmit -p tsconfig.json', W), 'build')
  assert.equal(classify('pnpm --filter=@posthog/frontend typescript:check', W), 'build')
  assert.equal(classify('git push origin HEAD:x', W), 'build')
  assert.equal(classify('pytest products/x/test_y.py -q', W), 'test')
  assert.equal(classify('cd /a/b && flox activate -- pytest x', W), 'test')
  assert.equal(classify('git status && git diff', W), null)
  assert.equal(classify('echo "run tsc later"', W), null)
  assert.equal(classify('npx tsc --noEmit -p .', '/Users/x/Development/perch-oss'), null)
})

test('one build slot: second agent is denied until the first finishes', () => {
  const pre = (id: string, command: string) => hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id, cwd: W, tool_input: { command } }, process.pid)
  assert.equal(pre('a', 'pnpm exec tsc --noEmit'), null)
  const denied: any = pre('b', 'pnpm exec tsc --noEmit')
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /posthog-pr1/)
  assert.equal(pre('t1', 'pytest x'), null) // tests have their own slots
  assert.equal(pre('t2', 'pytest y'), null)
  assert.equal((pre('t3', 'pytest z') as any).hookSpecificOutput.permissionDecision, 'deny')
  hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'a', tool_input: {} })
  assert.equal(pre('b', 'pnpm exec tsc --noEmit'), null)
})

test('a slot held by a process that is gone is free', () => {
  const pre = (id: string, pid: number) => hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id, cwd: W, tool_input: { command: 'pnpm build' } }, pid)
  hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b', tool_input: {} })
  assert.equal(pre('dead', 999999), null)
  assert.equal(pre('next', process.pid), null) // 999999 isn't alive, so its slot was cleared
})
