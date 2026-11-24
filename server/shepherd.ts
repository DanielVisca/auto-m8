// Shepherd: every PR an agent opens for you is driven from review to verified in production.
// - Review: the moment one needs an answer a shepherd run starts on it: a new review thread
//   comment, a human comment, a changes-requested review, CI going red, or a green head with no
//   open threads that has no stamphog label yet (stamphog repos only).
// - Merge: when the PR's plan says `merge: auto`, it is approved, green, has no open threads, and
//   every PR it waits on is verified in production, the shepherd merges it (Trunk where the repo
//   uses it).
// - Production: after the merge the shepherd waits for the deploy, then checks the plan's verify
//   list against the pre-merge baseline right away and again two hours after the merge. A
//   regression gets a revert PR and a NEEDS YOU, never an automatic revert.
// The plan lives in the PR description as a <!-- perch-plan --> block. Agents write it when they
// open the PR (~/.claude/CLAUDE.md asks them to); the shepherd backfills it when one is missing.
// Each PR gets one shepherd conversation in a worktree of its branch, resumed for every step, so
// it keeps the PR's history. It marks what it posts, so its own replies never wake it again.
// GitHub can't push to this laptop, so "the moment" is one GraphQL call every pollSeconds.
import { prSubject } from './origin.ts'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { send } from './chat.ts'
import { signature } from './signhook.ts'
import { editLabels, setTitle } from './conversations.ts'
import { link } from './context.ts'
import { all, get, run } from './db.ts'
import { recordError, resolveErrors } from './errors.ts'
import { checkContextFields, checkContexts, summarizeChecks, ghOffline, isGhSkippedOffline, prBatch, ghExec } from './gh.ts'
import { activeShepherds, prWorktree } from './pr.ts'
import { autonomyOn, settings, updateSettings } from './settings.ts'
import { isPaused } from './pausehold.ts'
import { MARK, revive, reviveBackoff, watch } from './shepherdstore.ts'
import { raise, resolveKey } from './decisionstore.ts'
import { toItems, itemsOf } from './transcript.ts'
import { ownerName } from './owner.ts'

export { MARK } from './shepherdstore.ts'

const exec = promisify(execFile)
const MIN = 60_000

// Bots whose top-level comments are summaries or merge plumbing, not something to answer.
// Their inline review threads still count.
const SUMMARY_BOTS = /^(trunk-io|github-actions|parameterai|veria-ai|vercel|codecov|changeset-bot|netlify|posthog)(\[bot\])?$/i
const isBot = (login: string) => /\[bot\]$/.test(login) || SUMMARY_BOTS.test(login)

// What an agent leaves in a PR description: Claude Code, PostHog cloud tasks, Desktop and Code.
export const AGENT_PR = /<!-- perch-plan|Generated with \[Claude Code\]|Created with \[PostHog( Code| Desktop)?\]|## 🤖 Agent context/

export type Item = { id: number; author: string; body: string; at?: number }
export type Snapshot = {
  state: string; isDraft: boolean; head: string; rollup: string | null; failing: string[]
  ciFailure?: boolean // complete context classification; excludes only proven optional cancellations
  headAt?: number | null // when the head commit was made; a draft quiet for STALLED_DRAFT_MS is a candidate
  planState?: string | null // the perch/plan status GitHub shows on the head now (lowercase); null when there is none
  labels: string[]; reviewDecision: string | null; body: string; mergedAt: number | null; mergeSha: string | null
  threads: { resolved: boolean; last: Item | null }[]
  comments: Item[]
  reviews: (Item & { state: string })[]
  fingerprint?: string // the cheap per-PR fingerprint (changedSnapshots) this read matches
}
export type Watch = { seen_comment: number; seen_thread: number; seen_review: number; handled_ci: string | null; handled_stamp: string | null }

// ---------- the plan in the PR description ----------
export type Plan = { merge: 'auto' | 'manual'; after: string[]; deploy: string; verify: string[]; raw: string }

export function parsePlan(body: string): Plan | null {
  const m = body.match(/<!--\s*perch-plan\b([\s\S]*?)-->/)
  if (!m) return null
  const raw = m[1].trim()
  const after: string[] = [], verify: string[] = []
  let merge: Plan['merge'] = 'manual', deploy = '', inVerify = false
  for (const line of raw.split('\n')) {
    const t = line.replace(/\s+#.*$/, '').trim()
    if (!t) continue
    let kv
    if ((kv = t.match(/^merge:\s*(auto|manual)\b/i))) { merge = kv[1].toLowerCase() as Plan['merge']; inVerify = false }
    else if ((kv = t.match(/^after:\s*(.+)$/i))) { after.push(...(kv[1].match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) ?? [])); inVerify = false }
    else if ((kv = t.match(/^deploy:\s*(.*)$/i))) { deploy = kv[1]; inVerify = false }
    else if (/^verify:\s*$/i.test(t)) inVerify = true
    else if ((kv = t.match(/^verify:\s*(.+)$/i))) { verify.push(kv[1]); inVerify = true }
    else if (inVerify && t.startsWith('-')) verify.push(t.replace(/^-\s*/, ''))
  }
  return { merge, after, deploy, verify, raw }
}

// The shepherd posts from your account, so its comments look like yours. They are the ones posted
// while one of its runs was going: [start, end] windows, end Infinity while a run is still out.
export type Own = { me: string; windows: [number, number][] }
const SLACK = 60_000
export const byShepherd = (i: Item, own?: Own) => !!own && i.author === own.me && own.windows.some(([a, b]) => (i.at ?? 0) >= a - SLACK && (i.at ?? 0) <= b + SLACK)

