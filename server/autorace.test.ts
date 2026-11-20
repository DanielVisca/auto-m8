import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { autoConfig, autoGate, autoInsights, candidate, candidateReason, deliverRaceResults, raceCapacityError, raceInstruction, selectRace, skipCandidate, startedCandidate, validateCandidate } from './autorace.ts'
import { all, run } from './db.ts'
import { settings } from './settings.ts'
import { detail, start, startRace } from './race.ts'
import { userBody } from '../shared/messageOrigin.ts'
import { userText } from './transcript.ts'

const task = 'Fix the intermittent duplicate deliveries in the queue worker. Make retries idempotent and add regression tests for ordering and cancellation.'
const select = (conversation = 'chat', prompt = task, extra: any = {}, now = Date.now()) => selectRace({ conversation, prompt, by: 'you', ...extra }, now)
beforeEach(() => {
  run('delete from race_candidates'); run('delete from race_runs'); run('delete from race_entries'); run('delete from race_reviews')
  settings.autonomy.enabled = true
  ;(settings as any).raceAuto = { enabled: true, perDay: 2, cooldownHours: 6, models: ['fixture-a', 'fixture-b'] }
})

test('selects difficult, checkable coding work; ordinary requests stay single-agent', () => {
  for (const p of [task, 'Optimize the slow API query in our repository and benchmark latency before and after.', 'Refactor the parser module to support escaped delimiters and test malformed input.']) assert.ok(candidateReason(p), p)
  for (const p of ['Fix the typo in the server error message.', 'How does the queue worker retry API work and why is it slow?', 'Urgent: fix the intermittent duplicate delivery in the queue worker.', 'Fix the queue worker retries without a model race. Add regression tests.', "Don't race this: fix the duplicate API deliveries and test them.", 'What is the status of the refactor to fix our slow parser?', 'Build a report about our API performance and send it to Slack.', 'continue', 'race this task across models: fix the slow API query and add tests.']) assert.equal(candidateReason(p), null, p)
})

test('excludes automation, retries, plan-only work and busy chats', () => {
  for (const extra of [{ by: 'routine' }, { by: 'helper' }, { by: undefined }, { retry: true }, { resent: true }, { profile: true }, { busy: true }, { mode: 'plan' }]) assert.equal(select(JSON.stringify(extra), task, extra), null)
  assert.equal(all<any>("select * from race_candidates where status = 'selected'").length, 0)
})

test('autonomy and feature off switches take effect without restart', () => {
  settings.autonomy.enabled = false
  assert.equal(select(), null)
  settings.autonomy.enabled = true
  ;(settings as any).raceAuto.enabled = false
  assert.equal(select('other'), null)
  assert.equal(autoInsights().enabled, false)
})

test('automatic races conserve either subscription, even when credits remain, and reopen at reset', () => {
  ;(settings as any).raceAuto.models = ['claude-opus-5-5', 'codex:gpt-6-astra']
  const now = Date.now()
  const u = { at: now, creditsAvailable: true, windows: [{ key: 'm10080', label: 'week', pct: 1, resetsAt: now + 1000 }] }
  assert.match(autoGate(now, undefined, { claude: null, codex: u })!, /OpenAI.*100%/)
  assert.equal(autoGate(now + 1000, undefined, { claude: null, codex: u }), null)
  const claude = { ...u, windows: [{ ...u.windows[0], key: 'seven_day', pct: 0.8 }] }
  assert.match(autoGate(now, undefined, { claude, codex: null })!, /Claude.*80%/)
  assert.equal(autoGate(now, undefined, { claude: null, codex: null }), null)
})

test('reservations, per-day cap, ownership, expiry and deduplication', () => {
  const a = select('a')!, b = select('b')!
  assert.ok(a); assert.ok(b)
  assert.equal(select('a'), null)
  assert.equal(candidate(a.id)?.status, 'selected', 'duplicate delivery must not cancel the reservation')
  assert.equal(select('c'), null)
  assert.match(autoGate()!, /limit/)
  assert.equal(validateCandidate(a.id, 'a'), null, 'own reservation does not count twice')
  assert.match(validateCandidate(a.id, 'intruder')!, /No automatic/)
  assert.match(validateCandidate(a.id, 'a', a.created_at + 3_600_001)!, /expired/)
  assert.ok(skipCandidate(a.id, 'intruder', 'no').error)
  assert.ok(skipCandidate(a.id, 'a', 'Needs external research').ok)
  assert.ok(select('d'), 'skips release reservations')
})

