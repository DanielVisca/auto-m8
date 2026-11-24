// GitHub through the gh CLI, for the background syncs (PR status, the shepherd).
//
// Two things went wrong before this existed:
// - gh exits non-zero when any alias in a batched GraphQL query fails (one deleted PR, one repo you
//   lost access to), even though stdout still holds the data for every other PR. The whole batch
//   was thrown away, every tick, so 39 good PRs never updated because of one bad one.
// - When api.github.com was unreachable (VPN, wifi), every sync kept firing and failing on its own
//   schedule. Now the first connection failure pauses GitHub calls with a growing back-off.
import { execFile } from 'node:child_process'
import { span } from './latency.ts'
import { promisify } from 'node:util'
import { recordError, resolveErrors } from './errors.ts'

const exec = promisify(execFile)

export const NETWORK = /error connecting to|TLS handshake timeout|connection reset|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|i\/o timeout|no such host|network is unreachable|Client\.Timeout|context deadline exceeded/i
// GitHub's answers when a budget is spent. GraphQL (5,000 points/hour) and REST core (5,000
// requests/hour) are separate budgets shared by every tool on the account, so one used-up budget
// pauses only the calls that spend it. Secondary limits (too many at once) pause everything briefly.
export const RATE_LIMIT = /API rate limit (already )?exceeded|graphql_rate_limit|secondary rate limit|abuse detection/i

// Back-off while GitHub can't be reached: 1, 2, 4 ... up to 15 minutes, cleared by any success.
let offlineUntil = 0
let failures = 0
export const ghOffline = () => Date.now() < offlineUntil || ghLimited('graphql') > 0
export function noteGhNetworkFailure() { failures++; offlineUntil = Date.now() + Math.min(15, 2 ** (failures - 1)) * 60_000 }
export function noteGhOk() { failures = 0; offlineUntil = 0 }
// The error gh() throws for a call it skipped because an earlier call already found GitHub unreachable.
export const isGhSkippedOffline = (e: unknown) => /skipped, api\.github\.com was unreachable/.test(String((e as any)?.message ?? e))
export const ghBackoff = () => ({ failures, until: offlineUntil, limited: { ...limitedUntil } })

// ---------- rate limits: pause until the reset, and count who spends the budget ----------
// Which budget a gh command spends. gh pr/issue/repo view use GraphQL; gh api <path> uses REST core;
// gh search uses REST search (30/minute); auth and local commands spend nothing.
export type GhResource = 'graphql' | 'core' | 'search' | 'none'
export function resourceOf(args: string[]): GhResource {
  const [a, b] = args
  if (a === 'api') return b === 'graphql' ? 'graphql' : /^\/?search\//.test(b ?? '') ? 'search' : b === 'rate_limit' ? 'none' : 'core'
  if (a === 'search') return 'search'
  if (a === 'auth' || a === 'version' || a === 'config') return 'none'
  return 'graphql'
}
const limitedUntil: Record<string, number> = {}
// When a budget is spent, until when (ms) perch leaves it alone; 0 if it isn't.
export const ghLimited = (r: GhResource) => Math.max(limitedUntil[r] ?? 0, limitedUntil.all ?? 0) > Date.now() ? Math.max(limitedUntil[r] ?? 0, limitedUntil.all ?? 0) : 0
export function noteGhRateLimited(r: GhResource, until: number) {
  const key = r === 'none' ? 'all' : r
  limitedUntil[key] = Math.max(limitedUntil[key] ?? 0, until)
  console.log(`[gh] ${key} rate limit hit; pausing those GitHub calls until ${new Date(limitedUntil[key]).toLocaleTimeString()}`)
}
export const clearGhRateLimits = () => { for (const k of Object.keys(limitedUntil)) delete limitedUntil[k] }

