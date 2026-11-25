// Ship profiles detected from recorded GitHub data (server/fixtures/shipprofile, read-only gh on
// 2026-11-25; PostHog/charts is private, so its fixture is scrubbed: people, comments, check names and
// commits replaced), and the regression guard: PostHog repos get exactly the shepherd they had before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { candidates, detectProfile, mergeInstruction, recommendations, shipLine, type RawRepo } from './shipprofile.ts'
import { detect, FIRST, MERGE, VERIFY, PLAN_FORMAT, parsePlan, stampLabel, type Snapshot } from './shepherd.ts'
import { queueVia } from './journey.ts'

const raw = (slug: string): RawRepo => JSON.parse(readFileSync(new URL(`./fixtures/shipprofile/${slug.replace('/', '__')}.json`, import.meta.url), 'utf8'))
const profile = (slug: string) => detectProfile(raw(slug))

test('PostHog/posthog: stamphog on a label, Trunk, production Deployments in prod-us and prod-eu', () => {
  const p = profile('PostHog/posthog')
  assert.deepEqual(p.review.autoApprover && { bot: p.review.autoApprover.bot, trigger: p.review.autoApprover.trigger, label: p.review.autoApprover.label }, { bot: 'stamphog', trigger: 'label', label: 'stamphog' })
  assert.equal(p.merge.kind, 'trunk')
  assert.deepEqual(p.merge.enqueue, { comment: '/trunk merge', dequeue: '/trunk unmerge' })
  assert.equal(p.live.kind, 'deployments')
  assert.deepEqual(p.live.environments, ['prod-eu', 'prod-us'], 'dev deployments are not production')
  assert.ok(p.ci.apps.includes('github-actions'))
  assert.equal(p.confidence.merge, 'high')
})

test('PostHog/charts: stamphog, merged by hand, deploys through a workflow', () => {
  const p = profile('PostHog/charts')
  assert.equal(p.review.autoApprover?.label, 'stamphog')
  assert.equal(p.merge.kind, 'manual')
  assert.equal(p.live.kind, 'workflow-run')
  assert.match(p.live.workflow!, /Deploy/i)
  assert.deepEqual(recommendations(p, ['grafana']).map(r => r.key), ['live'], 'publish Deployments from the deploy workflow')
})

test('oxc: the GitHub merge queue, enqueued over GraphQL', () => {
  const p = profile('oxc-project/oxc')
  assert.equal(p.merge.kind, 'github-queue')
  assert.equal(p.merge.enqueue.graphql, 'enqueuePullRequest')
  assert.equal(p.review.autoApprover, null)
  assert.match(mergeInstruction(p, 'u'), /merge queue/)
  assert.equal(queueVia(p).on, 'Add to merge queue')
})

test('crate: Mergify merges, and a CLA label is not its queue trigger', () => {
  const p = profile('crate/crate')
  assert.equal(p.merge.kind, 'mergify')
  assert.notEqual(p.merge.enqueue.label, 'cla-signed')
  assert.equal(p.live.kind, 'release-tag')
})

test('cal.com: people approve and merge, no production signal; .kodiak.toml is not the merge path', () => {
  const p = profile('calcom/cal.com')
  assert.equal(p.merge.kind, 'manual')
  assert.equal(p.review.autoApprover, null)
  assert.ok(p.review.humanShare >= 0.8)
  assert.equal(p.live.kind, 'unknown')
  const recs = recommendations(p, [])
  assert.deepEqual(recs.map(r => r.key), ['review', 'live', 'observability'])
  for (const r of recs) assert.ok(r.title.length < 220 && r.tradeoff.length > 20, 'one line, with its tradeoff')
})

test('auto-m8: merged by hand, merged is live, nothing to recommend', () => {
  const p = profile('DanielVisca/auto-m8')
  assert.equal(p.merge.kind, 'manual')
  assert.equal(p.live.kind, 'merged')
  assert.deepEqual(recommendations(p, ['posthog']), [])
  assert.equal(queueVia(p).on, 'Merge')
  assert.equal(queueVia(p).off, null)
  assert.match(shipLine(p, ['posthog']), /^Review: people · Merge: by hand \(squash\) · CI: GitHub Actions · Live: merged = live · Verify: posthog$/)
})

test('no observability MCP connected is its own recommendation; unknown tools are not', () => {
  const p = profile('PostHog/posthog')
  assert.deepEqual(recommendations(p, []).map(r => r.key), ['observability'])
  assert.deepEqual(recommendations(p, null), [])
})

