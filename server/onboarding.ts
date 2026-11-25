// First run: detect, don't ask. One parallel scan finds what this Mac already has (logins, chats,
// repos, MCP servers, Chrome, GitHub org), the setup screen shows it in one go, and asks only for
// what's missing and required (Claude, GitHub). Setup ends by opening a chat that is already
// briefing the user on their recent work (finish()).
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { CURSOR_DB } from './cursor.ts'
import { profile } from './profile.ts'
import { settings } from './settings.ts'

const exec = promisify(execFile)
const HOME = homedir()
const run = (cmd: string, args: string[], timeout = 5000) => exec(cmd, args, { timeout, maxBuffer: 4e6 }).then((r): { ok: boolean; out: string; code?: string } => ({ ok: true, out: r.stdout + r.stderr }), (e: any) => ({ ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.code }))

export type Detected = {
  claude: { installed: boolean; loggedIn: boolean; email?: string }
  codex: { installed: boolean; loggedIn: boolean }
  gh: { installed: boolean; loggedIn: boolean; login?: string; name?: string; orgs: string[] }
  chats: { claude: number; cursor: number }
  repos: { count: number; suggested: string | null; roots: { dir: string; repos: number }[] }
  mcp: { claude: string[]; codex: string[] }
  chrome: boolean
  ms: number
}

// .git folders under the usual places, at most 3 levels down, giving up after `budgetMs`.
export function scanRepos(roots: string[], budgetMs = 1500, depth = 3): string[] {
  const until = Date.now() + budgetMs, found = new Set<string>()
  const skip = /^(node_modules|Library|\.Trash|\.cache|\.npm|\.cargo|\.rustup|Applications|Pictures|Music|Movies|vendor|dist|build)$/
  const walk = (dir: string, left: number) => {
    if (Date.now() > until) return
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    if (entries.some(e => e.name === '.git')) { found.add(dir); return }
    if (left <= 0) return
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !skip.test(e.name)) walk(join(dir, e.name), left - 1)
  }
  for (const r of roots) if (existsSync(r)) walk(r, r === HOME ? Math.min(depth, 2) : depth)
  return [...found]
}

// The folder that holds most of the repos: where new chats should start.
export function suggestCwd(repos: string[]): { suggested: string | null; roots: { dir: string; repos: number }[] } {
  const counts = new Map<string, number>()
  for (const r of repos) { const p = dirname(r); counts.set(p, (counts.get(p) ?? 0) + 1) }
  const roots = [...counts].map(([dir, repos]) => ({ dir, repos })).sort((a, b) => b.repos - a.repos)
  const best = roots.find(r => r.dir !== HOME) ?? roots[0]
  return { suggested: best?.dir ?? null, roots: roots.slice(0, 5) }
}

// MCP server names (never their URLs or secrets) from Claude Code's and Codex's config.
export function mcpNames(claudeJson: string, codexToml: string): { claude: string[]; codex: string[] } {
  const claude = new Set<string>()
  try {
    const j = JSON.parse(claudeJson)
    for (const k of Object.keys(j.mcpServers ?? {})) claude.add(k)
    for (const p of Object.values<any>(j.projects ?? {})) for (const k of Object.keys(p?.mcpServers ?? {})) claude.add(k)
  } catch {}
  const codex = [...new Set([...codexToml.matchAll(/^\[mcp_servers\.("?)([^\]".]+)\1\]/gm)].map(m => m[2]))]
  return { claude: [...claude], codex }
}

const countClaudeChats = (dir: string) => {
  let n = 0
  try { for (const p of readdirSync(dir)) try { n += readdirSync(join(dir, p)).filter(f => f.endsWith('.jsonl')).length } catch {} } catch {}
  return n
}
const countCursorChats = async () => {
  if (!existsSync(CURSOR_DB)) return 0
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(CURSOR_DB, { readOnly: true })
    try { return Number((db.prepare(`select count(*) n from cursorDiskKV where key >= 'composerData:' and key < 'composerData;'`).get() as any).n) } finally { db.close() }
  } catch { return 0 }
}
const read = (f: string) => { try { return readFileSync(f, 'utf8') } catch { return '' } }

