// Self drive: a per-chat switch. While it's on, every time the chat's turn ends a driver agent reads
// the end of the conversation and does what the user would: answers its question, picks the option,
// tells it to carry on or to stop. It hands the chat back to the user only for what only they can do
// (irreversible or outward-facing actions, money, messages to people), through Needs me.
// The driver is a separate, text-only judgement, not the chat talking to itself: the point is a
// second look that works the way the user does, including saying "stop, this is the wrong task".
import { ephemeral, noticeLive, send, subscribe } from './chat.ts'
import { all, get, run } from './db.ts'
import { reportNeed } from './needsstore.ts'
import { ownerName } from './owner.ts'
import { isPaused } from './pausehold.ts'
import { settings } from './settings.ts'
import { itemsOf, type Item } from './transcript.ts'

run(`create table if not exists self_drive (
  id text primary key, on_at integer, enabled integer not null default 0,
  replies integer not null default 0, last_reply text, last_reply_at integer,
  status text, note text, updated_at integer)`)
run(`create table if not exists self_drive_log (
  id integer primary key autoincrement, conversation_id text not null, at integer not null, action text not null, message text, reason text)`)
for (const col of ['backoff_until integer', 'mode text', 'per_hour integer', 'recheck_min integer', 'model text', 'instructions text', 'budget_hour real']) { try { run(`alter table self_drive add column ${col}`) } catch {} }
try { run('alter table self_drive_log add column cost real') } catch {} // the driver's own spend per decision
run('create index if not exists self_drive_log_conv on self_drive_log(conversation_id, at)')

// Self drive is meant to run unwatched, so it keeps going and only stops for a real loop:
// - a burst: PER_HOUR messages in an hour backs off for BACKOFF_MS, then carries on. MAX_BACKOFFS of
//   those in a day is a big loop, and that hands the chat back.
// - the same reply MAX_SAME times in a row, or MAX_RESUMES stall nudges in a row with nothing between.
// Stalls (API errors, died mid tool call, never answered) and quiet waits get picked back up by the sweep.
export const PER_HOUR = 20
export const BACKOFF_MS = 30 * 60_000
export const MAX_BACKOFFS = 3
export const MAX_SAME = 3
export const MAX_RESUMES = 5
export const QUIET_MS = 2 * 60_000 // a turn end the follower missed (restart, terminal) is picked up after this
export const WAIT_RECHECK_MS = 20 * 60_000 // "waiting on CI/deploy": look again after this much quiet
export const RETRY_MS = 5 * 60_000 // the driver's own answer failed (unreadable, capped): try again
const SETTLE_MS = 4000 // let the turn's last events land (and a queued user message start) first
const DECISIONS = ['reply', 'resume', 'wait', 'done', 'needs_you', 'error', 'backoff', 'budget']
export const BUDGET_PAUSE_MS = 15 * 60_000 // over the hourly budget: look again after this

// Per-chat settings (right-click the 🚗). Unset means the defaults above.
// mode: 'full' hands back only what only the user can do; 'careful' also hands back big, lasting choices.
// budgetHour: API-equivalent $ per trailing hour across the chat's own turns and the driver's calls
// (on a subscription it isn't billed, but it counts toward usage limits). null = no budget.
export type DriveSettings = { mode: 'full' | 'careful'; perHour: number; recheckMin: number; model: string | null; instructions: string; budgetHour: number | null }
export type DriveState = { on: boolean; replies: number; status: string | null; note: string | null; lastReplyAt: number | null; settings: DriveSettings; spentHour: number; next: NextUp[] }
type Row = { id: string; enabled: number; replies: number; last_reply: string | null; last_reply_at: number | null; status: string | null; note: string | null; backoff_until: number | null
  mode: string | null; per_hour: number | null; recheck_min: number | null; model: string | null; instructions: string | null; budget_hour: number | null }
const settingsOf = (r?: Row | null): DriveSettings => ({
  mode: r?.mode === 'careful' ? 'careful' : 'full', perHour: r?.per_hour || PER_HOUR, recheckMin: r?.recheck_min || WAIT_RECHECK_MS / 60_000,
  model: r?.model || null, instructions: r?.instructions ?? '', budgetHour: r?.budget_hour || null })