test('learning defaults admit 24 daily races and release capacity at the rolling boundary', () => {
  ;(settings as any).raceAuto = { models: ['fixture-a', 'fixture-b'] }
  const now = Date.now()
  assert.equal(autoConfig().perDay, 24)
  assert.equal(autoConfig().maxConcurrent, 2)
  assert.equal(autoConfig().cooldownHours, 0.5)
  for (let i = 0; i < 24; i++) {
    const c = select(`chat-${i}`, task, {}, now)!
    assert.ok(c, `race ${i + 1} should be admitted`)
    startedCandidate(c.id, `run-${i}`)
    run('update race_candidates set started_at = ? where id = ?', now - 24 * 3_600_000 + 1, c.id)
  }
  assert.equal(select('over-limit', task, {}, now), null)
  assert.match(autoGate(now)!, /24 per 24 hours/)
  assert.ok(select('next-day', task, {}, now + 2))
})

test('shorter cooldown allows another task after 30 minutes but never overlaps a chat', () => {
  ;(settings as any).raceAuto = { models: ['fixture-a', 'fixture-b'] }
  const now = Date.now(), c = select('chat', task, {}, now)!
  startedCandidate(c.id, 'run')
  assert.equal(select('chat', task + ' Cover jitter too.', {}, now + 29 * 60_000), null)
  run("insert into race_runs (id, task, requester) values ('run', ?, 'chat')", task)
  assert.equal(select('chat', task + ' Cover timeouts too.', {}, now + 31 * 60_000), null)
  assert.equal(autoGate(now + 31 * 60_000), null, 'another chat can use the second slot')
  run("update race_runs set status = 'done' where id = 'run'")
  assert.ok(select('chat', task + ' Cover cancellation too.', {}, now + 31 * 60_000))
})

test('manual races share concurrency and worktree capacity with automatic races', () => {
  run("insert into race_runs (id, task) values ('manual', ?)", task)
  for (let i = 0; i < 5; i++) run('insert into race_entries (id, run_id, model) values (?, ?, ?)', `entry-${i}`, 'manual', `model-${i}`)
  assert.match(raceCapacityError()!, /worktree limit/)
  run("delete from race_entries where id = 'entry-4'")
  assert.equal(raceCapacityError(), null)
  run("insert into race_runs (id, task) values ('second', ?)", task)
  assert.match(autoGate()!, /2 at a time/)
  run("update race_runs set status = 'done' where id = 'manual'")
  assert.equal(autoGate(), null)
})

test('changed user instructions cancel an unstarted race; launched races impose cooldown', () => {
  const a = select()!
  assert.equal(select('chat', 'Stop; do not race this.'), null)
  assert.equal(candidate(a.id)?.status, 'skipped')
  assert.match(validateCandidate(a.id, 'chat')!, /already skipped/)
  const b = select('second')!
  startedCandidate(b.id, 'example')
  assert.equal(select('second', task + ' Also cover jitter.'), null)
  assert.equal(autoInsights().recent.find((c: any) => c.prompt.endsWith('jitter.'))?.outcome, 'Conversation race cooldown.')
})

test('instructions reach the agent while user bubbles and saved history show only the ask', () => {
  const c = select()!, prompt = task + raceInstruction(c)
  assert.match(prompt, new RegExp(c.id))
  assert.match(prompt, /action=start/)
  assert.equal(userBody(prompt), task)
  assert.equal(userText(prompt), task)
})

test('result outbox resumes once, retries delivery errors and distinguishes failed verification', () => {
  const c = select()!
  startedCandidate(c.id, 'done')
  run("insert into race_runs (id, task, status, top, final_branch, final_verify) values ('done', ?, 'done', '/repo', 'race/done/final', ?)", task, JSON.stringify({ ok: false, output: 'regression failed' }))
  deliverRaceResults(() => { throw new Error('transient send failure') })
  assert.equal(candidate(c.id)?.status, 'started')
  const messages: string[] = []
  deliverRaceResults((id, msg) => { assert.equal(id, 'chat'); messages.push(msg) })
  deliverRaceResults((_id, msg) => messages.push(msg))
  assert.equal(messages.length, 1)
  assert.match(messages[0], /needs recovery/)
  assert.match(messages[0], /regression failed/)
  assert.match(messages[0], /canceled or superseded/)
})

