import test from 'node:test'
import assert from 'node:assert/strict'
import { BACKOFF_MS, setDriveSettings, deps, drive, driveLog, driveState, MAX_BACKOFFS, MAX_RESUMES, parseVerdict, PER_HOUR, prompt, QUIET_MS, setSelfDrive, stallIn, sweep, WAIT_RECHECK_MS, type Verdict } from './selfdrive.ts'
import { get, run } from './db.ts'
import type { Item } from './transcript.ts'

const asked: Item[] = [
  { kind: 'user', text: 'add a self drive button' },
  { kind: 'assistant', blocks: [{ type: 'text', text: 'Plan is ready. Say go and I\'ll build it.' }] },
]
let verdict: Verdict | null = null
const sent: [string, string][] = []
const notices: string[] = []
deps.judge = async () => verdict
deps.send = (id, p) => { sent.push([id, p]) }
deps.notice = (_id, t) => { notices.push(t) }
let transcript: Item[] = asked
deps.transcript = () => transcript
let clock = Date.now()
deps.now = () => clock
let updated = 0
deps.updatedAt = () => updated
deps.running = () => true // keep setSelfDrive from scheduling a background drive; flipped per test
deps.paused = () => false

const fresh = (id: string) => { deps.running = () => true; setSelfDrive(id, true); deps.running = () => false; sent.length = 0; notices.length = 0; transcript = asked; clock += 86400_000 }

test('off: never drives', async () => {
  verdict = { action: 'reply', message: 'go' }
  assert.equal(await drive('off-chat'), null)
  assert.equal(sent.length, 0)
})

test('a stop-short turn gets the owner\'s reply, logged and counted', async () => {
  fresh('c1')
  verdict = { action: 'reply', message: 'Go. Build it in a worktree.', reason: 'agent offered to build' }
  await drive('c1')
  assert.deepEqual(sent, [['c1', 'Go. Build it in a worktree.']])
  assert.equal(driveState('c1').replies, 1)
  assert.equal(driveLog('c1')[0].action, 'reply')
})

test('the same reply is sent twice, the third time hands the chat back', async () => {
  fresh('c2')
  verdict = { action: 'reply', message: 'Carry on.' }
  await drive('c2'); clock += 1000; await drive('c2'); clock += 1000; await drive('c2')
  assert.equal(sent.length, 2)
  assert.equal(driveState('c2').status, 'needs_you')
  assert.ok(get<any>(`select 1 from needs where source_key = 'selfdrive:c2'`))
})

test('needs_you goes to Needs me and sends nothing', async () => {
  fresh('c3')
  verdict = { action: 'needs_you', reason: 'Approve the production table drop' }
  await drive('c3')
  assert.equal(sent.length, 0)
  assert.equal(driveState('c3').status, 'needs_you')
  assert.match(notices[0], /needs you/)
})

test('done turns self drive off', async () => {
  fresh('c4')
  verdict = { action: 'done', reason: 'PR opened and handed to the shepherd' }
  await drive('c4')
  assert.equal(driveState('c4').on, false)
  assert.equal(sent.length, 0)
})

test('a burst backs off and carries on; only repeated bursts hand back', async () => {
  fresh('c5')
  let judged = 0
  deps.judge = async () => { judged++; return { action: 'reply', message: `step ${judged}` } }
  const burst = () => { for (let i = 0; i < PER_HOUR; i++) run(`insert into self_drive_log (conversation_id, at, action) values ('c5', ?, 'reply')`, clock) }
  burst()
  await drive('c5')
  assert.equal(judged, 0)
  assert.equal(driveState('c5').status, 'backoff')
  assert.equal(await drive('c5'), null, 'still cooling off')
  clock += BACKOFF_MS + 3600_000
  await drive('c5')
  assert.equal(judged, 1, 'carries on after the backoff')
  for (let k = 1; k < MAX_BACKOFFS; k++) { burst(); await drive('c5'); clock += BACKOFF_MS + 1000 }
  burst()
  await drive('c5')
  deps.judge = async () => verdict
  assert.equal(driveState('c5').status, 'needs_you')
})

test('a stall is resumed without asking the driver, until it keeps stalling', async () => {
  fresh('c7')
  let judged = false
  deps.judge = async () => { judged = true; return null }
  transcript = [...asked, { kind: 'assistant', blocks: [{ type: 'tool', id: 't', name: 'Bash', input: {} }] }]
  await drive('c7')
  assert.equal(judged, false)
  assert.equal(sent.length, 1)
  assert.match(sent[0][1], /stalled \(it stopped mid tool call\)/)
  for (let i = 1; i < MAX_RESUMES; i++) { clock += 1000; await drive('c7') }
  assert.equal(sent.length, MAX_RESUMES)
  clock += 1000; await drive('c7')
  assert.equal(sent.length, MAX_RESUMES)
  assert.equal(driveState('c7').status, 'needs_you')
  deps.judge = async () => verdict
})

