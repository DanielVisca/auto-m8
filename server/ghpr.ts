// Live PR state straight from GitHub through the gh CLI, so orchestrators see what GitHub sees
// (not perch's periodic index): checks with names, review decision, unresolved threads, merge state.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { checkContextFields, checkContexts, summarizeChecks, ghExec, prBatch } from './gh.ts'
import { deployFor, type Deploy } from './deploys.ts'

const exec = promisify(execFile)

const FIELDS = (number: number) => `
  title number state isDraft mergeable mergeStateStatus reviewDecision headRefOid headRefName baseRefName updatedAt mergedAt author { login }
  commits(last:1){nodes{commit{oid committedDate statusCheckRollup{id state contexts(first:100){${checkContextFields(number)}}}}}}
  reviewThreads(first:100){nodes{isResolved isOutdated}}
  latestReviews(first:30){nodes{author{login} state commit{oid}}}
  comments(last:1){totalCount nodes{author{login} createdAt}}`
const Q = (number: number) => `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){${FIELDS(number)}}}}`

export type PrState = {
  url: string; repo: string; number: number; title: string; author: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  checks: 'passing' | 'failing' | 'running' | 'cancelled' | 'none'; failing: string[]; pending: string[]; optionalCancelled: string[]; totalChecks: number
  review: string; approvedBy: string[]; changesBy: string[]
  unresolved: number; outdated: number; comments: number
  head: string; branch: string; base: string; mergeState: string; updatedAt: number; mergedAt: number | null
}

export const parsePr = (url: string) => {
  const m = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/)
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]), url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` } : null
}

const cache = new Map<string, { at: number; p: Promise<PrState> }>()

export function prState(url: string, maxAgeMs = 45_000): Promise<PrState> {
  const pr = parsePr(url)
  if (!pr) return Promise.reject(new Error(`Not a PR link: ${url}`))
  const hit = cache.get(pr.url)
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.p
  const p = fetchPr(pr)
  cache.set(pr.url, { at: Date.now(), p })
  p.catch(() => cache.delete(pr.url))
  return p
}

// Many PRs at once: one GraphQL call per 20 PRs instead of one each (watches and the board read
// 30-100 PRs every few minutes, ~1,250 calls an hour one by one). Fresh cache entries are reused.
export async function prStates(urls: string[], maxAgeMs = 45_000): Promise<Map<string, PrState | Error>> {
  const out = new Map<string, PrState | Error>()
  const todo: NonNullable<ReturnType<typeof parsePr>>[] = []
  for (const u of new Set(urls)) {
    const pr = parsePr(u)
    if (!pr) { out.set(u, new Error(`Not a PR link: ${u}`)); continue }
    const hit = cache.get(pr.url)
    if (hit && Date.now() - hit.at < maxAgeMs) out.set(pr.url, await hit.p.catch(e => e instanceof Error ? e : new Error(String(e))))
    else todo.push(pr)
  }
  if (todo.length) {
    const byUrl = new Map(todo.map(pr => [pr.url, pr]))
    const { prs, missing, failed } = await prBatch(todo.map(pr => pr.url), u => FIELDS(byUrl.get(u)!.number), { size: 20, timeout: 60_000 })
    await pool(todo, 6, async pr => {
      const raw = prs.get(pr.url)
      if (!raw) { out.set(pr.url, missing.includes(pr.url) ? new Error(`GitHub doesn't know ${pr.url}`) : failed ?? new Error(`couldn't read ${pr.url}`)); return }
      const p = toState(pr, raw)
      cache.set(pr.url, { at: Date.now(), p })
      p.catch(() => cache.delete(pr.url))
      out.set(pr.url, await p.catch(e => e instanceof Error ? e : new Error(String(e))))
    })
  }
  return out
}

async function fetchPr(pr: NonNullable<ReturnType<typeof parsePr>>): Promise<PrState> {
  const { stdout } = await ghExec(['api', 'graphql', '-f', `query=${Q(pr.number)}`, '-F', `o=${pr.owner}`, '-F', `r=${pr.repo}`, '-F', `n=${pr.number}`], { maxBuffer: 20e6, timeout: 45_000 })
  return toState(pr, JSON.parse(stdout).data.repository.pullRequest)
}

async function toState(pr: NonNullable<ReturnType<typeof parsePr>>, p: any): Promise<PrState> {
  const roll = p.commits.nodes[0]?.commit?.statusCheckRollup
  const ctx = await checkContexts(roll, pr.number)
  const reviews: any[] = p.latestReviews.nodes.filter((r: any) => r.author?.login !== p.author?.login)
  const threads: any[] = p.reviewThreads.nodes
  return {
    url: pr.url, repo: `${pr.owner}/${pr.repo}`, number: pr.number, title: p.title, author: p.author?.login ?? '',
    state: p.state === 'MERGED' ? 'merged' : p.state === 'CLOSED' ? 'closed' : p.isDraft ? 'draft' : 'open',
    ...summarizeChecks(roll?.state, ctx), totalChecks: roll?.contexts?.totalCount ?? ctx.length,
    review: (p.reviewDecision ?? 'none').toLowerCase().replace(/_/g, ' '),
    approvedBy: reviews.filter(r => r.state === 'APPROVED').map(r => r.author?.login), changesBy: reviews.filter(r => r.state === 'CHANGES_REQUESTED').map(r => r.author?.login),
    unresolved: threads.filter(t => !t.isResolved && !t.isOutdated).length, outdated: threads.filter(t => !t.isResolved && t.isOutdated).length,
    comments: p.comments.totalCount, head: p.headRefOid, branch: p.headRefName, base: p.baseRefName, mergeState: (p.mergeStateStatus ?? '').toLowerCase(),
    updatedAt: Date.parse(p.updatedAt), mergedAt: p.mergedAt ? Date.parse(p.mergedAt) : null,
  }
}

// Runs fn over items with a few in flight at once (gh is happy with that; it isn't a cap on how many).
export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]) } }))
  return out
}

export function prLine(s: PrState, extra = '') {
  const checks = s.checks === 'failing' ? s.failing.length ? `CI RED (${s.failing.length}: ${s.failing.slice(0, 4).join(', ')}${s.failing.length > 4 ? ', …' : ''})` : 'CI RED (failure details unavailable)' : s.checks === 'running' ? `CI running (${s.pending.length} left)` : `CI ${s.checks}`
  const cancelled = s.optionalCancelled?.length ? ` | ${s.optionalCancelled.length} optional jobs cancelled: ${s.optionalCancelled.slice(0, 4).join(', ')}${s.optionalCancelled.length > 4 ? ', …' : ''}` : ''
  const review = s.approvedBy.length ? `approved by ${s.approvedBy.join(', ')}` : s.changesBy.length ? `changes requested by ${s.changesBy.join(', ')}` : `review ${s.review}`
  const state = s.state === 'merged' ? `MERGED ${new Date(s.mergedAt!).toISOString().slice(0, 16).replace('T', ' ')}` : s.state.toUpperCase()
  return `${s.repo}#${s.number} ${s.title} | ${state}${s.state === 'open' || s.state === 'draft' ? ` | ${checks}${cancelled} | ${review} | ${s.unresolved} unresolved thread${s.unresolved === 1 ? '' : 's'} | ${s.mergeState}` : ''}${extra} | ${s.url}`
}

