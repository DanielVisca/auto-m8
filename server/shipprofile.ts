// Ship profile: how a repo reviews, merges, tests and deploys, read from evidence instead of assumed.
// The shepherd started out hardcoded to PostHog's pipeline (stamphog approves, Trunk merges, Kargo
// and ArgoCD deploy, Grafana and PostHog verify). A profile says what a repo actually does:
// - review: required approvals from rulesets, CODEOWNERS, and which bot (if any) approves PRs
// - merge: who actually merged the last 30 PRs (trunk-io, mergify, the GitHub merge queue, people)
// - ci: the check-suite apps that report on PRs
// - live: how to tell a merge reached production (recent non-preview Deployments, release tags,
//   a deploy workflow, ArgoCD folders, or "merged = live")
// Evidence beats config: cal.com has a .kodiak.toml but people merge, and PostHog's .trunk/ is
// linter config. Fetching is ~5 read-only calls per repo (rulesets need no admin), cached 24h.
// detectProfile is pure, so the rules are tested on recorded fixtures.
import { randomUUID } from 'node:crypto'
import { db, get, run } from './db.ts'
import { ghExec } from './gh.ts'

export type Conf = 'high' | 'medium' | 'low'
export type Ev = { source: string; detail: string }
export type MergeKind = 'trunk' | 'mergify' | 'kodiak' | 'bors' | 'graphite' | 'github-queue' | 'auto-merge' | 'manual'
export type LiveKind = 'deployments' | 'release-tag' | 'workflow-run' | 'argocd' | 'merged' | 'unknown'
export type ShipProfile = {
  repo: string; branch: string; detectedAt: number; adminVisible: boolean; sample: number
  review: {
    required: number | null; codeOwners: boolean; requiredChecks: string[]
    autoApprover: null | { bot: string; trigger: 'label' | 'auto'; label?: string; share: number }
    humanShare: number; evidence: Ev[]
  }
  merge: {
    kind: MergeKind; method: 'squash' | 'merge' | 'rebase'
    enqueue: { comment?: string; dequeue?: string; label?: string; graphql?: 'enqueuePullRequest' | 'enablePullRequestAutoMerge' }
    queuedEvidence: { commentRe?: string; label?: string; timelineEvent?: string }
    evidence: Ev[]
  }
  ci: { apps: string[]; statusContexts: string[] }
  bots: { summary: string[]; reviewers: string[] }
  live: { kind: LiveKind; environments?: string[]; workflow?: string; tagPattern?: string; hint?: string; evidence: Ev[] }
  confidence: { review: Conf; merge: Conf; live: Conf }
  unknown: string[]
}

// What detection reads, already trimmed (comment heads, not bodies), so fixtures stay small.
export type Who = { login: string; bot: boolean }
export type RawPr = {
  n: number; mergedAt: string; mergedBy: Who | null; approvers: Who[]
  events: { type: string; label?: string; at?: string }[]
  comments: (Who & { head: string })[]
  apps: string[]; contexts: string[]
}
export type RawRepo = {
  slug: string; fetchedAt: number; branch: string; admin: boolean; protected: boolean; protectionChecks: string[]
  allow: { squash: boolean; merge: boolean; rebase: boolean; auto: boolean }; mergeQueue: boolean
  rules: { type: string; parameters?: any }[]; files: string[]
  deployments: { env: string; at: string; task: string; sha: string; state: string }[]
  releases: { tag: string; at: string; pre: boolean }[]
  pushRuns: { name: string; path: string; at: string }[]
  prs: RawPr[]
}

// ---------- detection (pure) ----------
const DAY = 86_400_000
const norm = (login: string) => login.toLowerCase().replace(/\[bot\]$/, '')
// Environments that aren't production: previews, staging, dev, promotion bookkeeping.
const NOT_PROD = /preview|pull|\bpr[-_ ]?\d|review|staging|\bstage\b|\bdev\b|develop|test|\bqa\b|sandbox|promote|demo|\bbot\b|autonomous/i
const DEPLOYISH = /deploy|\bcd\b|rollout/i
// Bot logins that merge for a queue, and what that queue is.
const MERGERS: [RegExp, MergeKind][] = [[/^trunk-io$/, 'trunk'], [/^mergify$/, 'mergify'], [/^kodiak(hq)?$/, 'kodiak'], [/^bors$/, 'bors'], [/^graphite-app$/, 'graphite'], [/^github-merge-queue$/, 'github-queue']]
const CI_NAMES: Record<string, string> = { 'github-actions': 'GitHub Actions', depot: 'Depot', circleci: 'CircleCI', 'circleci-checks': 'CircleCI', buildkite: 'Buildkite', vercel: 'Vercel', netlify: 'Netlify', codecov: 'Codecov', jenkins: 'Jenkins' }

