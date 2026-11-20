// A brand-new user: an empty home folder (no ~/.claude, no gh login, no git name), no perch data.
// perch must start, stay quiet (autonomy off, no PostHog project assumed), name nobody in
// particular, and keep setup gaps out of Health. Starts a real server on a spare port.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
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
    for (let i = 0; i < 100 && !out.includes('Mothership on http'); i++) await new Promise(r => setTimeout(r, 200))
    assert.match(out, /Mothership on http/, out)
    const s: any = await get('/api/settings')
    assert.equal(s.autonomy.enabled, false)
    assert.equal(s.welcome, true)
    assert.equal(s.posthog.projectId, 0)
    assert.deepEqual(JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')).autonomy, { enabled: false })
    // Give the startup checks (claude, gh) a moment to fail the way they do for a new user.
    await new Promise(r => setTimeout(r, 4000))
    const st: any = await get('/api/status')
    // No git name in this home, so the login name stands in (from the OS account, not $USER).
    const u = userInfo().username
    assert.equal(st.setup.owner, u[0].toUpperCase() + u.slice(1))
    assert.equal(st.claude?.loggedIn ?? false, false)
    const errs: any = await get('/api/errors')
    assert.deepEqual(errs.errors.filter((e: any) => e.status !== 'resolved').map((e: any) => e.message), [])
  } finally { srv.kill() }
})