// What in an open PR needs a review run now, and the watermarks to store once a run takes it.
// Pure, so the rules are tested without GitHub.
export function detect(pr: Snapshot, w: Watch, stamphogRepo: boolean, own?: Own) {
  const events: string[] = []
  const fresh = (i: Item | null, mark: number): i is Item => !!i && i.id > mark && !i.body.includes(MARK) && !byShepherd(i, own)
  const snip = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim().slice(0, 160)
  const top = (items: (Item | null)[], mark: number) => items.reduce((m, i) => (i && i.id > m ? i.id : m), mark)
  const seen = {
    thread: top(pr.threads.map(t => t.last), w.seen_thread),
    comment: top(pr.comments, w.seen_comment),
    review: top(pr.reviews, w.seen_review),
  }

  for (const t of pr.threads) if (!t.resolved && fresh(t.last, w.seen_thread)) events.push(`review thread comment from ${t.last.author}: ${snip(t.last.body)}`)
  // Slash commands (/trunk merge, /deploy …) are instructions to a bot, not something to answer.
  const command = (c: Item) => /^\s*\//.test(c.body)
  for (const c of pr.comments) if (fresh(c, w.seen_comment) && !isBot(c.author) && !command(c)) events.push(`comment from ${c.author}: ${snip(c.body)}`)
  for (const r of pr.reviews) {
    if (!fresh(r, w.seen_review)) continue
    if (r.state === 'CHANGES_REQUESTED') events.push(`changes requested by ${r.author}: ${snip(r.body) || '(see its threads)'}`)
    else if (!isBot(r.author) && r.body.trim() && r.state !== 'APPROVED') events.push(`review from ${r.author}: ${snip(r.body)}`)
  }

  let ci: string | null = null
  if (pr.ciFailure ?? (pr.rollup === 'FAILURE' || pr.rollup === 'ERROR')) {
    const sig = `${pr.head}:${pr.failing.length ? [...pr.failing].sort().join(',') : `rollup=${pr.rollup}`}`
    if (sig !== w.handled_ci) { events.push(`CI red on ${pr.head.slice(0, 12)}: ${pr.failing.slice(0, 6).join(', ') || 'GitHub reports failure; named check details unavailable'}`); ci = sig }
  }

  let stamp: string | null = null
  const openThreads = pr.threads.filter(t => !t.resolved).length
  if (stamphogRepo && pr.rollup === 'SUCCESS' && !pr.isDraft && pr.reviewDecision !== 'APPROVED'
    && !pr.labels.includes('stamphog') && openThreads === 0 && pr.head !== w.handled_stamp) {
    events.push(`CI green on ${pr.head.slice(0, 12)} with no open threads and no stamphog label: apply stamphog`)
    stamp = pr.head
  }
  return { events, seen, ci, stamp }
}

// A prerequisite is met once it passed its first production check ('verifying'); the two-hour
// check still runs and can still flag a regression, but the PRs after it don't wait for it.
// A hand-off counts too: it is live and nothing regressed; the unmet check belongs to its follow-up.
// So does 'live': a no-signal answer means it is deployed and nothing regressed, only its usage data
// hasn't filled. Without it a PR waiting a week for usage held every PR after it for that week.
export const NO_SIGNAL_MARK = 'live, no signal yet: '
const MET = new Set(['verifying', 'verified', 'handed-off', 'live'])
export const waitingOn = (plan: Plan | null, depStages: Record<string, string | null>) =>
  (plan?.after ?? []).filter(u => !MET.has(depStages[u] ?? ''))

// Is an open PR ready for the shepherd to merge? Returns why not, or null when it is.
export function mergeBlocker(pr: Snapshot, plan: Plan | null, depStages: Record<string, string | null>, handledMerge: string | null) {
  if (!plan) return 'no perch-plan in the description'
  if (plan.merge !== 'auto') return 'plan says merge: manual'
  if (pr.isDraft) return 'draft'
  if (pr.reviewDecision !== 'APPROVED') return 'not approved'
  if (pr.rollup !== 'SUCCESS') return `CI ${String(pr.rollup ?? 'unknown').toLowerCase()}`
  if (pr.threads.some(t => !t.resolved)) return 'open review threads'
  const waiting = waitingOn(plan, depStages)
  if (waiting.length) return `waiting for ${waiting.map(u => `#${u.split('/').pop()} (${depStages[u] ?? 'not watched'})`).join(', ')} to pass a production check`
  if (handledMerge === pr.head) return 'merge already requested for this head'
  return null
}

// ---------- stalled drafts ----------
// Slack-app and cloud tasks open their PRs as drafts, and the shepherd never acts on a draft, so a
// finished one waits forever. A draft we opened (perch-origin marker), green, with no commit for
// STALLED_DRAFT_MS is a stalled candidate: with a perch-plan it is marked ready, without one it is
// raised once as Needs you. A draft anyone says is held on purpose is never touched.
export const STALLED_DRAFT_MS = 6 * 60 * 60 * 1000
const ORIGIN_MARK = /<!-- perch-origin:v1/
const HELD = /\bWIP\b|\bdo not merge\b|\bdon'?t merge\b|\bon hold\b|\bhold(ing)? (this|it|off)\b|\bkeep(ing)? (this |it )?(as )?(a )?draft\b|\bdraft (on purpose|deliberately|intentionally)|\b(intentionally|deliberately) (a |kept as a |left as a )?draft\b|\bparked\b|\bdraft reason\b/i
export type DraftCall = { kind: 'ready' | 'needs' | 'held'; reason: string }
export function stalledDraft(pr: Snapshot, now = Date.now()): DraftCall | null {
  if (!pr.isDraft || pr.state !== 'OPEN' || !ORIGIN_MARK.test(pr.body)) return null
  if (pr.rollup !== 'SUCCESS' || pr.failing.length) return null
  if (!pr.headAt || now - pr.headAt < STALLED_DRAFT_MS) return null
  const said = [pr.body, ...pr.comments.map(c => c.body), ...pr.reviews.map(r => r.body)].find(t => HELD.test(t))
  if (said) return { kind: 'held', reason: `held on purpose: "${said.match(HELD)![0]}"` }
  if (parsePlan(pr.body)) return { kind: 'ready', reason: 'green draft with a perch-plan, no commits for 6h' }
  return { kind: 'needs', reason: 'green draft with no commits for 6h and no perch-plan, so perch cannot mark it ready on its own' }
}

// What a verify run concluded, from the last reply.
// NOT MET: a check didn't hold, nothing got worse, and a follow-up PR owns the rest. Ends the
// verify loop without a revert; perch watches the follow-up instead.
// NO SIGNAL: some check couldn't be judged (no traffic, no data yet, tool down). Not a pass, not a
// failure: the round runs again later. It outranks VERIFIED, so a reply with both never counts as a pass.
export function verifyOutcome(text: string): { kind: 'verified' | 'regression' | 'not-met' | 'no-signal' | 'not-deployed' | 'unclear'; detail: string; followUp?: string } {
  const line = (re: RegExp) => text.split('\n').map(l => l.replace(/^[\s>*_`]+|[*_`]+$/g, '').trim()).find(l => re.test(l)) ?? ''
  const reg = line(/^REGRESSION\b/i)
  if (reg) return { kind: 'regression', detail: reg }
  const nm = line(/^NOT MET\b/i)
  if (nm) return { kind: 'not-met', detail: nm, followUp: nm.match(/https:\/\/github\.com\/[^\s)>\]]+\/pull\/\d+/)?.[0] }
  const ns = line(/^NO[ -]SIGNAL\b/i)
  if (ns) return { kind: 'no-signal', detail: ns }
  const nd = line(/^NOT DEPLOYED\b/i)
  if (nd) return { kind: 'not-deployed', detail: nd }
  if (line(/^VERIFIED\b/i)) return { kind: 'verified', detail: 'all checks passed' }
  return { kind: 'unclear', detail: text.trim().split('\n').at(-1)?.slice(0, 200) ?? '' }
}