const count = <T,>(xs: T[]) => { const m = new Map<T, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]) }
const pct = (x: number) => `${Math.round(x * 100)}%`

export function detectProfile(raw: RawRepo, now = raw.fetchedAt): ShipProfile {
  const prs = raw.prs
  const n = prs.length || 1
  const share = (k: number) => k / n
  const unknown: string[] = []
  const rule = (t: string) => raw.rules.filter(r => r.type === t)

  // ---- review ----
  const prRules = rule('pull_request')
  const required = prRules.length ? Math.max(...prRules.map(r => Number(r.parameters?.required_approving_review_count ?? 0))) : null
  const codeOwners = prRules.some(r => r.parameters?.require_code_owner_review) || raw.files.some(f => /CODEOWNERS$/.test(f))
  const requiredChecks = [...new Set([...rule('required_status_checks').flatMap(r => (r.parameters?.required_status_checks ?? []).map((c: any) => String(c.context))), ...raw.protectionChecks])]
  const botApprovals = count(prs.flatMap(p => [...new Set(p.approvers.filter(a => a.bot).map(a => norm(a.login)))]))
  const humanShare = share(prs.filter(p => p.approvers.some(a => !a.bot)).length)
  let autoApprover: ShipProfile['review']['autoApprover'] = null
  const [topBot, topBotN] = botApprovals[0] ?? []
  if (topBot && share(topBotN!) >= 0.2) {
    // Label-triggered when a label carrying its name was added to most of the PRs it approved (stamphog).
    // Its label is often removed once it has approved, so any PR in the sample carrying it counts.
    const labels = count(prs.flatMap(p => [...new Set(p.events.filter(e => e.type === 'LabeledEvent' && e.label && e.label.toLowerCase().includes(topBot)).map(e => e.label!))]))
    const [label] = labels[0] ?? []
    autoApprover = label
      ? { bot: topBot, trigger: 'label', label, share: share(topBotN!) }
      : { bot: topBot, trigger: 'auto', share: share(topBotN!) }
  }
  const reviewEv: Ev[] = [
    { source: 'rulesets', detail: required === null ? 'no pull_request rule on the default branch' : `${required} approval${required === 1 ? '' : 's'} required${codeOwners ? ', CODEOWNERS' : ''}` },
    { source: 'last merged PRs', detail: `${pct(humanShare)} had a human approval${autoApprover ? `; ${autoApprover.bot} (bot) approved ${pct(autoApprover.share)}` : ''}` },
  ]
  if (!raw.admin && raw.protected) unknown.push('classic branch protection rules (admin only)')

  // ---- merge ----
  const mergedBy = count(prs.map(p => p.mergedBy).filter(Boolean).map(w => norm(w!.login)))
  const queueEvents = prs.filter(p => p.events.some(e => e.type === 'AddedToMergeQueueEvent')).length
  const autoEvents = prs.filter(p => p.events.some(e => e.type === 'AutoMergeEnabledEvent')).length
  const commenters = (re: RegExp) => prs.filter(p => p.comments.some(c => re.test(norm(c.login)))).length
  let kind: MergeKind = 'manual', kindShare = 0
  for (const [login, k] of mergedBy) {
    const m = MERGERS.find(([re]) => re.test(login))
    if (m && share(k) >= 0.5) { kind = m[1]; kindShare = share(k); break }
  }
  if (kind === 'github-queue' || (kind === 'manual' && (share(queueEvents) >= 0.5 || (raw.mergeQueue && share(queueEvents) >= 0.2)))) {
    kindShare = Math.max(kindShare, share(queueEvents))
    kind = share(commenters(/^graphite-app$/)) >= 0.3 ? 'graphite' : 'github-queue'
  } else if (kind === 'manual' && share(autoEvents) >= 0.5) { kind = 'auto-merge'; kindShare = share(autoEvents) }
  const humanMerged = share(prs.filter(p => p.mergedBy && !p.mergedBy.bot).length)
  if (kind === 'manual') kindShare = humanMerged

  // Merge method: what the ruleset allows, else what the repo allows. Squash first.
  const ruleMethods: string[] | undefined = prRules.find(r => r.parameters?.allowed_merge_methods)?.parameters.allowed_merge_methods
  const allowed = (m: 'squash' | 'merge' | 'rebase') => raw.allow[m] && (!ruleMethods || ruleMethods.includes(m))
  const method = (['squash', 'merge', 'rebase'] as const).find(allowed) ?? 'squash'

  // How to ask the queue for it, and how to tell it is queued.
  const labelFor = (bot: RegExp) => {
    const merged = prs.filter(p => p.mergedBy && bot.test(norm(p.mergedBy.login)))
    const [l, ln] = count(merged.flatMap(p => [...new Set(p.events.filter(e => e.type === 'LabeledEvent' && e.label && /merge|queue|ready|land|ship/i.test(e.label)).map(e => e.label!))]))[0] ?? [] // not cla-signed and other bookkeeping
    return l && ln! >= Math.max(2, merged.length * 0.5) ? l : undefined
  }
  let enqueue: ShipProfile['merge']['enqueue'] = {}, queuedEvidence: ShipProfile['merge']['queuedEvidence'] = {}
  if (kind === 'trunk') { enqueue = { comment: '/trunk merge', dequeue: '/trunk unmerge' }; queuedEvidence = { commentRe: '^\\s*/trunk\\s+merge\\b' } }
  else if (kind === 'mergify') {
    const label = labelFor(/^mergify$/)
    enqueue = label ? { label } : { comment: '@Mergifyio queue', dequeue: '@Mergifyio dequeue' }
    queuedEvidence = label ? { label } : { commentRe: '^\\s*@mergifyio\\s+queue\\b' }
  } else if (kind === 'kodiak') { const label = labelFor(/^kodiak(hq)?$/) ?? 'automerge'; enqueue = { label }; queuedEvidence = { label } }
  else if (kind === 'bors') { enqueue = { comment: 'bors r+', dequeue: 'bors r-' }; queuedEvidence = { commentRe: '^\\s*bors\\s+r\\+' } }
  else if (kind === 'github-queue' || kind === 'graphite') { enqueue = { graphql: 'enqueuePullRequest' }; queuedEvidence = { timelineEvent: 'AddedToMergeQueueEvent' } }
  else if (kind === 'auto-merge') { enqueue = { graphql: 'enablePullRequestAutoMerge' }; queuedEvidence = { timelineEvent: 'AutoMergeEnabledEvent' } }
  const mergeEv: Ev[] = [{ source: 'last merged PRs', detail: mergedBy.slice(0, 3).map(([l, k]) => `${l} merged ${k}/${prs.length}`).join(', ') || 'no merged PRs' }]
  if (queueEvents) mergeEv.push({ source: 'timeline', detail: `${queueEvents}/${prs.length} went through the GitHub merge queue` })
  if (autoEvents) mergeEv.push({ source: 'timeline', detail: `${autoEvents}/${prs.length} had auto-merge enabled` })
  if (raw.mergeQueue) mergeEv.push({ source: 'repository', detail: 'merge queue on the default branch' })
  for (const f of raw.files.filter(f => /mergify|kodiak|bors/.test(f))) mergeEv.push({ source: 'config', detail: `${f} present${kind === 'manual' ? ' but people merge' : ''}` })

  // ---- CI ----
  const apps = count(prs.flatMap(p => [...new Set(p.apps)])).filter(([, k]) => share(k) >= 0.1).map(([a]) => a)
  const statusContexts = count(prs.flatMap(p => [...new Set(p.contexts)])).filter(([, k]) => share(k) >= 0.2).map(([c]) => c).slice(0, 10)

  // ---- bots ----
  const summary = count(prs.flatMap(p => [...new Set(p.comments.filter(c => c.bot).map(c => norm(c.login)))])).filter(([, k]) => share(k) >= 0.1).map(([l]) => l)
  const reviewers = botApprovals.map(([l]) => l)

  // ---- live ----
  const liveEv: Ev[] = []
  let live: ShipProfile['live'] = { kind: 'merged', evidence: liveEv }
  const ok = (s: string) => /SUCCESS|INACTIVE/i.test(s)
  const recentProd = raw.deployments.filter(d => ok(d.state) && !NOT_PROD.test(d.env) && now - Date.parse(d.at) < 14 * DAY)
  const recentRel = raw.releases.filter(r => now - Date.parse(r.at) < 30 * DAY)
  const deployRuns = count(raw.pushRuns.filter(r => DEPLOYISH.test(`${r.name} ${r.path}`) && now - Date.parse(r.at) < 14 * DAY).map(r => r.name))
  if (recentProd.length) {
    const envs = count(recentProd.map(d => d.env)).map(([e]) => e).sort()
    const tasks = new Set(recentProd.map(d => d.task))
    live = { kind: 'deployments', environments: envs, evidence: liveEv, hint: tasks.size > 1 ? `${tasks.size} deploy tasks (one per service)` : undefined }
    liveEv.push({ source: 'deployments', detail: `${recentProd.length} successful deployments to ${envs.join(', ')} in the last 14 days` })
    if (tasks.size > 1) unknown.push('which deploy task carries a given PR')
  } else if (recentRel.length) {
    const tags = recentRel.map(r => r.tag)
    const pre = tags.every(t => /^v\d/.test(t)) ? 'v*' : tags.every(t => /canary/.test(t)) ? '*canary*' : undefined
    live = { kind: 'release-tag', tagPattern: pre, evidence: liveEv, hint: 'released when a tag containing the merge commit ships' }
    liveEv.push({ source: 'releases', detail: `${recentRel.length} release${recentRel.length > 1 ? 's' : ''} in 30 days, latest ${tags[0]}` })
    unknown.push('which release is deployed where')
  } else if (deployRuns.length) {
    live = { kind: 'workflow-run', workflow: deployRuns[0][0], evidence: liveEv, hint: 'a push run of this workflow containing the merge commit' }
    liveEv.push({ source: 'actions', detail: `workflow "${deployRuns[0][0]}" ran ${deployRuns[0][1]} times on pushes in 14 days` })
  } else if (raw.files.some(f => /^(argocd|charts)\/?$/.test(f))) {
    live = { kind: 'argocd', evidence: liveEv, hint: 'ArgoCD app synced to a revision containing the merge commit' }
    liveEv.push({ source: 'repository', detail: `${raw.files.filter(f => /^(argocd|charts)/.test(f)).join(', ')} folder` })
    unknown.push('which ArgoCD app deploys it')
  } else if (raw.deployments.length || raw.releases.length) {
    // Signs of deploying, but nothing recent and production-like: don't pretend merged is live.
    live = { kind: 'unknown', evidence: liveEv }
    const envs = [...new Set(raw.deployments.map(d => d.env))].slice(0, 4)
    liveEv.push({ source: 'deployments', detail: envs.length ? `only ${envs.join(', ')} deployments, none recent to production` : 'releases, none in 30 days' })
    unknown.push('production deploy signal')
  } else liveEv.push({ source: 'repository', detail: 'no deployments, releases or deploy workflows: merged is live' })

  const conf = (x: number): Conf => x >= 0.6 ? 'high' : x >= 0.3 ? 'medium' : 'low'
  return {
    repo: raw.slug, branch: raw.branch, detectedAt: now, adminVisible: raw.admin, sample: prs.length,
    review: { required, codeOwners, requiredChecks, autoApprover, humanShare, evidence: reviewEv },
    merge: { kind, method, enqueue, queuedEvidence, evidence: mergeEv },
    ci: { apps, statusContexts }, bots: { summary, reviewers }, live,
    confidence: {
      review: prs.length >= 10 ? (raw.rules.length || raw.admin ? 'high' : 'medium') : 'low',
      merge: prs.length >= 10 ? conf(kindShare) : 'low',
      live: live.kind === 'deployments' ? 'high' : live.kind === 'unknown' || live.kind === 'argocd' ? 'low' : 'medium',
    },
    unknown,
  }
}

