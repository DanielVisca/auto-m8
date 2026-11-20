// Subscriptions: every Claude and OpenAI (ChatGPT plan, through Codex) login you have, personal and
// team, any number of each. Each one is its own config folder, the same way the CLIs keep logins
// apart: CLAUDE_CONFIG_DIR for claude, CODEX_HOME for codex. Perch never reads or copies the
// credentials themselves; it asks each CLI who it is signed in as.
//
// Found automatically: each profile's own Claude and OpenAI folders (Work ~/.claude + ~/.codex,
// Personal ~/.claude-personal + ~/.codex-personal), plus any other profile's that this one
// explicitly borrows (profile.ts: Profile.borrows) — one-directional, so Work can offer Personal's
// logins without Personal seeing Work's. Added ones live in ~/.claude-<id> / ~/.codex-<id>, belong
// to the profile that connected them (kept in that profile's own data folder), and share this
// profile's transcripts, settings, skills and MCP servers (symlinks), so a chat can move between
// subscriptions mid-conversation and keep its history, memory and tools.
//
// A chat picks one subscription per provider (chat_prefs.claude_sub / openai_sub); unset means
// this profile's own login, which is how perch always behaved.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { db, get, run } from './db.ts'
import { profile, profiles } from './profile.ts'

export type Provider = 'claude' | 'openai'
export type Sub = { id: string; provider: Provider; label: string; dir: string; builtin: boolean }
export type SubStatus = { ok: boolean; email?: string | null; org?: string | null; plan?: string | null; why?: string; at: number }

const HOME = homedir()
const DEFAULT_CLAUDE = join(HOME, '.claude')
// Per-profile data, not shared: an "added" subscription (e.g. a connected ChatGPT Team account)
// belongs only to the profile that connected it.
const FILE = process.env.PERCH_SUBSCRIPTIONS_FILE ?? join(profile.dataDir, 'subscriptions.json')