// A blocker only a person can clear: a deployment environment waiting for an approver, a release
// gated on a team, CODEOWNERS on another team, access the account doesn't have. Retrying these
// burns runs and changes nothing, so the shepherd stops and asks you once instead.
const GATE = /\b(approv(al|er|ers)|environment protection|deployment protection|code ?owners?|can'?t give|cannot give|doesn'?t have (access|permission)|permission|waiting for (a |an )?(review|approval|human)|needs? (a |an )?(human|person)|protected branch|required reviewer)/i
export const isHumanGate = (detail: string) => GATE.test(detail)

// When to look again after a no-signal answer: the date it names (e.g. "waiting for 7-day window (2026-11-25)"),
// a day for a "24h" window, otherwise six hours. Never sooner than an hour.
export function noSignalRecheckAt(detail: string, now: number): number {
  const HOUR = 3_600_000
  const date = detail.match(/\b(20\d\d-\d\d-\d\d)(?:[ T](\d\d:\d\d))?/)
  if (date) {
    const t = Date.parse(`${date[1]}T${date[2] ?? '12:00'}:00Z`)
    if (!Number.isNaN(t)) return Math.max(now + HOUR, t)
  }
  if (/\b24 ?h|\b24-hour|\bday\b/i.test(detail)) return now + 24 * HOUR
  return now + 6 * HOUR
}

// NEEDS YOU lines a shepherd run ended on, one per decision.
export const needsYou = (text: string) => text.split('\n').map(l => l.replace(/^[\s>*_`-]+/, '').trim()).filter(l => /^NEEDS YOU:/i.test(l)).map(l => l.replace(/^NEEDS YOU:\s*/i, '').replace(/[*_`]+$/, '').trim()).filter(Boolean)

// ---------- GitHub ----------
const parse = (url: string) => {
  const [, owner, repo, , n] = new URL(url).pathname.split('/')
  return { owner, repo, number: Number(n), slug: `${owner}/${repo}` }
}

const item = (n: any): Item | null => n ? { id: Number(n.databaseId ?? 0), author: n.author?.login ?? 'ghost', body: String(n.body ?? ''), at: Date.parse(n.createdAt ?? n.submittedAt ?? 0) || 0 } : null

// One bad PR (deleted, no access) or one slow chunk no longer loses the rest: prBatch keeps
// partial results and splits a failing chunk. It throws only if nothing at all came back.
export async function snapshots(urls: string[]): Promise<Map<string, Snapshot>> {
  const { prs, failed } = await prBatch(urls, url => `
      updatedAt state isDraft headRefOid reviewDecision body mergedAt mergeCommit { oid } labels(first: 20) { nodes { name } }
      commits(last: 1) { nodes { commit { committedDate statusCheckRollup { id state contexts(first: 100) { ${checkContextFields(parse(url).number)} } } } } }
      comments(last: 30) { nodes { databaseId author { login } body createdAt } }
      reviews(last: 20) { nodes { databaseId author { login } body state submittedAt } }
      reviewThreads(last: 60) { nodes { isResolved comments(last: 1) { nodes { databaseId author { login } body createdAt } } } }`, { size: 10, timeout: 60_000 })
  if (failed && !prs.size) throw failed
  const out = new Map<string, Snapshot>()
  for (const [url, p] of prs) {
    const rollup = p.commits.nodes[0]?.commit?.statusCheckRollup
    let contexts
    try { contexts = await checkContexts(rollup, parse(url).number) }
    catch (e) { recordError('PR shepherd', e, `Reading all checks on ${url}`); continue }
    const checks = summarizeChecks(rollup?.state, contexts)
    out.set(url, {
      state: p.state, isDraft: p.isDraft, head: p.headRefOid, rollup: rollup?.state ?? null, fingerprint: fingerprintOf(p),
      headAt: Date.parse(p.commits.nodes[0]?.commit?.committedDate ?? '') || null,
      failing: checks.failing, ciFailure: checks.checks === 'failing',
      planState: String((contexts as any[]).find(c => c?.context === 'perch/plan')?.state ?? '').toLowerCase() || null,
      labels: p.labels.nodes.map((l: any) => l.name), reviewDecision: p.reviewDecision,
      body: String(p.body ?? ''), mergedAt: p.mergedAt ? Date.parse(p.mergedAt) : null, mergeSha: p.mergeCommit?.oid ?? null,
      threads: p.reviewThreads.nodes.map((t: any) => ({ resolved: t.isResolved, last: item(t.comments.nodes[0]) })),
      comments: p.comments.nodes.map(item).filter(Boolean),
      reviews: p.reviews.nodes.map((r: any) => ({ ...item(r)!, state: r.state })),
    })
  }
  return out
}

// A repo runs stamphog when it has the label. Checked once per repo per process.
const stamphogRepos = new Map<string, boolean>()
async function hasStamphog(slug: string) {
  if (!stamphogRepos.has(slug)) {
    try { await ghExec(['api', `repos/${slug}/labels/stamphog`, '--silent']); stamphogRepos.set(slug, true) }
    catch { stamphogRepos.set(slug, false) }
  }
  return stamphogRepos.get(slug)!
}

// ---------- the runs ----------
export const PLAN_FORMAT = `<!-- perch-plan
merge: auto            # auto: auto-m8 merges once approved, green, and every "after" PR is verified in production. manual: the author merges.
after: <PR url>        # zero or more lines. This PR waits until each one is merged AND verified in production.
deploy: <how this reaches production, and how to tell it is live (Kargo stage, ArgoCD app, image tag)>
intent: <one sentence: what a user or system should see happen in production if this works (the prod scouts check it on real sessions)>
verify:
- <a concrete check: the query or command, where to run it ((Grafana, PostHog, ...)), and what passing looks like against the pre-merge baseline>
-->`

