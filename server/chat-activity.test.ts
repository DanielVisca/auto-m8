import assert from 'node:assert/strict'
import { test } from 'node:test'

const { groupMessages, workSummary } = await import(new URL('../web/src/chatActivity.ts', import.meta.url).href)
const user = (text = 'Check this') => ({ kind: 'user', text })
const text = (value: string) => ({ type: 'text', text: value })
const assistant = (...blocks: any[]) => ({ kind: 'assistant', blocks })
const tool = (extra = {}) => ({ type: 'tool', id: 't1', name: 'Bash', input: { command: 'npm test' }, result: 'passed', ...extra })
const turns = (items: any[], running = false) => groupMessages(items, running).filter((r: any) => r.kind === 'turn')

test('live updates, tools and model notices form one card, without mutating the transcript', () => {
  const items = [user(), assistant(text('Checking the implementation.')), assistant(tool()), { kind: 'notice', text: 'Switched to Codex' }, assistant(text('Tests are passing.'))]
  const original = structuredClone(items)
  const [turn] = turns(items, true)
  assert.equal(turns(items, true).length, 1)
  assert.equal(turn.running, true)
  assert.equal(turn.answer.length, 0)
  assert.equal(turn.work.length, 4)
  assert.equal(workSummary(turn.work).preview, 'Tests are passing.')
  assert.equal(workSummary(turn.work).steps, 1)
  assert.deepEqual(items, original)
})

test('completion exposes only the final reply and keeps the same card key', () => {
  const items = [user(), assistant(text('Checking.')), assistant(tool()), { ...assistant(text('Fixed it.')), uuid: 'answer-uuid' }]
  const live = turns(items, true)[0]
  const done = turns([...items, { kind: 'result', ok: true, text: '' }])[0]
  assert.equal(done.index, live.index)
  assert.equal(done.running, false)
  assert.equal(done.work.length, 2)
  assert.deepEqual(done.answer[0].item.blocks, [text('Fixed it.')])
  assert.equal(done.answer[0].item.uuid, 'answer-uuid')
  // Saved history has no result item; it must present the same reply and work.
  assert.deepEqual(turns(items)[0], done)
})

test('a plain answer needs no work card; thinking and tools stay out of the final answer', () => {
  const [plain] = turns([user(), assistant(text('Hello.'))])
  assert.equal(plain.work.length, 0)
  assert.deepEqual(plain.answer[0].item.blocks, [text('Hello.')])
  const [mixed] = turns([user(), assistant({ type: 'thinking', text: 'Inspect first.' }, text('Checking.'), tool(), text('Done.'), text('All checks passed.'))])
  assert.equal(mixed.work[0].item.blocks.length, 3)
  assert.deepEqual(mixed.answer[0].item.blocks, [text('Done.'), text('All checks passed.')])
})

test('saved Codex activity moves into work and remains available after history reload', () => {
  const item = { ...assistant(text('The fix is live.')), activity: { tools: ['$ npm test', 'perch.browser'], omitted: 3 } }
  const original = structuredClone(item)
  const [turn] = turns([user(), item])
  assert.deepEqual(turn.work[0].item.activity, item.activity)
  assert.deepEqual(turn.work[0].item.blocks, [])
  assert.equal(turn.answer[0].item.activity, undefined)
  assert.equal(workSummary(turn.work).steps, 5)
  assert.deepEqual(item, original)
})

test('only the active tail runs, including before its first update', () => {
  const rows = turns([user(), assistant(text('Done.')), { kind: 'result', ok: true, text: '' }, user('Next')], true)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].running, false)
  assert.equal(rows[1].running, true)
  assert.equal(rows[1].work.length, 0)
  assert.equal(turns([], true)[0].running, true)
  assert.equal(turns([], false).length, 0)
})

test('errors, sign-in actions and Slack drafts remain outside collapsed work', () => {
  const draft = tool({ name: 'mcp__perch__draft_slack_message', result: 'draft:abc-123' })
  const [turn] = turns([user(), assistant(text('Checking.')), assistant(draft), assistant(text('Please run /login')), { kind: 'error', text: 'Connection lost' }], true)
  assert.equal(turn.work.length, 1)
  assert.equal(turn.attention.length, 3)
  assert.deepEqual(turn.attention[0].item.blocks, [draft])
  const failed = turns([user(), assistant(text('Still checking.')), { kind: 'result', ok: false, text: 'Interrupted' }])[0]
  assert.equal(failed.answer.length, 0)
  assert.equal(failed.running, false)
  const unfinished = turns([user(), assistant(text('Checking.'), tool())])[0]
  assert.equal(unfinished.answer.length, 0)
})

test('preview is short public prose, with tool failures counted and no private thinking', () => {
  const [turn] = turns([user(), assistant(text('**Checking** [the page](https://example.com).\n\n```sh\nnpm test\n```')), assistant({ type: 'thinking', text: 'Private analysis' }, tool({ isError: true }))], true)
  assert.equal(workSummary(turn.work).preview, 'Checking the page.')
  assert.equal(workSummary(turn.work).errors, 1)
  const [long] = turns([assistant(text('Long update '.repeat(100)))], true)
  assert.ok(workSummary(long.work).preview.length <= 200)
})

