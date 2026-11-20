// What a PR has been through, and whether "ready to merge" is really true.
// Rounds: each round is feedback (agent or human reviews and comments) and then what answered it
// (pushes, rebases, replies, a StampHog label). Readiness checks each condition on its own, on the
// PR's current commit, so a green "ready" can be trusted: who approved, every thread addressed,
// CI, conflicts. Queueing is PostHog's Trunk convention: a `/trunk merge` comment.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ghExec } from './gh.ts'

const exec = promisify(execFile)
const parse = (url: string) => {
  const m = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/)
  if (!m) throw new Error('That isn’t a GitHub pull request link.')
  return { owner: m[1], repo: m[2], number: Number(m[3]) }
}

// Review bots and services. Anyone else is a person.
const BOTS = /\[bot\]$|^(stamphog|posthog|parameterai|greptile-apps|copilot-pull-request-reviewer|copilot|github-actions|chatgpt-codex-connector|trunk-io|vercel|codecov|sentry-io|graphite-app|coderabbitai|cursor|claude)$/i
const isBot = (a: any) => !!a && (a.__typename === 'Bot' || BOTS.test(a.login ?? ''))
const TRUNK = /^\s*\/trunk\s+(merge|unmerge)\b/i
// Automation that comments but doesn't review: CI summaries, the queue bot, deploy previews.
const NOISE = /^(trunk-io|github-actions|scheduled-actions-posthog|vercel|codecov|sentry-io|netlify|dependabot|renovate)(\[bot\])?$/i