// ---------- reading it ----------
const MERGE_LABEL: Record<MergeKind, string> = { trunk: 'Trunk queue', mergify: 'Mergify queue', kodiak: 'Kodiak', bors: 'bors', graphite: 'Graphite / GitHub merge queue', 'github-queue': 'GitHub merge queue', 'auto-merge': 'GitHub auto-merge', manual: 'by hand' }
export function shipLine(p: ShipProfile, observability: string[] | null) {
  const a = p.review.autoApprover
  const review = [a ? `${a.bot} bot${a.trigger === 'label' ? ` (label ${a.label})` : ''}` : '', p.review.humanShare >= 0.2 || !a ? 'people' : ''].filter(Boolean).join(' + ')
    + (p.review.required ? `, ${p.review.required} required` : '')
  const merge = `${MERGE_LABEL[p.merge.kind]}${p.merge.kind === 'manual' || p.merge.kind === 'auto-merge' ? ` (${p.merge.method})` : ''}`
  const ci = [...p.ci.apps].sort((a, b) => Number(!CI_NAMES[a]) - Number(!CI_NAMES[b])).map(x => CI_NAMES[x] ?? x).slice(0, 3).join(', ') || 'none seen'
  const l = p.live
  const liveText = l.kind === 'deployments' ? `Deployments ${l.environments!.join(', ')}` : l.kind === 'release-tag' ? `release tags${l.tagPattern ? ` ${l.tagPattern}` : ''}` : l.kind === 'workflow-run' ? `workflow "${l.workflow}"` : l.kind === 'argocd' ? 'ArgoCD (agent checks)' : l.kind === 'merged' ? 'merged = live' : 'unknown'
  const verify = observability === null ? 'whatever MCPs agents have' : observability.length ? observability.join(', ') : 'no observability MCP'
  return `Review: ${review} · Merge: ${merge} · CI: ${ci} · Live: ${liveText} · Verify: ${verify}`
}

