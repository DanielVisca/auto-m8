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
run('create index if not exists self_drive_log_conv on self_drive_log(conversation_id, at)')

export const PER_HOUR = 12 // driver replies per chat per hour: a runaway loop costs at most this
const SETTLE_MS = 4000 // let the turn's last events land (and a queued user message start) first

export type DriveState = { on: boolean; replies: number; status: string | null; note: string | null; lastReplyAt: number | null }
type Row = { id: string; enabled: number; replies: number; last_reply: string | null; last_reply_at: number | null; status: string | null; note: string | null }

const row = (id: string) => get<Row>('select * from self_drive where id = ?', id)
export const isSelfDriving = (id: string) => !!row(id)?.enabled
export function driveState(id: string): DriveState {
  const r = row(id)
  return { on: !!r?.enabled, replies: r?.replies ?? 0, status: r?.status ?? null, note: r?.note ?? null, lastReplyAt: r?.last_reply_at ?? null }
}
export const driveLog = (id: string, limit = 30) =>
  all<{ at: number; action: string; message: string | null; reason: string | null }>('select at, action, message, reason from self_drive_log where conversation_id = ? order by at desc limit ?', id, limit)

const log = (id: string, action: string, message?: string | null, reason?: string | null) =>
  run('insert into self_drive_log (conversation_id, at, action, message, reason) values (?, ?, ?, ?, ?)', id, Date.now(), action, message ?? null, reason ?? null)
const setStatus = (id: string, status: string | null, note: string | null = null) =>
  run('update self_drive set status = ?, note = ?, updated_at = ? where id = ?', status, note, Date.now(), id)

export const onSelfDrive = new Set<(id: string) => void>()
const changed = (id: string) => onSelfDrive.forEach(f => f(id))

// Deps are swappable so tests can drive it without spawning Claude or a chat.
export const deps = {
  judge: (prompt: string) => judge(prompt),
  send: (id: string, prompt: string) => { send({ id, prompt, by: 'self-drive', resume: true }) },
  notice: (id: string, text: string) => { try { noticeLive(id, text) } catch {} },
  transcript: (id: string): Item[] => { const p = get<{ path: string }>('select path from conversations where id = ?', id)?.path; return p ? itemsOf(p) : [] },
  running: (_id: string) => false,
  paused: () => isPaused(),
  now: () => Date.now(),
}

export function setSelfDrive(id: string, on: boolean) {
  const now = deps.now()
  run(`insert into self_drive (id, enabled, on_at, updated_at) values (?, ?, ?, ?)
       on conflict(id) do update set enabled = excluded.enabled, on_at = case when excluded.enabled = 1 then excluded.on_at else self_drive.on_at end,
       status = null, note = null, updated_at = excluded.updated_at`, id, on ? 1 : 0, now, now)
  log(id, on ? 'on' : 'off')
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
    if (ev.type === 'result' || ev.type === 'perch_error') schedule(id)
  }, { background: true })
}

export function startSelfDrive(running: (id: string) => boolean) {
  deps.running = running
  for (const r of all<{ id: string }>('select id from self_drive where enabled = 1')) follow(r.id)
}

const timers = new Map<string, NodeJS.Timeout>()
const inflight = new Set<string>()
function schedule(id: string) {
  clearTimeout(timers.get(id))
  const t = setTimeout(() => { timers.delete(id); drive(id).catch(e => console.error('[self-drive]', id, e)) }, SETTLE_MS)
  t.unref?.()
  timers.set(id, t)
}

export type Verdict = { action: 'reply' | 'done' | 'needs_you' | 'wait'; message?: string; reason?: string }

