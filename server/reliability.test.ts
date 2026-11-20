// The 2026-11-14 incident: test fixtures in the live db crashed the shepherd, and a test file run
// on its own could write there at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from './db.ts'
import './shepherdstore.ts'
import { backfillDecisions } from './shepherd.ts'

test('backfillDecisions skips rows that are not PR URLs instead of throwing from its timer', () => {
  run(`insert or replace into shepherd_watch (url, enabled, source, created_at, stage, outcome) values ('r/stopped', 1, 'auto', 0, 'failed', 'NEEDS YOU: no verification after 9 tries')`)
  run(`insert or replace into shepherd_watch (url, enabled, source, created_at, stage, outcome) values ('https://github.com/PostHog/posthog/pull/1', 1, 'auto', 0, 'failed', 'NEEDS YOU: no verification after 9 tries')`)
  assert.doesNotThrow(() => backfillDecisions())
})

test('a test file run on its own, without PERCH_DB/PERCH_DATA, gets an in-memory db and a temp data folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perch-guard-'))
  const probe = join(dir, 'probe.test.mjs')
  writeFileSync(probe, `import { DATA_DIR } from ${JSON.stringify(join(import.meta.dirname, 'settings.ts'))}\nconsole.log('PROBE', process.env.PERCH_DB, DATA_DIR)\n`)
  const env = { ...process.env }; delete env.PERCH_DB; delete env.PERCH_DATA; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--test', probe], { env, encoding: 'utf8' })
  const line = (r.stdout + r.stderr).split('\n').find(l => l.includes('PROBE')) ?? ''
  assert.match(line, /PROBE :memory: \S*perch-test-/, r.stdout + r.stderr)
  assert.doesNotMatch(line, /Application Support/)
})

test('tests launched from a Perch agent cannot inherit its live data or database paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perch-inherited-guard-'))
  const probe = join(dir, 'probe.test.mjs')
  writeFileSync(probe, `import { DATA_DIR } from ${JSON.stringify(join(import.meta.dirname, 'settings.ts'))}\nconsole.log('PROBE', process.env.PERCH_DB, DATA_DIR)\n`)
  const live = join(process.env.HOME!, 'Library/Application Support/perch')
  const env: NodeJS.ProcessEnv = { ...process.env, PERCH_DATA: live, PERCH_DB: join(live, 'perch.db') }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--test', probe], { env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const line = r.stdout.split('\n').find(l => l.includes('PROBE')) ?? ''
  assert.match(line, /PROBE :memory: \S*perch-test-/)
  assert.doesNotMatch(line, /Application Support/)
})
