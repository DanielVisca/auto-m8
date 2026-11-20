import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { durableRun, savedRuns } from './durable-run.ts'

async function until(check: () => boolean) {
  const end = Date.now() + 5000
  while (!check()) { assert.ok(Date.now() < end, 'timed out'); await delay(20) }
}

test('agent survives its server being killed; reattachment replays state and delivers new output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'perch-durable-'))
  const gate = join(root, 'continue')
  const agent = join(root, 'agent.mjs')
  writeFileSync(agent, `import { existsSync } from 'node:fs';
    console.log('started 🦔');
    const timer = setInterval(() => { if (existsSync(${JSON.stringify(gate)})) {
      console.log('finished 🦔'); clearInterval(timer);
    } }, 20);`)
  const parent = join(root, 'parent.mjs')
  writeFileSync(parent, `import { durableRun } from ${JSON.stringify(new URL('./durable-run.ts', import.meta.url).href)};
    durableRun({ root: ${JSON.stringify(root)}, id: 'turn', data: { queue: ['next message'] },
      command: process.execPath, args: [${JSON.stringify(agent)}], cwd: ${JSON.stringify(root)} }, () => {});
    setInterval(() => {}, 1000);`)
  const server = spawn(process.execPath, [parent], { stdio: 'ignore' })
  let attached: ReturnType<typeof durableRun> | undefined
  try {
    await until(() => savedRuns(root)[0]?.offset > 0)
    const exited = once(server, 'exit')
    server.kill('SIGKILL'); await exited
    const record = savedRuns(root)[0]
    assert.deepEqual(record.data, { queue: ['next message'] })
    process.kill(record.pid, 0) // detached supervisor is still alive
    const lines: { line: string; replay: boolean }[] = []
    attached = durableRun({ root, id: record.id, data: record.data, command: '', args: [], cwd: root, resume: record }, (line, replay) => lines.push({ line, replay }))
    writeFileSync(gate, '')
    const exit = await attached.done
    assert.equal(exit.code, 0)
    assert.equal(exit.signal, null)
    assert.deepEqual(lines, [{ line: 'started 🦔', replay: true }, { line: 'finished 🦔', replay: false }])
    attached.acknowledge()
    assert.equal(savedRuns(root).length, 0)
  } finally { server.kill('SIGKILL'); attached?.kill('SIGKILL'); attached?.stop() }
})

test('interrupt and launch failure are recorded as failures, not successful empty replies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'perch-durable-exit-'))
  const job = durableRun({ root, id: 'interrupt', data: {}, command: process.execPath,
    args: ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], cwd: root }, () => {})
  await until(() => job.record.offset > 0)
  job.kill('SIGTERM')
  const exit = await job.done
  assert.equal(exit.signal, 'SIGTERM')
  job.acknowledge()
  const missing = durableRun({ root, id: 'missing', data: {}, command: join(root, 'absent'), args: [], cwd: root }, () => {})
  const failure = await missing.done
  assert.equal(failure.code, 1)
  assert.match(failure.error!, /ENOENT/)
  missing.acknowledge()
})

test('completion written while no reader exists is drained after reattachment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'perch-durable-complete-'))
  const job = durableRun({ root, id: 'finished', data: {}, command: process.execPath,
    args: ['-e', "console.log('last line')"], cwd: root }, () => {})
  job.stop()
  await until(() => existsSync(join(root, 'finished', 'exit.json')))
  const saved = savedRuns(root)[0]
  const lines: string[] = []
  const resumed = durableRun({ root, id: saved.id, data: {}, command: '', args: [], cwd: root, resume: saved }, line => lines.push(line))
  assert.equal((await resumed.done).code, 0)
  assert.deepEqual(lines, ['last line'])
  assert.equal(JSON.parse(readFileSync(join(root, 'finished', 'meta.json'), 'utf8')).offset, 10)
  resumed.acknowledge()
})
