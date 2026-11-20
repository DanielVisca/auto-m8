// Real terminals over node-pty. They outlive the browser tab: reopening shows the scrollback.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import * as pty from 'node-pty'
import { childEnv } from './chat.ts'
import { claudeEnv } from './account.ts'
import { settings } from './settings.ts'

export type Term = {
  id: string; title: string; cwd: string; cmd?: string; conversationId?: string
  p: pty.IPty; buf: string; exited: boolean; listeners: Set<(d: string) => void>; createdAt: number
  // An agent's terminal: the conversation that owns it gets woken when it finishes, waits for input or exits.
  owner?: string; needsUser?: string; shell: string
  lastOut: number; total: number; fg: string; quietReported: boolean; busyTicks: number; enterAt: number
}
export type TermState = 'at prompt' | 'running' | 'waiting for input' | 'exited'
const QUIET_WAITING_MS = 8_000 // a command that has printed nothing for this long is probably waiting on someone

export const terms = new Map<string, Term>()
export const onTermsChange = new Set<() => void>()
const changed = () => onTermsChange.forEach(f => f())
const SCROLLBACK = 300_000

// A command typed at the prompt but not run: bracketed paste, so multi-line text waits for Enter too.
export const pasteText = (cmd: string) => `\x1b[200~${cmd.replace(/\x1b\[20[01]~/g, '')}\x1b[201~`

export function createTerm(opts: { cwd?: string; cmd?: string; title?: string; conversationId?: string; configDir?: string; prefill?: string; run?: boolean; owner?: string; needsUser?: string }) {
  const id = randomUUID()
  const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : settings.chat.cwd
  const shell = process.env.SHELL ?? '/bin/zsh'
  // A command runs in a login shell, then drops to an interactive shell so the tab stays useful.
  const args = opts.cmd ? ['-lc', `${opts.cmd}; exec ${shell} -l`] : ['-l']
  const p = pty.spawn(shell, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd, env: childEnv(opts.configDir, claudeEnv()) as any })
  const t: Term = { id, title: opts.title ?? (opts.prefill ? opts.prefill.split('\n')[0].split(' ').slice(0, 3).join(' ') : opts.cmd ? opts.cmd.split(' ').slice(0, 3).join(' ') : cwd.split('/').pop()!), cwd, cmd: opts.cmd,
    conversationId: opts.conversationId, p, buf: '', exited: false, listeners: new Set(), createdAt: Date.now(),
    owner: opts.owner, needsUser: opts.needsUser, shell: shell.split('/').pop()!, lastOut: Date.now(), total: 0, fg: '', quietReported: false, busyTicks: 0, enterAt: 0 }
  p.onData(d => {
    t.buf = (t.buf + d).slice(-SCROLLBACK)
    t.total += d.length; t.lastOut = Date.now(); t.quietReported = false
    t.listeners.forEach(l => l(d))
    if (opts.prefill) armPrefill()
  })
  // Type the prefill once the shell has drawn its prompt (output then quiet), or after 4s regardless.
  let prefillTimer: ReturnType<typeof setTimeout> | undefined
  const typePrefill = () => { if (!opts.prefill || t.exited) return; const text = opts.prefill; opts.prefill = undefined; clearTimeout(prefillTimer); clearTimeout(fallback); t.p.write(opts.run ? `${text}\r` : pasteText(text)); if (opts.run) t.enterAt = Date.now() }
  const armPrefill = () => { clearTimeout(prefillTimer); prefillTimer = setTimeout(typePrefill, 350) }
  const fallback = opts.prefill ? setTimeout(typePrefill, 4000) : undefined
  p.onExit(() => { t.exited = true; t.listeners.forEach(l => l('\r\n[process exited]\r\n')); changed(); if (t.owner) termEvent(t, 'term_exited') })
  terms.set(id, t)
  changed()
  return t
}

export function closeTerm(id: string) {
  const t = terms.get(id)
  if (!t) return
  if (!t.exited) t.p.kill()
  terms.delete(id)
  changed()
}

export function listTerms() {
  return [...terms.values()].map(t => ({ id: t.id, title: t.title, cwd: t.cwd, cmd: t.cmd, conversationId: t.conversationId, exited: t.exited, createdAt: t.createdAt,
    owner: t.owner, needsUser: t.needsUser, state: termState(t) }))
}

// ---------- agent-owned terminals: state, plain-text output, and events for the owner ----------
// Foreground process: the shell itself means it's at the prompt; anything else is a command running.
const fgOf = (t: Term) => { try { return t.p.process ?? '' } catch { return '' } }
export function termState(t: Term): TermState {
  if (t.exited) return 'exited'
  const fg = fgOf(t)
  if (!fg || fg === t.shell || fg === `-${t.shell}`) return 'at prompt'
  return Date.now() - t.lastOut > QUIET_WAITING_MS ? 'waiting for input' : 'running'
}

