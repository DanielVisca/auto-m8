import test from 'node:test'
import assert from 'node:assert/strict'
import { settings, updateSettings } from './settings.ts'
import { held, hold, shouldHold, clearHeld } from './pausehold.ts'
import { overview, pauseAll, resumeAll } from './pause.ts'

test('pause holds automation sends but never yours', () => {
  updateSettings({ autonomy: { enabled: true } })
  assert.equal(shouldHold({ by: 'routine' }), false, 'nothing is held while running')
  pauseAll('test')
  assert.equal(settings.autonomy.enabled, false)
  assert.equal(shouldHold({ by: 'routine' }), true)
  assert.equal(shouldHold({ by: 'shepherd' }), true)
  assert.equal(shouldHold({}), true, 'an agent-to-agent send has no by and is held')
  assert.equal(shouldHold({ by: 'you' }), false)
  assert.equal(shouldHold({ by: 'routine', manual: true }), false, 'Run now / Nudge are you')
  assert.equal(shouldHold({ by: 'routine', retry: true }), false)
  hold({ by: 'routine', id: 'c1', prompt: 'daily report\nmore' })
  assert.equal(held().length, 1)
  const o = overview()
  assert.equal(o.paused, true)
  assert.equal(o.counts.held, 1)
  assert.ok(o.since)
  resumeAll({ restart: false })
  assert.equal(settings.autonomy.enabled, true)
  assert.equal(overview().paused, false)
  assert.equal(held().length, 0, 'held messages are cleared on resume; due work re-fires from its own state')
  clearHeld()
})
