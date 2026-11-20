import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpuUsage, localResources, parseMacMemory, parseProcesses, resourcePressure, type ResourceSnapshot } from './resources.ts'
import { ResourcePressureGate } from '../web/src/resourceStatus.ts'

const GiB = 1024 ** 3, MiB = 1024 ** 2
const comfortable = (): Pick<ResourceSnapshot, 'cpuPercent' | 'memory' | 'disk' | 'perch'> => ({
  cpuPercent: 20, memory: { totalBytes: 48 * GiB, usedBytes: 47 * GiB, pressure: 'normal', compressedBytes: 10 * GiB, swapBytes: 19 * GiB, swapBytesPerSecond: 0 },
  disk: { totalBytes: 1000 * GiB, availableBytes: 200 * GiB }, perch: { pid: 1, memoryBytes: GiB, eventLoopDelayMs: 0 },
})

test('CPU is measured between samples and accounts for every core', () => {
  assert.equal(cpuUsage({ idle: 100, total: 1000 }, { idle: 125, total: 1100 }), 75)
  assert.equal(cpuUsage({ idle: 100, total: 1000 }, { idle: 100, total: 1000 }), null)
})
test('Mac memory uses the reported page size and kernel pressure, including incomplete results', () => {
  const vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 20.\nPages speculative: 30.\nPages occupied by compressor: 40.\nSwapins: 50.\nSwapouts: 60.'
  const parsed = parseMacMemory('kern.memorystatus_vm_pressure_level: 2\nvm.swapusage: total = 20480.00M used = 19189.69M free = 1290.31M (encrypted)', vm)
  assert.equal(parsed.pressure, 'warning')
  assert.equal(parsed.reclaimableBytes, 60 * 16384)
  assert.equal(parsed.compressedBytes, 40 * 16384)
  assert.equal(parsed.swapIoBytes, 110 * 16384)
  assert.equal(parsed.swapBytes, 19189.69 * MiB)
  assert.equal(parseMacMemory('kern.memorystatus_vm_pressure_level: 4', vm).pressure, 'critical')
  assert.equal(parseMacMemory('', '').pressure, null)
  assert.equal(parseMacMemory('', '').swapIoBytes, null)
})
test('high RAM occupancy and old swap allocation alone do not imply a slow Mac', () => {
  assert.deepEqual(resourcePressure(comfortable()), { severity: 'normal', reasons: [] })
  const s = comfortable(); s.memory.pressure = 'warning'
  assert.equal(resourcePressure(s).severity, 'warning')
  s.memory.swapBytesPerSecond = 60 * MiB
  assert.equal(resourcePressure(s).severity, 'critical')
  assert.equal(resourcePressure(s).reasons[1].label, 'Swapping')
})
test('CPU, disk and Perch stalls can each identify the bottleneck', () => {
  const cpu = comfortable(); cpu.cpuPercent = 96
  assert.equal(resourcePressure(cpu).severity, 'critical')
  assert.equal(resourcePressure(cpu).reasons[0].label, 'CPU busy')
  const disk = comfortable(); disk.disk!.availableBytes = 4 * GiB
  assert.equal(resourcePressure(disk).reasons[0].label, 'Disk nearly full')
  const perch = comfortable(); perch.perch.eventLoopDelayMs = 3500
  assert.equal(resourcePressure(perch).reasons[0].label, 'Mothership delayed')
})
test('indicator ignores spikes, waits for recovery and starts fresh after sleep', () => {
  const gate = new ResourcePressureGate()
  assert.equal(gate.update('critical', 0), 'normal')
  assert.equal(gate.update('normal', 5000), 'normal')
  assert.equal(gate.update('warning', 10000), 'normal')
  assert.equal(gate.update('warning', 15000), 'normal')
  assert.equal(gate.update('critical', 20000), 'critical')
  assert.equal(gate.update('normal', 25000), 'critical')
  for (const t of [30000, 35000, 40000]) assert.equal(gate.update('normal', t), 'critical')
  assert.equal(gate.update('normal', 45000), 'normal')
  gate.update('critical', 50000)
  assert.equal(gate.update('critical', 100000), 'normal')
})
test('process list includes memory hogs and identifies Perch descendants regardless of ps order', () => {
  const rows = ['4 3 1.0 100 /usr/bin/python', '3 2 2.0 100 /usr/bin/node', '2 1 3.0 100 /usr/bin/node',
    '5 1 0.1 20000000 /Applications/Ollama.app/Contents/Resources/llama-server',
    '6 1 100.0 100 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '7 1 2.0 100 /Users/me/Development/perch/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    ...Array.from({ length: 10 }, (_, i) => `${10 + i} 1 50.0 100 /usr/bin/build`)].join('\n')
  const result = parseProcesses(rows, 2)
  assert.ok(result.some(p => p.name === 'Ollama' && p.memoryBytes === 20000000 * 1024))
  assert.ok(result.some(p => p.name === 'Google Chrome' && p.cpuPercent === 100))
  // With a small set all Perch descendants are visible in one of the top lists.
  const family = parseProcesses(rows.split('\n').slice(0, 3).join('\n'), 2)
  assert.ok(family.every(p => p.perch))
  assert.equal(parseProcesses(rows.split('\n')[5], 2)[0].perch, true)
  assert.deepEqual(parseProcesses('unavailable', 2), [])
})
test('concurrent windows share one bounded sample and subsequent reads use the cache', async () => {
  const a = localResources(), b = localResources()
  assert.equal(a, b)
  const sample = await a
  assert.equal(await localResources(), sample)
  assert.ok(sample.memory.totalBytes > 0)
  assert.ok(sample.cpuPercent === null || (sample.cpuPercent >= 0 && sample.cpuPercent <= 100))
})
