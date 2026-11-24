import { toolLabel } from './stream'
// A presentation of the existing transcript. Never rewrite messages or change agent input.
import type { Block, Item } from './api'

import { blockerInText, NEEDS_LOGIN } from './blockers.ts'
export { NEEDS_LOGIN }
export type Entry = { item: Item; index: number }
export type WorkTurn = { kind: 'turn'; index: number; work: Entry[]; answer: Entry[]; attention: Entry[]; running: boolean }
export type MessageRow = { kind: 'item'; entry: Entry } | WorkTurn

export function groupMessages(items: Item[], running = false): MessageRow[] {
  const rows: MessageRow[] = []
  let entries: Entry[] = [], start = 0
  const flush = (active: boolean, failed = false) => {
    if (!entries.length && !active) return
    if (!active && !entries.some(e => e.item.kind === 'assistant')) {
      rows.push(...entries.map(entry => ({ kind: 'item' as const, entry })))
      entries = []
      return
    }
    const turn: WorkTurn = { kind: 'turn', index: start, work: [], answer: [], attention: [], running: active }
    const lastAssistant = entries.findLast(e => e.item.kind === 'assistant')
    failed ||= entries.some(e => e.item.kind === 'error')
    for (const entry of entries) {
      const it = entry.item
      if (it.kind === 'error') { turn.attention.push(entry); continue }
      if (it.kind !== 'assistant') { turn.work.push(entry); continue }
      // Sign-in actions and prepared Slack drafts must remain reachable without opening work.
      const attention = it.blocks.filter(b => b.type === 'text' ? !!blockerInText(b.text)
        : b.type === 'tool' && b.name === 'mcp__perch__draft_slack_message' && /draft:([\w-]+)/.test(b.result ?? ''))
      let blocks = it.blocks.filter(b => !attention.includes(b))
      if (attention.length) turn.attention.push({ ...entry, item: { ...it, blocks: attention, activity: undefined } })
      // There is no common final/commentary marker across providers. While running, all output
      // stays in work; on completion, the last message's trailing text is the visible answer.
      if (!active && !failed && entry === lastAssistant) {
        const endOfWork = blocks.findLastIndex(b => b.type !== 'text') + 1
        const answer = blocks.slice(endOfWork)
        if (answer.some(b => b.type === 'text' && b.text.trim())) {
          turn.answer.push({ ...entry, item: { ...it, blocks: answer, activity: undefined } })
          blocks = blocks.slice(0, endOfWork)
        }
      }
      if (blocks.length || it.activity?.tools.length || it.activity?.omitted) {
        turn.work.push({ ...entry, item: { ...it, blocks } })
      }
    }
    rows.push(turn)
    entries = []
  }
  items.forEach((item, index) => {
    if (item.kind === 'user' || item.kind === 'result') {
      flush(false, item.kind === 'result' && !item.ok)
      rows.push({ kind: 'item', entry: { item, index } })
      start = index + 1
    } else entries.push({ item, index })
  })
  flush(running)
  return rows
}

// Use the agent's own public update for the preview; no additional model call or invented summary.
export function workSummary(work: Entry[]) {
  let preview = '', latestTool: Extract<Extract<Item, { kind: 'assistant' }>['blocks'][number], { type: 'tool' }> | undefined
  let steps = 0, savedSteps = 0, errors = 0
  for (const { item } of work) {
    if (item.kind !== 'assistant') continue
    savedSteps += (item.activity?.tools.length ?? 0) + (item.activity?.omitted ?? 0)
    for (const block of item.blocks) {
      if (block.type === 'text' && block.text.trim()) preview = block.text
      if (block.type === 'tool') { latestTool = block; steps++; if (block.isError) errors++ }
    }
  }
  preview = preview.replace(/```[\s\S]*?(?:```|$)/g, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim()
  if (preview.length > 200) preview = preview.slice(0, 197).trimEnd() + '…'
  // Reconnected Codex history may contain both a saved activity list and live tool rows.
  return { preview, latestTool, steps: Math.max(steps, savedSteps), errors }
}

// How a running turn is going, from what's already in the transcript (no extra model call):
// how long it has run, how long since anything happened, how far through its own plan it is,
// and whether the recent steps are going through or failing / repeating.
export type StepMark = 'ok' | 'err' | 'pending' | 'repeat'
export type Pulse = {
  startedAt?: number; lastAt?: number
  state: 'active' | 'waiting' | 'quiet' | 'stalled'
  plan?: { done: number; total: number; current?: string }
  marks: StepMark[]
  mood: 'smooth' | 'friction' | 'struggling'
  why?: string
}
const QUIET_MS = 60_000, STALL_MS = 3 * 60_000, LONG_TOOL_MS = 10 * 60_000

