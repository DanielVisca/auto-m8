// Profiles: Work and Personal (or more), kept apart. Each profile is its own perch server with
// its own data (conversations, PRs, notes, settings), its own Claude login (CLAUDE_CONFIG_DIR:
// subscription, MCP servers, connectors, transcripts), GitHub login (GH_CONFIG_DIR) and PostHog
// key. The window switches between them; both keep running. Nothing crosses over unless you copy
// it, and a copy is shown to you first.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
export const BASE_DIR = join(HOME, 'Library/Application Support/perch')
const FILE = join(BASE_DIR, 'profiles.json')

// borrows: other profile ids whose Claude and OpenAI logins this profile also offers as
// subscriptions (subscriptions.ts), on top of its own. One-directional: Work borrowing Personal
// does not mean Personal can see Work's.
export type Profile = { id: string; label: string; color: string; port: number; dataDir: string; claudeDir: string; codexDir: string; ghDir: string | null; enabled: boolean; borrows: string[] }

// Work is what perch has always been: the default data folder, ~/.claude, ~/.codex, your default
// gh login. It also borrows Personal's logins by default, since the reverse (company access from
// a personal profile) is the one you don't want.
const DEFAULTS: Profile[] = [
  { id: 'work', label: 'Work', color: '#d97706', port: 4777, dataDir: BASE_DIR, claudeDir: join(HOME, '.claude'), codexDir: join(HOME, '.codex'), ghDir: null, enabled: true, borrows: ['personal'] },
  { id: 'personal', label: 'Personal', color: '#2a9d6f', port: 4778, dataDir: join(BASE_DIR, 'profiles/personal'), claudeDir: join(HOME, '.claude-personal'), codexDir: join(HOME, '.codex-personal'), ghDir: join(HOME, '.config/gh-personal'), enabled: false, borrows: [] },
]

export function profiles(): Profile[] {
  try {
    const saved: Profile[] = JSON.parse(readFileSync(FILE, 'utf8')).profiles
    return DEFAULTS.map(d => ({ ...d, ...saved.find(s => s.id === d.id) })).concat(saved.filter(s => !DEFAULTS.some(d => d.id === s.id)))
  } catch { return DEFAULTS }
}
export function saveProfiles(update: (ps: Profile[]) => Profile[]) {
  mkdirSync(BASE_DIR, { recursive: true })
  const ps = update(profiles())
  writeFileSync(FILE, JSON.stringify({ profiles: ps }, null, 2))
  return ps
}

// This server's profile, from the shell (PERCH_PROFILE). Test servers default to Work's settings
// but keep their own data folder (PERCH_DATA).
export const PROFILE_ID = process.env.PERCH_PROFILE ?? 'work'
export const profile: Profile = profiles().find(p => p.id === PROFILE_ID) ?? DEFAULTS[0]

// Every process perch starts (claude, gh, terminals) inherits these, so a profile only ever uses its
// own accounts.
export function applyProfileEnv() {
  if (profile.claudeDir !== join(HOME, '.claude')) { mkdirSync(profile.claudeDir, { recursive: true }); process.env.CLAUDE_CONFIG_DIR = profile.claudeDir }
  if (profile.codexDir !== join(HOME, '.codex')) { mkdirSync(profile.codexDir, { recursive: true }); process.env.CODEX_HOME = profile.codexDir }
  if (profile.ghDir) { mkdirSync(profile.ghDir, { recursive: true }); process.env.GH_CONFIG_DIR = profile.ghDir }
}

// Setup state for the switcher: is this profile logged in to Claude and GitHub yet? Asked of the
// tools themselves (logins live in the keychain, not in files).
export async function readiness(p: Profile) {
  const { execFile } = await import('node:child_process')
  // Each check gets exactly that profile's folders: set when it has its own, removed when it uses the default.
  const envFor = (key: string, dir: string | null) => { const e = { ...process.env }; if (dir) e[key] = dir; else delete e[key]; return e }
  const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => new Promise<{ ok: boolean; out: string }>(res =>
    execFile(cmd, args, { env, timeout: 15_000 }, (e, out, err) => res({ ok: !e, out: String(out || err) })))
  const [c, g] = await Promise.all([
    run('claude', ['auth', 'status'], envFor('CLAUDE_CONFIG_DIR', p.claudeDir === join(HOME, '.claude') ? null : p.claudeDir)),
    run('gh', ['auth', 'status'], envFor('GH_CONFIG_DIR', p.ghDir))])
  let account: string | null = null
  try { const j = JSON.parse(c.out); account = j.loggedIn ? (j.email ?? j.account ?? j.authMethod ?? 'logged in') : null } catch {}
  return { claude: account, github: g.ok ? (g.out.match(/account (\S+)/)?.[1] ?? 'logged in') : null }
}
