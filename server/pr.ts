// What to do about a PR that is slipping or stalled, from the Home page.
// - Not today / a week: snooze it out of Pick up, Slipping and the stacks until then.
// - Push it through: a shepherd that drives it to merge (review threads, CI, approval, Trunk's
//   merge queue). Cloud by default so it keeps going while the laptop sleeps. Never a second
//   shepherd on a PR that already has one running.
// - Deep audit & apply: for PRs stuck on pushback. A chat in its own worktree of the PR branch
//   gathers every review thread and CI failure, audits the design with the ddia-swarm skill,
//   applies the fixes, and asks before pushing.
import { presenceAll } from './presence.ts'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { send } from './chat.ts'
import { editLabels, setTitle } from './conversations.ts'
import { link } from './context.ts'
import { all, db, get, run } from './db.ts'
import { posthogFetch } from './indexer.ts'
import { localRepos } from './search.ts'
import { codeRoots, settings } from './settings.ts'
import { randomUUID } from 'node:crypto'
import { checkContextFields, checkContexts, summarizeChecks, ghExec, notePr, onPrChanged, prKey } from './gh.ts'
import { deployFor } from './deploys.ts'

const exec = promisify(execFile)
db.exec(`create table if not exists snoozes (key text primary key, until integer, reason text)`)

export const snoozed = () => new Set(all<any>('select key from snoozes where until > ?', Date.now()).map(r => r.key))
export function snooze(keys: string[], until: number, reason = '') {
  for (const k of keys) run('insert or replace into snoozes (key, until, reason) values (?, ?, ?)', k, until, reason)
}

const parse = (url: string) => {
  const m = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/)
  if (!m) throw new Error('That isn’t a GitHub pull request link.')
  return { owner: m[1], repo: m[2], number: Number(m[3]), slug: `${m[1]}/${m[2]}` }
}

// Conversations already driving this PR: an active or very recent shepherd run.
// A shepherd counts as active when a run is going now, or when a scheduled loop (workflow
// origin) ran on this PR in the last day: loop runs finish in minutes, so "running" alone misses them.
export function activeShepherds(url: string) {
  return all<any>(`select c.id, coalesce(u.title, c.title) title, c.status, c.updated_at, c.source, c.origin,
                     (select count(*) from conversation_prs x join conversations y on y.id = x.conversation_id where x.url = cp.url and y.origin = 'workflow' and y.started_at > ?) runs_today
                   from conversation_prs cp join conversations c on c.id = cp.conversation_id
                   left join user_state u on u.id = c.id
                   where cp.url = ? and coalesce(u.state, '') != 'hidden' and (
                     c.status in ('in_progress', 'queued')
                     or (c.origin = 'workflow' and c.updated_at > ?)
                     or (c.updated_at > ? and (lower(c.title) like '%shepherd%' or lower(c.title) like '%push through%' or lower(coalesce(u.title, '')) like '%push through%')))
                   order by c.updated_at desc limit 5`, Date.now() - 86400_000, url, Date.now() - 86400_000, Date.now() - 3 * 3600_000)
    .map(r => ({ ...r, status: r.status === 'in_progress' ? 'running now' : r.origin === 'workflow' ? `loop, ${r.runs_today} runs today, last ${Math.round((Date.now() - r.updated_at) / 60_000)}m ago` : r.status }))
}

const SHEPHERD = (url: string) => `Drive this pull request to merge: ${url}

Use the pr-shepherd skill (load it with use_skill if it isn't installed), and get-stamp for approval.
1. Read every open review thread and the failing CI checks.
2. Address each review thread: apply the change, or reply with the reason when you disagree. Resolve the threads you addressed.
3. Fix failing CI until checks are green.
4. Get it approved (stamphog where it qualifies, otherwise request the right reviewer).
5. Once approved and green, add it to the Trunk merge queue.
Don't force-push over other people's commits. Stop and report if a decision needs the author: a design change, a disputed review, or scope beyond the PR.`