// Calls per perch module per hour (last 24h): which part of perch spends GitHub's budget.
type Tally = { calls: number; failed: number; limited: number; skipped: number; byResource: Record<string, number> }
const usage = new Map<number, Map<string, Tally>>()
const HOUR = 3600_000
function callerOf(stack = new Error().stack ?? ''): string {
  for (const line of stack.split('\n').slice(1)) {
    const f = line.match(/\/server\/([\w.-]+)\.ts:/)?.[1]
    if (f && f !== 'gh') return f
  }
  return 'other'
}
function tally(caller: string, r: GhResource, kind: 'ok' | 'failed' | 'limited' | 'skipped') {
  const h = Math.floor(Date.now() / HOUR) * HOUR
  if (!usage.has(h)) { usage.set(h, new Map()); for (const k of usage.keys()) if (k < h - 24 * HOUR) usage.delete(k) }
  const m = usage.get(h)!
  const t = m.get(caller) ?? { calls: 0, failed: 0, limited: 0, skipped: 0, byResource: {} }
  if (kind === 'skipped') t.skipped++
  else { t.calls++; t.byResource[r] = (t.byResource[r] ?? 0) + 1; if (kind === 'failed') t.failed++; if (kind === 'limited') { t.failed++; t.limited++ } }
  m.set(caller, t)
}
// What GitHub said about the GraphQL budget at the last probe.
export type GhBudget = { limit: number; used: number; remaining: number; resetAt: number; at: number }
let lastBudget: GhBudget | null = null
// True once most of this hour's GraphQL budget is gone (>= 70% used, per a probe less than 10 minutes
// old and still inside GitHub's window). Optional pollers (orchestra watches, presence) skip their
// tick while it holds, so perch doesn't spend the budget down to zero and stall the shepherd.
export function ghPressure(now = Date.now()): boolean {
  const b = lastBudget
  return !!b && b.limit > 0 && now - b.at < 10 * 60_000 && b.resetAt > now && b.used / b.limit >= 0.7
}
export const setGhBudgetForTest = (b: GhBudget | null) => { lastBudget = b }
export function ghUsage() {
  const hours = [...usage].sort(([a], [b]) => b - a).map(([hour, m]) => ({
    hour, total: [...m.values()].reduce((s, t) => s + t.calls, 0),
    callers: [...m].map(([caller, t]) => ({ caller, ...t })).sort((a, b) => b.calls - a.calls),
  }))
  return { graphql: lastBudget, limited: Object.fromEntries(Object.entries(limitedUntil).filter(([, u]) => u > Date.now())), hours }
}

// When a budget runs out, ask GitHub when it resets (these probes are free) and pause until then.
async function resetFor(r: GhResource, said: string): Promise<number> {
  const fallback = Date.now() + (/secondary|abuse/i.test(said) ? 60_000 : 5 * 60_000)
  try {
    if (r === 'graphql') { const b = await probeGraphql(); if (b && b.remaining === 0) return b.resetAt + 5_000 }
    else if (r === 'core' || r === 'search') {
      const j = JSON.parse((await exec('gh', ['api', 'rate_limit'], { timeout: 15_000 })).stdout)
      const x = j?.resources?.[r]; if (x && x.remaining === 0) return x.reset * 1000 + 5_000
    }
  } catch {}
  return fallback
}
// The GraphQL budget, read from the response headers (they're sent even when it's spent).
export async function probeGraphql(): Promise<GhBudget | null> {
  let out = ''
  try { out = (await exec('gh', ['api', 'graphql', '-i', '-f', 'query={ rateLimit { remaining } }'], { timeout: 15_000 })).stdout }
  catch (e: any) { out = String(e?.stdout ?? '') }
  const h = (n: string) => Number(out.match(new RegExp(`^x-ratelimit-${n}:\\s*(\\d+)`, 'im'))?.[1])
  if (!Number.isFinite(h('limit')) || !Number.isFinite(h('reset'))) return null
  lastBudget = { limit: h('limit'), used: h('used'), remaining: h('remaining'), resetAt: h('reset') * 1000, at: Date.now() }
  for (const fn of onGhBudget) try { fn(lastBudget) } catch {}
  return lastBudget
}
export const onGhBudget = new Set<(b: GhBudget) => void>()
// Settings → Health gets a line once 80% of the hour's GraphQL budget is gone, naming the parts of
// perch that made the most calls this hour; it clears once the budget is back under half.
// The budget is shared by every tool on the account (agents running gh, editors, CI tokens), so the
// line says who spent it: when auto-m8's own GraphQL calls in GitHub's window are under half the points
// used, it's other tools, which no change to perch fixes (self-fix leaves those alone).
export function budgetNotice(b: GhBudget): string | null {
  if (!b.limit || b.used / b.limit < 0.8) return null
  const hours = ghUsage().hours
  const top = hours[0]?.callers.slice(0, 4).map(c => `${c.caller} ${c.calls}`).join(', ')
  const windowStart = b.resetAt - HOUR
  const mine = hours.filter(h => h.hour + HOUR > windowStart).reduce((s, h) => s + h.callers.reduce((t, c) => t + (c.byResource.graphql ?? 0), 0), 0)
  const used = `${b.used.toLocaleString()} of ${b.limit.toLocaleString()} GitHub GraphQL points this hour (resets ${new Date(b.resetAt).toLocaleTimeString()})`
  if (mine * 2 < b.used) return `GitHub budget: other tools on your GitHub account have used ${used}; auto-m8 made ${mine.toLocaleString()} GraphQL calls of those, and pauses its own until the reset.${top ? ` auto-m8's calls this hour: ${top}.` : ''}`
  return `GitHub budget: auto-m8's account has used ${used}.${top ? ` auto-m8's calls this hour: ${top}.` : ''}`
}
onGhBudget.add(b => {
  const n = budgetNotice(b)
  if (n) recordError('GitHub budget', new Error(n))
  else if (b.used / b.limit < 0.5) resolveErrors('GitHub budget')
})
let probing: NodeJS.Timeout | null = null
// Probe every 5 minutes once perch has used gh, so a budget heading for empty shows up before it runs out.
function startProbing() {
  if (probing || process.env.PERCH_NO_GH_PROBE) return
  probing = setInterval(() => { probeGraphql().catch(() => {}) }, 5 * 60_000)
  probing.unref?.()
  setTimeout(() => { probeGraphql().catch(() => {}) }, 10_000).unref?.()
}

