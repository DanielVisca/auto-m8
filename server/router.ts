// Picking the model for each message, from what you already pay for: Claude Code's models on your
// plan (Haiku, Sonnet, Opus), local Ollama models, and later Cursor. Never pay-per-token APIs.
// - Auto (the default): quick asks go to Haiku, normal work to Sonnet, heavy thinking (design,
//   debugging, audits, big or multi-file changes, images) to Opus. A short follow-up ("continue")
//   keeps the model it's on, and a correction steps up a model.
// - Usage caps: when a model hits its limit, perch notes when it resets, moves the chat to the next
//   model down (Opus → Sonnet → Haiku → a local model that fits) and resends your message; after
//   the reset it's back on the list.
// The model switches inside the running session (a set_model control message), so the agent keeps
// its whole context.
import { intentOf } from './turns.ts'
import { capsOf } from './account.ts'

// Fable is pin-only: Auto never picks it (it tops out at Opus), but a chat pinned to Fable falls
// back down this list when Fable hits its cap.
export type Tier = 'haiku' | 'sonnet' | 'opus' | 'fable'
const ORDER: Tier[] = ['fable', 'opus', 'sonnet', 'haiku']
const LABEL: Record<Tier, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' }
export const tierLabel = (t: string) => LABEL[t as Tier] ?? t

// Engines: 'auto'; 'claude:<tier>' (a fixed Claude model); '' (the old default: same as auto when
// routing is on); anything else is a local Ollama model.
export const isAuto = (engine: string) => engine === 'auto' || engine === ''
export const claudeFixed = (engine: string) => engine.startsWith('claude:') ? engine.slice(7) as Tier : null
export const isLocal = (engine: string) => !!engine && !isAuto(engine) && !claudeFixed(engine) && !engine.startsWith('codex')

const HEAVY = /\b(design|architect\w*|plan|refactor|audit|investigate|debug|root cause|why (does|is|did)|migrat\w*|race|concurren\w*|deadlock|security|performance|optimi[sz]e|rewrite|across (the|all)|end to end|stack|schema|data model|review this|ddia)\b/i
const CONTINUE = /^\s*(yes|yep|ok(ay)?|go( ahead)?|continue|keep going|do it|sounds good|lgtm|ship it|thanks?( you)?|great|perfect|next|please do)\b[.!]?\s*$/i

// Which model for this message, and why (shown in the chat).
// Past this much context, stepping down to a smaller model for a quick message costs more than it
// saves: the new model has no cache of the conversation and has to load all of it again.
const BIG_CONTEXT = 60_000
export function route(prompt: string, o: { current: Tier | null; corrected: boolean; images: number; turbo: boolean; context?: number }): { tier: Tier; why: string } {
  const pick = pickTier(prompt, o)
  if (o.current && (o.context ?? 0) > BIG_CONTEXT && ORDER.indexOf(pick.tier) > ORDER.indexOf(o.current))
    return { tier: o.current, why: `staying put: switching would reload ${Math.round((o.context ?? 0) / 1000)}k tokens of context` }
  return pick
}
function pickTier(prompt: string, o: { current: Tier | null; corrected: boolean; images: number; turbo: boolean }): { tier: Tier; why: string } {
  if (o.turbo) return { tier: 'opus', why: 'turbo' }
  if (CONTINUE.test(prompt) && o.current) return { tier: o.current, why: 'carrying on' }
  if (o.corrected && o.current) {
    const up = o.current === 'fable' ? 'fable' : ORDER[Math.max(ORDER.indexOf('opus'), ORDER.indexOf(o.current) - 1)]
    return { tier: up, why: up === o.current ? 'a correction, already on the top model' : 'stepping up after a correction' }
  }
  const intent = intentOf(prompt)
  const long = prompt.length > 600
  if (o.images > 0) return { tier: 'opus', why: 'images' }
  if (HEAVY.test(prompt) || (long && ['build', 'fix', 'review', 'pr'].includes(intent))) return { tier: 'opus', why: 'heavy thinking' }
  if (prompt.length < 220 && ['research', 'write', 'other'].includes(intent)) return { tier: 'haiku', why: 'a quick ask' }
  return { tier: 'sonnet', why: 'everyday work' }
}

