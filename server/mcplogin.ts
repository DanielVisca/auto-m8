// Authorize an MCP server from inside auto-m8, no terminal: run `claude mcp login <server>` in the
// background. It opens the browser itself and finishes on its own when you approve there. Used when
// a tool call fails because a server (e.g. the Slack plugin) needs OAuth: auto-m8 starts this at once
// and the toast offers to open it again, instead of telling you to go find /mcp.
import { spawn, type ChildProcess } from 'node:child_process'
import { childEnv } from './chat.ts'
export { serverLabel, serverNeedingAuth } from './errors.ts'

export type McpLoginState = { server: string; state: 'waiting' | 'done' | 'failed'; url?: string; error?: string; at: number }
export const mcpLogins = new Map<string, McpLoginState>()
const procs = new Map<string, ChildProcess>()
export const onMcpLogin = new Set<(s: McpLoginState) => void>()
const changed = (s: McpLoginState) => onMcpLogin.forEach(fn => { try { fn(s) } catch {} })

// The error an MCP call gives when its server needs OAuth. `server` is the name `claude mcp` knows it by.
export class McpAuthError extends Error {
  server: string
  constructor(server: string, what = 'That') {
    super(`${what} needs ${server} authorized (MCP server needs authorization).`)
    this.server = server
  }
}

// From a stream-json init event: the servers among `want` (substring match) that need OAuth.
export function needsAuthIn(ev: any, want: RegExp): string[] {
  if (ev?.type !== 'system' || ev?.subtype !== 'init' || !Array.isArray(ev.mcp_servers)) return []
  return ev.mcp_servers.filter((s: any) => s?.status === 'needs-auth' && want.test(String(s.name))).map((s: any) => String(s.name))
}

export function startMcpLogin(server: string, configDir?: string): McpLoginState {
  const cur = mcpLogins.get(server)
  if (cur?.state === 'waiting' && procs.has(server) && Date.now() - cur.at < 10 * 60_000) return cur
  const st: McpLoginState = { server, state: 'waiting', at: Date.now() }
  mcpLogins.set(server, st)
  let out = ''
  // `claude mcp login` refuses to run without a terminal; macOS `script` gives it a pseudo-terminal.
  const p = spawn('script', ['-q', '/dev/null', 'claude', 'mcp', 'login', server], { env: childEnv(configDir), stdio: ['pipe', 'pipe', 'pipe'] })
  procs.set(server, p)
  const read = (d: Buffer) => {
    out += String(d).replace(/\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[A-Za-z]|[\x00-\x08\r]/g, '')
    const url = out.match(/https:\/\/\S+/)?.[0]
    if (url && url !== st.url) { st.url = url; changed(st) }
  }
  p.stdout!.on('data', read)
  p.stderr!.on('data', read)
  const end = (ok: boolean, error?: string) => {
    if (procs.get(server) !== p) return
    procs.delete(server)
    Object.assign(st, ok ? { state: 'done', error: undefined } : { state: 'failed', error })
    changed(st)
  }
  p.on('error', e => end(false, e.message))
  p.on('exit', code => end(code === 0 && !/Couldn't complete|failed/i.test(out), out.replace(/https:\/\/\S+/g, '').trim().slice(-300) || `exited ${code}`))
  // An approval left open forever would hold the next attempt.
  setTimeout(() => { if (procs.get(server) === p) p.kill() }, 10 * 60_000).unref?.()
  changed(st)
  return st
}

export function submitMcpCode(server: string, code: string) {
  const p = procs.get(server)
  if (!p) return { error: 'no authorization waiting for a code' }
  p.stdin!.write(code.trim() + '\n')
  return { ok: true }
}
