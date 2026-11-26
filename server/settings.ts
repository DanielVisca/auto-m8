// Settings live in one JSON file next to the database. Sections merge shallowly over the
// defaults, so a new setting appears without a migration.
import { profile } from './profile.ts'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const HOME = homedir()
// Tests never touch the real data folder or db. A test file run on its own, without npm test's
// PERCH_DB/PERCH_DATA, once wrote shepherd fixtures (r/stopped, r/cap-old…) into the live db, and
// backfillDecisions then crashed on them (2026-11-14).
export const UNDER_TEST = !!process.env.NODE_TEST_CONTEXT || /\.test\.ts$/.test(process.argv[1] ?? '')
if (UNDER_TEST) {
  const isLive = (path?: string) => !!path && (resolve(path) === resolve(profile.dataDir) || resolve(path).startsWith(resolve(profile.dataDir) + '/'))
  if (!process.env.PERCH_DB || isLive(process.env.PERCH_DB)) process.env.PERCH_DB = ':memory:'
  // Perch itself exports PERCH_DATA to its agents. A bare node --test therefore inherited the
  // live settings folder even though its database was in memory. Keep both isolated.
  if (!process.env.PERCH_DATA || isLive(process.env.PERCH_DATA)) process.env.PERCH_DATA = mkdtempSync(join(tmpdir(), 'perch-test-'))
}
export const DATA_DIR = process.env.PERCH_DATA ?? join(HOME, 'Library/Application Support/perch')
mkdirSync(DATA_DIR, { recursive: true })
const FILE = join(DATA_DIR, 'settings.json')
function saveSettings(value: unknown) {
  // Readers (including other agent processes) must never see a truncated JSON file.
  const temporary = `${FILE}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2))
  renameSync(temporary, FILE)
}

export type Source = { id: string; label: string; dir: string; configDir: string }

export type Settings = {
  port: number
  sources: Source[]
  // projectId: unset until you pick one in Settings, or picked from the key's own project (indexer.ts ensureUser).
  posthog: { host: string; projectId?: number | null; pollSeconds: number }
  chat: { permissionMode: string; model: string; cwd: string; chrome: boolean; idleMinutes: number }
  window: { alwaysOnTop: boolean; hotkey: string; collapseHotkey?: string; bounds: { x: number; y: number; width: number; height: number } | null; autoMini: boolean; autoTuck?: boolean }
  ui: { theme: 'system' | 'light' | 'dark'; layout?: string; favourites?: string[] } // layout: a file in layouts/ or a shipped one (server/layout.ts); favourites: layouts on ⌘⌥1-9, in order
  organize: { archiveDoneAfterDays: number }
  ai: { model: string; dailyBrief: boolean; attention?: boolean } // the model for briefs, history answers and skill search
  needs: { enabled: boolean; engine: string; maxRunsPerDay: number }
  // Slack workspaces, so a <workspace>.slack.com link can open in the Slack app (slack.ts slackAppLink).
  // Each entry is "<workspace>:<team id>", e.g. "acme:T0123ABCD". A bare team id is used for any workspace.
  slack: { teams: string[] }
  // mcp_tool_call events for auto-m8's own MCP tools, sent to the connected PostHog project (mcpanalytics.ts). No argument values or results.
  mcpAnalytics?: { enabled: boolean }
  remote: { enabled: boolean } // phone access on the local network
  // Phone (server/mobile.ts): push when something needs you while you're away; keep the Mac awake while agents run.
  mobile: { push: boolean; stayAwake: boolean; tailscale: boolean }
  // Local models through Ollama: a chat can pick one; background jobs can all run on one.
  local: { baseUrl: string; model: string; background: boolean }
  focus: { active: boolean; areas: { name: string; query: string }[] }
  // PRs agents open here get a shepherd the moment a comment lands or CI goes red (server/shepherd.ts).
  shepherd: { auto: boolean; autoSince: number; pollSeconds: number; quietSeconds: number; maxRunsPerDay: number }
  // Evolve (server/evolve.ts): learn your use cases, write skills for repeated ones, tune them.
  evolve: { enabled: boolean; forge: boolean; tune: boolean; resume: boolean }
  // Decisions (server/decisions.ts): how long perch waits on a big one before taking its recommendation (0: never).
  decisions: { autoAfterHours: number; autoFixesPerDay: number; askMe?: boolean } // askMe off: perch takes every recommendation at once and agents decide
  // Lifecycle (server/lifecycle.ts): quiet chats get a closing pass that saves learnings to memory, then close.
  lifecycle: { enabled: boolean }
  // Agent browser (server/browser.ts): a dedicated Chrome profile perch drives over CDP, one window per chat.
  // sites: host (or *.host) -> trusted (no confirm gates) | allow (gated irreversible clicks) | read (no input) | deny (can't open).
  // Who perch works for (owner.ts). Blank name: the first name from git config, else the login name.
  owner: { name: string }
  // One switch for agents that act on their own: PR shepherd, autopilot (scans, self-fix), evolve, lifecycle.
  // On for installs that predate it; a fresh install starts with it off (see FRESH below).
  autonomy: { enabled: boolean; pausedAt?: number | null; reason?: string | null; interrupted?: string[] } // enabled off = paused (server/pause.ts)
  welcome?: boolean // fresh installs: show the setup checklist on Home until it is dismissed
  // Anonymous usage stats (telemetry.ts). On for fresh installs (opt-out), off for installs that predate it.
  telemetry: { enabled: boolean; key?: string; host?: string }
  // Unblocker cards on Home and the once-per-chat nudge in the system prompt (suggestions.ts). Fresh installs only.
  nudges: { enabled: boolean }
  browser: { enabled: boolean; chromePath: string; headless: boolean; defaultPolicy: 'trusted' | 'allow' | 'read' | 'deny'; sites: Record<string, 'trusted' | 'allow' | 'read' | 'deny'>; confirmIrreversible: boolean; allowedActions: string[]; maxSessions: number; recordingDays: number; recordVisual: boolean; showWindows: boolean }
}

const POSTHOG_CODE = join(HOME, 'Library/Application Support/@posthog/posthog-code/claude')

export const defaults: Settings = {
  port: 4777,
  // The profile's own Claude login and transcripts; PostHog Code only belongs to Work.
  sources: [
    { id: 'claude', label: 'Claude Code', dir: join(profile.claudeDir, 'projects'), configDir: profile.claudeDir },
    ...(profile.id === 'work' ? [{ id: 'posthog-code', label: 'PostHog Code', dir: join(POSTHOG_CODE, 'projects'), configDir: POSTHOG_CODE }] : []),
  ],
  posthog: { host: 'https://us.posthog.com', pollSeconds: 60 },
  chat: { permissionMode: 'auto', model: '', cwd: join(HOME, 'Development'), chrome: false, idleMinutes: 20 },
  window: { alwaysOnTop: true, hotkey: 'Control+Alt+Space', collapseHotkey: 'Control+Alt+M', bounds: null, autoMini: true, autoTuck: true },
  ui: { theme: 'system' },
  organize: { archiveDoneAfterDays: 7 },
  ai: { model: 'sonnet', dailyBrief: true },
  needs: { enabled: true, engine: 'codex', maxRunsPerDay: 24 },
  slack: { teams: [] },
  remote: { enabled: false },
  mobile: { push: true, stayAwake: true, tailscale: false },
  local: { baseUrl: 'http://127.0.0.1:11434', model: '', background: false },
  focus: { active: false, areas: [] },
  shepherd: { auto: true, autoSince: 0, pollSeconds: 45, quietSeconds: 60, maxRunsPerDay: 12 },
  evolve: { enabled: true, forge: true, tune: true, resume: true },
  decisions: { autoAfterHours: 4, autoFixesPerDay: 3, askMe: false },
  lifecycle: { enabled: true },
  owner: { name: '' },
  autonomy: { enabled: true },
  telemetry: { enabled: false },
  nudges: { enabled: false },
  browser: { enabled: true, chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: false, defaultPolicy: 'allow', sites: {}, confirmIrreversible: true, allowedActions: [], maxSessions: 6, recordingDays: 14, recordVisual: false, showWindows: false },
}

function merge(base: Settings, patch: Partial<Settings>): Settings {
  const out: any = { ...base }
  for (const [k, v] of Object.entries(patch ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && (base as any)[k] ? { ...(base as any)[k], ...v } : v
  }
  return out
}

// A brand-new install (no settings file yet) starts quiet: nothing acts on its own, and nothing spends the
// Claude subscription in the background, until the owner turns autonomy on. Existing installs keep theirs.
export const FRESH = !existsSync(FILE)
// No projectId: picked from the PostHog key once one is saved (indexer.ts ensureUser).
// The usual places people keep repos; the first that exists is where new chats start.
const CODE_DIRS = ['Development', 'code', 'src', 'Projects', 'projects', 'dev', 'repos', 'workspace', 'GitHub', 'Documents/GitHub', 'Developer']
// Where repos live: the chat folder plus whichever usual places exist (search, PR checkouts).
export const codeRoots = () => [...new Set([settings.chat.cwd, ...CODE_DIRS.map(d => join(HOME, d))])].filter(d => d && d !== HOME && existsSync(d))
const FRESH_START = { autonomy: { enabled: false }, welcome: true, posthog: { projectId: null }, telemetry: { enabled: true }, nudges: { enabled: true },
  chat: { ...defaults.chat, cwd: CODE_DIRS.map(d => join(HOME, d)).find(d => existsSync(d)) ?? HOME } }
export let settings: Settings = merge(defaults, FRESH ? FRESH_START as Partial<Settings> : JSON.parse(readFileSync(FILE, 'utf8')))
if (FRESH) saveSettings(FRESH_START)
export const autonomyOn = () => settings.autonomy?.enabled !== false

// Read fresh from disk: the MCP process (where agents raise decisions) is long-lived and doesn't see
// updateSettings calls made in the main server.
export function askMe(): boolean {
  try { return !!(existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {})?.decisions?.askMe } catch { return !!settings.decisions?.askMe }
}

export function updateSettings(patch: Partial<Settings>): Settings {
  settings = merge(settings, patch)
  saveSettings(settings)
  return settings
}
