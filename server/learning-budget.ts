// Experiments yield before foreground routing does. Included credits are for real work;
// don't use paid overage to keep background learning going. A high reading stays useful
// even when old: release it at its reset, or when a newer report shows room again.
import { usageNow, type Usage } from './usage.ts'

export const LEARNING_LIMIT = 0.8
export type LearningGate = { provider: 'claude' | 'codex'; paused: boolean; reason: string | null; resumesAt: number | null }
export type UsageSnapshot = ReturnType<typeof usageNow>

export function learningGate(model: string, usage: UsageSnapshot = usageNow(), now = Date.now()): LearningGate | null {
  const provider = /^(codex(?::|$)|gpt-|o[134](?:-|$))/.test(model) ? 'codex'
    : /^(claude[-:]|opus|sonnet|haiku|fable|mythos)/.test(model) ? 'claude' : null
  if (!provider) return null // local models don't use a subscription
  const tier = model.replace(/^claude[-:]/, '').split('-')[0]
  const u: Usage | null = usage[provider]
  const blocked = (u?.windows ?? []).filter(w => Number.isFinite(w.pct) && w.pct >= LEARNING_LIMIT &&
    // Overall windows apply to every model; tier-specific windows only to that tier.
    (!/^seven_day_/.test(w.key) || w.key === `seven_day_${tier}`) &&
    (!Number.isFinite(w.resetsAt) || w.resetsAt <= 0 || w.resetsAt > now))
  const resumesAt = blocked.length && blocked.every(w => Number.isFinite(w.resetsAt) && w.resetsAt > now)
    ? Math.max(...blocked.map(w => w.resetsAt)) : null
  const label = provider === 'claude' ? 'Claude' : 'OpenAI / Codex'
  const reason = blocked.length ? `${label} ${blocked.map(w => `${w.label} usage ${Math.round(w.pct * 100)}%`).join(', ')}; reserving the last 20% for your work.` : null
  return { provider, paused: !!reason, reason, resumesAt }
}

export function learningGates(models: string[], usage: UsageSnapshot = usageNow(), now = Date.now()) {
  return models.map(m => learningGate(m, usage, now)).filter((g): g is LearningGate => !!g?.paused)
}
