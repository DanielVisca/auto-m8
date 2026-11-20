// signhook.ts: GitHub comments posted from Ana's account must carry the agent signature.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { check, signature } from './signhook.ts'

const env = { PERCH_OWNER_NAME: 'Ana', PERCH_AGENT: 'perch shepherd', PERCH_CONVERSATION_ID: 'abc-123' }
const bash = (command: string, cwd?: string) => check({ tool_name: 'Bash', tool_input: { command }, cwd }, env)

test('the signature names the automation and hides the conversation id', () => {
  assert.equal(signature(env), "<sub>🤖 Ana's agent · perch shepherd</sub>\n<!-- perch-agent: perch shepherd, conversation abc-123 -->")
  assert.match(signature({}), /claude code<\/sub>/)
})

test('unsigned comments are blocked with the signature to add', () => {
  for (const c of [
    `gh pr comment 36 --body "Fixed in e77295d."`,
    `gh issue comment 5 -b 'thanks'`,
    `gh pr review 36 --approve --body "lgtm"`,
    `gh api repos/PostHog/snuffle/issues/36/comments -f body='Fixed'`,
    `gh api -X POST repos/o/r/pulls/1/comments/99/replies -f body="Fixed in baa0b08"`,
    `gh api graphql -f query='mutation { addPullRequestReviewThreadReply(input: {body: "x"}) { comment { id } } }'`,
    `cd repo && gh pr comment 36 --body "Fixed."`,
    `GH_TOKEN=x gh pr comment 36 --body "Fixed."`,
    `URL=$(gh pr comment 36 --body "x")`,
    `for n in 1 2; do\n  gh pr comment $n --body "x"\ndone`,
  ]) assert.match(bash(c) ?? '', /perch-agent: perch shepherd, conversation abc-123/, c)
})

test('signed comments, bot commands and reads pass', () => {
  for (const c of [
    `gh pr comment 36 --body "Fixed.\n\n${signature(env)}"`,
    `gh pr comment 36 --body "/trunk merge"`,
    `gh pr comment 36 --body '@posthog review'`,
    `gh api repos/o/r/issues/36/comments --jq '.[].body'`,
    `gh pr review 36 --approve`,
    `gh pr view 36 --comments`,
    `gh pr create --body "x"`,
    `git commit -m "comment"`,
    `echo gh pr comment 1 --body "hello"`,
    "python3 - <<'EOF'\nprompt = '3. Post it with `gh pr comment 5 --body-file f`'\nEOF",
  ]) assert.equal(bash(c), null, c)
})

test('a body file is read for the signature', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sign-'))
  writeFileSync(join(dir, 'signed.md'), `hi\n\n${signature(env)}`)
  writeFileSync(join(dir, 'plain.md'), 'hi')
  assert.equal(bash(`gh pr comment 36 --body-file signed.md`, dir), null)
  assert.equal(bash(`gh api repos/o/r/issues/1/comments -F body=@${dir}/signed.md`), null)
  assert.notEqual(bash(`gh pr comment 36 --body-file plain.md`, dir), null)
})

test('GitHub MCP comment tools are checked too', () => {
  const mcp = (body: string) => check({ tool_name: 'mcp__claude_ai_GitHub_Copilot_MCP__add_issue_comment', tool_input: { body } }, env)
  assert.notEqual(mcp('Fixed'), null)
  assert.equal(mcp(`Fixed\n\n${signature(env)}`), null)
  assert.equal(check({ tool_name: 'mcp__claude_ai_GitHub_Copilot_MCP__get_me', tool_input: {} }, env), null)
})

test('as a hook process it denies with JSON and is silent otherwise', () => {
  const run = (input: object) => execFileSync(process.execPath, [join(import.meta.dirname, 'signhook.ts')], { input: JSON.stringify(input), env: { ...process.env, ...env } }).toString()
  const out = JSON.parse(run({ tool_name: 'Bash', tool_input: { command: 'gh pr comment 1 -b "x y z"' } }))
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'ls' } }), '')
})

test('the signature names whoever owns this perch', async () => {
  const { possessive } = await import('./owner.ts')
  assert.match(signature({ PERCH_OWNER_NAME: 'Ana', PERCH_AGENT: 'shepherd' }), /🤖 Ana's agent · shepherd/)
  assert.match(signature({ PERCH_OWNER_NAME: 'James' }), /🤖 James' agent · claude code/)
  assert.equal(possessive('Ana'), "Ana's")
})
