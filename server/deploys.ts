// Merged vs deployed: where each merged PR is running, and since when.
// Two sources, best first:
//  1. The deploy bot's "Deploy status" comment (<!-- deploy-notify-bot -->) on PostHog/posthog PRs:
//     one row per environment with a status and a deployed-at time, edited as each one lands.
//  2. The shepherd's stage for PRs it follows (any repo): deploying, or live once it reached verifying.
// A PR with neither has no signal: shown as unknown, never as deployed.
import { all } from './db.ts'
import { ghExec } from './gh.ts'

export type Env = { env: string; status: 'deployed' | 'deploying' | 'failed'; at: number | null }
export type Deploy = {
  state: 'deployed' | 'deploying' | 'stuck' | 'failed' | 'unknown'
  envs: Env[]
  source: 'deploy-bot' | 'shepherd' | null
  liveAt: number | null // first production environment live (prod-us or prod-eu)
}

export const DEPLOY_MARK = '<!-- deploy-notify-bot -->'
const PROD = /^prod/i
// Merged this long ago with no production environment: it probably never shipped.
export const STUCK_AFTER = 24 * 3600_000

// | **prod-us** | :white_check_mark: Deployed | 2026-11-25 12:29 UTC | [Run](…) |
export function parseDeployComment(body: string): Env[] {
  const out: Env[] = []
  for (const line of String(body ?? '').split('\n')) {
    const m = line.match(/^\|\s*\*{0,2}([\w-]+)\*{0,2}\s*\|\s*([^|]*)\|\s*([^|]*)\|/)
    if (!m || /^(environment|-+)$/i.test(m[1])) continue
    const s = m[2].toLowerCase()
    const status: Env['status'] = /fail|error|x:|cross/.test(s) ? 'failed' : /deployed|white_check_mark|✅/.test(s) && !/not/.test(s) ? 'deployed' : 'deploying'
    const t = m[3].trim().match(/(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d)/)
    out.push({ env: m[1], status, at: t ? Date.parse(`${t[1]}T${t[2]}:00Z`) : null })
  }
  return out
}

export function deployState(mergedAt: number | null, envs: Env[], shepherdStage: string | null, now = Date.now()): Deploy {
  if (envs.length) {
    const prod = envs.filter(e => PROD.test(e.env))
    const live = prod.filter(e => e.status === 'deployed' && e.at).map(e => e.at as number)
    const state = prod.some(e => e.status === 'failed') && !live.length ? 'failed'
      : prod.length && prod.every(e => e.status === 'deployed') ? 'deployed'
      : mergedAt && now - mergedAt > STUCK_AFTER && !live.length ? 'stuck' : 'deploying'
    return { state, envs, source: 'deploy-bot', liveAt: live.length ? Math.min(...live) : null }
  }
  if (shepherdStage) {
    const live = ['verifying', 'verified', 'handed-off', 'failed'].includes(shepherdStage)
    const state = live ? 'deployed' : mergedAt && now - mergedAt > STUCK_AFTER ? 'stuck' : 'deploying'
    return { state, envs: [], source: 'shepherd', liveAt: null }
  }
  // Nothing reports on it. Within the first hour the deploy bot may simply not have posted yet.
  return { state: mergedAt && now - mergedAt < 3600_000 ? 'deploying' : 'unknown', envs: [], source: null, liveAt: null }
}

const stageOf = (url: string) => all<any>('select stage from shepherd_watch where url = ?', url)[0]?.stage ?? null
export const botComment = (comments: { author?: { login?: string } | null; body?: string }[]) =>
  [...comments].reverse().find(c => String(c.body ?? '').includes(DEPLOY_MARK) || /^deployment-status/.test(c.author?.login ?? ''))?.body ?? ''
export const deployFor = (url: string, mergedAt: number | null, comments: any[]) =>
  deployState(mergedAt, parseDeployComment(botComment(comments)), stageOf(url))

