// Listing, searching and organising conversations. States are computed from activity, PRs and
// what you set by hand; labels, snooze and rules sit on top. Everything the UI filters on, the
// brief and the rules use the same `list` function, so a rule is just a saved search.
import './attention.ts' // creates the attention table the list joins
import './decisionstore.ts' // and the decisions table
import { promiseFor } from './promises.ts'
import { randomUUID } from 'node:crypto'
import { chats, runningChats } from './chat.ts'
import { all, get, refreshMeta, run, tx, userWrites, writes } from './db.ts'
import { settings } from './settings.ts'
import { subOf, subs } from './account.ts'
import { originOwner } from './origin.ts'
import { hookSignals } from './hookSignals.ts'

export type Row = Record<string, any>
const DAY = 86400_000

// state_auto: 1 = perch decides, 0 = you set it (sticks), 2 = a rule set it (your next message undoes it)
export function effectiveState(r: Row, live: Set<string>): string {
  if (r.state === 'hidden') return 'hidden'
  const prs: Row[] = (typeof r.prs === 'string' ? JSON.parse(r.prs) : r.prs ?? []).filter((p: Row) => p.created && p.url)
  // Chats perch runs report their own state; for the rest a transcript written to in the
  // last 90 seconds means a terminal or PostHog Code session is working.
  // A Claude Code hook, when there is one, beats the 90-second guess (scripts/perch-hook.sh): a long tool call
  // in a terminal is still running, and a session that hit Stop or a permission prompt is not.
  const hook = hookStatus(r)
  const isLive = live.has(r.id) || hook === 'running' || (['in_progress', 'queued'].includes(r.status) && Date.now() - r.updated_at < 45 * 60_000) ||
    (!hook && r.source !== 'posthog-task' && r.source !== 'import' && !chats.has(r.id) && Date.now() - r.updated_at < 90_000) // a copy from another profile never runs
  if (isLive) return 'running'
  if (r.state === 'later' && r.snooze_until && r.snooze_until <= Date.now()) return 'waiting' // back from snooze
  if (r.state && r.state_auto !== 1) return r.state
  // Finished work leaves the list by itself: when its PRs have all merged or closed, or after
  // 3 quiet days with nothing asked of you. Search still finds it; anything you set wins.
  if (prs.length && prs.every(p => p.state === 'MERGED' || p.state === 'CLOSED')) return 'archived'
  // Red CI or requested changes on a PR it opened is NOT "needs me": perch's shepherd answers those on every
  // agent PR. Counting them put 6 of 12 "waiting on you" on 2026-11-12 on work no human had to touch.
  const age = Date.now() - r.updated_at
  // Needs me = the agent asked you something, or the work stalled and needs you to unstick it.
  if (needsReason(r)) return 'waiting'
  return age < 3 * DAY ? 'active' : 'archived'
}

// The hook signal for a Claude Code session, if it's still the latest word on it. Chats perch runs itself
// report their own state, and the signal is dropped once the transcript was written after it (2s of grace:
// the hook and the transcript write race). "needs_you" is Claude's idle nudge after every finished turn, and
// "done" is every Stop: neither means you're needed, so the judge (attention.ts) decides those, not the hook.
export function hookStatus(r: Row) {
  if (r.source !== 'claude' || chats.has(r.id)) return undefined
  return hookSignals.statusFor(r.id, { transcriptMtime: (r.updated_at ?? 0) - 2000 })
}

// Tasks you asked for (Slack, desktop, web) versus runs that automation started on its own
// (PR shepherds, scouts, workflows). Automated runs stay out of the lists unless you ask.
const HUMAN_ORIGINS = new Set(['slack', 'user_created', 'posthog_ai', 'signals_chat', 'support_reply', null, undefined, ''])
export const isAutomated = (r: Row) => r.source === 'posthog-task' && !HUMAN_ORIGINS.has(r.origin)

// Who started a thread when it wasn't you: helper, shepherd, routine, autopilot, ... or null when it's
// yours. Agent threads stay out of your lists (sidebar, Now, Needs you) and live under "Agent runs".
const AGENT_LABELS = ['shepherd', 'search', 'helper', 'self-fix', 'autopilot', 'orchestrator', 'routine', 'autoresearch']
export function agentKind(r: Row): string | null {
  if (isAutomated(r)) return r.origin ?? 'cloud'
  const ls: string[] = r.labels ?? []
  if (ls.includes('shepherd')) return 'shepherd'
  if (ls.includes('search')) return 'search'
  if (r.started_by && r.started_by !== 'you') return r.started_by
  if (/^You are a helper that conversation /.test(r.first_prompt ?? '')) return 'helper' // a helper started outside perch_started
  if (String(r.cwd ?? '').startsWith('/private/tmp/perch-')) return 'test' // perch's own smoke tests
  return null
}

