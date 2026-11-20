// Continue in the cloud (mobile plan, step 5): when the Mac is about to be unavailable, a
// conversation keeps going as a PostHog cloud task, then comes back to the same conversation.
//
// One conversation, one owner at a time. Handing off takes a lease: while the cloud owns it,
// anything sent to the conversation (from the phone, the Mac, or another agent) is forwarded to
// the cloud run as a steering message instead of starting a second local turn. Bringing it back
// releases the lease and resumes the local session with what the cloud did, so the local
// transcript stays the one history.
//
// What crosses: the conversation's condensed history (carry.ts, text only) and the code. The code
// goes as a branch: committed work is pushed as-is; uncommitted tracked changes are snapshotted with
// `git stash create` (a commit object; the working tree, index and stash list are untouched) and
// pushed to perch/cloud/<id>. Untracked files are listed, not copied.
import { execFile } from 'node:child_process'
import { all, get, run } from './db.ts'
import { settings } from './settings.ts'

run(`create table if not exists cloud_leases (
  conversation_id text primary key,
  task_id text not null, run_id text, url text,
  repository text, branch text, base_sha text, untracked text,
  status text not null,            -- cloud | returning | returned | failed
  started_at integer not null, finished_at integer, returned_at integer,
  by text, error text,
  sent text                        -- json: what was sent to the conversation while the cloud owned it
)`)
run('create table if not exists chat_notices (conversation_id text not null, at integer not null, text text not null)') // chat.ts owns it
const storeNotice = (id: string, text: string) => run('insert into chat_notices (conversation_id, at, text) values (?, ?, ?)', id, Date.now(), text)

export type Lease = { conversation_id: string; task_id: string; run_id: string | null; url: string | null; repository: string | null; branch: string | null; base_sha: string | null; untracked: string | null; status: string; started_at: number; finished_at: number | null; returned_at: number | null; by: string | null; error: string | null; sent: string | null }
// idle: the cloud agent finished its turn and is waiting. PostHog keeps such runs in_progress
// (the session stays open for follow-ups), so this, not the run status, is usually "done".
export type TaskState = { status: string; run: string | null; pr: string | null; error: string | null; idle?: boolean }
export type GitInfo = { repository: string | null; branch: string | null; sha: string | null; pushed: boolean; untracked: string[]; note: string }
export type Deps = {
  conversation: (id: string) => { cwd: string | null; title: string; running: boolean } | null
  history: (id: string) => string
  git: (cwd: string, convId: string) => Promise<GitInfo>
  // Reasons the cloud cannot do this conversation's work (a personal repo it cannot push to, ...). Optional.
  blockers?: (git: GitInfo, history: string) => Promise<string[]>
  startTask: (o: { title: string; description: string; repository?: string; branch?: string; parent: string }) => Promise<{ task: string; run: string | null }>
  taskState: (task: string) => Promise<TaskState>
  taskLogs: (task: string, run: string) => Promise<string>
  steer: (task: string, run: string, text: string) => Promise<void>
  resumeLocal: (id: string, prompt: string) => void
  notify: (n: { title: string; body: string; url: string; tag?: string }) => Promise<unknown>
  macAway: () => Promise<boolean>
  subscriptionReady?: () => boolean // a Claude subscription can take messages again (an account not at its limit)
  notice?: (id: string, text: string) => void // a note in the thread; live when the chat is open (chat.ts noticeLive)
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'canceled', 'error', 'stopped'])
const done = (s: TaskState) => TERMINAL.has(s.status) || !!s.idle

// From a run's raw session log: did the agent's last turn complete with no newer prompt after it?
export function idleFromLogs(rows: any[]) {
  let lastDone = -1, lastPrompt = -1
  rows.forEach((r, i) => { const m = (r?.notification ?? r)?.method; if (m === '_posthog/turn_complete') lastDone = i; if (m === 'session/prompt') lastPrompt = i })
  return lastDone >= 0 && lastDone > lastPrompt
}
export const RETURN_BY = 'perch-cloud-return'
export const taskUrl = (task: string) => `${settings.posthog.host}/project/${settings.posthog.projectId}/tasks/${task}`
export const leaseFor = (id: string) => get<Lease>(`select * from cloud_leases where conversation_id = ? and status in ('cloud', 'returning')`, id) ?? null
export const leases = () => all<Lease>('select * from cloud_leases order by started_at desc limit 50')

