// Who is on each PR right now, Google Docs style: one avatar per agent, each backed by a signal
// that proves it and that expires. Nothing is guessed from rhythm; when a signal goes quiet the
// avatar turns "late" and then disappears, so an avatar never promises work that has stopped.
//
// Signals, best first:
// - StampHog: its review_runs API (status, updated_at); else its 👀 on the PR; else the
//   `stamphog` label, which means it re-reviews on the next push.
// - ReviewHog: its pr_status API (which asks Temporal live); else the PostHog app's 👀.
// - PR shepherd: a run of its task (perch indexes those), then the sticky `<!-- pr-shepherd -->`
//   comment it rewrites each run; the next check is the PR scout's next run.
// - Claude on this Mac: ~/.claude/sessions/<pid>.json (busy/idle, deleted on exit) for a session
//   about this PR.
// - Cloud tasks about this PR: run status plus last activity.
// - Any other bot: its 👀 while it works.
import { recordError } from './errors.ts'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { all } from './db.ts'
import { posthogFetch } from './indexer.ts'
import { settings } from './settings.ts'
import { ghExec, ghPressure } from './gh.ts'
import { isPrScoutName } from './needsprcheck.ts'

const exec = promisify(execFile)
const MIN = 60_000

export type AgentState = 'working' | 'waiting' | 'late'
export type Agent = {
  key: string // stable per agent: stamphog, reviewhog, shepherd, claude:<session>, task:<id>, bot:<login>
  name: string
  avatar?: string // GitHub avatar for bots
  icon?: string // perch's own agent art (web/public/agents)
  brand?: string // perch Brand id
  glyph?: string // fallback icon
  state: AgentState
  status: string // one line: what it is doing / waiting for
  since: number | null // when the proving signal last moved
  next: number | null // when it will look again, if known
  proof: string // where the signal came from, for the tooltip
  conversation?: string
  link?: string
}

type GhPr = { url: string; headRefOid: string; state: string; labels: string[]; eyes: { login: string; avatar: string; at: number }[]
  reviews: { login: string; avatar: string; state: string; at: number; oid: string | null }[]; comments: { login: string; avatar: string; at: number; body: string }[] }

const bare = (login = '') => login.replace(/\[bot\]$/, '')
const parse = (url: string) => { const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/); return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null }

// ---------- GitHub: labels, 👀, reviews and recent comments, 12 PRs per query ----------
async function github(urls: string[]): Promise<Map<string, GhPr>> {
  const out = new Map<string, GhPr>()
  for (let i = 0; i < urls.length; i += 12) {
    const chunk = urls.slice(i, i + 12).map(parse).filter(Boolean) as { owner: string; repo: string; number: number }[]
    const q = `query { ${chunk.map((p, j) => `p${j}: repository(owner: ${JSON.stringify(p.owner)}, name: ${JSON.stringify(p.repo)}) { pullRequest(number: ${p.number}) {
      url state headRefOid labels(first: 20) { nodes { name } }
      reactions(content: EYES, last: 10) { nodes { createdAt user { login avatarUrl } } }
      reviews(last: 12) { nodes { author { login avatarUrl } state submittedAt commit { oid } } }
      comments(last: 25) { nodes { author { login avatarUrl } updatedAt body } } } }`).join('\n')} }`
    try {
      const { stdout } = await ghExec(['api', 'graphql', '-f', `query=${q}`], { maxBuffer: 60e6, timeout: 60_000 })
      const d = JSON.parse(stdout).data ?? {}
      for (const k of Object.keys(d)) {
        const p = d[k]?.pullRequest
        if (!p) continue
        out.set(p.url, {
          url: p.url, headRefOid: p.headRefOid, state: p.state, labels: p.labels.nodes.map((l: any) => l.name),
          eyes: p.reactions.nodes.filter((r: any) => r.user).map((r: any) => ({ login: bare(r.user.login), avatar: r.user.avatarUrl, at: Date.parse(r.createdAt) })),
          reviews: p.reviews.nodes.filter((r: any) => r.author).map((r: any) => ({ login: bare(r.author.login), avatar: r.author.avatarUrl, state: r.state, at: Date.parse(r.submittedAt), oid: r.commit?.oid ?? null })),
          comments: p.comments.nodes.filter((c: any) => c.author).map((c: any) => ({ login: bare(c.author.login), avatar: c.author.avatarUrl, at: Date.parse(c.updatedAt), body: String(c.body ?? '') })),
        })
      }
    } catch (e: any) { lastError = `GitHub: ${String(e.stderr ?? e.message).slice(0, 200)}` }
  }
  return out
}