// ---- PostHog regression: the shepherd behaves exactly as it did before profiles ----
const snap = (o: Partial<Snapshot> = {}): Snapshot => ({
  state: 'OPEN', isDraft: false, head: 'abc1234567890', rollup: 'SUCCESS', failing: [], labels: [], reviewDecision: 'REVIEW_REQUIRED',
  body: '', mergedAt: null, mergeSha: null, threads: [], comments: [], reviews: [], ...o,
})
const zero = { seen_comment: 0, seen_thread: 0, seen_review: 0, handled_ci: null, handled_stamp: null }
const URL_ = 'https://github.com/PostHog/posthog/pull/1'

test('PostHog regression: same stamphog event, merge prompt, first prompt and verify prompt', async () => {
  const p = profile('PostHog/posthog')
  const label = await stampLabel('PostHog/posthog', p)
  assert.equal(label, 'stamphog')
  for (const s of [snap(), snap({ labels: ['stamphog'] }), snap({ rollup: 'FAILURE', failing: ['x'] }), snap({ reviewDecision: 'APPROVED' })])
    assert.deepEqual(detect(s, zero, label), detect(s, zero, true))
  assert.deepEqual(detect(snap(), zero, label).events, ['CI green on abc123456789 with no open threads and no stamphog label: apply stamphog'])
  const plan = parsePlan('<!-- perch-plan\nmerge: auto\n-->')!
  assert.equal(MERGE(URL_, 'abc', plan, p), MERGE(URL_, 'abc', plan), 'Trunk wording unchanged')
  assert.equal(FIRST(URL_, 'h', { profile: p, stamp: label, tools: null }), FIRST(URL_, 'h'))
  assert.equal(VERIFY(URL_, 1, 0, 'abc', plan, { profile: p, stamp: label, tools: null }), VERIFY(URL_, 1, 0, 'abc', plan))
  assert.equal(queueVia(p).kind, 'trunk')
  assert.equal(queueVia(null).kind, 'trunk', 'no profile: Trunk, as before')
  assert.ok(PLAN_FORMAT.includes('(Grafana, PostHog, ...)'))
})

test('repos without a label-triggered approval bot never get "apply stamphog"', async () => {
  for (const slug of ['oxc-project/oxc', 'calcom/cal.com', 'crate/crate', 'DanielVisca/auto-m8']) {
    const label = await stampLabel(slug, profile(slug))
    assert.equal(label, null, slug)
    assert.deepEqual(detect(snap(), zero, label).events, [], slug)
  }
})

test('prompts name the connected observability tools and the confirmed deployment', () => {
  const p = profile('PostHog/posthog')
  const v = VERIFY(URL_, 1, 0, 'abc', null, { profile: p, tools: ['grafana', 'posthog'], live: 'prod-us: deploy of 39da6c80bd' })
  assert.match(v, /Use the observability MCPs connected here: grafana, posthog\./)
  assert.match(v, /already confirmed .* live \(prod-us: deploy of 39da6c80bd\)/)
  assert.match(FIRST(URL_, 'h', { profile: p, stamp: 'stamphog', tools: ['datadog'] }), /\(datadog, \.\.\.\)/)
  const m = VERIFY(URL_, 1, 0, 'abc', null, { profile: profile('DanielVisca/auto-m8'), tools: [] })
  assert.match(m, /merged is live/)
  assert.match(m, /No observability MCP is connected/)
})

test('deployment candidates: production env, successful, after the merge, newest few distinct commits', () => {
  const t = (m: number) => new Date(Date.UTC(2026, 10, 25, 12, m)).toISOString()
  const deps = [
    { env: 'prod-us', at: t(30), task: 'deploy', sha: 'c3', state: 'IN_PROGRESS' },
    { env: 'prod-us', at: t(20), task: 'deploy:mcp', sha: 'c2', state: 'SUCCESS' },
    { env: 'prod-us', at: t(19), task: 'deploy', sha: 'c2', state: 'INACTIVE' },
    { env: 'prod-eu', at: t(18), task: 'deploy', sha: 'c2', state: 'SUCCESS' },
    { env: 'prod-us', at: t(5), task: 'deploy', sha: 'c1', state: 'SUCCESS' },
    { env: 'prod-us', at: t(0), task: 'deploy', sha: 'c0', state: 'SUCCESS' },
  ]
  assert.deepEqual(candidates(deps, 'prod-us', Date.parse(t(4))).map(d => d.sha), ['c2', 'c1'])
})
