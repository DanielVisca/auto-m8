import assert from 'node:assert/strict'
import { test } from 'node:test'
import { all, db, run } from './db.ts'
import { autoresearchReading, linkWorkstream, projectStatus, projectText, recordReading, setProject, setWorkstreams } from './projects.ts'

// The inbox is created by orchestra.ts; a gate opening writes to it.
db.exec('create table if not exists inbox (id integer primary key autoincrement, owner text, at integer, target text, event text, text text, delivered_at integer)')

test('a plan has workstreams with north stars, gates, readings and progress', () => {
  run(`insert into conversations (id, source, started_at, updated_at) values ('plan-c', 'claude', 1, 1)`)
  setProject('plan-c', { goal: 'APM dashboards', done_when: '50 tiles @10s' })
  setWorkstreams('plan-c', [
    { key: 'DDIA review', name: 'Design review' },
    { key: 'ws1', name: 'Execution path', north_star: '0 rejected queries', metric: 'rejected', direction: 'minimize', target: 0, after: ['ddia-review'] },
    { key: 'ws3', name: 'Correctness', metric: 'match', unit: '%', baseline: 60, target: 95 },
  ])
  let s = projectStatus('plan-c')!
  assert.deepEqual(s.workstreams.map((w: any) => w.key), ['ddia-review', 'ws1', 'ws3'])
  const ws1 = () => projectStatus('plan-c')!.workstreams.find((w: any) => w.key === 'ws1')!
  assert.equal(ws1().gate, 'blocked')
  assert.deepEqual(ws1().waiting_on, ['ddia-review'])

  // The first reading becomes the baseline; progress uses the best value toward the target.
  recordReading('plan-c', 'ws1', 40, 'harness', 'baseline on master')
  recordReading('plan-c', 'ws1', 10, 'harness')
  recordReading('plan-c', 'ws1', 20, 'harness')
  assert.equal(ws1().baseline, 40)
  assert.equal(ws1().current, 20)
  assert.equal(ws1().best, 10)
  assert.equal(ws1().progress, 0.75)
  assert.equal(ws1().met, false)

  // Finishing the gate opens it and wakes the driving conversation.
  setWorkstreams('plan-c', [{ key: 'ddia-review', status: 'done' }])
  assert.equal(ws1().gate, 'open')
  const ev = all<any>(`select * from inbox where owner = 'plan-c' and event = 'gate_open'`)
  assert.equal(ev.length, 1)
  assert.match(ev[0].text, /ws1/)

  assert.throws(() => recordReading('plan-c', 'nope', 1), /No workstream/)
  assert.match(projectText('plan-c'), /ws1: Execution path \| active/)
})

test('a linked autoresearch run feeds its workstream; links show the agents and PRs', () => {
  run(`insert into conversations (id, source, title, started_at, updated_at) values ('plan-d', 'claude', 'driver', 1, 1)`)
  run(`insert into conversations (id, source, title, started_at, updated_at) values ('ar-run', 'claude', 'autoresearch: refresh', 1, 1)`)
  setProject('plan-d', { goal: 'Faster' })
  setWorkstreams('plan-d', [{ key: 'ws2', name: 'Load', metric: 'p95', unit: 'ms', direction: 'minimize', target: 3000 }])
  linkWorkstream('plan-d', 'ws2', 'autoresearch', 'perch://ar-run')
  linkWorkstream('plan-d', 'ws2', 'pr', 'https://github.com/PostHog/posthog/pull/1')
  autoresearchReading('ar-run', 9000, 'baseline')
  autoresearchReading('ar-run', 2500, 'batched tile execution')
  autoresearchReading('someone-else', 1, 'not linked')
  // A PR the linked run opened lands under the workstream by itself.
  run(`insert into conversation_prs (conversation_id, url, created) values ('ar-run', 'https://github.com/PostHog/posthog/pull/2', 1)`)
  const w = projectStatus('plan-d')!.workstreams[0]
  assert.equal(w.readings.length, 2)
  assert.equal(w.baseline, 9000)
  assert.equal(w.met, true)
  assert.equal(w.progress, 1)
  assert.deepEqual(w.agents.map((a: any) => [a.kind, a.id, a.name]), [['autoresearch', 'ar-run', 'autoresearch: refresh']])
  assert.deepEqual(w.prs.map((x: any) => x.url), ['https://github.com/PostHog/posthog/pull/1', 'https://github.com/PostHog/posthog/pull/2'])
  assert.equal(w.prs[0].phase, 'in review')
  assert.ok(projectStatus('plan-d')!.prs.some((p: any) => p.url.endsWith('/pull/1')))
  assert.ok(projectStatus('plan-d')!.prs.some((p: any) => p.url.endsWith('/pull/2')))
})

test('a project gets one plan board with a plan tile, shown beside its chat and reused', async () => {
  const { ensurePlanBoard, chatBoard } = await import('./boards.ts')
  const { tiles } = await import('./canvas.ts')
  run(`insert into conversations (id, source, started_at, updated_at) values ('plan-e', 'claude', 1, 1)`)
  setProject('plan-e', { goal: 'Ship the thing: in detail' })
  const a = ensurePlanBoard('plan-e')
  const b = ensurePlanBoard('plan-e')
  assert.equal(a, b)
  const ts = tiles(a)
  assert.equal(ts.length, 1)
  assert.equal(ts[0].kind, 'plan')
  assert.equal(ts[0].config.conversation_id, 'plan-e')
  assert.deepEqual({ ...chatBoard('plan-e') }, { board_id: a, layout: 'side' })
  assert.throws(() => ensurePlanBoard('no-project'), /no project/)
})