// Every gh call perch makes goes through here (drop-in for exec('gh', args, opts)): a spent budget
// is skipped without calling GitHub, a rate-limit answer pauses that budget until its reset, and
// each call is counted against the perch module that made it.
export async function ghExec(args: string[], opts: { timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string }> {
  const r = resourceOf(args), caller = callerOf()
  startProbing()
  const until = r === 'none' ? 0 : ghLimited(r)
  if (until) {
    tally(caller, r, 'skipped')
    throw Object.assign(new Error(`gh ${args.slice(0, 2).join(' ')}: skipped, GitHub's ${r} rate limit is used up (auto-m8 resumes at ${new Date(until).toLocaleTimeString()})`), { rateLimited: true, stdout: '', stderr: '' })
  }
  try {
    const out = await span(`gh ${args.filter(a => !a.startsWith('-')).slice(0, 2).join(' ')}`, () => exec('gh', args, opts as any))
    tally(caller, r, 'ok')
    return { stdout: String(out.stdout), stderr: String(out.stderr) }
  } catch (e: any) {
    const said = `${e?.stderr ?? ''} ${e?.stdout ?? ''} ${e?.message ?? ''}`
    if (RATE_LIMIT.test(said) && r !== 'none') {
      tally(caller, r, 'limited')
      // a secondary limit is about bursts, not one budget: pause all of perch's GitHub calls briefly
      noteGhRateLimited(/secondary|abuse/i.test(said) ? 'none' : r, await resetFor(r, said))
    } else tally(caller, r, 'failed')
    throw e
  }
}

// A short error: what gh said, not the 10 KB query it was given (that used to fill the stored
// error detail and push gh's own message off the end).
function ghError(e: any, what: string): Error {
  if (e?.rateLimited) return Object.assign(new Error(String(e.message)), { rateLimited: true })
  const said = String(e?.stderr ?? '').trim() || String(e?.message ?? e).split('\n').slice(1).join(' ').trim()
  return new Error(`${what}: ${e?.killed ? 'timed out. ' : ''}${said.slice(0, 500) || 'failed'}`)
}

async function gh(args: string[], what: string, opts: { timeout?: number; maxBuffer?: number }) {
  if (Date.now() < offlineUntil) throw new Error(`${what}: skipped, api.github.com was unreachable (retrying after ${new Date(offlineUntil).toLocaleTimeString()})`)
  try {
    const r = await ghExec(args, { maxBuffer: opts.maxBuffer ?? 20e6, timeout: opts.timeout ?? 60_000 })
    noteGhOk()
    return { stdout: r.stdout, failed: null as any }
  } catch (e: any) {
    const said = `${e?.stderr ?? ''} ${e?.message ?? ''}`
    if (NETWORK.test(said)) noteGhNetworkFailure()
    return { stdout: String(e?.stdout ?? ''), failed: e }
  }
}

// One GraphQL query. Returns whatever data came back, plus the per-alias errors gh reported.
// Throws only when there is no usable data at all (offline, auth, timeout, malformed query).
export async function ghGraphql(query: string, opts: { timeout?: number; maxBuffer?: number } = {}): Promise<{ data: Record<string, any>; errors: string[] }> {
  const { stdout, failed } = await gh(['api', 'graphql', '-f', `query=${query}`], 'gh api graphql', opts)
  let body: any = null
  try { body = stdout ? JSON.parse(stdout) : null } catch {}
  if (body?.data && typeof body.data === 'object') {
    if (failed) noteGhOk() // reached GitHub; only some aliases failed
    const errors = (body.errors ?? []).map((x: any) => String(x?.message ?? x))
    if (!errors.length && failed) errors.push(String(failed.stderr ?? '').trim())
    return { data: body.data, errors }
  }
  if (failed) throw ghError(failed, 'gh api graphql')
  throw new Error('gh api graphql: empty reply')
}

// Any other gh command, with the same back-off and short errors.
export async function ghJson<T = any>(args: string[], opts: { timeout?: number; maxBuffer?: number } = {}): Promise<T> {
  const what = `gh ${args.slice(0, 2).join(' ')}`
  const { stdout, failed } = await gh(args, what, opts)
  if (failed) throw ghError(failed, what)
  return JSON.parse(stdout) as T
}

export function checkContextFields(pullRequestNumber?: number) {
  const required = pullRequestNumber === undefined ? '' : `isRequired(pullRequestNumber: ${pullRequestNumber})`
  return `totalCount pageInfo { hasNextPage endCursor } nodes {
    ... on CheckRun { name conclusion status completedAt ${required} } ... on StatusContext { context state ${required} }
  }`
}

type CheckContext = { name?: string; conclusion?: string | null; status?: string; completedAt?: string | null; isRequired?: boolean; context?: string; state?: string }
type CheckPage = { nodes: CheckContext[]; totalCount?: number; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
type CheckRollup = { id: string; state?: string | null; contexts: CheckPage }
type CheckSummary = { checks: 'passing' | 'failing' | 'running' | 'cancelled' | 'none'; failing: string[]; pending: string[]; optionalCancelled: string[] }

export function summarizeChecks(rollup: string | null | undefined, contexts: CheckContext[]): CheckSummary {
  const name = (c: CheckContext) => c.name ?? c.context ?? 'unnamed check'
  const failed = (c: CheckContext) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'STALE'].includes(c.conclusion ?? c.state ?? '')
  // GitHub sometimes leaves status IN_PROGRESS after publishing a final result and completion time.
  const pendingCheck = (c: CheckContext) => c.state === 'PENDING' || c.state === 'EXPECTED'
    || (!c.conclusion && !c.completedAt && !!c.status && c.status !== 'COMPLETED')
  const failing = contexts.filter(c => failed(c) || c.conclusion === 'CANCELLED' && c.isRequired !== false)
    .map(c => c.conclusion === 'CANCELLED' ? `${name(c)} (cancelled, ${c.isRequired ? 'required' : 'requirement unknown'})` : name(c))
  const pending = contexts.filter(pendingCheck).map(name)
  const optionalCancelled = contexts.filter(c => c.conclusion === 'CANCELLED' && c.isRequired === false).map(name)
  // A red rollup caused entirely by known optional cancellations is neither green nor a test failure.
  // Unknown states still preserve the aggregate failure instead of silently hiding it.
  const explainedByCancellation = optionalCancelled.length > 0 && contexts.every(c => pendingCheck(c)
    || ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion ?? c.state ?? '')
    || c.conclusion === 'CANCELLED' && c.isRequired === false)
  const red = failing.length > 0 || ['FAILURE', 'ERROR'].includes(rollup ?? '') && !explainedByCancellation
  const checks = red ? 'failing' : pending.length ? 'running' : optionalCancelled.length ? 'cancelled'
    : rollup === 'PENDING' || rollup === 'EXPECTED' ? 'running' : contexts.length ? 'passing' : 'none'
  return { checks, failing, pending, optionalCancelled }
}

