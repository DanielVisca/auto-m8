import { spawn } from 'node:child_process'
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type RunRecord<T = any> = { id: string; pid: number; offset: number; started: number; data: T }
export type RunExit = { code: number | null; signal: string | null; error?: string; at: number }
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const save = (path: string, value: unknown) => {
  writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

export function savedRuns<T>(root: string): RunRecord<T>[] {
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap(id => {
    try { return [JSON.parse(readFileSync(join(root, id, 'meta.json'), 'utf8'))] } catch { return [] }
  })
}

// Replaying old lines rebuilds the consumer's accumulated text/usage without counting or emitting
// those events again. Acknowledgement is explicit: a completed run stays recoverable until its
// result and any queued messages have been handled.
export function durableRun<T>(o: {
  root: string; id: string; data: T; command: string; args: string[]; cwd: string;
  env?: NodeJS.ProcessEnv; resume?: RunRecord<T>
}, onLine: (line: string, replay: boolean) => void) {
  const dir = join(o.root, o.id), metaPath = join(dir, 'meta.json'), exitPath = join(dir, 'exit.json')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  let record = o.resume
  if (!record) {
    const out = openSync(join(dir, 'stdout'), 'wx', 0o600), err = openSync(join(dir, 'stderr'), 'wx', 0o600)
    try {
      const worker = spawn(process.execPath, [join(import.meta.dirname, 'durable-worker.mjs'), exitPath, o.command, ...o.args], {
        cwd: o.cwd, env: o.env, stdio: ['ignore', out, err], detached: true,
      })
      worker.unref()
      record = { id: o.id, pid: worker.pid ?? 0, offset: 0, started: Date.now(), data: o.data }
      worker.on('error', e => save(exitPath, { code: 1, signal: null, error: e.message, at: Date.now() }))
      save(metaPath, record)
    } finally { closeSync(out); closeSync(err) }
  }
  const state = record
  const previousOffset = state.offset
  let savedOffset = state.offset
  const fd = openSync(join(dir, 'stdout'), 'r')
  let cursor = 0, consumed = 0, pending = Buffer.alloc(0), stopped = false
  let resolve!: (value: RunExit & { stderr: string }) => void
  const done = new Promise<RunExit & { stderr: string }>(r => { resolve = r })
  const stop = () => { if (!stopped) { stopped = true; clearInterval(timer); closeSync(fd) } }
  const poll = () => {
    if (stopped) return
    try {
      const size = fstatSync(fd).size
      while (cursor < size) {
        const b = Buffer.alloc(Math.min(size - cursor, 1 << 20))
        const n = readSync(fd, b, 0, b.length, cursor)
        if (!n) break
        cursor += n
        pending = Buffer.concat([pending, b.subarray(0, n)])
        let end: number
        while ((end = pending.indexOf(10)) >= 0) {
          const line = pending.subarray(0, end).toString('utf8')
          consumed += end + 1
          pending = pending.subarray(end + 1)
          onLine(line, consumed <= previousOffset)
          state.offset = consumed
        }
      }
      if (state.offset !== savedOffset) { save(metaPath, state); savedOffset = state.offset }
      let exit: RunExit | null = null
      if (existsSync(exitPath)) exit = JSON.parse(readFileSync(exitPath, 'utf8'))
      else if (!state.pid || !alive(state.pid)) exit = { code: null, signal: null, error: 'agent process died without an exit status', at: Date.now() }
      if (exit) {
        // The child can finish between our fstat and its status-file write. Drain its last bytes.
        if (fstatSync(fd).size > cursor) return
        stop()
        let stderr = ''
        try { stderr = readFileSync(join(dir, 'stderr'), 'utf8').slice(-4000) } catch {}
        resolve({ ...exit, stderr })
      }
    } catch (e) { console.error('reading durable agent output', o.id, e) }
  }
  const timer = setInterval(poll, 150)
  timer.unref()
  return {
    record: state, done,
    kill(signal: NodeJS.Signals = 'SIGTERM') { if (state.pid > 0) try { process.kill(-state.pid, signal) } catch {} },
    update(data: T) { state.data = data; save(metaPath, state) },
    // stop only detaches this reader. It must never stop the agent during a server restart.
    stop,
    acknowledge() { stop(); rmSync(dir, { recursive: true, force: true }) },
  }
}
