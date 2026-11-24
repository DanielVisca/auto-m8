import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { all, db, run } from './db.ts'
import { DATA_DIR, settings } from './settings.ts'
import { busyChatIds, claimNeeds, finishReview, HOUR, need, needByKey, needHistory, needsList, recheckNeed, reportNeed, saveSync, syncValue, updateNeed } from './needsstore.ts'
import { blockerText, captureApproval, captureLocalNeeds, captureScoutReport, syncScoutNeeds } from './needssources.ts'

db.exec(`create table if not exists perch_started (id text primary key, at integer, by text)`)
const now = Date.now()
beforeEach(() => {
  for (const t of ['needs', 'needs_events', 'needs_sync', 'needs_runs', 'conversations', 'perch_started']) run(`delete from ${t}`)
})
const report = (key = 'test', at = now) => reportNeed({ key, source: 'test', title: 'Unlock the account', context: 'Only the user can unlock it' }, at)

test('polling, opening, old age and a related merge never resolve an intervention', () => {
  const n = report('test', now - 30 * 86400_000)
  updateNeed(n.id, { status: 'needs_you', evidence: 'Sign-in still requires a hardware key', human_action: 'Sign in with your hardware key' }, 'reviewer', now)
  report('test', now + 30 * 86400_000)
  assert.equal(need(n.id)?.status, 'needs_you')
  assert.equal(needsList().items.length, 1)
  assert.equal(needHistory(n.id).length, 2)
  assert.throws(() => updateNeed(n.id, { status: 'resolved', evidence: '' }))
  assert.throws(() => updateNeed(n.id, { status: 'needs_you', evidence: 'unclear' }))
})

test('dismissal sticks for an unchanged source; new evidence reopens it without losing history', () => {
  const n = report()
  updateNeed(n.id, { status: 'dismissed', evidence: 'Duplicate of another tracked item' })
  assert.equal(report().status, 'dismissed')
  const fresh = reportNeed({ key: 'test', source: 'test', title: n.title, context: 'The account was locked again' })
  assert.equal(fresh.id, n.id)
  assert.equal(fresh.status, 'checking')
  assert.equal(needHistory(n.id).length, 3)
})

test('a newer source reply keeps a confirmed human action visible until evidence clears it', () => {
  const n = report()
  updateNeed(n.id, { status: 'needs_you', human_action: 'Unlock the account', evidence: 'Hardware key required; account still locked' }, 'reviewer', now)
  claimNeeds('old-review', new Set(), 12, now + 25 * HOUR)
  const changed = reportNeed({ key: 'test', source: 'test', title: 'Another task', context: 'The same chat is now working on a different task' }, now + 25 * HOUR + 1)
  assert.equal(changed.status, 'needs_you')
  assert.equal(changed.human_action, 'Unlock the account')
  assert.equal(changed.evidence, 'Hardware key required; account still locked')
  assert.equal(changed.lease_until, null)
  recheckNeed(n.id, now + 25 * HOUR + 1)
  assert.equal(need(n.id)?.status, 'needs_you', 'requesting a recheck must not hide the action either')
  assert.match(need(n.id)?.evidence ?? '', /Hardware key required/)
  assert.throws(() => updateNeed(n.id, { status: 'resolved', evidence: 'Stale review', reviewer_id: 'old-review', revision: n.revision }))
  const next = claimNeeds('fresh-review', new Set(), 12, now + 25 * HOUR + 2)
  assert.equal(next[0].id, n.id)
  updateNeed(n.id, { status: 'resolved', evidence: 'Verified the account is unlocked', reviewer_id: 'fresh-review', revision: changed.revision })
  assert.equal(need(n.id)?.status, 'resolved')
})