export function cloudPrompt(o: { title: string; history: string; git: GitInfo; convId: string }) {
  const code = o.git.repository && o.git.branch
    ? `The code is in ${o.git.repository} on branch \`${o.git.branch}\`${o.git.sha ? ` (at ${o.git.sha.slice(0, 12)})` : ''}. ${o.git.note} Work on that branch and push your commits to it, so the Mac can pick them up. Open or update a PR only if the conversation was already heading there.`
    : `There is no code to carry (${o.git.note}). Continue with research, investigation or planning; say clearly what you would change if code is needed.`
  return [
    `You are continuing a conversation that started on the user's Mac in perch. The Mac is unavailable for a while (asleep or away), so you own this work until it comes back. Pick up exactly where it left off: the last request below is what to do next.`,
    code,
    o.git.untracked.length ? `These new files existed on the Mac but were not committed, so you do not have them: ${o.git.untracked.slice(0, 30).join(', ')}${o.git.untracked.length > 30 ? ' …' : ''}.` : '',
    `the user may send you messages while you run; treat them as theirs. When you finish or get blocked, end with a short summary: what you did, what is pushed where, and what is left. That summary goes back into the original conversation.`,
    `## Conversation so far (perch://${o.convId}, "${o.title}")\n\n${o.history}`,
  ].filter(Boolean).join('\n\n')
}

export function returnPrompt(l: Lease, s: TaskState, logTail: string) {
  let sent: string[] = []
  try { sent = JSON.parse(l.sent ?? '[]') } catch {}
  return [
    `While the Mac was away, this conversation continued as a PostHog cloud task (${l.url ?? taskUrl(l.task_id)}). It has finished (${s.idle && !TERMINAL.has(s.status) ? 'its last turn is complete' : s.status}${s.error ? `: ${s.error}` : ''}) and the conversation is back here.`,
    l.branch && l.repository ? `It worked on ${l.repository} branch \`${l.branch}\`. Run \`git fetch origin ${l.branch}\`, look at what it changed since ${l.base_sha?.slice(0, 12) ?? 'the handoff'}, and bring it into this checkout (${l.branch.startsWith('perch/cloud/') ? 'that branch was made from a snapshot of your uncommitted changes, so merge or cherry-pick it onto the current branch, keeping any local edits' : 'fast-forward or merge'}).` : '',
    s.pr ? `It opened or updated ${s.pr}.` : '',
    sent.length ? `While it ran, these messages were sent to the conversation and went to the cloud run:\n${sent.map(m => `- ${m.replace(/\s+/g, ' ').slice(0, 600)}`).join('\n')}` : '',
    `What it said and did (tail of its log):\n\n${logTail || '(no log)'}`,
    `Check where things stand, then continue from there. If it finished the job, verify it and tell the user in one line.`,
  ].filter(Boolean).join('\n\n')
}

