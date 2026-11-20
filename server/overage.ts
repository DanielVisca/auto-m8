// Codex credits as a status line, shown next to the plan usage only when it matters: plan usage near
// its limit, credits being spent, or credits running low. The parser is pure and written against real
// payloads of the endpoint Codex's own /status reads; overageNow caches it for a few minutes.
// Claude has no line here: perch never reads Claude.ai credentials, so Claude's usage comes only from
// what the claude CLI reports in its own stream (usage.ts).

export type OverageStatus = {
  provider: 'claude' | 'codex'
  unit: 'usd' | 'credits'
  enabled: boolean // overage/credits allowed once the plan runs out
  onCredits: boolean // a plan window is full, so usage is coming out of overage now
  used?: number
  limit?: number // cap for the period; undefined = no cap
  remaining?: number // undefined = unlimited
  resetsAt?: number // ms, when the cap resets
  low: boolean // under 20% of the cap, or under $5 left
  exhausted: boolean
}
const SHOW_AT = 0.8, LOW_FRACTION = 0.2, LOW_DOLLARS = 5
const num = (v: any): number | undefined => { const n = typeof v === 'string' && v.trim() ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : undefined }

function finish(s: Omit<OverageStatus, 'low' | 'exhausted'>, worst: number, reached: boolean): OverageStatus | null {
  const remaining = s.remaining ?? (s.limit !== undefined && s.used !== undefined ? Math.max(0, s.limit - s.used) : undefined)
  const exhausted = s.enabled && (reached || (remaining !== undefined && remaining <= 0))
  const low = s.enabled && (exhausted || (remaining !== undefined && ((s.unit === 'usd' && remaining < LOW_DOLLARS) || (!!s.limit && remaining / s.limit < LOW_FRACTION))))
  if (worst < SHOW_AT && !low) return null // nothing worth a line yet
  return { ...s, remaining, low, exhausted }
}

// raw = GET chatgpt.com/backend-api/wham/usage. Window used_percent is a percent, reset_at epoch seconds.
// The real cap is spend_control.individual_limit (workspace credits per period); credits.balance is often null.
export function codexOverage(raw: any, now = Date.now()): OverageStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const wins = [raw.rate_limit?.primary_window, raw.rate_limit?.secondary_window].filter(w => num(w?.used_percent) !== undefined)
  if (!wins.length) return null
  const worst = Math.max(...wins.map(w => num(w.used_percent)! / 100))
  const c = raw.credits ?? {}, cap = raw.spend_control?.individual_limit
  const enabled = c.has_credits === true || c.unlimited === true || !!cap
  const base = { provider: 'codex' as const, unit: 'credits' as const, enabled, onCredits: enabled && worst >= 1 }
  if (!enabled) return finish(base, worst, false)
  if (cap && c.unlimited !== true) {
    const reset = num(cap.reset_at)
    return finish({ ...base, used: num(cap.used), limit: num(cap.limit), remaining: num(cap.remaining), resetsAt: reset && reset * 1000 > now ? reset * 1000 : undefined }, worst, raw.spend_control?.reached === true || c.overage_limit_reached === true)
  }
  return finish({ ...base, remaining: c.unlimited === true ? undefined : num(c.balance) }, worst, c.overage_limit_reached === true)
}

// One line for the model menu, e.g. "On credits · $34 of $100 left · resets Dec 1".
export type OverageLine = { text: string; heat: 'ok' | 'warm' | 'hot'; title: string }
export function overageLine(s: OverageStatus | null, now = Date.now()): OverageLine | null {
  if (!s) return null
  const amt = (n: number) => s.unit === 'usd' ? `$${n < 10 && n % 1 ? n.toFixed(2) : Math.round(n).toLocaleString('en-US')}` : Math.round(n).toLocaleString('en-US')
  const day = s.resetsAt ? new Date(s.resetsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : ''
  const resets = day ? ` · resets ${day}` : ''
  const kind = s.unit === 'usd' ? 'Overage' : 'Credits'
  const unitWord = s.unit === 'usd' ? '' : ' credits'
  const title = [
    s.used !== undefined ? `${amt(s.used)}${s.limit !== undefined ? ` of ${amt(s.limit)}` : ''}${unitWord} used` : '',
    day && `Cap resets ${day}${s.resetsAt! - now > 0 ? ` (in ${Math.ceil((s.resetsAt! - now) / 86400_000)}d)` : ''}`,
    s.enabled ? 'Once the plan limit is hit, requests keep running on these.' : 'Requests stop when the plan limit is hit.',
  ].filter(Boolean).join('\n')
  if (!s.enabled) return { text: `${kind} off · requests stop at the plan limit`, heat: s.onCredits ? 'hot' : 'warm', title }
  if (s.exhausted) return { text: `Out of ${s.unit === 'usd' ? 'overage' : 'credits'}${resets}`, heat: 'hot', title }
  const left = s.remaining !== undefined ? `${amt(s.remaining)}${s.limit !== undefined ? ` of ${amt(s.limit)}` : ''} left${resets}`
    : `${s.used !== undefined ? `${amt(s.used)} used, ` : ''}no cap`
  return { text: `${s.onCredits ? 'On credits' : `${kind} on`} · ${left}`, heat: s.low ? 'warm' : 'ok', title }
}

// ---------- fetch ----------
// perch never reads another tool's stored credentials (~/.codex/auth.json) or calls private usage
// endpoints with them, so there is no live Codex overage line. codexOverage/overageLine stay for
// when Codex reports usage itself.
export type Overage = { codex: OverageLine | null }
export async function overageNow(): Promise<Overage> {
  return { codex: null }
}
