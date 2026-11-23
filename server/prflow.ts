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
import { recordError } from './errors.ts'

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

// A 502/504 from GitHub, or gh killed by our timeout (killed, empty stderr: the message is only
// "Command failed: <the whole query>", which used to slip past the retry and get reported raw).
export const retryableSearchError = (e: any) => !!e?.killed || /HTTP 5\d\d|timed out|timeout/i.test(`${e?.stderr ?? ''} ${e?.message ?? ''}`)

// What gh said about which search page, not the 600-character query it was given.
export function searchError(e: any, q: string, page: number): Error {
  if (e?.rateLimited) return e
  const said = String(e?.stderr ?? '').trim() || String(e?.message ?? e).split('\n').slice(1).join(' ').trim()
  return new Error(`GitHub PR search "${q}" (page ${page}): ${e?.killed ? 'timed out' : said.slice(0, 300) || 'failed'}`)
}

async function search(q: string, files = true) {
  const out: any[] = []
  for (let after: string | null = null, i = 0; i < 12; i++) {
    const args: string[] = ['api', 'graphql', '-f', `query=${files ? Q : Q.replace(/\n\s*files\(first:30\)\{nodes\{path additions deletions\}\}/, '')}`, '-F', `q=${q}`, ...(after ? ['-F', `after=${after}`] : [])]
    // GitHub's search sometimes answers a heavy page with a 502/504: retry those a couple of times.
    let stdout = ''
    for (let t = 0; ; t++) {
      try { stdout = (await ghExec(args, { maxBuffer: 50e6, timeout: 60_000 })).stdout; break }
      catch (e: any) { if (t >= 2 || !retryableSearchError(e)) throw searchError(e, q, i + 1); await new Promise(r => setTimeout(r, 1500 * (t + 1))) }
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

// A materialized view of your PRs. One store of raw PRs (kept on disk) is synced in the background
// every SYNC_MS: an incremental sync asks GitHub only for PRs updated since the last one, plus a
// light pass (no file lists) over open PRs, whose CI state changes without bumping updatedAt.
// A full rebuild runs every FULL_MS to catch anything the incremental passes missed. Every window
// (today, 7, 30, 90, 180 days) is derived from the store on read, so it's instant and its
// stalled/stale ages are current even between syncs. A full fetch used to take ~1 minute per window.
const SYNC_MS = 2 * 60_000, FULL_MS = 6 * 3600_000, KEEP_DAYS = 180
const FIELDS = (files: boolean) => `url number title state isDraft createdAt updatedAt mergedAt closedAt reviewDecision repository{nameWithOwner} ${files ? 'files(first:30){nodes{path additions deletions}}' : ''} commits(last:1){nodes{commit{committedDate statusCheckRollup{state}}}} reviews(last:1){nodes{submittedAt}}`
// skipped: originated PRs too old for any window, so incremental syncs don't fetch them again.
type Store = { prs: Record<string, any>; syncedAt: number; fullAt: number; skipped?: string[] }
const storeFile = join(DATA_DIR, 'prflow-store.json')
let store: Store | null = null
let syncing: Promise<Store> | null = null
let timer: ReturnType<typeof setInterval> | null = null

function loadStore() {
  if (!store && existsSync(storeFile)) { try { store = JSON.parse(readFileSync(storeFile, 'utf8')) } catch {} }
  return store
}

// Local midnight as an ISO time with offset, which GitHub search takes: 2026-11-11T00:00:00-08:00.
function localMidnight() {
  const d = new Date(); d.setHours(0, 0, 0, 0)
  const off = -d.getTimezoneOffset(), a = Math.abs(off), pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00:00${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
}

const keepSince = () => Date.now() - KEEP_DAYS * DAY
const kept = (p: any) => p.state === 'OPEN' || Date.parse(p.createdAt) >= keepSince() || Date.parse(p.mergedAt ?? p.closedAt ?? 0) >= keepSince()

async function sync(full: boolean): Promise<Store> {
  const old = loadStore()
  full ||= !old || Date.now() - old.fullAt > FULL_MS
  const started = Date.now()
  const prs: Record<string, any> = full ? {} : { ...old!.prs }
  const put = (p: any) => { const was = prs[p.url] ?? old?.prs[p.url]; prs[p.url] = p.files ? p : { ...p, files: was?.files ?? { nodes: [] } } }
  if (full) {
    const since = new Date(keepSince()).toISOString().slice(0, 10), today = localMidnight()
    const found = await Promise.all([`author:@me is:pr created:>=${since}`, 'author:@me is:pr is:open', `author:@me is:pr merged:>=${today}`, `author:@me is:pr closed:>=${today}`].map(q => search(q)))
    found.flat().forEach(put)
  } else {
    // Overlap the window a little: GitHub's search index lags writes by a few seconds.
    const since = new Date(old!.syncedAt - 10 * 60_000).toISOString().replace(/\.\d+Z$/, 'Z')
    const [changed, open] = await Promise.all([search(`author:@me is:pr updated:>=${since}`), search('author:@me is:pr is:open', false)])
    changed.forEach(put)
    open.forEach(put)
  }
  // PRs started from your work under someone else's name: new ones need their files, open ones their CI.
  const origin = originatedPrs()
  const skipped = new Set(full ? [] : old!.skipped ?? [])
  const missing = origin.filter(u => !prs[u] && !skipped.has(u))
  const open = full ? [] : origin.filter(u => prs[u]?.state === 'OPEN' && !missing.includes(u))
  if (missing.length) for (const [u, p] of (await prBatch(missing, FIELDS(true))).prs) if (kept(p)) put(p); else skipped.add(u)
  if (open.length) for (const [, p] of (await prBatch(open, FIELDS(false))).prs) put(p)
  for (const [u, p] of Object.entries(prs)) if (!kept(p)) delete prs[u]
  store = { prs, syncedAt: started, fullAt: full ? started : old!.fullAt, skipped: [...skipped] }
  writeFileSync(storeFile, JSON.stringify(store))
  onPrFlow.forEach(f => f())
  return store
}

function kick(full = false) {
  if (!syncing) {
    syncing = sync(full).finally(() => { syncing = null })
    // Nobody awaits a background sync: note a failure and keep serving the store; the next tick retries.
    syncing.catch(e => recordError('PR insights', e, 'Refreshing PR insights'))
  }
  return syncing
}

function view(s: Store, days: number) {
  const now = Date.now()
  const since = days === 0 ? Date.parse(localMidnight()) : now - days * DAY
  const convs = new Map<string, string>()
  for (const r of all<any>(`select cp.url, c.id from conversation_prs cp join conversations c on c.id = cp.conversation_id order by c.updated_at desc`)) if (!convs.has(r.url)) convs.set(r.url, r.id)
  // days=0 is "today": since local midnight, and it also takes in PRs merged or closed today
  // (opened earlier), so "shipped" means shipped today.
  const prs = Object.values(s.prs).filter(p => p.state === 'OPEN' || Date.parse(p.createdAt) >= since || days === 0 && Date.parse(p.mergedAt ?? p.closedAt ?? 0) >= since).map(p => {
    const c = classify(p, now)
    return {
      url: p.url, number: p.number, title: p.title, repo: p.repository.nameWithOwner, area: areaOf(p.repository.nameWithOwner, p.files?.nodes ?? []),
      created: Date.parse(p.createdAt), merged: p.mergedAt ? Date.parse(p.mergedAt) : null, closed: p.closedAt ? Date.parse(p.closedAt) : null,
      origin: originFor(prSubject(p.url))?.owner ?? null, draft: p.isDraft, conversation: convs.get(p.url) ?? null, ...c,
    }
  })
  const hours = prs.filter(p => p.merged).map(p => (p.merged! - p.created) / 3600_000).sort((a, b) => a - b)
  return { days, prs, medianMergeHours: hours.length ? hours[Math.floor(hours.length / 2)] : null, fetchedAt: s.syncedAt }
}

export async function prFlow(days = 90, wait = false, force = false) {
  if (!timer) { timer = setInterval(() => { kick() }, SYNC_MS); timer.unref?.() }
  const s = loadStore()
  if (force || !s || Date.now() - s.syncedAt > SYNC_MS) kick()
  if (s && !wait) return { ...view(s, days), refreshing: !!syncing }
  if (!s && !wait) {
    // First run after the upgrade: show the old per-window snapshot while the store builds.
    const legacy = join(DATA_DIR, `prflow-${days}.json`)
    if (existsSync(legacy)) { try { return { ...JSON.parse(readFileSync(legacy, 'utf8')), refreshing: true } } catch {} }
  }
  return view(await (syncing ?? kick()), days)
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