// The text of step 2 of the shepherd's MERGE prompt: how this repo merges.
export function mergeInstruction(p: ShipProfile, url: string) {
  const e = p.merge.enqueue, m = p.merge.method
  switch (p.merge.kind) {
    case 'trunk': return 'If the repo merges through Trunk (a trunk-io[bot] comment on the PR), comment exactly `/trunk merge` on the PR, with nothing else in the comment: Trunk rejects any extra text. Then read Trunk\'s reply on the PR: "Submitted to Merge" means queued. Otherwise run `gh pr merge ' + url + ' --squash`.'
    case 'mergify': case 'kodiak': case 'bors':
      return e.label
        ? `This repo merges through ${MERGE_LABEL[p.merge.kind]}: add the label \`${e.label}\` with \`gh pr edit ${url} --add-label ${e.label}\` and nothing else. The bot merges it once its rules pass.`
        : `This repo merges through ${MERGE_LABEL[p.merge.kind]}: comment exactly \`${e.comment}\` on the PR, with nothing else in the comment. Then read the bot's reply: queued or merged.`
    case 'github-queue': case 'graphite':
      return `This repo uses the GitHub merge queue: run \`gh pr merge ${url}\` (no method flag), which adds it to the queue. Don't merge around the queue.`
    case 'auto-merge': return `This repo uses GitHub auto-merge: run \`gh pr merge ${url} --auto --${m}\`.`
    default: return `Run \`gh pr merge ${url} --${m}\`.`
  }
}

