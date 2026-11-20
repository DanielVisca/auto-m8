import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { savedRuns } from './durable-run.ts'

test('Codex recovery preserves queued attachments, text, usage, and the original turn without double counting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'perch-codex-recovery-'))
  const cli = join(root, 'codex'), gate = join(root, 'continue')
  writeFileSync(cli, `#!/usr/bin/env node
    import { existsSync } from 'node:fs';
    if (process.argv.includes('login')) { console.log('Logged in using ChatGPT'); process.exit(0) }
    const emit = x => console.log(JSON.stringify(x));
    emit({ type: 'thread.started', thread_id: 'test-thread' });
    emit({ type: 'item.completed', item: { type: 'agent_message', text: 'Before restart' } });
    emit({ type: 'item.started', item: { type: 'command_execution', id: 'tool1', command: 'test command' } });
    emit({ type: 'item.completed', item: { type: 'command_execution', id: 'tool1', command: 'test command', aggregated_output: 'ok', exit_code: 0 } });
    const timer = setInterval(() => { if (existsSync(${JSON.stringify(gate)})) {
      emit({ type: 'item.completed', item: { type: 'agent_message', text: 'After restart' } });
      emit({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 } });
      clearInterval(timer);
    } }, 20);`)
  chmodSync(cli, 0o700)
  const database = join(root, 'perch.db')
  const serverFile = join(root, 'server.mjs')
  writeFileSync(serverFile, `
    import { startTurn, turnEvent } from ${JSON.stringify(new URL('./turns.ts', import.meta.url).href)};
    import { codexTurn } from ${JSON.stringify(new URL('./codex.ts', import.meta.url).href)};
    const turnId = startTurn('chat', 'do the work', { turbo: false, model: 'codex' });
    const job = codexTurn({ conversationId: 'chat', cwd: ${JSON.stringify(root)}, mode: 'plan', prompt: 'do the work',
      mcpScript: '', node: process.execPath, env: process.env, recovery: { turnId, queue: [] } }, ev => turnEvent('chat', ev, turnId));
    job.proc.saveQueue([{ prompt: 'next', images: [{ data: 'image bytes' }] }]);
    setInterval(() => {}, 1000);`)
  const env = { ...process.env, PERCH_DATA: root, PERCH_DB: database, CODEX_CLI_PATH: cli }
  const server = spawn(process.execPath, [serverFile], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let errors = ''
  server.stderr!.on('data', b => { errors += b })
  const end = Date.now() + 5000
  while (!(savedRuns(join(root, 'codex-runs'))[0]?.offset > 0)) {
    assert.ok(Date.now() < end, errors || 'no Codex output'); await delay(20)
  }
  const exited = once(server, 'exit'); server.kill('SIGKILL'); await exited
  Object.assign(process.env, { PERCH_DATA: root, PERCH_DB: database, CODEX_CLI_PATH: cli })
  const { codexTurn, recoverableCodex, recordCodexTurn } = await import('./codex.ts')
  const { get, run } = await import('./db.ts')
  const { turnEvent } = await import('./turns.ts')
  const saved = recoverableCodex()[0], turnId = saved.data.recovery.turnId
  assert.deepEqual(saved.data.recovery.queue, [{ prompt: 'next', images: [{ data: 'image bytes' }] }])
  // Keep transcript writes inside the fixture, including on retries after a crash.
  const transcript = join(root, 'transcript.jsonl')
  writeFileSync(transcript, '')
  run("insert into conversations (id,source,path) values ('chat','claude',?)", transcript)
  const seen: any[] = []
  const job = codexTurn({ conversationId: 'chat', cwd: root, mode: 'plan', prompt: 'do the work', mcpScript: '', node: process.execPath, env,
    saved, recovery: { ...saved.data.recovery, opts: { prompt: 'do the work', messageId: 'upgraded-prompt' } }, before: r => recordCodexTurn({ id: 'chat', turnId, cwd: root, prompt: 'do the work', reply: r.text, tools: r.tools }),
  }, ev => { seen.push(ev); turnEvent('chat', ev, turnId) })
  assert.equal(recoverableCodex()[0].data.recovery.opts.messageId, 'upgraded-prompt')
  writeFileSync(gate, '')
  const result = await job.done
  assert.equal(result.ok, true)
  assert.equal(result.text, 'Before restart\n\nAfter restart')
  const texts = seen.filter(e => e.type === 'assistant').flatMap(e => e.message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text))
  assert.deepEqual(texts, ['After restart'])
  const turn = get<any>('select * from turns where id = ?', turnId)
  assert.equal(turn.ok, 1); assert.ok(turn.first_token_at); assert.equal(turn.tools, 1)
  assert.equal(turn.in_tok, 80); assert.equal(turn.out_tok, 10); assert.equal(turn.cache_read, 20)
  const beforeReplay = readFileSync(transcript, 'utf8')
  recordCodexTurn({ id: 'chat', turnId, cwd: root, prompt: 'do the work', reply: result.text, tools: result.tools })
  assert.equal(readFileSync(transcript, 'utf8'), beforeReplay)
  const { toItems } = await import('./transcript.ts')
  const items = toItems(beforeReplay)
  assert.deepEqual(items.map(item => item.kind), ['user', 'assistant'])
  const answer = items[1]
  assert.ok(answer.kind === 'assistant')
  assert.deepEqual(answer.blocks, [{ type: 'text', text: result.text }])
  assert.deepEqual(answer.activity, { tools: result.tools })
  job.acknowledge()
  assert.equal(recoverableCodex().length, 0)
})