export function makeCloud(d: Deps) {
  const notice = d.notice ?? storeNotice
  // Hand a conversation to the cloud. Refuses while it is running locally: one owner at a time.
  async function handOff(id: string, by = 'user') {
    if (leaseFor(id)) throw new Error('This conversation is already in the cloud.')
    if (id.startsWith('task:')) throw new Error('This is already a cloud task.')
    const c = d.conversation(id)
    if (!c) throw new Error('No such conversation.')
    if (c.running) throw new Error('It is mid-turn on the Mac. Let the turn finish (or stop it), then continue it in the cloud.')
    const git = c.cwd ? await d.git(c.cwd, id) : { repository: null, branch: null, sha: null, pushed: false, untracked: [], note: 'the conversation has no working folder' }
    const history = d.history(id)
    const why = await d.blockers?.(git, history).catch(() => [] as string[]) ?? []
    if (why.length && by !== 'user-forced') throw new Error(`Not handing this to the cloud: ${why.join('; ')}. Keep it on the Mac, or delegate it to a local agent.`)
    const description = cloudPrompt({ title: c.title, history, git, convId: id })
    const t = await d.startTask({ title: `☁ ${c.title}`.slice(0, 120), description, repository: git.repository ?? undefined, branch: git.branch ?? undefined, parent: id })
    const url = taskUrl(t.task)
    run(`insert into cloud_leases (conversation_id, task_id, run_id, url, repository, branch, base_sha, untracked, status, started_at, by)
         values (?, ?, ?, ?, ?, ?, ?, ?, 'cloud', ?, ?)
         on conflict(conversation_id) do update set task_id = excluded.task_id, run_id = excluded.run_id, url = excluded.url, repository = excluded.repository,
           branch = excluded.branch, base_sha = excluded.base_sha, untracked = excluded.untracked, status = 'cloud', started_at = excluded.started_at,
           finished_at = null, returned_at = null, by = excluded.by, error = null, sent = null`,
      id, t.task, t.run, url, git.repository, git.branch, git.sha, JSON.stringify(git.untracked), Date.now(), by)
    run(`insert or ignore into links (a, b, kind, note, created_at) values (?, ?, 'continued-in-cloud', 'perch cloud handoff', ?)`, id, `task:${t.task}`, Date.now())
    notice(id, `Continuing in the cloud as a PostHog task: ${url}${git.branch ? ` (branch ${git.branch})` : ''}. Messages you send here go to it until it comes back.`)
    d.notify({ title: 'Continuing in the cloud', body: c.title.slice(0, 140), url, tag: `cloud:${id}` }).catch(() => {})
    return { ...leaseFor(id)!, git }
  }

  // Anything sent to a conversation the cloud owns goes to the cloud run. Returns true if it did.
  function intercept(opts: { id?: string; prompt: string; by?: string }) {
    if (!opts.id || opts.by === RETURN_BY) return false
    const l = leaseFor(opts.id)
    if (!l) return false
    if (!l.run_id || l.status !== 'cloud') throw new Error('This conversation is coming back from the cloud; send again in a moment.')
    // Handed to the cloud only because every subscription was out, and one is back (the limit
    // reset): bring it home with what the cloud did, and
    // send this message on the Mac instead of to the cloud run.
    if (l.by === 'fallback' && d.subscriptionReady?.()) {
      run(`update cloud_leases set status = 'returning' where conversation_id = ?`, opts.id)
      notice(opts.id, 'A Claude subscription is available again: bringing this conversation back from the cloud to the Mac, then sending your message.')
      const cid = opts.id, prompt = opts.prompt
      void (async () => {
        await d.steer(l.task_id, l.run_id!, 'The conversation moved back to the Mac. Stop now: push what you have to the branch and end with a short summary.').catch(() => {})
        await bringBack(cid, true, prompt).catch(e => {
          run(`update cloud_leases set status = 'returned', returned_at = ?, error = ? where conversation_id = ?`, Date.now(), `return failed: ${e?.message ?? e}`, cid)
          d.resumeLocal(cid, prompt)
        })
      })()
      return true
    }
    let sent: string[] = []
    try { sent = JSON.parse(l.sent ?? '[]') } catch {}
    run('update cloud_leases set sent = ? where conversation_id = ?', JSON.stringify([...sent, opts.prompt].slice(-40)), opts.id)
    notice(opts.id, `Sent to the cloud run: ${opts.prompt.replace(/\s+/g, ' ').slice(0, 300)}`)
    const cid = opts.id
    // A run that already stopped can't take messages; the message is kept and goes home with the conversation.
    d.steer(l.task_id, l.run_id, opts.prompt).catch(e => {
      run('update cloud_leases set error = ? where conversation_id = ?', `steer failed: ${e?.message ?? e}`, cid)
      notice(cid, 'The cloud run could not take that message (it may have stopped). It is kept and goes to the Mac when the conversation comes back.')
    })
    return true
  }

  // Bring it back: release the lease and resume the local session with what the cloud did.
  // If the run is still going, ask it to wrap up; the tick returns it once it stops.
  async function bringBack(id: string, force = false, next?: string) {
    const l = leaseFor(id)
    if (!l) throw new Error('This conversation is not in the cloud.')
    const s = await d.taskState(l.task_id)
    if (!done(s) && !force) {
      if (s.run) await d.steer(l.task_id, s.run, 'The user is back at the Mac. Wrap up now: push what you have to the branch, then stop with a short summary of what you did and what is left.')
      run(`update cloud_leases set status = 'returning' where conversation_id = ?`, id)
      return { returned: false, status: s.status }
    }
    const tail = s.run ? await d.taskLogs(l.task_id, s.run).catch(() => '') : ''
    run(`update cloud_leases set status = 'returned', returned_at = ?, finished_at = coalesce(finished_at, ?), error = ? where conversation_id = ?`, Date.now(), Date.now(), s.error, id)
    notice(id, `Back from the cloud (${s.status}). ${l.url ?? ''}`)
    d.resumeLocal(id, returnPrompt(l, s, tail.slice(-6000)) + (next ? `\n\n---\nThen the user's new message, sent while it was in the cloud:\n${next}` : ''))
    return { returned: true, status: s.status }
  }

  // Every minute: note finished runs, tell the phone, and bring finished work home when the Mac is in use.
  async function tick() {
    const live = all<Lease>(`select * from cloud_leases where status in ('cloud', 'returning')`)
    if (!live.length) return
    const away = await d.macAway()
    for (const l of live) {
      const s = await d.taskState(l.task_id).catch(() => null)
      if (!s) continue
      if (s.run && s.run !== l.run_id) run('update cloud_leases set run_id = ? where conversation_id = ?', s.run, l.conversation_id)
      if (!done(s)) continue
      if (!l.finished_at) {
        run('update cloud_leases set finished_at = ? where conversation_id = ?', Date.now(), l.conversation_id)
        d.notify({ title: s.status === 'completed' || (s.idle && !TERMINAL.has(s.status)) ? 'Cloud run finished' : `Cloud run ${s.status}`, body: (s.pr ? `${s.pr} · ` : '') + 'It comes back to the conversation when you are at the Mac.', url: l.url ?? taskUrl(l.task_id), tag: `cloud:${l.conversation_id}` }).catch(() => {})
      }
      if (!away || l.status === 'returning') await bringBack(l.conversation_id).catch(() => {})
    }
  }

  return { handOff, intercept, bringBack, tick }
}

