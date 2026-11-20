// Where your PRs end up, for the Insights flow chart: area → review → outcome.
// Every PR you opened in the window, plus every PR of yours still open (the stale ones are the point).
// Area comes from the files a PR changes most (products/<x>, scenes/<x>, …); other repos are their own area.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { all } from './db.ts'
import { originatedPrs, originFor, prSubject } from './origin.ts'
import { prBatch, ghExec } from './gh.ts'
import { DATA_DIR } from './settings.ts'

const exec = promisify(execFile)
export const onPrFlow = new Set<() => void>()
const DAY = 86400_000
const STALLED = 3 * DAY, STALE = 14 * DAY

export type Outcome = 'merged' | 'moving' | 'needs-you' | 'stalled' | 'stale' | 'abandoned'
export type Review = 'draft' | 'waiting' | 'changes' | 'approved' | 'none'

const Q = `query($q:String!,$after:String){search(query:$q,type:ISSUE,first:25,after:$after){pageInfo{hasNextPage endCursor}nodes{... on PullRequest{
  url number title state isDraft createdAt updatedAt mergedAt closedAt reviewDecision repository{nameWithOwner}
  files(first:30){nodes{path additions deletions}}
  commits(last:1){nodes{commit{committedDate statusCheckRollup{state}}}}
  reviews(last:1){nodes{submittedAt}}}}}}`

async function search(q: string) {
  const out: any[] = []
  for (let after: string | null = null, i = 0; i < 12; i++) {
    const args: string[] = ['api', 'graphql', '-f', `query=${Q}`, '-F', `q=${q}`, ...(after ? ['-F', `after=${after}`] : [])]
    // GitHub's search sometimes answers a heavy page with a 502/504: retry those a couple of times.
    let stdout = ''
    for (let t = 0; ; t++) {
      try { stdout = (await ghExec(args, { maxBuffer: 50e6, timeout: 60_000 })).stdout; break }
      catch (e: any) { if (t >= 2 || !/HTTP 5\d\d|timed out/i.test(String(e.stderr ?? e.message))) throw e; await new Promise(r => setTimeout(r, 1500 * (t + 1))) }
    }
    const s: any = JSON.parse(stdout).data.search
    out.push(...s.nodes.filter((n: any) => n.url))
    if (!s.pageInfo.hasNextPage) break
    after = s.pageInfo.endCursor
  }
  return out
}

// Generated and lock files say nothing about what the PR is about.
const NOISE = /(__snapshots__|\.ambr$|\.snap$|lock\.(json|yaml)$|\.lock$|schema\.(json|py)$|generated|\/migrations\/|\.min\.)/
export function areaOf(repo: string, files: { path: string; additions: number; deletions: number }[]) {
  if (repo !== 'PostHog/posthog') return repo.split('/')[1]
  const score = new Map<string, number>()
  for (const f of files) {
    if (NOISE.test(f.path)) continue
    const p = f.path.split('/')
    const key = p[0] === 'products' ? p[1]
      : p[0] === 'frontend' && p[2] === 'scenes' ? p[3]
      : p[0] === 'frontend' && p[2] === 'queries' ? 'queries'
      : p[0] === 'ee' && p[1] === 'hogai' ? 'max ai'
      : p[0] === 'posthog' && /^hogql/.test(p[1] ?? '') ? 'hogql'
      : p[0] === 'posthog' ? p[1]?.replace(/\.py$/, '') ?? 'posthog'
      : p[0] === 'rust' || p[0] === 'services' ? p[1] ?? p[0]
      : p[0] === '.github' ? 'ci'
      : p[0] === 'frontend' ? 'frontend'
      : p[0]
    if (key) score.set(key, (score.get(key) ?? 0) + f.additions + f.deletions + 1)
  }
  return [...score].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'posthog'
}

function classify(p: any, now: number) {
  const commit = p.commits.nodes[0]?.commit
  const last = Math.max(Date.parse(commit?.committedDate ?? 0) || 0, Date.parse(p.reviews.nodes[0]?.submittedAt ?? 0) || 0, Date.parse(p.createdAt))
  const checks = commit?.statusCheckRollup?.state ?? null
  const review: Review = p.isDraft ? 'draft' : p.reviewDecision === 'APPROVED' ? 'approved' : p.reviewDecision === 'CHANGES_REQUESTED' ? 'changes'
    : p.reviewDecision === 'REVIEW_REQUIRED' ? 'waiting' : p.state === 'OPEN' ? 'waiting' : 'none'
  const idle = now - last
  let outcome: Outcome, why = ''
  if (p.state === 'MERGED') outcome = 'merged'
  else if (p.state === 'CLOSED') outcome = 'abandoned'
  else if (idle > STALE) { outcome = 'stale'; why = `no commits or reviews for ${Math.round(idle / DAY)}d` }
  else if (!p.isDraft && review === 'approved' && checks === 'SUCCESS') { outcome = 'needs-you'; why = 'approved and green: merge it' }
  else if (review === 'changes') { outcome = 'needs-you'; why = 'changes requested' }
  else if (!p.isDraft && (checks === 'FAILURE' || checks === 'ERROR')) { outcome = 'needs-you'; why = review === 'approved' ? 'approved, but CI is red' : 'CI is red' }
  else if (idle > STALLED) { outcome = 'stalled'; why = review === 'waiting' ? `waiting on review for ${Math.round(idle / DAY)}d` : `quiet for ${Math.round(idle / DAY)}d` }
  else outcome = 'moving'
  return { review, outcome, why, last, checks }
}