// ---------- PostHog: StampHog runs, ReviewHog status, the PR scout's schedule ----------
const p = () => `/api/projects/${settings.posthog.projectId}`
const apiCache = new Map<string, { at: number; data: any }>()
async function cached(key: string, ttl: number, fn: () => Promise<any>) {
  const c = apiCache.get(key)
  if (c && Date.now() - c.at < ttl) return c.data
  try { const data = await fn(); apiCache.set(key, { at: Date.now(), data }); return data }
  catch (e: any) { lastError = `PostHog: ${String(e.message).slice(0, 200)}`; return c?.data ?? null }
}
const stamphogRun = (pr: { owner: string; repo: string; number: number }, ttl: number) => cached(`stamp:${pr.owner}/${pr.repo}#${pr.number}`, ttl, async () => {
  const r: any = await posthogFetch(`${p()}/stamphog/review_runs/?repository=${encodeURIComponent(`${pr.owner}/${pr.repo}`)}&pr_number=${pr.number}`)
  return ((r.results ?? r) as any[]).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null
})
const reviewhogStatus = (url: string, ttl: number) => cached(`rh:${url}`, ttl, () => posthogFetch(`${p()}/review_hog/reviews/pr_status/?pr_url=${encodeURIComponent(url)}`))
// The scout that decides which PRs get a shepherd: its next run is the shepherd's next look.
const prScout = () => cached('scout:prs', 10 * MIN, async () => {
  const r: any = await posthogFetch(`${p()}/signals/scout/configs/?limit=200`)
  const s = ((r.results ?? r) as any[]).find(x => isPrScoutName(x.skill_name) || /\bprs?\b.*shepherd|shepherd/i.test(x.description ?? ''))
  return s ? { id: s.id, name: s.display_name || s.skill_name, enabled: s.enabled && s.status === 'active', last: s.last_run_at ? Date.parse(s.last_run_at) : null, every: (s.run_interval_minutes ?? 240) * MIN, cron: s.run_cron_schedule } : null
})

// ---------- Claude sessions on this Mac ----------
const SESSIONS = join(homedir(), '.claude', 'sessions')
export function liveSessions() {
  const out: { pid: number; session: string; busy: boolean; since: number }[] = []
  if (!existsSync(SESSIONS)) return out
  for (const f of readdirSync(SESSIONS)) {
    if (!f.endsWith('.json')) continue
    try {
      const s = JSON.parse(readFileSync(join(SESSIONS, f), 'utf8'))
      try { process.kill(s.pid, 0) } catch { continue } // the file outlives a crash; the process doesn't
      out.push({ pid: s.pid, session: s.sessionId, busy: s.status === 'busy', since: s.statusUpdatedAt ?? s.updatedAt ?? s.startedAt })
    } catch {}
  }
  return out
}

// ---------- putting it together ----------
const SHEPHERD_DONE = /merged|closed|done|abandon|stopp|gave.?up|handed/i
let snapshot = new Map<string, Agent[]>()
const computedAt = new Map<string, number>()
let lastError = ''
let refreshing: Promise<void> | null = null
export const onPresence = new Set<() => void>()

export function presence(url: string): Agent[] { return snapshot.get(url) ?? [] }
export function presenceAll() { return snapshot }
export const presenceError = () => lastError

export function refreshPresence(urls: string[]) {
  // Never rejects: this runs on timers with nobody awaiting it, and an unhandled rejection ends the server.
  if (ghPressure()) return refreshing ?? Promise.resolve() // GitHub budget mostly spent: keep the last snapshot
  refreshing ??= compute([...new Set(urls)]).catch(e => { lastError = String(e?.message ?? e).slice(0, 300); recordError('presence', e, 'Checking who is working on your PRs') }).finally(() => { refreshing = null })
  return refreshing
}

