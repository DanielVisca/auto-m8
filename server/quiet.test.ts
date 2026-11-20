import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseHidIdle, parseSwap, parseVmStat, quietFor, quietSample, underPressure, type Sample } from './quiet.ts'

const GB = 1024 ** 3
const s = (o: Partial<Sample> = {}, at = Date.now()): Sample => ({ at, load1: 2, cores: 15, availBytes: 30 * GB, swapUsedBytes: 0, userIdleSec: 0, busyChats: 0, ...o })
const mins = (n: number, o: Partial<Sample> = {}, now = Date.now()) => Array.from({ length: n }, (_, i) => s(o, now - (n - 1 - i) * 60_000))

test('parses vm_stat, swap and HID idle', () => {
  assert.equal(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  10.\nPages inactive:  20.\nPages speculative:  5.\nPages purgeable:  5.\n'), 40 * 16384)
  assert.equal(parseSwap('vm.swapusage: total = 18432.00M  used = 17015.75M  free = 1416.25M  (encrypted)'), 17015.75 * 1024 ** 2)
  assert.equal(parseHidIdle('  |   "HIDIdleTime" = 55494916000'), 55.494916)
})

test('a minute is quiet only when the model fits with headroom', () => {
  assert.equal(quietSample(s({ availBytes: 22 * GB }), 20 * GB), false)
  assert.equal(quietSample(s({ availBytes: 25 * GB }), 20 * GB), true)
})

test('at the keyboard: quiet needs low load and at most one agent working', () => {
  assert.equal(quietSample(s({ load1: 10 }), 0), false)
  assert.equal(quietSample(s({ busyChats: 3 }), 0), false)
  assert.equal(quietSample(s({ busyChats: 1 }), 0), true)
})

test('stepped away: busier machine is fine, short of saturated', () => {
  assert.equal(quietSample(s({ userIdleSec: 900, load1: 10, busyChats: 4 }), 0), true)
  assert.equal(quietSample(s({ userIdleSec: 900, load1: 14 }), 0), false)
})

test('quiet for the whole window, no gaps, no single busy minute', () => {
  assert.equal(quietFor(mins(20), { bytes: 0, minutes: 20 }), true)
  assert.equal(quietFor(mins(5), { bytes: 0, minutes: 20 }), false) // just restarted or the Mac slept
  const l = mins(20); l[10] = { ...l[10], load1: 12 }
  assert.equal(quietFor(l, { bytes: 0, minutes: 20 }), false)
})

test('back off only when the user is active and the machine struggles for 3 minutes', () => {
  assert.equal(underPressure(mins(3, { availBytes: 1 * GB })), true)
  assert.equal(underPressure(mins(3, { availBytes: 1 * GB, userIdleSec: 600 })), false)
  assert.equal(underPressure(mins(2, { availBytes: 1 * GB })), false)
  assert.equal(underPressure([s({ swapUsedBytes: 0 }), s({ swapUsedBytes: 1 * GB }), s({ swapUsedBytes: 2.5 * GB })]), true)
})