const FIRST = (url: string, head: string) => `You are the shepherd for ${url}. auto-m8 starts you whenever something on this PR needs an answer, so handle the events below, then stop. You will be woken again for the next ones, and later to merge it and verify it in production.

You are in a dedicated worktree of the PR branch (${head}), detached at origin/${head}. Before you change anything, \`git fetch origin ${head}\` and check out \`origin/${head}\` so you work on the latest head. Push with \`git push origin HEAD:${head}\`. Never force-push over someone else's commits.

How to handle events: load the pr-shepherd skill (use_skill) and run one iteration of it focused on the events: review-triage for threads and comments, ci-shepherd for red checks, its Step 4 for stamphog. Skip qa-swarm and simplify unless your own fixes in this run changed behaviour substantively.

The plan: auto-m8 reads a <!-- perch-plan --> block in the PR description to know whether to merge it, what it waits for, and how to verify it in production. If the description has none, add one (edit the description with \`gh pr edit --body-file\`, keeping everything else). Read the diff and the description to fill it in:
${PLAN_FORMAT}
Use merge: manual when you add it yourself; the author switches it to auto. Make every verify check something you could run later with the Grafana or PostHog MCPs, with what passing looks like.

Rules:
- auto-m8 knows what you post during a run, so your own replies never wake you. Post comments as plain text.
- Never mark a draft ready, and never merge or add to the merge queue in a review run. auto-m8 tells you when to merge.
- Fix what a reviewer or CI shows is wrong. When you disagree, reply with the reason. When a decision belongs to the author (scope, design, a disputed review), don't act: say so in your last message on a line starting "NEEDS YOU:".
- Visual Review (PostHog storybook snapshots): when the changed or new snapshots are what this PR or the master it picked up should produce, approve them and finalize the run yourself with the auto-m8 browser on the run page linked from the \`PostHog Visual Review / storybook\` check. Finalizing only writes baselines for this branch and is redone on the next head, so it is not a decision for the author. Raise NEEDS YOU only for a snapshot that looks like a real regression, and say which one.
- Finish with a few lines: what you did per event, and the PR's state (CI, threads, stamphog verdict).`

const LATER = (events: string[]) => `New on this PR since your last run:\n${events.map(e => `- ${e}`).join('\n')}\nHandle them as before, then stop.`

const MERGE = (url: string, head: string, plan: Plan) => `Time to merge ${url}. auto-m8 checked: approved, CI green on ${head.slice(0, 12)}, no open review threads, the plan says merge: auto${plan.after.length ? `, and every PR it waits on is verified in production (${plan.after.join(', ')})` : ''}.

1. Re-check on the current head with \`gh pr view ${url} --json headRefOid,reviewDecision,statusCheckRollup,mergeStateStatus\`. If the head moved or anything is no longer true, don't merge; say what changed.
2. If the repo merges through Trunk (a trunk-io[bot] comment on the PR), comment exactly \`/trunk merge\` on the PR, with nothing else in the comment: Trunk rejects any extra text. Then read Trunk's reply on the PR: "Submitted to Merge" means queued. Otherwise run \`gh pr merge ${url} --squash\`.
3. Reply with one line: MERGE QUEUED, MERGED, or NOT MERGED: <reason>.
auto-m8 then follows it to production and starts your verify run once it has merged.`

const VERIFY = (url: string, round: number, mergedAt: number, sha: string | null, plan: Plan | null) => `${url} merged at ${new Date(mergedAt).toISOString()}${sha ? ` as ${sha.slice(0, 12)}` : ''}. This is production check ${round} of 2: round 1 once it is deployed, round 2 two hours after the merge.

The plan from the PR description:
${plan ? plan.raw : '(none: work out from the diff how it deploys and what would show it working or broken, and say so)'}

1. Confirm it is live in production (the plan's deploy line: the deploy stage, ArgoCD app or image that carries ${sha ? sha.slice(0, 12) : 'the merge commit'}). Check what production runs now, not that it ran once: when another repo pins a version (a release tag bumped in a deploy or infra repo), confirm the pinned version contains the commit, e.g. \`gh api repos/<org>/<repo>/compare/<pinned tag>...<merge sha> -q .status\` is "behind" or "identical". For an ArgoCD app, read it directly (read-only, already logged in over Tailscale): \`argocd app list -o name | grep <service>\` to find it, then \`argocd app get argocd/<app> -o json\` for sync/health status, the live images (.status.summary.images) and the synced revision, and \`argocd app history argocd/<app>\` for when it last synced; if the CLI says the token expired, say so in your reply instead of guessing. If it is not live yet, reply with a line "NOT DEPLOYED: <where it is>" and stop; auto-m8 checks again in 15 minutes.
2. Run every verify check twice: over a window before the merge (the baseline) and since the deploy. Use whichever observability MCPs you have (Grafana, PostHog, Datadog…).
3. If every check ran and held, post a PR comment with a table (check, baseline, now), and reply with a line "VERIFIED". No signal is not a pass: a check that couldn't be judged (zero traffic or usage, e.g. a flag-gated page nobody opened yet; no data in the window; a tool or the browser unavailable) has not passed, even if nothing looks wrong. If any check had no signal and none regressed or failed, post the same table marking those checks "no signal" and why, and reply with a line "NO SIGNAL: <the checks without signal>" instead of VERIFIED. auto-m8 runs this round again later to retry them. Never write VERIFIED or result=pass while a check lacks signal.
4. If a check regressed, open a revert PR (\`git revert\` the merge commit on a new branch from the default branch; in its description say which check failed and include a perch-plan with merge: manual). Post the evidence as a PR comment. Reply with a line "REGRESSION: <check> — revert PR <url>" and a line "NEEDS YOU: <what to decide>". Never merge the revert yourself.
5. If a check isn't met but nothing got worse than the baseline (a revert would bring nothing back, or would undo what the PR did fix), don't open a revert. Name the follow-up PR that owns the rest (open it if none exists), post the evidence as a PR comment, and reply with a line "NOT MET: <check> — no regression; follow-up <PR url>". auto-m8 stops verifying this PR and follows the follow-up instead. Never write REGRESSION just to end the checks.
6. End the evidence comment from step 3, 4 or 5 with the line \`<!-- perch-check round=${round} result=pass -->\` only when every check ran and passed; \`result=no-signal checks="<the checks without signal>"\` for a NO SIGNAL reply, \`result=regression\` for step 4, \`result=not-met\` for step 5 (a check that ran and failed, not one without signal). The production proof scorecard on the PR reads it.${round === 1 ? `
7. Works check, only when the diff changes something a user sees in the web app (frontend/, a page or API response the UI shows) and the plan has an \`intent:\` line or the PR body makes the intended behaviour clear: open the changed page in production with the auto-m8 browser tool (your own window, logged in as ${ownerName()}), do the core flow once, and check the intended behaviour happens and nothing looks broken or slow. Use a project without customer data. Post a short PR comment: what you did, what you saw (a screenshot only if it shows no customer data), and the line \`<!-- perch-browser-check result=pass -->\` or \`result=concern\`. A concern is reported, not reverted: add a line "NEEDS YOU: <what looked wrong>". Skip this step for backend-only or infra changes.` : ''}`

const running = new Set<string>()

// Your GitHub login: the shepherd posts as you.
let me: string | null = null
const login = async () => (me ??= (await ghExec(['api', 'user', '--jq', '.login'])).stdout.trim())

const windows = (w: any): [number, number][] => {
  try { return (JSON.parse(w.own_windows ?? '[]') as [number, number | null][]).map(([a, b]) => [a, b ?? Infinity]) } catch { return [] }
}
// A run is starting: open a window. Ten are kept, older comments are behind the watermarks anyway.
function openWindow(url: string, w: any) {
  const list = JSON.parse(w.own_windows ?? '[]').slice(-9)
  list.push([Date.now(), null])
  run('update shepherd_watch set own_windows = ? where url = ?', JSON.stringify(list), url)
}
// The run finished: close its window.
function closeWindow(url: string, w: any, isRunning: (id: string) => boolean) {
  const list = JSON.parse(w.own_windows ?? '[]')
  const last = list.at(-1)
  if (!last || last[1] !== null || (w.conversation_id && isRunning(w.conversation_id))) return
  last[1] = Date.now()
  run('update shepherd_watch set own_windows = ? where url = ?', JSON.stringify(list), url)
  w.own_windows = JSON.stringify(list)
}

// The stage of each PR this plan waits on. Prerequisites nobody watches yet are watched from now.
function depStagesOf(plan: Plan | null) {
  const out: Record<string, string | null> = {}
  for (const dep of plan?.after ?? []) {
    const row = get<any>('select stage, outcome from shepherd_watch where url = ?', dep)
    if (!row) watch(dep, 'manual')
    out[dep] = row?.stage === 'deploying' && String(row.outcome ?? '').startsWith(NO_SIGNAL_MARK) ? 'live' : row?.stage ?? null
  }
  return out
}

// Post when our record says otherwise, or when GitHub shows something else. On 2026-11-17 two pending
// statuses landed on #135741 from outside this server's record (it still said success), and since the
// record matched, perch never corrected them: the PR sat blocked behind a verified prerequisite.
export function planNeedsPost(recorded: string | null | undefined, pr: Pick<Snapshot, 'head' | 'planState'>, state: string) {
  return recorded !== `${pr.head}:${state}` || (pr.planState !== undefined && pr.planState !== state)
}

// Prerequisites as a check on the PR, not a sentence in its description: a perch/plan status that
// is pending until every "after" PR passed a production check. When they have, one comment says
// what is live (revision, when, what was checked): the evidence a reviewer or stamphog asks for.
async function planCheck(url: string, w: any, pr: Snapshot) {
  const plan = parsePlan(pr.body)
  // Projects draw their graph from these edges.
  const after = JSON.stringify(plan?.after ?? [])
  if (w.after_urls !== after) { run('update shepherd_watch set after_urls = ? where url = ?', after, url); w.after_urls = after }
  if (!plan?.after.length) return
  const stages = depStagesOf(plan)
  const waiting = waitingOn(plan, stages)
  const state = waiting.length ? 'pending' : 'success'
  const p = parse(url)
  if (planNeedsPost(w.plan_status, pr, state)) {
    const description = waiting.length
      ? `Waiting for ${waiting.map(u => `#${u.split('/').pop()}`).join(', ')} to be live and checked in production`
      : 'Prerequisites are live and passed their production checks'
    await ghExec(['api', '-X', 'POST', `repos/${p.slug}/statuses/${pr.head}`, '-f', `state=${state}`, '-f', 'context=perch/plan', '-f', `description=${description.slice(0, 140)}`, '--silent'])
    stale.add(url)
    run('update shepherd_watch set plan_status = ? where url = ?', `${pr.head}:${state}`, url)
  }
  if (state === 'success' && !w.receipt_at) {
    const lines = plan.after.map(u => {
      const d = get<any>('select merged_at, merge_sha, stage, outcome from shepherd_watch where url = ?', u)
      return `- ${u}: merged ${d?.merged_at ? new Date(d.merged_at).toISOString().replace(/\.\d+Z$/, 'Z') : '?'}${d?.merge_sha ? ` as \`${String(d.merge_sha).slice(0, 12)}\`` : ''}, live in production, ${d?.stage === 'verified' ? 'both production checks passed' : 'first production check passed (the two-hour check is still to come)'}.`
    })
    const body = `Prerequisites for this PR are live in production:\n${lines.join('\n')}\n\nThe check results are in each PR's comments.\n\n${signature({ PERCH_AGENT: 'auto-m8 shepherd', PERCH_CONVERSATION_ID: w.conversation_id ?? undefined })}`
    const { stdout } = await ghExec(['api', '-X', 'POST', `repos/${p.slug}/issues/${p.number}/comments`, '-f', `body=${body}`, '--jq', '.id'])
    stale.add(url)
    run('update shepherd_watch set receipt_at = ?, seen_comment = max(seen_comment, ?) where url = ?', Date.now(), Number(stdout.trim()) || 0, url)
  }
}