// Terminal output as text an agent can read: escape codes out, carriage-return overwrites applied.
export function plainText(raw: string) {
  const noEsc = raw
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC (titles, cwd)
    .replace(/\x1b\[[0-9;?<>=!]*[ -\/]*[@-~]/g, '') // CSI
    .replace(/\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMcNO]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r+\n/g, '\n')
  return noEsc.split('\n').map(line => { const parts = line.split('\r').filter((x, i, a) => x || i === a.length - 1); return parts.length ? parts[parts.length - 1] : '' })
    .join('\n').replace(/\n{3,}/g, '\n\n')
}

export function readTerm(t: Term, opts: { since?: number; maxChars?: number } = {}) {
  const max = opts.maxChars ?? 6000
  // since is an offset in total bytes written; only what's still in the scrollback can be returned.
  const start = opts.since != null ? Math.max(0, t.buf.length - (t.total - opts.since)) : 0
  const text = plainText(t.buf.slice(start)).trimEnd()
  return { state: termState(t), fg: fgOf(t), offset: t.total, output: text.length > max ? `…${text.slice(-max)}` : text, needsUser: t.needsUser }
}

// Block until the terminal settles (back at the prompt, waiting for input, exited) or the timeout.
export async function waitTerm(t: Term, ms: number) {
  const end = Date.now() + Math.min(ms, 110_000)
  await new Promise(r => setTimeout(r, 300)) // let input just sent echo back before judging
  let ranSomething = termState(t) !== 'at prompt'
  while (Date.now() < end) {
    const st = termState(t)
    if (st !== 'at prompt' || (t.enterAt && Date.now() - t.enterAt > 800)) ranSomething = true
    if (st === 'exited' || st === 'waiting for input' || (st === 'at prompt' && ranSomething && Date.now() - t.lastOut > 600)) return st
    await new Promise(r => setTimeout(r, 400))
  }
  return termState(t)
}

export function sendTerm(t: Term, text: string, enter: boolean) {
  if (t.exited) throw new Error('That terminal has exited.')
  t.p.write(enter ? `${text}\r` : text)
  if (enter || text.includes('\r')) t.enterAt = Date.now()
}
// Keystrokes from the user's window: Enter means a command was started, so its end is worth reporting.
export function typedInto(t: Term, d: string) { if (d.includes('\r')) t.enterAt = Date.now() }

// Events go to the owner's perch inbox (wired in main.ts), so it is woken once per burst.
export const termEvents = new Set<(owner: string, termId: string, event: string, text: string) => void>()
function termEvent(t: Term, event: 'term_done' | 'term_waiting' | 'term_exited') {
  const r = readTerm(t, { maxChars: 2500 })
  const what = event === 'term_done' ? 'finished; the shell is back at the prompt' : event === 'term_waiting' ? `is waiting for input (${r.fg} has printed nothing for ${Math.round((Date.now() - t.lastOut) / 1000)}s)` : 'exited'
  termEvents.forEach(f => f(t.owner!, t.id, event, `Terminal ${t.id} ("${t.title}") ${what}. Last output:\n${r.output.split('\n').slice(-30).join('\n')}\n\nCheck it (terminal action=read) and carry on: answer a prompt with action=send, or verify the result and continue the work.`))
}

// Watch owned terminals: command finished (foreground went back to the shell), or quiet and waiting on someone.
setInterval(() => {
  for (const t of terms.values()) {
    if (!t.owner || t.exited) continue
    const now = Date.now(), fg = fgOf(t), atPrompt = !fg || fg === t.shell || fg === `-${t.shell}`
    t.busyTicks = atPrompt ? t.busyTicks : t.busyTicks + 1
    // Done: back at the prompt and quiet, after a real command (seen running twice, so prompt helpers like git don't count)
    // or after someone pressed Enter (builtins never leave the shell).
    if (atPrompt && now - t.lastOut > 1000 && (t.busyTicks >= 2 || (t.enterAt && now - t.enterAt > 1500))) { termEvent(t, 'term_done'); t.busyTicks = 0; t.enterAt = 0 }
    else if (atPrompt && t.busyTicks < 2 && !t.enterAt) t.busyTicks = 0
    if (!atPrompt && !t.quietReported && now - t.lastOut > QUIET_WAITING_MS) { t.quietReported = true; termEvent(t, 'term_waiting') }
    if ((t.fg === t.shell) !== atPrompt && t.fg) changed() // the UI shows "press Enter to run" only at the prompt
    t.fg = atPrompt ? t.shell : fg
  }
}, 1500).unref()