export function setDriveSettings(id: string, s: Partial<DriveSettings>) {
  run('insert into self_drive (id, updated_at) values (?, ?) on conflict(id) do nothing', id, deps.now())
  const clamp = (v: unknown, lo: number, hi: number) => v === undefined ? undefined : Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)))
  const set: [string, unknown][] = [
    ['mode', s.mode === undefined ? undefined : s.mode === 'careful' ? 'careful' : 'full'],
    ['per_hour', clamp(s.perHour, 1, 500)], ['recheck_min', clamp(s.recheckMin, 1, 24 * 60)],
    ['model', s.model === undefined ? undefined : (String(s.model ?? '').trim().slice(0, 80) || null)],
    ['instructions', s.instructions === undefined ? undefined : String(s.instructions).slice(0, 4000)],
    ['budget_hour', s.budgetHour === undefined ? undefined : s.budgetHour === null || !(Number(s.budgetHour) > 0) ? 0 : Math.min(1000, Math.round(Number(s.budgetHour) * 100) / 100)],
  ]
  for (const [col, v] of set) if (v !== undefined) run(`update self_drive set ${col} = ? where id = ?`, v, id)
  changed(id)
  return driveState(id)
}

const row = (id: string) => get<Row>('select * from self_drive where id = ?', id)
export const isSelfDriving = (id: string) => !!row(id)?.enabled
export function driveState(id: string): DriveState {
  const r = row(id)
  return { on: !!r?.enabled, replies: r?.replies ?? 0, status: r?.status ?? null, note: r?.note ?? null, lastReplyAt: r?.last_reply_at ?? null, settings: settingsOf(r), spentHour: spentSince(id, deps.now() - 3600_000), next: r?.enabled ? nextUp(id, r) : [] }
}

// What happens next in a driven chat, soonest first: the driver's own next look, and follow-ups the
// chat's agent scheduled for itself. at is null for "when something happens" (a turn ends, a PR merges).
export type NextUp = { at: number | null; kind: 'drive' | 'follow-up'; text: string }
export function nextUp(id: string, r = row(id), now = deps.now()): NextUp[] {
  const out: NextUp[] = []
  if (r?.enabled) {
    const last = get<{ at: number; action: string; reason: string | null }>(
      `select at, action, reason from self_drive_log where conversation_id = ? and action in (${DECISIONS.map(() => '?').join(',')}) order by at desc, id desc limit 1`, id, ...DECISIONS)
    const recheck = settingsOf(r).recheckMin * 60_000
    if (deps.running(id)) out.push({ at: null, kind: 'drive', text: 'decides what to say when this turn ends' })
    else if (r.backoff_until && r.backoff_until > now) out.push({ at: r.backoff_until, kind: 'drive', text: r.status === 'budget' ? 'carries on after the budget pause' : 'carries on after cooling off' })
    else if (r.status === 'needs_you') out.push({ at: null, kind: 'drive', text: `waiting for you: ${r.note ?? 'it handed this back'}` })
    else if (last?.action === 'wait') out.push({ at: last.at + recheck, kind: 'drive', text: `looks again${last.reason ? `: ${last.reason}` : ''}` })
    else if (last?.action === 'error') out.push({ at: last.at + RETRY_MS, kind: 'drive', text: 'tries its decision again' })
    else if (last && ['reply', 'resume'].includes(last.action)) out.push({ at: last.at + recheck, kind: 'drive', text: 'checks the chat picked up its last message' })
  }
  try {
    for (const p of all<{ due_at: number | null; text: string; until: string | null; pr_url: string | null }>(
      `select due_at, text, until, pr_url from promises where conversation_id = ? and status in ('open', 'waiting') order by coalesce(due_at, created_at) limit 3`, id))
      out.push({ at: p.due_at, kind: 'follow-up', text: p.due_at ? p.text : `${p.text}${p.until ? ` (when ${p.until}${p.pr_url ? ` on ${p.pr_url}` : ''})` : ''}` })
  } catch {} // promises.ts not loaded (tests)
  return out.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))
}
export const driveLog = (id: string, limit = 30) =>
  all<{ at: number; action: string; message: string | null; reason: string | null }>('select at, action, message, reason from self_drive_log where conversation_id = ? order by at desc limit ?', id, limit)

const log = (id: string, action: string, message?: string | null, reason?: string | null, cost?: number | null) =>
  run('insert into self_drive_log (conversation_id, at, action, message, reason, cost) values (?, ?, ?, ?, ?, ?)', id, deps.now(), action, message ?? null, reason ?? null, cost ?? null)