// The last thing a conversation said, read from its transcript (survives a perch restart).
function lastReply(id: string, since: number) {
  const c = get<any>('select path, updated_at from conversations where id = ?', id)
  if (!c?.path || !existsSync(c.path) || c.updated_at < since) return null
  try {
    const last = itemsOf(c.path).at(-1)
    if (!last || last.kind !== 'assistant') return null
    return last.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
  } catch { return null }
}

// Your open PRs that an agent wrote, opened after auto mode was switched on. Each PR is looked at
// once: agent PRs are watched, the rest are remembered as not-agent so they aren't fetched again.
async function enroll() {
  if (!settings.shepherd.auto || !autonomyOn()) return
  const fresh = all<any>(`select url from prs where authored = 1 and state = 'OPEN'
    and not exists (select 1 from shepherd_watch w where w.url = prs.url)`).map(r => r.url)
  for (let i = 0; i < fresh.length; i += 20) {
    const batch = fresh.slice(i, i + 20)
    const { prs } = await prBatch(batch, 'createdAt body', { size: 20 })
    for (const [url, p] of prs) {
      if (Date.parse(p.createdAt) > settings.shepherd.autoSince && AGENT_PR.test(p.body ?? '')) watch(url, 'auto')
      else run(`insert or ignore into shepherd_watch (url, enabled, source, created_at) values (?, 0, 'not-agent', ?)`, url, Date.now())
    }
  }
}

// One shepherd conversation per PR, started in its worktree or resumed. If it can't start (the
// worktree fetch failed, the repo isn't cloned), the run it claimed is given back: a run that never
// happened must not count toward the daily cap, or the PR is paused having done nothing.
async function converse(url: string, w: any, prompt: (first: string | null) => string) {
  try { return await startOrResume(url, w, prompt) }
  catch (e) {
    run(`update shepherd_watch set runs = max(0, runs - 1) where url = ?`, url)
    const list = JSON.parse(get<any>('select own_windows from shepherd_watch where url = ?', url)?.own_windows ?? '[]')
    if (list.at(-1)?.[1] === null) { list.pop(); run('update shepherd_watch set own_windows = ? where url = ?', JSON.stringify(list), url) }
    throw e
  }
}