// One-line recommendations for the links the shepherd can't drive on its own, with their tradeoff.
export type Recommendation = { key: string; title: string; tradeoff: string }
export function recommendations(p: ShipProfile, observability: string[] | null): Recommendation[] {
  const out: Recommendation[] = []
  if (!p.review.autoApprover && p.sample >= 10 && p.review.humanShare >= 0.8)
    out.push({ key: 'review', title: `${p.repo}: every PR waits for a person to approve it; an approval bot for low-risk PRs would let auto-m8 merge those unattended`, tradeoff: 'A bot stamp is weaker evidence than a reviewer: scope it to small, well-tested changes.' })
  if (p.live.kind === 'unknown')
    out.push({ key: 'live', title: `${p.repo}: no production signal, so auto-m8 can't tell when a merge is live; publish GitHub Deployments from the production deploy job`, tradeoff: 'Exact and cheap to check (no agent run), at the cost of one deploy-workflow change and a token with deployments:write. Until then a verify agent judges it.' })
  else if (p.live.kind === 'argocd' || p.live.kind === 'workflow-run')
    out.push({ key: 'live', title: `${p.repo}: production deploys via ${p.live.kind === 'argocd' ? 'ArgoCD' : `"${p.live.workflow}"`} but don't publish GitHub Deployments; publishing them lets auto-m8 check "is it live" in code`, tradeoff: 'One deploy-workflow change and a token with deployments:write; until then an agent checks it every 15 minutes.' })
  if (observability !== null && !observability.length)
    out.push({ key: 'observability', title: `${p.repo}: no observability MCP is connected, so production checks can confirm a merge is live but not that it works; connect Grafana, Datadog, Sentry or PostHog`, tradeoff: 'Agents can compare against a pre-merge baseline, at the cost of one more credential they hold.' })
  return out
}

