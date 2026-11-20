import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { withToolDirs } from './path.ts'

test('withToolDirs puts ~/.local/bin (native claude install) on a login-shell PATH, once', () => {
  const home = mkdtempSync(join(tmpdir(), 'perch-home-'))
  mkdirSync(join(home, '.local/bin'), { recursive: true })
  const p = withToolDirs('/usr/bin:/bin', home).split(':')
  assert.equal(p[0], join(home, '.local/bin'))
  assert.ok(!p.includes(join(home, '.claude/local')), 'skips folders that do not exist')
  assert.equal(withToolDirs(p.join(':'), home).split(':').filter(d => d === join(home, '.local/bin')).length, 1)
})