// Follow the rollup's node ID, not the PR branch: a push between pages must not mix two heads.
// A missing/error page is not an empty page; callers must not use it to claim CI is green.
//
// PostHog PRs carry 100+ checks, so every read of one cost a second GraphQL call for page two, on
// every shepherd tick and board read (about a third of perch's hourly budget). Once the rollup is
// settled (SUCCESS / FAILURE / ERROR) its contexts don't change until a push or re-run, and either of
// those changes the rollup's id, state or count: so the full list is kept per rollup and reused.
const settledChecks = new Map<string, { at: number; nodes: CheckContext[] }>()
const SETTLED = new Set(['SUCCESS', 'FAILURE', 'ERROR'])
const SETTLED_TTL = 2 * 3600_000 // keyed by rollup id/state/count with every check finished: only a safety net
export const clearCheckCache = () => settledChecks.clear()
export async function checkContexts(rollup: CheckRollup | null | undefined, pullRequestNumber?: number): Promise<CheckContext[]> {
  if (!rollup) return []
  if (!rollup.contexts.pageInfo.hasNextPage) return [...rollup.contexts.nodes]
  const state = String(rollup.state ?? '')
  const key = SETTLED.has(state) && rollup.id ? `${rollup.id}|${state}|${rollup.contexts.totalCount ?? ''}|${pullRequestNumber ?? ''}` : ''
  const hit = key ? settledChecks.get(key) : undefined
  if (hit && Date.now() - hit.at < SETTLED_TTL) return [...hit.nodes]
  const nodes = await allContexts(rollup, pullRequestNumber)
  // A red rollup can still have checks running; only a list with every check finished is final.
  const done = nodes.every(n => n.name !== undefined ? n.status === 'COMPLETED' || !!n.completedAt : !/^(PENDING|EXPECTED)$/.test(String(n.state ?? '')))
  if (key && done) {
    settledChecks.set(key, { at: Date.now(), nodes })
    if (settledChecks.size > 500) for (const [k, v] of settledChecks) if (Date.now() - v.at >= SETTLED_TTL || settledChecks.size > 400) settledChecks.delete(k)
  }
  return [...nodes]
}
async function allContexts(rollup: CheckRollup, pullRequestNumber?: number): Promise<CheckContext[]> {
  let page = rollup.contexts
  const nodes = [...page.nodes]
  const seen = new Set<string>()
  while (page.pageInfo.hasNextPage) {
    const cursor = page.pageInfo.endCursor
    if (!rollup.id || !cursor || seen.has(cursor)) throw new Error('GitHub checks pagination did not advance')
    seen.add(cursor)
    const { data, errors } = await ghGraphql(`{ node(id: ${JSON.stringify(rollup.id)}) {
      ... on StatusCheckRollup { contexts(first: 100, after: ${JSON.stringify(cursor)}) { ${checkContextFields(pullRequestNumber)} } }
    } }`)
    const next = data.node?.contexts
    if (errors.length || !next?.nodes || !next?.pageInfo) throw new Error(`GitHub checks: ${errors.join('; ') || 'missing context page'}`)
    page = next
    nodes.push(...page.nodes)
  }
  return nodes
}

