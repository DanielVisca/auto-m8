// How the claude processes perch starts are billed.
// - By default, the unmodified `claude` CLI runs with whatever login you gave it (`claude auth
//   login`). Perch never reads, stores or passes Claude.ai credentials or session tokens.
// - Optionally, an Anthropic API key you add in Settings → Models (kept in the macOS keychain,
//   keychain.ts) is passed to every claude process perch starts as ANTHROPIC_API_KEY, so usage
//   bills to the API instead.
// Usage caps and the usage windows claude reports in its own stream (rate_limit_event) are kept
// here; router.ts and usage.ts read and write them through this module.
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { all, db, get, run } from './db.ts'
import { anthropicKey } from './keychain.ts'
import { HOME } from './settings.ts'
import { subscriptionBudget } from './subscription-budget.ts'
import type { Usage } from './usage.ts'

export type Billing = 'login' | 'api'
export const billing = (): Billing => anthropicKey() ? 'api' : 'login'
export const billingLabel = (b: Billing) => b === 'api' ? 'API key' : 'Claude Code login'

// Extra environment for a claude process: the API key when one is set, nothing otherwise.
export const claudeEnv = (): NodeJS.ProcessEnv => { const k = anthropicKey(); return k ? { ANTHROPIC_API_KEY: k } : {} }

// ---------- Claude subscriptions ----------
// One profile can hold several Claude subscriptions (a Team seat and a personal Max plan, say). Each
// is the claude CLI's own login in its own config folder (CLAUDE_CONFIG_DIR): auto-m8 never sees or
// stores a token. The extra folders link transcripts, skills, plugins, CLAUDE.md and settings back to
// the main one, so a chat moves between subscriptions by resuming the same session (--resume).
// 'main' is the profile's own folder (~/.claude, or the profile's CLAUDE_CONFIG_DIR).
export type Sub = { id: string; label: string; dir: string; main: boolean; enabled: boolean; pinned: boolean }
export type SubLogin = { loggedIn: boolean; email?: string; org?: string; plan?: string; at: number }
db.exec('create table if not exists claude_subs (id text primary key, label text not null, dir text, ord integer not null default 0, enabled integer not null default 1, pinned integer not null default 0)')
export const mainDir = () => process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude')
const SUBS_DIR = process.env.PERCH_CLAUDE_SUBS_DIR || join(HOME, '.claude-subs')
type SubRow = { id: string; label: string; dir: string | null; ord: number; enabled: number; pinned: number }
export function subs(): Sub[] {
  const rows = all<SubRow>('select * from claude_subs order by ord, rowid')
  const main = rows.find(r => r.id === 'main')
  const list = [main ?? { id: 'main', label: '', dir: null, ord: -1, enabled: 1, pinned: 0 }, ...rows.filter(r => r.id !== 'main')]
  return list.sort((a, b) => a.ord - b.ord).map(r => ({ id: r.id, label: r.label || defaultLabel(r.id), dir: r.id === 'main' ? mainDir() : r.dir!, main: r.id === 'main', enabled: !!r.enabled, pinned: !!r.pinned }))
}
const defaultLabel = (id: string) => { const l = logins.get(id); return l?.plan ? planLabel(l) : id === 'main' ? 'Claude' : id }
export const planLabel = (l: SubLogin) => l.plan === 'team' ? `${l.org ?? 'Team'} seat` : l.plan === 'enterprise' ? `${l.org ?? 'Enterprise'}` : l.plan ? `${l.plan[0].toUpperCase()}${l.plan.slice(1)}` : 'Claude'
export const subOf = (id?: string | null) => subs().find(s => s.id === (id || 'main')) ?? subs()[0]
export function addSub(label: string): Sub {
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || `sub-${Date.now().toString(36)}`
  if (id === 'main' || get('select 1 from claude_subs where id = ?', id)) throw new Error('A subscription with that name exists')
  const dir = join(SUBS_DIR, id)
  const ord = (get<{ m: number }>('select max(ord) m from claude_subs')?.m ?? 0) + 1
  run('insert into claude_subs (id, label, dir, ord) values (?, ?, ?, ?)', id, label.trim(), dir, ord)
  shareFolder(dir)
  return subOf(id)
}
const ensureMainRow = () => run("insert or ignore into claude_subs (id, label, dir, ord) values ('main', '', null, 0)")
export function updateSub(id: string, p: { label?: string; enabled?: boolean; pinned?: boolean; move?: -1 | 1 }) {
  ensureMainRow()
  if (p.label !== undefined) run('update claude_subs set label = ? where id = ?', p.label.trim(), id)
  if (p.enabled !== undefined) run('update claude_subs set enabled = ? where id = ?', p.enabled ? 1 : 0, id)
  if (p.pinned !== undefined) { run('update claude_subs set pinned = 0'); if (p.pinned) run('update claude_subs set pinned = 1 where id = ?', id) }
  if (p.move) {
    const list = subs(); for (const s of list) run("insert or ignore into claude_subs (id, label, dir, ord) values (?, '', ?, 0)", s.id, s.main ? null : s.dir)
    const i = list.findIndex(s => s.id === id), j = i + p.move
    if (i >= 0 && j >= 0 && j < list.length) { [list[i], list[j]] = [list[j], list[i]]; list.forEach((s, k) => run('update claude_subs set ord = ? where id = ?', k, s.id)) }
  }
}
export function removeSub(id: string) { if (id !== 'main') run('delete from claude_subs where id = ?', id) }