function planOf(input: any): Pulse['plan'] {
  // Claude's TodoWrite {todos:[{content,status,activeForm}]}; Codex's update_plan {plan:[{step,status}]}.
  const list = Array.isArray(input?.todos) ? input.todos : Array.isArray(input?.plan) ? input.plan : null
  if (!list?.length) return undefined
  const done = list.filter((t: any) => t?.status === 'completed').length
  const cur = list.find((t: any) => t?.status === 'in_progress')
  return { done, total: list.length, current: cur ? String(cur.activeForm ?? cur.content ?? cur.step ?? '') || undefined : undefined }
}

export function workPulse(work: Entry[], now: number, startedAt?: number, seenAt?: number): Pulse {
  const tools: Extract<Block, { type: 'tool' }>[] = []
  let lastAt = seenAt, plan: Pulse['plan']
  for (const { item } of work) {
    if (item.kind !== 'assistant') continue
    if (item.ts) { lastAt = Math.max(lastAt ?? 0, item.ts); startedAt ??= item.ts }
    for (const b of item.blocks) if (b.type === 'tool') {
      tools.push(b)
      if (/TodoWrite|update_plan/i.test(b.name)) plan = planOf(b.input) ?? plan
    }
  }
  const seen = new Set<string>()
  const marks: StepMark[] = tools.map(t => {
    const key = `${t.name}:${JSON.stringify(t.input ?? '')}`
    const again = seen.has(key); seen.add(key)
    return t.result === undefined ? 'pending' : t.isError ? 'err' : again && !/TodoWrite|update_plan/i.test(t.name) ? 'repeat' : 'ok'
  })
  const recent = marks.slice(-10)
  const errs = recent.filter(m => m === 'err').length, reps = recent.filter(m => m === 'repeat').length
  const mood: Pulse['mood'] = errs >= 3 || errs + reps >= 5 ? 'struggling' : errs || reps >= 2 ? 'friction' : 'smooth'
  const why = mood === 'smooth' ? undefined
    : [errs && `${errs} of the last ${recent.length} steps failed`, reps && `${reps} repeated`].filter(Boolean).join(', ')
  const idle = lastAt ? now - lastAt : 0
  const pending = marks.at(-1) === 'pending'
  const state: Pulse['state'] = pending ? (idle > LONG_TOOL_MS ? 'stalled' : idle > QUIET_MS ? 'waiting' : 'active')
    : idle > STALL_MS ? 'stalled' : idle > QUIET_MS ? 'quiet' : 'active'
  return { startedAt, lastAt, state, plan, marks: marks.slice(-24), mood, why }
}

export function shortDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

// The turn's work as a few intents instead of one long list of steps. A new intent starts where
// the agent says what it's doing next: a public update, a thinking note with text, or its task
// list moving to another task. Titles are the agent's own words (or the first step's description
// when it said nothing), so there's no extra model call and nothing invented.
export type Phase = {
  key: string; title: string; why: 'update' | 'thinking' | 'task' | 'steps'
  entries: Entry[]; steps: number; errors: number; repeats: number
  state: 'running' | 'done' | 'recovered' | 'failed'
  startedAt?: number; endedAt?: number
  // What the agent said when it opened this intent, in full (the title is its first sentence).
  opening?: string
  // What came of it, for a finished intent: the agent's next update (what it made of the results)
  // and one line per step with the start of what that step returned.
  outcome?: string
  results: StepResult[]
}
export type StepResult = { label: string; excerpt: string; isError?: boolean }
type Tool = Extract<Block, { type: 'tool' }>

const firstSentence = (s: string) => {
  const t = s.replace(/```[\s\S]*?(?:```|$)/g, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim()
  const m = t.match(/^(.{12,}?[.!?])(\s|$)/)
  const one = m ? m[1] : t
  return one.length > 140 ? one.slice(0, 137).trimEnd() + '…' : one
}
const stepTitle = (t: Tool) => typeof t.input?.description === 'string' && t.input.description.trim() ? t.input.description.trim()
  : typeof t.input?.activeForm === 'string' ? t.input.activeForm : ''
