// Instant search: every local source in parallel, each with its own time budget, no model in
// the loop. Results come back grouped by source; a slow or failing source never blocks the rest.
import { profile } from './profile.ts'
import { execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { list } from './conversations.ts'
import { all } from './db.ts'
import { posthogStatus } from './indexer.ts'
import { skills } from './posthog.ts'
import { codeRoots, HOME, settings } from './settings.ts'
import { notesStatus, searchAppleNotes } from './applenotes.ts'
import { ghExec } from './gh.ts'

const exec = promisify(execFile)

export type Hit = { title: string; sub?: string; snippet?: string; href?: string; open?: { kind: 'conversation' | 'file' | 'skill'; id: string; line?: number }; score?: number }
export type SourceResult = { source: string; label: string; hits: Hit[]; ms: number; error?: string; more?: number }

// ripgrep ships inside the Claude Code binary; run it under its own name, as the shell does.
let rgCmd: { cmd: string; argv0?: string } | null = null
async function rg() {
  if (rgCmd) return rgCmd
  for (const p of ['/opt/homebrew/bin/rg', '/usr/local/bin/rg']) if (existsSync(p)) return (rgCmd = { cmd: p })
  const claude = [join(HOME, '.local/bin/claude'), ...(await exec('/bin/zsh', ['-lc', 'whence -p claude']).then(r => [r.stdout.trim()]).catch(() => []))].find(p => p && existsSync(p))
  return (rgCmd = claude ? { cmd: claude, argv0: 'rg' } : { cmd: 'rg' })
}

function run(cmd: string, args: string[], opts: { argv0?: string; timeout: number; cwd?: string }) {
  return new Promise<string>(resolve => {
    const p = spawn(cmd, args, { argv0: opts.argv0, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    p.stdout.on('data', d => { out += d; if (out.length > 2e6) p.kill() })
    const t = setTimeout(() => p.kill(), opts.timeout)
    p.on('close', () => { clearTimeout(t); resolve(out) })
    p.on('error', () => { clearTimeout(t); resolve(out) })
  })
}

// ---------- the repos on this Mac ----------
let repoCache: { at: number; repos: { path: string; name: string; remote: string | null }[] } | null = null
export function localRepos() {
  if (repoCache && Date.now() - repoCache.at < 10 * 60_000) return repoCache.repos
  const roots = [...codeRoots(), join(HOME, 'Library/Caches/perch/src')].filter(existsSync)
  const repos: { path: string; name: string; remote: string | null }[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return }
    if (entries.includes('.git')) {
      let remote: string | null = null
      try { remote = readFileSync(join(dir, '.git/config'), 'utf8').match(/url = (.+)/)?.[1]?.trim() ?? null } catch {}
      repos.push({ path: dir, name: dir.split('/').pop()!, remote })
      return
    }
    for (const e of entries) {
      if (e.startsWith('.') || e === 'node_modules') continue
      const p = join(dir, e)
      try { if (statSync(p).isDirectory()) walk(p, depth + 1) } catch {}
    }
  }
  roots.forEach(r => walk(r, 0))
  repoCache = { at: Date.now(), repos }
  return repos
}

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(w => w.length > 1 && !/^(the|and|for|how|does|what|where|why|did|with|from|this|that|my|in|of|to|a|is)$/.test(w))

// ---------- sources ----------
type Opts = { agents?: boolean }
const sources: Record<string, { label: string; budget: number; run: (q: string, o: Opts) => Promise<Hit[]> }> = {
  conversations: {
    label: 'Conversations', budget: 1500,
    // Your own chats; agent runs (shepherds, helpers, scouts) only when you ask for them.
    run: async (q, o) => list({ q: o.agents ? `${q} is:any` : q, sort: 'relevance', limit: 12, focus: false }).conversations.map(c => ({
      title: c.title ?? c.first_prompt, sub: `${c.source}${c.cwd ? ' · ' + c.cwd.split('/').pop() : ''} · ${c.effective}`, snippet: c.snippet,
      open: { kind: 'conversation', id: c.id }, score: c.score,
    })),
  },
  notes: {
    label: 'Notes', budget: 500,
    run: async q => {
      const ws = words(q)
      if (!ws.length) return []
      return all<any>(`select day, body from notes where ${ws.map(() => 'lower(body) like ?').join(' and ')} order by day desc limit 8`, ...ws.map(w => `%${w}%`)).map(n => {
        const i = n.body.toLowerCase().indexOf(ws[0])
        return { title: `Notepad · ${n.day}`, snippet: n.body.slice(Math.max(0, i - 60), i + 140), href: `#home` }
      })
    },
  },
  applenotes: {
    label: 'Apple Notes', budget: 1500,
    run: async q => {
      const hits = searchAppleNotes(q, 8)
      if (notesStatus.access === 'needs-access') throw new Error('needs Full Disk Access (Settings → Connections)')
      const w = q.toLowerCase().split(/\s+/)[0]
      return hits.map(n => {
        const i = n.text.toLowerCase().indexOf(w)
        return { title: n.title, sub: `${n.folder ?? 'Notes'} · ${new Date(n.modified).toLocaleDateString()}`, snippet: n.text.slice(Math.max(0, i - 60), i + 160), href: `applenotes:note/${n.id}`, open: { kind: 'applenote' as any, id: n.id } }
      })
    },
  },
  code: {
    label: 'Your repos', budget: 2500,
    // Literal search for the most distinctive words, across every local repo at once.
    run: async q => {
      const ws = words(q).sort((a, b) => b.length - a.length).slice(0, 2)
      if (!ws.length) return []
      const { cmd, argv0 } = await rg()
      const repos = localRepos().map(r => r.path)
      const pattern = ws.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
      const out = await run(cmd, ['--json', '-i', '-m', '2', '--max-filesize', '1M', '--max-columns', '300', '-g', '!*.lock', '-g', '!*.min.*', '-g', '!dist/**', '-g', '!*.snap', pattern, ...repos], { argv0, timeout: 2300 })
      const hits: Hit[] = []
      const perFile = new Map<string, Hit>()
      for (const line of out.split('\n')) {
        if (!line.startsWith('{"type":"match"')) continue
        let m: any
        try { m = JSON.parse(line).data } catch { continue }
        const path: string = m.path.text
        if (perFile.has(path)) continue
        const repo = localRepos().find(r => path.startsWith(r.path + '/'))
        const rel = repo ? path.slice(repo.path.length + 1) : path
        const text: string = m.lines.text ?? ''
        // Files whose path also matches rank first: they are usually what you mean.
        const score = ws.filter(w => rel.toLowerCase().includes(w)).length * 2 + ws.filter(w => text.toLowerCase().includes(w)).length
        const hit = { title: rel, sub: repo?.name, snippet: text.trim().slice(0, 200), open: { kind: 'file' as const, id: path, line: m.line_number }, score }
        perFile.set(path, hit)
        hits.push(hit)
      }
      return hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 25)
    },
  },
  mac: {
    label: 'This Mac', budget: 1500,
    // Spotlight: documents, notes, PDFs, downloads; skips code and caches, which have their own source.
    run: async q => {
      const out = await run('/usr/bin/mdfind', ['-onlyin', HOME, q], { timeout: 1400 })
      return out.split('\n').filter(p => p && !/\/(node_modules|Library\/(Caches|Containers|Group Containers|Application Support)|\.git|Development)\//.test(p)).slice(0, 12)
        .map(p => ({ title: p.split('/').pop()!, sub: p.replace(HOME, '~').split('/').slice(0, -1).join('/'), open: { kind: 'file' as const, id: p } }))
    },
  },
  skills: {
    label: 'Skills', budget: 2500,
    run: async q => {
      const ws = words(q)
      const local = localSkills().map(s => ({ s, n: ws.filter(w => `${s.name} ${s.description}`.toLowerCase().includes(w)).length })).filter(x => x.n > 0)
        .sort((a, b) => b.n - a.n).slice(0, 6).map(({ s }) => ({ title: s.name, sub: `installed · ${s.where}`, snippet: s.description.slice(0, 200), open: { kind: 'file' as const, id: s.path } }))
      let store: Hit[] = []
      if (posthogStatus.ok && skills.cached()) { // never wait on the network here; the catalogue is kept warm
        try {
          const r = await skills.list({ q, sort: 'relevance' })
          const have = new Set(local.map(l => l.title))
          store = r.results.filter((s: any) => !have.has(s.name)).slice(0, 6).map((s: any) => ({ title: s.name, sub: `skill store${s.mine ? ' · yours' : ''}`, snippet: String(s.description ?? '').slice(0, 200), open: { kind: 'skill' as const, id: s.name } }))
        } catch {}
      }
      return [...local, ...store]
    },
  },
  github: {
    label: 'GitHub', budget: 3500,
    // PRs and issues you are part of. (Code search is rate-limited; the agent uses it when it decides to.)
    run: async q => {
      const { stdout } = await ghExec(['search', 'prs', q, '--involves=@me', '--limit', '10', '--json', 'url,title,repository,state,updatedAt,number'], { timeout: 3400 })
      return (JSON.parse(stdout) as any[]).map(p => ({ title: `#${p.number} ${p.title}`, sub: `${p.repository?.nameWithOwner} · ${p.state.toLowerCase()} · ${p.updatedAt.slice(0, 10)}`, href: p.url }))
    },
  },
}

// Skills installed for Claude Code and PostHog Code: name and description from each SKILL.md.
let skillCache: { at: number; items: { name: string; description: string; path: string; where: string }[] } | null = null
export function localSkills() {
  if (skillCache && Date.now() - skillCache.at < 10 * 60_000) return skillCache.items
  const items: { name: string; description: string; path: string; where: string }[] = []
  const seen = new Set<string>()
  const scan = (dir: string, where: string, depth: number) => {
    if (depth > 6 || !existsSync(dir)) return
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return }
    if (entries.includes('SKILL.md')) {
      const path = join(dir, 'SKILL.md')
      const head = readFileSync(path, 'utf8').slice(0, 2000)
      const name = head.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? dir.split('/').pop()!
      if (!seen.has(name)) { seen.add(name); items.push({ name, description: head.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '', path, where }) }
      return
    }
    for (const e of entries) if (!e.startsWith('.') && e !== 'node_modules') { const p = join(dir, e); try { if (statSync(p).isDirectory()) scan(p, where, depth + 1) } catch {} }
  }
  // Only what a Claude Code session can actually use: your skills, enabled plugins, synced plugins.
  // (Disabled plugins and other apps' skill folders are not "installed" for Claude Code.)
  // This profile's own Claude folder: Personal never lists Work's skills, or the other way round.
  const CLAUDE = profile.claudeDir
  scan(join(CLAUDE, 'skills'), 'Claude Code', 0)
  let enabled: Record<string, boolean> = {}
  try { enabled = JSON.parse(readFileSync(join(CLAUDE, 'settings.json'), 'utf8')).enabledPlugins ?? {} } catch {}
  try {
    const installed = JSON.parse(readFileSync(join(CLAUDE, 'plugins/installed_plugins.json'), 'utf8')).plugins ?? {}
    for (const [key, entries] of Object.entries<any[]>(installed)) {
      if (enabled[key] === false) continue
      for (const e of entries) if (e.scope === 'user' && e.installPath) scan(join(e.installPath, 'skills'), `plugin ${key.split('@')[0]}`, 0)
    }
  } catch {}
  const synced = join(CLAUDE, 'plugins/synced')
  if (existsSync(synced)) for (const d of readdirSync(synced)) scan(join(synced, d), 'plugin', 0)
  skillCache = { at: Date.now(), items }
  return items
}

export const SOURCES = Object.entries(sources).map(([id, s]) => ({ id, label: s.label }))

// Runs the chosen sources in parallel; each one is cut off at its own budget.
export async function quick(q: string, only?: string[], o: Opts = {}): Promise<SourceResult[]> {
  const ids = Object.keys(sources).filter(id => !only?.length || only.includes(id))
  return Promise.all(ids.map(async id => {
    const s = sources[id]
    const t0 = Date.now()
    try {
      const hits = await Promise.race([s.run(q, o), new Promise<Hit[]>((_, rej) => setTimeout(() => rej(new Error('timed out')), s.budget + 300))])
      return { source: id, label: s.label, hits, ms: Date.now() - t0 }
    } catch (e: any) {
      return { source: id, label: s.label, hits: [], ms: Date.now() - t0, error: String(e.message ?? e).slice(0, 160) }
    }
  }))
}
