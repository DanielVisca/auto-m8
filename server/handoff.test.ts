import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { test } from 'node:test'
import { agentSender, QUEUED, stampPrompt } from '../shared/messageOrigin.ts'
import { runCorrectionFor } from './replycheck.ts'

let fixtures = 0
import { claudePeer, codexPeer, modelTier } from './model-tiers.ts'
import { chooseProvider } from './subscription-budget.ts'
import type { Usage } from './usage.ts'

const models = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'].map(slug => ({ slug, tier: modelTier(slug) }))

// Exercise the real send/handoff functions with fake process, clock and database boundaries.
// Loading the full chat module would start provider probes and the watchdog against the host.
const source = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
const code = stripTypeScriptTypes(source.slice(source.indexOf('export type SendOpts'), source.indexOf('export function interrupt')).replace('export function send', 'function send'))
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

function fixture(lastModel = '') {
  const c: any = { id: 'chat', cwd: '/tmp', proc: null, state: 'idle', turn: [], pending: [], engine: '', tier: 'opus', turbo: false, context: true, mode: 'plan' }
  const s = { codexOk: true, capped: false, hot: false, cover: false, next: null as string | null, pin: 'auto', routed: 'opus', defaultModel: 'gpt-6.1-sol', usage: { claude: null as Usage | null, codex: null as Usage | null } }
  const events: any[] = [], writes: any[] = [], turns: any[] = []
  const runner = { write: (line: string) => writes.push(JSON.parse(line)), kill() {}, stop() {} }
  const context: any = {
    chats: new Map([[c.id, c]]), waiting: new Map(), sendInterceptors: new Set(), shouldHold: () => false, hold() {}, randomUUID: () => 'uuid', Date, Buffer,
    settings: { chat: {}, local: { model: 'qwen3-coder:30b' } }, QUEUED, stampPrompt, agentSender, MCP_SCRIPT: '', process: { execPath: 'node' },
    get: (sql: string) => sql.startsWith('select model from turns') ? { model: lastModel } : null, run() {}, startChatOrigin() {}, setTurbo() {}, turboFor: () => false, setEngine: (_id: string, e: string) => { s.pin = e }, engineFor: () => s.pin,
    isCodex: (e: string) => e === 'codex' || e.startsWith('codex:'),
    isLocal: (e: string) => !!e && e !== 'auto' && !e.startsWith('claude:') && !e.startsWith('codex'),
    claudeFixed: (e: string) => e.startsWith('claude:') ? e.slice(7) : null,
    route: () => ({ tier: s.routed }), available: (want: string) => s.capped ? null : s.next ?? want,
    markCapped: (scope: string) => { if (scope === 'all') s.capped = true }, tierLabel: (t: string) => t,
    allCapped: () => s.capped, codexReadySync: () => s.codexOk, localUpSync: () => true,
    activeAccount: () => 'main', accountLabel: (a: string) => a, outUntil: () => null, usesProfileLogin: () => true, configDirFor: () => undefined,
    usageNow: () => s.hot ? { claude: { at: Date.now(), windows: [{ key: 'five_hour', pct: 0.96, resetsAt: Date.now() + 100_000 }] }, codex: null } : s.usage,
    chooseProvider,
    codexReady: async () => ({ ok: s.codexOk, why: 'signed out' }), codexDefaultModel: () => s.defaultModel,
    codexFallbackModel: (model: string) => codexPeer(model, models, s.defaultModel),
    claudeFallbackTier: (model?: string) => claudePeer(model || s.defaultModel),
    wantsCodex: (_tier: string, ok: boolean, hot: boolean) => ({ codex: ok && (s.cover || s.capped || hot), why: 'test cap' }),
    contextTokens: () => 0, isCorrection: () => false,
    // The real check and cooldown; each fixture is its own chat as far as the cooldown can tell.
    runCorrectionFor: ((n: number) => (id: string, text: string) => runCorrectionFor(`${id}#${n}`, text))(++fixtures),
    selectRace: () => null, raceInstruction: () => '\n\n<perch-auto-race>Scope and launch the race.</perch-auto-race>',
    cloudFallback: null, emit: (_c: any, ev: any) => events.push(ev), setState: (_c: any, state: string) => { c.state = state },
    start: () => { c.proc = runner }, startTurn: (_id: string, _prompt: string, meta: any) => { lastModel = meta.model ?? '' }, snapshot: async () => {}, turnEvent() {},
    transcriptPath: () => '/missing', existsSync: () => false, codexThread: () => 'thread',
    tmpdir: () => '/tmp', join: (...parts: string[]) => parts.join('/'), writeFileSync() {},
    systemPrompt: () => '', childEnv: () => ({}), recordCodexTurn() {}, recordedCodexPrompt: () => null, recordCodexPrompt() {}, recordCodexMessage() {}, indexTranscript() {},
    codexTurn: (opts: any) => {
      let resolve!: (r: any) => void
      const done = new Promise(r => { resolve = r })
      const proc = { kill() {}, saveQueue() {} }
      turns.push({ opts, resolve, proc })
      return { proc, done, acknowledge() {} }
    },
    setTimeout: () => { throw new Error('Handoffs must not leave a timer gap for newer messages to overtake them') },
  }
  vm.createContext(context)
  vm.runInContext(code, context)
  const send = (o: any) => context.send({ id: c.id, by: 'you', ...o })
  const messages = () => writes.filter(x => x.type === 'user').map(x => x.message.content)
  const echoes = () => events.filter(x => x.type === 'perch_user').map(x => x.text)
  const codexNotices = () => events.filter(x => x.type === 'perch_notice' && x.text.startsWith('Continuing on Codex'))
  return { c, s, context, turns, runner, writes, send, messages, echoes, codexNotices, events }
}

