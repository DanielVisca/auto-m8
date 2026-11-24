// What the settings page shows: Claude login, MCP connections and their auth, GitHub, PostHog.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export type Mcp = { name: string; target: string; status: 'connected' | 'needs-auth' | 'failed' | 'not-configured' | 'unknown'; kind: 'claude.ai' | 'plugin' | 'local' }
export const status: { claude?: any; claudeVersion?: string; gh?: { ok: boolean; account?: string; error?: string }; mcp?: { checkedAt: number; servers: Mcp[]; error?: string }; mcpChecking?: boolean
  // A chat's Claude reported a lapsed sign-in (e.g. "OAuth session expired and could not be refreshed")
  // while `claude auth status` may still say logged in. Cleared by the next good Claude turn or a sign-in.
  claudeAuthLapse?: { at: number; text: string; conversationId: string } } = {}

export function parseMcpList(out: string): Mcp[] {
  const servers: Mcp[] = []
  for (const line of out.split('\n')) {
    const sep = line.indexOf(': ')
    const dash = line.lastIndexOf(' - ')
    if (sep < 0 || dash < sep) continue
    const name = line.slice(0, sep).trim()
    const target = line.slice(sep + 2, dash).trim()
    const s = line.slice(dash + 3)
    const st: Mcp['status'] = /Connected/.test(s) ? 'connected' : /auth/i.test(s) ? 'needs-auth' : /Failed/i.test(s) ? 'failed' : /Not configured/i.test(s) ? 'not-configured' : 'unknown'
    servers.push({ name, target, status: st, kind: name.startsWith('claude.ai ') ? 'claude.ai' : name.startsWith('plugin:') ? 'plugin' : 'local' })
  }
  return servers
}

export async function refreshMcp() {
  if (status.mcpChecking) return
  status.mcpChecking = true
  try {
    const { stdout } = await exec('claude', ['mcp', 'list'], { timeout: 120_000, maxBuffer: 10e6 })
    status.mcp = { checkedAt: Date.now(), servers: parseMcpList(stdout) }
  } catch (e: any) {
    status.mcp = { checkedAt: Date.now(), servers: parseMcpList(e.stdout ?? ''), error: e.message.slice(0, 300) }
  } finally { status.mcpChecking = false }
}

export async function refreshBasics() {
  await Promise.all([
    exec('claude', ['--version']).then(r => { status.claudeVersion = r.stdout.trim() }).catch(() => {}),
    exec('claude', ['auth', 'status']).then(r => { status.claude = JSON.parse(r.stdout) }).catch(e => { // logged out exits 1 but still prints JSON; ENOENT means claude isn't on PATH
      try { status.claude = { ...JSON.parse(e.stdout), error: 'Not logged in' } } catch { status.claude = { loggedIn: false, error: e.code === 'ENOENT' ? 'claude not found on PATH (looked in ~/.local/bin too)' : e.message.slice(0, 200) } }
    }),
    exec('gh', ['auth', 'status']).then(r => {
      const out = r.stdout + r.stderr
      status.gh = { ok: true, account: out.match(/account (\S+)/)?.[1] }
    }).catch(e => { status.gh = { ok: false, error: (e.stderr || e.message).slice(0, 200) } }),
  ])
}