const toolName = toolLabel
const inputHint = (i: any) => {
  if (!i || typeof i !== 'object') return ''
  const v = i.command ?? i.file_path ?? i.query ?? i.pattern ?? i.url ?? i.prompt ?? i.skill ?? i.action ?? ''
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
}
// One line per step: what it set out to do, and the first lines of what came back.
export function stepResult(t: Tool): StepResult {
  const hint = inputHint(t.input)
  const label = stepTitle(t) || (hint ? `${toolName(t.name)} ${hint}` : toolName(t.name))
  const lines = (t.result ?? '').replace(/<\/?[a-z][\w-]*>/gi, '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
  let excerpt = lines.slice(0, 3).join(' · ')
  if (excerpt.length > 240) excerpt = excerpt.slice(0, 237).trimEnd() + '…'
  if (lines.length > 3) excerpt += ` (+${lines.length - 3} lines)`
  return { label, excerpt: t.result === undefined ? '…' : excerpt || 'no output', isError: t.isError }
}
const isPlan = (t: Tool) => /TodoWrite|update_plan/i.test(t.name)

export function workPhases(work: Entry[], running = false): Phase[] {
  const phases: Phase[] = []
  const seen = new Set<string>()
  let cur: Phase | undefined, task: string | undefined
  const open = (title: string, why: Phase['why'], ts?: number) => {
    cur = { key: `${phases.length}`, title, why, entries: [], steps: 0, errors: 0, repeats: 0, state: 'done', startedAt: ts, results: [] }
    phases.push(cur)
  }
  // Add blocks of one transcript item to the current phase, as a slice of that item.
  const add = (entry: Entry, blocks: Block[], withActivity: boolean) => {
    if (!cur) open('', 'steps', (entry.item as any).ts)
    const it = entry.item
    const sliced: Entry = it.kind === 'assistant' ? { ...entry, item: { ...it, blocks, activity: withActivity ? it.activity : undefined } } : entry
    const last = cur!.entries.at(-1)
    if (last && last.index === entry.index && last.item.kind === 'assistant' && sliced.item.kind === 'assistant') {
      last.item = { ...last.item, blocks: [...last.item.blocks, ...blocks], activity: withActivity ? it.kind === 'assistant' ? it.activity : undefined : last.item.activity }
    } else cur!.entries.push(sliced)
  }
  for (const entry of work) {
    const it = entry.item
    if (it.kind !== 'assistant') { add(entry, [], false); continue }
    const ts = it.ts
    it.blocks.forEach((b, j) => {
      const lastBlock = j === it.blocks.length - 1
      const said = b.type === 'text' || b.type === 'thinking' ? b.text.trim() : ''
      if (said && (b.type === 'text' || said.length >= 40)) {
        // A thinking note right after an update that already opened this phase stays in it.
        const why = b.type === 'text' ? 'update' : 'thinking'
        if (!cur || cur.steps > 0) { open(firstSentence(said), why, ts); cur!.opening = said }
        else if (!cur.title) { cur.title = firstSentence(said); cur.why = why; cur.opening = said }
      }
      if (b.type === 'tool' && isPlan(b)) {
        const list = Array.isArray(b.input?.todos) ? b.input.todos : Array.isArray(b.input?.plan) ? b.input.plan : []
        const now = list.find((t: any) => t?.status === 'in_progress')
        const name = now ? String(now.activeForm ?? now.content ?? now.step ?? '') : ''
        if (name && name !== task) { task = name; if (cur?.steps || !cur) open(name, 'task', ts); else if (cur.why !== 'update') cur.title = name }
      }
      add(entry, [b], lastBlock)
      if (b.type === 'tool' && cur) {
        if (!isPlan(b)) {
          cur.steps++
          const k = `${b.name}:${JSON.stringify(b.input ?? '')}`
          if (seen.has(k)) cur.repeats++
          seen.add(k)
        }
        if (b.isError) cur.errors++
        if (!cur.title && stepTitle(b)) cur.title = stepTitle(b)
      }
    })
    if (!it.blocks.length && it.activity) add(entry, [], true)
    if (cur && ts) cur.endedAt = ts
  }
  phases.forEach((p, i) => {
    const next = phases[i + 1]
    if (next?.startedAt) p.endedAt = next.startedAt
    const tools = p.entries.flatMap(e => e.item.kind === 'assistant' ? e.item.blocks.filter((b): b is Tool => b.type === 'tool') : [])
    const lastTool = tools.at(-1)
    if (!p.title) p.title = lastTool ? stepTitle(lastTool) || `${lastTool.name} steps` : 'Working'
    p.results = tools.filter(t => !isPlan(t)).map(stepResult)
    if (next?.opening && next.why !== 'task') p.outcome = next.opening
    const isLast = i === phases.length - 1
    p.state = isLast && running ? 'running'
      : p.errors === 0 ? 'done'
      : lastTool?.isError && isLast ? 'failed' : 'recovered'
  })
  return phases
}