// API-equivalent $ since a time: the chat's own turns (turns.ts may not be loaded) plus the driver's calls.
export function spentSince(id: string, since: number) {
  let chat = 0
  try { chat = get<{ c: number }>('select coalesce(sum(cost), 0) c from turns where conversation_id = ? and sent_at > ?', id, since)?.c ?? 0 } catch {}
  return chat + (get<{ c: number }>('select coalesce(sum(cost), 0) c from self_drive_log where conversation_id = ? and at > ?', id, since)?.c ?? 0)
}
const setStatus = (id: string, status: string | null, note: string | null = null) =>
  run('update self_drive set status = ?, note = ?, updated_at = ? where id = ?', status, note, deps.now(), id)
const lastDecision = (id: string) => get<{ at: number; action: string; message: string | null }>(
  `select at, action, message from self_drive_log where conversation_id = ? and action in (${DECISIONS.map(() => '?').join(',')}) order by at desc, id desc limit 1`, id, ...DECISIONS)
// How many of the most recent decisions in a row match: "the same reply again", "another stall nudge".
function streak(id: string, match: (r: { action: string; message: string | null }) => boolean) {
  let n = 0
  for (const r of all<{ action: string; message: string | null }>(`select action, message from self_drive_log where conversation_id = ? and action in ('reply', 'resume', 'done', 'needs_you') order by at desc, id desc limit 20`, id)) { if (!match(r)) break; n++ }
  return n
}

export const onSelfDrive = new Set<(id: string) => void>()
const changed = (id: string) => onSelfDrive.forEach(f => f(id))
// Switched on or off (by you, or by itself when done): the conversation list shows a 🚗 on driven chats.
export const onSelfDriveToggle = new Set<(id: string) => void>()
const toggled = (id: string) => onSelfDriveToggle.forEach(f => f(id))

// Deps are swappable so tests can drive it without spawning Claude or a chat.
export const deps = {
  judge: (prompt: string, model?: string | null): Promise<(Verdict & { cost?: number }) | null> => judge(prompt, model),
  send: (id: string, prompt: string) => { send({ id, prompt, by: 'self-drive', resume: true }) },
  notice: (id: string, text: string) => { try { noticeLive(id, text) } catch {} },
  transcript: (id: string): Item[] => { const p = get<{ path: string }>('select path from conversations where id = ?', id)?.path; return p ? itemsOf(p) : [] },
  running: (_id: string) => false,
  updatedAt: (id: string) => get<{ updated_at: number }>('select updated_at from conversations where id = ?', id)?.updated_at ?? 0,
  paused: () => isPaused(),
  now: () => Date.now(),
}

export function setSelfDrive(id: string, on: boolean) {
  const now = deps.now()
  run(`insert into self_drive (id, enabled, on_at, updated_at) values (?, ?, ?, ?)
       on conflict(id) do update set enabled = excluded.enabled, on_at = case when excluded.enabled = 1 then excluded.on_at else self_drive.on_at end,
       status = null, note = null, updated_at = excluded.updated_at`, id, on ? 1 : 0, now, now)
  log(id, on ? 'on' : 'off')
  toggled(id)
  if (on) {
    follow(id)
    // Switched on while the chat is already waiting on you: drive the turn that is sitting there.
    if (!deps.running(id)) schedule(id)
  }
  changed(id)
  return driveState(id)
}

// Listen to the chat's stream; every top-level turn end is a chance to drive.
const followed = new Set<string>()
export function follow(id: string) {
  if (followed.has(id)) return
  followed.add(id)
  subscribe(id, ev => {
    if (ev.parent_tool_use_id) return
    if (ev.type === 'result') schedule(id, ev.is_error ? `it ended on an error: ${String(ev.result ?? ev.subtype ?? '').slice(0, 200)}` : null, !ev.is_error)
    if (ev.type === 'perch_error') schedule(id, `it stopped with an error: ${String(ev.message ?? '').slice(0, 200)}`)
  }, { background: true })
}

export function startSelfDrive(running: (id: string) => boolean) {
  deps.running = running
  for (const r of all<{ id: string }>('select id from self_drive where enabled = 1')) follow(r.id)
  setInterval(() => { try { sweep() } catch (e) { console.error('[self-drive] sweep', e) } }, 60_000).unref()
}