// Everything a chat needs from the main folder, linked so every subscription shares it. Not linked:
// the login (.credentials / keychain entry), .claude.json (holds the account), and the org's policy files.
const SHARED = ['projects', 'skills', 'agents', 'commands', 'hooks', 'plugins', 'CLAUDE.md', 'settings.json', 'file-history', 'todos', 'plans', 'shell-snapshots', 'session-env', 'history.jsonl', 'ide', 'chrome', 'output-styles']
// From .claude.json: MCP servers and per-folder trust, never the account fields.
const SHARED_KEYS = ['mcpServers', 'projects', 'hasCompletedOnboarding', 'theme', 'bypassPermissionsModeAccepted', 'hasAcknowledgedCostThreshold', 'lastOnboardingVersion', 'autoUpdates']
const mainJson = () => mainDir() === join(HOME, '.claude') ? join(HOME, '.claude.json') : join(mainDir(), '.claude.json')
const synced = new Map<string, number>()
export function shareFolder(dir: string) {
  mkdirSync(dir, { recursive: true })
  for (const n of SHARED) {
    const from = join(mainDir(), n), to = join(dir, n)
    if (!existsSync(from)) continue
    try { const st = lstatSync(to); if (st.isSymbolicLink()) continue; if (st.isDirectory() && readdirSync(to).length === 0) rmdirSync(to); else continue } catch {}
    try { symlinkSync(from, to) } catch {}
  }
  try {
    const src = mainJson(), m = statSync(src).mtimeMs
    if ((synced.get(dir) ?? 0) >= m) return
    const main = JSON.parse(readFileSync(src, 'utf8')), dst = join(dir, '.claude.json')
    const mine = existsSync(dst) ? JSON.parse(readFileSync(dst, 'utf8')) : {}
    for (const k of SHARED_KEYS) if (k in main) mine[k] = main[k]
    writeFileSync(dst, JSON.stringify(mine, null, 2), { mode: 0o600 })
    synced.set(dir, m)
  } catch {}
}

// Who each folder is signed in as, from `claude auth status` (the CLI's own answer).
const logins = new Map<string, SubLogin>()
export const loginOf = (id: string) => logins.get(id)
export function refreshLogins(force = false): Promise<void> {
  return Promise.all(subs().map(s => new Promise<void>(done => {
    const l = logins.get(s.id)
    if (!force && l && Date.now() - l.at < 10 * 60_000) return done()
    const env: NodeJS.ProcessEnv = { ...process.env }; delete env.CLAUDECODE
    if (s.dir !== join(HOME, '.claude')) env.CLAUDE_CONFIG_DIR = s.dir; else delete env.CLAUDE_CONFIG_DIR
    execFile('claude', ['auth', 'status'], { env, timeout: 15_000 }, (_e, out) => {
      try { const j = JSON.parse(String(out)); logins.set(s.id, { loggedIn: !!j.loggedIn, email: j.email, org: j.orgName, plan: j.subscriptionType, at: Date.now() }) }
      catch { if (!logins.has(s.id)) logins.set(s.id, { loggedIn: s.main, at: Date.now() }) }
      done()
    })
  }))).then(() => {})
}