export async function pushThrough(url: string, where: 'cloud' | 'here' = 'cloud', force = false) {
  const pr = parse(url)
  const existing = activeShepherds(url)
  if (existing.length && !force) return { existing, message: `#${pr.number} already has a shepherd working on it.` }
  if (where === 'cloud') {
    const t: any = await posthogFetch(`/api/projects/${settings.posthog.projectId}/tasks/`, { method: 'POST', body: JSON.stringify({ title: `Push through: ${pr.slug}#${pr.number}`, description: SHEPHERD(url), repository: pr.slug }) })
    return { taskId: t.id, url: `${settings.posthog.host}/project/${settings.posthog.projectId}/tasks/${t.id}`, message: `A cloud shepherd is pushing #${pr.number} through. It shows up in your list within a minute.`, runError: t.run_error }
  }
  const repo = localRepos().find(r => r.remote?.includes(`${pr.owner}/${pr.repo}`))
  const id = randomUUID()
  send({ by: 'shepherd', id, cwd: repo?.path ?? settings.chat.cwd, prompt: SHEPHERD(url), context: true, resume: false })
  setTitle(id, `Push through: ${pr.repo}#${pr.number}`)
  editLabels([id], ['shepherd'])
  return { conversationId: id, message: `Shepherding #${pr.number} here.` }
}

const AUDIT = (url: string, head: string) => `This PR is slipping: it got pushback and needs a thorough pass. ${url}
You are in a dedicated worktree of its branch (${head}); the user's own checkout is untouched.

1. Gather everything: \`gh pr view ${url} --comments\`, every review thread (unresolved first) with \`gh api graphql\`, and failing checks with \`gh pr checks ${url}\`.
2. Audit the design with the ddia-swarm skill (load it with use_skill): what the reviewers' concerns mean for correctness, data model, consistency and failure modes, grounded in the code.
3. Write a short plan: each concern marked BLOCKING or NIT, the fix, and which review thread it answers.
4. Apply the blocking fixes here, then the nits that are cheap. Run the relevant tests.
5. Summarise what changed per thread, then ASK before pushing. When the user agrees: \`git push origin HEAD:${head}\`, and reply on each thread with what changed.`

// A git fetch can fail for a moment (network, a ref or index lock held by another git run). Retry
// a few times, and put git's own stderr in the error: execFile's message is only "Command failed",
// which left the real cause invisible in the notice.
export async function retryGit<T>(fn: () => Promise<T>, o: { tries?: number; delays?: number[]; wait: (ms: number) => Promise<void> }): Promise<T> {
  const tries = o.tries ?? 3, delays = o.delays ?? [2000, 10_000]
  for (let i = 1; ; i++) {
    try { return await fn() } catch (e: any) {
      if (i >= tries) {
        const err = String(e?.stderr ?? '').trim()
        if (err) e.message = `${String(e.message).split('\n')[0]}: ${err.slice(0, 400)}`
        throw e
      }
      await o.wait(delays[Math.min(i - 1, delays.length - 1)])
    }
  }
}

// The checkout a PR worktree hangs off: the user's own clone when there is one, else perch's source
// cache (~/Library/Caches/perch/src/<owner>/<repo>, which localRepos() also scans), cloned on first
// use. Without the fallback a PR in a repo nobody cloned (a shepherd watching PostHog/sdk-specs)
// failed every tick, and the hourly revive of "couldn't start a run" retried it forever.
export const SRC_CACHE = join(homedir(), 'Library/Caches/perch/src')
export async function repoCheckout(owner: string, repo: string, o: {
  repos: { path: string; remote: string | null }[]; cache?: string; exists?: (p: string) => boolean
  clone: (slug: string, dir: string) => Promise<unknown>
}) {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const remoteIs = (r: string | null) => !!r && new RegExp(`[/:]${esc(owner)}/${esc(repo)}(\\.git)?/?$`, 'i').test(r)
  const own = o.repos.find(r => remoteIs(r.remote))
  if (own) return own.path
  const dir = join(o.cache ?? SRC_CACHE, owner, repo)
  if (!(o.exists ?? existsSync)(join(dir, '.git'))) { mkdirSync(dirname(dir), { recursive: true }); await o.clone(`${owner}/${repo}`, dir) }
  return dir
}

