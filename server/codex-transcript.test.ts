import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { run, get } from './db.ts'
import { settings } from './settings.ts'
import { indexTranscript } from './indexer.ts'
import { recordedCodexPrompt, recordCodexPrompt, recordCodexMessage, recordCodexTurn } from './codex-history.ts'
import { test } from 'node:test'
import { applyLine, emptyMeta, toItems } from './transcript.ts'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
const stream = vm.createContext({ Date, Map, Set })
vm.runInContext(stripTypeScriptTypes(readFileSync(new URL('../web/src/stream.ts', import.meta.url), 'utf8')).replace(/^export /gm, '') + '\nthis.emptyLive = emptyLive', stream)
const { adopt, apply, emptyLive } = stream

const entry = (text: string, extra: object = {}) => JSON.stringify({
  type: 'assistant', version: 'perch-codex', uuid: 'reply',
  message: { id: 'msg_codex_reply', model: 'codex', content: [{ type: 'text', text }] }, ...extra,
})

test('old Codex footers become activity without changing the answer or shell commands', () => {
  const answer = 'Started the repair.\n\nSee https://github.com/PostHog/posthog/pull/123.'
  const tool = '$ \'printf "first; second"; echo done\''
  const [item] = toItems(entry(`${answer}\n\n_(Codex ran: ${tool}; posthog.exec; posthog.exec; perch.browser (failed); and 17 more)_`))
  assert.ok(item.kind === 'assistant')
  assert.deepEqual(item.blocks, [{ type: 'text', text: answer }])
  assert.deepEqual(item.activity, { tools: [tool, 'posthog.exec', 'posthog.exec', 'perch.browser (failed)'], omitted: 17 })
  assert.equal(item.uuid, 'reply')
})

test('ordinary text and quoted footers remain untouched', () => {
  const text = 'The footer looks like:\n\n_(Codex ran: posthog.exec)_'
  for (const data of [entry(text, { version: 'claude' }), entry(`${text}\n\nThis is an example.`), entry('Done.')]) {
    const [item] = toItems(data)
    assert.ok(item.kind === 'assistant')
    assert.equal(item.activity, undefined)
    assert.equal((item.blocks[0] as any).text, JSON.parse(data).message.content[0].text)
  }
})

function fixture() {
  const id = randomUUID(), cwd = mkdtempSync(join(tmpdir(), 'perch-history-')), path = join(cwd, `${id}.jsonl`)
  writeFileSync(path, '')
  run('insert into conversations (id, source, path) values (?, ?, ?)', id, 'claude', path)
  return { id, cwd, path }
}

test('recording a Codex turn saves all activity separately and preserves the transcript chain', () => {
  const f = fixture()
  writeFileSync(f.path, JSON.stringify({ type: 'system', uuid: 'previous' }) + '\n')
  const tools = Array.from({ length: 57 }, (_, i) => i === 0 ? '$ echo "a; b"' : 'posthog.exec')
  const reply = 'The repair is running.'
  recordCodexTurn({ ...f, prompt: 'Check it', reply, tools })
  const saved = readFileSync(f.path, 'utf8'), raw = saved.trim().split('\n').map(s => JSON.parse(s))
  assert.equal(raw[1].parentUuid, 'previous')
  assert.equal(raw[2].parentUuid, raw[1].uuid)
  assert.equal(raw[2].message.content[0].text, reply)
  const items = toItems(saved)
  assert.equal(items.length, 2)
  const item = items[1]
  assert.ok(item.kind === 'assistant')
  assert.deepEqual(item.blocks, [{ type: 'text', text: reply }])
  assert.deepEqual(item.activity, { tools })
})

test('an unfinished first Codex message is immediately indexed and searchable', () => {
  const f = fixture(), original = settings.sources
  settings.sources = [{ id: 'claude', label: 'test', dir: f.cwd, configDir: f.cwd }]
  try {
    indexTranscript(recordCodexPrompt({ ...f, messageId: 'first', prompt: 'find my quasar notebook' }))
    assert.equal(get<any>('select messages from conversations where id = ?', f.id)?.messages, 1)
    assert.equal(get<any>("select id from search where search match 'quasar' and id = ?", f.id)?.id, f.id)
    assert.deepEqual(toItems(readFileSync(f.path, 'utf8')).map(i => i.kind), ['user'])
  } finally { settings.sources = original }
})