// A batch of `repository { pullRequest }` aliases (p0, p1, ...) for PR urls, split into chunks.
// A chunk that fails as a whole is retried once as two halves, so one slow or oversized PR
// can't keep the others from updating. A chunk that still fails is reported in `failed` and the
// rest carry on; once GitHub is unreachable the remaining chunks are skipped. `missing` lists PRs
// GitHub answered for but doesn't know (deleted, renamed repo, no access).
export async function prBatch(urls: string[], fields: string | ((url: string) => string), opts: { size?: number; timeout?: number } = {}): Promise<{ prs: Map<string, any>; missing: string[]; errors: string[]; failed: Error | null }> {
  const prs = new Map<string, any>()
  const missing: string[] = []
  const errors: string[] = []
  let failed: Error | null = null
  const alias = (u: string, j: number) => {
    const [, owner, repo, , n] = new URL(u).pathname.split('/')
    return `p${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { pullRequest(number: ${Number(n)}) { ${typeof fields === 'function' ? fields(u) : fields} } }`
  }
  const one = async (chunk: string[], split: boolean): Promise<void> => {
    try {
      const { data, errors: errs } = await ghGraphql(`{ ${chunk.map(alias).join('\n')} }`, { timeout: opts.timeout })
      errors.push(...errs)
      chunk.forEach((u, j) => { const pr = data[`p${j}`]?.pullRequest; if (pr) prs.set(u, pr); else missing.push(u) })
    } catch (e: any) {
      if (split && chunk.length > 1 && !ghOffline() && !NETWORK.test(String(e?.message))) {
        const h = Math.ceil(chunk.length / 2)
        await one(chunk.slice(0, h), false)
        await one(chunk.slice(h), false)
        return
      }
      throw e
    }
  }
  const size = opts.size ?? 25
  for (let i = 0; i < urls.length; i += size) {
    try { await one(urls.slice(i, i + size), true) } catch (e: any) { failed = e; if (ghOffline()) break }
  }
  return { prs, missing, errors, failed }
}