// A worktree of the PR branch, detached so it never fights a checkout of the same branch.
// Shared by the deep audit and the shepherd. Checking out a large repo takes minutes.
export async function prWorktree(url: string) {
  const pr = parse(url)
  // Blobless: full history and refs for the worktree, file contents fetched only when checked out.
  const repoPath = await repoCheckout(pr.owner, pr.repo, {
    repos: localRepos(),
    clone: (slug, dir) => ghExec(['repo', 'clone', slug, dir, '--', '--filter=blob:none', '--quiet'], { maxBuffer: 20e6, timeout: 600_000 }),
  })
  const repo = { path: repoPath }
  const head = get<any>('select head from prs where url = ?', url)?.head
    ?? JSON.parse((await ghExec(['pr', 'view', String(pr.number), '--repo', pr.slug, '--json', 'headRefName'])).stdout).headRefName
  const dir = join(dirname(repo.path), '.perch-worktrees', `${basename(repo.path)}-pr${pr.number}`)
  // Hooks off: a repo's post-checkout hook can fail on a fresh worktree with no node_modules.
  const git = (args: string[]) => exec('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo.path, maxBuffer: 20e6, timeout: 600_000 })
  // An explicit refspec: a clone with a narrowed fetch refspec (single-branch, sparse) never
  // creates origin/<head> from a bare `git fetch origin <head>`, and the worktree add then fails.
  // pull/<n>/head is the PR's own head, for same-repo and fork PRs alike; a branch name alone could
  // match a different branch on origin.
  const ref = `refs/perch/pr/${pr.number}`
  await retryGit(() => git(['fetch', 'origin', `+refs/pull/${pr.number}/head:${ref}`, '--quiet']), { wait: ms => new Promise(r => setTimeout(r, ms)) })
  if (!existsSync(dir)) { mkdirSync(dirname(dir), { recursive: true }); await git(['worktree', 'add', '--detach', dir, ref]) }
  else await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', dir, 'checkout', '--detach', ref, '--quiet'])
  return { dir, head }
}

export async function deepAudit(url: string) {
  const pr = parse(url)
  const { dir, head } = await prWorktree(url)
  const id = randomUUID()
  send({ by: 'audit', id, cwd: dir, prompt: AUDIT(url, head), context: true, resume: false })
  setTitle(id, `Deep audit: ${pr.repo}#${pr.number}`)
  editLabels([id], ['audit'])
  for (const c of all<any>('select conversation_id from conversation_prs where url = ?', url)) link(id, c.conversation_id, 'related', `audit of #${pr.number}`)
  return { conversationId: id, worktree: dir, message: `Auditing #${pr.number} in its own worktree.` }
}

// A PR at a glance, for the hover preview: what it says, what it touches, what's still open.
// Review threads that are unresolved but outdated (the code under them changed) are likely fixed.
// Review bots post HTML (severity badges, details blocks): keep the words, drop the markup.
const readable = (s: any) => String(s ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '$1').replace(/<\/?(a|details|summary|br|p|div|span|sub|sup)[^>]*>/gi, ' ').replace(/<[^>]+>/g, '').replace(/[ \t]+/g, ' ').trim()
const previewCache = new Map<string, { at: number; data: any }>()
// Stale-while-revalidate lives in the browser (it paints its last copy, then swaps in this answer).
// Here: answers younger than maxAge are reused, and concurrent views of one PR share one GitHub call.
const previewInflight = new Map<string, Promise<any>>()
// Another module saw the PR move: the next open of its preview reads GitHub (the card paints the old copy meanwhile).
onPrChanged.add((key, source) => { if (source !== 'pr') for (const u of previewCache.keys()) if (prKey(u) === key) previewCache.delete(u) })
export async function preview(url: string, maxAge = 300_000) {
  const hit = previewCache.get(url)
  if (hit && Date.now() - hit.at < maxAge) return withConversations(hit.data)
  let p = previewInflight.get(url)
  if (!p) { p = readPreview(url).finally(() => previewInflight.delete(url)); previewInflight.set(url, p) }
  // GitHub's budget spent or GitHub unreachable: the last preview beats an error card.
  try { return withConversations(await p) } catch (e) { if (hit) return withConversations(hit.data); throw e }
}
async function readPreview(url: string) {
  const pr = parse(url)
  const query = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){
    title body state isDraft mergedAt reviewDecision additions deletions changedFiles headRefName baseRefName updatedAt author{login}
    files(first:40){nodes{path additions deletions}}
    commits(last:1){nodes{commit{statusCheckRollup{id state contexts(first:100){${checkContextFields(pr.number)}}}}}}
    reviewThreads(first:60){nodes{isResolved isOutdated path line comments(first:2){nodes{author{login} body createdAt url}}}}
    reviews(last:20){nodes{author{login} state body submittedAt}}
    comments(last:30){nodes{author{login} body}}}}}`
  const { stdout } = await ghExec(['api', 'graphql', '-f', `query=${query}`, '-F', `o=${pr.owner}`, '-F', `r=${pr.repo}`, '-F', `n=${pr.number}`], { maxBuffer: 10e6, timeout: 20_000 })
  const p = JSON.parse(stdout).data.repository.pullRequest
  notePr(url, p)
  const rollup = p.commits.nodes[0]?.commit?.statusCheckRollup
  const contexts = await checkContexts(rollup, pr.number)
  const { failing } = summarizeChecks(rollup?.state, contexts)
  const threads = p.reviewThreads.nodes.filter((t: any) => !t.isResolved).map((t: any) => ({
    path: t.path, line: t.line, outdated: t.isOutdated, author: t.comments.nodes[0]?.author?.login, url: t.comments.nodes[0]?.url, body: readable(t.comments.nodes[0]?.body).slice(0, 400), replies: t.comments.nodes.length - 1,
  }))
  const data = {
    fetchedAt: Date.now(),
    url, title: p.title, state: p.state === 'OPEN' ? (p.isDraft ? 'draft' : 'open') : p.state.toLowerCase(), review: p.reviewDecision, author: p.author?.login,
    body: String(p.body ?? '').replace(/<!--[\s\S]*?-->/g, '').trim().slice(0, 4000), additions: p.additions, deletions: p.deletions, changedFiles: p.changedFiles,
    head: p.headRefName, base: p.baseRefName, updatedAt: p.updatedAt, files: p.files.nodes, checks: { state: p.commits.nodes[0]?.commit?.statusCheckRollup?.state ?? null, failing },
    // Merged: where it runs now (deploy bot's table, else the shepherd's stage).
    deploy: p.state === 'MERGED' ? deployFor(url, p.mergedAt ? Date.parse(p.mergedAt) : null, p.comments?.nodes ?? []) : null,
    open: threads.filter((t: any) => !t.outdated), outdated: threads.filter((t: any) => t.outdated).length,
    // Each reviewer's latest verdict; the pushback is often in a review summary, not a line comment.
    reviews: Object.values(Object.fromEntries((p.reviews.nodes as any[]).filter(r => r.state !== 'PENDING').map(r => [r.author?.login, r])))
      .filter((r: any) => r.state === 'CHANGES_REQUESTED' || (r.state === 'COMMENTED' && r.body?.trim()) || r.state === 'APPROVED')
      .map((r: any) => ({ author: r.author?.login, state: r.state, body: String(r.body ?? '').slice(0, 1500), at: r.submittedAt })),
  }
  previewCache.set(url, { at: data.fetchedAt, data })
  return data
}
// Conversations about this PR, from every source perch indexes; fresh each time (cheap, local).
function withConversations(data: any) {
  const url = data.url
  return { ...data, conversations: all<any>(`select c.id, coalesce(u.title, c.title, c.first_prompt) title, c.source, c.origin, c.status, c.updated_at
    from conversation_prs cp join conversations c on c.id = cp.conversation_id left join user_state u on u.id = c.id
    where cp.url = ? and coalesce(u.state, '') != 'hidden' order by c.updated_at desc limit 8`, url) }
}

// Who is working on each PR right now, for the badges: shepherd loops, agents making changes,
// reviews and audits. Only live work counts. A loop is live while it keeps its own rhythm
// (the gap between its last runs); once it misses two beats it drops off, so a badge never
// promises a worker that has stopped.
export type Worker = { kind: 'shepherd' | 'changes' | 'review'; label: string; conversation: string; last: number; next: number | null; running: boolean }
// Derived from presence (server/presence.ts), which reads each agent's own signal.
export function prWorkers(): Record<string, Worker[]> {
  const out: Record<string, Worker[]> = {}
  for (const [url, agents] of presenceAll()) {
    out[url] = agents.map(a => ({
      kind: a.key === 'shepherd' ? 'shepherd' : a.key === 'stamphog' || a.key === 'reviewhog' || a.key.startsWith('bot:') ? 'review' : 'changes',
      label: `${a.name}: ${a.status}`, conversation: a.conversation ?? '', last: a.since ?? 0, next: a.next, running: a.state === 'working',
    }))
  }
  return out
}

// Put an agent on a PR, from the PR view's right-click menu. Each uses the agent's own API:
// - StampHog: "review it now" (it refuses drafts, closed or bot PRs and says why; a pass posts an approval).
// - PostHog Review: a Deep or Standard review, or "fix threads" (resolve_only: works the open review
//   threads and may push fix commits, only when the PR's author opted in).
// - The shepherd goes through pushThrough, which won't start a second one.
export async function addAgent(url: string, agent: 'stamphog' | 'reviewhog', mode?: string) {
  const pr = parse(url)
  const base = `/api/projects/${settings.posthog.projectId}`
  try {
    if (agent === 'stamphog') {
      const r: any = await posthogFetch(`${base}/stamphog/review_runs/`, { method: 'POST', body: JSON.stringify({ repository: pr.slug, pr_number: pr.number }) })
      return { ok: true, message: r.created === false ? `StampHog already has a review of #${pr.number}'s latest commit (${r.status}).` : `StampHog is reviewing #${pr.number}. A pass posts an approval; anything else, a comment.` }
    }
    const run_mode = ['review', 'review_only', 'flash', 'resolve_only'].includes(String(mode)) ? mode : 'review_only'
    const r: any = await posthogFetch(`${base}/review_hog/reviews/trigger/`, { method: 'POST', body: JSON.stringify({ pr_url: url, run_mode }) })
    const what = run_mode === 'flash' ? 'a Standard review' : run_mode === 'resolve_only' ? 'fixing the open review threads' : 'a Deep review'
    return { ok: true, message: r.status === 'already_reviewed' ? `PostHog Review already reviewed #${pr.number}'s latest commit.` : r.status === 'joined_running_review' ? `PostHog Review is already reviewing #${pr.number}; your request joined it.` : `PostHog Review started ${what} of #${pr.number}.${r.resolve_will_run === false && run_mode === 'review' ? ` It won't fix threads: ${r.resolve_skip_reason ?? 'not opted in'}.` : ''}` }
  } catch (e: any) {
    // Their refusals are readable (draft, not connected, not opted in): pass them on.
    return { ok: false, message: String(e?.message ?? e).replace(/^.*?(\{.*\})?$/, (m, j) => { try { const o = JSON.parse(j); return o.detail ?? o.error ?? m } catch { return m } }).slice(0, 300) }
  }
}

