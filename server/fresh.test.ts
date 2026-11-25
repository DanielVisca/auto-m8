// A brand-new user: an empty home folder (no ~/.claude, no gh login, no git name), no perch data.
// perch must start, stay quiet (autonomy off, no PostHog project assumed), name nobody in
// particular, and keep setup gaps out of Health. Starts a real server on a spare port.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('a fresh install starts quiet, with the setup checklist on', { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'perch-fresh-home-')), data = mkdtempSync(join(tmpdir(), 'perch-fresh-data-'))
  const port = 4900 + Math.floor(Math.random() * 90)
  const srv = spawn(process.execPath, [join(import.meta.dirname, 'main.ts')], {
    env: { HOME: home, USER: 'newperson', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', PERCH_PORT: String(port), PERCH_DATA: data, PERCH_BROWSER_HEADLESS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  srv.stdout.on('data', d => { out += d }); srv.stderr.on('data', d => { out += d })
  try {
    const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { Host: `127.0.0.1:${port}` } }).then(r => r.json())
    for (let i = 0; i < 100 && !out.includes('auto-m8 on http'); i++) await new Promise(r => setTimeout(r, 200))
    assert.match(out, /auto-m8 on http/, out)
    const s: any = await get('/api/settings')
    assert.equal(s.autonomy.enabled, false)
    assert.equal(s.welcome, true)
    assert.equal(s.telemetry.enabled, true) // opt-out on fresh installs (still sends nothing without a key)
    assert.equal(s.nudges.enabled, true)
    assert.equal(s.posthog.projectId ?? null, null)
    assert.deepEqual(JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')).autonomy, { enabled: false })
    // Give the startup checks (claude, gh) a moment to fail the way they do for a new user.
    await new Promise(r => setTimeout(r, 4000))
    const st: any = await get('/api/status')
    // No git name in this home, so the login name stands in (from the OS account, not $USER).
    const u = userInfo().username
    assert.equal(st.setup.owner, u[0].toUpperCase() + u.slice(1))
    assert.equal(st.claude?.loggedIn ?? false, false)
    const d: any = await get('/api/onboarding/detect')
    assert.equal(d.claude.loggedIn, false)
    assert.equal(d.chats.claude, 0)
    assert.deepEqual(d.mcp, { claude: [], codex: [] })
    const errs: any = await get('/api/errors')
    assert.deepEqual(errs.errors.filter((e: any) => e.status !== 'resolved').map((e: any) => e.message), [])
  } finally { srv.kill() }
})

// An install that predates usage stats and the unblocker keeps both off, and sees no first run.
test('an existing install keeps telemetry and nudges off', { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'perch-old-home-')), data = mkdtempSync(join(tmpdir(), 'perch-old-data-'))
  writeFileSync(join(data, 'settings.json'), JSON.stringify({ autonomy: { enabled: true }, owner: { name: 'Ana' } }))
  const port = 4900 + Math.floor(Math.random() * 90)
  const srv = spawn(process.execPath, [join(import.meta.dirname, 'main.ts')], {
    env: { HOME: home, USER: 'ana', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', PERCH_PORT: String(port), PERCH_DATA: data, PERCH_BROWSER_HEADLESS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  srv.stdout.on('data', d => { out += d }); srv.stderr.on('data', d => { out += d })
  try {
    const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { Host: `127.0.0.1:${port}` } }).then(r => r.json())
    for (let i = 0; i < 100 && !out.includes('auto-m8 on http'); i++) await new Promise(r => setTimeout(r, 200))
    const s: any = await get('/api/settings')
    assert.equal(s.welcome, undefined)
    assert.equal(s.telemetry.enabled, false)
    assert.equal(s.nudges.enabled, false)
    assert.deepEqual(((await get('/api/suggestions')) as any).suggestions, [])
    assert.equal(existsSync(join(data, 'first-open')), false)
  } finally { srv.kill() }
})
