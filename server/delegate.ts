// Delegation: a chat hands a focused job (a review, a test run, a bit of research) to a helper
// conversation and carries on. The helper is an ordinary, visible perch chat, linked to its parent.
// When the helper finishes a turn, perch puts its report into the parent's input; if it is stuck
// it says so and the parent can answer it (delegate_send). Same idea as Herdr's `hc run --bg` /
// `hc send`, but the helper stays a normal conversation you can open, search and steer.
import { chatSubject } from './origin.ts'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chats, interrupt, send, subscribe } from './chat.ts'
import { editLabels, setTitle } from './conversations.ts'
import { all, get, run } from './db.ts'
import { settings } from './settings.ts'
import { marked } from './relay.ts'
import { createHelper } from './worktrees.ts'
import { machineLine } from './owner.ts'

run(`create table if not exists delegations (
  id text primary key, parent text not null, child text not null, name text not null, brief text not null,
  status text not null default 'running', result text, created_at integer not null, finished_at integer, reports integer not null default 0)`)
// The helper's own git worktree, when it was given one (delegate worktree=true).
try { run('alter table delegations add column worktree text') } catch {}
try { run('alter table delegations add column branch text') } catch {}

export const onDelegate = new Set<() => void>()
const changed = () => onDelegate.forEach(f => f())

const MAX_RUNNING = 25
const MAX_REPORT = 6000

const kickoff = (d: { brief: string; name: string }, parent: string) => `You are a helper that conversation ${parent} delegated a job to. You are not talking to the user directly: your final message of each turn is sent to the parent agent as your report.
Job: ${d.name}

${d.brief}

How to work:
- Do the job and nothing else. Don't delegate further.
- Your last message is the report. Lead with the result or the answer, then what you checked or changed, then anything left undone. Keep it under 400 words and include paths, PR links or numbers the parent needs.
- If you are blocked on a decision or on information only the parent or the user has, start your final message with "NEEDS HELP:" and say exactly what you need. The parent can answer and you will continue.`

