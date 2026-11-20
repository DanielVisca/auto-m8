// Pace included allowances until their own reset dates. This is a routing preference,
// not an artificial cap: active work can still use a provider that is ahead of budget.
import type { Usage } from './usage.ts'

export type Provider = 'claude' | 'codex' | 'local'
const FRESH_MS = 30 * 60_000
const durationMinutes = (key: string) => key.startsWith('seven_day') ? 10080 : key === 'five_hour' ? 300 : Number(key.match(/^m(\d+)$/)?.[1])

export function subscriptionBudget(usage: Usage | null, tier = '', now = Date.now()) {
  const windows = usage && now - usage.at <= FRESH_MS ? usage.windows.filter(w =>
    Number.isFinite(w.pct) && w.pct >= 0 && Number.isFinite(w.resetsAt) && w.resetsAt > now &&
    (!/^seven_day_(opus|sonnet|haiku|fable)$/.test(w.key) || w.key === `seven_day_${tier}`),
  ) : []
  const pressure = Math.max(0, ...windows.map(w => {
    const mins = w.minutes ?? durationMinutes(w.key)
    // A small opening allowance permits bursts; preserve 10% for the end of a long window.
    const elapsed = Math.max(0, Math.min(1, 1 - (w.resetsAt - now) / (mins * 60_000)))
    const allowance = mins >= 1440 ? 0.1 + 0.8 * elapsed : 0.9
    return w.pct / allowance
  }))
  const fresh = !!usage && now - usage.at <= FRESH_MS
  return { pressure, exhausted: fresh && (usage?.blocked === true || (windows.some(w => w.pct >= 1) && usage?.creditsAvailable !== true)) }
}

export function chooseProvider(o: {
  claude: Usage | null; codex: Usage | null; tier: string
  claudeReady: boolean; codexReady: boolean; localReady: boolean
  current?: 'claude' | 'codex'; now?: number
}): { provider: Provider; why: string; conserve: boolean } {
  const cb = subscriptionBudget(o.claude, o.tier, o.now), xb = subscriptionBudget(o.codex, '', o.now)
  const conserve = cb.pressure > 1 || xb.pressure > 1
  const candidates = [
    { provider: 'claude' as const, budget: cb, ready: o.claudeReady && !cb.exhausted },
    { provider: 'codex' as const, budget: xb, ready: o.codexReady && !xb.exhausted },
  ].filter(p => p.ready)
  if (!candidates.length) return { provider: o.localReady ? 'local' : o.codexReady ? 'codex' : 'claude', why: 'subscription allowances are unavailable', conserve: true }
  const current = candidates.find(p => p.provider === (o.current ?? 'claude')) ?? candidates[0]
  const other = candidates.find(p => p !== current)
  // Stay on the warm conversation unless the budget difference warrants a handoff.
  const pick = other && current.budget.pressure > 1 && other.budget.pressure + 0.2 < current.budget.pressure ? other : current
  return { provider: pick.provider, why: pick === current && candidates.length === 1 ? 'the other subscription is unavailable' : 'pacing subscription usage until its reset', conserve }
}
