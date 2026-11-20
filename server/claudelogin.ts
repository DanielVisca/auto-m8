// Sign in to Claude from inside perch, no terminal: run `claude auth login` in the background.
// It opens the browser itself and finishes on its own when you approve there; if the browser
// flow hands you a code instead, the UI sends it here and we type it into the waiting process.
import { spawn, type ChildProcess } from 'node:child_process'
import { childEnv } from './chat.ts'

export type LoginState = { state: 'idle' | 'waiting' | 'done' | 'failed'; url?: string; error?: string; at?: number }
export const login: LoginState = { state: 'idle' }
let proc: ChildProcess | null = null

export function startLogin(onChange: () => void, configDir?: string) {
  if (proc && login.state === 'waiting') return login
  Object.assign(login, { state: 'waiting', url: undefined, error: undefined, at: Date.now() })
  let out = ''
  const p = proc = spawn('claude', ['auth', 'login'], { env: childEnv(configDir), stdio: ['pipe', 'pipe', 'pipe'] })
  const read = (d: Buffer) => {
    out += d
    const url = out.match(/https:\/\/\S+oauth\S+/)?.[0]
    if (url && url !== login.url) { login.url = url; onChange() }
  }
  p.stdout!.on('data', read)
  p.stderr!.on('data', read)
  p.on('error', e => { if (proc !== p) return; proc = null; Object.assign(login, { state: 'failed', error: e.message }); onChange() })
  p.on('exit', code => {
    if (proc !== p) return
    proc = null
    Object.assign(login, code === 0 ? { state: 'done', error: undefined } : { state: 'failed', error: out.replace(/https:\/\/\S+/g, '').trim().slice(-300) || `exited ${code}` })
    onChange()
  })
  // A sign-in left open forever would hold the next attempt; give up after 10 minutes.
  setTimeout(() => { if (proc === p) { p.kill(); } }, 10 * 60_000).unref?.()
  return login
}

export function submitCode(code: string) {
  if (!proc || login.state !== 'waiting') return { error: 'no sign-in waiting for a code' }
  proc.stdin!.write(code.trim() + '\n')
  return { ok: true }
}

export function cancelLogin() { proc?.kill(); proc = null; Object.assign(login, { state: 'idle', url: undefined, error: undefined }) }
