import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { all, run } from './db.ts'
import { gitInfo, idleFromLogs, leaseFor, makeCloud, repoFromRemote, RETURN_BY, type Deps } from './cloud.ts'

run(`create table if not exists links (a text, b text, kind text, note text, created_at integer, primary key (a, b, kind))`)

function fake(over: Partial<Deps> = {}) {
  const log: any = { started: [], steered: [], resumed: [], notified: [] }
  const state = { status: 'in_progress', run: 'run-1', pr: null as string | null, error: null as string | null, idle: false }
  let away = true
  const d: Deps = {
    conversation: id => id === 'missing' ? null : { cwd: '/repo', title: 'Fix the widget', running: id === 'busy' },
    history: () => 'USER: fix the widget\nAGENT: on it',
    git: async () => ({ repository: 'PostHog/posthog', branch: 'perch/cloud/abc', sha: 'deadbeefcafe', pushed: true, untracked: ['notes.md'], note: 'snapshot' }),
    startTask: async o => { log.started.push(o); return { task: 'task-1', run: 'run-1' } },
    taskState: async () => ({ ...state }),
    taskLogs: async () => 'I pushed the fix to perch/cloud/abc.',
    steer: async (t, r, text) => { if (state.status !== 'in_progress') throw new Error('run is not active'); log.steered.push({ t, r, text }) },
    resumeLocal: (id, prompt) => log.resumed.push({ id, prompt }),
    notify: async n => { log.notified.push(n) },
    macAway: async () => away,
    ...over,
  }
  return { cloud: makeCloud(d), log, state, setAway: (a: boolean) => { away = a } }
}

test('hand-off starts a cloud task with the history and code, and takes the lease', async () => {
  const { cloud, log } = fake()
  run(`delete from cloud_leases`)
  const l = await cloud.handOff('conv-a')
  assert.equal(l.status, 'cloud')
  assert.equal(l.task_id, 'task-1')
  assert.equal(log.started[0].repository, 'PostHog/posthog')
  assert.equal(log.started[0].branch, 'perch/cloud/abc')
  assert.match(log.started[0].description, /USER: fix the widget/)
  assert.match(log.started[0].description, /notes\.md/)
  assert.equal(log.notified[0].title, 'Continuing in the cloud')
  await assert.rejects(cloud.handOff('conv-a'), /already in the cloud/)
  assert.equal(all<any>(`select * from links where a = 'conv-a' and b = 'task:task-1'`).length, 1)
})

test('refuses a conversation that is mid-turn on the Mac, unknown, or already a task', async () => {
  const { cloud } = fake()
  await assert.rejects(cloud.handOff('busy'), /mid-turn/)
  await assert.rejects(cloud.handOff('missing'), /No such/)
  await assert.rejects(cloud.handOff('task:x'), /already a cloud task/)
})

test('while the cloud owns it, messages go to the cloud run, not a local turn', async () => {
  const { cloud, log } = fake()
  run(`delete from cloud_leases`)
  await cloud.handOff('conv-b')
  assert.equal(cloud.intercept({ id: 'conv-b', prompt: 'also add a test' }), true)
  assert.equal(cloud.intercept({ id: 'other', prompt: 'x' }), false)
  assert.equal(cloud.intercept({ id: 'conv-b', prompt: 'x', by: RETURN_BY }), false) // the return itself runs locally
  await new Promise(r => setImmediate(r))
  assert.equal(log.steered[0].text, 'also add a test')
})

test('finished while away: the phone hears, the conversation waits; back at the Mac it returns with the work', async () => {
  const { cloud, log, state, setAway } = fake()
  run(`delete from cloud_leases`)
  await cloud.handOff('conv-c')
  cloud.intercept({ id: 'conv-c', prompt: 'and update the docs' })
  state.status = 'completed'; state.pr = 'https://github.com/PostHog/posthog/pull/1'
  await cloud.tick()
  assert.ok(leaseFor('conv-c'), 'still owned by the cloud while the Mac is away')
  assert.equal(log.notified.at(-1).title, 'Cloud run finished')
  assert.equal(log.resumed.length, 0)
  setAway(false)
  await cloud.tick()
  assert.equal(leaseFor('conv-c'), null)
  assert.equal(log.resumed.length, 1)
  const p = log.resumed[0].prompt
  assert.match(p, /git fetch origin perch\/cloud\/abc/)
  assert.match(p, /pull\/1/)
  assert.match(p, /I pushed the fix/)
  assert.match(p, /and update the docs/)
  await cloud.tick()
  assert.equal(log.resumed.length, 1, 'returned once')
})