// ---------- the real dependencies ----------
const sh = (cwd: string, args: string[]) => new Promise<{ ok: boolean; out: string }>(r =>
  execFile('git', args, { cwd, timeout: 60_000 }, (e, out, err) => r({ ok: !e, out: String(out || '').trim() || String(err || e?.message || '').trim() })))

export function repoFromRemote(url: string) {
  const m = url.trim().match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
  return m ? `${m[1]}/${m[2]}` : null
}

// What the cloud needs to pick the code up. Pushes only to a branch of its own (perch/cloud/<id>)
// when there is unpushed or uncommitted work; never rewrites the conversation's own branch.
export async function gitInfo(cwd: string, convId: string): Promise<GitInfo> {
  const top = await sh(cwd, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return { repository: null, branch: null, sha: null, pushed: false, untracked: [], note: 'the folder is not a git repository' }
  const repository = repoFromRemote((await sh(cwd, ['config', '--get', 'remote.origin.url'])).out)
  if (!repository) return { repository: null, branch: null, sha: null, pushed: false, untracked: [], note: 'the repository has no GitHub origin' }
  const branch = (await sh(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).out
  const head = (await sh(cwd, ['rev-parse', 'HEAD'])).out
  const untracked = (await sh(cwd, ['ls-files', '--others', '--exclude-standard'])).out.split('\n').filter(Boolean)
  const snap = (await sh(cwd, ['stash', 'create', `perch cloud handoff ${convId}`])).out // '' when nothing is uncommitted
  const remoteHead = branch !== 'HEAD' ? (await sh(cwd, ['ls-remote', 'origin', `refs/heads/${branch}`])).out.split(/\s/)[0] : ''
  if (!snap && branch !== 'HEAD' && remoteHead === head) return { repository, branch, sha: head, pushed: true, untracked, note: 'Everything committed on the Mac is already on that branch.' }
  const sha = snap || head
  const target = `perch/cloud/${convId.replace(/^task:/, '').slice(0, 8)}`
  const p = await sh(cwd, ['push', '--force', 'origin', `${sha}:refs/heads/${target}`])
  if (!p.ok) return { repository, branch: remoteHead ? branch : null, sha: remoteHead || null, pushed: false, untracked, note: `Pushing the Mac's latest work failed (${p.out.slice(0, 160)}), so the cloud has only what was already pushed${remoteHead ? '' : ' (nothing, for this branch)'}.` }
  return { repository, branch: target, sha, pushed: true, untracked, note: `This branch is a snapshot of the Mac's work on \`${branch}\`${snap ? ', including changes that were not committed yet (as one commit on top)' : ' (commits not pushed yet)'}.` }
}