// ---------- fetching (read-only) ----------
const OBJ = (alias: string, path: string) => `${alias}: object(expression: "HEAD:${path}") { id }`
const FILES: [string, string][] = [['mergify', '.mergify.yml'], ['mergify2', '.github/mergify.yml'], ['kodiak', '.kodiak.toml'], ['kodiak2', '.github/.kodiak.toml'], ['bors', 'bors.toml'],
  ['co1', 'CODEOWNERS'], ['co2', '.github/CODEOWNERS'], ['co3', 'docs/CODEOWNERS'], ['argocd', 'argocd'], ['charts', 'charts']]

const REPO_Q = (o: string, r: string) => `{ repository(owner: "${o}", name: "${r}") {
  defaultBranchRef { name } viewerPermission autoMergeAllowed squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed mergeQueue { url }
  deployments(first: 60, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { environment createdAt task commitOid latestStatus { state } } }
  releases(first: 5, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { tagName createdAt isPrerelease } }
  ${FILES.map(([a, p]) => OBJ(a, p)).join('\n  ')}
} }`
const PRS_Q = (o: string, r: string) => `{ repository(owner: "${o}", name: "${r}") {
  pullRequests(states: MERGED, first: 30, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes {
    number mergedAt mergedBy { __typename login }
    reviews(states: APPROVED, first: 10) { nodes { author { __typename login } } }
    timelineItems(first: 40, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, AUTO_MERGE_ENABLED_EVENT, LABELED_EVENT]) { nodes { __typename ... on LabeledEvent { createdAt label { name } } ... on AddedToMergeQueueEvent { createdAt } ... on AutoMergeEnabledEvent { createdAt } } }
    comments(first: 30) { nodes { author { __typename login } body } }
    commits(last: 1) { nodes { commit { checkSuites(first: 60) { nodes { app { slug } status } } status { contexts { context } } } } }
  } }
} }`

const who = (a: any): Who | null => a?.login ? { login: String(a.login), bot: a.__typename === 'Bot' || /\[bot\]$/.test(a.login) } : null
async function gql(q: string) {
  const { stdout } = await ghExec(['api', 'graphql', '-f', `query=${q}`], { maxBuffer: 30e6, timeout: 60_000 })
  const j = JSON.parse(stdout)
  if (!j.data?.repository) throw new Error(`ship profile: ${j.errors?.[0]?.message ?? 'no repository data'}`)
  return j.data.repository
}
const rest = async (path: string) => { try { return JSON.parse((await ghExec(['api', path], { timeout: 30_000, maxBuffer: 10e6 })).stdout) } catch { return null } }

