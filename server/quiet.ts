// Is the Mac quiet enough for heavy background work (a local model's shadow replay)?
// Samples once a minute: load, memory the system could hand out, swap, how long since the
// user last touched the keyboard or mouse, and how many perch chats are working. Background
// work starts only after the machine has been quiet for a sustained window, and is told to back
// off when the user is active and the machine is under pressure.
import { execFile } from 'node:child_process'
import { cpus, loadavg } from 'node:os'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export type Sample = { at: number; load1: number; cores: number; availBytes: number; swapUsedBytes: number; userIdleSec: number; busyChats: number }

const samples: Sample[] = []
const KEEP = 120 // two hours of minutes
let busyChats = () => 0

// Pages macOS can hand out without swapping: free + inactive + speculative + purgeable.
export function parseVmStat(out: string): number {
  const page = Number(out.match(/page size of (\d+) bytes/)?.[1] ?? 16384)
  const n = (k: string) => Number(out.match(new RegExp(`Pages ${k}:\\s+(\\d+)`))?.[1] ?? 0)
  return (n('free') + n('inactive') + n('speculative') + n('purgeable')) * page
}
export function parseSwap(out: string): number {
  const m = out.match(/used = ([\d.]+)([MG])/)
  return m ? Number(m[1]) * (m[2] === 'G' ? 1024 ** 3 : 1024 ** 2) : 0
}
export const parseHidIdle = (out: string) => { const m = out.match(/"HIDIdleTime" = (\d+)/); return m ? Number(m[1]) / 1e9 : 0 }

async function sample(): Promise<Sample> {
  const run = (cmd: string, args: string[]) => exec(cmd, args, { timeout: 10_000, maxBuffer: 5e6 }).then(r => r.stdout, () => '')
  const [vm, swap, hid] = await Promise.all([run('vm_stat', []), run('sysctl', ['vm.swapusage']), run('ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-r', '-k', 'HIDIdleTime'])])
  return { at: Date.now(), load1: loadavg()[0], cores: cpus().length, availBytes: parseVmStat(vm), swapUsedBytes: parseSwap(swap), userIdleSec: parseHidIdle(hid), busyChats: busyChats() }
}

export type Need = { bytes: number; minutes: number }
const GB = 1024 ** 3
const HEADROOM = 4 * GB

// One minute is quiet when the work fits in memory with room to spare and either you've stepped
// away, or the machine is lightly loaded with at most one agent working.
export function quietSample(s: Sample, needBytes: number) {
  if (s.availBytes < needBytes + HEADROOM) return false
  if (s.userIdleSec >= 10 * 60) return s.load1 < s.cores * 0.8
  return s.load1 < s.cores * 0.35 && s.busyChats <= 1
}

// Quiet for the whole window, with no gaps in the samples (a sleeping Mac doesn't count as quiet).
export function quietFor(list: Sample[], need: Need, now = Date.now()) {
  const from = now - need.minutes * 60_000
  const win = list.filter(s => s.at >= from)
  if (win.length < Math.max(1, need.minutes - 2)) return false
  return win.every(s => quietSample(s, need.bytes))
}

// While a heavy job runs: back off when you're at the machine and it's struggling, for three
// minutes running (swap growing, memory nearly gone, or load past the core count).
export function underPressure(list: Sample[]) {
  const last = list.slice(-3)
  if (last.length < 3) return false
  const swapGrew = last[2].swapUsedBytes - last[0].swapUsedBytes > 1 * GB
  return last.every(s => s.userIdleSec < 120 && (s.availBytes < 2 * GB || s.load1 > s.cores * 1.1 || swapGrew))
}

export const isQuiet = (need: Need) => quietFor(samples, need)
export const lastSample = (): Sample | undefined => samples.at(-1)
export const isUnderPressure = () => underPressure(samples)
export function quietState(need: Need) {
  const s = samples.at(-1)
  if (!s) return { quiet: false, reason: 'measuring', sample: null }
  const quietMins = (() => { let n = 0; for (let i = samples.length - 1; i >= 0 && quietSample(samples[i], need.bytes); i--) n++; return n })()
  const reason = s.availBytes < need.bytes + HEADROOM ? `needs ${((need.bytes + HEADROOM) / GB).toFixed(0)} GB free, ${(s.availBytes / GB).toFixed(1)} GB available`
    : !quietSample(s, need.bytes) ? `busy: load ${s.load1.toFixed(1)} on ${s.cores} cores, ${s.busyChats} agents working`
    : quietMins < need.minutes ? `quiet for ${quietMins} of ${need.minutes} min` : 'quiet'
  return { quiet: isQuiet(need), reason, quietMins, sample: s }
}

export function startQuiet(countBusy: () => number) {
  busyChats = countBusy
  const tick = () => sample().then(s => { samples.push(s); if (samples.length > KEEP) samples.shift() }).catch(() => {})
  tick()
  setInterval(tick, 60_000).unref()
}