// ---------- caps and usage, per subscription ----------
const subCaps = new Map<string, Map<string, number>>() // sub -> tier -> until
const usageBy = new Map<string, Usage>()
const TIERS = ['opus', 'sonnet', 'haiku'] // Fable is pin-only, so it never decides whether Claude is out
const capOf = (sub: string, tier: string, now: number) => Math.max(subCaps.get(sub)?.get(tier) ?? 0, subCaps.get(sub)?.get('all') ?? 0) > now
export function markSubCapped(sub: string, tiers: string[], until: number) {
  const m = subCaps.get(sub) ?? new Map<string, number>(); subCaps.set(sub, m)
  for (const t of tiers) m.set(t, Math.max(until, m.get(t) ?? 0))
}
// Usable now: switched on, signed in (or not checked yet), and not out on its own limits.
const usable = (s: Sub, now: number) => s.enabled && logins.get(s.id)?.loggedIn !== false && !(usageBy.get(s.id)?.blocked && (usageBy.get(s.id)!.windows.some(w => w.pct >= 1 && w.resetsAt > now)))
// The view the router reads: a tier counts as capped only when it is capped on every usable subscription.
export function capsOf(now = Date.now()): Map<string, number> {
  const out = new Map<string, number>()
  const live = subs().filter(s => usable(s, now))
  const pool = live.length ? live : subs().filter(s => s.main)
  for (const t of [...TIERS, 'fable']) {
    const untils = pool.map(s => Math.max(subCaps.get(s.id)?.get(t) ?? 0, subCaps.get(s.id)?.get('all') ?? 0))
    if (untils.every(u => u > now)) out.set(t, Math.min(...untils))
  }
  return out
}
export const clearCaps = () => subCaps.clear() // the billing changed: old caps no longer apply
export function noteClaudeUsage(u: Usage, sub = 'main') { const cur = usageBy.get(sub); if (!cur || u.at >= cur.at) usageBy.set(sub, u) }
export const subUsage = (sub: string) => usageBy.get(sub) ?? null
// No argument: the subscription Auto would use now.
export const claudeUsage = (sub?: string) => usageBy.get(sub ?? pickSub()) ?? null

// Which subscription a Claude turn runs on. Pinned wins while it can work. Otherwise stay on the
// chat's current one (its cache is warm) until it runs ahead of its pacing budget or out; then the
// first in your order that has room, else the one with the most room.
export function pickSub(tier = 'sonnet', current?: string | null, now = Date.now()): string {
  const list = subs(), ok = list.filter(s => usable(s, now) && !capOf(s.id, tier, now))
  if (!ok.length) return current && list.some(s => s.id === current) ? current : list.find(s => s.main)!.id
  const pin = ok.find(s => s.pinned)
  if (pin) return pin.id
  if (ok.length === 1 || anthropicKey()) return ok[0].id
  const pressure = (s: Sub) => subscriptionBudget(usageBy.get(s.id) ?? null, tier, now).pressure
  const cur = ok.find(s => s.id === current)
  if (cur && pressure(cur) <= 1) return cur.id
  return ok.find(s => pressure(s) <= 1)?.id ?? [...ok].sort((a, b) => pressure(a) - pressure(b))[0].id
}
export const subDir = (sub: string) => subOf(sub).dir

// When Claude is usable again: the latest cap or blocked window still in the future.
export function outUntil(now = Date.now()): number | null {
  const caps = capsOf(now), u = claudeUsage()
  const tiers = TIERS.map(t => caps.get(t) ?? 0)
  const capUntil = tiers.every(x => x > now) ? Math.min(...tiers) : 0
  const full = u?.blocked ? u.windows.filter(w => w.pct >= 1 && w.resetsAt > now).map(w => w.resetsAt) : []
  const until = Math.max(capUntil, ...full, 0)
  return until > now ? until : null
}
export const claudeOut = (now = Date.now()) => outUntil(now) !== null

export function billingStatus(now = Date.now()) {
  return { billing: billing(), apiKey: !!anthropicKey(), out: claudeOut(now), until: outUntil(now), usage: claudeUsage(),
    caps: [...capsOf(now)].map(([tier, until]) => ({ tier, until })) }
}

// How each chat's process was billed, from when it started: spend attributes each transcript
// message to the billing in force at its time. 'local' for local models, which bill nothing.
db.exec('create table if not exists chat_account_span (id text not null, account text not null, from_ts integer not null, primary key (id, from_ts))')
export function noteChatAccount(id: string, account: string, at = Date.now()) {
  const last = get<{ account: string }>('select account from chat_account_span where id = ? order by from_ts desc limit 1', id)
  if (last?.account !== account) run('insert or replace into chat_account_span (id, account, from_ts) values (?, ?, ?)', id, account, at)
}
