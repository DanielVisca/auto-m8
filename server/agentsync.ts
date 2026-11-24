// Keeps the other agents (Codex, Cursor) set up like Claude Code, so whichever one picks up a chat
// has the same instructions, memory, skills and MCP servers. Claude Code's files are the source
// of truth; this only adds what's missing and never removes or edits what you set up by hand.
// - Instructions + memory: ~/.codex/AGENTS.md, written from ~/.claude/CLAUDE.md and the memory
//   index (rewritten while it carries perch's marker; left alone if you replace it).
// - Skills: each ~/.claude/skills/<name> is linked into ~/.codex/skills (same SKILL.md format).
// - MCP servers: Claude Code's user and home-folder servers, plus perch's own, are added to
//   ~/.codex/config.toml and ~/.cursor/mcp.json when those don't have one by that name.
// claude.ai connectors (Slack, Granola, Drive...) live in your Claude account, not on this Mac, so
// they can't be copied; Codex has its own connectors in the ChatGPT app.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOME } from './settings.ts'
import { MCP_SERVER, mcpTool } from '../shared/brand.ts'
import { budgetAgentsMd, memoryLines } from './codexbudget.ts'

const MARK = '<!-- written by auto-m8 (server/agentsync.ts) from ~/.claude; delete this line to keep your own edits -->'
const OLD_MARK = '<!-- written by perch (server/agentsync.ts) from ~/.claude; delete this line to keep your own edits -->'
const CODEX = join(HOME, '.codex'), CLAUDE = join(HOME, '.claude')
const memoryDirs = () => { const p = join(CLAUDE, 'projects'); return existsSync(p) ? readdirSync(p).map(d => join(p, d, 'memory')).filter(d => existsSync(join(d, 'MEMORY.md'))) : [] }
const read = (f: string) => { try { return readFileSync(f, 'utf8') } catch { return '' } }

// The memory index outgrew Codex's 32 KiB instruction limit (42 KB on 2026-11-22), which failed every
// Codex turn. CLAUDE.md always goes in; memory lines go in newest first within GLOBAL_BUDGET, and each
// Codex turn adds the lines matching its own task (chat.ts, codexMemoryFor).
export const memoryHeader = (d: string) => `### Memory in ${d}\nEach line points to one file in that folder with one fact (frontmatter: name, description, metadata.type). Read the file before relying on it; facts may be stale, so verify names, flags and files still exist. To remember something new, write a new file in the same format there and add a one-line pointer to its MEMORY.md.`
export const allMemoryLines = () => memoryLines(memoryDirs().map(dir => ({ dir, text: read(join(dir, 'MEMORY.md')) })))
export let agentsMdKept = new Set<string>(), agentsMdBytes = 0
function agentsMd(): string {
  const r = budgetAgentsMd(`${MARK}
# Standing instructions (shared with Claude Code)

These are the user's own instructions, written for Claude Code and shared with every agent. Where they name Claude-only tools (ToolSearch, Skill, Agent, TodoWrite, Monitor, the auto-m8 tools as ${mcpTool('*')}), use your equivalent: the shell, the MCP servers you have (auto-m8's tools are on the \`${MCP_SERVER}\` server), and skills in ~/.codex/skills.

${read(join(CLAUDE, 'CLAUDE.md')).trim()}`, memoryHeader, allMemoryLines())
  agentsMdKept = new Set(r.kept.map(l => l.line)); agentsMdBytes = Buffer.byteLength(r.text, 'utf8')
  if (r.dropped) console.warn(`[agentsync] ~/.codex/AGENTS.md: kept ${r.kept.length} of ${r.kept.length + r.dropped} memory lines to stay under Codex's instruction limit (${agentsMdBytes} bytes); each Codex turn adds the lines that match its task`)
  return r.text
}

function syncAgentsMd() {
  const f = join(CODEX, 'AGENTS.md')
  const cur = read(f)
  if (cur && !cur.startsWith(MARK) && !cur.startsWith(OLD_MARK)) return 'kept yours'
  const next = agentsMd()
  if (cur !== next) { writeFileSync(f, next); return 'updated' }
  return 'unchanged'
}

function syncSkills() {
  const src = join(CLAUDE, 'skills'), dst = join(CODEX, 'skills')
  if (!existsSync(src)) return 0
  mkdirSync(dst, { recursive: true })
  let n = 0
  for (const name of readdirSync(src)) {
    if (!existsSync(join(src, name, 'SKILL.md'))) continue
    const to = join(dst, name)
    try { lstatSync(to); continue } catch {} // there already (yours or ours)
    symlinkSync(join(src, name), to); n++
  }
  return n
}