type Saved = { added: Sub[]; labels: Record<string, string> }
function load(): Saved {
  try { const j = JSON.parse(readFileSync(FILE, 'utf8')); return { added: j.added ?? [], labels: j.labels ?? {} } } catch { return { added: [], labels: {} } }
}
function save(s: Saved) { mkdirSync(dirname(FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(s, null, 2)) }

export const defaultClaudeId = () => `claude-${profile.id}`
export const defaultOpenaiId = () => `openai-${profile.id}`

// Every subscription: this profile's own logins first, then any profile it borrows, then the ones
// you connected. Same folder listed once.
export function subscriptions(): Sub[] {
  const s = load()
  const all = profiles()
  const own = all.find(p => p.id === profile.id) ?? profile
  const borrowed = all.filter(p => p.id !== own.id && (own.borrows ?? []).includes(p.id) && (p.enabled || existsSync(p.claudeDir)))
  const found: Sub[] = [own, ...borrowed].flatMap(p => [
    { id: `claude-${p.id}`, provider: 'claude' as const, label: p.label, dir: p.claudeDir, builtin: true },
    { id: `openai-${p.id}`, provider: 'openai' as const, label: p.label, dir: p.codexDir, builtin: true },
  ])
  const all_ = [...found, ...s.added.map(a => ({ ...a, builtin: false }))]
  const seen = new Set<string>()
  return all_.filter(x => !seen.has(x.dir) && !!seen.add(x.dir)).map(x => ({ ...x, label: s.labels[x.id] ?? x.label }))
}
export const subById = (id: string | null | undefined) => id ? subscriptions().find(s => s.id === id) ?? null : null

// ---------- who each one is signed in as ----------
const status = new Map<string, SubStatus>()
const STALE_MS = 2 * 60_000
const envFor = (s: Sub): NodeJS.ProcessEnv => {
  const e = { ...process.env }
  delete e.CLAUDECODE
  if (s.provider === 'claude') e.CLAUDE_CONFIG_DIR = s.dir
  else e.CODEX_HOME = s.dir
  return e
}
const runIn = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => new Promise<string>(res =>
  execFile(cmd, args, { env, timeout: 15_000 }, (e, out, err) => res(`${out ?? ''}${err ?? ''}${e && !out && !err ? e.message : ''}`)))

let codexBinOf: () => string | null = () => null
export const setCodexBin = (f: () => string | null) => { codexBinOf = f }

export async function check(s: Sub): Promise<SubStatus> {
  let st: SubStatus
  if (s.provider === 'claude') {
    const out = await runIn('claude', ['auth', 'status'], envFor(s))
    try {
      const j = JSON.parse(out.slice(out.indexOf('{')))
      st = j.loggedIn
        ? { ok: true, email: j.email ?? null, org: j.orgName ?? null, plan: j.planTier ?? j.subscriptionType ?? (j.authMethod === 'api_key' ? 'API key' : null), at: Date.now() }
        : { ok: false, why: 'Signed out', at: Date.now() }
    } catch { st = { ok: false, why: existsSync(s.dir) ? 'Signed out' : 'Not set up', at: Date.now() } }
  } else {
    const bin = codexBinOf()
    if (!bin) st = { ok: false, why: 'Codex CLI not found: install the Codex app or `npm i -g @openai/codex`', at: Date.now() }
    else {
      const out = await runIn(bin, ['login', 'status'], envFor(s))
      if (/OPENAI_API_KEY|Usage\s+\$ codex/i.test(out)) st = { ok: false, why: 'This Codex CLI is too old for ChatGPT sign-in: update it (`npm i -g @openai/codex`)', at: Date.now() }
      else if (/logged in/i.test(out) && !/not logged in/i.test(out)) st = { ok: true, plan: /chatgpt/i.test(out) ? 'ChatGPT plan' : /api key/i.test(out) ? 'API key' : null, at: Date.now() }
      else st = { ok: false, why: 'Signed out', at: Date.now() }
    }
  }
  status.set(s.id, st)
  return st
}
export const statusOf = (id: string) => status.get(id) ?? null
export async function refreshAll(force = false) {
  await Promise.all(subscriptions().map(s => {
    const st = status.get(s.id)
    return !force && st && Date.now() - st.at < STALE_MS ? st : check(s)
  }))
}
// A subscription is usable when it's signed in, or unknown yet (don't block on a first check).
export const subUsable = (id: string) => status.get(id)?.ok !== false

// ---------- connecting a new one ----------
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'account'
const link = (from: string, to: string) => { try { if (existsSync(from) && !lstatExists(to)) symlinkSync(from, to) } catch {} }
const lstatExists = (p: string) => { try { lstatSync(p); return true } catch { return false } }
// The Claude config file: ~/.claude.json for the default folder, <dir>/.claude.json otherwise.
const claudeJson = (dir: string) => dir === DEFAULT_CLAUDE ? join(HOME, '.claude.json') : join(dir, '.claude.json')

// A new folder that shares this profile's transcripts, instructions, skills and MCP servers, so a
// chat keeps its history and tools whichever subscription runs it. Only the login differs.
export function prepareDir(provider: Provider, dir: string) {
  mkdirSync(dir, { recursive: true })
  if (provider === 'claude') {
    const src = profile.claudeDir
    mkdirSync(join(src, 'projects'), { recursive: true })
    for (const f of ['projects', 'settings.json', 'CLAUDE.md', 'skills', 'agents', 'commands', 'plugins']) link(join(src, f), join(dir, f))
    // User-level MCP servers live next to the login in .claude.json; copy just those, never the login.
    const target = claudeJson(dir)
    if (!existsSync(target)) {
      let mcpServers = {}
      try { mcpServers = JSON.parse(readFileSync(claudeJson(src), 'utf8')).mcpServers ?? {} } catch {}
      writeFileSync(target, JSON.stringify({ mcpServers, hasCompletedOnboarding: true }, null, 2))
    }
  } else {
    const src = profile.codexDir
    mkdirSync(join(src, 'sessions'), { recursive: true })
    for (const f of ['config.toml', 'AGENTS.md', 'instructions.md', 'skills', 'sessions', 'models_cache.json']) link(join(src, f), join(dir, f))
  }
}

export function addSubscription(provider: Provider, label: string): Sub {
  const s = load()
  const taken = new Set(subscriptions().map(x => x.id))
  let base = `${provider}-${slug(label)}`, id = base
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`
  const dir = join(HOME, provider === 'claude' ? `.claude-${id.slice(7)}` : `.codex-${id.slice(7)}`)
  prepareDir(provider, dir)
  const sub: Sub = { id, provider, label: label.trim() || (provider === 'claude' ? 'Claude' : 'ChatGPT'), dir, builtin: false }
  s.added.push(sub)
  save(s)
  return sub
}
export function renameSubscription(id: string, label: string) {
  const s = load()
  const a = s.added.find(x => x.id === id)
  if (a) a.label = label; else s.labels[id] = label
  save(s)
}
// Forget a connected subscription: sign it out and drop it from the list. The folder stays (it holds
// nothing but the symlinks and a signed-out config), so nothing shared is ever deleted.
export async function removeSubscription(id: string) {
  const s = load()
  const sub = s.added.find(x => x.id === id)
  if (!sub) return { error: 'Only subscriptions you connected here can be removed; sign the built-in ones out from their profile.' }
  const bin = sub.provider === 'claude' ? 'claude' : codexBinOf()
  if (bin) await runIn(bin, sub.provider === 'claude' ? ['auth', 'logout'] : ['logout'], envFor(sub))
  s.added = s.added.filter(x => x.id !== id)
  save(s)
  status.delete(id)
  run('update chat_prefs set claude_sub = null where claude_sub = ?', id)
  run('update chat_prefs set openai_sub = null where openai_sub = ?', id)
  return { ok: true }
}

// ---------- signing in ----------
// One sign-in at a time per subscription: `claude auth login` / `codex login` in that folder. Both
// open the browser themselves and finish when you approve there.
export type Login = { state: 'waiting' | 'done' | 'failed'; url?: string; error?: string; at: number }
export const logins = new Map<string, Login>()
const procs = new Map<string, ChildProcess>()
export function startSubLogin(id: string, onChange: () => void): Login | { error: string } {
  const sub = subById(id)
  if (!sub) return { error: 'No such subscription' }
  const bin = sub.provider === 'claude' ? 'claude' : codexBinOf()
  if (!bin) return { error: 'Codex CLI not found: install the Codex app or `npm i -g @openai/codex`' }
  procs.get(id)?.kill()
  if (!sub.builtin || sub.provider === 'openai') mkdirSync(sub.dir, { recursive: true })
  const l: Login = { state: 'waiting', at: Date.now() }
  logins.set(id, l)
  let out = ''
  const p = spawn(bin, sub.provider === 'claude' ? ['auth', 'login'] : ['login'], { env: envFor(sub), stdio: ['pipe', 'pipe', 'pipe'] })
  procs.set(id, p)
  const read = (d: Buffer) => { out += d; const url = out.match(/https:\/\/\S+/)?.[0]; if (url && url !== l.url) { l.url = url; onChange() } }
  p.stdout!.on('data', read); p.stderr!.on('data', read)
  p.on('error', e => { procs.delete(id); Object.assign(l, { state: 'failed', error: e.message }); onChange() })
  p.on('exit', async code => {
    if (procs.get(id) !== p) return
    procs.delete(id)
    const st = await check(sub)
    Object.assign(l, st.ok ? { state: 'done', error: undefined } : { state: 'failed', error: out.replace(/https:\/\/\S+/g, '').trim().slice(-300) || `exited ${code}` })
    onChange()
  })
  setTimeout(() => { if (procs.get(id) === p) p.kill() }, 10 * 60_000).unref?.()
  onChange()
  return l
}
export function submitSubCode(id: string, code: string) {
  const p = procs.get(id)
  if (!p) return { error: 'no sign-in waiting for a code' }
  p.stdin!.write(code.trim() + '\n')
  return { ok: true }
}

// ---------- which one a chat uses ----------
db.exec('create table if not exists chat_prefs (id text primary key, turbo integer)') // same as turns.ts; whichever loads first
try { db.exec('alter table chat_prefs add column claude_sub text') } catch {}
try { db.exec('alter table chat_prefs add column openai_sub text') } catch {}
const col = (p: Provider) => p === 'claude' ? 'claude_sub' : 'openai_sub'
// The chat's choice, or null for this profile's own login. A removed subscription reads as unset.
export function chatSub(id: string, p: Provider): string | null {
  const v = get<any>(`select ${col(p)} v from chat_prefs where id = ?`, id)?.v ?? null
  return v && subById(v)?.provider === p ? v : null
}
export function setChatSub(id: string, p: Provider, sub: string | null) {
  const v = sub && sub !== (p === 'claude' ? defaultClaudeId() : defaultOpenaiId()) ? sub : null
  run(`insert into chat_prefs (id, ${col(p)}) values (?, ?) on conflict(id) do update set ${col(p)} = excluded.${col(p)}`, id, v)
}

// The claude config folder for a chat's subscription (undefined: this profile's own). A folder
// with its own transcripts (another profile's) gets a link to this chat's transcript first, so
// --resume finds it and new turns append to the one file this profile indexes.
export function claudeDirForChat(id: string, cwd: string): string | undefined {
  const sub = subById(chatSub(id, 'claude'))
  if (!sub) return undefined
  const proj = (d: string) => join(d, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  const from = join(proj(profile.claudeDir), `${id}.jsonl`), to = join(proj(sub.dir), `${id}.jsonl`)
  try { if (existsSync(from) && !lstatExists(to)) { mkdirSync(dirname(to), { recursive: true }); symlinkSync(from, to) } } catch {}
  return sub.dir
}
// Extra environment for a chat's Codex turn: CODEX_HOME when it runs on a non-default subscription.
export function codexEnvForChat(id: string): NodeJS.ProcessEnv {
  const sub = subById(chatSub(id, 'openai'))
  return sub && sub.dir !== profile.codexDir ? { CODEX_HOME: sub.dir } : {}
}
export const subLabelOf = (id: string) => { const s = subById(id); return s ? `${s.provider === 'claude' ? 'Claude' : 'OpenAI'} · ${s.label}` : null }

// The list the picker and Settings show.
export function subscriptionsView() {
  return {
    subs: subscriptions().map(s => ({ ...s, status: status.get(s.id) ?? null, login: logins.get(s.id) ?? null,
      isDefault: s.id === (s.provider === 'claude' ? defaultClaudeId() : defaultOpenaiId()), folder: basename(s.dir) })),
  }
}