// The safety net for everything the turn-end follower can't see: a chat that stalled without a
// result event, a turn that ended while auto-m8 was restarting, a "waiting on CI" that never came
// back, a driver answer that failed. Returns the chats it picked up.
export function sweep(now = deps.now()): string[] {
  if (deps.paused()) return []
  const picked: string[] = []
  for (const r of all<Row>('select * from self_drive where enabled = 1')) {
    if (deps.running(r.id) || inflight.has(r.id) || timers.has(r.id)) continue
    if (r.backoff_until && r.backoff_until > now) continue
    const updated = deps.updatedAt(r.id), last = lastDecision(r.id), recheck = settingsOf(r).recheckMin * 60_000
    const since = now - (last?.at ?? 0)
    const moved = !last || updated > last.at // the chat did something the driver hasn't looked at
    const due =
      (moved && now - updated >= QUIET_MS) ||
      (!moved && last?.action === 'wait' && since >= recheck) ||
      (!moved && (last?.action === 'error' || last?.action === 'backoff' || last?.action === 'budget') && since >= RETRY_MS) ||
      (!moved && (last?.action === 'reply' || last?.action === 'resume') && since >= recheck) // sent, and nothing happened
    if (!due || (last?.action === 'needs_you' && !moved)) continue
    picked.push(r.id)
    drive(r.id).catch(e => console.error('[self-drive]', r.id, e))
  }
  return picked
}

// The transcript ends without the agent finishing its turn.
export function stallIn(items: Item[]): string | null {
  const last = items[items.length - 1]
  if (!last) return null
  if (last.kind === 'user') return 'it never answered the last message'
  const b = last.blocks[last.blocks.length - 1]
  if (!b) return null
  if (b.type === 'text' && /^\s*API Error\b|^\s*(Request timed out|Overloaded)/i.test(b.text)) return 'it ended on an API error'
  if (b.type === 'tool' && b.result === undefined) return 'it stopped mid tool call'
  if (b.type === 'tool') return 'it stopped after a tool result, before replying'
  return null
}

const timers = new Map<string, NodeJS.Timeout>()
const inflight = new Set<string>()
function schedule(id: string, stalled: string | null = null, finished = false) {
  clearTimeout(timers.get(id))
  const t = setTimeout(() => { timers.delete(id); drive(id, stalled, finished).catch(e => console.error('[self-drive]', id, e)) }, SETTLE_MS)
  t.unref?.()
  timers.set(id, t)
}

export type Verdict = { action: 'reply' | 'done' | 'needs_you' | 'wait'; message?: string; reason?: string }

// finished: the turn just ended cleanly (a result event), so the transcript can't be read as a stall;
// it may simply not be flushed yet. Stall detection is for errors and the sweep.
export async function drive(id: string, stalled: string | null = null, finished = false): Promise<Verdict | null> {
  const r = row(id)
  if (!r?.enabled || inflight.has(id) || deps.running(id)) return null
  if (deps.paused()) { setStatus(id, 'paused', 'auto-m8 is paused, or agents acting on their own is off in Settings'); changed(id); return null }
  const now = deps.now()
  if (r.backoff_until && r.backoff_until > now) return null
  const lastHour = get<{ n: number }>(`select count(*) n from self_drive_log where conversation_id = ? and action in ('reply', 'resume') and at > ?`, id, now - 3600_000)?.n ?? 0
  const perHour = settingsOf(r).perHour
  if (lastHour >= perHour) {
    const backoffs = (get<{ n: number }>(`select count(*) n from self_drive_log where conversation_id = ? and action = 'backoff' and at > ?`, id, now - 86400_000)?.n ?? 0) + 1
    if (backoffs > MAX_BACKOFFS) return handBack(id, `Self drive has sent ${perHour}+ messages an hour, ${MAX_BACKOFFS} times today, without finishing: that's a loop.`, '')
    run('update self_drive set backoff_until = ? where id = ?', now + BACKOFF_MS, id)
    setStatus(id, 'backoff', `${lastHour} messages in the last hour: pausing ${BACKOFF_MS / 60_000} min, then carrying on`)
    log(id, 'backoff', null, `${lastHour} in an hour (${backoffs}/${MAX_BACKOFFS} today)`)
    changed(id)
    return null
  }
  const budget = settingsOf(r).budgetHour
  if (budget) {
    const spent = spentSince(id, now - 3600_000)
    if (spent >= budget) {
      // A budget pause isn't a loop: it never hands the chat back, it waits for the hour to roll over.
      run('update self_drive set backoff_until = ? where id = ?', now + BUDGET_PAUSE_MS, id)
      setStatus(id, 'budget', `$${spent.toFixed(2)} spent in the last hour (budget $${budget}): pausing, then carrying on`)
      log(id, 'budget', null, `$${spent.toFixed(2)} of $${budget} in the last hour`)
      changed(id)
      return null
    }
  }
  const items = deps.transcript(id)
  // Stalled: nothing to judge, the agent just has to carry on. No model call needed.
  const stall = stalled ?? (finished ? null : stallIn(items))
  if (stall) return resume(id, stall)
  if (!items.some(i => i.kind === 'assistant')) return null
  inflight.add(id)
  setStatus(id, 'thinking'); changed(id)
  let driverCost: number | null = null
  try {
    const v = await deps.judge(prompt(id, items, r.last_reply, settingsOf(r)), settingsOf(r).model)
    if (!row(id)?.enabled) return null // switched off while it was thinking
    if (!v) { setStatus(id, 'error', `The driver's answer was unreadable; trying again in ${RETRY_MS / 60_000} min.`); log(id, 'error'); return null }
    driverCost = v.cost ?? null
    if (deps.running(id)) { setStatus(id, null); return null } // the user (or something else) already picked it up
    return act(id, v, driverCost)
  } finally { inflight.delete(id); changed(id) }
}