type Server = { type?: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }
// Our own server used to be registered as "perch"; it is now MCP_SERVER (auto-m8). An old "perch"
// entry that runs our server/mcp.ts is removed, so agents don't see every tool twice.
const LEGACY = 'perch'
const runsOurMcp = (s: Server | undefined, ours: Server) => !!s?.command && (s.args ?? []).some(a => (ours.args ?? []).includes(a) || /[\\/]server[\\/]mcp\.ts$/.test(a))
function claudeServers(ours: Server): Record<string, Server> {
  let cfg: any = {}
  try { cfg = JSON.parse(read(join(HOME, '.claude.json')) || '{}') } catch {}
  const all: Record<string, Server> = { ...(cfg.projects?.[join(HOME, 'Development')]?.mcpServers ?? {}), ...(cfg.projects?.[HOME]?.mcpServers ?? {}), ...(cfg.mcpServers ?? {}), [MCP_SERVER]: ours }
  if (runsOurMcp(all[LEGACY], ours)) delete all[LEGACY]
  return all
}

// Drops the [mcp_servers.perch] table (and its .env / .http_headers sub-tables) when it runs our mcp.ts.
export function withoutLegacyToml(toml: string, ours: Server): string {
  const lines = toml.split('\n')
  const header = (l: string) => /^\s*\[/.test(l)
  const legacyHeader = (l: string) => new RegExp(`^\\s*\\[mcp_servers\\.("?)${LEGACY}\\1(\\.[^\\]]*)?\\]\\s*$`).test(l)
  const start = lines.findIndex(l => new RegExp(`^\\s*\\[mcp_servers\\.("?)${LEGACY}\\1\\]\\s*$`).test(l))
  if (start < 0) return toml
  let end = start + 1
  while (end < lines.length && (!header(lines[end]) || legacyHeader(lines[end]))) end++
  const block = lines.slice(start, end).join('\n')
  const args = [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1])
  if (!runsOurMcp({ command: 'x', args }, ours)) return toml
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n')
}

const q = (s: string) => JSON.stringify(s)
function tomlBlock(name: string, s: Server): string | null {
  const key = /^[\w-]+$/.test(name) ? name : q(name)
  if (s.url) return `\n[mcp_servers.${key}]\nurl = ${q(s.url)}\n` + (s.headers && Object.keys(s.headers).length ? `\n[mcp_servers.${key}.http_headers]\n${Object.entries(s.headers).map(([k, v]) => `${q(k)} = ${q(v)}`).join('\n')}\n` : '')
  if (!s.command) return null
  return `\n[mcp_servers.${key}]\ncommand = ${q(s.command)}\nargs = [${(s.args ?? []).map(q).join(', ')}]\n` + (s.env && Object.keys(s.env).length ? `\n[mcp_servers.${key}.env]\n${Object.entries(s.env).map(([k, v]) => `${q(k)} = ${q(v)}`).join('\n')}\n` : '')
}

function syncCodexMcp(servers: Record<string, Server>, ours: Server) {
  const f = join(CODEX, 'config.toml')
  if (!existsSync(f)) return []
  const was = read(f)
  const cur = withoutLegacyToml(was, ours)
  if (cur !== was) writeFileSync(f, cur)
  const have = new Set([...cur.matchAll(/^\[mcp_servers\.("?)([^\]."]+)\1\]/gm)].map(m => m[2]))
  const added: string[] = []
  let out = ''
  for (const [name, s] of Object.entries(servers)) {
    if (have.has(name)) continue
    const b = tomlBlock(name, s)
    if (b) { out += b; added.push(name) }
  }
  if (out) writeFileSync(f, cur.trimEnd() + '\n' + out)
  return added
}

function syncCursorMcp(servers: Record<string, Server>, ours: Server) {
  const f = join(HOME, '.cursor', 'mcp.json')
  if (!existsSync(join(HOME, '.cursor'))) return []
  let cfg: any = { mcpServers: {} }
  try { cfg = JSON.parse(read(f) || '{"mcpServers":{}}') } catch { return [] } // unreadable: leave it alone
  cfg.mcpServers ??= {}
  const dropped = runsOurMcp(cfg.mcpServers[LEGACY], ours)
  if (dropped) delete cfg.mcpServers[LEGACY]
  const added = Object.keys(servers).filter(n => !cfg.mcpServers[n])
  for (const n of added) { const { type: _t, ...s } = servers[n]; cfg.mcpServers[n] = s }
  if (added.length || dropped) writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n')
  return added
}

export function syncAgents(ours: Server) {
  const r: Record<string, unknown> = {}
  try {
    if (existsSync(CODEX)) {
      r.agentsMd = syncAgentsMd()
      r.skillsLinked = syncSkills()
      r.codexMcpAdded = syncCodexMcp(claudeServers(ours), ours)
    }
    r.cursorMcpAdded = syncCursorMcp(claudeServers(ours), ours)
  } catch (e) { r.error = String(e) }
  return r
}