// Threads perch started before it recorded who started them: work it out once from what's known.
export function backfillStartedBy() {
  const kinds: [string, string][] = [
    ['helper', `id in (select child from delegations)`],
    ['routine', `id in (select conversation_id from routine_runs where conversation_id is not null)`],
    ['autoresearch', `id in (select conversation_id from autoresearch_runs where conversation_id is not null)`],
    ...AGENT_LABELS.map(l => [l, `id in (select conversation_id from labels where label = '${l}')`] as [string, string]),
  ]
  for (const [kind, where] of kinds) try { run(`update perch_started set by = ? where by is null and ${where}`, kind) } catch {}
  run(`update perch_started set by = 'you' where by is null`)
}

// Why a conversation needs you, or null. Only recent conversations count: a stall from last
// month is history, not a to-do.
export function needsReason(r: Row): string | null {
  // A decision in your queue that this conversation owns, however old: it is waiting on you.
  if (r.decision) return `decision: ${r.decision}`
  const age = Date.now() - r.updated_at
  if (r.source === 'posthog-task') {
    if (r.status === 'failed' && age < 3 * DAY) return 'the task failed'
    if (r.status === 'in_progress' && age > 45 * 60_000 && age < 3 * DAY) return 'running but no progress for 45+ minutes'
    return null
  }
  if (age > 3 * DAY) return null
  // Exact, from the Claude Code hook: it is stopped on a permission prompt only you can answer.
  if (hookStatus(r) === 'waiting_permission') {
    const h = hookSignals.get(r.id)
    return `waiting for your permission${h?.message ? `: ${h.message.replace(/^Claude needs your permission to use /i, '')}` : ''}`
  }
  // A trailing "?" or "want me to…" is not a real ask on its own (agents offer things all the time), and a stall
  // is the agent's to resume (main.ts resumes it). Both go through the judge below, which flags only what a human must do.
  // The judgement call: a model read where it ended and thinks you should look (clears when you open it).
  // It expires after a day: a guess nobody acted on for 24h was not really waiting on you.
  if (r.ai_reason && (!r.seen_at || r.seen_at < r.ai_at) && age < DAY) return `auto-m8 flagged: ${r.ai_reason}`
  return null
}

// Browser and model columns read tables other modules create (browser.ts, spend.ts); until both
// exist (tests, first boot) the list leaves them out instead of failing.
const USED_MODELS = `(select group_concat(f || ':' || last) from (select case when um.model like 'claude%' then 'claude' when um.model like 'codex%' then 'codex' else 'ollama' end f, max(um.ts) last
      from usage_msgs um where um.session = c.id and um.model is not null and um.model <> '<synthetic>' group by 1)) used_models,`
let extras: boolean | null = null
// Self drive on (selfdrive.ts creates the table): the row shows a 🚗.
let driveTable = false
const driveCol = () => (driveTable ||= !!get('select 1 from sqlite_master where type = \'table\' and name = \'self_drive\''))
  ? `(select sd.enabled from self_drive sd where sd.id = c.id) self_drive,` : ''
function extraCols(models: boolean) {
  if (!extras) {
    const have = new Set(all<{ name: string }>(`select name from sqlite_master where type = 'table' and name in ('browser_sessions', 'usage_msgs')`).map(t => t.name))
    if (have.size < 2) return ''
    extras = true
  }
  return `${driveCol()}
    -- An Agent Chrome window open for this chat right now (browser.ts deletes the row when it closes).
    exists (select 1 from browser_sessions b where b.owner = c.id) has_browser,
    -- Which model families it has run on, with when each was last used ("claude:1794..,ollama:1794.."),
    -- plus the engine it is set to now (chat_prefs), so the row can stack them with the current one on top.
    ${models ? USED_MODELS : ''}
    (select x.engine from chat_prefs x where x.id = c.id) engine_pref,
    (select x.engine from chat_prefs x where x.id = c.id and coalesce(x.engine, '') not in ('', 'auto') and x.engine not like 'claude:%' and x.engine not like 'codex%') local_engine,`
}
// The same "used_models" for every conversation in one grouped pass. As a per-row subquery it was
// over half of the full-list query (39 of ~70ms on 3,700 conversations); usage is only scanned
// every few minutes, so one pass a minute is as fresh as the data.
let usedModels: { at: number; map: Map<string, string> } | null = null
function usedModelsBySession() {
  if (usedModels && Date.now() - usedModels.at < 60_000) return usedModels.map
  const map = new Map<string, string>()
  try {
    for (const r of all<{ session: string; f: string; last: number }>(`select session, case when model like 'claude%' then 'claude' when model like 'codex%' then 'codex' else 'ollama' end f, max(ts) last
      from usage_msgs where session is not null and model is not null and model <> '<synthetic>' group by 1, 2`)) map.set(r.session, (map.has(r.session) ? map.get(r.session) + ',' : '') + `${r.f}:${r.last}`)
  } catch {} // no usage table yet (tests, first boot)
  usedModels = { at: Date.now(), map }
  return map
}

