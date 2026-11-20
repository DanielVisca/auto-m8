import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { toStop, strained, MAX_IDLE } from './reaper.ts'
import { KIND_IDLE_MS, kindProtected, pendingWork, protectedKind } from './protection.ts'

const MIN = 60_000, GB = 1024 ** 3
const calm = { availBytes: 20 * GB, load1: 4, cores: 15 }
const p = (id: string, mins: number, watched = false) => ({ id, idleMs: mins * MIN, watched })
const ids = (r: { id: string }[]) => r.map(x => x.id).sort()

test('stops what has been idle past the limit, never a watched chat', () => {
  assert.deepEqual(ids(toStop([p('a', 25), p('b', 5), p('c', 40, true)], { limitMs: 20 * MIN, machine: calm })), ['a'])
})

test('caps idle processes: least recently used go first, the recent ones stay', () => {
  const list = Array.from({ length: 30 }, (_, i) => p(`c${i}`, 3 + i)) // all past the 2-min grace, none past the limit
  const r = toStop(list, { limitMs: 60 * MIN, machine: calm })
  assert.equal(r.length, 30 - MAX_IDLE)
  assert.ok(r.every(x => Number(x.id.slice(1)) >= MAX_IDLE), 'the oldest are stopped')
})

test('the cap leaves just-finished chats alone', () => {
  const list = Array.from({ length: 20 }, (_, i) => p(`n${i}`, 1))
  assert.deepEqual(toStop(list, { limitMs: 20 * MIN, machine: calm }), [])
})

test('under memory pressure, anything idle past the grace stops', () => {
  const tight = { availBytes: 1 * GB, load1: 4, cores: 15 }
  assert.ok(strained(tight) && strained({ availBytes: 20 * GB, load1: 40, cores: 15 }) && !strained(calm) && !strained(null))
  assert.deepEqual(ids(toStop([p('a', 3), p('b', 1), p('c', 3, true)], { limitMs: 20 * MIN, machine: tight })), ['a'])
})

// 2026-11-17: reattach set the idle clock to now, and perch restarts every 20-60 min, so the reaper
// never fired. The clock must come from when the agent last wrote, not from the restart.
test('reattach keeps the idle clock instead of resetting it to now', () => {
  const src = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('export function reattachChats'), src.indexOf('export { QUEUED }'))
  assert.match(body, /statSync\(files\(m\.id\)\.out\)\.mtimeMs/)
  assert.doesNotMatch(body.slice(body.indexOf('for (const name of readdirSync(RUN)')), /lastUsed: Date\.now\(\)/)
  assert.match(src, /c\.lastOutput = Math\.max\(c\.lastOutput, Math\.min\(Date\.now\(\), st\.mtimeMs\)\)/, 'replayed output is not new activity')
})

// Restore points used 'read-tree HEAD' into a fresh index, so 'add -A' re-hashed every file: 21s a
// turn in the posthog repo. They must start from a copy of the repo's own index.
test('restore points seed their index from the repo index', () => {
  const src = readFileSync(new URL('./branch.ts', import.meta.url), 'utf8')
  assert.match(src, /copyFileSync\(own, env\.GIT_INDEX_FILE\)/)
  assert.match(src, /if \(head && !copied\) await git\(cwd, \['read-tree', 'HEAD'\]/)
})

const prot = (id: string, mins: number, why = 'wakeup scheduled') => ({ id, idleMs: mins * MIN, watched: false, protectedWhy: why })

test('protected agents are never stopped by any rule, and do not count toward the cap', () => {
  const tight = { availBytes: 1 * GB, load1: 40, cores: 15 }
  assert.deepEqual(toStop([prot('scout', 90), p('a', 25)], { limitMs: 20 * MIN, machine: tight }).map(x => x.id), ['a'])
  const list = [...Array.from({ length: 12 }, (_, i) => prot(`s${i}`, 30)), ...Array.from({ length: MAX_IDLE }, (_, i) => p(`c${i}`, 5))]
  assert.deepEqual(toStop(list, { limitMs: 60 * MIN, machine: calm }), [], '12 protected + 8 ordinary idle agents: nothing over the cap')
})

const line = (name: string, input: any, at: number) => JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { content: [{ type: 'tool_use', name, input }] } })

test('pendingWork finds a scheduled wakeup, a cron job and a recent background job', () => {
  const now = Date.now()
  assert.equal(pendingWork(line('ScheduleWakeup', { delaySeconds: 1200 }, now - 5 * MIN), now), 'wakeup scheduled')
  assert.equal(pendingWork(line('ScheduleWakeup', { delaySeconds: 1200 }, now - 40 * MIN), now), null, 'a wakeup that already fired')
  assert.equal(pendingWork(line('CronCreate', { cron: '*/5 * * * *' }, now - 5 * 60 * MIN), now), 'cron job')
  assert.equal(pendingWork([line('CronCreate', {}, now - 9 * MIN), line('CronDelete', {}, now - 8 * MIN)].join('\n'), now), null)
  assert.equal(pendingWork(line('Bash', { command: 'sleep 99', run_in_background: true }, now - 10 * MIN), now), 'background job')
  assert.equal(pendingWork(line('Monitor', {}, now - 3 * 60 * MIN), now), null, 'old background jobs stop protecting after an hour')
  assert.equal(pendingWork('{"cut off\n' + line('Read', {}, now), now), null, 'a cut first line and unrelated tools are ignored')
})

test('scouts, routines and shepherds are protected; helpers and searches are not', () => {
  for (const k of ['shepherd', 'routine', 'autopilot', 'orchestrator', 'autoresearch', 'self-fix', 'cloud']) assert.ok(protectedKind(k), k)
  for (const k of ['helper', 'search', 'test', null, undefined]) assert.ok(!protectedKind(k), String(k))
})

test('kind protection lapses after KIND_IDLE_MS and whenever the Mac is strained', () => {
  assert.ok(kindProtected('shepherd', 5 * MIN, false))
  assert.ok(!kindProtected('shepherd', KIND_IDLE_MS + 1, false), 'an idle shepherd is resumed by its next event')
  assert.ok(!kindProtected('shepherd', 5 * MIN, true), 'memory pressure overrides kind protection')
  assert.ok(!kindProtected('helper', 5 * MIN, false))
})
