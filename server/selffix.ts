// Self-fix: perch fixes its own recurring bugs instead of listing them in a tab. When an error keeps
// coming back (10+ times, still happening today, not a network blip), perch starts one agent in a
// worktree of its own repo, on a perch-fix/<slug> branch: it reproduces the bug on a copy of the
// database, fixes the cause, runs typecheck and tests, commits on that branch, and asks you one
// decision: merge it or not. One fix at a time, at most two a day. It never touches main, never
// restarts perch, and never pushes.
// Autopilot findings that aren't about perch's own code become decisions too: "Fix it for me"
// starts an agent on it, "Leave it" drops it.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { send } from './chat.ts'
import { editLabels, setTitle } from './conversations.ts'
import { all, get, run } from './db.ts'
import { raise } from './decisionstore.ts'
import { notPerchBug } from './errors.ts'
import { HOME, settings } from './settings.ts'

const exec = promisify(execFile)
const STARTED = Date.now()
const DAY = 86400_000
// The checkout this perch runs from, wherever it was cloned.
const REPO = join(import.meta.dirname, '..')
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)

const PROMPT = (e: any, branch: string, decisionKey: string) => `perch keeps hitting this error, and you are fixing it in perch's own code (~/Development/perch, but work only in this worktree, branch ${branch}).

Where: ${e.source}
Seen ${e.count} times, first ${new Date(e.first_at).toISOString()}, last ${new Date(e.last_at).toISOString()}.
What perch told the user: ${e.message}
Raw error:
${String(e.detail ?? '').slice(0, 2500)}

1. Load the perch-perch-app-dev skill (use_skill) and follow its rules.
2. Find the cause in this worktree's code. Investigate against a COPY of the live database (sqlite3 ".backup" into /tmp), never the live one.
3. Fix it at the cause, with a test in server/perch.test.ts when the logic is testable. Run \`npx tsc --noEmit -p .\` and \`npm test\` here.
4. Commit on ${branch} in this worktree (never on main, never push, never restart perch).
5. Then call the perch ask_decision tool with this conversation's id, question "Merge perch fix: <one line>?", options ["Merge it", "Leave it"], your recommendation, and in context: the cause, the fix, and what you ran. If the answer comes back "Merge it": in ~/Development/perch, check \`git status --short\`; if main has uncommitted changes that touch the same files, stop and say so; otherwise \`git merge --no-ff ${branch}\`, then remove the worktree. Tell the user perch needs a restart (⌘⇧R) to run the fix.
If it turns out not to be a bug in perch (an outside service, the user's setup), don't change code: say what it is and what the user would do, and use ask_decision for that instead.`

export async function selfFix() {
  if (!existsSync(join(REPO, '.git'))) return
  // One at a time, two a day.
  const today = all<any>(`select status from decisions where key like 'perchfix:%' and created_at > ?`, Date.now() - DAY)
  if (today.length >= 2 || get(`select 1 from decisions where key like 'perchfix:%' and status = 'open'`)) return
  // Still happening since this process started (so not something this build already fixed), and
  // not a setup problem only you can fix.
  const e = all<any>(`select * from errors where status not in ('resolved', 'needs-you') and count >= 10 and last_at > ? order by count desc`, STARTED)
    .find(x => !notPerchBug(`${x.message} ${x.detail}`) && !get('select 1 from decisions where key = ?', `perchfix:${x.key}`))
  if (!e) return
  const name = slug(`${e.source} ${e.message}`)
  const branch = `perch-fix/${name}`
  const dir = join(dirname(REPO), '.perch-worktrees', `perch-fix-${name}`)
  if (!existsSync(dir)) {
    mkdirSync(dirname(dir), { recursive: true })
    // The branch can outlive an earlier fix: reuse it rather than give up.
    try { await exec('git', ['-C', REPO, 'worktree', 'add', '-b', branch, dir, 'HEAD']) }
    catch { await exec('git', ['-C', REPO, 'worktree', 'add', dir, branch]) }
  }
  const key = `perchfix:${e.key}`
  const id = send({ by: 'self-fix', cwd: dir, prompt: PROMPT(e, branch, key), resume: false, context: true })
  setTitle(id, `perch fixes itself: ${e.source}`)
  editLabels([id], ['perch', 'self-fix'])
  // The decision exists from the start, so the queue shows a fix is under way; the agent's own
  // ask_decision (merge it?) lands next to it, and answering either goes to this conversation.
  raise({ key, source: 'autopilot', conversationId: id, title: `perch is fixing its own bug: ${e.message}`.slice(0, 300), context: `Seen ${e.count} times. An agent is on it in ${dir} (branch ${branch}); it will ask before merging.`, options: ['Let it finish', 'Stop it'], recommendation: 'Let it finish', stakes: 'low' })
}

// An autopilot finding becomes a decision instead of a card in a tab you don't open.
export function findingToDecision(s: { id: string; title: string; why: string; link?: string }) {
  raise({ key: `autopilot:${s.title.toLowerCase().slice(0, 160)}`, source: 'autopilot', url: s.link ?? null, title: s.title, context: s.why, options: ['Fix it for me', 'Leave it'], recommendation: 'Fix it for me', stakes: 'low' })
}

// "Fix it for me" on a finding: an agent takes it, in perch's repo when it's about perch.
export function fixFinding(title: string, why: string, link: string | null) {
  const aboutPerch = /\bperch\b|shepherd|autopilot|routine|brief/i.test(`${title} ${why}`)
  const prompt = `perch's autopilot found this and the user asked you to fix it:

${title}
${why}${link ? `\n${link}` : ''}

Fix it at the cause, then verify the fix worked (re-run the check, or look at the data again).
- If it's about perch itself, load perch-perch-app-dev (use_skill) and follow its rules: work on a perch-fix/ branch in a worktree, never on main, don't push or restart.
- If it's a PostHog scout, workflow or task, use the PostHog MCP.
- Never post to Slack or message anyone. If the fix needs someone else, draft it with draft_slack_message for the user.
- If a real choice is left that only the user can make, use ask_decision, don't end on a question.`
  const id = send({ by: 'autopilot', cwd: aboutPerch ? REPO : settings.chat.cwd, prompt, resume: false, context: true })
  setTitle(id, `Autopilot fix: ${title}`.slice(0, 120))
  editLabels([id], ['autopilot'])
  return id
}