test('bring back while it runs asks it to wrap up, then returns when it stops', async () => {
  const { cloud, log, state } = fake()
  run(`delete from cloud_leases`)
  await cloud.handOff('conv-d')
  const r = await cloud.bringBack('conv-d')
  assert.equal(r.returned, false)
  assert.match(log.steered.at(-1).text, /Wrap up now/)
  assert.equal(leaseFor('conv-d')?.status, 'returning')
  assert.throws(() => cloud.intercept({ id: 'conv-d', prompt: 'x' }), /coming back/)
  state.status = 'completed'
  await cloud.tick() // returns even though the Mac counts as away: you asked for it
  assert.equal(leaseFor('conv-d'), null)
  assert.equal(log.resumed.length, 1)
})

test('a message to a run that already stopped is kept for the return', async () => {
  const { cloud, log, state, setAway } = fake()
  run(`delete from cloud_leases`)
  await cloud.handOff('conv-e')
  state.status = 'completed'
  cloud.intercept({ id: 'conv-e', prompt: 'one more thing' })
  await new Promise(r => setImmediate(r))
  setAway(false)
  await cloud.tick()
  assert.match(log.resumed[0].prompt, /one more thing/)
})

test('repository names come from GitHub remotes only', () => {
  assert.equal(repoFromRemote('git@github.com:PostHog/posthog.git'), 'PostHog/posthog')
  assert.equal(repoFromRemote('https://github.com/octocat/perch'), 'octocat/perch')
  assert.equal(repoFromRemote('https://gitlab.com/x/y.git'), null)
})

test('git: uncommitted work is snapshotted to a perch/cloud branch without touching the checkout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'perch-cloud-'))
  const origin = join(dir, 'origin.git'), work = join(dir, 'work')
  const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()
  g(dir, 'init', '--bare', '-b', 'main', origin)
  g(dir, 'init', '-b', 'main', work)
  g(work, 'config', 'user.email', 't@t'); g(work, 'config', 'user.name', 't'); g(work, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(work, 'a.txt'), 'one\n'); g(work, 'add', '.'); g(work, 'commit', '-m', 'one')
  g(work, 'remote', 'add', 'origin', origin); g(work, 'push', '-q', 'origin', 'main')
  // The real remote must look like GitHub to count; point origin's URL there, push via pushurl.
  g(work, 'remote', 'set-url', 'origin', 'https://github.com/PostHog/example.git'); g(work, 'remote', 'set-url', '--push', 'origin', origin)
  g(work, 'config', `url.${origin}.insteadOf`, 'https://github.com/PostHog/example.git')

  const clean = await gitInfo(work, 'conv-clean-1234')
  assert.equal(clean.branch, 'main'); assert.equal(clean.repository, 'PostHog/example'); assert.match(clean.note, /already on that branch/)

  writeFileSync(join(work, 'a.txt'), 'two\n'); writeFileSync(join(work, 'new.txt'), 'n\n')
  const before = g(work, 'status', '--porcelain'), stashes = g(work, 'stash', 'list')
  const dirty = await gitInfo(work, 'conv-dirty-5678')
  assert.equal(dirty.branch, 'perch/cloud/conv-dir')
  assert.deepEqual(dirty.untracked, ['new.txt'])
  assert.equal(g(work, 'status', '--porcelain'), before, 'working tree untouched')
  assert.equal(g(work, 'stash', 'list'), stashes, 'stash list untouched')
  assert.equal(g(origin, 'show', `${dirty.sha}:a.txt`), 'two')
  assert.equal(g(origin, 'rev-parse', 'refs/heads/perch/cloud/conv-dir'), dirty.sha)

  const none = await gitInfo(dir, 'x')
  assert.equal(none.repository, null)
})