// ---------- usage caps ----------
// Claude says when a limit hits: "Claude AI usage limit reached|1793898000" or "…resets 3pm".
// Caps are kept in account.ts: tier → until (ms).
// Also the plan's spend cap: "You've hit your individual spend limit · … your 5-hour limit resets 1:50pm".
const CAP = /usage limit|spend limit|limit reached|hit your [\w -]*limit|limit resets|rate[_ ]limit|quota|429|too many requests|weekly limit|out of (usage|credits)|credit balance|usage-credits/i
// A cap on one model names it ("Opus weekly limit"); anything else (the 5-hour window, the spend
// cap, credits) is the whole account, so every Claude model is out until it resets.
export function capScope(text: string): Tier | 'all' {
  const m = text.match(/\b(opus|sonnet|fable|haiku)\b[^.\n]{0,30}limit/i)
  return m ? m[1].toLowerCase() as Tier : 'all'
}
export function capFrom(text: string): number | null {
  if (!CAP.test(text)) return null
  const epoch = text.match(/\|(\d{10})\b/)?.[1]
  if (epoch) return Number(epoch) * 1000
  const at = text.match(/resets?(?: at)? (\d{1,2})(?::(\d{2}))?\s*(am|pm)/i)
  if (at) {
    const d = new Date(); let h = Number(at[1]) % 12 + (at[3].toLowerCase() === 'pm' ? 12 : 0)
    d.setHours(h, Number(at[2] ?? 0), 0, 0); if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  return Date.now() + 60 * 60_000 // no time given: try again in an hour
}
export const markCapped = (tier: Tier | 'all', until: number) => { const capped = capsOf(); for (const t of tier === 'all' ? ORDER : [tier]) capped.set(t, Math.max(until, capped.get(t) ?? 0)) }
// Claude and Codex are peers (both on plans you already pay for) and cover for each other:
// - every Claude model capped, or Opus/Fable capped for heavy work: Codex takes the message;
// - Codex capped or signed out (a pinned Codex chat or one Codex was covering): Claude takes it;
// - both out: a local model.
// `wantsCodex` is that decision for one message in an auto chat; `want` is the Claude tier route() picked.
export function wantsCodex(want: Tier, codexOk: boolean, claudeNearLimit = false): { codex: boolean; why: string } {
  if (!codexOk) return { codex: false, why: '' }
  if (claudeNearLimit) return { codex: true, why: 'Claude is at the edge of its plan limit' }
  const tier = available(want)
  if (!tier) return { codex: true, why: 'every Claude model is at its cap' }
  if ((want === 'opus' || want === 'fable') && ORDER.indexOf(tier) > ORDER.indexOf('opus')) return { codex: true, why: `${tierLabel(want)} is at its cap, and Codex is the closer match than ${tierLabel(tier)}` }
  return { codex: false, why: '' }
}
// Every Claude model is out: chats and background jobs go to Codex (or a local model) instead.
export const allCapped = () => ORDER.every(t => t === 'fable' || isCapped(t))
// Engines that aren't Claude Code at all.
export const isCodex = (engine: string) => engine === 'codex' || engine.startsWith('codex:')
export const isCapped = (tier: Tier) => (capsOf().get(tier) ?? 0) > Date.now()
export const capsNow = () => [...capsOf()].filter(([, u]) => u > Date.now()).map(([tier, until]) => ({ tier, until }))

// The best model at or below the wanted one that isn't capped; null when every Claude model is.
export function available(want: Tier): Tier | null {
  for (const t of ORDER.slice(ORDER.indexOf(want))) if (!isCapped(t)) return t
  for (const t of ORDER) if (t !== 'fable' && !isCapped(t)) return t // everything below is capped: take anything left (Fable only when pinned)
  return null
}
