// A CDP socket that stays open while Chrome stops answering (2026-11-18: "Target.getTargets timed out
// after 30000ms" for over an hour, status still connected) is treated as dead: perch drops it, removes
// the stale DevToolsActivePort, counts the recovery, and the next ensureBrowser() connects afresh.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'

const profile = mkdtempSync(join(tmpdir(), 'perch-hang-'))
process.env.PERCH_AGENT_CHROME_DIR = profile
process.env.PERCH_DATA = mkdtempSync(join(tmpdir(), 'perch-hang-data-')) // its own settings.json: the Chrome stub must not leak into other test files
const B = await import('./browser.ts')
const S = await import('./settings.ts')
S.updateSettings({ browser: { ...S.settings.browser, chromePath: '/nonexistent/chrome' } }) // never launch a real Chrome here

// A live process holding the profile's SingletonLock with no debug port (2026-11-18, pid 35888).
const lockedBy = (args: string[]) => {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', ...args], { stdio: 'ignore' })
  symlinkSync(`fakehost-${p.pid}`, join(profile, 'SingletonLock'))
  return p
}
const exited = (p: ReturnType<typeof spawn>) => p.exitCode !== null || p.signalCode !== null

test('a profile locked by an unreachable process that is not the Agent Chrome is left alone', async () => {
  const p = lockedBy(['--user-data-dir=/somewhere/else'])
  try {
    await new Promise(r => setTimeout(r, 200))
    await assert.rejects(B.ensureBrowser(), /already open \(pid \d+\)/)
    assert.equal(exited(p), false)
    assert.equal(B.browserStatus().recoveries, 0)
  } finally { p.kill('SIGKILL'); (await import('node:fs')).rmSync(join(profile, 'SingletonLock'), { force: true }) }
})

test('a profile locked by an unreachable Agent Chrome is quit and its lock cleared', async () => {
  const p = lockedBy([`--user-data-dir=${profile}`])
  writeFileSync(join(profile, 'DevToolsActivePort'), '1\n/devtools/browser/gone') // nothing listens there
  await new Promise(r => setTimeout(r, 200))
  await assert.rejects(B.ensureBrowser(), /Chrome not found/) // got past the lock to the launch
  assert.equal(exited(p), true)
  assert.equal(existsSync(join(profile, 'SingletonLock')), false)
  assert.equal(existsSync(join(profile, 'DevToolsActivePort')), false)
  assert.equal(B.browserStatus().recoveries, 1)
  assert.match(B.browserStatus().lastRecoveryReason ?? '', new RegExp(`pid ${p.pid}`))
})

test('a CDP connection that stops answering is recovered', async () => {
  let answering = true
  const http = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"Browser":"fake"}') })
  const wss = new WebSocketServer({ server: http })
  wss.on('connection', ws => ws.on('message', raw => {
    const m = JSON.parse(raw.toString())
    if (!answering) return // the hang: socket open, no replies
    ws.send(JSON.stringify({ id: m.id, result: m.method === 'Target.getTargets' ? { targetInfos: [] } : {} }))
  }))
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r))
  const port = (http.address() as any).port
  const portFile = join(profile, 'DevToolsActivePort')
  writeFileSync(portFile, `${port}\n/devtools/browser/fake`)
  try {
    const c = await B.ensureBrowser()
    assert.equal(B.browserStatus().connected, true)
    const before = B.browserStatus().recoveries

    answering = false
    await assert.rejects(c.send('Target.getTargets', {}, undefined, 100), /timed out/)
    assert.equal(B.browserStatus().connected, true, 'one timeout alone is not a hang')
    await assert.rejects(c.send('Storage.getCookies', {}, undefined, 100), /timed out/)
    // second browser-level timeout: recovery starts (Browser.close then times out after 5s)
    await new Promise(r => setTimeout(r, 50))
    const st = B.browserStatus()
    assert.equal(st.connected, false)
    assert.equal(st.recoveries, before + 1)
    assert.ok(st.lastRecovery && st.lastRecoveryReason?.includes('Storage.getCookies'))
    const until = Date.now() + 8000
    while (existsSync(portFile) && Date.now() < until) await new Promise(r => setTimeout(r, 100))
    assert.equal(existsSync(portFile), false, 'stale DevToolsActivePort removed')

    // Chrome is back (here: the fake answers again): the next call connects fresh
    answering = true
    writeFileSync(portFile, `${port}\n/devtools/browser/fake`)
    const c2 = await B.ensureBrowser()
    assert.notEqual(c2, c)
    assert.equal(B.browserStatus().connected, true)
    assert.equal(B.browserStatus().recoveries, before + 1)
    c2.close()
  } finally {
    wss.close(); http.close()
  }
})