test('an in-progress run whose last turn completed counts as finished (PostHog keeps the session open)', async () => {
  const P = (method: string) => ({ notification: { method } })
  assert.equal(idleFromLogs([]), false)
  assert.equal(idleFromLogs([P('session/prompt'), P('session/update')]), false)
  assert.equal(idleFromLogs([P('session/prompt'), P('_posthog/turn_complete')]), true)
  assert.equal(idleFromLogs([P('session/prompt'), P('_posthog/turn_complete'), P('session/prompt')]), false, 'a steer started a new turn')
  const { cloud, log, state, setAway } = fake()
  run(`delete from cloud_leases`)
  await cloud.handOff('conv-f')
  state.idle = true
  setAway(false)
  await cloud.tick()
  assert.equal(leaseFor('conv-f'), null)
  assert.match(log.resumed[0].prompt, /last turn is complete/)
})

test('thread notes go through the live notice hook (so an open chat shows them without a reload)', async () => {
  const notes: [string, string][] = []
  const { cloud } = fake({ notice: (id, text) => notes.push([id, text]) })
  run(`delete from cloud_leases`)
  await cloud.handOff('conv-g')
  cloud.intercept({ id: 'conv-g', prompt: 'ship it' })
  assert.match(notes[0][1], /Continuing in the cloud/)
  assert.deepEqual(notes[1], ['conv-g', 'Sent to the cloud run: ship it'])
  assert.equal(all<any>(`select * from chat_notices where conversation_id = 'conv-g'`).length, 0, 'the hook, not a silent db write')
})

test('noticeLive reaches an open chat, and viewers of a chat that is not running yet', async () => {
  const { readFileSync } = await import('node:fs')
  const { stripTypeScriptTypes } = await import('node:module')
  const vm = await import('node:vm')
  const src = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('export function noticeLive'), src.indexOf('function setState'))
  const got: any[] = [], stored: any[] = [], open = { id: 'open' }
  const ctx: any = { chats: new Map([['open', open]]), waiting: new Map([['idle', new Set([(ev: any) => got.push(['idle', ev])])]]),
    emit: (c: any, ev: any) => got.push([c.id, ev]), run: (_sql: string, ...a: any[]) => stored.push(a), Date }
  vm.runInNewContext(stripTypeScriptTypes(fn.replace('export function', 'function')) + '\nthis.noticeLive = noticeLive', ctx)
  ctx.noticeLive('open', 'a'); ctx.noticeLive('idle', 'b')
  assert.deepEqual(got.map(g => [g[0], g[1].type, g[1].text]), [['open', 'perch_notice', 'a'], ['idle', 'perch_notice', 'b']])
  assert.equal(stored.length, 1, 'the not-running chat keeps it for reloads (emit stores it for the open one)')
})

test('a fallback hand-off comes home as soon as a subscription is back, carrying the new message', async () => {
  let ready = false
  const { cloud, log } = fake({ subscriptionReady: () => ready })
  run(`delete from cloud_leases`)
  await cloud.handOff('conv-f', 'fallback')
  assert.equal(cloud.intercept({ id: 'conv-f', prompt: 'continue' }), true)
  await new Promise(r => setImmediate(r))
  assert.equal(log.steered.at(-1).text, 'continue', 'still capped: the cloud run takes it')
  ready = true
  assert.equal(cloud.intercept({ id: 'conv-f', prompt: 'keep going' }), true)
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r))
  assert.match(log.steered.at(-1).text, /moved back to the Mac/)
  assert.equal(log.resumed.length, 1)
  assert.match(log.resumed[0].prompt, /keep going$/)
  assert.equal(leaseFor('conv-f'), null, 'the lease is released')
  // A hand-off you asked for stays in the cloud even when a subscription is free.
  await cloud.handOff('conv-g')
  assert.equal(cloud.intercept({ id: 'conv-g', prompt: 'x' }), true)
  assert.notEqual(leaseFor('conv-g'), null)
})
