// Which agents can reach which MCP servers, so an agent whose tool is failing can see whether
// Claude, Codex or Cursor has working access and hand the job to that one (delegate engine=...).
// Claude and Codex are asked directly (`claude mcp list` checks health; `codex mcp list` shows what
// is enabled and its auth); Cursor is read from its config. claude.ai connectors are Claude-only.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { codexBin } from './codex.ts'
import { HOME } from './settings.ts'

const exec = promisify(execFile)
type Row = { server: string; state: string }
const run = (bin: string, args: string[]) => exec(bin, args, { timeout: 40_000, maxBuffer: 4_000_000, env: process.env }).then(r => r.stdout, e => String(e?.stdout ?? ''))

function parseClaude(out: string): Row[] {
  return out.split('\n').flatMap(l => {
    const m = l.match(/^(.+?): .* - ([✔✓✗!✘].*)$/)
    return m ? [{ server: m[1].trim(), state: /Connected|✔|✓/.test(m[2]) ? 'connected' : /auth/i.test(m[2]) ? 'needs authentication' : 'failing' }] : []
  })
}
function parseCodex(out: string): Row[] {
  const rows: Row[] = []
  for (const block of out.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter(Boolean)
    const h = lines[0] ?? ''
    const st = h.indexOf('Status'), au = h.indexOf('Auth')
    if (!h.startsWith('Name') || st < 0) continue // stdio servers have no Status column: configured is all that's known
    for (const l of lines.slice(1)) rows.push({ server: l.split(/\s+/)[0], state: `${l.slice(st, au > st ? au : undefined).trim() || 'enabled'}${au > st && !/^unsupported$/i.test(l.slice(au).trim()) ? `, auth: ${l.slice(au).trim()}` : ''}` })
  }
  for (const block of out.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter(Boolean)
    if (lines[0]?.startsWith('Name') && !lines[0].includes('Status')) for (const l of lines.slice(1)) rows.push({ server: l.split(/\s+/)[0], state: 'configured (stdio, health not checked)' })
  }
  return rows
}
function cursorServers(): Row[] {
  try { const f = join(HOME, '.cursor/mcp.json'); return existsSync(f) ? Object.keys(JSON.parse(readFileSync(f, 'utf8')).mcpServers ?? {}).map(server => ({ server, state: 'configured' })) : [] } catch { return [] }
}

let cache: { at: number; text: Promise<{ claude: Row[]; codex: Row[]; cursor: Row[] }> } | null = null
export async function mcpRows() {
  if (!cache || Date.now() - cache.at > 60_000) cache = { at: Date.now(), text: Promise.all([run('claude', ['mcp', 'list']), codexBin() ? run(codexBin()!, ['mcp', 'list']) : Promise.resolve('')]).then(([c, x]) => ({ claude: parseClaude(c), codex: parseCodex(x), cursor: cursorServers() })) }
  return cache.text
}
export async function mcpAccess(server?: string): Promise<string> {
  const all = await mcpRows()
  const norm = (s: string) => s.toLowerCase().replace(/^claude\.ai /, '').replace(/[^a-z0-9]/g, '')
  const names = [...new Set([...all.claude, ...all.codex, ...all.cursor].map(r => r.server))].filter(n => !server || norm(n).includes(norm(server)) || norm(server).includes(norm(n))).sort()
  if (!names.length) return server ? `No agent has an MCP server matching "${server}". Claude and Codex are kept in step with each other, but claude.ai connectors exist only in Claude and ChatGPT connectors only in Codex.` : 'No MCP servers found.'
  const at = (rows: Row[], n: string) => rows.find(r => norm(r.server) === norm(n))?.state ?? '—'
  const lines = names.map(n => `- ${n}: Claude ${at(all.claude, n)} | Codex ${at(all.codex, n)} | Cursor ${at(all.cursor, n)}`)
  return `${lines.join('\n')}\n\nIf this agent's tool is failing and another agent shows "connected" or "enabled", hand the job over: delegate with engine=claude or engine=codex (it reports back to you). If none is working, the server itself is down or needs auth; say which. Codex status is configuration and auth only (it doesn't probe the server).`
}