test('automatic launch requires a scoped check and refuses a dirty checkout', async () => {
  ;(settings as any).raceAuto.models = ['fixture-a', 'fixture-b']
  const c = select()!
  assert.match((await start({ task, cwd: '/missing', requester: 'chat', autoCandidate: c.id })).error!, /verify command/)
  const cwd = mkdtempSync(join(tmpdir(), 'perch-auto-dirty-'))
  execFileSync('git', ['init', '-q', cwd])
  writeFileSync(join(cwd, 'important.txt'), 'uncommitted user work')
  const out = await start({ task, cwd, requester: 'chat', autoCandidate: c.id, verify: 'true' })
  assert.match(out.error!, /uncommitted work/)
  assert.equal(candidate(c.id)?.status, 'skipped')
  assert.equal(all('select * from race_runs').length, 0)
})

test('two simultaneous races run through worktrees, reviews and return to their own chats', { timeout: 45_000 }, async () => {
  // Fixture CLIs exercise the complete orchestration without buying model calls or editing a real repo.
  const root = mkdtempSync(join(tmpdir(), 'perch-auto-e2e-')), cwd = join(root, 'repo'), bin = join(root, 'claude')
  execFileSync('git', ['init', '-q', cwd])
  writeFileSync(join(cwd, 'answer.txt'), 'before')
  execFileSync('git', ['-C', cwd, 'add', '.'])
  execFileSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--no-verify', '-qm', 'base'])
  writeFileSync(bin, `#!${process.execPath}\nconst fs = require('node:fs');\nconst prompt = process.argv[process.argv.indexOf('-p') + 1];\nlet result = 'implemented';\nif (prompt.startsWith('You are reviewing')) result = JSON.stringify({score:90,sufficient:true,issues:[],strengths:['focused'],vs_mine:'comparable'});\nelse if (prompt.startsWith('You ran in a race')) result = JSON.stringify({winner:'fixture-a',summary:'Combined tested fix',models:{'fixture-a':{sufficient:true},'fixture-b':{sufficient:true}},adjudication:[]});\nelse fs.writeFileSync('answer.txt','after');\nconsole.log(JSON.stringify({type:'result',result,usage:{input_tokens:1,output_tokens:1}}));\n`, { mode: 0o755 })
  const oldPath = process.env.PATH
  process.env.PATH = root + ':' + oldPath
  ;(settings as any).raceAuto.models = ['fixture-a', 'fixture-b']
  const c = select()!, second = select('second')!, messages: { id: string; message: string }[] = []
  startRace(() => {}, (id, message) => messages.push({ id, message }))
  try {
    const input = { task, cwd, requester: 'chat', picked: 'fixture-a', autoCandidate: c.id, verify: `${JSON.stringify(process.execPath)} -e 'if(require("fs").readFileSync("answer.txt","utf8")!=="after")process.exit(1)'` }
    const [out, duplicate, parallel] = await Promise.all([start({ ...input, autoCandidate: undefined }), start(input), start({ ...input, requester: 'second', autoCandidate: second.id })])
    assert.ok(out.runId, out.error ?? 'Race did not start')
    assert.equal(duplicate.runId, out.runId, 'simultaneous duplicate returns the same race')
    assert.ok(parallel.runId, parallel.error ?? 'Second race did not start')
    assert.notEqual(parallel.runId, out.runId)
    assert.equal(all("select * from race_runs where status = 'running'").length, 2)
    assert.match((await start({ ...input, requester: 'third', autoCandidate: undefined, models: ['fixture-a', 'fixture-b'] })).error!, /concurrency limit/)
    assert.equal((await start(input)).runId, out.runId, 'repeated launch returns the same race')
    while (all("select * from race_runs where status = 'running'").length) await new Promise(r => setTimeout(r, 100))
    assert.equal(messages.length, 2)
    for (const [selected, launched] of [[c, out], [second, parallel]] as const) {
      const result = detail(launched.runId!)!
      assert.equal(result.status, 'done', result.error)
      assert.equal(result.reviews.length, 2)
      assert.equal(result.final_verify.ok, true)
      const message = messages.find(m => m.id === selected.conversation_id)?.message
      assert.ok(message)
      assert.match(message, new RegExp(launched.runId!))
      assert.match(message, /Combined solution: race\//)
      assert.equal(candidate(selected.id)?.status, 'delivered')
      assert.equal(execFileSync('git', ['-C', cwd, 'show', `${result.final_branch}:answer.txt`], { encoding: 'utf8' }), 'after')
    }
    assert.equal(execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' }), '', 'original checkout stays untouched')
  } finally { process.env.PATH = oldPath }
})
