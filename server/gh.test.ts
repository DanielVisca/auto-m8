// gh.ts against a fake gh on PATH: partial GraphQL results, chunking, and the offline back-off.
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const bin = mkdtempSync(join(tmpdir(), 'perch-gh-'))
const fake = (script: string) => { writeFileSync(join(bin, 'gh'), `#!/bin/sh\n${script}\n`); chmodSync(join(bin, 'gh'), 0o755) }
process.env.PATH = `${bin}:${process.env.PATH}`
const gh = await import('./gh.ts')
const url = (n: number) => `https://github.com/PostHog/posthog/pull/${n}`

test('one missing PR keeps the rest of the batch', async () => {
  gh.noteGhOk()
  // What gh really does: data for the good aliases on stdout, the bad one on stderr, exit 1.
  fake(`echo '{"data":{"p0":{"pullRequest":{"title":"a"}},"p1":{"pullRequest":null},"p2":{"pullRequest":{"title":"c"}}},"errors":[{"message":"Could not resolve to a PullRequest with the number of 123."}]}'
echo 'gh: Could not resolve to a PullRequest with the number of 123.' >&2; exit 1`)
  const r = await gh.prBatch([url(1), url(123), url(3)], 'title')
  assert.deepEqual([...r.prs.keys()], [url(1), url(3)])
  assert.deepEqual(r.missing, [url(123)])
  assert.equal(r.failed, null)
  assert.match(r.errors[0], /Could not resolve/)
  assert.equal(gh.ghOffline(), false)
})

test('chunks by size', async () => {
  gh.noteGhOk()
  writeFileSync(join(bin, 'calls'), '')
  fake(`echo x >> ${join(bin, 'calls')}; echo '{"data":{}}'`)
  await gh.prBatch(Array.from({ length: 23 }, (_, i) => url(i + 1)), 'title', { size: 10 })
  const { readFileSync } = await import('node:fs')
  assert.equal(readFileSync(join(bin, 'calls'), 'utf8').trim().split('\n').length, 3)
})

test('unreachable GitHub backs off and keeps the error short', async () => {
  gh.noteGhOk()
  fake(`echo 'error connecting to api.github.com' >&2; echo 'check your internet connection or https://githubstatus.com' >&2; exit 1`)
  const r = await gh.prBatch([url(1), url(2)], 'title', { size: 1 })
  assert.ok(r.failed)
  assert.match(r.failed!.message, /^gh api graphql: error connecting to api\.github\.com/)
  assert.ok(!r.failed!.message.includes('pullRequest'), 'the query is not in the message')
  assert.equal(gh.ghOffline(), true)
  assert.equal(gh.ghBackoff().failures, 1, 'stopped after the first chunk instead of hammering')
  await assert.rejects(gh.ghJson(['search', 'prs']), /skipped, api\.github\.com was unreachable/)
  const { friendly } = await import('./errors.ts')
  assert.equal(friendly(r.failed, 'Updating PR status').transient, true)
  assert.match(friendly(r.failed, 'Updating PR status').message, /couldn't reach GitHub/)
  gh.noteGhOk()
})

test('which budget a gh command spends', () => {
  assert.equal(gh.resourceOf(['api', 'graphql', '-f', 'query=x']), 'graphql')
  assert.equal(gh.resourceOf(['pr', 'view', '1']), 'graphql')
  assert.equal(gh.resourceOf(['api', 'repos/PostHog/posthog/labels/x']), 'core')
  assert.equal(gh.resourceOf(['api', 'search/issues']), 'search')
  assert.equal(gh.resourceOf(['search', 'prs', 'x']), 'search')
  assert.equal(gh.resourceOf(['auth', 'status']), 'none')
})

test('a spent GraphQL budget pauses GraphQL calls until the reset, counts them, and says GitHub', async () => {
  gh.noteGhOk(); gh.clearGhRateLimits()
  writeFileSync(join(bin, 'calls'), '')
  const reset = Math.floor(Date.now() / 1000) + 600
  // the rate-limit probe gets headers; everything else gets GitHub's rate-limit answer
  fake(`case "$*" in *rateLimit*) printf 'HTTP/2.0 200 OK\\nX-Ratelimit-Limit: 5000\\nX-Ratelimit-Remaining: 0\\nX-Ratelimit-Used: 5000\\nX-Ratelimit-Reset: ${reset}\\n\\n{}'; exit 1;; esac
echo x >> ${join(bin, 'calls')}
echo '{"errors":[{"type":"RATE_LIMIT","code":"graphql_rate_limit","message":"API rate limit already exceeded for user ID 1."}]}'
echo 'gh: API rate limit already exceeded for user ID 1.' >&2; exit 1`)
  const r = await gh.prBatch([url(1), url(2)], 'title', { size: 1 })
  assert.ok(r.failed)
  const until = gh.ghLimited('graphql')
  assert.ok(until >= reset * 1000, 'paused until the reset GitHub gave')
  assert.equal(gh.ghLimited('core'), 0, 'REST core is a separate budget and keeps working')
  assert.equal(gh.ghOffline(), true, 'GraphQL pollers that check ghOffline skip their tick')
  await assert.rejects(gh.ghExec(['pr', 'view', '1']), /rate limit is used up/)
  const { readFileSync } = await import('node:fs')
  assert.equal(readFileSync(join(bin, 'calls'), 'utf8').trim().split('\n').length, 1, 'stopped after the first answer instead of hammering')
  const { friendly } = await import('./errors.ts')
  const f = friendly(r.failed, 'Updating PR status')
  assert.match(f.message, /^GitHub's API limit/)
  assert.doesNotMatch(f.message, /PostHog/)
  assert.equal(f.transient, false, 'withRetry does not hammer a spent budget')
  assert.match(friendly(new Error('gh api graphql: gh: API rate limit already exceeded for user ID 1.')).message, /GitHub/)
  assert.match(friendly(new Error('PostHog 429: throttled')).message, /PostHog is rate-limiting/)
  const u = gh.ghUsage()
  assert.equal(u.graphql?.remaining, 0)
  const me = u.hours[0].callers.find(c => c.caller === 'gh.test')
  assert.ok(me && me.limited === 1 && me.skipped >= 1, JSON.stringify(u.hours[0]))
  gh.clearGhRateLimits(); gh.noteGhOk()
})

test('budget notice at 80% names the callers', () => {
  const at = Date.now() + 600_000
  assert.equal(gh.budgetNotice({ limit: 5000, used: 3000, remaining: 2000, resetAt: at, at: Date.now() }), null)
  assert.match(gh.budgetNotice({ limit: 5000, used: 4200, remaining: 800, resetAt: at, at: Date.now() })!, /used 4,200 of 5,000 GitHub GraphQL points.*gh\.test/)
})