// Which Claude subscriptions each chat's process ran on (chat_account_span: 'login' is the main
// one, 'login:<id>' the others), most recent first. Only worth showing with more than one set up.
function claudeSubsBySession(only?: string) {
  const map = new Map<string, string[]>()
  try {
    for (const r of all<{ id: string; account: string }>(`select id, account, max(from_ts) last from chat_account_span
        where account like 'login%' ${only ? 'and id = ?' : ''} group by 1, 2 order by last desc`, ...(only ? [only] : [])))
      (map.get(r.id) ?? map.set(r.id, []).get(r.id)!).push(r.account === 'login' ? 'main' : r.account.slice(6))
  } catch {} // no table yet (tests, first boot)
  return map
}
function claudeSubsOf(ids: string[] | undefined) {
  if (!ids?.length || subs().length < 2) return null
  return ids.map((id, i) => ({ id, label: subOf(id).label, current: i === 0 }))
}

const baseSql = (models = true) => `
  select c.*, coalesce(u.title, c.title) title, u.state, u.state_auto, u.pinned, u.note, u.snooze_until, u.seen_at, u.state_at, a.reason ai_reason, a.judged_at ai_at,
    (select coalesce(ps.by, 'you') from perch_started ps where ps.id = c.id) started_by,
    (select title from decisions d where d.conversation_id = c.id and d.status = 'open' and coalesce(d.stakes, 'high') = 'high' order by d.created_at desc limit 1) decision,
    (select json_group_array(json_object('url', cp.url, 'created', cp.created, 'state', p.state, 'draft', p.draft,
        'review', p.review, 'checks', p.checks, 'number', p.number, 'repo', p.repo, 'title', p.title))
      from conversation_prs cp left join prs p on p.url = cp.url where cp.conversation_id = c.id and cp.created = 1) prs,
    (select json_group_array(label) from labels where conversation_id = c.id) labels,
    ${extraCols(models)}
    -- Two indexed counts, not one 'a = id or b = id' (that scanned every link for every row).
    ((select count(*) from links l where l.a = c.id) + (select count(*) from links l where l.b = c.id and l.a <> c.id)) link_count
  from conversations c left join user_state u on u.id = c.id left join attention a on a.id = c.id and a.verdict = 1`