const { workPulse } = await import(new URL('../web/src/chatActivity.ts', import.meta.url).href)
test('pulse: plan progress, step marks, mood and stall from the transcript', () => {
  const t0 = 1_000_000
  const todo = tool({ id: 'p', name: 'TodoWrite', input: { todos: [{ status: 'completed', content: 'a' }, { status: 'in_progress', content: 'b', activeForm: 'Doing b' }, { status: 'pending', content: 'c' }] }, result: 'ok' })
  const work = [{ item: { ...assistant(todo, tool({ id: 'x' }), tool({ id: 'y', isError: true }), tool({ id: 'z', input: { command: 'npm test' }, result: 'again' })), ts: t0 }, index: 1 }]
  const p = workPulse(work, t0 + 5_000, t0 - 60_000)
  assert.deepEqual(p.plan, { done: 1, total: 3, current: 'Doing b' })
  assert.deepEqual(p.marks, ['ok', 'ok', 'err', 'repeat'])
  assert.equal(p.mood, 'friction')
  assert.equal(p.state, 'active')
  assert.equal(p.startedAt, t0 - 60_000)
  assert.equal(workPulse(work, t0 + 4 * 60_000).state, 'stalled')
  // A step still running is waiting, not stalled, until it's been very long.
  const pending = [{ item: { ...assistant(tool({ id: 'q', result: undefined })), ts: t0 }, index: 1 }]
  assert.equal(workPulse(pending, t0 + 4 * 60_000).state, 'waiting')
  assert.equal(workPulse(pending, t0 + 11 * 60_000).state, 'stalled')
  const bad = [{ item: { ...assistant(...[1, 2, 3].map(i => tool({ id: `e${i}`, input: { i }, isError: true }))), ts: t0 }, index: 1 }]
  assert.equal(workPulse(bad, t0).mood, 'struggling')
})

test('work groups into intents at the agent\'s own updates and thinking notes', async () => {
  const { workPhases } = await import(new URL('../web/src/chatActivity.ts', import.meta.url).href)
  const bash = (description: string, extra = {}) => tool({ id: description, input: { command: description, description }, ...extra })
  const think = (t: string) => ({ type: 'thinking', text: t })
  const work = [
    assistant(think(''), bash('List perch layout'), bash('Grep server log')),
    assistant(think('I\'m searching for PostHog rate-limit hits, which the log does not show.'), bash('Find callers', { isError: true, result: 'boom' }), bash('Read posthogFetch')),
    assistant(text('Checking the GitHub limits now.'), bash('Check rate limit')),
  ].map((item, index) => ({ item, index }))
  const done = workPhases(work, false)
  assert.deepEqual(done.map((p: any) => [p.title, p.steps, p.state]), [
    ['List perch layout', 2, 'done'],
    ['I\'m searching for PostHog rate-limit hits, which the log does not show.', 2, 'recovered'],
    ['Checking the GitHub limits now.', 1, 'done'],
  ])
  assert.equal(workPhases(work, true).at(-1).state, 'running')
  // A finished intent carries what came of it: the next update, and one line per step.
  assert.equal(done[1].outcome, 'Checking the GitHub limits now.')
  assert.deepEqual(done[1].results.map((r: any) => [r.label, r.excerpt, !!r.isError]), [['Find callers', 'boom', true], ['Read posthogFetch', 'passed', false]])
  // Every block stays reachable inside exactly one intent.
  const blocks = done.flatMap((p: any) => p.entries.flatMap((e: any) => e.item.blocks))
  assert.equal(blocks.length, work.flatMap(e => e.item.blocks).length)
})

test('an agent message that arrives mid-turn stays in the running card instead of starting a new one', () => {
  const sent = { kind: 'user', queued: true, text: '[perch: sent by an agent from perch://abc "Shepherd: posthog#1". Not typed by the user.]\n\nSplit done.' }
  const items = [user(), assistant(text('Working on it.')), assistant(tool()), sent]
  let all = turns(items, true)
  assert.equal(all.length, 1)
  assert.equal(all[0].running, true)
  assert.equal(all[0].queued.length, 1)
  assert.equal(all[0].queued[0].pickedUp, false)
  assert.equal(all[0].work.length, 2)
  all = turns([...items, assistant(text('Done. Now the shepherd message.')), { kind: 'result', ok: true, text: '' }])
  assert.equal(all.length, 1)
  assert.equal(all[0].queued[0].pickedUp, true)
  assert.equal(all[0].answer.length, 1)
})

test('a message you type mid-turn still starts a new turn', () => {
  const items = [user(), assistant(tool()), { kind: 'user', queued: true, text: 'Actually, stop and check X' }, assistant(text('Checking X.'))]
  assert.equal(turns(items, true).length, 2)
})

test('history shows a message that arrived mid-turn (saved as a queued_command attachment)', async () => {
  const { toItems } = await import('./transcript.ts')
  const line = (o: any) => JSON.stringify(o)
  const items = toItems([
    line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Do the thing' } }),
    line({ type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } }),
    line({ type: 'attachment', uuid: 'q1', attachment: { type: 'queued_command', prompt: '[perch: sent by an agent from perch://abc "Shepherd". Not typed by the user.]\n\nSplit done.' } }),
    line({ type: 'attachment', uuid: 'q2', attachment: { type: 'queued_command', prompt: '<task-notification><task-id>x</task-id></task-notification>' } }),
  ].join('\n'))
  const queued = items.filter((i: any) => i.queued)
  assert.equal(queued.length, 1)
  assert.match((queued[0] as any).text, /Split done/)
})