// Fix CI: an agent that reads the failing checks' logs, fixes the cause on the PR's branch, and
// pushes. Flaky failures get a rerun, not a code change. "Here" runs in its own worktree of the
// branch (like the deep audit), so your checkout is never touched. Never two fixers on one PR.
const FIX_CI = (url: string, head?: string) => `Fix the failing CI on this pull request: ${url}
${head ? `You are in a dedicated worktree of its branch (${head}); the user's own checkout is untouched.\n` : ''}
1. List the failing checks: \`gh pr checks ${url}\`. For each failure, read its log (\`gh run view <run-id> --log-failed\`) and find the root cause.
2. Fix it on the PR's branch: code, tests, snapshots, lint, types. Run the relevant tests locally before pushing.
3. If a failure is flaky (unrelated to this change), rerun the job with \`gh run rerun <run-id> --failed\` instead of changing code, and say so.
4. Push the fix${head ? ` (\`git push origin HEAD:${head}\`)` : ''}. Never force-push over other people's commits. Stop and report if a fix needs a design decision.
End with one line per failing check: what it was and what you did.`

export async function fixCi(url: string, where: 'cloud' | 'here' = 'cloud', force = false) {
  const pr = parse(url)
  const busy = all<any>(`select c.id, coalesce(u.title, c.title) title, c.status from conversation_prs cp join conversations c on c.id = cp.conversation_id left join user_state u on u.id = c.id
    where cp.url = ? and c.updated_at > ? and (lower(coalesce(u.title, c.title, '')) like 'fix ci%')`, url, Date.now() - 3 * 3600_000)
  if (busy.length && !force) return { existing: busy, message: `#${pr.number} already has a CI fixer from the last few hours.` }
  if (where === 'cloud') {
    const t: any = await posthogFetch(`/api/projects/${settings.posthog.projectId}/tasks/`, { method: 'POST', body: JSON.stringify({ title: `Fix CI: ${pr.slug}#${pr.number}`, description: FIX_CI(url), repository: pr.slug }) })
    return { taskId: t.id, message: `A cloud agent is fixing CI on #${pr.number}. It shows up in your list within a minute.`, runError: t.run_error }
  }
  const repo = localRepos().find(r => r.remote?.includes(`${pr.owner}/${pr.repo}`))
  if (!repo) throw new Error(`No local checkout of ${pr.slug} found. Use the cloud option, or clone it under ${codeRoots()[0] ?? 'your code folder'}.`)
  const head = get<any>('select head from prs where url = ?', url)?.head
    ?? JSON.parse((await ghExec(['pr', 'view', String(pr.number), '--repo', pr.slug, '--json', 'headRefName'])).stdout).headRefName
  const dir = join(dirname(repo.path), '.perch-worktrees', `${basename(repo.path)}-pr${pr.number}`)
  const git = (args: string[]) => exec('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo.path, maxBuffer: 20e6, timeout: 180_000 })
  await git(['fetch', 'origin', head, '--quiet'])
  if (!existsSync(dir)) { mkdirSync(dirname(dir), { recursive: true }); await git(['worktree', 'add', '--detach', dir, `origin/${head}`]) }
  else await exec('git', ['-C', dir, 'checkout', '--detach', `origin/${head}`, '--quiet'])
  const id = randomUUID()
  send({ by: 'fix-ci', id, cwd: dir, prompt: FIX_CI(url, head), context: true, resume: false })
  setTitle(id, `Fix CI: ${pr.repo}#${pr.number}`)
  editLabels([id], ['fix-ci'])
  return { conversationId: id, message: `Fixing CI on #${pr.number} here, in its own worktree.` }
}