// The folder worth showing under a chat. Perch starts chats in one shared parent folder
// (~/Development), which says nothing, so those show the repo their PRs are in, or nothing.
export function placeOf(r: { cwd?: string | null; prs?: { url?: string }[] }): string | null {
  const cwd = String(r.cwd ?? '').replace(/\/+$/, '')
  const wt = cwd.match(/([^/]+)\/\.perch-worktrees\//)
  if (wt) return wt[1]
  const vague = !cwd || cwd === String(settings.chat.cwd ?? '').replace(/\/+$/, '') || cwd === process.env.HOME
  if (!vague) return cwd.split('/').pop() ?? null
  const repos = new Map<string, number>()
  for (const p of r.prs ?? []) { const m = String(p.url ?? '').match(/github\.com\/[^/]+\/([^/]+)\//); if (m) repos.set(m[1], (repos.get(m[1]) ?? 0) + 1) }
  return [...repos].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

function hydrate(r: Row, live: Set<string>) {
  r.prs = r.prs ? JSON.parse(r.prs).filter((p: Row) => p.url) : []
  r.labels = r.labels ? JSON.parse(r.labels).filter(Boolean) : []
  r.has_browser = !!r.has_browser
  r.self_drive = !!r.self_drive
  // Model families it ran on, current first: the engine it is set to now, then the rest by last use.
  // Usage lags (transcripts are scanned every 10 min), so the pref is what says "current".
  const last = new Map<string, number>()
  for (const part of String(r.used_models ?? '').split(',').filter(Boolean)) { const [f, t] = part.split(':'); last.set(f, Number(t) || 0) }
  if (r.local_engine && !last.has('ollama')) last.set('ollama', 0)
  const pref = String(r.engine_pref ?? '')
  const now = pref.startsWith('claude:') ? 'claude' : pref.startsWith('codex') ? 'codex' : pref && pref !== 'auto' ? 'ollama' : null
  r.models = [...last.keys()].sort((a, b) => (a === now ? -1 : b === now ? 1 : last.get(b)! - last.get(a)!))
  if (now && !r.models.includes(now) && r.models.length) r.models.unshift(now)
  delete r.used_models; delete r.engine_pref
  r.promise = promiseFor(r.id)
  r.where = whereRuns(r)
  r.place = placeOf(r)
  // Search sessions live in the search view; shepherd runs (PR watch, push-through) are automation, not your threads.
  r.agent_kind = agentKind(r)
  r.automated = !!r.agent_kind
  return derive(r, live)
}
// The fields that change when a chat starts or stops running, without re-reading the row.
function derive(r: Row, live: Set<string>) {
  r.effective = effectiveState(r, live)
  // Unread, like an inbox: something arrived after you last opened it. Never-opened threads count
  // only when recent, so years of imported history don't all show up bold. A chat that is still
  // working isn't bold: it lights up once the agent finishes its turn, not on every mid-turn message.
  r.unread = r.effective !== 'running' && (r.seen_at ? r.updated_at > r.seen_at + 2000 : r.updated_at > Date.now() - 2 * 86400_000)
  r.returned = r.state === 'later' && r.snooze_until && r.snooze_until <= Date.now()
  r.reason = r.effective === 'waiting' ? (r.state === 'waiting' ? r.note || 'flagged' : r.returned ? 'back from snooze' : needsReason(r)) : null
  return r
}

// ---------- the query language ----------
// Free words and "quoted phrases" search titles, messages, labels, notes, branches and PR titles.
// Filters: #label  label:x  -#label  in:claude|code|task  state:waiting  repo:posthog  pr:123
//          where:slack|cloud|claude|code|mac|perch|ollama|<task origin>  (where it runs; several are OR'd)
//          project:dash  is:pinned  older:7d  newer:2d
export type Query = {
  terms: string[]; labels: string[]; notLabels: string[]; sources: string[]; states: string[]
  where: string[]; origin?: string; repo?: string; pr?: string; project?: string; pinned?: boolean; olderThan?: number; newerThan?: number; auto?: boolean; any?: boolean
}

const SOURCE_ALIAS: Record<string, string> = { claude: 'claude', cc: 'claude', code: 'posthog-code', 'posthog-code': 'posthog-code', phc: 'posthog-code', task: 'posthog-task', tasks: 'posthog-task', slack: 'posthog-task' }
const STATE_ALIAS: Record<string, string> = { needs: 'waiting', needsme: 'waiting', waiting: 'waiting', running: 'running', active: 'active', later: 'later', snoozed: 'later', idle: 'idle', done: 'done', archived: 'archived', hidden: 'hidden' }
// Where a conversation runs, as a SQL test on the conversations row (c). Anything else is a task
// origin (review_hog, signals_chat, ...), so `where:review_hog` works without listing them all.
const LOCAL_ENGINE = `exists (select 1 from chat_prefs x where x.id = c.id and coalesce(x.engine, '') not in ('', 'auto') and x.engine not like 'claude:%')`
const WHERE_SQL: Record<string, string> = {
  slack: `(c.source = 'posthog-task' and c.origin = 'slack')`,
  cloud: `c.source = 'posthog-task'`, task: `c.source = 'posthog-task'`, tasks: `c.source = 'posthog-task'`,
  claude: `c.source = 'claude'`, cc: `c.source = 'claude'`,
  code: `c.source = 'posthog-code'`, phc: `c.source = 'posthog-code'`,
  mac: `c.source in ('claude', 'posthog-code')`, local: `c.source in ('claude', 'posthog-code')`, laptop: `c.source in ('claude', 'posthog-code')`,
  perch: `exists (select 1 from perch_started x where x.id = c.id)`,
  ollama: LOCAL_ENGINE, model: LOCAL_ENGINE,
}
// A plain-words answer to "where did this run", shown to agents and in search results.
export const whereRuns = (r: Row) => r.source === 'posthog-task' ? (r.origin === 'slack' ? 'cloud task, from Slack' : `cloud task${r.origin ? ` (${r.origin})` : ''}`) : r.source === 'posthog-code' ? 'PostHog Code, on this Mac' : r.source === 'claude' ? 'Claude Code, on this Mac' : String(r.source ?? 'unknown')
const dur = (s: string) => { const m = s.match(/^(\d+)([hdw])$/); return m ? Number(m[1]) * { h: 3600_000, d: DAY, w: 7 * DAY }[m[2] as 'h'] : undefined }

export function parseQuery(input: string): Query {
  const q: Query = { terms: [], labels: [], notLabels: [], sources: [], states: [], where: [] }
  for (const m of input.matchAll(/(-?)(\w+):("[^"]+"|\S+)|(-?)#([\w./-]+)|"([^"]+)"|(\S+)/g)) {
    const [, neg, key, rawVal, hneg, hash, phrase, word] = m
    const val = rawVal?.replace(/^"|"$/g, '').toLowerCase()
    if (hash) (hneg ? q.notLabels : q.labels).push(hash.toLowerCase())
    else if (key === 'label' || key === 'l') (neg ? q.notLabels : q.labels).push(val)
    else if (key === 'in' || key === 'source') { if (SOURCE_ALIAS[val]) q.sources.push(SOURCE_ALIAS[val]) }
    else if (key === 'state' || key === 'is' && STATE_ALIAS[val]) { if (STATE_ALIAS[val]) q.states.push(STATE_ALIAS[val]) }
    else if (key === 'is' && val === 'pinned') q.pinned = true
    else if (key === 'is' && (val === 'auto' || val === 'automated')) q.auto = true
    else if (key === 'is' && val === 'any') q.any = true
    else if (key === 'where' || key === 'on') q.where.push(val.replace(/^#/, '').replace(/^auto-m8$/i, 'perch')) // where:auto-m8 = where:perch (started in the app)
    else if (key === 'origin') q.origin = val
    else if (key === 'repo') q.repo = val
    else if (key === 'pr') q.pr = val.replace(/^#/, '')
    else if (key === 'project' || key === 'cwd') q.project = val
    else if (key === 'older') q.olderThan = dur(val)
    else if (key === 'newer') q.newerThan = dur(val)
    else if (phrase) q.terms.push(`"${phrase.replace(/"/g, '')}"`)
    else if (key) q.terms.push(...`${key} ${rawVal}`.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)) // a colon that isn't a filter
    else if (word) { const w = word.replace(/[^\p{L}\p{N}_-]/gu, ''); if (w) q.terms.push(w) }
  }
  return q
}

const ftsAnd = (terms: string[]) => terms.map(t => (t.startsWith('"') ? t : `"${t}"*`)).join(' AND ')
const ftsOr = (terms: string[]) => terms.map(t => (t.startsWith('"') ? t : `"${t}"*`)).join(' OR ')

// Text relevance per conversation: messages (titles weigh 3x) and meta (labels, notes, PRs, 2x).
// All words must match; if that finds little, any word may match, ranked lower.
function textScores(terms: string[]) {
  const scores = new Map<string, { score: number; snippet?: string }>()
  const add = (rows: Row[], weight: number) => {
    for (const r of rows) {
      const s = -r.rank * weight
      const cur = scores.get(r.id)
      if (!cur || s > cur.score) scores.set(r.id, { score: s, snippet: r.snippet ?? cur?.snippet })
      else if (!cur.snippet && r.snippet) cur.snippet = r.snippet
    }
  }
  const content = (match: string, weight: number) => {
    try {
      add(all(`select id, bm25(search, 0, 3, 1) rank, snippet(search, 2, '«', '»', '…', 12) snippet from search where search match ? order by rank limit 300`, match), weight)
      add(all(`select id, bm25(meta_search) rank from meta_search where meta_search match ? order by rank limit 300`, match), weight * 2)
    } catch {} // a malformed query matches nothing rather than failing the list
  }
  content(ftsAnd(terms), 1)
  if (scores.size < 8 && terms.length > 1) content(ftsOr(terms), 0.35)
  return scores
}

// ---------- focus: one or two areas at a time ----------
// An area is a saved search (#label, project:x, repo:y, or words). While focus is on, lists and
// the home page show only conversations matching an area, plus anything pinned.
let focusCache: { key: string; at: number; ids: Set<string> } | null = null
export function focusIds(): Set<string> | null {
  const f = settings.focus
  if (!f.active || !f.areas.length) return null
  const key = JSON.stringify(f.areas)
  if (focusCache?.key === key && Date.now() - focusCache.at < 5000) return focusCache.ids
  const ids = new Set<string>()
  for (const a of f.areas) for (const c of list({ q: `${a.query} is:any`, limit: 100_000, focus: false }).conversations) ids.add(c.id)
  focusCache = { key, at: Date.now(), ids }
  return ids
}
export const focusWords = () => settings.focus.areas.flatMap(a => parseQuery(a.query).terms.concat(parseQuery(a.query).labels, parseQuery(a.query).repo ?? [], parseQuery(a.query).project ?? []))
  .flatMap(w => w.replace(/"/g, '').toLowerCase().split(/[\s/-]+/)).filter(w => w.length > 3)

// Areas worth focusing on: your labels, the projects and repos you've been busy in.
export function focusSuggestions() {
  const since = Date.now() - 21 * DAY
  const labels = allLabels().slice(0, 10).map(l => ({ name: `#${l.label}`, query: `#${l.label}`, n: l.n, kind: 'label' }))
  const projects = all<Row>(`select cwd, count(*) n from conversations where updated_at > ? and cwd is not null group by cwd order by n desc limit 12`, since)
    .map(r => ({ name: String(r.cwd).split('/').filter(Boolean).pop()!, n: r.n }))
    .filter((p, i, arr) => p.name && !/^(claude-\d+|tmp|var|scratchpad|[0-9a-f-]{30,})$/i.test(p.name) && arr.findIndex(x => x.name === p.name) === i)
    .slice(0, 6).map(p => ({ name: p.name, query: `project:${p.name}`, n: p.n, kind: 'project' }))
  const repos = all<Row>(`select repo, count(*) n from prs where authored = 1 and state = 'OPEN' and repo is not null group by repo order by n desc limit 5`)
    .map(r => ({ name: r.repo, query: `repo:${String(r.repo).split('/')[1]}`, n: r.n, kind: 'repo' }))
  return { labels, projects, repos, current: settings.focus }
}

// When a chat last moved for you: the last message you sent it, or the moment the agent finished
// answering one. Recent sorts by this, so a chat goes to the top when you write and again when the
// answer is done, and doesn't jump around while the agent is mid-turn writing its transcript
// (updated_at). Only perch-run turns count: terminal sessions' transcript turns are backfilled
// lazily and would sink an active one, so those (and chats with no turns) keep updated_at.
export function activityBySession(): Map<string, number> {
  const map = new Map<string, number>()
  try {
    for (const r of all<{ id: string; at: number }>(`select conversation_id id, max(max(sent_at, coalesce(finished_at, 0))) at from turns where source = 'perch' group by 1`)) map.set(r.id, r.at)
  } catch {} // no turns table yet (tests, first boot)
  return map
}
export const activityOf = (r: Row, map: Map<string, number>): number => map.get(r.id) ?? r.updated_at

export function list(input: { q?: string; states?: string[]; source?: string; sort?: string; limit?: number; includeHidden?: boolean; focus?: boolean }) {
  const q = parseQuery(input.q ?? '')
  const where: string[] = []
  const params: any[] = []
  for (const l of q.labels) { where.push('exists (select 1 from labels x where x.conversation_id = c.id and x.label = ?)'); params.push(l) }
  for (const l of q.notLabels) { where.push('not exists (select 1 from labels x where x.conversation_id = c.id and x.label = ?)'); params.push(l) }
  if (q.where.length) {
    where.push('(' + q.where.map(w => WHERE_SQL[w] ?? 'lower(c.origin) = ?').join(' or ') + ')')
    params.push(...q.where.filter(w => !WHERE_SQL[w]))
  }
  if (q.origin) { where.push("exists (select 1 from work_origins o where o.subject = 'chat:' || c.id and o.owner = ?)"); params.push(q.origin === 'me' ? originOwner() : q.origin) }
  const sources = [...q.sources, ...(input.source ? [input.source] : [])]
  if (sources.length) { where.push(`c.source in (${sources.map(() => '?').join(',')})`); params.push(...sources) }
  if (q.repo) { where.push(`exists (select 1 from conversation_prs x where x.conversation_id = c.id and lower(x.url) like ?)`); params.push(`%github.com/%${q.repo}%/pull/%`) }
  if (q.pr) { where.push(`exists (select 1 from conversation_prs x where x.conversation_id = c.id and x.url like ?)`); params.push(`%/pull/${q.pr}`) }
  if (q.project) { where.push('lower(c.cwd) like ?'); params.push(`%${q.project}%`) }
  if (q.olderThan) { where.push('c.updated_at < ?'); params.push(Date.now() - q.olderThan) }
  if (q.newerThan) { where.push('c.updated_at > ?'); params.push(Date.now() - q.newerThan) }

  const scores = q.terms.length ? textScores(q.terms) : null
  if (scores) {
    if (!scores.size) return { conversations: [], counts: {}, query: q, focus: null }
    where.push(`c.id in (${[...scores.keys()].map(() => '?').join(',')})`)
    params.push(...scores.keys())
  }
  const live = new Set(runningChats().filter(c => c.state === 'running').map(c => c.id))
  let rows: Row[]
  if (where.length) {
    // Only the matching ids come from SQL; the rows are the shared hydrated ones. Running the whole
    // list query (a dozen subqueries per row) again for every folder, label and search was a third
    // of the list's cost.
    const byId = everyRow(live) && base!.byId
    rows = []
    for (const { id } of all<{ id: string }>(`select c.id from conversations c where ${where.join(' and ')}`, ...params)) {
      const r = byId.get(id) ?? detail(id) // indexed a moment ago, not in the shared list yet
      if (!r) continue
      const copy = { ...r }
      if (scores) copy.snippet = scores.get(id)?.snippet
      rows.push(copy)
    }
  } else rows = everyRow(live)
  const shared = !where.length

  // Automated runs (shepherds, helpers, routines, scouts, search agents) stay out of your list and
  // your searches: only is:auto, is:any, or an explicit where:/origin:/in:task filter reaches them.
  // counts.auto still says how many matched, so the search can offer to add them.
  const automated = rows.filter(r => r.automated)
  let pool = q.auto ? automated : q.any || q.origin || q.where.length || sources.includes('posthog-task') ? rows : rows.filter(r => !r.automated)
  const focus = input.focus === false ? null : focusIds()
  let hiddenByFocus = 0
  if (focus) {
    const kept = pool.filter(r => focus.has(r.id) || r.pinned)
    hiddenByFocus = pool.filter(r => !['hidden', 'archived'].includes(r.effective)).length - kept.filter(r => !['hidden', 'archived'].includes(r.effective)).length
    pool = kept
  }
  const counts: Record<string, number> = { auto: automated.length }
  for (const r of pool) counts[r.effective] = (counts[r.effective] ?? 0) + 1

  const states = [...q.states, ...(input.states ?? [])]
  let out = states.length ? pool.filter(r => states.includes(r.effective))
    // Searching reaches into the archive; browsing doesn't. Hidden only when asked for.
    : pool.filter(r => r.effective !== 'hidden' && (scores || q.origin || r.effective !== 'archived'))
  if (q.pinned) out = out.filter(r => r.pinned)

  const sort = input.sort ?? 'updated'
  const activity = activityBySession()
  if (scores && (sort === 'relevance' || sort === 'updated')) {
    // Relevance, nudged toward what is recent, live and pinned; done and archived sink.
    const boost: Record<string, number> = { running: 1.4, waiting: 1.4, active: 1.25, later: 1, idle: 0.9, done: 0.75, archived: 0.6 }
    for (const r of out) {
      const ageDays = (Date.now() - r.updated_at) / DAY
      r.score = (scores.get(r.id)?.score ?? 0) * (boost[r.effective] ?? 1) * (r.pinned ? 1.3 : 1) * (r.automated ? 0.5 : 1) * (1 + 1 / (1 + ageDays / 7))
    }
    out.sort((a, b) => b.score - a.score)
  } else {
    const ORDER = ['running', 'waiting', 'active', 'later', 'idle', 'done', 'archived', 'hidden']
    const cmp: Record<string, (a: Row, b: Row) => number> = {
      updated: (a, b) => activityOf(b, activity) - activityOf(a, activity),
      created: (a, b) => b.started_at - a.started_at,
      title: (a, b) => String(a.title ?? a.first_prompt ?? '').localeCompare(String(b.title ?? b.first_prompt ?? '')),
      messages: (a, b) => b.messages - a.messages,
      prs: (a, b) => b.prs.length - a.prs.length || b.updated_at - a.updated_at,
      state: (a, b) => ORDER.indexOf(a.effective) - ORDER.indexOf(b.effective) || b.updated_at - a.updated_at,
    }
    out.sort(cmp[sort] ?? cmp.updated)
    out.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
  }
  return { conversations: out.slice(0, input.limit ?? 400).map(r => ({ ...(shared ? { ...r } : r), activity_at: activityOf(r, activity) }) as Row), counts, query: q, focus: focus ? { areas: settings.focus.areas, hidden: hiddenByFocus } : null }
}

// Every conversation, hydrated: what the sidebar, home, brief and plain lists all start from. One
// page load asks for it several times and every live update asks again, so it's shared until
// something is written here, the running chats change, or two seconds pass (other processes, like
// the MCP server, write to the db too). Shared rows: list() hands callers copies of the ones it returns.
// Rebuilding every row costs ~1-2s on 2,158 conversations (more under load), and with ~40 chats writing
// the old key (every db write) changed on nearly every call: on 2026-11-16 the live server was killed
// three times in 7 minutes frozen inside this rebuild (hydrate, placeOf, whereRuns). Now a write you'd
// see (state, labels, decisions...) or a chat starting/stopping rebuilds at once; background churn
// rebuilds at most every max(2s, 5x the last build), which keeps this under ~20% of the server's time.
// It still froze the server under load: any chat starting or stopping rebuilt every row, and
// background writes rebuilt it inside whichever request came next. Now only a write you'd see
// rebuilds inline. A chat starting or stopping re-derives just its own row. Background churn, other
// processes' writes (pragma data_version) and the clock are served from the rows in hand while one
// rebuild runs after the response; if that changed anything a list shows, onListChange tells the
// open pages to refetch.
type Base = { userWrites: number; writes: number; dataVersion: number; live: Set<string>; at: number; ms: number; rows: Row[]; byId: Map<string, Row>; sig: string }
let base: Base | null = null
let rebuilding: NodeJS.Timeout | null = null
export let listBuilds = 0
export const onListChange = new Set<() => void>()
const dataVersion = () => { try { return Number(get<{ data_version: number }>('pragma data_version')?.data_version ?? 0) } catch { return 0 } }
const signature = (rows: Row[]) => { let h = 0; for (const r of rows) { const s = `${r.id}|${r.updated_at}|${r.effective}|${r.title}|${r.unread}|${r.reason}|${r.pinned}|${r.messages}|${r.labels.length}|${r.prs.length}`; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0 } return `${rows.length}:${h}` }
function build(live: Set<string>): Base {
  const t = performance.now()
  const uw = userWrites, w = writes, dv = dataVersion()
  const rows = all<Row>(baseSql(false))
  const models = usedModelsBySession(), claudeSubs = claudeSubsBySession()
  for (const r of rows) { r.used_models = models.get(r.id); r.claude_subs = claudeSubsOf(claudeSubs.get(r.id)); hydrate(r, live) }
  listBuilds++
  return (base = { userWrites: uw, writes: w, dataVersion: dv, live, at: Date.now(), ms: performance.now() - t, rows, byId: new Map(rows.map(r => [r.id, r])), sig: signature(rows) })
}
function everyRow(live: Set<string>): Row[] {
  if (!base || base.userWrites !== userWrites) return build(live).rows
  if (base.live !== live) {
    for (const id of live) if (!base.live.has(id)) { const r = base.byId.get(id); if (r) derive(r, live) }
    for (const id of base.live) if (!live.has(id)) { const r = base.byId.get(id); if (r) derive(r, live) }
    base.live = live
  }
  const age = Date.now() - base.at
  const dirty = base.writes !== writes || base.dataVersion !== dataVersion()
  if (!rebuilding && ((dirty && age > Math.max(1500, 10 * base.ms)) || age > 30_000)) { // 30s: time-based fields (snoozes, unread)
    rebuilding = setTimeout(() => {
      rebuilding = null
      const before = base?.sig
      try { build(new Set(runningChats().filter(c => c.state === 'running').map(c => c.id))) } catch (e) { console.error('list rebuild', e); return }
      if (base!.sig !== before) onListChange.forEach(f => { try { f() } catch {} })
    }, 0)
  }
  return base.rows
}

export function detail(id: string) {
  const c = get<Row>(`${baseSql()} where c.id = ?`, id)
  if (!c) return null
  c.claude_subs = claudeSubsOf(claudeSubsBySession(id).get(id))
  return hydrate(c, new Set(runningChats().filter(x => x.state === 'running').map(x => x.id)))
}

// ---------- organising ----------
export function setStates(ids: string[], body: { state?: string | null; snoozeDays?: number; snoozeUntil?: number; pinned?: boolean; note?: string }) {
  tx(() => {
    for (const id of ids) {
      run('insert into user_state (id) values (?) on conflict do nothing', id)
      if ('state' in body) {
        const until = body.state === 'later' ? body.snoozeUntil ?? (body.snoozeDays ? Date.now() + body.snoozeDays * DAY : null) : null
        run('update user_state set state = ?, state_auto = ?, snooze_until = ?, state_at = ? where id = ?', body.state ?? null, body.state ? 0 : 1, until, Date.now(), id)
      }
      // Hiding or archiving something yourself unpins it.
      if (body.state === 'hidden' || body.state === 'archived') run('update user_state set pinned = 0 where id = ?', id)
      if ('pinned' in body) run('update user_state set pinned = ? where id = ?', body.pinned ? 1 : 0, id)
      if ('note' in body) { run('update user_state set note = ? where id = ?', body.note ?? null, id); refreshMeta(id) }
    }
  })
}

// Opening a conversation marks it seen, which clears "a reply since you last looked".
export function markSeen(id: string) {
  run('insert into user_state (id, seen_at) values (?, ?) on conflict(id) do update set seen_at = excluded.seen_at', id, Date.now())
}

export function setTitle(id: string, title: string) {
  run('insert into user_state (id, title) values (?, ?) on conflict(id) do update set title = excluded.title', id, title.slice(0, 160))
}

export const normLabel = (l: string) => l.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-').slice(0, 40)

export function editLabels(ids: string[], add: string[] = [], remove: string[] = [], auto = 0) {
  tx(() => {
    for (const id of ids) {
      for (const l of add.map(normLabel).filter(Boolean)) run('insert or ignore into labels (conversation_id, label, auto, created_at) values (?, ?, ?, ?)', id, l, auto, Date.now())
      for (const l of remove.map(normLabel)) run('delete from labels where conversation_id = ? and label = ?', id, l)
      refreshMeta(id)
    }
  })
}

export const allLabels = () => all<{ label: string; n: number; last: number }>('select label, count(*) n, max(created_at) last from labels group by label order by last desc')

// ---------- rules: saved searches that act ----------
export type Rule = { id: string; name: string; query: string; action: 'label' | 'archive' | 'snooze'; value: string | null; enabled: number; last_matched: number | null }

export const listRules = () => all<Rule>('select * from rules order by created_at')
export function saveRule(r: Partial<Rule>) {
  const id = r.id ?? randomUUID()
  run(`insert into rules (id, name, query, action, value, enabled, created_at) values (?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set name = excluded.name, query = excluded.query, action = excluded.action, value = excluded.value, enabled = excluded.enabled`,
    id, r.name ?? r.query, r.query ?? '', r.action ?? 'label', r.value ?? null, r.enabled ?? 1, Date.now())
  applyRules()
  return id
}
export const deleteRule = (id: string) => run('delete from rules where id = ?', id)

// A rule never overrides a state you set by hand, and only acts on conversations that aren't
// already where it would put them, so running it every minute is idempotent.
export function applyRules() {
  let changed = 0
  for (const rule of listRules()) {
    if (!rule.enabled || !rule.query.trim()) continue
    const { conversations } = list({ q: rule.query, limit: 5000 })
    for (const c of conversations) {
      if (rule.action === 'label' && rule.value && !c.labels.includes(normLabel(rule.value))) { editLabels([c.id], [rule.value], [], 1); changed++ }
      if ((rule.action === 'archive' || rule.action === 'snooze') && c.state_auto !== 0 && !['archived', 'later', 'hidden', 'running'].includes(c.effective)) {
        const until = rule.action === 'snooze' ? Date.now() + Number(rule.value || 7) * DAY : null
        run('insert into user_state (id) values (?) on conflict do nothing', c.id)
        run('update user_state set state = ?, state_auto = 2, snooze_until = ?, state_at = ? where id = ?', rule.action === 'archive' ? 'archived' : 'later', until, Date.now(), c.id)
        changed++
      }
    }
    if (conversations.length) run('update rules set last_matched = ? where id = ?', Date.now(), rule.id)
  }
  return changed
}

// Conversations that probably belong together with one, so a label can spread in one click:
// same branch, a shared PR, the same PR repo and branch prefix, or an explicit link.
export function siblings(id: string) {
  const c = get<Row>('select * from conversations where id = ?', id)
  if (!c) return []
  const prefix = c.branch && !['main', 'master', 'HEAD'].includes(c.branch) ? c.branch.split(/[/_-]/).slice(0, 2).join('-') : null
  return all<Row>(`
    select distinct o.id, coalesce(o.title, o.first_prompt) title, o.updated_at, o.branch from conversations o
    where o.id != ? and (
      (? is not null and o.branch = ?)
      or o.id in (select b.conversation_id from conversation_prs a join conversation_prs b on a.url = b.url where a.conversation_id = ?)
      or o.id in (select case when a = ? then b else a end from links where a = ? or b = ?)
      or (? is not null and replace(replace(o.branch, '/', '-'), '_', '-') like ? || '%')
    ) order by o.updated_at desc limit 30`, id, c.branch, c.branch, id, id, id, id, prefix, prefix)
}