export async function fetchRaw(slug: string): Promise<RawRepo> {
  const [o, r] = slug.split('/')
  const [repo, prs] = await Promise.all([gql(REPO_Q(o, r)), gql(PRS_Q(o, r))])
  const branch = repo.defaultBranchRef?.name ?? 'main'
  const enc = encodeURIComponent(branch)
  const [rules, br, runs] = await Promise.all([
    rest(`repos/${slug}/rules/branches/${enc}`),
    rest(`repos/${slug}/branches/${enc}`),
    rest(`repos/${slug}/actions/runs?branch=${enc}&event=push&per_page=50`),
  ])
  return {
    slug, fetchedAt: Date.now(), branch, admin: repo.viewerPermission === 'ADMIN',
    protected: !!br?.protected, protectionChecks: br?.protection?.required_status_checks?.contexts ?? [],
    allow: { squash: !!repo.squashMergeAllowed, merge: !!repo.mergeCommitAllowed, rebase: !!repo.rebaseMergeAllowed, auto: !!repo.autoMergeAllowed },
    mergeQueue: !!repo.mergeQueue,
    rules: Array.isArray(rules) ? rules.map((x: any) => ({ type: x.type, parameters: x.parameters })) : [],
    files: FILES.filter(([a]) => repo[a]).map(([, p]) => p),
    deployments: (repo.deployments?.nodes ?? []).map((d: any) => ({ env: String(d.environment ?? ''), at: d.createdAt, task: String(d.task ?? ''), sha: String(d.commitOid ?? ''), state: String(d.latestStatus?.state ?? '') })),
    releases: (repo.releases?.nodes ?? []).map((x: any) => ({ tag: x.tagName, at: x.createdAt, pre: !!x.isPrerelease })),
    pushRuns: (runs?.workflow_runs ?? []).map((x: any) => ({ name: String(x.name ?? ''), path: String(x.path ?? ''), at: x.created_at })),
    prs: (prs.pullRequests?.nodes ?? []).map((p: any): RawPr => ({
      n: p.number, mergedAt: p.mergedAt, mergedBy: who(p.mergedBy),
      approvers: (p.reviews?.nodes ?? []).map((x: any) => who(x.author)).filter(Boolean),
      events: (p.timelineItems?.nodes ?? []).map((e: any) => ({ type: e.__typename, label: e.label?.name, at: e.createdAt })),
      comments: (p.comments?.nodes ?? []).flatMap((c: any) => { const w = who(c.author); return w ? [{ ...w, head: String(c.body ?? '').trim().split('\n')[0].slice(0, 60) }] : [] }),
      apps: [...new Set<string>((p.commits?.nodes?.[0]?.commit?.checkSuites?.nodes ?? []).filter((s: any) => s.status && s.status !== 'QUEUED') /* installed apps leave a queued suite that never runs */.map((s: any) => s.app?.slug).filter(Boolean))],
      contexts: [...new Set<string>((p.commits?.nodes?.[0]?.commit?.status?.contexts ?? []).map((c: any) => c.context))],
    })),
  }
}

// ---------- the cache: one profile per repo, 24h ----------
db.exec('create table if not exists ship_profiles (repo text primary key, at integer not null, profile text not null)')
// autopilot.ts owns this table; whichever module loads first makes it.
db.exec(`create table if not exists suggestions (id text primary key, created_at integer, status text default 'open', kind text, title text, why text, evidence text, payload text, created_ref text)`)
const TTL = DAY
const failedAt = new Map<string, number>()
const inflight = new Map<string, Promise<ShipProfile | null>>()

export const cachedProfile = (slug: string): ShipProfile | null => {
  const row = get<{ profile: string }>('select profile from ship_profiles where repo = ?', slug)
  try { return row ? JSON.parse(row.profile) : null } catch { return null }
}
export const saveProfile = (p: ShipProfile) => run('insert or replace into ship_profiles (repo, at, profile) values (?, ?, ?)', p.repo, Date.now(), JSON.stringify(p))

// The repo's profile: cached for a day, re-detected on refresh. A failed detection falls back to the
// last profile (or null, and isn't retried for an hour), so callers keep today's behaviour.
export function shipProfile(slug: string, refresh = false): Promise<ShipProfile | null> {
  const row = get<{ at: number }>('select at from ship_profiles where repo = ?', slug)
  if (row && !refresh && Date.now() - row.at < TTL) return Promise.resolve(cachedProfile(slug))
  if (!refresh && Date.now() - (failedAt.get(slug) ?? 0) < 3_600_000) return Promise.resolve(cachedProfile(slug))
  if (inflight.has(slug)) return inflight.get(slug)!
  const p = fetchRaw(slug).then(raw => {
    const prof = detectProfile(raw)
    saveProfile(prof)
    failedAt.delete(slug)
    suggestMissingLinks(prof).catch(() => {})
    return prof
  }, () => { failedAt.set(slug, Date.now()); return cachedProfile(slug) }).finally(() => inflight.delete(slug))
  inflight.set(slug, p)
  return p
}

// ---------- the user's observability MCPs ----------
const OBS = /grafana|posthog|datadog|sentry|honeycomb|new.?relic|prometheus|loki|signoz|axiom|elastic|splunk|better.?stack|dynatrace|cloudwatch|chronosphere|logfire|lightstep|victoria/i
let obs: { at: number; list: string[] | null } | null = null
export const setObservabilityForTest = (list: string[] | null) => { obs = { at: Date.now(), list } }
// Connected observability MCP servers, by name; null when they can't be read (then prompts stay generic).
export async function observabilityTools(): Promise<string[] | null> {
  if (obs && Date.now() - obs.at < 10 * 60_000) return obs.list
  let list: string[] | null = null
  try {
    const { mcpRows } = await import('./mcpaccess.ts')
    const rows = await mcpRows()
    const all = [...rows.claude, ...rows.codex]
    if (all.length) list = [...new Set(all.filter(r => /^(connected|enabled)/i.test(r.state) && OBS.test(r.server)).map(r => r.server.replace(/^claude\.ai /, '')))].sort()
  } catch {}
  obs = { at: Date.now(), list }
  return list
}