const Q = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){
  title number state isDraft mergeable mergeStateStatus reviewDecision headRefOid headRefName baseRefName createdAt mergedAt author { login } repository { nameWithOwner }
  reviewRequests(first:10){nodes{requestedReviewer{__typename ... on User{login} ... on Team{name}}}}
  commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:100){totalCount nodes{
    ... on CheckRun{name conclusion status} ... on StatusContext{context state}}}}}}}
  reviewThreads(first:100){nodes{isResolved isOutdated comments(first:1){nodes{author{login __typename}}}}}
  latestReviews(first:30){nodes{author{login __typename} state submittedAt commit{oid}}}
  timelineItems(first:250, itemTypes:[PULL_REQUEST_COMMIT, PULL_REQUEST_REVIEW, ISSUE_COMMENT, HEAD_REF_FORCE_PUSHED_EVENT, LABELED_EVENT,
    READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, MERGED_EVENT, REVIEW_DISMISSED_EVENT]){nodes{ __typename
    ... on PullRequestCommit{commit{committedDate messageHeadline}}
    ... on PullRequestReview{author{login __typename} state submittedAt body comments{totalCount}}
    ... on IssueComment{author{login __typename} createdAt body}
    ... on HeadRefForcePushedEvent{createdAt actor{login}}
    ... on LabeledEvent{createdAt label{name} actor{login}}
    ... on ReadyForReviewEvent{createdAt}
    ... on ConvertToDraftEvent{createdAt}
    ... on MergedEvent{createdAt}
    ... on ReviewDismissedEvent{createdAt}
  }}}}}`

type Check = { id: string; ok: boolean | null; label: string; detail: string }

const cache = new Map<string, { at: number; data: any }>()
export async function journey(url: string, fresh = false) {
  const hit = cache.get(url)
  if (hit && !fresh && Date.now() - hit.at < 60_000) return hit.data
  const pr = parse(url)
  const get = async () => JSON.parse((await ghExec(['api', 'graphql', '-f', `query=${Q}`, '-F', `o=${pr.owner}`, '-F', `r=${pr.repo}`, '-F', `n=${pr.number}`], { maxBuffer: 20e6, timeout: 45_000 })).stdout).data.repository.pullRequest
  let p = await get()
  // GitHub works out conflicts lazily: the first ask often says UNKNOWN. Ask again shortly.
  for (let i = 0; i < 2 && p.state === 'OPEN' && p.mergeable === 'UNKNOWN'; i++) { await new Promise(r => setTimeout(r, 2000)); p = await get() }
  const author = p.author?.login
  const at = (s: string) => Date.parse(s)

  // ---- the events, in order ----
  type Ev = { at: number; kind: string; who?: string; bot?: boolean; state?: string; comments?: number; text?: string }
  const evs: Ev[] = []
  for (const n of p.timelineItems.nodes) {
    if (n.__typename === 'PullRequestCommit') evs.push({ at: at(n.commit.committedDate), kind: 'commit', text: n.commit.messageHeadline })
    else if (n.__typename === 'PullRequestReview' && n.author?.login !== author && !NOISE.test(n.author?.login ?? '')) evs.push({ at: at(n.submittedAt), kind: 'review', who: n.author?.login, bot: isBot(n.author), state: n.state, comments: n.comments.totalCount + (n.body?.trim() ? 1 : 0) })
    else if (n.__typename === 'IssueComment') {
      const m = String(n.body ?? '').match(TRUNK)
      if (m) evs.push({ at: at(n.createdAt), kind: m[1].toLowerCase() === 'merge' ? 'queue' : 'unqueue', who: n.author?.login })
      else if (n.author?.login === author) evs.push({ at: at(n.createdAt), kind: 'reply', who: author })
      else if (!NOISE.test(n.author?.login ?? '')) evs.push({ at: at(n.createdAt), kind: 'comment', who: n.author?.login, bot: isBot(n.author), comments: 1 })
    }
    else if (n.__typename === 'HeadRefForcePushedEvent') evs.push({ at: at(n.createdAt), kind: 'rebase', who: n.actor?.login })
    else if (n.__typename === 'LabeledEvent') evs.push({ at: at(n.createdAt), kind: 'label', text: n.label?.name, who: n.actor?.login })
    else if (n.__typename === 'ReadyForReviewEvent') evs.push({ at: at(n.createdAt), kind: 'ready' })
    else if (n.__typename === 'ConvertToDraftEvent') evs.push({ at: at(n.createdAt), kind: 'draft' })
    else if (n.__typename === 'MergedEvent') evs.push({ at: at(n.createdAt), kind: 'merged' })
    else if (n.__typename === 'ReviewDismissedEvent') evs.push({ at: at(n.createdAt), kind: 'dismissed' })
  }
  evs.sort((a, b) => a.at - b.at)

  // ---- rounds: feedback, then what answered it ----
  const FEEDBACK = new Set(['review', 'comment'])
  const ANSWER = new Set(['commit', 'rebase', 'reply', 'label'])
  const opened = { at: at(p.createdAt), commits: 0 }
  const rounds: any[] = []
  let cur: any = null
  for (const e of evs) {
    if (FEEDBACK.has(e.kind)) {
      if (!cur || cur.answer.commits + cur.answer.rebases + cur.answer.replies > 0) { cur = { n: rounds.length + 1, at: e.at, reviewers: new Map(), comments: 0, answer: { commits: 0, rebases: 0, replies: 0, labels: [] as string[], at: null as number | null } }; rounds.push(cur) }
      const r = cur.reviewers.get(e.who) ?? { who: e.who, bot: e.bot, states: new Set<string>() }
      if (e.state) r.states.add(e.state)
      cur.reviewers.set(e.who, r)
      cur.comments += e.comments ?? 0
    } else if (ANSWER.has(e.kind)) {
      if (!cur) { if (e.kind === 'commit') opened.commits++; continue }
      cur.answer.at ??= e.at
      if (e.kind === 'commit') cur.answer.commits++
      else if (e.kind === 'rebase') cur.answer.rebases++
      else if (e.kind === 'reply') cur.answer.replies++
      else if (e.kind === 'label' && e.text) cur.answer.labels.push(e.text)
    }
  }
  const roundsOut = rounds.map(r => ({ ...r, reviewers: [...r.reviewers.values()].map((x: any) => ({ ...x, states: [...x.states] })) }))

  // ---- readiness, each condition on its own ----
  const head = p.headRefOid
  const latest = p.latestReviews.nodes.filter((r: any) => r.author?.login !== author)
  const approvals = latest.filter((r: any) => r.state === 'APPROVED').map((r: any) => ({ who: r.author?.login, bot: isBot(r.author), at: at(r.submittedAt), current: r.commit?.oid === head }))
  const blocking = latest.filter((r: any) => r.state === 'CHANGES_REQUESTED').map((r: any) => r.author?.login)
  const threads = p.reviewThreads.nodes
  const open = threads.filter((t: any) => !t.isResolved && !t.isOutdated).length
  const outdated = threads.filter((t: any) => !t.isResolved && t.isOutdated).length
  const ctx = p.commits.nodes[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []
  const total = p.commits.nodes[0]?.commit?.statusCheckRollup?.contexts?.totalCount ?? ctx.length
  const failing = ctx.filter((c: any) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'].includes(c.conclusion ?? c.state)).map((c: any) => c.name ?? c.context)
  const pending = ctx.filter((c: any) => (c.status && c.status !== 'COMPLETED') || c.state === 'PENDING' || c.state === 'EXPECTED').map((c: any) => c.name ?? c.context)
  const rollup = p.commits.nodes[0]?.commit?.statusCheckRollup?.state ?? null
  const lastQueue = [...evs].reverse().find(e => e.kind === 'queue' || e.kind === 'unqueue')
  const queued = lastQueue?.kind === 'queue' && p.state === 'OPEN' ? { by: lastQueue.who, at: lastQueue.at } : null
  const human = approvals.filter((a: any) => !a.bot)
  const checks: Check[] = [
    { id: 'draft', ok: !p.isDraft, label: p.isDraft ? 'Still a draft' : 'Ready for review', detail: p.isDraft ? 'Mark it ready first.' : '' },
    { id: 'approved', ok: p.reviewDecision === 'APPROVED' && approvals.some((a: any) => a.current),
      label: approvals.length ? `Approved by ${approvals.map((a: any) => `${a.who}${a.bot ? ' (bot)' : ''}`).join(', ')}` : 'Not approved yet',
      detail: !approvals.length ? (p.reviewDecision === 'REVIEW_REQUIRED' ? 'Waiting on a required review.' : '')
        : approvals.some((a: any) => a.current) ? `${approvals.some((a: any) => a.current && !a.bot) ? 'A person approved' : 'Approved'} the current commit.${!human.length ? ' No human approval: a bot did.' : ''}`
        : 'Approved before the last push: the approval may not cover the latest changes.' },
    { id: 'changes', ok: !blocking.length, label: blocking.length ? `Changes requested by ${blocking.join(', ')}` : 'No changes requested', detail: '' },
    { id: 'threads', ok: open === 0, label: open ? `${open} review thread${open > 1 ? 's' : ''} still open` : `All ${threads.length} review thread${threads.length === 1 ? '' : 's'} addressed`,
      detail: outdated ? `${outdated} more ${outdated > 1 ? 'are' : 'is'} unresolved but outdated (the code under ${outdated > 1 ? 'them' : 'it'} changed).` : '' },
    { id: 'ci', ok: failing.length ? false : pending.length ? null : rollup === 'SUCCESS' || (!ctx.length ? null : true),
      label: failing.length ? `${failing.length} check${failing.length > 1 ? 's' : ''} failing` : pending.length ? `${pending.length} check${pending.length > 1 ? 's' : ''} still running` : ctx.length ? `All ${total} checks passed` : 'No checks reported',
      detail: failing.slice(0, 4).join(', ') || pending.slice(0, 3).join(', ') },
    { id: 'merge', ok: p.mergeable === 'CONFLICTING' || p.mergeStateStatus === 'DIRTY' ? false : p.mergeable === 'MERGEABLE' ? true : null,
      label: p.mergeable === 'CONFLICTING' ? 'Has merge conflicts' : p.mergeStateStatus === 'BEHIND' ? 'Behind the base branch' : p.mergeable === 'MERGEABLE' ? 'No conflicts with the base' : 'GitHub is still checking for conflicts',
      detail: p.mergeStateStatus === 'BEHIND' ? 'The queue will rebase it.' : '' },
  ]
  const ready = p.state === 'OPEN' && checks.every(c => c.ok === true)
  const data = {
    url, title: p.title, number: p.number, repo: p.repository.nameWithOwner, head: p.headRefName, base: p.baseRefName, draft: p.isDraft,
    requested: p.reviewRequests.nodes.map((n: any) => n.requestedReviewer?.login ?? n.requestedReviewer?.name).filter(Boolean),
    failing, pending: pending.length, openThreads: open, blocking, mergeable: p.mergeable, mergeState: p.mergeStateStatus,
    state: p.state, merged: p.mergedAt ? at(p.mergedAt) : null, ready, queued, checks, opened, rounds: roundsOut,
    totals: { rounds: roundsOut.length, agentRounds: roundsOut.filter(r => r.reviewers.every((x: any) => x.bot)).length, humanReviewers: [...new Set(roundsOut.flatMap(r => r.reviewers.filter((x: any) => !x.bot).map((x: any) => x.who)))] },
  }
  cache.set(url, { at: Date.now(), data })
  return data
}

// Add to (or take out of) the Trunk merge queue. Only offered when every check passes.
export async function queue(url: string, on: boolean) {
  const j = await journey(url, true)
  if (on && !j.ready) return { ok: false, message: `Not ready yet: ${j.checks.filter((c: Check) => c.ok !== true).map((c: Check) => c.label.toLowerCase()).join('; ')}.` }
  await ghExec(['pr', 'comment', url, '--body', on ? '/trunk merge' : '/trunk unmerge'], { timeout: 30_000 })
  cache.delete(url)
  return { ok: true, message: on ? `#${url.split('/').pop()} is in the Trunk merge queue.` : `#${url.split('/').pop()} is out of the merge queue.` }
}