// Fix many PRs at once, from a filtered PR list. Either one orchestrator here (a turbo chat that
// sees them all: stacks bottom-up, independent PRs in parallel subagents, each in a worktree, and a
// follow-up to check CI after pushing), or one cloud agent per PR. PRs with an agent already at
// work are left out by the caller.
type Target = { url: string; title: string; head?: string; base?: string; checks?: string | null; review?: string | null; action?: string | null; draft?: boolean }
const ORCHESTRATE = (prs: Target[], goal: string) => `Get these ${prs.length} pull requests unstuck: ${goal === 'ci' ? 'fix their failing CI' : goal === 'comments' ? 'address their open review comments' : 'fix failing CI and address open review comments'}. You are the orchestrator: plan once, then run independent work in parallel.

${prs.map(p => `- ${p.url} | ${p.title} | branch ${p.head ?? '?'} → ${p.base ?? '?'}${p.draft ? ' | draft' : ''} | checks ${p.checks ?? '?'} | review ${p.review ?? 'none'}${p.action ? ` | ${p.action}` : ''}`).join('\n')}

How:
1. Group stacks: a PR whose base is another PR's branch sits on it. Fix a stack bottom-up, then restack the PRs above (the gh-stack skill, via use_skill, if needed). Independent PRs go in parallel: one subagent each (Agent tool, launched together), each in its own worktree: \`git worktree add ../.perch-worktrees/<repo>-pr<N> origin/<branch>\`. Never work in the user's own checkout.
2. Each subagent, for its PR: read failing checks (\`gh pr checks <url>\`, \`gh run view <id> --log-failed\`) and the unresolved review threads (\`gh api graphql\` reviewThreads). Fix causes, not symptoms; flaky failures get \`gh run rerun <id> --failed\` instead of code changes. Reply on each review thread with what changed, or why not. Push with \`git push origin HEAD:<branch>\`. Never force-push over other people's commits.
3. Stop and report a PR instead of fixing it when it needs a design decision or the reviewer's call.
4. After pushing, call the auto-m8 follow_up tool with each PR and until: "checks", so you come back and confirm CI went green (and fix again if not).
End with one line per PR: what was wrong, what you did, and its state now.`