test('partial replies and queued images survive reload; replay and completion do not duplicate them', () => {
  const f = fixture(), turnId = randomUUID(), images = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } }]
  const prompt = { ...f, messageId: 'first', prompt: 'Investigate' }
  const partial = { ...f, turnId, itemId: 'item_1', text: 'Found the cause.' }
  recordCodexPrompt(prompt)
  recordCodexMessage(partial)
  recordCodexPrompt({ ...f, messageId: 'queued', prompt: 'Also check this', images })
  // A server reattachment replays already-read output and re-registers its active prompt.
  recordCodexPrompt(prompt)
  recordCodexMessage(partial)
  const items = toItems(readFileSync(f.path, 'utf8'))
  assert.equal(items.length, 3)
  assert.match((items[2] as any).text, /Also check this.*\n\n🖼 1 image attached/)
  recordCodexMessage({ ...partial, itemId: 'item_2', text: 'Fixed it.' })
  const finish = { ...prompt, turnId, reply: 'Found the cause.\n\nFixed it.', tools: ['perch.search_conversations'] }
  recordCodexTurn(finish)
  const beforeReplay = readFileSync(f.path, 'utf8')
  recordCodexTurn(finish)
  assert.equal(readFileSync(f.path, 'utf8'), beforeReplay)
  const done = toItems(beforeReplay)
  assert.equal(done.filter(i => i.kind === 'user').length, 2)
  assert.deepEqual(done.filter(i => i.kind === 'assistant').flatMap(i => i.blocks), [{ type: 'text', text: 'Found the cause.' }, { type: 'text', text: 'Fixed it.' }])
  assert.deepEqual((done.at(-1) as any).activity, { tools: finish.tools })
})

test('new activity metadata does not cause literal footer examples to be removed', () => {
  const text = 'Example:\n\n_(Codex ran: posthog.exec)_'
  const [item] = toItems(entry(text, { perchActivity: { tools: ['perch.browser'] } }))
  assert.ok(item.kind === 'assistant')
  assert.deepEqual(item.blocks, [{ type: 'text', text }])
  assert.deepEqual(item.activity, { tools: ['perch.browser'] })
})

test('loading saved messages then replaying the live turn shows each exactly once', () => {
  const f = fixture(), turnId = randomUUID()
  recordCodexPrompt({ ...f, messageId: 'user-first', prompt: 'Find it' })
  recordCodexMessage({ ...f, turnId, itemId: 'one', text: 'Looking.' })
  recordCodexMessage({ ...f, turnId, itemId: 'two', text: 'Found it.' })
  const history = toItems(readFileSync(f.path, 'utf8')), live = emptyLive()
  adopt(live, history)
  for (const item of history) {
    apply(live, item.kind === 'user' ? { type: 'perch_user', uuid: item.uuid, text: item.text }
      : { type: 'assistant', uuid: item.uuid, message: { id: item.uuid, content: item.blocks } })
  }
  assert.equal(live.items.length, 0)
  apply(live, { type: 'perch_user', uuid: 'user-next', text: 'Find it' })
  assert.equal(live.items.length, 1, 'a new message with identical text is still displayed')
})

test('recovered historical messages appear in order and search without reviving old requests', () => {
  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-11-13T00:00:00Z', message: { role: 'user', content: 'Investigate' } }),
    entry('Done.', { timestamp: '2026-11-13T00:10:00Z' }),
    JSON.stringify({ type: 'perch-recovered-message', entry: { type: 'user', timestamp: '2026-11-13T00:05:00Z', message: { role: 'user', content: 'Also check queues' } } }),
  ]
  const meta = emptyMeta(); lines.forEach(line => applyLine(meta, line))
  assert.equal(meta.messages, 2)
  assert.equal(meta.lastRole, 'assistant')
  assert.equal(meta.lastAssistant, 'Done.')
  assert.equal(meta.updatedAt, Date.parse('2026-11-13T00:10:00Z'))
  assert.ok(meta.text.includes('Also check queues'))
  assert.deepEqual(toItems(lines.join('\n')).map(i => i.kind), ['user', 'user', 'assistant'])
})

test('an older active run adopts its saved prompt instead of duplicating it on upgrade', () => {
  const f = fixture(), since = Date.now() - 1000
  recordCodexPrompt({ ...f, messageId: 'existing', prompt: 'Continue', at: new Date(since).toISOString() })
  assert.equal(recordedCodexPrompt(f.id, f.cwd, 'Continue', since), 'existing')
  assert.equal(recordedCodexPrompt(f.id, f.cwd, 'Continue', since + 1), null)
  recordCodexPrompt({ ...f, messageId: recordedCodexPrompt(f.id, f.cwd, 'Continue', since)!, prompt: 'Continue' })
  assert.equal(toItems(readFileSync(f.path, 'utf8')).length, 1)
})
