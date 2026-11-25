// How much of each subscription's limits is used, from what the agents already report, no extra calls:
// - Claude Code streams a rate_limit_event with the 5-hour and weekly utilisation after turns;
// - Codex writes its rate limits (plan windows, percent used, reset time) into its session files.
// Local models have no limit. Auto balances these windows against their reset dates and
// distinguishes exhausted included usage from an account that still has existing credits.
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, HOME, UNDER_TEST } from './settings.ts'
import { subscriptionBudget } from './subscription-budget.ts'
import { claudeUsage, noteClaudeUsage, pickSub, subs, subUsage } from './account.ts'

export type Win = { key: string; label: string; pct: number; resetsAt: number; minutes?: number } // pct 0..1, resetsAt in ms
export type Usage = { windows: Win[]; at: number; plan?: string; creditsAvailable?: boolean; blocked?: boolean }
const HOT = 0.95

const tail = (f: string, bytes: number) => {
  const size = statSync(f).size, fd = openSync(f, 'r')
  try { const len = Math.min(size, bytes), b = Buffer.alloc(len); readSync(fd, b, 0, len, size - len); return b.toString('utf8') } finally { closeSync(fd) }
}
const newest = (dir: string, ok: (n: string) => boolean, n: number): string[] => {
  const out: { f: string; t: number }[] = []
  const walk = (d: string, depth: number) => { try { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1) } else if (ok(e.name)) out.push({ f: p, t: statSync(p).mtimeMs }) } } catch {} }
  if (existsSync(dir)) walk(dir, 0)
  return out.sort((a, b) => b.t - a.t).slice(0, n).map(x => x.f)
}
const WIN_LABEL: Record<string, string> = { five_hour: '5h', seven_day: 'week', seven_day_opus: 'Opus week', seven_day_sonnet: 'Sonnet week' }

// ---------- Claude ----------
// Kept in account.ts, from the rate_limit_event the claude CLI itself streams.
// A plan with extra usage keeps answering once a window hits 100%: the event then says
// overageStatus "allowed"/"allowed_warning" (and isUsingOverage). Only "rejected" with no
// overage left means Claude really refuses, so that is what marks it blocked.
export function parseClaudeUsage(ev: any, at: number): Usage | null {
  const rl = ev?.rate_limit_info, w = rl?.unifiedWindows
  if (!w || typeof w !== 'object') return null
  const windows: Win[] = Object.entries<any>(w).filter(([, v]) => typeof v?.utilization === 'number').map(([key, v]) => ({ key, label: WIN_LABEL[key] ?? key.replace(/_/g, ' '), pct: v.utilization, resetsAt: Number(v.resetsAt) * 1000 }))
  if (!windows.length) return null
  const creditsAvailable = rl.overageStatus === 'allowed' || rl.overageStatus === 'allowed_warning'
  return { windows, at, creditsAvailable, blocked: rl.status === 'rejected' && !creditsAvailable }
}
// sub: the Claude subscription (account.ts) whose process reported it.
export function noteClaude(ev: any, at = Date.now(), sub = 'main') {
  const parsed = parseClaudeUsage(ev, at)
  if (parsed) noteClaudeUsage(parsed, sub)
}
const subOfRun = (out: string) => { try { return JSON.parse(readFileSync(out.replace(/\.out$/, '.json'), 'utf8')).sub || 'main' } catch { return 'main' } }
function bootClaude() {
  for (const f of newest(join(DATA_DIR, 'run'), n => n.endsWith('.out'), 12)) {
    try {
      const lines = tail(f, 300_000).split('\n')
      for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes('"rate_limit_event"')) { try { noteClaude(JSON.parse(lines[i]), statSync(f).mtimeMs, subOfRun(f)); break } catch {} }
    } catch {}
  }
}