export async function orchestrate(prs: Target[], where: 'here' | 'cloud', goal: 'ci' | 'comments' | 'both' = 'both') {
  const list = prs.filter(p => p?.url && /\/pull\/\d+/.test(p.url)).slice(0, 25)
  if (!list.length) throw new Error('No PRs to work on.')
  if (where === 'cloud') {
    const started: string[] = [], skipped: string[] = []
    for (const p of list) {
      const r: any = goal === 'ci' ? await fixCi(p.url, 'cloud') : await pushThrough(p.url, 'cloud')
      ;(r.existing ? skipped : started).push(`#${p.url.split('/').pop()}`)
    }
    return { message: `Started ${started.length} cloud agent${started.length === 1 ? '' : 's'}${started.length ? ` (${started.join(', ')})` : ''}.${skipped.length ? ` Skipped ${skipped.join(', ')}: already being worked on.` : ''}` }
  }
  const first = parse(list[0].url)
  const repo = localRepos().find(r => r.remote?.includes(`${first.owner}/${first.repo}`))
  const id = randomUUID()
  send({ by: 'orchestrator', id, cwd: repo?.path ?? settings.chat.cwd, prompt: ORCHESTRATE(list, goal), context: true, resume: false, turbo: true })
  setTitle(id, `Fix ${list.length} PRs: ${goal === 'ci' ? 'CI' : goal === 'comments' ? 'review comments' : 'CI and comments'}`)
  editLabels([id], ['orchestrator'])
  for (const p of list) run('insert or ignore into conversation_prs (conversation_id, url, created) values (?, ?, ?)', id, p.url, Date.now())
  return { conversationId: id, message: `One agent is working across ${list.length} PRs, in parallel where it can.` }
}
