// Free pre-check before model review: PR-shaped Needs me items whose PRs are all merged/closed
// close with GitHub evidence, so the daily review budget goes to items that need judgement.
// Scope stays narrow on purpose: a merged linked PR is NOT proof an arbitrary ask is done.
// Only shepherd items (the ask IS the PR) and PR digests (the ask is reviewing those PRs) qualify.
import { execFile } from 'node:child_process'
import { all } from './db.ts'
import { updateNeed, saveSync, syncValue, HOUR, type Need } from './needsstore.ts'

const PR_URL = /github\.com\/(PostHog\/[\w.-]+)\/pull\/(\d+)/g
const SHORT = /^(?:☁\s*)?(?:PR shepherd: |Shepherd: |Unblock )(?:PostHog\/)?([\w.-]+)#(\d+)\s*$/

// The PR digest scout's name. Any name ending in scout-prs or scout-<anything>-prs counts
// (signals-scout-prs, signals-scout-team-prs, my-scout-prs), so you can name your own.
const SCOUT_NAME = String.raw`[\w-]*scout(?:-[a-z0-9-]+)?-prs`
export const isPrScoutName = (name: string) => /scout(?:-[a-z0-9-]+)?-prs$/.test(String(name ?? '').trim())
const DIGEST_TITLE = new RegExp(`^(?:Scout: ${SCOUT_NAME}\\s*$|PR digest|PR summary)`, 'i')
const DIGEST_PROMPT = new RegExp(`^\\[sandbox_prompt:signals_scout:${SCOUT_NAME}\\]`)
const DIGEST_SOURCE = new RegExp(`${SCOUT_NAME}\\b`)

export type PrRef = { repo: string; number: number }
export type PrState = { state: string; mergedAt?: string | null; closedAt?: string | null }

/** Which PRs decide this item, or null when the item is not PR-shaped enough to auto-close. */
export function prsDeciding(n: Pick<Need, 'source' | 'title' | 'context' | 'url'>): PrRef[] | null {
  const short = n.title.trim().match(SHORT)
  if (short) return [{ repo: `PostHog/${short[1]}`, number: Number(short[2]) }]
  const isShepherd = n.source === 'shepherd' && (n.url ?? '').match(/\/pull\/\d+$/)
  // A digest's ask is "review these PRs". Other asks that merely name the digest scout
  // (e.g. "Scout self-improvement: signals-scout-prs ...") are about the scout, not the PRs.
  const isDigest = DIGEST_TITLE.test(n.title.trim()) || (DIGEST_SOURCE.test(n.source) && DIGEST_PROMPT.test(n.title.trim()))
  if (!isShepherd && !isDigest) return null
  const text = isShepherd ? n.url ?? '' : `${n.title}\n${n.context ?? ''}\n${n.url ?? ''}`
  const refs = new Map<string, PrRef>()
  for (const m of text.matchAll(PR_URL)) refs.set(`${m[1]}#${m[2]}`, { repo: m[1], number: Number(m[2]) })
  return refs.size ? [...refs.values()] : null
}

export function closingEvidence(prs: PrRef[], states: Map<string, PrState>): string | null {
  const lines: string[] = []
  for (const p of prs) {
    const s = states.get(`${p.repo}#${p.number}`)
    if (!s || !['MERGED', 'CLOSED'].includes(s.state)) return null
    lines.push(`https://github.com/${p.repo}/pull/${p.number} is ${s.state}${s.mergedAt ? ` (merged ${s.mergedAt})` : s.closedAt ? ` (closed ${s.closedAt})` : ''}`)
  }
  return `Free GitHub pre-check: every PR this item is about is finished, so the ask is moot. ${lines.join('; ')}. A new problem after merge (verify, regression) comes in as a new item.`
}

const gh = (p: PrRef) => new Promise<PrState | null>(res =>
  execFile('gh', ['pr', 'view', String(p.number), '--repo', p.repo, '--json', 'state,mergedAt,closedAt'], { timeout: 20_000 },
    (err, out) => { try { res(err ? null : JSON.parse(out)) } catch { res(null) } }))

let running = false
export async function precheckPrNeeds(now = Date.now(), lookup = gh) {
  if (running || now - Number(syncValue('prPrecheckAt') ?? 0) < HOUR / 4) return 0
  running = true
  saveSync('prPrecheckAt', String(now))
  let closed = 0
  try {
    const items = all<Need>(`select * from needs where status in ('checking', 'agent') and lease_until is null order by checked_at is not null, checked_at limit 400`)
    const cache = new Map<string, PrState>()
    let calls = 0
    for (const n of items) {
      const prs = prsDeciding(n)
      if (!prs || prs.length > 12) continue
      for (const p of prs) {
        const k = `${p.repo}#${p.number}`
        if (cache.has(k) || calls >= 60) continue
        calls++
        const s = await lookup(p)
        if (s) cache.set(k, s)
      }
      const ev = closingEvidence(prs, cache)
      if (ev) { updateNeed(n.id, { status: 'resolved', evidence: ev }, 'pr-precheck', now); closed++ }
    }
  } finally { running = false }
  return closed
}
