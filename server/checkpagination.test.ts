import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const bin = mkdtempSync(join(tmpdir(), 'perch-checks-'))
const calls = join(bin, 'calls')
process.env.PATH = `${bin}:${process.env.PATH}`
const { snapshots, detect, changedSnapshots, resetSnapshotCache } = await import('./shepherd.ts')
const { prState, prStates, prLine, prBrief, clearBriefs } = await import('./ghpr.ts')
const { clearCheckCache } = await import('./gh.ts')
const { preview } = await import('./pr.ts')
const { diffPr } = await import('./orchestra.ts')
const url = 'https://github.com/PostHog/posthog/pull/135915'
const zero = { seen_comment: 0, seen_thread: 0, seen_review: 0, handled_ci: null, handled_stamp: null }
const failing = ['Test Rust (logs-ingestion)', 'Rust Tests Pass']

function fixture(options: { singlePage?: boolean; brokenPage?: boolean; noNames?: boolean; nodes?: object[]; rollup?: string } = {}) {
  writeFileSync(calls, '')
  clearCheckCache(); resetSnapshotCache(); clearBriefs()
  const nodes = options.nodes ?? Array.from({ length: options.singlePage ? 3 : 205 }, (_, i) => ({
    name: i === 153 ? failing[0] : i === 204 ? failing[1] : `check-${i}`, conclusion: !options.noNames && (i === 153 || i === 204) ? 'FAILURE' : 'SUCCESS', status: 'COMPLETED',
  }))
  const script = `#!${process.execPath}
const fs = require('node:fs')
const q = process.argv.find(x => x.startsWith('query=')).slice(6)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(q) + '\\n')
let nodes = ${JSON.stringify(nodes)}
if (!q.includes('isRequired(pullRequestNumber:')) nodes = nodes.map(({isRequired, ...rest}) => rest)
const after = q.match(/after:\\s*"([^\"]+)"/)
const offset = after ? Number(after[1]) : 0
const contexts = { totalCount: nodes.length, nodes: nodes.slice(offset, offset + 100), pageInfo: { hasNextPage: offset + 100 < nodes.length, endCursor: String(offset + 100) } }
const rollup = { id: 'rollup-original-head', state: ${JSON.stringify(options.rollup ?? 'FAILURE')}, contexts }
const p = { updatedAt:'2026-11-14T04:00:00Z', title:'retry', number:135915, state:'OPEN', isDraft:false, headRefOid:'original-head', headRefName:'fix/retry', baseRefName:'master', reviewDecision:'APPROVED', author:{login:'author'}, body:'', labels:{nodes:[]}, commits:{nodes:[{commit:{oid:'original-head', committedDate:'2026-11-14T04:00:00Z', statusCheckRollup:rollup}}]}, comments:{totalCount:0,nodes:[]}, reviews:{nodes:[]}, latestReviews:{nodes:[]}, reviewThreads:{nodes:[]}, files:{nodes:[]} }
if (after && ${!!options.brokenPage}) { console.log(JSON.stringify({data:{node:null},errors:[{message:'page unavailable'}]})); process.exit(1) }
console.log(JSON.stringify({ data: after ? {node:rollup} : q.includes('p0:') ? {p0:{pullRequest:p},p1:{pullRequest:{...p,commits:{nodes:[]}}}} : {repository:{pullRequest:p}} }))
`
  writeFileSync(join(bin, 'gh'), script)
  chmodSync(join(bin, 'gh'), 0o755)
}

test('shepherd reads all 205 checks and detects a failure beyond the first 100 exactly once', async () => {
  fixture()
  const p = (await snapshots([url])).get(url)!
  assert.deepEqual(p.failing, failing)
  const d = detect(p, zero, true)
  assert.equal(d.events.length, 1)
  assert.match(d.events[0], /Test Rust/)
  assert.deepEqual(detect(p, { ...zero, handled_ci: d.ci }, true).events, [])
  const requests = readFileSync(calls, 'utf8').trim().split('\n').map(q => JSON.parse(q) as string).filter(q => q.includes('after:'))
  assert.equal(requests.length, 2)
  for (const q of requests) assert.match(q, /node\(id: "rollup-original-head"\)/, 'pagination stays on the same commit when the PR head moves')
})