let cache: { at: number; value: Detected } | null = null
let pending: Promise<Detected> | null = null
export function detect(fresh = false): Promise<Detected> {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return Promise.resolve(cache.value)
  return pending ??= doDetect().then(v => { cache = { at: Date.now(), value: v }; return v }).finally(() => { pending = null })
}

async function doDetect(): Promise<Detected> {
  const t0 = Date.now()
  const [claude, codex, gh, cursor] = await Promise.all([
    run('claude', ['auth', 'status']).then(r => {
      if (r.code === 'ENOENT') return { installed: false, loggedIn: false }
      try { const j = JSON.parse(r.out.slice(r.out.indexOf('{'))); return { installed: true, loggedIn: !!j.loggedIn, email: j.email } } catch { return { installed: true, loggedIn: false } }
    }),
    run('codex', ['login', 'status']).then(r => ({ installed: r.code !== 'ENOENT', loggedIn: r.ok && /logged in/i.test(r.out) && !/not logged in/i.test(r.out) })),
    (async () => {
      const st = await run('gh', ['auth', 'status'])
      if ((st as any).code === 'ENOENT') return { installed: false, loggedIn: false, orgs: [] }
      if (!st.ok) return { installed: true, loggedIn: false, orgs: [] }
      const [u, o] = await Promise.all([run('gh', ['api', 'user', '--jq', '[.login, .name // ""] | @tsv']), run('gh', ['api', 'user/orgs', '--jq', '.[].login'])])
      const [login, name] = u.ok ? u.out.trim().split('\t') : []
      return { installed: true, loggedIn: true, login, name: name || undefined, orgs: o.ok ? o.out.split('\n').map(s => s.trim()).filter(Boolean) : [] }
    })(),
    countCursorChats(),
  ])
  const repos = scanRepos(['Development', 'code', 'src', 'projects', 'Projects'].map(d => join(HOME, d)).concat(HOME))
  return {
    claude, codex, gh,
    chats: { claude: countClaudeChats(join(profile.claudeDir, 'projects')), cursor },
    repos: { count: repos.length, ...suggestCwd(repos) },
    mcp: mcpNames(read(join(HOME, '.claude.json')), read(join(HOME, '.codex/config.toml'))),
    chrome: existsSync(settings.browser.chromePath),
    ms: Date.now() - t0,
  }
}

// The first useful moment: a chat that briefs the user from their own recent chats and open PRs,
// with one suggested next step. Sonnet keeps it cheap.
export async function briefPrompt(recent: { title: string; updated_at: number }[]): Promise<string> {
  const prs = await run('gh', ['search', 'prs', '--author', '@me', '--state', 'open', '--limit', '15', '--json', 'url,title,repository,updatedAt'], 15_000)
  let prList = ''
  try { prList = (JSON.parse(prs.out) as any[]).map(p => `- ${p.title} (${p.url}, updated ${String(p.updatedAt).slice(0, 10)})`).join('\n') } catch {}
  const chats = recent.slice(0, 15).map(c => `- ${c.title} (${new Date(c.updated_at).toISOString().slice(0, 10)})`).join('\n')
  return [
    'This is my first chat in auto-m8. Brief me on where my work stands, in under 150 words:',
    '1. What I have been working on lately (group the chats and PRs below into 2-4 threads).',
    '2. Which open PRs need something from me (check them with gh pr view if useful: review state, red CI).',
    '3. One concrete next step you can do for me right now, as a question I can answer yes to.',
    'Use search_conversations or get_conversation if a thread needs more context. Don\'t change any files.',
    '', '<recent-chats>', chats || '(none found)', '</recent-chats>',
    '', '<open-prs>', prList || '(none found, or gh is not logged in)', '</open-prs>',
  ].join('\n')
}