test('consecutive automatic Codex turns announce the handoff only once, including queued messages', async () => {
  const f = fixture()
  f.s.hot = true
  f.send({ prompt: 'Review A' })
  f.send({ prompt: 'Also review B' })
  f.turns[0].resolve({ ok: true }); await flush()
  f.turns[1].resolve({ ok: true }); await flush()
  f.send({ prompt: 'Carry on' })
  assert.equal(f.turns.length, 3)
  assert.equal(f.codexNotices().length, 1)
})

test('a fresh chat process remembers that its previous turn already used Codex', () => {
  for (const model of ['codex', 'codex:gpt-6-astra']) {
    const f = fixture(model)
    f.s.hot = true
    f.send({ prompt: 'Carry on after restart' })
    assert.equal(f.turns.length, 1)
    assert.equal(f.codexNotices().length, 0)
  }
})

test('a genuine return to Codex after a Claude turn announces a new handoff', async () => {
  const f = fixture()
  f.s.hot = true
  f.send({ prompt: 'Review A' })
  f.turns[0].resolve({ ok: true }); await flush()
  f.s.hot = false
  f.s.codexOk = false
  f.send({ prompt: 'Review B' })
  assert.deepEqual(f.messages(), ['Review B'])
  f.c.state = 'idle'
  f.s.hot = true; f.s.codexOk = true
  f.send({ prompt: 'Review C' })
  assert.equal(f.turns.length, 2)
  assert.equal(f.codexNotices().length, 2)
})

test('a running Claude turn keeps its steer even when usage becomes hot', () => {
  const f = fixture()
  f.c.proc = f.runner; f.c.state = 'running'; f.s.hot = true
  f.send({ prompt: 'Keep going' })
  assert.equal(f.turns.length, 0)
  assert.deepEqual(f.messages(), ['Keep going'])
})

test('switching from a busy local model never sends Claude model controls to Ollama', () => {
  const f = fixture()
  f.c.proc = f.runner; f.c.state = 'running'; f.c.engine = 'qwen3-coder:30b'; f.c.tier = null
  f.send({ prompt: 'Finish this, then use Claude', engine: 'claude:opus' })
  assert.deepEqual(f.messages(), ['Finish this, then use Claude'])
  assert.equal(f.writes.filter(x => x.type === 'control_request').length, 0)
  assert.equal(f.s.pin, 'claude:opus')
})

test('Codex queues a steer, then respects its newly chosen model without double echo', async () => {
  const f = fixture()
  f.send({ prompt: 'Review A', engine: 'codex:model-a' })
  f.send({ prompt: 'Review B', engine: 'codex:model-b' })
  assert.equal(f.turns.length, 1)
  assert.equal(f.c.proc, null)
  f.turns[0].resolve({ ok: true }); await flush()
  assert.equal(f.turns[1].opts.model, 'model-b')
  assert.deepEqual(f.echoes(), ['Review A', 'Review B'])
})

test('a queued Claude selection takes effect when the Codex turn finishes', async () => {
  const f = fixture()
  f.send({ prompt: 'Review A', engine: 'codex' })
  f.send({ prompt: 'Review B', engine: 'claude:sonnet' })
  f.turns[0].resolve({ ok: true }); await flush()
  assert.equal(f.turns.length, 1)
  assert.deepEqual(f.messages(), ['Review B'])
  assert.equal(f.c.pending.length, 1)
  assert.deepEqual(f.echoes(), ['Review A', 'Review B'])
})