test('board and hover preview include failures beyond the first 100 checks', async () => {
  fixture()
  const p = await prState(url, 0)
  assert.equal(p.checks, 'failing')
  assert.equal(p.totalChecks, 205)
  assert.deepEqual(p.failing, failing)
  assert.match(prLine(p), /CI RED \(2: Test Rust/)
  assert.deepEqual((await preview(url)).checks.failing, failing)
})

test('a failed next page skips that snapshot without losing other PRs in the batch', async () => {
  fixture({ brokenPage: true })
  const other = url.replace('135915', '135916')
  const result = await snapshots([url, other])
  assert.equal(result.has(url), false, 'partial checks must not be treated as complete')
  assert.equal(result.has(other), true)
  await assert.rejects(prState(url, 0), /page unavailable/)
})

test('a red rollup still wakes once and shows red when GitHub supplies no named failures', async () => {
  fixture({ singlePage: true, noNames: true })
  const p = (await snapshots([url])).get(url)!
  const d = detect(p, zero, true)
  assert.equal(d.events.length, 1)
  assert.deepEqual(detect(p, { ...zero, handled_ci: d.ci }, true).events, [])
  const state = await prState(url, 0)
  assert.equal(state.checks, 'failing')
  assert.match(prLine(state), /failure details unavailable/)
  assert.ok(!readFileSync(calls, 'utf8').includes('after:'), 'single-page PRs do not need another request')
})

const completed = (name: string, conclusion = 'SUCCESS', isRequired?: boolean) => ({ name, conclusion, isRequired, status: 'COMPLETED', completedAt: '2026-11-13T16:54:28Z' })
const before = { state: 'open', head: 'original-head', checks: 'running', review: 'approved', unresolved: 0, failing: [] }

test('optional cancellations beyond page one are visible without red/green events or a shepherd run', async () => {
  fixture({ nodes: [...Array.from({ length: 100 }, (_, i) => completed(`check-${i}`)),
    completed('assign-labels', 'CANCELLED', false), completed('flags-project-board', 'CANCELLED', false),
    { ...completed('Determine need to run dagster checks'), status: 'IN_PROGRESS' },
  ] })
  const p = await prState(url, 0)
  assert.equal(p.checks, 'cancelled')
  assert.deepEqual(p.failing, [])
  assert.deepEqual(p.pending, [], 'a final conclusion/completion time wins over stale IN_PROGRESS')
  assert.deepEqual(p.optionalCancelled, ['assign-labels', 'flags-project-board'])
  assert.match(prLine(p), /2 optional jobs cancelled: assign-labels, flags-project-board/)
  assert.deepEqual(diffPr(before, p, p), [], 'optional cancellations neither announce failure nor green CI')
  assert.deepEqual(detect((await snapshots([url])).get(url)!, zero, true).events, [])
})

test('required and unknown-requirement cancellations remain actionable', async () => {
  fixture({ nodes: [completed('Required tests', 'CANCELLED', true), completed('Unknown requirement', 'CANCELLED'), completed('Optional', 'CANCELLED', false)] })
  const p = await prState(url, 0)
  assert.equal(p.checks, 'failing')
  assert.deepEqual(p.failing, ['Required tests (cancelled, required)', 'Unknown requirement (cancelled, requirement unknown)'])
  assert.deepEqual(p.optionalCancelled, ['Optional'])
  assert.deepEqual(diffPr(before, p, p).map(x => x[0]), ['ci_red'])
  assert.equal(detect((await snapshots([url])).get(url)!, zero, true).events.length, 1)
})

test('optional cancellations do not hide true failures or genuine pending checks', async () => {
  fixture({ nodes: [completed('Optional', 'CANCELLED', false), completed('Unit tests', 'FAILURE', false),
    completed('Timeout', 'TIMED_OUT', true), { name: 'Still running', status: 'IN_PROGRESS', conclusion: null },
    { context: 'External pending', state: 'PENDING' },
  ] })
  const p = await prState(url, 0)
  assert.equal(p.checks, 'failing')
  assert.deepEqual(p.failing, ['Unit tests', 'Timeout'])
  assert.deepEqual(p.pending, ['Still running', 'External pending'])
  assert.deepEqual(diffPr(before, p, p).map(x => x[0]), ['ci_red'])
})

const queries = () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(q => JSON.parse(q) as string)

test('a settled rollup reads its second page of checks once, not on every read', async () => {
  fixture()
  await prState(url, 0); await prState(url, 0)
  await snapshots([url])
  assert.equal(queries().filter(q => q.includes('after:')).length, 2, 'two pages beyond the first, read once')
})

test('a running rollup is never served from the check cache', async () => {
  fixture({ rollup: 'PENDING' })
  await prState(url, 0); await prState(url, 0)
  assert.equal(queries().filter(q => q.includes('after:')).length, 4)
})

test('a red rollup with checks still running is not cached', async () => {
  fixture({ nodes: [...Array.from({ length: 100 }, (_, i) => completed(`check-${i}`)), completed('Unit', 'FAILURE'), { name: 'slow', status: 'IN_PROGRESS', conclusion: null }] })
  await prState(url, 0); await prState(url, 0)
  assert.equal(queries().filter(q => q.includes('after:')).length, 2)
})

test('the shepherd re-reads a PR in full only when its fingerprint moves', async () => {
  fixture()
  const t = Date.now()
  const first = await changedSnapshots([url], t)
  assert.deepEqual(first.get(url)!.failing, failing)
  writeFileSync(calls, '')
  const again = await changedSnapshots([url], t + 60_000)
  assert.deepEqual(again.get(url)!.failing, failing, 'unchanged PR served from the last read')
  const q = queries()
  assert.equal(q.length, 1, 'one fingerprint call, no full read')
  assert.doesNotMatch(q[0], /reviewThreads/)
  writeFileSync(calls, '')
  await changedSnapshots([url], t + 40 * 60_000)
  assert.ok(queries().some(x => x.includes('reviewThreads')), 'a full read once FULL_READ_MS has passed')
})

test('watches and the board read many PRs in one call', async () => {
  fixture({ singlePage: true })
  const other = url.replace('135915', '135916')
  const m = await prStates([url, other], 0)
  assert.equal((m.get(url) as any).title, 'retry')
  assert.ok(m.get(other) instanceof Object)
  assert.equal(queries().length, 1)
})

test('PR pills asking at once share one light call, and an hour-old answer is reused', async () => {
  fixture({ singlePage: true })
  const other = url.replace('135915', '135916')
  const [a, b] = await Promise.all([prBrief(url), prBrief(other)])
  assert.equal(a.title, 'retry'); assert.equal(a.author, 'author'); assert.equal(b.state, 'open')
  await prBrief(url)
  const q = queries()
  assert.equal(q.length, 1)
  assert.doesNotMatch(q[0], /statusCheckRollup/)
})

test('a PR pill falls back to perch\'s own index when GitHub refuses', async () => {
  fixture({ singlePage: true })
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}\nconsole.error('gh: API rate limit already exceeded for user ID 1.'); process.exit(1)\n`)
  const b = await prBrief(url.replace('135915', '135999'), () => ({ title: 'from the index', state: 'OPEN', draft: 1 }))
  assert.equal(b.title, 'from the index'); assert.equal(b.state, 'draft')
  const { clearGhRateLimits } = await import('./gh.ts'); clearGhRateLimits()
})

test('a PR with CI running is re-read every few minutes, not every tick', async () => {
  fixture({ rollup: 'PENDING' })
  const t = Date.now()
  await changedSnapshots([url], t)
  writeFileSync(calls, '')
  await changedSnapshots([url], t + 60_000)
  assert.equal(queries().length, 1, 'fingerprint only')
  writeFileSync(calls, '')
  await changedSnapshots([url], t + 6 * 60_000)
  assert.ok(queries().some(x => x.includes('reviewThreads')))
})
