// How the claude processes perch starts are billed.
// - By default, the unmodified `claude` CLI runs with whatever login you gave it (`claude auth
//   login`). Perch never reads, stores or passes Claude.ai credentials or session tokens.
// - Optionally, an Anthropic API key you add in Settings → Models (kept in the macOS keychain,
//   keychain.ts) is passed to every claude process perch starts as ANTHROPIC_API_KEY, so usage
//   bills to the API instead.
// Usage caps and the usage windows claude reports in its own stream (rate_limit_event) are kept
// here; router.ts and usage.ts read and write them through this module.
import { db, get, run } from './db.ts'
import { anthropicKey } from './keychain.ts'
import type { Usage } from './usage.ts'

export type Billing = 'login' | 'api'
export const billing = (): Billing => anthropicKey() ? 'api' : 'login'
export const billingLabel = (b: Billing) => b === 'api' ? 'API key' : 'Claude Code login'

// Extra environment for a claude process: the API key when one is set, nothing otherwise.
export const claudeEnv = (): NodeJS.ProcessEnv => { const k = anthropicKey(); return k ? { ANTHROPIC_API_KEY: k } : {} }

// ---------- caps and usage ----------
const capped = new Map<string, number>()
export const capsOf = () => capped
export const clearCaps = () => capped.clear() // the billing changed: old caps no longer apply
let usage: Usage | null = null
export const claudeUsage = () => usage
export function noteClaudeUsage(u: Usage) { if (!usage || u.at >= usage.at) usage = u }

const TIERS = ['opus', 'sonnet', 'haiku'] // Fable is pin-only, so it never decides whether Claude is out
// When Claude is usable again: the latest cap or blocked window still in the future.
export function outUntil(now = Date.now()): number | null {
  const caps = TIERS.map(t => capped.get(t) ?? 0)
  const capUntil = caps.every(u => u > now) ? Math.min(...caps) : 0
  const full = usage?.blocked ? usage.windows.filter(w => w.pct >= 1 && w.resetsAt > now).map(w => w.resetsAt) : []
  const until = Math.max(capUntil, ...full, 0)
  return until > now ? until : null
}
export const claudeOut = (now = Date.now()) => outUntil(now) !== null

export function billingStatus(now = Date.now()) {
  return { billing: billing(), apiKey: !!anthropicKey(), out: claudeOut(now), until: outUntil(now), usage,
    caps: [...capped].filter(([, u]) => u > now).map(([tier, until]) => ({ tier, until })) }
}

// How each chat's process was billed, from when it started: spend attributes each transcript
// message to the billing in force at its time. 'local' for local models, which bill nothing.
db.exec('create table if not exists chat_account_span (id text not null, account text not null, from_ts integer not null, primary key (id, from_ts))')
export function noteChatAccount(id: string, account: string, at = Date.now()) {
  const last = get<{ account: string }>('select account from chat_account_span where id = ? order by from_ts desc limit 1', id)
  if (last?.account !== account) run('insert or replace into chat_account_span (id, account, from_ts) values (?, ?, ?)', id, account, at)
}