export async function drive(id: string): Promise<Verdict | null> {
  const r = row(id)
  if (!r?.enabled || inflight.has(id) || deps.running(id)) return null
  if (deps.paused()) { setStatus(id, 'paused', 'auto-m8 is paused, or agents acting on their own is off in Settings'); changed(id); return null }
  const now = deps.now()
  const lastHour = get<{ n: number }>(`select count(*) n from self_drive_log where conversation_id = ? and action = 'reply' and at > ?`, id, now - 3600_000)?.n ?? 0
  if (lastHour >= PER_HOUR) return handBack(id, `Self drive replied ${lastHour} times in the last hour without finishing. Have a look at where it's going.`, '')
  const items = deps.transcript(id)
  const last = [...items].reverse().find(i => i.kind === 'assistant')
  if (!last) return null
  inflight.add(id)
  setStatus(id, 'thinking'); changed(id)
  try {
    const v = await deps.judge(prompt(id, items))
    if (!row(id)?.enabled) return null // switched off while it was thinking
    if (!v) { setStatus(id, 'error', "The driver's answer was unreadable; it tries again on the next turn."); log(id, 'error'); return null }
    if (deps.running(id)) { setStatus(id, null); return null } // the user (or something else) already picked it up
    return act(id, v, r)
  } finally { inflight.delete(id); changed(id) }
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

function act(id: string, v: Verdict, r: Row): Verdict {
  const message = (v.message ?? '').trim(), reason = (v.reason ?? '').trim()
  if (v.action === 'wait') { setStatus(id, null, reason || null); log(id, 'wait', null, reason); return v }
  if (v.action === 'done') {
    run('update self_drive set enabled = 0, status = ?, note = ?, updated_at = ? where id = ?', 'done', reason || 'Finished.', deps.now(), id)
    log(id, 'done', null, reason)
    deps.notice(id, `🚗 Self drive finished and turned itself off: ${reason || 'the work is done.'}`)
    return v
  }
  if (v.action === 'needs_you' || !message) return handBack(id, reason || 'The driver needs you here.', message)
  // Saying the same thing again means the chat is going round in circles: that's for the user.
  if (r.last_reply && norm(r.last_reply) === norm(message)) return handBack(id, 'Self drive was about to send the same reply twice; the chat looks stuck.', message)
  run('update self_drive set replies = replies + 1, last_reply = ?, last_reply_at = ?, status = ?, note = ?, updated_at = ? where id = ?', message, deps.now(), 'replied', reason || null, deps.now(), id)
  log(id, 'reply', message, reason)
  deps.send(id, message)
  return v
}

function handBack(id: string, reason: string, message: string): Verdict {
  setStatus(id, 'needs_you', reason)
  log(id, 'needs_you', message || null, reason)
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

export function prompt(id: string, items: Item[]) {
  const name = ownerName()
  let goal: { goal: string; done_when: string | null } | undefined
  try { goal = get<any>(`select goal, done_when from projects where conversation_id = ? and status = 'active'`, id) } catch {} // projects.ts may not be loaded
  return `You are driving an AI coding agent's chat on behalf of ${name}, who switched on "self drive" so the work finishes without them. The agent's turn just ended. Decide what ${name} would do next, as if you were them.

How ${name} works: they act like the founder of the work. Ship small and fast, decide reversible things on the spot, fix adjacent problems instead of routing around them, never hand work to other people. Short, decisive messages: the next concrete step, not a menu. They challenge the task when it looks wrong.

Choose one action:
- "reply": the agent asked something, offered options, stopped short ("say go and I'll…"), hit a fixable blocker, or stopped before finishing. Write ${name}'s next message: answer the question, pick the option (usually the agent's recommendation unless it's wrong), or tell it exactly what to do next. If the agent raised a real doubt that the task is wrong or harmful, it's fine to answer "stop" or to change direction: don't rubber-stamp.
- "done": the work is finished and checked (PR opened and handed to its shepherd, question answered, result verified). Nothing left for the agent to do.
- "wait": the agent is waiting on something that will come back by itself (CI, a deploy, a helper, a scheduled follow-up) and said so. Nothing to send now.
- "needs_you": only ${name} can do the next step: something irreversible or destructive in production, spending money, sending a message or posting publicly as them, a merge the PR's plan doesn't already allow, a credential or hardware approval, or a decision that belongs to someone outside the team. Also when the chat is going in circles.

Never approve destructive production actions, spending, or messages to people on ${name}'s behalf: that is "needs_you". Don't invent facts the transcript doesn't support.
${goal ? `\nThe goal of this chat: ${goal.goal}${goal.done_when ? `\nDone when: ${goal.done_when}` : ''}\n` : ''}
Reply with ONLY JSON: {"action": "reply" | "done" | "wait" | "needs_you", "message": "the message to send (reply only), in ${name}'s voice", "reason": "one short line: why"}

The conversation so far (most recent last):
${transcriptFor(items)}`
}

function judge(p: string): Promise<Verdict | null> {
  return new Promise(resolve => {
    let out = ''
    ephemeral(['-p', p, '--output-format', 'stream-json', '--verbose', '--model', settings.ai.model, '--no-session-persistence',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk'], settings.chat.cwd, ev => {
      if (ev.type === 'result') out = String(ev.result ?? '')
      if (ev.type === 'perch_done') resolve(parseVerdict(out))
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