function resume(id: string, stall: string): Verdict | null {
  const n = streak(id, d => d.action === 'resume')
  if (n >= MAX_RESUMES) return handBack(id, `The chat stalled ${n + 1} times in a row (${stall}) and resuming didn't help.`, '')
  const message = `You stalled (${stall}). Self drive is on, so nobody else will pick this up: carry on with the task from where you stopped, finish it including its checks, and report the result. If one approach keeps failing, try another.`
  run('update self_drive set status = ?, note = ?, updated_at = ? where id = ?', 'resumed', `stalled: ${stall}`, deps.now(), id)
  log(id, 'resume', message, stall)
  deps.send(id, message)
  changed(id)
  return { action: 'reply', message, reason: stall }
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

function act(id: string, v: Verdict, cost: number | null = null): Verdict {
  const message = (v.message ?? '').trim(), reason = (v.reason ?? '').trim()
  if (v.action === 'wait') { setStatus(id, 'waiting', reason || null); log(id, 'wait', null, reason, cost); return v }
  if (v.action === 'done') {
    run('update self_drive set enabled = 0, status = ?, note = ?, updated_at = ? where id = ?', 'done', reason || 'Finished.', deps.now(), id)
    log(id, 'done', null, reason, cost)
    toggled(id)
    deps.notice(id, `🚗 Self drive finished and turned itself off: ${reason || 'the work is done.'}`)
    return v
  }
  if (v.action === 'needs_you' || !message) return handBack(id, reason || 'The driver needs you here.', message, cost)
  // The same reply over and over means the chat is going round in circles.
  const same = streak(id, d => d.action === 'reply' && !!d.message && norm(d.message) === norm(message))
  if (same >= MAX_SAME - 1) return handBack(id, `Self drive was about to send the same reply ${MAX_SAME} times in a row; the chat is going in circles.`, message)
  run('update self_drive set replies = replies + 1, last_reply = ?, last_reply_at = ?, status = ?, note = ?, updated_at = ? where id = ?', message, deps.now(), 'replied', reason || null, deps.now(), id)
  log(id, 'reply', message, reason, cost)
  deps.send(id, message)
  return v
}

function handBack(id: string, reason: string, message: string, cost: number | null = null): Verdict {
  setStatus(id, 'needs_you', reason)
  log(id, 'needs_you', message || null, reason, cost)
  try {
    reportNeed({ key: `selfdrive:${id}`, source: 'self drive', conversation_id: id, title: reason.slice(0, 240),
      context: `Self drive stopped in this chat and handed it back.${message ? `\nWhat it would have said: ${message}` : ''}` })
  } catch (e) { console.error('[self-drive] needs me', e) }
  deps.notice(id, `🚗 Self drive needs you: ${reason}`)
  return { action: 'needs_you', message, reason }
}

// ---------- the driver ----------
export function transcriptFor(items: Item[], max = 14000) {
  const lines: string[] = []
  for (const i of items.slice(-16)) {
    if (i.kind === 'user') lines.push(`USER: ${i.text.slice(0, 2000)}`)
    else {
      const text = i.blocks.filter(b => b.type === 'text').map((b: any) => b.text).join('\n')
      const tools = i.blocks.filter(b => b.type === 'tool').map((b: any) => `${b.name}${b.isError ? '(error)' : ''}`)
      if (text.trim() || tools.length) lines.push(`AGENT: ${text.slice(0, 4000)}${tools.length ? `\n[tools: ${tools.slice(-6).join(', ')}]` : ''}`)
    }
  }
  const s = lines.join('\n\n')
  return s.length > max ? '…' + s.slice(-max) : s
}

export function prompt(id: string, items: Item[], lastReply?: string | null, ds: DriveSettings = settingsOf(null)) {
  const name = ownerName()
  let goal: { goal: string; done_when: string | null } | undefined
  try { goal = get<any>(`select goal, done_when from projects where conversation_id = ? and status = 'active'`, id) } catch {} // projects.ts may not be loaded
  return `You are driving an AI coding agent's chat on behalf of ${name}, who switched on "self drive" so the work finishes without them. The agent's turn just ended. Decide what ${name} would do next, as if you were them.

How ${name} works: they act like the founder of the work. Ship small and fast, decide reversible things on the spot, fix adjacent problems instead of routing around them, never hand work to other people. Short, decisive messages: the next concrete step, not a menu. They challenge the task when it looks wrong.

Choose one action:
- "reply": the agent asked something, offered options, stopped short ("say go and I'll…"), hit a fixable blocker, or stopped before finishing. Write ${name}'s next message: answer the question, pick the option (usually the agent's recommendation unless it's wrong), or tell it exactly what to do next. If the agent raised a real doubt that the task is wrong or harmful, it's fine to answer "stop" or to change direction: don't rubber-stamp.
- "done": the work is finished and checked (PR opened and handed to its shepherd, question answered, result verified). Nothing left for the agent to do.
- "wait": the agent is waiting on something that will come back by itself (CI, a deploy, a helper, a scheduled follow-up) and said so. Nothing to send now.
- "needs_you": rare. ${name} turned this on to not be needed: before choosing it, look for any way forward (another approach, a different tool, a reversible version, doing the independent parts first) and reply with that instead. Only when the next step truly can't happen without them: something irreversible or destructive in production, spending money, sending a message or posting publicly as them, a merge the PR's plan doesn't already allow, a credential or hardware approval, or a decision that belongs to someone outside the team. Also when the chat is going in circles.

Never approve destructive production actions, spending, or messages to people on ${name}'s behalf: that is "needs_you". Don't invent facts the transcript doesn't support.
${ds.mode === 'careful' ? `\n${name} set this chat to careful: also choose "needs_you" for big choices with lasting consequences (architecture, a public API, data model changes, which of two substantially different approaches to build), with the options and your recommendation in "reason".\n` : ''}${ds.instructions.trim() ? `\n${name}'s own instructions for driving this chat (follow them over the defaults above, except the never-approve rule):\n${ds.instructions.trim()}\n` : ''}${lastReply ? `\nYour last message to the agent was: "${lastReply.slice(0, 600)}". If that didn't move the work forward, try something different, don't repeat it.\n` : ''}${goal ? `\nThe goal of this chat: ${goal.goal}${goal.done_when ? `\nDone when: ${goal.done_when}` : ''}\n` : ''}
Reply with ONLY JSON: {"action": "reply" | "done" | "wait" | "needs_you", "message": "the message to send (reply only), in ${name}'s voice", "reason": "one short line: why"}

The conversation so far (most recent last):
${transcriptFor(items)}`
}

function judge(p: string, model?: string | null): Promise<(Verdict & { cost?: number }) | null> {
  return new Promise(resolve => {
    let out = '', cost: number | undefined
    ephemeral(['-p', p, '--output-format', 'stream-json', '--verbose', '--model', model || settings.ai.model, '--no-session-persistence',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk'], settings.chat.cwd, ev => {
      if (ev.type === 'result') { out = String(ev.result ?? ''); cost = Number(ev.total_cost_usd) || undefined }
      if (ev.type === 'perch_done') { const v = parseVerdict(out); resolve(v ? { ...v, cost } : null) }
    })
  })
}

export function parseVerdict(out: string): Verdict | null {
  try {
    const v = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
    if (!['reply', 'done', 'wait', 'needs_you'].includes(v?.action)) return null
    return { action: v.action, message: v.message ? String(v.message) : undefined, reason: v.reason ? String(v.reason) : undefined }
  } catch { return null }
}
