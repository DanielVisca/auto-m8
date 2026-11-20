import assert from 'node:assert/strict'
import { test } from 'node:test'
import { all, run } from './db.ts'
import { candidatePr, chatSubject, confirmPr, inheritChat, originChain, originFor, originMarker, originatedPrs, originPrompt, parseOriginMarkers, prSubject, recordOrigin, searchOrigins, setOriginOwner, startChatOrigin, withOriginMarker } from './origin.ts'
import { cloudPages, cloudSubject, indexCloudTask, indexScoutReport } from './originsync.ts'
import { check } from './signhook.ts'

setOriginOwner('octocat')
const t0 = '2026-11-14T00:00:00Z', t1 = '2026-11-14T01:00:00Z'

test('origin survives delegation, model retries, and an edit to the visible description', () => {
  startChatOrigin('root-test', 'you')
  inheritChat('helper-test', chatSubject('root-test'))
  startChatOrigin('helper-test', 'you')
  const helper = originFor(chatSubject('helper-test'))!
  assert.equal(helper.root, chatSubject('root-test'))
  assert.equal(originChain(helper.subject).length, 2)
  assert.equal(recordOrigin(helper.subject, { kind: 'conversation', owner: 'other', evidence: 'retry' })?.owner, 'octocat')
  const marker = originMarker(helper)
  assert.equal(withOriginMarker('A changed description\n' + marker, helper), 'A changed description\n' + marker)
  assert.match(originPrompt('helper-test'), /NEW PR/)
})

test('private source names and finding details do not enter public markers', () => {
  const o = recordOrigin('private-report-test', { kind: 'report', label: '[security] secret title', evidence: 'private finding URL and full internal context' })!
  const marker = originMarker(o)
  assert.ok(!/security|secret|finding|private/.test(marker))
  assert.equal(parseOriginMarkers(marker)[0].owner, 'octocat')
  assert.throws(() => withOriginMarker('<!-- perch-origin:v1\nbroken -->', o), /Conflicting/)
})

test('report -> task -> new bot-authored PR is attributed even when task creator is another user', () => {
  recordOrigin('test-scout', { kind: 'scout', evidence: 'verified source owner' })
  const report = { id: 'report-test', scout_name: 'test-scout', created_at: t0, implementation_pr_url: 'https://github.com/PostHog/posthog/pull/999001', assignee: { task_id: 'foreign-task' } }
  assert.deepEqual(indexScoutReport(report, 'test-scout'), ['foreign-task'])
  const source = cloudSubject('report', 'report-test')
  indexCloudTask({ id: 'foreign-task', title: 'fix', created_by: { id: 999 }, created_at: t0, latest_run: { created_at: t0, id: 'run', output: { pr_url: report.implementation_pr_url } } }, 493920, source)
  assert.ok(originFor(chatSubject('task:foreign-task')))
  assert.equal(confirmPr(report.implementation_pr_url, t1, 'app/posthog')?.root, 'test-scout')
  assert.deepEqual(originChain(prSubject(report.implementation_pr_url)).map(o => o.kind), ['scout', 'report', 'task', 'pr'])
  assert.ok(originatedPrs().includes(report.implementation_pr_url))
})

test('review output pointing to an existing PR does not claim that PR', () => {
  const url = 'https://github.com/PostHog/posthog/pull/999002'
  indexCloudTask({ id: 'review-task', title: 'review', created_by: { id: 493920 }, created_at: t1, latest_run: { created_at: t1, output: { pr_url: url } } }, 493920)
  assert.equal(confirmPr(url, t0, 'someone-else'), undefined)
  assert.equal(originFor(prSubject(url)), undefined)
})

test('quoted creation commands, mentions, missing ancestry, and foreign tasks are not enough', () => {
  const url = 'https://github.com/PostHog/posthog/pull/999003'
  candidatePr(url, chatSubject('root-test'), Date.parse(t0), 'legacy transcript heuristic')
  assert.equal(confirmPr(url, t1, 'someone-else'), undefined)
  assert.equal(inheritChat('unknown-child', 'missing-parent'), undefined)
  indexCloudTask({ id: 'unrelated', created_by: { id: 999 }, created_at: t0 }, 493920)
  assert.equal(originFor(chatSubject('task:unrelated')), undefined)
  assert.equal(originFor('https://github.com/PostHog/posthog/pull/123'), undefined)
})

test('a workflow marker resolves to the known source, while a forged/unknown one does not', () => {
  const source = recordOrigin('workflow-test', { kind: 'workflow', evidence: 'workflow creator ID matches' })!
  indexCloudTask({ id: 'workflow-child', created_by: 493920, description: originMarker(source), created_at: t0 }, 493920)
  assert.equal(originFor(chatSubject('task:workflow-child'))?.root, source.root)
  indexCloudTask({ id: 'forged-child', description: originMarker(source).replace(/source: .*/, 'source: aaaaaaaaaaaaaaaaaaaaaaaa'), created_at: t0 }, 493920)
  assert.equal(originFor(chatSubject('task:forged-child')), undefined)
  indexCloudTask({ id: 'copied-by-other', created_by: 999, description: originMarker(source), created_at: t0 }, 493920)
  assert.equal(originFor(chatSubject('task:copied-by-other')), undefined)
})

test('search includes an attributed PR without changing its author', () => {
  run("insert into prs (url,title,state) values ('https://github.com/PostHog/posthog/pull/999001','Neutral fix title','OPEN')")
  assert.equal(searchOrigins('origin:me Neutral')[0]?.kind, 'pr')
  assert.equal(searchOrigins('origin:someoneelse Neutral').length, 0)
})

test('pagination follows all pages on the configured host and rejects foreign next URLs', async () => {
  const seen: string[] = []
  const page = await cloudPages(async p => { seen.push(p); return p.includes('offset') ? { results: [2], next: null } : { results: [1], next: '/next?offset=1' } }, '/first')
  assert.deepEqual(page.rows, [1, 2]); assert.deepEqual(seen, ['/first', '/next?offset=1'])
  await assert.rejects(cloudPages(async () => ({ results: [], next: 'https://unrelated.invalid/next' }), '/first'), /Unexpected pagination host/)
})

test('creation hook enforces the inherited marker, leaving review and edit commands alone', () => {
  const marker = originMarker(originFor(chatSubject('root-test'))!)
  const env = { PERCH_ORIGIN_MARKER: marker }
  const hook = (command: string) => check({ tool_name: 'Bash', tool_input: { command } }, env)
  assert.match(hook('gh pr create --fill')!, /hidden marker/)
  assert.equal(hook(`gh pr create --body "Fix.\n${marker}"`), null)
  assert.equal(hook('gh pr view 12'), null)
  assert.equal(hook('gh pr edit 12 --title x'), null)
  assert.equal(hook('echo gh pr create'), null)
})

test('late report evidence augments the chain without replacing the carried origin or creating a cycle', () => {
  const first = recordOrigin('late-task', { kind: 'task', evidence: 'owner created task' })!
  recordOrigin('late-scout', { kind: 'scout', evidence: 'verified source' })
  recordOrigin('late-report', { parent: 'late-scout', kind: 'report', evidence: 'source metadata' })
  recordOrigin('late-task', { parent: 'late-report', kind: 'task', evidence: 'implementation attached later' })
  assert.equal(originFor('late-task')?.root, first.root)
  assert.deepEqual(originChain('late-task').map(o => o.subject), ['late-scout', 'late-report', 'late-task'])
  recordOrigin('late-scout', { parent: 'late-task', kind: 'scout', evidence: 'would form a cycle' })
  assert.equal(originChain('late-scout').length, 1)
})
