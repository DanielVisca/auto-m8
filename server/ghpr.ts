// Live PR state straight from GitHub through the gh CLI, so orchestrators see what GitHub sees
// (not perch's periodic index): checks with names, review decision, unresolved threads, merge state.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { checkContextFields, checkContexts, summarizeChecks, ghExec } from './gh.ts'

const exec = promisify(execFile)

const Q = (number: number) => `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){
  title number state isDraft mergeable mergeStateStatus reviewDecision headRefOid headRefName baseRefName updatedAt mergedAt author { login }
  commits(last:1){nodes{commit{oid committedDate statusCheckRollup{id state contexts(first:100){${checkContextFields(number)}}}}}}
  reviewThreads(first:100){nodes{isResolved isOutdated}}
  latestReviews(first:30){nodes{author{login} state commit{oid}}}
  comments(last:1){totalCount nodes{author{login} createdAt}}
}}}`

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

async function fetchPr(pr: NonNullable<ReturnType<typeof parsePr>>): Promise<PrState> {
  const { stdout } = await ghExec(['api', 'graphql', '-f', `query=${Q(pr.number)}`, '-F', `o=${pr.owner}`, '-F', `r=${pr.repo}`, '-F', `n=${pr.number}`], { maxBuffer: 20e6, timeout: 45_000 })
  const p = JSON.parse(stdout).data.repository.pullRequest
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
