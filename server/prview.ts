// The PR side of perch: the sidebar's PR view and each PR's page. GitHub says what exists and
// what is asked of you; perch adds who is working on each one and every conversation about it.
import { recordError } from './errors.ts'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { all, get } from './db.ts'
import { originChain, originFor, originatedPrs, prSubject } from './origin.ts'
import { prBatch, ghExec, ghLimited, ghOffline, ghPressure, notePr, onPrChanged, prKey } from './gh.ts'
import { preview, prWorkers, snoozed } from './pr.ts'
import { areaOf } from './prflow.ts'
import { presence, refreshPresence, scoutPresence } from './presence.ts'
import { sectionsFor, onPrSections } from './prsections.ts'
import { toItems, itemsOf } from './transcript.ts'

const exec = promisify(execFile)
const FIELDS = `url number title isDraft state createdAt updatedAt mergedAt reviewDecision headRefName baseRefName additions deletions
  repository { nameWithOwner } author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  files(first: 40) { nodes { path additions deletions } }
  reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name slug } } } }
  mergeable reviewThreads(first: 60) { nodes { isResolved isOutdated } }`
const since = (days: number) => new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)
// Only your open PRs: review requests and mentions belong to other people's work.
const SEARCHES: Record<string, string | (() => string)> = {
  mine: 'is:pr is:open author:@me archived:false',
}
void since
// One request per search: GitHub refuses the four combined (too heavy), and retries a 5xx.
export const ghTimedOut = (e: any) => !!(e?.killed || e?.signal === 'SIGTERM' || /timed out/i.test(String(e?.stderr ?? e?.message)))
async function gql(query: string) {
  for (let t = 0; ; t++) {
    try { return JSON.parse((await ghExec(['api', 'graphql', '-f', `query=${query}`], { maxBuffer: 30e6, timeout: 90_000 })).stdout).data }
    // A timeout shows up as the process being killed, with nothing on stderr: retry that too.
    catch (e: any) {
      if (!ghTimedOut(e) && !/HTTP 5\d\d/i.test(String(e.stderr ?? e.message))) throw e
      // Out of retries: say it was a timeout (the raw error has an empty stderr and reads as an unknown failure).
      if (t >= 2) throw ghTimedOut(e) ? new Error('gh api graphql timed out after 90s') : e
      await new Promise(r => setTimeout(r, 1200 * (t + 1)))
    }
  }
}
const fetchAll = async () => {
  const [viewer, ...parts] = await Promise.all([gql('query { viewer { login } }'), ...Object.entries(SEARCHES).map(([k, q]) =>
    pages(typeof q === 'function' ? q() : q).then(nodes => [k, { nodes }]))])
  const result: any = { viewer: viewer.viewer, ...Object.fromEntries(parts as any) }
  const existing = new Set(result.mine.nodes.map((p: any) => p.url))
  const missing = originatedPrs().filter(url => !existing.has(url) && get<any>('select state from prs where url = ?', url)?.state === 'OPEN')
  if (missing.length) { const extra = await prBatch(missing, FIELDS); result.mine.nodes.push(...[...extra.prs.values()].filter(p => p.state === 'OPEN')) }
  return result
}

// 25 PRs a page (each with its files): 100 at once is heavy enough that GitHub sometimes times out.
async function pages(q: string) {
  const out: any[] = []
  for (let after: string | null = null, i = 0; i < 8; i++) {
    const d: any = await gql(`query { s: search(query: ${JSON.stringify(q)}, type: ISSUE, first: 25${after ? `, after: ${JSON.stringify(after)}` : ''}) { pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { ${FIELDS} } } } }`)
    out.push(...d.s.nodes)
    for (const n of d.s.nodes) if (n?.url) notePr(n.url, n, 'prview')
    if (!d.s.pageInfo.hasNextPage) break
    after = d.s.pageInfo.endCursor
  }
  return out
}

let cache: { at: number; data: any } | null = null
let inflight: Promise<any> | null = null

