// Chat names you can read at a glance, and the branch family of a chat.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { run } from './db.ts'
import { family } from './family.ts'
import { readableTitle, userText } from './transcript.ts'
import { tidy } from './titles.ts'

test('titles drop pulled-in context, link markup and scout boilerplate', () => {
  assert.equal(readableTitle('<earlier-conversations>\nThe user pulled these in…\n</earlier-conversations>\n\nShort chat names please'), 'Short chat names please')
  assert.equal(readableTitle('[sandbox_prompt:signals_scout:prod-walkthrough] You are a Signals scout agent for PostHog.\n\nYour job'), 'Scout: prod-walkthrough')
  assert.equal(readableTitle('*<https://github.com/octocat|@octocat>* teams can set keys'), '@octocat teams can set keys')
  assert.equal(readableTitle('look at https://github.com/PostHog/posthog/pull/134625 again'), 'look at posthog#134625 again')
  assert.equal(tidy('"Get all metrics into PostHog."'), 'Get all metrics into PostHog')
  assert.equal(readableTitle('<attached-images>\n- /Users/x/Library/Application Support/perch/attachments/a.png\n</attached-images>\n\ngreat, also fix the names\n[Image: source: /private/tmp/1.png]'), 'great, also fix the names')
  assert.equal(readableTitle('<attached-images>\n- /Users/x/a.png\n</attached-images>'), 'Image')
  // Shared links and files lead the message, but the words you wrote name the chat.
  assert.equal(readableTitle('🔗 https://posthog.slack.com/archives/C0B/p1795) 🔗 https://posthog.slack.com/archives/C0B/p1795 I keep starting on clustering'), 'I keep starting on clustering')
  assert.equal(readableTitle('<shared-from-browser>\nPage "Slack" (https://posthog.slack.com/archives/C0B/p1795)\nhttps://posthog.slack.com/archives/C0B/p1795\n</shared-from-browser>\n\nis this ready?'), 'is this ready?')
  assert.equal(readableTitle('☁ 🔗 https://posthog.slack.com/archives/C0B/p1795 pull in our expertise'), '☁ pull in our expertise')
  assert.equal(readableTitle('📄 notes.md 🔗 https://github.com/PostHog/dash/pull/7'), '📄 notes.md 🔗 dash#7') // nothing else: keep the refs
})

test('a link shared from the browser shows once, without the closing bracket', () => {
  assert.equal(userText('<shared-from-browser>\nPage "Slack" (https://posthog.slack.com/archives/C0B/p1795)\nhttps://posthog.slack.com/archives/C0B/p1795\n</shared-from-browser>\n\nhi'), '🔗 https://posthog.slack.com/archives/C0B/p1795\n\nhi')
})

test('a chat shows where it branched from and every branch off it', () => {
  const now = Date.now()
  for (const id of ['root', 'b1', 'b2', 'b1a', 'other']) run(`insert into conversations (id, source, title, started_at, updated_at, messages) values (?, 'claude', ?, ?, ?, 1)`, id, `T ${id}`, now, now)
  run(`insert into links (a, b, kind, created_at) values ('b1', 'root', 'branch', 1), ('b2', 'root', 'context', 2), ('b1a', 'b1', 'rewound', 3), ('other', 'root', 'related', 4)`)
  const f = family('b1a')
  assert.equal(f.root, 'root')
  assert.deepEqual(f.members.map(m => [m.id, m.depth]), [['root', 0], ['b1', 1], ['b1a', 2], ['b2', 1]])
  assert.equal(family('other').members.length, 1) // "related" isn't family
})

test('rows show the repo, not the shared folder perch starts chats in', async () => {
  const { placeOf } = await import('./conversations.ts')
  const { settings } = await import('./settings.ts')
  const dev = settings.chat.cwd
  assert.equal(placeOf({ cwd: dev, prs: [{ url: 'https://github.com/PostHog/posthog/pull/1' }, { url: 'https://github.com/PostHog/posthog/pull/2' }, { url: 'https://github.com/PostHog/charts/pull/3' }] }), 'posthog')
  assert.equal(placeOf({ cwd: dev, prs: [] }), null)
  assert.equal(placeOf({ cwd: `${dev}/perch`, prs: [] }), 'perch')
  assert.equal(placeOf({ cwd: `${dev}/posthog/.perch-worktrees/fix-x`, prs: [] }), 'posthog')
})
