// End to end in an isolated harness: the real shell/main.cjs (fake Electron, temp HOME and data folder,
// spare port) supervises a stand-in server that uses the real restart queue, driven by the real
// scripts/restart.sh. It never touches the live perch on :4777.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dirname, '..')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until<T>(f: () => T | undefined, ms: number): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) { const v = f(); if (v) return v }
  throw new Error('timed out')
}

test('restart.sh coalesces: two requests in the window make one restart with both reasons; --now is immediate', { timeout: 150_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'perch-restartq-')), port = 20000 + Math.floor(Math.random() * 20000)
  const home = join(root, 'home'), data = join(root, 'data'), log = join(root, 'boots.log')
  mkdirSync(join(root, 'shell'), { recursive: true }); mkdirSync(join(root, 'server')); mkdirSync(join(root, 'node_modules/electron'), { recursive: true }); mkdirSync(home); mkdirSync(data)
  cpSync(join(REPO, 'shell'), join(root, 'shell'), { recursive: true })
  writeFileSync(join(root, 'node_modules/electron/package.json'), '{"name":"electron","main":"index.js"}')
  writeFileSync(join(root, 'node_modules/electron/index.js'), `setInterval(() => {}, 1 << 30)
const deep = () => new Proxy(function () {}, { get: (t, k) => k === 'then' ? undefined : deep(), apply: () => deep(), construct: () => deep() })
module.exports = new Proxy({}, { get: (_t, k) => k === 'app' ? new Proxy({}, { get: (_a, m) => m === 'whenReady' ? () => new Promise(() => {}) : m === 'getPath' ? () => '/tmp' : deep() }) : deep() })`)
  writeFileSync(join(root, 'server/main.ts'), `import { appendFileSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { restartQueue } from ${JSON.stringify(join(REPO, 'server/restartqueue.ts'))}
const data = process.env.PERCH_DATA!, reasonFile = join(data, 'restart-reason')
let why = ''; try { why = readFileSync(reasonFile, 'utf8'); rmSync(reasonFile) } catch {}
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, at: Date.now(), why }) + '\\n')
const q = restartQueue({ windowMs: 8000, restart: r => { require_write(r); process.kill(process.pid, 'SIGTERM') } })
function require_write(r: string) { appendFileSync(reasonFile, r) }
process.once('SIGTERM', () => process.exit(0))
createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.url === '/api/health') return res.end(JSON.stringify({ ok: true, pid: process.pid }))
  let body = ''; for await (const c of req) body += c
  const b = JSON.parse(body || '{}'), r = q.request(b.reason, !!b.now)
  if (r.queued) return res.end(JSON.stringify({ ok: true, pid: process.pid, ...r }))
  require_write(r.reason); res.on('finish', () => setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50)); res.end(JSON.stringify({ ok: true, queued: false }))
}).listen(${port}, '127.0.0.1')
`)
  const boots = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  const shell: ChildProcess = spawn(process.execPath, [join(root, 'shell/main.cjs')], { env: { ...process.env, HOME: home, PERCH_DATA: data, PERCH_PORT: String(port) }, stdio: 'ignore' })
  const restart = (...args: string[]) => spawnSync('sh', [join(REPO, 'scripts/restart.sh'), ...args], { env: { ...process.env, PERCH_PORT: String(port) }, encoding: 'utf8' })
  try {
    await until(() => boots().length >= 1 && spawnSync('curl', ['-sf', '-m', '1', `http://127.0.0.1:${port}/api/health`]).status === 0, 90_000) // the shell starts it
    const a = restart('change A'), b = restart('change B')
    assert.match(a.stdout, /^queued, will restart at \d\d:\d\d with 1 reason /, a.stdout + a.stderr)
    assert.match(b.stdout, /^queued, will restart at \d\d:\d\d with 2 reasons/, b.stdout + b.stderr)
    const second = await until(() => boots()[1], 20_000)
    assert.equal(second.why, 'change A · change B')
    await sleep(3000)
    assert.equal(boots().length, 2, 'one restart for both requests')
    const c = restart('--now', 'emergency') // inside the new server's window: --now still goes at once
    assert.match(c.stdout, /Mothership restarted: pid \d+ -> \d+/, c.stdout + c.stderr)
    assert.equal((await until(() => boots()[2], 15_000)).why, 'emergency')
  } finally { shell.kill('SIGKILL'); for (const b of boots()) try { process.kill(b.pid, 'SIGKILL') } catch {} }
})