test('Codex cap preserves original and queued messages, attachments and one echo each', async () => {
  const f = fixture()
  const images = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } }]
  f.send({ prompt: 'Review screenshot', images, engine: 'codex' })
  f.send({ prompt: 'Also check retries' })
  f.s.codexOk = false
  f.turns[0].resolve({ capped: true }); await flush()
  f.send({ prompt: 'Then report' })
  assert.deepEqual(JSON.parse(JSON.stringify(f.messages())), [[...images, { type: 'text', text: 'Review screenshot' }], 'Also check retries', 'Then report'])
  assert.deepEqual(f.echoes(), ['Review screenshot', 'Also check retries', 'Then report'])
  assert.equal(f.c.pending.length, 3)
})

test('messages arriving during provider readiness stay behind all unanswered work', async () => {
  const f = fixture()
  let ready!: (r: any) => void
  f.context.codexReady = () => new Promise(resolve => { ready = resolve })
  f.c.lastPrompt = 'B'
  f.context.onCap(f.c, Date.now() + 60_000, 'all', [{ prompt: 'A' }, { prompt: 'B' }])
  f.send({ prompt: 'C' })
  assert.equal(f.turns.length, 0)
  ready({ ok: true }); await flush()
  assert.equal(f.turns[0].opts.prompt, 'A')
  f.turns[0].resolve({ ok: true }); await flush()
  assert.equal(f.turns[1].opts.prompt, 'B')
  f.turns[1].resolve({ ok: true }); await flush()
  assert.equal(f.turns[2].opts.prompt, 'C')
  assert.deepEqual(f.echoes(), ['C'])
})

test('stale Codex readiness falls back to an available Claude model', async () => {
  const f = fixture()
  f.s.cover = true; f.s.next = 'sonnet'; f.c.lastPrompt = 'A'
  f.context.codexReady = async () => ({ ok: false, why: 'signed out' })
  f.context.onCap(f.c, Date.now() + 60_000, 'opus'); await flush()
  assert.equal(f.c.engine, 'claude:sonnet')
  assert.deepEqual(f.messages(), ['A'])
  assert.deepEqual(f.echoes(), [])
})

test('a queued automation message has the same sender live and in the provider transcript', () => {
  const f = fixture()
  f.c.proc = f.runner; f.c.state = 'running'
  f.send({ prompt: 'Continue the review.', by: 'shepherd' })
  assert.ok(f.messages()[0].startsWith(QUEUED))
  assert.deepEqual(agentSender(f.messages()[0]), agentSender(f.echoes()[0]))
  assert.equal(agentSender(f.messages()[0])?.label, 'perch: shepherd')
})

test('agent provenance survives a Codex cap and is not duplicated by the retry', async () => {
  const f = fixture()
  f.send({ prompt: 'Continue the review.', by: 'shepherd', engine: 'codex' })
  assert.equal(agentSender(f.turns[0].opts.prompt)?.body, 'Continue the review.')
  f.s.codexOk = false
  f.turns[0].resolve({ capped: true }); await flush()
  assert.deepEqual(f.messages(), f.echoes())
  assert.equal(agentSender(f.messages()[0])?.body, 'Continue the review.')
})

test('automatic scoping instruction reaches Claude and Codex before they edit', () => {
  for (const engine of ['claude:opus', 'codex']) {
    const f = fixture(), seen: any[] = []
    f.context.selectRace = (input: any) => { seen.push(input); return { reason: 'testable alternatives' } }
    f.send({ prompt: 'Earlier context\nFix the worker', selectionText: 'Fix the worker', engine })
    assert.equal(seen[0].prompt, 'Fix the worker', 'selection sees only the new request')
    assert.equal(seen[0].by, 'you')
    const delivered = engine === 'codex' ? f.turns[0].opts.prompt : f.messages()[0]
    assert.match(delivered, /Earlier context/)
    assert.match(delivered, /<perch-auto-race>/)
  }
})

const peers = [['haiku', 'gpt-6-luna'], ['sonnet', 'gpt-6.1-sol'], ['opus', 'gpt-6-astra'], ['fable', 'gpt-6-astra']]