async function startOrResume(url: string, w: any, prompt: (first: string | null) => string) {
  const p = parse(url)
  if (w.conversation_id) {
    // The hourly worktree sweep may have removed an idle checkout: make it again before resuming,
    // or the chat would start in the default folder instead of the PR branch.
    const cwd = get<{ cwd: string }>('select cwd from conversations where id = ?', w.conversation_id)?.cwd
    if (cwd?.includes('/.perch-worktrees/') && !existsSync(cwd)) await prWorktree(url)
    send({ id: w.conversation_id, prompt: prompt(null), resume: true }); return w.conversation_id
  }
  const { dir, head } = await prWorktree(url)
  const id = randomUUID()
  send({ by: 'shepherd', id, originParent: prSubject(url), cwd: dir, prompt: prompt(FIRST(url, head)), context: true, resume: false })
  setTitle(id, `Shepherd: ${p.repo}#${p.number}`)
  editLabels([id], ['shepherd'])
  for (const c of all<any>('select conversation_id from conversation_prs where url = ? and conversation_id != ?', url, id)) link(id, c.conversation_id, 'related', `shepherd of #${p.number}`)
  return id
}

// Can a run start on this PR now? Counts it against the daily cap when it can.
// Only a rival that is working right now blocks a run. activeShepherds also lists finished
// workflow tasks from the last day and the post-merge prod scouts ("Prod scout evidence: ...");
// counting those left merged PRs on "waiting for the deploy" for days, because each scout run
// renewed the window and the verify run never started.
export function rivalShepherds(url: string, own: string | null) {
  return activeShepherds(url).filter((s: any) => s.id !== own
    && !/^prod scout evidence/i.test(s.title ?? '')
    && (s.status === 'running now' || s.status === 'queued' || Date.now() - s.updated_at < 30 * MIN))
}

function claim(url: string, w: any, isRunning: (id: string) => boolean) {
  const today = new Date().toISOString().slice(0, 10)
  const runs = w.runs_day === today ? w.runs : 0
  if (runs >= settings.shepherd.maxRunsPerDay) {
    run(`update shepherd_watch set paused_reason = ?, paused_at = ? where url = ?`, `hit ${settings.shepherd.maxRunsPerDay} runs today`, Date.now(), url)
    return false
  }
  // Another shepherd (a Push through, a loop) is already on it: don't race it.
  if (rivalShepherds(url, w.conversation_id).length) return false
  if (w.conversation_id && isRunning(w.conversation_id)) return false
  run(`update shepherd_watch set runs = ?, runs_day = ?, last_run_at = ? where url = ?`, runs + 1, today, Date.now(), url)
  openWindow(url, w)
  return true
}

async function review(url: string, w: any, pr: Snapshot, isRunning: (id: string) => boolean) {
  const d = detect(pr, w, await hasStamphog(parse(url).slug), { me: await login(), windows: windows(w) })
  if (!d.events.length) { if (w.pending) run('update shepherd_watch set pending = null, pending_since = null where url = ?', url); return false }
  // Let a burst land (bots post several comments in a row) before starting one run for all of it.
  if (!w.pending_since) { run('update shepherd_watch set pending = ?, pending_since = ? where url = ?', d.events.join('\n'), Date.now(), url); return true }
  if (Date.now() - w.pending_since < settings.shepherd.quietSeconds * 1000) { run('update shepherd_watch set pending = ? where url = ?', d.events.join('\n'), url); return true }
  if (!claim(url, w, isRunning)) return true
  const id = await converse(url, w, first => first ? `${first}\n\nEvents now:\n${d.events.map(e => `- ${e}`).join('\n')}` : LATER(d.events))
  run(`update shepherd_watch set conversation_id = ?, pending = null, pending_since = null, seen_comment = ?, seen_thread = ?, seen_review = ?,
       handled_ci = coalesce(?, handled_ci), handled_stamp = coalesce(?, handled_stamp) where url = ?`,
    id, d.seen.comment, d.seen.thread, d.seen.review, d.ci, d.stamp, url)
  return true
}

async function maybeMerge(url: string, w: any, pr: Snapshot, isRunning: (id: string) => boolean) {
  const plan = parsePlan(pr.body)
  const depStages = depStagesOf(plan)
  const blocker = mergeBlocker(pr, plan, depStages, w.handled_merge)
  run('update shepherd_watch set outcome = ? where url = ?', blocker ? `not merging: ${blocker}` : 'merging', url)
  if (blocker || !claim(url, w, isRunning)) return
  const id = await converse(url, w, first => first ? `${first}\n\n${MERGE(url, pr.head, plan!)}` : MERGE(url, pr.head, plan!))
  run('update shepherd_watch set conversation_id = ?, handled_merge = ? where url = ?', id, pr.head, url)
}

