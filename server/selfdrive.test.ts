import test from 'node:test'
import assert from 'node:assert/strict'
import { deps, drive, driveLog, driveState, parseVerdict, PER_HOUR, prompt, setSelfDrive, type Verdict } from './selfdrive.ts'
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
deps.transcript = () => asked
deps.running = () => true // keep setSelfDrive from scheduling a background drive; flipped per test
deps.paused = () => false

const fresh = (id: string) => { setSelfDrive(id, true); deps.running = () => false; sent.length = 0; notices.length = 0 }

test('off: never drives', async () => {
  verdict = { action: 'reply', message: 'go' }
  assert.equal(await drive('off-chat'), null)
  assert.equal(sent.length, 0)
})

test('a stop-short turn gets the owner\'s reply, logged and counted', async () => {
  deps.running = () => true
  fresh('c1')
  verdict = { action: 'reply', message: 'Go. Build it in a worktree.', reason: 'agent offered to build' }
  await drive('c1')
  assert.deepEqual(sent, [['c1', 'Go. Build it in a worktree.']])
  assert.equal(driveState('c1').replies, 1)
  assert.equal(driveLog('c1')[0].action, 'reply')
})

test('the same reply twice hands the chat back instead of looping', async () => {
  deps.running = () => true
  fresh('c2')
  verdict = { action: 'reply', message: 'Carry on.' }
  await drive('c2'); await drive('c2')
  assert.equal(sent.length, 1)
  assert.equal(driveState('c2').status, 'needs_you')
  assert.ok(get<any>(`select 1 from needs where source_key = 'selfdrive:c2'`))
})

test('needs_you goes to Needs me and sends nothing', async () => {
  deps.running = () => true
  fresh('c3')
  verdict = { action: 'needs_you', reason: 'Approve the production table drop' }
  await drive('c3')
  assert.equal(sent.length, 0)
  assert.equal(driveState('c3').status, 'needs_you')
  assert.match(notices[0], /needs you/)
})

test('done turns self drive off', async () => {
  deps.running = () => true
  fresh('c4')
  verdict = { action: 'done', reason: 'PR opened and handed to the shepherd' }
  await drive('c4')
  assert.equal(driveState('c4').on, false)
  assert.equal(sent.length, 0)
})

test('hourly cap hands back without asking the driver', async () => {
  deps.running = () => true
  fresh('c5')
  for (let i = 0; i < PER_HOUR; i++) run(`insert into self_drive_log (conversation_id, at, action) values ('c5', ?, 'reply')`, Date.now())
  let judged = false
  deps.judge = async () => { judged = true; return { action: 'reply', message: 'x' } }
  await drive('c5')
  deps.judge = async () => verdict
  assert.equal(judged, false)
  assert.equal(driveState('c5').status, 'needs_you')
})

test('a running chat or a pause is left alone', async () => {
  deps.running = () => true
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