// A PR in the list moved (the shepherd, a preview or a board read saw it first): re-read just those PRs
// and patch them into the list, then tell the UI, instead of showing the old state until the 2-minute
// timer. Refetching the whole list on every change cost ~10x the calls (56 open PRs with CI running
// change every few seconds), so changes are batched: one small read at most every 30s.
const pendingKeys = new Set<string>()
let soon: NodeJS.Timeout | null = null, lastSoon = 0
const lists = () => Object.values(cache?.data ?? {}).filter((v: any) => Array.isArray(v?.nodes)) as { nodes: any[] }[]
async function patchChanged() {
  soon = null; lastSoon = Date.now()
  const keys = new Set(pendingKeys); pendingKeys.clear()
  const urls = [...new Set(lists().flatMap(l => l.nodes.map((p: any) => p?.url)).filter((u: string) => u && keys.has(prKey(u))))]
  if (!urls.length || !cache) return
  const { prs } = await prBatch(urls, FIELDS, { size: 20 })
  if (!prs.size || !cache) return
  for (const l of lists()) l.nodes = l.nodes.map((p: any) => prs.get(p?.url) ?? p)
  for (const fn of onPrSections) fn()
}
onPrChanged.add((key, source) => {
  if (source === 'prview' || !cache || ghLimited('graphql') || ghPressure()) return
  if (!lists().some(l => l.nodes.some((p: any) => prKey(p?.url) === key))) return
  pendingKeys.add(key)
  if (soon) return
  soon = setTimeout(() => { patchChanged().catch(() => {}) }, Math.max(1_000, lastSoon + 30_000 - Date.now()))
  soon.unref?.()
})

export async function prSidebar(fresh = false) {
  // With GitHub's budget mostly spent (or paused until its reset, or GitHub unreachable) the last
  // list is served for longer instead of each sidebar poll spending more of it or failing again.
  const maxAge = ghLimited('graphql') || ghOffline() ? Infinity : ghPressure() ? 600_000 : 120_000
  if (cache && (!fresh || maxAge === Infinity) && Date.now() - cache.at < maxAge) return withLive(cache.data)
  inflight ??= fetchAll()
    .then(data => { cache = { at: Date.now(), data }; void refreshPresence(presenceUrls()); return data })
    // A failed refresh keeps the last good list. Without this, a background refresh that
    // failed (nobody awaiting it) was an unhandled rejection, and that ends the server.
    // A skipped call (budget paused until its reset) with a list in hand isn't news: the GitHub budget line says it once.
    .catch(e => { if (!(e?.rateLimited && cache)) recordError('pr-sidebar', e, 'Reading your PRs from GitHub'); if (cache) return cache.data; throw e })
    .finally(() => { inflight = null })
  // Serve the last answer at once while a refresh runs; wait only the first time.
  return withLive(cache && !fresh ? cache.data : await inflight)
}

// Live parts come from perch each time: workers, linked conversations, snoozes.
async function withLive(d: any) {
  const me = d.viewer.login
  const workers = prWorkers()
  const snz = snoozed()
  const convs = new Map(all<any>(`select cp.url, count(*) n, max(c.updated_at) last from conversation_prs cp join conversations c on c.id = cp.conversation_id
    left join user_state u on u.id = c.id where coalesce(u.state, '') != 'hidden' group by cp.url`).map(r => [r.url, r]))
  const shape = (p: any) => {
    const checks = p.commits.nodes[0]?.commit?.statusCheckRollup?.state ?? null
    const req = p.reviewRequests.nodes.map((n: any) => n.requestedReviewer).filter(Boolean)
    const direct = req.some((r: any) => r.__typename === 'User' && r.login === me)
    const teams = req.filter((r: any) => r.__typename === 'Team').map((r: any) => r.name)
    const mine = p.author?.login === me || !!originFor(prSubject(p.url))
    const openThreads = (p.reviewThreads?.nodes ?? []).filter((t: any) => !t.isResolved && !t.isOutdated).length
    // What you'd do next, if anything.
    // "Ready to merge" means the same as the PR page's checklist: approved, green, every thread addressed, no conflicts.
    const action = !mine ? (direct ? 'review it' : teams.length ? `review · ${teams[0].replace(/^Team /, '')}` : null)
      : p.state !== 'OPEN' ? null
      : p.reviewDecision === 'CHANGES_REQUESTED' ? 'changes requested'
      : !p.isDraft && (checks === 'FAILURE' || checks === 'ERROR') ? 'CI is red'
      : !p.isDraft && p.reviewDecision === 'APPROVED' && checks === 'SUCCESS' ? (openThreads ? `approved · ${openThreads} open thread${openThreads > 1 ? 's' : ''}` : p.mergeable === 'CONFLICTING' ? 'approved · conflicts' : 'ready to merge') : null
    const c = convs.get(p.url)
    return { url: p.url, number: p.number, title: p.title, repo: p.repository.nameWithOwner, author: p.author?.login, mine, draft: p.isDraft, state: p.state,
      review: p.reviewDecision, checks, createdAt: Date.parse(p.createdAt), updatedAt: Date.parse(p.updatedAt), mergedAt: p.mergedAt ? Date.parse(p.mergedAt) : null, head: p.headRefName, base: p.baseRefName,
      additions: p.additions, deletions: p.deletions, direct, teams, action, workers: workers[p.url] ?? [], agents: presence(p.url), conversations: c?.n ?? 0, lastTalk: c?.last ?? null, snoozed: snz.has(p.url) }
  }
  const mine = (d.mine.nodes as any[]).filter(p => p?.url).map(p => ({ ...shape(p), area: areaOf(p.repository.nameWithOwner, p.files?.nodes ?? []) }))
  // A perch folder hint per PR, from conversations about only a few PRs (a sweep says nothing).
  const folderOf = new Map(all<any>(`with n as (select conversation_id, count(*) k from conversation_prs group by 1)
    select cp.url, f.name, sum(1.0 / n.k) w from conversation_prs cp join n on n.conversation_id = cp.conversation_id
    join labels l on l.conversation_id = cp.conversation_id join folders f on f.label = l.label where n.k <= 5 group by 1, 2 order by w`).map(r => [r.url, r.name]))
  const sec = sectionsFor(mine.map(p => ({ url: p.url, title: p.title, repo: p.repo, area: p.area, folder: folderOf.get(p.url) ?? null, updatedAt: p.updatedAt })))
  const groups = new Map<string, any[]>()
  for (const p of mine) {
    const name = sec.of(p.url) ?? p.area
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name)!.push(p)
  }
  // Inside a section: what needs you, then agents at work, then the rest by last update; drafts last.
  const rank = (p: any) => (p.action && !p.snoozed ? 0 : p.agents.some((a: any) => a.state !== 'waiting') ? 1 : 2) * 10 + (p.draft ? 1 : 0)
  const sections = [...groups].map(([name, prs]) => {
    const m = sec.meta(name)
    return { id: name, title: name, icon: m?.icon ?? null, ord: m?.ord ?? 999, prs: prs.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt),
      working: prs.filter(p => p.agents.some((a: any) => a.state === 'working')).length, needs: prs.filter(p => p.action && !p.snoozed).length }
  }).sort((a, b) => a.ord - b.ord || b.prs.length - a.prs.length)
  return { me, fetchedAt: cache?.at ?? Date.now(), sorting: sec.sorting, sections, scout: await scoutPresence().catch(() => null) }
}