test('one leased batch, daily bound, busy owner exclusion and stale review protection', () => {
  const n = report()
  const other = reportNeed({ key: 'busy', source: 'test', title: 'Busy owner', conversation_id: 'busy-chat' }, now)
  const batch = claimNeeds('r1', new Set(['busy-chat']), 2, now)
  assert.deepEqual(batch.map(n => n.id), [n.id])
  assert.equal(claimNeeds('r2', new Set(), 2, now).length, 0)
  const changed = reportNeed({ key: 'test', source: 'test', title: n.title, context: 'Changed evidence' }, now + 1)
  assert.throws(() => updateNeed(n.id, { status: 'resolved', evidence: 'Old result', reviewer_id: 'r1', revision: batch[0].revision }))
  assert.equal(changed.status, 'checking')
  claimNeeds('r2', new Set(), 2, now + 2)
  finishReview('r2', 'Tool failed', now + 3)
  recheckNeed(other.id, now + 4)
  assert.equal(claimNeeds('r3', new Set(), 2, now + 5).length, 0)
  assert.equal(need(other.id)?.status, 'checking')
})

test('a failed review retains a confirmed human action and schedules retry', () => {
  const n = report()
  updateNeed(n.id, { status: 'needs_you', evidence: 'Login requires hardware key', human_action: 'Touch your hardware key' }, 'reviewer', now)
  claimNeeds('r1', new Set(), 12, now + 25 * HOUR)
  finishReview('r1', 'Connector timed out', now + 25 * HOUR + 1)
  const result = need(n.id)!
  assert.equal(result.status, 'needs_you')
  assert.equal(result.human_action, 'Touch your hardware key')
  assert.equal(result.lease_until, null)
  assert.ok(result.next_check_at > now + 25 * HOUR)
})

test('an idle reviewer or owner in the chat inventory does not block the next batch', () => {
  const n = reportNeed({ key: 'idle', source: 'test', title: 'Unblock an idle owner', conversation_id: 'idle-owner' }, now)
  reportNeed({ key: 'live', source: 'test', title: 'Active owner', conversation_id: 'live-owner' }, now)
  const busy = busyChatIds([{ id: 'previous-reviewer', state: 'idle' }, { id: 'idle-owner', state: 'exited' }, { id: 'live-owner', state: 'running' }])
  assert.equal(busy.has('previous-reviewer'), false)
  assert.deepEqual(claimNeeds('next-reviewer', busy, 12, now).map(n => n.id), [n.id])
})

test('a user dismissal invalidates a running review and a claimed fix queues verification', () => {
  const n = report()
  claimNeeds('r1', new Set(), 12, now)
  updateNeed(n.id, { status: 'dismissed', evidence: 'Not needed' }, 'user', now + 1)
  assert.throws(() => updateNeed(n.id, { status: 'needs_you', evidence: 'Old review', human_action: 'Sign in', reviewer_id: 'r1', revision: n.revision }))
  recheckNeed(n.id, now + 2, 'User resolved their part; verify and resume')
  assert.equal(need(n.id)?.status, 'checking')
  assert.match(need(n.id)?.evidence ?? '', /verify and resume/)
})

test('scout resolution is explicit and scoped to host/project; a handoff is not resolution', () => {
  const r = { id: 'r1', title: 'Choose rollout', summary: 'Needs input', status: 'pending_input', actionability: 'requires_human_input', scout_name: 'my-scout' }
  captureScoutReport(r, 'us.posthog.com/2', 'https://us.posthog.com/project/2')
  captureScoutReport(r, 'eu.posthog.com/2', 'https://eu.posthog.com/project/2')
  const n = needByKey('report:us.posthog.com/2:r1')!
  updateNeed(n.id, { status: 'agent', evidence: 'Sent an instruction to its owner' })
  captureScoutReport(r, 'us.posthog.com/2', 'https://us.posthog.com/project/2')
  assert.equal(need(n.id)?.status, 'agent')
  captureScoutReport({ ...r, status: 'resolved' }, 'us.posthog.com/2', 'https://us.posthog.com/project/2')
  assert.equal(need(n.id)?.status, 'resolved')
  assert.equal(needByKey('report:eu.posthog.com/2:r1')?.status, 'checking')
  assert.equal(needsList().history.length, 1)
})

test('explicit browser gates are tracked and their answer closes only that gate', () => {
  const a = { id: 'approval1', owner: 'owner', what: 'finalize snapshots', url: 'https://example.com', state: 'pending' }
  captureApproval(a)
  const n = needByKey('browser:approval1')!
  assert.equal(n.status, 'checking')
  captureApproval({ ...a, state: 'denied' })
  assert.equal(need(n.id)?.status, 'resolved')
  assert.match(need(n.id)?.evidence ?? '', /denied/)
})