test('an error event counts as a stall', async () => {
  fresh('c8')
  await drive('c8', 'it stopped with an error: overloaded')
  assert.match(sent[0][1], /overloaded/)
})

test('a clean turn end is judged, never mistaken for a stall', async () => {
  fresh('c10')
  transcript = [...asked, { kind: 'user', text: 'go' }] // the transcript hasn't caught up with the result yet
  let judged = false
  deps.judge = async () => { judged = true; return { action: 'wait', reason: 'x' } }
  await drive('c10', null, true)
  deps.judge = async () => verdict
  assert.equal(judged, true)
  assert.equal(sent.length, 0)
})

test('stallIn', () => {
  assert.equal(stallIn(asked), null)
  assert.match(stallIn([{ kind: 'user', text: 'go' }])!, /never answered/)
  assert.match(stallIn([{ kind: 'assistant', blocks: [{ type: 'text', text: 'API Error: 529 overloaded' }] }])!, /API error/)
  assert.match(stallIn([{ kind: 'assistant', blocks: [{ type: 'tool', id: 't', name: 'Bash', input: {}, result: 'ok' }] }])!, /after a tool result/)
})

test('sweep picks up missed turns, stale waits and failed answers', async () => {
  fresh('c9')
  verdict = { action: 'wait', reason: 'CI running' }
  updated = clock - QUIET_MS - 1 // the chat moved and nobody looked
  assert.ok(sweep().includes('c9'))
  await new Promise(r => setImmediate(r))
  assert.equal(driveLog('c9')[0].action, 'wait')
  assert.ok(!sweep().includes('c9'), 'just decided to wait')
  clock += WAIT_RECHECK_MS
  assert.ok(sweep().includes('c9'), 'waited long enough: look again')
  await new Promise(r => setImmediate(r))
  verdict = null
  clock += WAIT_RECHECK_MS
  sweep(); await new Promise(r => setImmediate(r))
  assert.equal(driveLog('c9')[0].action, 'error')
  clock += 5 * 60_000
  assert.ok(sweep().includes('c9'), 'retries a failed answer')
  await new Promise(r => setImmediate(r))
})

test('a running chat or a pause is left alone', async () => {
  fresh('c6')
  deps.running = () => true
  verdict = { action: 'reply', message: 'go' }
  assert.equal(await drive('c6'), null)
  deps.running = () => false
  deps.paused = () => true
  assert.equal(await drive('c6'), null)
  deps.paused = () => false
  assert.equal(sent.length, 0)
})

test('verdict parsing and prompt', () => {
  assert.deepEqual(parseVerdict('sure: {"action":"reply","message":"go","reason":"r"}'), { action: 'reply', message: 'go', reason: 'r' })
  assert.equal(parseVerdict('{"action":"merge it"}'), null)
  assert.equal(parseVerdict('nope'), null)
  const p = prompt('c1', asked)
  assert.match(p, /Say go and I'll build it/)
  assert.match(p, /needs_you/)
})

test('per-chat settings reach the driver and are clamped', async () => {
  fresh('c11')
  const st = setDriveSettings('c11', { mode: 'careful', perHour: 0, recheckMin: 99999, model: 'opus', instructions: 'Merge when green.', budgetHour: null })
  assert.deepEqual(st.settings, { mode: 'careful', perHour: 1, recheckMin: 1440, model: 'opus', instructions: 'Merge when green.', budgetHour: null })
  let seen: { p: string; m?: string | null } | null = null
  deps.judge = async (p, m) => { seen = { p, m }; return { action: 'reply', message: 'go' } }
  await drive('c11')
  assert.equal(seen!.m, 'opus')
  assert.match(seen!.p, /careful/)
  assert.match(seen!.p, /Merge when green\./)
  clock += 1000
  await drive('c11') // perHour 1: the second message in the hour cools off
  deps.judge = async () => verdict
  assert.equal(driveState('c11').status, 'backoff')
})

test('an hourly budget pauses (never hands back) and counts the driver too', async () => {
  fresh('c12')
  setDriveSettings('c12', { budgetHour: 2 })
  deps.judge = async () => ({ action: 'reply', message: 'next step', cost: 1.5 })
  await drive('c12')
  assert.equal(sent.length, 1)
  assert.equal(driveState('c12').spentHour, 1.5)
  run(`insert into self_drive_log (conversation_id, at, action, cost) values ('c12', ?, 'reply', 1)`, clock)
  clock += 1000
  await drive('c12')
  deps.judge = async () => verdict
  assert.equal(sent.length, 1, 'over budget: nothing sent')
  assert.equal(driveState('c12').status, 'budget')
  assert.equal(driveState('c12').on, true)
  assert.equal(setDriveSettings('c12', { budgetHour: null }).settings.budgetHour, null)
})
