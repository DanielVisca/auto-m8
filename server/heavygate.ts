// Heavy checks run a few at a time, machine-wide. One full typecheck of a big repo takes 6-14 GB:
// on 2026-11-25 four agents each ran theirs at once (two typechecks at 14 + 6 GB, a pre-push
// preflight, a test run), the Mac went to 24 GB compressed with 128 MB free, and everything swapped,
// auto-m8's own server included (a health check took 74 s). The rule "don't run full suites in
// several checkouts at once" was only an instruction; this enforces it.
//
// Hooks passed to every claude auto-m8 starts:
//   PreToolUse on Bash: a heavy command in a big repo takes a slot (one for typecheck/build/push,
//     two for test runs). If they're all taken, the command is blocked with a note naming who has
//     them, so the agent can wait and try again. Nothing is ever auto-approved here.
//   PostToolUse on Bash: the command finished, its slot is free. A background command keeps its slot
//     until it ages out. A slot also frees when the agent holding it exits, or after MAX_AGE.
import { execFileSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export const SLOTS = { build: 1, test: 2 } as const
type Kind = keyof typeof SLOTS
const DIR = process.env.PERCH_HEAVY_DIR ?? join(homedir(), 'Library', 'Application Support', 'perch', 'heavy-slots')

// A command word at a command position (start, after ; & | ( or newline, optionally after VAR=x or
// a runner such as pnpm exec / npx / uv run / flox activate --), not a word inside text.
const at = (re: string) => new RegExp(String.raw`(?:^|[;&|(\n]|\$\()\s*(?:\w+=\S*\s+)*(?:(?:pnpm|npx|uv|poetry|flox)\s+(?:exec|run|activate\s+--)?\s*)?` + re)
const BUILD = [at(String.raw`(?:tsc|tsgo)\b`), /typescript[:-]check|hogli\s+(?:ci:preflight|build|typescript)/, at(String.raw`(?:pnpm|npm|yarn)\s+(?:-\S+\s+)*(?:run\s+)?(?:build|typecheck|typescript:check)\b`), at(String.raw`git\s+push\b`), at(String.raw`(?:vite|next)\s+build\b`)]
const TEST = [at(String.raw`(?:python\S*\s+-m\s+)?pytest\b`), at(String.raw`(?:jest|vitest)\b`), at(String.raw`(?:pnpm|npm|yarn)\s+(?:-\S+\s+)*(?:run\s+)?test\b`), at(String.raw`cargo\s+(?:test|nextest)\b`)]

// Only big repos: a typecheck of auto-m8 itself or a small repo is quick and cheap.
export const bigRepo = (cwd: string, cmd: string) => /\/posthog(?:[-/]|$)|\/\.perch-worktrees\/posthog/.test(cwd) || /\bcd\s+\S*\/(?:\.perch-worktrees\/)?posthog/.test(cmd)

export function classify(cmd: string, cwd: string): Kind | null {
  if (!bigRepo(cwd, cmd)) return null
  if (BUILD.some(r => r.test(cmd))) return 'build'
  if (TEST.some(r => r.test(cmd))) return 'test'
  return null
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' } }
const MAX_AGE = { fg: 15 * 60_000, bg: 30 * 60_000 }
type Slot = { kind: Kind; tool: string; pid: number; bg: boolean; at: number; cwd: string; cmd: string; file: string }

function held(kind?: Kind, now = Date.now()): Slot[] {
  mkdirSync(DIR, { recursive: true })
  const out: Slot[] = []
  for (const f of readdirSync(DIR)) {
    const file = join(DIR, f)
    try {
      const h = JSON.parse(readFileSync(file, 'utf8'))
      if ((h.pid && !alive(h.pid)) || now - h.at > (h.bg ? MAX_AGE.bg : MAX_AGE.fg)) { rmSync(file, { force: true }); continue }
      if (!kind || h.kind === kind) out.push({ ...h, file })
    } catch { rmSync(file, { force: true }) }
  }
  return out
}

export function take(kind: Kind, slot: Omit<Slot, 'kind' | 'file' | 'at'>, now = Date.now()): boolean {
  held(kind, now) // clears stale slots
  for (let i = 0; i < SLOTS[kind]; i++) {
    try {
      const fd = openSync(join(DIR, `${kind}-${i}`), 'wx') // atomic: only one taker wins a slot
      writeSync(fd, JSON.stringify({ ...slot, kind, at: now })); closeSync(fd)
      return true
    } catch {}
  }
  return false
}

export function release(tool: string) {
  for (const h of held()) if (h.tool === tool && !h.bg) rmSync(h.file, { force: true })
}

const describe = (h: Slot) => `${basename(h.cwd)}: ${h.cmd.replace(/\s+/g, ' ').slice(0, 80)} (${Math.round((Date.now() - h.at) / 60_000)} min)`

// The claude process running this hook (hook → sh → claude): the slot is free once it exits.
function agentPid(): number {
  let pid = process.ppid
  for (let i = 0; i < 4 && pid > 1; i++) {
    try {
      const [pp, ...comm] = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/)
      if (/claude|node/.test(comm.join(' ')) && !/sh$/.test(comm.join(' '))) return pid
      pid = Number(pp)
    } catch { break }
  }
  return 0
}

export function hook(payload: any, pid = 0): object | null {
  if (payload?.tool_name !== 'Bash') return null
  const ti = payload.tool_input ?? {}
  const tool = String(payload.tool_use_id ?? '')
  if (payload.hook_event_name === 'PostToolUse' || payload.hook_event_name === 'PostToolUseFailure') { if (tool) release(tool); return null }
  const cmd = String(ti.command ?? '')
  const cwd = String(payload.cwd ?? '')
  const kind = classify(cmd, cwd)
  if (!kind) return null
  if (take(kind, { tool, pid, bg: !!ti.run_in_background, cwd, cmd: cmd.split('\n')[0].slice(0, 200) })) return null
  const reason = `auto-m8: ${kind === 'build' ? 'a typecheck/build/push' : 'test runs'} already running in another checkout (${held(kind).map(describe).join('; ')}). ` +
    `Heavy checks run ${SLOTS[kind]} at a time machine-wide so the Mac doesn't run out of memory. Do other work and try again in a few minutes; don't work around this.`
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
}

if (import.meta.main) {
  let raw = ''
  process.stdin.on('data', d => { raw += d })
  process.stdin.on('end', () => {
    try {
      const payload = JSON.parse(raw)
      const out = hook(payload, payload.hook_event_name === 'PreToolUse' ? agentPid() : 0)
      if (out) process.stdout.write(JSON.stringify(out))
    } catch {}
    process.exit(0)
  })
}
