// On-demand, shared samples: no top process, polling agents, database writes or history on disk.
import { execFile } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import { cpus, freemem, homedir, loadavg, platform, totalmem } from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'

import type { Pressure, ResourceProcess, ResourceSnapshot } from '../shared/resources.ts'
export type { Pressure, ResourceProcess, ResourceSnapshot } from '../shared/resources.ts'
const GiB = 1024 ** 3, MiB = 1024 ** 2
const cpuTimes = () => cpus().reduce((sum, c) => ({ idle: sum.idle + c.times.idle, total: sum.total + Object.values(c.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 })
export function cpuUsage(before: { idle: number; total: number }, after: { idle: number; total: number }) {
  const total = after.total - before.total
  return total > 0 ? Math.max(0, Math.min(100, 100 * (1 - (after.idle - before.idle) / total))) : null
}
const command = (file: string, args: string[], timeout = 2000) => new Promise<string | null>(resolve => {
  execFile(file, args, { timeout, maxBuffer: 2 * MiB, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) => resolve(error ? null : stdout))
})
export function parseMacMemory(sysctl: string, vm: string) {
  const pageBytes = Number(vm.match(/page size of (\d+) bytes/)?.[1])
  const pages = (name: string) => { const n = vm.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm')); return n && pageBytes > 0 ? Number(n[1]) * pageBytes : null }
  const level = Number(sysctl.match(/kern\.memorystatus_vm_pressure_level:\s*(\d+)/)?.[1])
  const pressure: Pressure | null = level === 1 ? 'normal' : level === 2 ? 'warning' : level === 4 ? 'critical' : null
  const swap = sysctl.match(/used\s*=\s*([\d.]+)([KMG])/) // sysctl uses binary units
  const swapBytes = swap ? Number(swap[1]) * ({ K: 1024, M: MiB, G: GiB }[swap[2]] ?? 1) : null
  const free = pages('Pages free'), inactive = pages('Pages inactive'), speculative = pages('Pages speculative')
  const swapIn = pages('Swapins'), swapOut = pages('Swapouts')
  return { pressure, swapBytes, compressedBytes: pages('Pages occupied by compressor'),
    reclaimableBytes: free !== null && inactive !== null && speculative !== null ? free + inactive + speculative : null,
    swapIoBytes: swapIn !== null && swapOut !== null ? swapIn + swapOut : null }
}
export function parseProcesses(output: string, serverPid: number): ResourceProcess[] {
  const rows = output.split('\n').flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/)
    if (!m) return []
    const command = m[5], app = command.match(/\/([^/]+)\.app\//)?.[1]
    return [{ pid: Number(m[1]), parent: Number(m[2]), name: app ?? command.split('/').pop() ?? command,
      cpuPercent: Number(m[3]), memoryBytes: Number(m[4]) * 1024, perch: /\/perch\/node_modules\/electron\//.test(command) }]
  })
  const family = new Set([serverPid])
  // ps uses comm, never args: command-line tokens, prompts and secrets stay out of the API.
  for (let i = 0; i < rows.length; i++) {
    const before = family.size
    for (const p of rows) if (family.has(p.parent)) family.add(p.pid)
    if (family.size === before) break
  }
  const processes = rows.map(({ parent, ...p }) => ({ ...p, perch: p.perch || family.has(p.pid) }))
  // Show both CPU hogs and memory hogs; a sleeping local model can be the largest consumer.
  const byCpu = [...processes].sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 5)
  const byMemory = [...processes].sort((a, b) => b.memoryBytes - a.memoryBytes).slice(0, 5)
  return [...new Map([...byCpu, ...byMemory].map(p => [p.pid, p])).values()]
}
export function resourcePressure(s: Pick<ResourceSnapshot, 'cpuPercent' | 'memory' | 'disk' | 'perch'>) {
  let severity: Pressure = 'normal'
  const reasons: ResourceSnapshot['reasons'] = []
  const add = (level: Pressure, label: string, detail: string) => { if (level === 'critical' || severity === 'normal') severity = level; reasons.push({ label, detail }) }
  if (s.memory.pressure && s.memory.pressure !== 'normal') add(s.memory.pressure, 'Memory pressure', s.memory.pressure === 'critical' ? 'macOS reports critical memory pressure.' : 'macOS is compressing or reclaiming memory to keep up.')
  if ((s.memory.swapBytesPerSecond ?? 0) >= 10 * MiB) add(s.memory.swapBytesPerSecond! >= 50 * MiB ? 'critical' : 'warning', 'Swapping', 'Memory is moving between RAM and disk, which can make apps pause.')
  if ((s.cpuPercent ?? 0) >= 85) add(s.cpuPercent! >= 95 ? 'critical' : 'warning', 'CPU busy', 'Most CPU capacity is in use; apps and builds are competing for time.')
  if (s.disk && (s.disk.availableBytes < 20 * GiB || s.disk.availableBytes / s.disk.totalBytes < 0.05)) add(s.disk.availableBytes < 5 * GiB || s.disk.availableBytes / s.disk.totalBytes < 0.02 ? 'critical' : 'warning', 'Disk nearly full', 'Low free space can slow builds and leave less room for swap.')
  if (s.perch.eventLoopDelayMs >= 1000) add(s.perch.eventLoopDelayMs >= 3000 ? 'critical' : 'warning', 'Perch delayed', 'Perch’s server paused while handling work. Mac pressure can contribute too.')
  return { severity, reasons }
}

let previousCpu = cpuTimes(), previousSwap: { bytes: number; at: number } | null = null
let cached: ResourceSnapshot | null = null, pending: Promise<ResourceSnapshot> | null = null
let disk: ResourceSnapshot['disk'] = null, diskAt = 0
let processCache: ResourceProcess[] = [], processesAt = 0
let processesPending = false, processError = false
const loopDelay = monitorEventLoopDelay({ resolution: 100 })
let loopStarted = false

async function sample(): Promise<ResourceSnapshot> {
  if (!loopStarted) { loopDelay.enable(); loopStarted = true }
  const now = Date.now(), mac = platform() === 'darwin', unavailable: string[] = []
  const nextCpu = cpuTimes(), cpuPercent = cpuUsage(previousCpu, nextCpu); previousCpu = nextCpu
  // ps is the most expensive probe on an overloaded Mac. Never make the resource read wait for it.
  if (!processesPending && now - processesAt >= 15_000) {
    processesAt = now; processesPending = true
    void command('/bin/ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,comm='], 5000).then(output => {
      processError = output === null
      if (output !== null) processCache = parseProcesses(output, process.pid)
    }).finally(() => { processesPending = false })
  }
  const [sysctl, vm, volume] = await Promise.all([
    mac ? command('/usr/sbin/sysctl', ['kern.memorystatus_vm_pressure_level', 'vm.swapusage']) : null,
    mac ? command('/usr/bin/vm_stat', []) : null,
    now - diskAt >= 60_000 ? statfs(homedir()).catch(() => null) : null,
  ])
  const memory = mac ? parseMacMemory(sysctl ?? '', vm ?? '') : null
  if (!memory || memory.pressure === null || memory.compressedBytes === null || memory.swapBytes === null) unavailable.push('macOS memory details')
  if (processError) unavailable.push('process list (last successful sample shown)')
  if (now - diskAt >= 60_000) { disk = volume ? { availableBytes: volume.bavail * volume.bsize, totalBytes: volume.blocks * volume.bsize } : null; diskAt = now }
  if (!disk) unavailable.push('disk space')
  let swapBytesPerSecond: number | null = null
  if (memory?.swapIoBytes !== null && memory?.swapIoBytes !== undefined) {
    const elapsed = previousSwap ? now - previousSwap.at : 0
    if (previousSwap && elapsed > 0 && elapsed < 30_000 && memory.swapIoBytes >= previousSwap.bytes) swapBytesPerSecond = (memory.swapIoBytes - previousSwap.bytes) * 1000 / elapsed
    previousSwap = { bytes: memory.swapIoBytes, at: now }
  }
  const total = totalmem(), eventLoopDelayMs = cached && now - cached.sampledAt < 30_000 ? Math.max(0, Math.round(loopDelay.max / 1e6 - 100)) : 0
  loopDelay.reset()
  const snapshot = { sampledAt: now, cpuPercent, cores: cpus().length, load: loadavg()[0],
    memory: { totalBytes: total, usedBytes: Math.max(0, total - (memory?.reclaimableBytes ?? freemem())), compressedBytes: memory?.compressedBytes ?? null, pressure: memory?.pressure ?? null, swapBytes: memory?.swapBytes ?? null, swapBytesPerSecond },
    disk, perch: { pid: process.pid, memoryBytes: process.memoryUsage().rss, eventLoopDelayMs }, processes: processCache, unavailable }
  return { ...snapshot, ...resourcePressure(snapshot) }
}
export function localResources(): Promise<ResourceSnapshot> {
  if (cached && Date.now() - cached.sampledAt < 4500) return Promise.resolve(cached)
  if (pending) return pending
  pending = sample().then(s => { cached = s; return s }).finally(() => { pending = null })
  return pending
}