test('Claude caps hand off each tier to its Codex peer, preserving the pin and queued work', async () => {
  for (const [tier, model] of peers) {
    const f = fixture()
    f.c.tier = tier; f.s.pin = `claude:${tier}`; f.c.lastPrompt = 'continue'
    f.s.defaultModel = tier === 'haiku' ? 'gpt-6-astra' : 'gpt-6-luna'
    f.context.onCap(f.c, Date.now() + 60_000, 'all', [{ prompt: 'continue' }, { prompt: 'Then report' }])
    await flush()
    assert.equal(f.turns[0].opts.model, model)
    assert.equal(f.s.pin, `claude:${tier}`)
    assert.ok(f.events.some(ev => ev.type === 'perch_notice' && ev.text.includes(model)))
    f.turns[0].resolve({ ok: true }); await flush()
    assert.equal(f.turns[1].opts.model, model)
    assert.deepEqual(f.echoes(), [])
  }
})

test('known caps and near-limit routing select a peer and retain the tier for recovery', () => {
  for (const [tier, model] of peers) for (const capped of [true, false]) {
    const f = fixture()
    f.c.tier = null; f.s.routed = tier
    f.s.capped = capped; f.s.hot = !capped
    f.send({ prompt: 'continue' })
    assert.equal(f.turns[0].opts.model, model)
    assert.equal(f.c.tier, tier)
    assert.equal(f.turns[0].opts.recovery.chat.tier, tier)
    assert.equal(f.s.pin, 'auto')
  }
})

test('Codex cap retries the actual model tier even when the prompt or default suggests another', async () => {
  for (const [tier, model] of peers.slice(0, 3)) {
    const f = fixture()
    f.send({ prompt: 'continue', engine: `codex:${model}` })
    f.s.codexOk = false; f.s.defaultModel = 'gpt-6-luna'
    f.turns[0].resolve({ capped: true }); await flush()
    assert.equal(f.c.tier, tier)
    assert.equal(f.s.pin, `codex:${model}`)
    assert.deepEqual(f.messages(), ['continue'])
    assert.deepEqual(f.echoes(), ['continue'])
  }
})

test('a pinned Codex model uses its Claude peer when already unavailable, and returns after reset', () => {
  for (const [tier, model] of peers.slice(0, 3)) {
    const f = fixture()
    f.s.codexOk = false
    f.send({ prompt: 'continue', engine: `codex:${model}` })
    assert.equal(f.c.tier, tier)
    assert.equal(f.s.pin, `codex:${model}`)
    f.c.state = 'idle'; f.s.codexOk = true
    f.send({ prompt: 'continue' })
    assert.equal(f.turns[0].opts.model, model)
  }
})

test('a default Codex turn remembers its resolved model through a cap', async () => {
  const f = fixture()
  f.s.defaultModel = 'gpt-6-astra'
  f.send({ prompt: 'continue', engine: 'codex' })
  assert.equal(f.turns[0].opts.model, 'gpt-6-astra')
  f.s.defaultModel = 'gpt-6-luna'; f.s.codexOk = false
  f.turns[0].resolve({ capped: true }); await flush()
  assert.equal(f.c.tier, 'opus')
  assert.equal(f.s.pin, 'codex')
})

test('Claude returning after a cap respects the original model pin', async () => {
  const f = fixture()
  f.s.pin = 'claude:haiku'; f.s.capped = true
  f.send({ prompt: 'continue' })
  assert.equal(f.turns[0].opts.model, 'gpt-6-luna')
  f.turns[0].resolve({ ok: true }); await flush()
  f.s.capped = false
  f.send({ prompt: 'continue' })
  assert.equal(f.c.tier, 'haiku')
  assert.equal(f.s.pin, 'claude:haiku')
})

test('Auto paces a week early and preserves the requested model tier', () => {
  const f = fixture()
  f.s.routed = 'sonnet'
  f.s.usage.claude = { at: Date.now(), windows: [{ key: 'seven_day', label: 'week', pct: 0.65, resetsAt: Date.now() + 5 * 86400_000 }] }
  f.send({ prompt: 'Keep working' })
  assert.equal(f.turns[0].opts.model, 'gpt-6.1-sol')
  assert.equal(f.s.pin, 'auto')
  assert.match(f.codexNotices()[0].text, /pacing/)
})

test('known exhausted subscriptions continue locally without pinning the chat there', () => {
  const f = fixture()
  f.s.codexOk = false
  f.s.usage.claude = { at: Date.now(), windows: [{ key: 'seven_day', label: 'week', pct: 1, resetsAt: Date.now() + 86400_000 }] }
  f.send({ prompt: 'Keep working' })
  assert.equal(f.c.engine, 'qwen3-coder:30b')
  assert.equal(f.s.pin, 'auto')
  assert.deepEqual(f.messages(), ['Keep working'])
  f.c.state = 'idle'; f.s.usage.claude = null
  f.send({ prompt: 'Continue after reset' })
  assert.equal(f.c.engine, 'auto')
})