test('local collection includes automation and PostHog summaries, excludes its own reviewers and active tasks', () => {
  const path = join(DATA_DIR, 'blocked.jsonl')
  writeFileSync(path, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Needs Ana to sign in before I can continue.' }] } }) + '\n')
  run(`insert into conversations (id, source, title, path, updated_at) values ('local', 'claude', 'Routine', ?, ?)`, path, now - HOUR)
  run(`insert into perch_started (id, by) values ('local', 'routine'), ('review', 'needs-review')`)
  for (const [id, status] of [['cloud', 'completed'], ['active', 'in_progress'], ['review', 'completed']]) run(`insert into conversations (id, source, title, summary, status, updated_at, origin) values (?, 'posthog-task', 'Scout', 'requires_human_input: choose scope', ?, ?, 'signals_scout')`, id, status, now - HOUR)
  captureLocalNeeds(new Set(), now)
  assert.deepEqual(needsList().items.map(n => n.conversation_id).sort(), ['cloud', 'local'])
  captureLocalNeeds(new Set(), now)
  assert.equal(needsList().items.length, 2)
  assert.equal(blockerText('The result is ready; no action necessary.'), false)
})

test('cloud collection verifies ownership, reads known reports for resolution and keeps errors visible', async () => {
  const prefix = `/api/projects/${settings.posthog.projectId}`
  const report = { id: 'r1', scout_name: 'mine', title: 'Pick scope', status: 'pending_input', actionability: 'requires_human_input', summary: 'Choose one' }
  let resolved = false, fail = false
  const calls: string[] = []
  const fetch = async (path: string) => {
    calls.push(path)
    if (fail) throw new Error('endpoint 503')
    if (path === '/api/users/@me/') return { id: 7 }
    if (path.includes('/configs/')) return { results: [{ skill_name: 'mine', owners: [{ id: 7 }] }] }
    if (path.startsWith(`${prefix}/signals/reports/r1/`)) return { ...report, status: resolved ? 'resolved' : 'pending_input' }
    return { results: [report, { ...report, id: 'someone-elses', scout_name: 'foreign' }] }
  }
  await syncScoutNeeds(fetch, now)
  assert.equal(needsList().items.length, 1)
  fail = true
  await syncScoutNeeds(fetch, now + HOUR)
  assert.equal(needsList().items.length, 1)
  assert.match(syncValue('cloudError')!, /503/)
  fail = false; resolved = true
  await syncScoutNeeds(fetch, now + HOUR + 60_000)
  assert.equal(needsList().history.length, 0, 'errors are not retried every tick')
  await syncScoutNeeds(fetch, now + HOUR + 2 * 60_000)
  assert.equal(needsList().history.length, 1)
  assert.equal(syncValue('cloudError'), '')
  assert.ok(calls.some(p => p.includes('/reports/r1/')))
})

test('engine quota errors are recognised so they pause reviews instead of burning daily runs', async () => {
  const { isQuotaError } = await import('./needs.ts')
  assert.ok(isQuotaError('Codex: You hit your spend cap set by the owner of your workspace.'))
  assert.ok(isQuotaError('Claude usage limit reached'))
  assert.ok(!isQuotaError('Reviewer finished without recording an outcome'))
})

test('network failures while offline are recognised so they do not burn daily runs', async () => {
  const { isNetworkError } = await import('./needs.ts')
  assert.ok(isNetworkError("API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)"))
  assert.ok(isNetworkError('Codex: workspace routing discovery timed out'))
  assert.ok(!isNetworkError('Reviewer finished without recording an outcome'))
})

test('free PR pre-check: only shepherd/digest items, all PRs finished, closes with evidence', async () => {
  const { prsDeciding, closingEvidence, precheckPrNeeds } = await import('./needsprcheck.ts')
  assert.deepEqual(prsDeciding({ source: 'chat', title: 'Shepherd: posthog#134878', context: '', url: null }), [{ repo: 'PostHog/posthog', number: 134878 }])
  // An arbitrary chat that merely links a PR must never auto-close.
  assert.equal(prsDeciding({ source: 'chat', title: 'decide on rollout', context: 'see https://github.com/PostHog/charts/pull/20249', url: null }), null)
  assert.equal(prsDeciding({ source: 'PostHog scout', title: 'Scout self-improvement: signals-scout-prs – cover auto PRs', context: 'https://github.com/PostHog/posthog-js/pull/5594', url: null }), null)
  const digest = { source: 'PostHog scout · signals-scout-prs', title: 'PR digest', context: 'https://github.com/PostHog/posthog/pull/1 and https://github.com/PostHog/posthog/pull/2', url: null }
  const prs = prsDeciding(digest)!
  assert.equal(prs.length, 2)
  // One PR still open keeps the item.
  assert.equal(closingEvidence(prs, new Map([['PostHog/posthog#1', { state: 'MERGED' }], ['PostHog/posthog#2', { state: 'OPEN' }]])), null)
  assert.match(closingEvidence(prs, new Map([['PostHog/posthog#1', { state: 'MERGED', mergedAt: 'x' }], ['PostHog/posthog#2', { state: 'CLOSED' }]]))!, /pull\/2 is CLOSED/)

  saveSync('prPrecheckAt', '0')
  const done = reportNeed({ key: 'pc-done', source: 'shepherd', title: 'Shepherd: posthog#9001', context: 'stuck' }, now)
  const open = reportNeed({ key: 'pc-open', source: 'shepherd', title: 'Shepherd: posthog#9002', context: 'stuck' }, now)
  const other = reportNeed({ key: 'pc-other', source: 'chat', title: 'pick timing', context: 'https://github.com/PostHog/posthog/pull/9001' }, now)
  const closed = await precheckPrNeeds(now, async p => ({ state: p.number === 9001 ? 'MERGED' : 'OPEN' }))
  assert.ok(closed >= 1)
  assert.equal(need(done.id)!.status, 'resolved')
  assert.equal(need(open.id)!.status, 'checking')
  assert.equal(need(other.id)!.status, 'checking')
  // Throttled: a second sweep inside 15 minutes does nothing.
  assert.equal(await precheckPrNeeds(now + 1000, async () => ({ state: 'MERGED' })), 0)
})

test('shepherd runs for the same PR share one Needs me item', async () => {
  const { chatNeedKey } = await import('./needssources.ts')
  assert.equal(chatNeedKey('a', 'PR shepherd: PostHog/posthog#120731'), 'pr:PostHog/posthog#120731')
  assert.equal(chatNeedKey('b', '☁ Shepherd: posthog#120731'), 'pr:PostHog/posthog#120731')
  assert.equal(chatNeedKey('c', 'Shepherd: charts#20249'), 'pr:PostHog/charts#20249')
  assert.equal(chatNeedKey('d', 'Decide whether to merge posthog#1'), 'chat:d')
  assert.equal(chatNeedKey('e', 'Blocked work', 'Shepherd: posthog#5'), 'pr:PostHog/posthog#5')
})

test('the PR digest scout can be named scout-prs or scout-<anything>-prs', async () => {
  const { isPrScoutName, prsDeciding } = await import('./needsprcheck.ts')
  for (const name of ['signals-scout-prs', 'scout-prs', 'signals-scout-team-prs', 'signals-scout-my-org-2-prs']) assert.equal(isPrScoutName(name), true, name)
  for (const name of ['signals-scout-prs-weekly', 'signals-scout', 'prs', 'scoutprs', '']) assert.equal(isPrScoutName(name), false, name)
  const ctx = 'https://github.com/PostHog/app/pull/7'
  assert.deepEqual(prsDeciding({ source: 'PostHog scout · signals-scout-team-prs', title: 'Scout: signals-scout-team-prs', context: ctx, url: null }), [{ repo: 'PostHog/app', number: 7 }])
  assert.deepEqual(prsDeciding({ source: 'PostHog scout · signals-scout-team-prs', title: '[sandbox_prompt:signals_scout:signals-scout-team-prs] review', context: ctx, url: null }), [{ repo: 'PostHog/app', number: 7 }])
  assert.equal(prsDeciding({ source: 'PostHog scout', title: 'Scout self-improvement: signals-scout-team-prs', context: ctx, url: null }), null)
})