// ---------- Codex ----------
let codex: Usage | null = null, codexAt = 0
const codexLabel = (mins: number) => mins <= 360 ? `${Math.round(mins / 60)}h` : mins >= 10080 ? 'week' : `${Math.round(mins / 60 / 24)}d`
// When the workspace refuses Codex outright, Codex writes a record under another limit_id ("premium")
// with rate_limit_reached_type "workspace_member_usage_limit_reached" and no windows. Ignoring it as
// another model's limit meant Auto never saw Codex was out and kept handing it chats that failed.
const WORKSPACE_BLOCK = /workspace|spend|member_usage/i
export function parseCodexUsage(rl: any, at: number): Usage | null {
  if (rl && rl.limit_id && rl.limit_id !== 'codex') return typeof rl.rate_limit_reached_type === 'string' && WORKSPACE_BLOCK.test(rl.rate_limit_reached_type) ? { windows: [], at, blocked: true } : null
  if (!rl) return null
  const windows: Win[] = [rl.primary, rl.secondary].filter(w => w && Number.isFinite(w.used_percent) && Number.isFinite(w.window_minutes) && w.window_minutes > 0 && Number.isFinite(w.resets_at)).map(w => ({ key: `m${w.window_minutes}`, label: codexLabel(w.window_minutes), pct: w.used_percent / 100, resetsAt: w.resets_at * 1000, minutes: w.window_minutes }))
  return windows.length ? { windows, at, plan: rl.plan_type, creditsAvailable: rl.credits?.has_credits === true || rl.credits?.unlimited === true, blocked: rl.spend_control_reached === true || !!rl.rate_limit_reached_type } : null
}
function readCodex() {
  if (UNDER_TEST) return // real account quotas must never control test fixtures
  if (Date.now() - codexAt < 30_000) return
  codexAt = Date.now()
  for (const f of newest(join(HOME, '.codex/sessions'), n => n.endsWith('.jsonl'), 6)) {
    try {
      const lines = tail(f, 400_000).split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"rate_limits"')) continue
        let x: any; try { x = JSON.parse(lines[i]) } catch { continue }
        const parsed = parseCodexUsage(x.payload?.rate_limits ?? x.rate_limits, Date.parse(x.timestamp) || statSync(f).mtimeMs)
        if (parsed) { if (!codex || parsed.at >= codex.at) codex = parsed; break }
      }
    } catch {}
  }
}

// A window whose reset time has passed is back to empty (the number we saw is old news).
const live = (u: Usage | null): Usage | null => u && { ...u, windows: u.windows.map(w => w.resetsAt && w.resetsAt < Date.now() ? { ...w, pct: 0 } : w) }
// claude: the subscription Auto would use now; claudeSubs: each one (the model menu shows them all).
export function usageNow() { readCodex(); return { claude: live(claudeUsage()), codex: live(codex) } }
export function claudeSubsNow() { const active = pickSub(); return subs().filter(s => s.enabled).map(s => ({ id: s.id, label: s.label, active: s.id === active, pinned: s.pinned, usage: live(subUsage(s.id)) })) }
const hot = (u: Usage | null) => !!u && u.windows.some(w => w.pct >= HOT)
export const claudeHot = () => hot(live(claudeUsage()))
export const codexHot = () => { readCodex(); return hot(live(codex)) }
// Included usage at 100% can still be usable on an account with existing credits.
// A refusal stays true after the 30-minute freshness window: once Codex is out, no new sessions run to
// report it again. It holds until a full window resets, or 12 hours for a workspace block with no reset.
export const CODEX_BLOCK_MS = 12 * 3_600_000
export function codexBlockedAt(u: Usage | null, now = Date.now()): boolean {
  if (!u?.blocked) return false
  const resets = u.windows.filter(w => w.pct >= 1).map(w => w.resetsAt).filter(t => t > now)
  return resets.length ? true : !u.windows.some(w => w.pct >= 1) && now - u.at < CODEX_BLOCK_MS
}
export const codexExhausted = () => { readCodex(); return codexBlockedAt(codex) || subscriptionBudget(live(codex)).exhausted }
if (!UNDER_TEST) { bootClaude(); readCodex() }