function exhausted() {
  const f = fixture()
  f.s.codexOk = false
  f.s.usage.claude = { at: Date.now(), windows: [{ key: 'seven_day', label: 'week', pct: 1, resetsAt: Date.now() + 86400_000 }] }
  return f
}

test('every subscription out: the message goes to the cloud fallback, not the local model', () => {
  const f = exhausted()
  const taken: any[] = []
  f.context.cloudFallback = (o: any, id: string) => taken.push({ prompt: o.prompt, id })
  const id = f.send({ prompt: 'Keep working' })
  assert.equal(taken.length, 1)
  assert.equal(taken[0].prompt, 'Keep working')
  assert.equal(taken[0].id, id)
  assert.deepEqual(f.messages(), []) // nothing reached a local process
  assert.notEqual(f.c.engine, 'qwen3-coder:30b')
})

test('a failed cloud hand-off resends once with noCloud and lands on the local model', () => {
  const f = exhausted()
  f.context.cloudFallback = () => {}
  f.send({ prompt: 'Keep working', noCloud: true })
  assert.equal(f.c.engine, 'qwen3-coder:30b')
  assert.deepEqual(f.messages(), ['Keep working'])
})

test('a returning Codex thread receives the intervening Claude work', () => {
  const f = fixture('claude:sonnet')
  f.context.handoff = () => 'LATEST CLAUDE WORK\n'
  f.send({ prompt: 'Continue', engine: 'codex' })
  assert.equal(f.turns[0].opts.prompt, 'LATEST CLAUDE WORK\nContinue')
})

const HANDS_OFF = 'Done. The quickest way is to paste this in your terminal:\n```\ngit push\n```'

test('a Codex reply that hands the user a command gets one correction, on Codex, after queued messages', async () => {
  const f = fixture()
  f.send({ prompt: 'Push it', engine: 'codex' })
  f.send({ prompt: 'Also tag it' }) // arrives mid-turn: queued
  f.turns[0].resolve({ ok: true, text: HANDS_OFF }); await flush()
  // The queued user message runs first, exactly once; the correction waits behind it.
  assert.equal(f.turns.length, 2)
  assert.equal(f.turns[1].opts.prompt, 'Also tag it')
  assert.equal(f.c.codexQueue.length, 1)
  assert.match(f.c.codexQueue[0].prompt, /^⏰ perch check: your last reply asked the user to run a command/)
  f.turns[1].resolve({ ok: true, text: 'Tagged v1.' }); await flush()
  assert.equal(f.turns.length, 3)
  assert.match(f.turns[2].opts.prompt, /^⏰ perch check/)
  assert.deepEqual(f.echoes().filter(t => !t.startsWith('⏰')), ['Push it', 'Also tag it'])
  // Cooldown: the corrected agent repeating itself doesn't loop.
  f.turns[2].resolve({ ok: true, text: HANDS_OFF }); await flush()
  assert.equal(f.turns.length, 3)
  assert.equal(f.c.codexQueue.length, 0)
})

test('a Codex reply with no hand-off, a failed turn or a capped turn sends no correction', async () => {
  for (const r of [{ ok: true, text: 'Ran `git push`: done.' }, { ok: false, text: HANDS_OFF }]) {
    const f = fixture()
    f.send({ prompt: 'Push it', engine: 'codex' })
    f.turns[0].resolve(r); await flush()
    assert.equal(f.turns.length, 1)
    assert.ok(!f.echoes().some(t => t.startsWith('⏰')))
  }
  const f = fixture()
  f.send({ prompt: 'Push it', engine: 'codex' })
  f.turns[0].resolve({ ok: false, capped: true, text: HANDS_OFF }); await flush()
  assert.ok(!f.echoes().some(t => t.startsWith('⏰')))
  assert.ok(!f.writes.some(w => /perch check/.test(JSON.stringify(w))))
})

test('the local-model fallback finishes through the Claude result path, which runs the same check', () => {
  // Local models run inside the claude CLI (agentEnv points it at Ollama), so their replies end in
  // the same stream result event as Claude's; only Codex has a separate completion path.
  const chat = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
  assert.match(chat, /local \? agentEnv\(c\.engine\)/)
  const resultPath = chat.slice(chat.indexOf("if (ev.type === 'result') {"), chat.indexOf('function exited('))
  assert.match(resultPath, /runCorrectionFor\(c\.id, ev\.result\)/)
  const codexDone = chat.slice(chat.indexOf('t.done.then('), chat.indexOf('export function interrupt'))
  assert.match(codexDone, /runCorrectionFor\(c\.id, r\.text\)/)
})