// ---------- merge plan: what order, and what's needed from whom ----------
// For a set of PRs (one piece of work): stacks bottom-up, then what's closest to done first, each
// with its one next step and who owns it. "You" steps are what the person must do; "agent" steps
// are fixable by an agent (CI, threads, conflicts); "wait" means nothing to do but let it run.
type Step = { owner: 'you' | 'agent' | 'wait' | 'done'; text: string }
export async function mergePlan(urls: string[]) {
  const list = [...new Set(urls)].slice(0, 12)
  const js: any[] = []
  for (let i = 0; i < list.length; i += 4) js.push(...(await Promise.all(list.slice(i, i + 4).map(u => journey(u).catch(() => null)))))
  const prs = js.filter(Boolean)
  const byHead = new Map(prs.map(j => [`${j.repo}:${j.head}`, j]))
  const parentOf = (j: any) => { const b = byHead.get(`${j.repo}:${j.base}`); return b && b !== j && b.state === 'OPEN' ? b : null }
  const depth = (j: any) => { let d = 0; for (let p = parentOf(j); p && d < 20; p = parentOf(p)) d++; return d }
  const rootOf = (j: any) => { let r = j; for (let p = parentOf(j), i = 0; p && i < 20; p = parentOf(p), i++) r = p; return r }

  const step = (j: any): Step => {
    if (j.state === 'MERGED') return { owner: 'done', text: 'Merged' }
    if (j.state === 'CLOSED') return { owner: 'done', text: 'Closed without merging' }
    if (j.queued) return { owner: 'wait', text: 'In the merge queue' }
    const parent = parentOf(j)
    if (j.ready) return parent ? { owner: 'wait', text: `Ready; merges after #${parent.number}` } : { owner: 'you', text: 'Ready: add it to the merge queue' }
    if (j.draft) return { owner: 'you', text: 'Mark it ready for review' }
    if (j.mergeable === 'CONFLICTING') return { owner: 'agent', text: 'Resolve merge conflicts' }
    if (j.failing.length) return { owner: 'agent', text: `Fix CI (${j.failing.length} failing: ${j.failing.slice(0, 2).join(', ')})` }
    if (j.blocking.length) return { owner: 'agent', text: `Address the changes ${j.blocking.join(', ')} requested` }
    if (j.openThreads) return { owner: 'agent', text: `Resolve ${j.openThreads} open review thread${j.openThreads > 1 ? 's' : ''}` }
    if (j.pending) return { owner: 'wait', text: `${j.pending} check${j.pending > 1 ? 's' : ''} still running` }
    const approved = j.checks.find((c: any) => c.id === 'approved')
    if (!approved?.ok) return { owner: 'you', text: j.requested.length ? `Get a review: waiting on ${j.requested.join(', ')}` : 'Get a review: no reviewer requested yet' }
    return { owner: 'wait', text: 'Waiting on GitHub' }
  }
  const rank = { you: 0, agent: 1, wait: 2, done: 3 } as const
  // Work closest to done first: ready, then fixable, then waiting. A stack stays in its order.
  const items = prs.map(j => ({ url: j.url, number: j.number, title: j.title, repo: j.repo, root: rootOf(j).url, depth: depth(j), step: step(j), parent: parentOf(j)?.number ?? null }))
  const stackRank = new Map<string, number>()
  for (const it of items) stackRank.set(it.root, Math.min(stackRank.get(it.root) ?? 9, it.step.owner === 'done' ? 9 : it.step.owner === 'you' && /merge queue/.test(it.step.text) ? 0 : rank[it.step.owner] + 1))
  items.sort((a, b) => (a.step.owner === 'done' ? 1 : 0) - (b.step.owner === 'done' ? 1 : 0) || stackRank.get(a.root)! - stackRank.get(b.root)! || a.root.localeCompare(b.root) || a.depth - b.depth)
  const open = items.filter(i => i.step.owner !== 'done')
  const yours = open.filter(i => i.step.owner === 'you')
  const agents = open.filter(i => i.step.owner === 'agent')
  // One sentence: what the person has to do to finish this work.
  const summary = !open.length ? (items.length ? 'All merged or closed. Nothing left to do.' : '')
    : yours.length ? `${yours.map(i => `#${i.number}: ${i.step.text.replace(/^Ready: /, '').replace(/^Get a review: /, 'get a review (').replace(/(waiting on .*|no reviewer requested yet)$/, '$1)').toLowerCase()}`).join('; ')}.`
    : agents.length ? `Nothing from you right now: ${agents.length} PR${agents.length > 1 ? 's need' : ' needs'} an agent fix.` : 'Nothing from you right now: waiting on checks and the queue.'
  return { summary, items, agentFixable: agents.map(i => i.url) }
}