// After the merge: wait for the deploy, verify right away and two hours after the merge.
async function production(url: string, w: any, pr: Snapshot, isRunning: (id: string) => boolean) {
  if (w.stage === 'verified' || w.stage === 'failed' || w.stage === 'handed-off') return
  const mergedAt = pr.mergedAt ?? Date.now()
  if (!w.stage || w.stage === 'open') {
    run(`update shepherd_watch set stage = 'deploying', merged_at = ?, merge_sha = ?, verify_round = 1, verify_due_at = ?, outcome = 'merged; waiting for the deploy' where url = ?`,
      mergedAt, pr.mergeSha, Date.now(), url)
    w = get<any>('select * from shepherd_watch where url = ?', url)
  }
  // Read the answer of the verify run that is out.
  if (w.awaiting) {
    if (w.conversation_id && isRunning(w.conversation_id)) return
    const text = lastReply(w.conversation_id, w.awaiting_since)
    if (text === null && Date.now() - w.awaiting_since < 60 * MIN) return // transcript not indexed yet
    const o = verifyOutcome(text ?? '')
    const round = Number(String(w.awaiting).split(':')[1] ?? 1)
    if (o.kind === 'verified') { resolveKey(`gate:${url}`, 'it reached production'); resolveKey(`unverified:${url}`, 'verified') }
    if (o.kind === 'verified' && round >= 2) run(`update shepherd_watch set stage = 'verified', awaiting = null, enabled = 0, outcome = ? where url = ?`, `verified in production (2 checks)`, url)
    else if (o.kind === 'verified') run(`update shepherd_watch set stage = 'verifying', awaiting = null, verify_round = 2, verify_attempts = 0, verify_due_at = ?, outcome = ? where url = ?`,
      Math.max(Date.now(), (w.merged_at ?? mergedAt) + 120 * MIN), 'check 1 passed; check 2 two hours after the merge', url)
    else if (o.kind === 'not-met') {
      resolveKey(`gate:${url}`, 'it reached production'); resolveKey(`unverified:${url}`, 'a follow-up PR owns the unmet check')
      run(`update shepherd_watch set stage = 'handed-off', awaiting = null, enabled = 0, follow_up = ?, outcome = ? where url = ?`,
        o.followUp ?? null, `${o.followUp ? `follow-up ${o.followUp} owns it` : 'no follow-up named'}: ${o.detail}`.slice(0, 400), url)
      if (o.followUp && !get('select 1 from shepherd_watch where url = ?', o.followUp)) watch(o.followUp, 'manual')
    }
    else if (o.kind === 'regression') {
      run(`update shepherd_watch set stage = 'failed', awaiting = null, enabled = 0, outcome = ? where url = ?`, o.detail, url)
      const p = parse(url)
      raise({ reopen: true, key: `regression:${url}`, source: 'shepherd', url, title: `${p.repo}#${p.number} regressed in production: merge the revert?`, context: o.detail, options: ['Merge the revert', 'It is fine, keep it', 'Look into it first'], recommendation: 'Look into it first' })
    }
    // A no-signal answer means it is live and waiting for data (a 24h or 7-day window), so the same
    // answer repeating is expected, not a blocker that needs a person.
    else if (isHumanGate(o.detail) || (o.kind !== 'no-signal' && o.detail && o.detail === w.last_detail && (w.verify_attempts ?? 0) >= 4)) {
      // One only a person can clear, or the same blocker for an hour: stop spending runs and ask once.
      // The watch stays off until you answer ("I cleared it" turns it back on).
      const p = parse(url)
      raise({ reopen: true,
        key: `gate:${url}`, source: 'shepherd', url,
        title: `${p.repo}#${p.number} is merged but can't reach production on its own`,
        context: o.detail,
        options: ['I cleared it', 'Ask the approver for me (draft it)', 'Leave it'],
        recommendation: 'Ask the approver for me (draft it)', stakes: 'low',
      })
      run(`update shepherd_watch set stage = 'blocked', enabled = 0, awaiting = null, outcome = ?, last_detail = ?, revive_at = ? where url = ?`, `waiting on a person: ${o.detail}`.slice(0, 400), o.detail, Date.now() + reviveBackoff(w.revives ?? 0), url)
      return
    }
    else if (o.kind === 'no-signal') {
      // Live, but its usage window hasn't filled. Look again when the window it names closes, not every
      // hour, and never count it toward the give-up limit: waiting a week for data is not a failure.
      run(`update shepherd_watch set awaiting = null, verify_due_at = ?, outcome = ?, last_detail = ? where url = ?`,
        noSignalRecheckAt(o.detail, Date.now()), `${NO_SIGNAL_MARK}${o.detail || 'waiting for usage data'}`, o.detail || null, url)
    }
    else {
      // Not deployed yet, or no clear answer: look again in 15 minutes, for up to about two hours.
      const attempts = (w.verify_attempts ?? 0) + 1
      if (attempts > 8) {
        run(`update shepherd_watch set stage = 'failed', awaiting = null, enabled = 0, outcome = ?, revive_at = ? where url = ?`, `NEEDS YOU: no verification after ${attempts} tries (${o.detail})`, Date.now() + reviveBackoff(w.revives ?? 0), url)
        const p = parse(url)
        raise({ reopen: true, key: `unverified:${url}`, source: 'shepherd', url, title: `${p.repo}#${p.number} merged but auto-m8 couldn't verify it in production`, context: o.detail || 'the verify runs gave no clear answer', options: ['Verify it again', 'Mark it verified', 'Leave it'], recommendation: 'Verify it again', stakes: 'low' })
      }
      // No signal (e.g. zero traffic on a flag-gated page) needs time for usage, not another 15-minute poke.
      else run(`update shepherd_watch set awaiting = null, verify_attempts = ?, verify_due_at = ?, outcome = ?, last_detail = ? where url = ?`, attempts, Date.now() + 15 * MIN, o.detail || 'retrying', o.detail || null, url)
    }
    return
  }
  if (Date.now() < (w.verify_due_at ?? 0) || !claim(url, w, isRunning)) return
  const round = w.verify_round || 1
  const prompt = VERIFY(url, round, w.merged_at ?? mergedAt, w.merge_sha ?? pr.mergeSha, parsePlan(pr.body))
  const id = await converse(url, w, first => first ? `${first}\n\n${prompt}` : prompt)
  run('update shepherd_watch set conversation_id = ?, awaiting = ?, awaiting_since = ? where url = ?', id, `verify:${round}`, Date.now(), url)
}

// A finished run that ended on "NEEDS YOU: ..." lines: each becomes a decision for you, in the
// conversation that opened the PR. Read once per run.
function collectNeeds(w: any, isRunning: (id: string) => boolean) {
  if (w.awaiting || (w.stage && w.stage !== 'open') || !w.conversation_id || isRunning(w.conversation_id) || !w.last_run_at || (w.needs_read_at ?? 0) >= w.last_run_at) return
  const text = lastReply(w.conversation_id, w.last_run_at)
  if (text === null) return
  run('update shepherd_watch set needs_read_at = ? where url = ?', Date.now(), w.url)
  const p = parse(w.url)
  const needs = needsYou(text)
  if (!needs.length) { resolveNeeds(w.url, 'the next shepherd run had nothing for you'); return }
  // One decision per PR, refreshed with the latest run's ask.
  raise({ reopen: true, key: `needs:${w.url}`, source: 'shepherd', url: w.url, title: `${p.repo}#${p.number}: ${needs.join('; ')}`.slice(0, 300), context: text.split('\n').slice(-12).join('\n').slice(0, 1500), options: [], stakes: 'low' })
}
const resolveNeeds = (url: string, why: string) => resolveKey(`needs:${url}`, why)

async function draftTick(url: string, pr: Snapshot) {
  const call = stalledDraft(pr)
  if (!call || call.kind === 'held') return
  const p = parse(url)
  if (call.kind === 'needs') {
    // Raised once: raise() keeps an answered decision closed unless reopen is set.
    raise({ key: `draft:${url}`, source: 'shepherd', url, title: `${p.repo}#${p.number} is a finished draft the shepherd can't act on`, context: `${call.reason}. Add a perch-plan to the description and mark it ready, or close it.`, options: ['I added a plan', 'Leave it'], stakes: 'low' })
    return
  }
  await ghExec(['pr', 'ready', String(p.number), '-R', p.slug])
  stale.add(url)
  resolveKey(`draft:${url}`, 'marked ready')
  run('update shepherd_watch set outcome = ? where url = ?', `marked ready: ${call.reason}`, url)
}

async function tickOne(w: any, pr: Snapshot, isRunning: (id: string) => boolean) {
  closeWindow(w.url, w, isRunning)
  collectNeeds(w, isRunning)
  if (pr.state === 'CLOSED' || pr.state === 'MERGED') resolveNeeds(w.url, pr.state === 'CLOSED' ? 'closed' : 'merged')
  if (pr.state === 'CLOSED') { resolveKey(`gate:${w.url}`, 'closed'); run(`update shepherd_watch set enabled = 0, stage = 'closed', paused_reason = 'closed' where url = ?`, w.url); return }
  if (pr.state === 'MERGED') { await production(w.url, w, pr, isRunning); return }
  if (pr.isDraft) { await draftTick(w.url, pr); return }
  try { await planCheck(w.url, w, pr) } catch (e: any) { recordError('PR shepherd', e, `Setting the perch/plan check on ${w.url}`) }
  // Review work comes first; merging waits until nothing is pending.
  if (await review(w.url, w, pr, isRunning)) return
  await maybeMerge(w.url, w, pr, isRunning)
}