// Your merged PRs in the PostHog org over the last N days, with where each one is running.
// One GraphQL search (comments included), cached for 10 minutes.
let cache: { at: number; days: number; data: any } | null = null
export async function listDeploys(days = 14) {
  days = Math.max(1, Math.min(60, days || 14))
  if (cache && cache.days === days && Date.now() - cache.at < 10 * 60_000) return cache.data
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)
  const q = `is:pr is:merged author:@me org:PostHog merged:>=${since}`
  const query = `query($q:String!,$after:String){search(query:$q,type:ISSUE,first:50,after:$after){pageInfo{hasNextPage endCursor}nodes{... on PullRequest{
    url title mergedAt repository{nameWithOwner} comments(last:30){nodes{author{login} body}}}}}}`
  const nodes: any[] = []
  let after: string | null = null
  for (let page = 0; page < 4; page++) {
    const args = ['api', 'graphql', '-f', `query=${query}`, '-F', `q=${q}`]
    if (after) args.push('-F', `after=${after}`)
    const { stdout } = await ghExec(args, { maxBuffer: 20e6, timeout: 30_000 })
    const s = JSON.parse(stdout).data.search
    nodes.push(...s.nodes)
    if (!s.pageInfo.hasNextPage) break
    after = s.pageInfo.endCursor
  }
  const prs = nodes.filter(n => n?.url).map(n => {
    const mergedAt = Date.parse(n.mergedAt)
    const d = deployFor(n.url, mergedAt, n.comments?.nodes ?? [])
    return { url: n.url, title: n.title, repo: n.repository?.nameWithOwner, mergedAt, ...d, lagMin: d.liveAt ? Math.round((d.liveAt - mergedAt) / 60_000) : null }
  }).sort((a, b) => b.mergedAt - a.mergedAt)
  const count = (s: string) => prs.filter(p => p.state === s).length
  const lags = prs.map(p => p.lagMin).filter((x): x is number => x != null && x >= 0).sort((a, b) => a - b)
  const pct = (p: number) => lags.length ? lags[Math.min(lags.length - 1, Math.floor(p * lags.length))] : null
  const data = {
    days, fetchedAt: Date.now(),
    totals: { merged: prs.length, deployed: count('deployed'), deploying: count('deploying'), stuck: count('stuck'), failed: count('failed'), unknown: count('unknown') },
    lag: { p50: pct(0.5), p90: pct(0.9), max: lags.length ? lags[lags.length - 1] : null },
    prs,
  }
  cache = { at: Date.now(), days, data }
  return data
}

// ---------- alert: merged but slow to reach production ----------
// posthog's p50/p90 merge → prod is about 1h, so 3h without every prod region is well outside normal.
// Other repos have no per-environment signal, only the shepherd's stage: give them a day.
export const SLOW_AFTER = { bot: 3 * 3600_000, other: STUCK_AFTER }
const WATCH_DAYS = 7 // older merges are history, not alerts
export const deployKey = (url: string) => `deploy:${url}`

export function slowDeploys(prs: any[], now = Date.now()) {
  return prs.filter(p => {
    if (now - p.mergedAt > WATCH_DAYS * 86400_000) return false
    if (p.state === 'failed') return true
    if (p.state === 'deployed' || p.state === 'unknown') return false // no signal is not an alert
    return now - p.mergedAt > (p.source === 'deploy-bot' ? SLOW_AFTER.bot : SLOW_AFTER.other)
  })
}

const envLine = (p: any) => p.envs?.length ? p.envs.map((e: any) => `${e.env}: ${e.status}${e.at ? ` at ${new Date(e.at).toISOString().slice(0, 16)}Z` : ''}`).join(', ') : `shepherd stage only (${p.source ?? 'no source'})`

// Report each slow or failed deploy to Needs me (an agent checks it before it reaches the user),
// and close the ones that have since landed. Stable title and context: polling never resets an item.
export async function checkSlowDeploys(now = Date.now()) {
  const { reportNeed, needByKey, updateNeed, activeNeed } = await import('./needsstore.ts')
  const d = await listDeploys(14)
  const slow = slowDeploys(d.prs, now)
  for (const p of slow) {
    const n = p.url.split('/').pop(), repo = p.repo?.replace(/^PostHog\//, '')
    reportNeed({
      key: deployKey(p.url), source: 'deploy', url: p.url,
      title: `${p.state === 'failed' ? 'Deploy failed' : 'Not in production yet'}: ${repo}#${n} ${p.title}`.slice(0, 240),
      context: [
        `${p.url} merged ${new Date(p.mergedAt).toISOString().slice(0, 16)}Z and is ${p.state === 'failed' ? 'failing to deploy' : 'not live in every production region'}.`,
        `Where it is: ${envLine(p)}.`,
        `Normal for ${p.source === 'deploy-bot' ? 'posthog is about 1h merge → prod (alert after 3h)' : 'this repo: alert after 24h, from the shepherd stage'}.`,
        'Find out why before asking the user: the deploy bot comment\'s charts workflow run (gh run view), argocd app get/history for the service, the Kargo stage, or the version pin that should carry it (gh api repos/<org>/<repo>/compare/<pinned>...<merge sha>).',
        'Resolve with evidence if it is live now. If a deploy is blocked on something only the user can do (approve a promotion, a manual bump PR), say exactly that.',
      ].join('\n'),
    }, now)
  }
  // Landed since: close with the evidence.
  const flagged = new Set(slow.map(p => p.url))
  for (const p of d.prs) {
    if (flagged.has(p.url) || p.state !== 'deployed') continue
    const old = needByKey(deployKey(p.url))
    if (old && activeNeed(old)) updateNeed(old.id, { status: 'resolved', evidence: `Live now: ${envLine(p)}.` }, 'source', now)
  }
  return slow.length
}