async function compute(urls: string[]) {
  const now = Date.now()
  lastError = ''
  const gh = await github(urls)
  const scout = await prScout()
  const sessions = liveSessions()
  // Conversations about each PR. A conversation linked to many PRs (a sweep, a digest) is not "on" any one of them.
  const rows = all<any>(`select cp.url, cp.created, pr.head, c.id, c.source, c.origin, c.status, c.updated_at, c.branch, coalesce(u.title, c.title, c.first_prompt) title,
      (select count(*) from conversation_prs x where x.conversation_id = c.id) n
    from conversation_prs cp join conversations c on c.id = cp.conversation_id left join user_state u on u.id = c.id left join prs pr on pr.url = cp.url
    where c.updated_at > ? and coalesce(u.state, '') not in ('hidden')`, now - 3 * 86400_000)
  const byUrl = Object.groupBy(rows, (r: any) => r.url) as Record<string, any[]>
  const onIt = (c: any, number: number) => c.created === 1 || (c.head && c.branch === c.head) || new RegExp(`#${number}\\b`).test(String(c.title ?? ''))
  const next = new Map<string, Agent[]>()

  const one = async (url: string) => {
    const pr = parse(url)
    if (!pr) return
    const g = gh.get(url)
    const open = !g || g.state === 'OPEN'
    const agents: Agent[] = []
    const convs = byUrl[url] ?? []
    const posthogRepo = pr.owner.toLowerCase() === 'posthog'
    // Ask the PostHog APIs often only while something is happening on the PR.
    const busy = !!g && (g.eyes.length > 0 || g.comments.some(c => now - c.at < 30 * MIN) || g.reviews.some(r => now - r.at < 30 * MIN))
    const ttl = busy ? 45_000 : 5 * MIN

    // StampHog
    if (posthogRepo && open) {
      const run = await stamphogRun(pr, ttl)
      const eyes = g?.eyes.find(e => e.login === 'stamphog')
      const rev = g?.reviews.filter(r => r.login === 'stamphog').at(-1)
      const avatar = eyes?.avatar ?? rev?.avatar ?? g?.comments.find(c => c.login === 'stamphog')?.avatar
      const base = { key: 'stamphog', name: 'StampHog', icon: '/agents/stamphog.png', avatar, glyph: '✓', link: url }
      const updated = run ? Date.parse(run.updated_at) : 0
      if (run && ['queued', 'reviewing'].includes(run.status)) {
        const stale = now - updated > 45 * MIN
        agents.push({ ...base, state: stale ? 'late' : 'working', status: stale ? `${run.status} but silent for ${Math.round((now - updated) / MIN)}m, may be stuck` : run.status === 'reviewing' ? 'Reviewing for approval' : 'Queued to review', since: updated, next: null, proof: 'StampHog API' })
      } else if (eyes && now - eyes.at < 45 * MIN) {
        agents.push({ ...base, state: 'working', status: 'Reviewing for approval', since: eyes.at, next: null, proof: 'its 👀 on the PR' })
      } else if (g?.labels.includes('stamphog')) {
        const v = run?.status === 'gated' ? 'last run gated by policy' : run?.verdict && run.verdict !== 'none' ? `last verdict: ${run.verdict}` : rev ? `last review ${rev.state.toLowerCase()}` : 'not reviewed yet'
        agents.push({ ...base, state: 'waiting', status: `Re-reviews on the next push · ${v}`, since: updated || rev?.at || null, next: null, proof: '`stamphog` label' + (run ? ' + StampHog API' : '') })
      }
    }

    // ReviewHog
    if (posthogRepo && open) {
      const s = await reviewhogStatus(url, ttl)
      const eyes = g?.eyes.find(e => e.login === 'posthog')
      const avatar = eyes?.avatar ?? g?.reviews.find(r => r.login === 'posthog')?.avatar
      const base = { key: 'reviewhog', name: 'PostHog Review', icon: '/agents/reviewhog.png', avatar, glyph: '◉', link: url }
      if (s && ['queued', 'reviewing', 'resolving'].includes(s.state)) {
        const started = s.latest_resolution?.started_at ? Date.parse(s.latest_resolution.started_at) : null
        agents.push({ ...base, state: 'working', status: s.state === 'resolving' ? 'Checking whether its findings were fixed' : s.state === 'queued' ? 'Queued to review' : 'Reviewing the latest push', since: started ?? now, next: null, proof: 'ReviewHog API (live)' })
      } else if (!s && eyes && now - eyes.at < 45 * MIN) {
        agents.push({ ...base, state: 'working', status: 'Reviewing', since: eyes.at, next: null, proof: 'its 👀 on the PR' })
      }
    }

    // PR shepherd: a run going now, else the state its sticky comment left and when the scout looks next.
    if (open) {
      const runs = convs.filter(c => c.source === 'posthog-task' && /shepherd|babysit/i.test(String(c.title))).sort((a, b) => b.updated_at - a.updated_at)
      const live = runs.find(c => c.status === 'in_progress' || c.status === 'queued')
      const sticky = g?.comments.filter(c => c.body.startsWith('<!-- pr-shepherd -->')).at(-1)
      const m = sticky?.body.match(/PR shepherd:\s*([\w-]+)\*?\*?\s*\(([^,)]+)/)
      const said = m?.[1]?.replace(/_/g, ' ')
      const at = m?.[2] && !Number.isNaN(Date.parse(m[2])) ? Date.parse(m[2]) : sticky?.at ?? runs[0]?.updated_at ?? null
      const scoutNext = scout?.enabled && scout.last ? scout.last + scout.every : null
      const base = { key: 'shepherd', name: 'PR shepherd', icon: '/agents/shepherd.png', glyph: '🐑', conversation: (live ?? runs[0])?.id }
      if (live && now - live.updated_at < 60 * MIN) {
        agents.push({ ...base, state: 'working', status: said ? `Checking now · was ${said}` : 'Checking now', since: live.updated_at, next: null, proof: 'shepherd task is running' })
      } else if (live) {
        agents.push({ ...base, state: 'late', status: `Run open but silent for ${Math.round((now - live.updated_at) / MIN)}m, may be stuck`, since: live.updated_at, next: null, proof: 'shepherd task status' })
      } else if (at && said && !SHEPHERD_DONE.test(said) && scout?.enabled && now - at < 2 * (scout.every ?? 0) + 30 * MIN) {
        const late = scoutNext != null && now > scoutNext + 20 * MIN
        agents.push({ ...base, state: late ? 'late' : 'waiting', status: `${said[0].toUpperCase()}${said.slice(1)}`, since: at, next: scoutNext, proof: `sticky comment${scout ? ` · next check when ${scout.name} runs` : ''}` })
      }
    }

    // Claude on this Mac, in a session about this PR (about only a few PRs, or on its branch).
    for (const s of sessions) {
      const c = convs.find(c => c.id === s.session && onIt(c, pr.number))
      if (!c) continue
      if (!s.busy && now - s.since > 30 * MIN) continue
      agents.push({ key: `claude:${c.id}`, name: 'Claude', brand: 'claude', state: s.busy ? 'working' : 'waiting', status: s.busy ? String(c.title ?? '').replace(/^\[[^\]]*\]\s*/, '').slice(0, 80) : 'Open and idle: waiting on you', since: s.since, next: null, proof: `session pid ${s.pid}`, conversation: c.id })
    }

    // Cloud tasks about this PR (not the shepherd, not review sub-sessions).
    for (const c of convs) {
      if (c.source !== 'posthog-task' || /shepherd|babysit/i.test(String(c.title)) || c.origin === 'review_hog' || !onIt(c, pr.number)) continue
      if (c.status !== 'in_progress' && c.status !== 'queued') continue
      const quiet = now - c.updated_at
      if (quiet > 2 * 3600_000) continue
      agents.push({ key: `task:${c.id}`, name: c.origin === 'slack' ? 'PostHog (Slack)' : 'PostHog task', brand: c.origin === 'slack' ? 'slack' : 'posthog', state: quiet > 60 * MIN ? 'late' : 'working',
        status: quiet > 60 * MIN ? `No activity for ${Math.round(quiet / MIN)}m` : String(c.title ?? '').slice(0, 80), since: c.updated_at, next: null, proof: 'task run status', conversation: c.id })
    }

    // Any other bot with its 👀 up.
    for (const e of g?.eyes ?? []) {
      if (['stamphog', 'posthog'].includes(e.login) || now - e.at > 45 * MIN) continue
      agents.push({ key: `bot:${e.login}`, name: e.login, avatar: e.avatar, glyph: e.login[0]?.toUpperCase(), state: 'working', status: 'Working (👀 on the PR)', since: e.at, next: null, proof: 'its 👀 on the PR', link: url })
    }

    const order = { working: 0, late: 1, waiting: 2 }
    if (agents.length) next.set(url, agents.sort((a, b) => order[a.state] - order[b.state]))
  }
  for (let i = 0; i < urls.length; i += 8) await Promise.all(urls.slice(i, i + 8).map(one))
  // PRs outside this round (another caller's list) keep their entry for 10 minutes, then expire.
  for (const u of urls) computedAt.set(u, now)
  for (const [u, a] of snapshot) if (!urls.includes(u) && !next.has(u) && now - (computedAt.get(u) ?? 0) < 10 * MIN) next.set(u, a)
  const changed = JSON.stringify([...next]) !== JSON.stringify([...snapshot])
  snapshot = next
  if (changed) for (const l of onPresence) l()
}

// The PR scout looks at all your PRs at once, so it shows once, above the list: running now, or when next.
export async function scoutPresence(): Promise<Agent | null> {
  const s = await prScout()
  if (!s) return null
  const runs = await cached('scout:runs', 45_000, () => posthogFetch(`${p()}/signals/scout/runs/?config=${encodeURIComponent(s.id)}`))
  const last = ((runs?.results ?? runs ?? []) as any[])[0]
  const live = last && ['in_progress', 'queued', 'running'].includes(String(last.status ?? last.task_run_status ?? '').toLowerCase())
  const next = s.enabled && s.last ? s.last + s.every : null
  const late = !live && next != null && Date.now() > next + 30 * MIN
  return { key: 'scout', name: s.name, icon: '/agents/scout.png', glyph: '🔭', state: live ? 'working' : late ? 'late' : 'waiting',
    status: !s.enabled ? 'Paused' : live ? 'Looking over your PRs now, picking what to shepherd' : late ? 'Overdue: its last run was a while ago' : `Picks which PRs get a shepherd, every ${Math.round(s.every / 3600_000)}h`,
    since: live ? Date.parse(last.created_at ?? last.started_at ?? '') || null : s.last, next: live ? null : next, proof: 'scout config and runs (PostHog API)' }
}