// ---------- briefs: title / state / author for PR pills ----------
// Every PR pill in every chat asked for one, and each used the full PR-state query (all checks,
// threads, reviews; two calls for PostHog PRs): /api/pr/brief alone hit the rate limit dozens of
// times a day. A brief needs four fields, so pills asking within 50ms share one call (25 PRs per
// call), answers are kept for an hour, and with GitHub out of reach perch's own index answers.
// deploy: only on merged PRs, so the pill's dot can tell merged (purple) from live in production.
export type PrBrief = { url: string; title: string; state: PrState['state']; repo: string; number: number; author: string | null; deploy?: Deploy['state'] }
const briefs = new Map<string, { at: number; b: PrBrief }>()
const BRIEF_MS = 3600_000
// Merged but not yet live: re-read sooner so the dot turns over within minutes of the deploy.
const DEPLOYING_MS = 5 * 60_000
const briefTtl = (b: PrBrief) => b.state === 'merged' && b.deploy !== 'deployed' ? DEPLOYING_MS : BRIEF_MS
let queued: { pr: NonNullable<ReturnType<typeof parsePr>>; done: (b: PrBrief | Error) => void }[] = []
let flush: NodeJS.Timeout | null = null
export const clearBriefs = () => briefs.clear()

export function prBrief(url: string, local?: (url: string) => { title: string; state: string; draft?: number | boolean } | undefined): Promise<PrBrief> {
  const pr = parsePr(url)
  if (!pr) return Promise.reject(new Error(`Not a PR link: ${url}`))
  const hit = briefs.get(pr.url)
  if (hit && Date.now() - hit.at < briefTtl(hit.b)) return Promise.resolve(hit.b)
  const fallback = (e: Error): PrBrief => {
    if (hit) return hit.b
    const row = local?.(pr.url)
    if (!row?.title) throw e
    const st = String(row.state).toLowerCase()
    const state = st === 'merged' ? 'merged' : st === 'closed' ? 'closed' : row.draft ? 'draft' : 'open'
    return { url: pr.url, title: row.title, repo: `${pr.owner}/${pr.repo}`, number: pr.number, author: null, state,
      ...(state === 'merged' ? { deploy: deployFor(pr.url, null, []).state } : {}) }
  }
  return new Promise<PrBrief | Error>(done => {
    queued.push({ pr, done })
    flush ??= setTimeout(() => { flush = null; const batch = queued; queued = []; void readBriefs(batch) }, 50)
  }).then(b => b instanceof Error ? fallback(b) : b)
}

async function readBriefs(batch: typeof queued) {
  const urls = [...new Set(batch.map(x => x.pr.url))]
  let res: Awaited<ReturnType<typeof prBatch>> | null = null, err: Error | null = null
  // Only PostHog/posthog has the deploy bot's comment; elsewhere the shepherd's stage is the signal.
  const fields = (u: string) => `title state isDraft mergedAt author { login }${/github\.com\/PostHog\/posthog\/pull\//i.test(u) ? ' comments(last: 30) { nodes { author { login } body } }' : ''}`
  try { res = await prBatch(urls, fields, { size: 25, timeout: 30_000 }) } catch (e: any) { err = e }
  for (const { pr, done } of batch) {
    const p = res?.prs.get(pr.url)
    if (!p) { done(err ?? res?.failed ?? new Error(`GitHub doesn't know ${pr.url}`)); continue }
    const state = p.state === 'MERGED' ? 'merged' : p.state === 'CLOSED' ? 'closed' : p.isDraft ? 'draft' : 'open'
    const b: PrBrief = { url: pr.url, title: p.title, repo: `${pr.owner}/${pr.repo}`, number: pr.number, author: p.author?.login ?? null, state,
      ...(state === 'merged' ? { deploy: deployFor(pr.url, p.mergedAt ? Date.parse(p.mergedAt) : null, p.comments?.nodes ?? []).state } : {}) }
    briefs.set(pr.url, { at: Date.now(), b })
    done(b)
  }
  if (briefs.size > 2000) for (const [k, v] of briefs) if (Date.now() - v.at > briefTtl(v.b)) briefs.delete(k)
}