// Presence for your open PRs and any PR a recent conversation is about, every minute while perch runs.
export function presenceUrls() {
  const mine = (cache?.data?.mine?.nodes ?? []).map((p: any) => p?.url).filter(Boolean)
  const linked = all<any>(`select distinct cp.url from conversation_prs cp join conversations c on c.id = cp.conversation_id
    where c.updated_at > ? order by c.updated_at desc limit 60`, Date.now() - 2 * 86400_000).map(r => r.url)
  return [...new Set([...mine, ...linked])].slice(0, 120)
}
setInterval(() => { if (cache) void refreshPresence(presenceUrls()) }, 60_000).unref()

// What an agent is doing right now: its latest step, from the transcript (or a cloud task's summary).
function latestStep(id: string) {
  const c = get<any>('select path, summary, status from conversations where id = ?', id)
  if (!c) return null
  if (!c.path || !existsSync(c.path)) return c.summary ? String(c.summary).split('\n')[0].slice(0, 160) : null
  try {
    const items = itemsOf(c.path)
    for (let i = items.length - 1; i >= 0; i--) {
      const it: any = items[i]
      if (it.kind !== 'assistant') continue
      for (let j = it.blocks.length - 1; j >= 0; j--) {
        const b = it.blocks[j]
        if (b.type === 'tool') return `${b.name}: ${String(b.input?.description ?? b.input?.command ?? b.input?.file_path ?? b.input?.pattern ?? '').slice(0, 120)}`
        if (b.type === 'text' && b.text.trim()) return b.text.trim().split('\n')[0].slice(0, 160)
      }
    }
  } catch {}
  return null
}

// One PR's page: the preview, plus every agent and conversation on it with what each is doing.
export async function prPage(url: string, maxAge?: number) {
  const p = await preview(url, maxAge)
  if (!presence(url).length) await refreshPresence([url])
  const agents = presence(url).map(a => ({ ...a, now: a.conversation ? latestStep(a.conversation) : null }))
  const conversations = all<any>(`select c.id, coalesce(u.title, c.title, c.first_prompt) title, c.source, c.origin, c.status, c.started_at, c.updated_at, c.stall
    from conversation_prs cp join conversations c on c.id = cp.conversation_id left join user_state u on u.id = c.id
    where cp.url = ? and coalesce(u.state, '') != 'hidden' order by c.updated_at desc limit 40`, url)
    .map(c => ({ ...c, now: latestStep(c.id) }))
  return { ...p, agents, conversations, origin: originChain(prSubject(url)) }
}