// Every tick used to re-read every watched PR in full (comments, reviews, threads, all checks):
// about 2,300 GraphQL calls an hour for ~75 PRs, half of GitHub's budget, when most of those PRs
// hadn't changed. Now a tick first asks GitHub for a small fingerprint of each PR (one cheap call
// per 50 PRs) and re-reads in full only the PRs whose fingerprint moved, that
// the shepherd itself just wrote to, or whose last full read is older than FULL_READ_MS (RUNNING_READ_MS
// while CI runs).
const FULL_READ_MS = 15 * 60_000
const RUNNING_READ_MS = 5 * 60_000
const FINGERPRINT = `updatedAt state isDraft headRefOid reviewDecision mergedAt
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 1) { totalCount } } } } }`
const lastRead = new Map<string, { at: number; fp: string; snap: Snapshot }>()
const stale = new Set<string>() // the shepherd wrote to these PRs (status, comment, ready): read them again
export const resetSnapshotCache = () => { lastRead.clear(); stale.clear() }
export const fingerprintOf = (p: any) => {
  const r = p?.commits?.nodes?.[0]?.commit?.statusCheckRollup
  return [p?.updatedAt, p?.state, p?.isDraft, p?.headRefOid, p?.reviewDecision, p?.mergedAt, r?.state ?? '', r?.contexts?.totalCount ?? ''].join('|')
}
export async function changedSnapshots(urls: string[], now = Date.now()): Promise<Map<string, Snapshot>> {
  const fps = new Map<string, string>()
  if (lastRead.size) {
    const { prs } = await prBatch(urls.filter(u => lastRead.has(u)), FINGERPRINT, { size: 50, timeout: 30_000 })
    for (const [u, p] of prs) fps.set(u, fingerprintOf(p))
  }
  // Spread the periodic full reads over the window instead of re-reading every PR on the same tick.
  const jitter = (u: string) => [...u].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % (5 * 60_000)
  const need = urls.filter(u => {
    const c = lastRead.get(u)
    // Running CI: a new failure flips the rollup to FAILURE and new jobs move the count (both in the
    // fingerprint), so a running PR needs a full read only every few minutes on top of those.
    const running = c?.snap.rollup === 'PENDING' || c?.snap.rollup === 'EXPECTED'
    return !c || stale.has(u) || !fps.has(u) || fps.get(u) !== c.fp || now - c.at > (running ? RUNNING_READ_MS : FULL_READ_MS + jitter(u))
  })
  const fresh = need.length ? await snapshots(need) : new Map<string, Snapshot>()
  const out = new Map<string, Snapshot>()
  for (const u of urls) {
    const f = fresh.get(u)
    if (f) { lastRead.set(u, { at: now, fp: f.fingerprint ?? fps.get(u) ?? '', snap: f }); stale.delete(u); out.set(u, f) }
    else if (!need.includes(u)) out.set(u, lastRead.get(u)!.snap)
  }
  for (const u of lastRead.keys()) if (!urls.includes(u)) lastRead.delete(u)
  return out
}

export async function tickShepherd(isRunning: (id: string) => boolean) {
  if (running.has('tick') || isPaused()) return
  running.add('tick')
  try {
    if (ghOffline()) return // GitHub unreachable: gh.ts is backing off, the next tick after it retries
    await enroll()
    revive()
    const rows = all<any>(`select * from shepherd_watch where enabled = 1 and paused_reason is null`)
    if (!rows.length) return
    const snaps = await changedSnapshots(rows.map(r => r.url))
    for (const w of rows) {
      const pr = snaps.get(w.url)
      if (!pr) continue
      // One PR that can't be worked on must not stop the PRs after it.
      try { await tickOne(w, pr, isRunning); run('update shepherd_watch set start_failures = 0 where url = ? and start_failures > 0', w.url) }
      catch (e: any) {
        const n = (w.start_failures ?? 0) + 1
        run('update shepherd_watch set start_failures = ? where url = ?', n, w.url)
        if (n >= 3) run('update shepherd_watch set paused_reason = ?, paused_at = ? where url = ?', `couldn't start a run 3 times: ${String(e?.message ?? e).split('\n')[0].slice(0, 200)}`, Date.now(), w.url)
        recordError('PR shepherd', e, `Working on ${w.url}`)
      }
    }
    resolveErrors('PR shepherd')
  } catch (e: any) {
    // GitHub went unreachable after the check above (during enroll, or another module's call): the
    // call that found out already reported it and gh.ts backs off, so a skipped call is not a new error.
    if (isGhSkippedOffline(e) && ghOffline()) return
    recordError('PR shepherd', e, 'Watching PRs for comments, CI, merges and production checks')
  } finally { running.delete('tick') }
}

// PRs the shepherd gave up on before decisions existed: each gets its decision once.
export function backfillDecisions() {
  for (const w of all<any>(`select url, outcome from shepherd_watch where stage = 'failed' and outcome like 'NEEDS YOU%'`)) {
    if (!URL.canParse(w.url)) continue // not a PR URL (test fixtures once leaked in as r/stopped); it ran in a timer, so it threw uncaught
    const p = parse(w.url)
    if (isHumanGate(w.outcome)) raise({ key: `gate:${w.url}`, source: 'shepherd', url: w.url, title: `${p.repo}#${p.number} is merged but can't reach production on its own`, context: w.outcome, options: ['I cleared it', 'Ask the approver for me (draft it)', 'Leave it'], recommendation: 'Ask the approver for me (draft it)', stakes: 'low' })
    else raise({ key: `unverified:${w.url}`, source: 'shepherd', url: w.url, title: `${p.repo}#${p.number} merged but auto-m8 couldn't verify it in production`, context: w.outcome, options: ['Verify it again', 'Mark it verified', 'Leave it'], recommendation: 'Verify it again', stakes: 'low' })
  }
}

export function startShepherd(isRunning: (id: string) => boolean) {
  setTimeout(backfillDecisions, 15_000).unref()
  // Auto mode covers PRs opened from the moment it first runs, not every PR an agent ever opened.
  if (!settings.shepherd.autoSince) updateSettings({ shepherd: { ...settings.shepherd, autoSince: Date.now() } })
  const loop = () => { tickShepherd(isRunning).finally(() => setTimeout(loop, settings.shepherd.pollSeconds * 1000).unref()) }
  setTimeout(loop, 10_000).unref()
}