// Missing links become one "heads up" each in the suggestions list, once per repo and link.
export async function suggestMissingLinks(p: ShipProfile) {
  for (const r of recommendations(p, await observabilityTools())) {
    if (get('select 1 from suggestions where title = ?', r.title)) continue
    run(`insert into suggestions (id, created_at, kind, title, why, evidence, payload) values (?, ?, 'ship', ?, ?, ?, ?)`,
      randomUUID(), Date.now(), r.title, r.tradeoff, JSON.stringify(p.live.evidence.concat(p.review.evidence).map(e => `${e.source}: ${e.detail}`)), JSON.stringify({ repo: p.repo, key: r.key }))
  }
}

// ---------- is a merge live? (deployments) ----------
// The newest successful production deployments per environment, then a compare: the deployed commit
// contains the merge commit when GitHub says it is "ahead" of it or "identical". Commits don't change,
// so each answer is kept.
const contains = new Map<string, boolean>()
async function includes(slug: string, base: string, head: string) {
  const k = `${slug}:${base}...${head}`
  if (!contains.has(k)) {
    const st = (await ghExec(['api', `repos/${slug}/compare/${base}...${head}?per_page=1`, '--jq', '.status'], { timeout: 30_000, maxBuffer: 20e6 })).stdout.trim()
    contains.set(k, st === 'ahead' || st === 'identical')
  }
  return contains.get(k)!
}
const deployCache = new Map<string, { at: number; list: RawRepo['deployments'] }>()
async function recentDeployments(slug: string) {
  const c = deployCache.get(slug)
  if (c && Date.now() - c.at < 2 * 60_000) return c.list
  const [o, r] = slug.split('/')
  const repo = await gql(`{ repository(owner: "${o}", name: "${r}") { deployments(first: 100, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { environment createdAt task commitOid latestStatus { state } } } } }`)
  const list = (repo.deployments?.nodes ?? []).map((d: any) => ({ env: String(d.environment ?? ''), at: d.createdAt, task: String(d.task ?? ''), sha: String(d.commitOid ?? ''), state: String(d.latestStatus?.state ?? '') }))
  deployCache.set(slug, { at: Date.now(), list })
  return list
}

export type LiveCheck = { live: boolean; detail: string }
// Pure part: which deployments could carry a merge made at mergedAt, newest first, a few per environment.
export function candidates(deps: RawRepo['deployments'], env: string, mergedAt: number, max = 6) {
  const seen = new Set<string>()
  return deps.filter(d => d.env === env && /SUCCESS|INACTIVE/i.test(d.state) && Date.parse(d.at) >= mergedAt - 60_000 && !seen.has(d.sha) && seen.add(d.sha)).slice(0, max)
}
// When a repo deploys both the main app (task "deploy") and single services ("deploy:<service>"),
// only the main deploy says the change is live: PostHog's worker deploys carry a merge commit
// minutes before the web servers do, so counting them started the verify agent early and it
// found NOT DEPLOYED (PR 142446, 2026-11-25). Repos with only per-service tasks keep all of them.
export function mainTasks<T extends { task: string }>(deps: T[]): T[] {
  const main = deps.filter(d => !d.task || d.task === 'deploy')
  return main.length && main.length < deps.length ? main : deps
}

export async function liveCheck(slug: string, mergeSha: string, mergedAt: number, envs: string[]): Promise<LiveCheck> {
  const deps = await recentDeployments(slug)
  const parts: string[] = []
  let all = true
  for (const env of envs) {
    let hit: RawRepo['deployments'][number] | null = null
    // Oldest of the newest first: the first deployment that carried it.
    for (const d of mainTasks(candidates(deps, env, mergedAt)).reverse()) if (await includes(slug, mergeSha, d.sha)) { hit = d; break }
    if (hit) parts.push(`${env}: ${hit.task || 'deploy'} of ${hit.sha.slice(0, 10)} at ${hit.at}`)
    else { all = false; parts.push(`${env}: no successful deployment containing it yet`) }
  }
  return { live: all, detail: parts.join('; ') }
}