type Wt = Awaited<ReturnType<typeof createHelper>>
const worktreeNote = (w: Wt) => `

YOUR WORKTREE: you work in your own git worktree, ${w.dir}, on a new branch ${w.branch}, started from ${w.base} (${w.from}) of ${w.repo}. Other agents edit other checkouts at the same time, so stay in this directory.${w.dirtyParent ? ` The parent's ${w.dirtyParent} uncommitted changes are NOT here; if the job depends on them, say NEEDS HELP.` : ''}
- Deliver by committing on ${w.branch} (clear messages). Don't push or open a PR unless the brief says so. Your report names the branch and its commits; the parent merges them.
- This Mac is shared by every running agent (${machineLine}, one Docker daemon). A new worktree has no node_modules or virtualenv: install dependencies only if the job needs them (the package manager's shared cache makes it quick). Run only the tests for what you changed, never the full suite; don't start dev servers, docker compose stacks or anything on a default port.
- Finish with the worktree clean (everything committed or discarded). perch removes it once it is idle and clean; the branch and its commits stay.`

// Which model runs the helper: Claude and Codex are peers, so the parent picks per job. 'auto' (or
// nothing) lets perch route it like any chat; 'claude' pins Claude Sonnet; 'codex' or 'codex:<model>'
// pins Codex; 'claude:<tier>' is a specific Claude model.
export function helperEngine(e?: string): string {
  const v = String(e ?? '').trim().toLowerCase()
  if (!v || v === 'auto') return 'auto'
  if (v === 'claude') return 'claude:sonnet'
  if (v === 'codex' || v.startsWith('codex:') || /^claude:(haiku|sonnet|opus|fable)$/.test(v)) return v
  throw new Error(`Unknown engine "${e}": use auto, claude, claude:<haiku|sonnet|opus>, codex or codex:<model>.`)
}

export async function start(input: { parent: string; brief: string; name?: string; cwd?: string; mode?: string; worktree?: boolean; engine?: string }) {
  const parent = String(input.parent || '')
  if (!parent) throw new Error('delegate needs the parent conversation_id (yours).')
  if (get('select 1 from delegations where child = ?', parent)) throw new Error('You are already a helper: do the job yourself instead of delegating it on.')
  if (all<any>(`select 1 from delegations where parent = ? and status = 'running'`, parent).length >= MAX_RUNNING) throw new Error(`${MAX_RUNNING} helpers are already running for this conversation. Wait for a report or stop one.`)
  const brief = String(input.brief ?? '').trim()
  if (!brief) throw new Error('Give the helper a brief: what to do and what to report back.')
  const name = (input.name ?? brief.replace(/\s+/g, ' ')).slice(0, 80)
  const parentCwd = get<{ cwd: string }>('select cwd from conversations where id = ?', parent)?.cwd
  const cwd = [input.cwd, parentCwd].find(c => c && existsSync(c)) ?? settings.chat.cwd
  const id = randomUUID(), child = randomUUID()
  const wt = input.worktree ? await createHelper(cwd, child) : null
  run('insert into delegations (id, parent, child, name, brief, created_at, worktree, branch) values (?, ?, ?, ?, ?, ?, ?, ?)', id, parent, child, name, brief, Date.now(), wt?.dir ?? null, wt?.branch ?? null)
  send({ by: 'helper', id: child, originParent: chatSubject(parent), engine: helperEngine(input.engine), cwd: wt?.dir ?? cwd, prompt: kickoff({ brief, name }, parent) + (wt ? worktreeNote(wt) : ''), mode: input.mode ?? 'acceptEdits', context: true, resume: false })
  editLabels([child], ['helper'])
  setTitle(child, `Helper: ${name}`)
  run('insert or ignore into links (a, b, kind, note, created_at) values (?, ?, ?, ?, ?)', parent, child, 'started', 'helper', Date.now())
  follow(id)
  changed()
  return { id, child, worktree: wt?.dir ?? null, branch: wt?.branch ?? null, repo: wt?.repo ?? null }
}

const following = new Set<string>()
function follow(id: string) {
  if (following.has(id)) return
  following.add(id)
  const d0 = get<any>('select child from delegations where id = ?', id)
  if (!d0) return
  let text = ''
  subscribe(d0.child, ev => {
    if (ev.parent_tool_use_id) return
    if (ev.type === 'perch_user') text = ''
    if (ev.type === 'stream_event' && ev.event?.delta?.type === 'text_delta') text += ev.event.delta.text
    if (ev.type === 'result') report(id, String(ev.result ?? text ?? ''), !!ev.is_error)
    if (ev.type === 'perch_error') report(id, `The helper stopped: ${String(ev.message ?? 'unexpectedly').slice(0, 500)}`, true)
  }, { background: true })
}

function report(id: string, text: string, failed: boolean) {
  const d = get<any>('select * from delegations where id = ?', id)
  if (!d || d.status === 'stopped') return
  const body = text.trim().slice(0, MAX_REPORT) || '(the helper finished without writing a report)'
  const needsHelp = /^\s*NEEDS HELP:/i.test(body)
  const status = failed ? 'failed' : needsHelp ? 'needs-help' : 'done'
  run('update delegations set status = ?, result = ?, finished_at = ?, reports = reports + 1 where id = ?', status, body, Date.now(), id)
  const head = failed ? 'FAILED' : needsHelp ? 'BLOCKED, NEEDS YOU' : 'DONE'
  const wtLine = d.worktree ? `\nIts worktree: ${d.worktree} (branch ${d.branch}). Review with \`git log -p HEAD..${d.branch}\` in your checkout, then merge or cherry-pick it; perch removes the worktree once it is idle and clean, the branch stays.` : ''
  const prompt = `HELPER REPORT (from a helper you delegated to, not from the user): "${d.name}" ${head}.\n\n${body}\n\nHelper conversation: perch://${d.child}${wtLine}${needsHelp ? `\nAnswer with delegate_send (id ${id}) to unblock it.` : ''}`
  // Only conversations perch itself runs can take the report as input; resuming one that is open in
  // a terminal would fork its history. Those get the report in the helper's thread and Needs me.
  const ours = chats.has(d.parent) || !!get('select 1 from perch_started where id = ?', d.parent)
  if (ours) send({ id: d.parent, prompt, resume: true })
  else run(`insert into user_state (id, state, state_auto, state_at, note) values (?, 'waiting', 2, ?, ?)
            on conflict(id) do update set state = 'waiting', state_auto = 2, state_at = excluded.state_at, note = excluded.note`, d.child, Date.now(), `Helper ${status}; its parent isn't running in perch, so read the report here`)
  changed()
}

// The parent answers a blocked helper, or gives it more to do.
export function sendTo(id: string, message: string) {
  const d = get<any>('select * from delegations where id = ?', id)
  if (!d) throw new Error('No such helper.')
  if (d.status === 'stopped') throw new Error('That helper was stopped.')
  if (d.worktree && !existsSync(d.worktree)) throw new Error(`Its worktree ${d.worktree} was cleaned up (branch ${d.branch} is kept). Delegate a new helper with worktree=true and point it at that branch.`)
  run(`update delegations set status = 'running' where id = ?`, id)
  follow(id)
  send({ id: d.child, prompt: marked(d.parent, String(message)), resume: true })
  changed()
}

export function stop(id: string) {
  const d = get<any>('select child from delegations where id = ?', id)
  if (!d) return
  run(`update delegations set status = 'stopped', finished_at = ? where id = ?`, Date.now(), id)
  interrupt(d.child)
  changed()
}

export const forParent = (parent: string) => all<any>('select id, child, name, status, result, created_at, finished_at, worktree, branch from delegations where parent = ? order by created_at', parent)
export const forChild = (child: string) => get<any>('select id, parent, name, status from delegations where child = ?', child)

export function resumeFollowers() { for (const d of all<any>(`select id from delegations where status = 'running'`)) follow(d.id) }