// Fetching takes ~40s (every PR's files), so the last result is kept on disk and served at once;
// a refresh runs in the background when it's older than 3 minutes (the page polls every minute).
const cache = new Map<number, { at: number; data: any }>()
const refreshing = new Map<number, Promise<any>>()
const file = (days: number) => join(DATA_DIR, `prflow-${days}.json`)
export async function prFlow(days = 90, wait = false, force = false) {
  let hit = cache.get(days)
  if (!hit && existsSync(file(days))) { try { const data = JSON.parse(readFileSync(file(days), 'utf8')); hit = { at: data.fetchedAt, data }; cache.set(days, hit) } catch {} }
  const fresh = hit && Date.now() - hit.at < 3 * 60_000
  if ((!fresh || force) && !refreshing.has(days)) refreshing.set(days, fetchFlow(days).finally(() => refreshing.delete(days)))
  if (hit && !wait) return { ...hit.data, refreshing: refreshing.has(days) }
  return refreshing.get(days) ?? hit!.data
}

// Local midnight as an ISO time with offset, which GitHub search takes: 2026-11-11T00:00:00-08:00.
function localMidnight() {
  const d = new Date(); d.setHours(0, 0, 0, 0)
  const off = -d.getTimezoneOffset(), a = Math.abs(off), pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00:00${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
}

async function fetchFlow(days: number) {
  // days=0 is "today": since local midnight, and it also takes in PRs merged or closed today
  // (opened earlier), so "shipped" means shipped today.
  const since = days === 0 ? localMidnight() : new Date(Date.now() - days * DAY).toISOString().slice(0, 10)
  const queries = [`author:@me is:pr created:>=${since}`, 'author:@me is:pr is:open',
    ...(days === 0 ? [`author:@me is:pr merged:>=${since}`, `author:@me is:pr closed:>=${since}`] : [])]
  const byUrl = new Map((await Promise.all(queries.map(search))).flat().map(p => [p.url, p]))
  const extra = originatedPrs().filter(url => !byUrl.has(url))
  if (extra.length) {
    const batch = await prBatch(extra, `url number title state isDraft createdAt updatedAt mergedAt closedAt reviewDecision repository{nameWithOwner} files(first:30){nodes{path additions deletions}} commits(last:1){nodes{commit{committedDate statusCheckRollup{state}}}} reviews(last:1){nodes{submittedAt}}`)
    for (const [url, p] of batch.prs) if (p.state === 'OPEN' || Date.parse(p.createdAt) >= Date.parse(since) || days === 0 && Date.parse(p.mergedAt ?? p.closedAt) >= Date.parse(since)) byUrl.set(url, p)
  }
  const now = Date.now()
  const convs = new Map<string, string>()
  for (const r of all<any>(`select cp.url, c.id from conversation_prs cp join conversations c on c.id = cp.conversation_id order by c.updated_at desc`)) if (!convs.has(r.url)) convs.set(r.url, r.id)
  const prs = [...byUrl.values()].map(p => {
    const c = classify(p, now)
    return {
      url: p.url, number: p.number, title: p.title, repo: p.repository.nameWithOwner, area: areaOf(p.repository.nameWithOwner, p.files.nodes),
      created: Date.parse(p.createdAt), merged: p.mergedAt ? Date.parse(p.mergedAt) : null, closed: p.closedAt ? Date.parse(p.closedAt) : null,
      origin: originFor(prSubject(p.url))?.owner ?? null, draft: p.isDraft, conversation: convs.get(p.url) ?? null, ...c,
    }
  })
  const merged = prs.filter(p => p.merged)
  const hours = merged.map(p => (p.merged! - p.created) / 3600_000).sort((a, b) => a - b)
  const data = { days, prs, medianMergeHours: hours.length ? hours[Math.floor(hours.length / 2)] : null, fetchedAt: now }
  cache.set(days, { at: now, data })
  writeFileSync(file(days), JSON.stringify(data))
  onPrFlow.forEach(f => f())
  return data
}

// The "why" behind a set of PRs, fetched in one query for the summary agent: size, the start of
// the description, the last comments and reviews, and any PR that referenced it (often its replacement).
export async function prContext(urls: string[]) {
  const pick = urls.slice(0, 30)
  if (!pick.length) return ''
  const q = `{${pick.map((u, i) => `p${i}: resource(url: ${JSON.stringify(u)}) { ... on PullRequest { url additions deletions changedFiles body
    comments(last: 3) { nodes { author { login } body } }
    reviews(last: 2) { nodes { author { login } state body } }
    timelineItems(last: 4, itemTypes: [CROSS_REFERENCED_EVENT]) { nodes { ... on CrossReferencedEvent { source { ... on PullRequest { url state title } } } } } } }`).join('\n')}}`
  let data: any = {}
  try { data = JSON.parse((await ghExec(['api', 'graphql', '-f', `query=${q}`], { maxBuffer: 30e6, timeout: 60_000 })).stdout).data ?? {} } catch { return '' }
  const clip = (s: any, n: number) => String(s ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim().slice(0, n)
  return Object.values(data).filter(Boolean).map((p: any) => {
    const refs = p.timelineItems.nodes.map((n: any) => n.source).filter((s: any) => s?.url && s.url !== p.url)
    return [`### ${p.url} (+${p.additions}/−${p.deletions}, ${p.changedFiles} files)`,
      p.body && `description: ${clip(p.body, 300)}`,
      ...p.reviews.nodes.filter((r: any) => r.body || r.state !== 'COMMENTED').map((r: any) => `review ${r.author?.login ?? '?'} ${r.state}: ${clip(r.body, 200)}`),
      ...p.comments.nodes.map((c: any) => `comment ${c.author?.login ?? '?'}: ${clip(c.body, 220)}`),
      ...refs.map((s: any) => `referenced by ${s.url} (${s.state.toLowerCase()}): ${clip(s.title, 90)}`),
    ].filter(Boolean).join('\n')
  }).join('\n\n')
}
