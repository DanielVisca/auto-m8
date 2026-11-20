// Reply checks (commands handed to the user) and PR references drawn as pills. Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { asksUserToRun, runCorrectionFor } from './replycheck.ts'
import { bareRefs, knownPrs, linkPrRefs } from '../web/src/prrefs.ts'

test('flags replies that hand a command to the user', () => {
  for (const t of [
    'The quickest way is to paste this in your terminal. It keeps a backup.',
    "If you'd rather not wait, you can run the commit yourself from that worktree:\n```\ngit push\n```",
    'You can run `git push --force-with-lease` from there.',
    'You can close this copy. Continue in your terminal session.',
  ]) assert.ok(asksUserToRun(t), t)
})

test('leaves alone replies that ran it, or opened it in perch', () => {
  for (const t of [
    'Building the version file so I can run its tests locally, then I will push.',
    'I opened it in the terminal under the chat with the command typed in; it needs your sudo password.',
    'Ran `npm test`: 412 passed.',
    '```\nrun this in your terminal\n```',
    '- **Claude Code sessions run in a terminal:** only the per-chat panel covers these.',
    'Now the post-turn check for "run this in your terminal".',
  ]) assert.equal(asksUserToRun(t), null, t)
})

test('one correction per chat per half hour', () => {
  const t = 'Paste this into your terminal: `ls`.'
  assert.ok(runCorrectionFor('c1', t, 1_000_000))
  assert.equal(runCorrectionFor('c1', t, 1_000_000 + 60_000), null)
  assert.ok(runCorrectionFor('c1', t, 1_000_000 + 31 * 60_000))
})

test('PR references become links when they can be pinned to one PR', () => {
  const known = knownPrs(['opened https://github.com/PostHog/posthog/pull/135188 and https://github.com/PostHog/posthog.com/pull/22109'])
  assert.equal(linkPrRefs('#135188 is green', known), '[#135188](https://github.com/PostHog/posthog/pull/135188) is green')
  assert.equal(linkPrRefs('see PostHog/posthog-cloud-infra#12291', known), 'see [PostHog/posthog-cloud-infra#12291](https://github.com/PostHog/posthog-cloud-infra/pull/12291)')
  assert.equal(linkPrRefs('docs in PostHog/posthog.com#22109', known), 'docs in [PostHog/posthog.com#22109](https://github.com/PostHog/posthog.com/pull/22109)')
  // Left alone: unknown numbers, code, existing links, file anchors, headings, short numbers.
  for (const t of ['#999999 unknown', '`#135188`', '[#135188](https://x)', 'server/main.ts#120', '## 135188', 'item #12']) assert.equal(linkPrRefs(t, known), t)
  assert.deepEqual(bareRefs('#135188 and `#5599` and #5600'), ['135188', '5600'])
})

test('owner/repo#n in tool output pins a later bare number', () => {
  const known = knownPrs(['$40.29 PostHog/posthog#84649 feat(desktop): canvases', 'posthog/posthog#84649 and https://github.com/PostHog/posthog/pull/84649'])
  assert.equal(linkPrRefs('#84649 cost the most', known), '[#84649](https://github.com/PostHog/posthog/pull/84649) cost the most')
})

test('a number seen in two repos is ambiguous', () => {
  const known = knownPrs(['https://github.com/a/b/pull/1234 https://github.com/c/d/pull/1234'])
  assert.equal(linkPrRefs('#1234', known), '#1234')
})
