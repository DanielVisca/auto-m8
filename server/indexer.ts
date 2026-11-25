// Keeps the database in step with the transcript folders, PostHog tasks and GitHub PRs.
// Transcripts are read once in full, then only their new bytes as they grow.
import { mkdirSync } from 'node:fs'
import { CURSOR_DB, CURSOR_DIR, syncCursor } from './cursor.ts'
import { profile } from './profile.ts'
import { execFile } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, watch } from 'node:fs'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { all, db, get, refreshMeta, run, tx } from './db.ts'
import { ghJson, ghOffline, prBatch } from './gh.ts'
import { posthogKey } from './keychain.ts'
import { autonomyOn, settings, updateSettings, type Source } from './settings.ts'
import { friendly, recordError, resolveErrors, withRetry } from './errors.ts'
import { autolinkPr } from './prroute.ts'
import { candidatePr, chatSubject, indexLocalOrigin, originFor } from './origin.ts'
import { backfillLocalOrigins, ensureOriginOwner, indexCloudTask, reconcileOriginPrs, syncCloudOrigins } from './originsync.ts'
import { applyLine, asksUser, emptyMeta, readableTitle, stallOf, type Meta } from './transcript.ts'
import { updateSearch } from './searchindex.ts'

const exec = promisify(execFile)
export const onChange = new Set<(what: string) => void>()
export const onTick = new Set<() => void>() // after each sync pass: rules run here
const emit = (what: string) => onChange.forEach(f => f(what))

type Cached = { meta: Meta; offset: number; source: Source }
const cache = new Map<string, Cached>() // transcript path -> parse state for incremental reads

export const indexStatus: Record<string, { files: number; lastScan: number; error?: string }> = {}

function transcripts(source: Source): string[] {
  if (!existsSync(source.dir)) return []
  const out: string[] = []
  for (const project of readdirSync(source.dir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const dir = join(source.dir, project.name)
    for (const f of readdirSync(dir)) if (f.endsWith('.jsonl') && !f.startsWith('agent-')) out.push(join(dir, f))
  }
  return out
}

function readFrom(path: string, from: number, to: number): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(to - from)
    readSync(fd, buf, 0, buf.length, from)
    return buf.toString('utf8')
  } finally { closeSync(fd) }
}

// Parses new complete lines and returns the text, tool calls and PRs they added.
function advance(path: string, source: Source, size: number) {
  let c = cache.get(path)
  if (!c || size < c.offset) { c = { meta: emptyMeta(), offset: 0, source }; cache.set(path, c) }
  const chunk = readFrom(path, c.offset, size)
  const end = chunk.lastIndexOf('\n') + 1 // leave a half-written last line for next time
  for (const line of chunk.slice(0, end).split('\n')) if (line) applyLine(c.meta, line)
  const fresh = c.offset === 0
  c.offset += Buffer.byteLength(chunk.slice(0, end))
  const added = { fresh, text: c.meta.text, tools: c.meta.tools, errors: c.meta.errors }
  // The database holds these from here; keep only counters and titles in memory.
  c.meta.text = []; c.meta.tools = []; c.meta.errors = []
  return { c, added }
}

const BODY_LIMIT = 400_000

type Added = { fresh: boolean; text: string[]; tools: Meta['tools']; errors: string[] }

function persist(path: string, c: Cached, added: Added) {
  const id = basename(path, '.jsonl')
  const m = c.meta
  if (!m.startedAt) return // no real messages yet
  tx(() => {
    run(`insert into conversations (id, source, title, first_prompt, cwd, branch, path, started_at, updated_at, messages, asks, stall)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(id) do update set title = coalesce(excluded.title, (select title from auto_titles a where a.id = conversations.id)), first_prompt = excluded.first_prompt, cwd = excluded.cwd,
           branch = excluded.branch, path = excluded.path, updated_at = excluded.updated_at, messages = excluded.messages, asks = excluded.asks, stall = excluded.stall`,
      id, c.source.id, m.title, m.firstPrompt, m.cwd, m.branch, path, m.startedAt, m.updatedAt, m.messages, asksUser(m) ? 1 : 0, stallOf(m))
    indexLocalOrigin(id, c.source.id, m.title ?? undefined)
    updateSearch([{ id, title: [m.title, m.firstPrompt].filter(Boolean).join(' — '), body: old => {
      const body = (added.fresh ? '' : old) + (added.text.length ? '\n' + added.text.join('\n') : '')
      return body.length > BODY_LIMIT ? body.slice(0, BODY_LIMIT / 2) + '\n…\n' + body.slice(-BODY_LIMIT / 2) : body
    } }])
    if (added.fresh) run('delete from tool_calls where conversation_id = ?', id)
    for (const t of added.tools) {
      const server = t.name.startsWith('mcp__') ? t.name.split('__')[1] : null
      run('insert or ignore into tool_calls (conversation_id, tool_use_id, name, server, ts, is_error, detail) values (?, ?, ?, ?, ?, 0, ?)',
        id, t.id, t.name, server, t.ts, t.detail ?? null)
    }
    for (const e of added.errors) run('update tool_calls set is_error = 1 where tool_use_id = ?', e)
    for (const [url, created] of m.prs) {
      run(`insert into conversation_prs (conversation_id, url, created) values (?, ?, ?)
           on conflict do update set created = max(created, excluded.created)`, id, url, created ? 1 : 0)
      if (created) candidatePr(url, chatSubject(id), m.startedAt!, 'local transcript PR creation result')
      autolinkPr(id, url)
    }
    refreshMeta(id)
    // Copies of one conversation (a resume that started a new file, an import, a branch) share
    // their first message: link them as one lineage instead of letting them look like duplicates.
    if (m.rootUuid) {
      run('update conversations set root_uuid = ? where id = ?', m.rootUuid, id)
      for (const o of all<{ id: string }>('select id from conversations where root_uuid = ? and id != ?', m.rootUuid, id)) {
        if (!get('select 1 from links where (a = ? and b = ?) or (a = ? and b = ?)', id, o.id, o.id, id)) {
          run('insert or ignore into links (a, b, kind, note, created_at) values (?, ?, ?, ?, ?)', id, o.id, 'continues', 'same conversation history (resumed, copied or branched)', Date.now())
        }
      }
    }
  })
}

function indexFile(path: string, source: Source, force = false) {
  const st = statSync(path, { throwIfNoEntry: false })
  if (!st) return false
  const known = get<{ size: number; mtime: number }>('select size, mtime from files where path = ?', path)
  const cached = cache.get(path)
  const unchanged = cached ? cached.offset === st.size : known?.size === st.size && known?.mtime === Math.floor(st.mtimeMs)
  if (!force && unchanged) return false
  if (force) cache.delete(path) // re-parse from the start
  const { c, added } = advance(path, source, st.size)
  persist(path, c, added)
  run('insert into files (path, size, mtime) values (?, ?, ?) on conflict(path) do update set size = excluded.size, mtime = excluded.mtime',
    path, st.size, Math.floor(st.mtimeMs))
  return true
}

// New Codex messages must be searchable before the first reply completes (or the watcher fires).
export function indexTranscript(path: string) {
  const source = allSources().find(s => path.startsWith(s.dir + '/'))
  if (source && indexFile(path, source)) emit('conversations')
}

// Your configured sources, plus Cursor's agent conversations (converted into transcripts by
// cursor.ts) on the Work profile when Cursor is installed.
export const allSources = (): Source[] => [...settings.sources, ...(profile.id === 'work' && existsSync(CURSOR_DB) ? [{ id: 'cursor', label: 'Cursor', dir: CURSOR_DIR, configDir: '' }] : [])]

export function scanAll(force = false) {
  let changed = 0
  if (allSources().some(s => s.id === 'cursor')) try { syncCursor() } catch (e: any) { indexStatus.cursor = { files: 0, lastScan: Date.now(), error: e.message } }
  for (const source of allSources()) {
    try {
      const files = transcripts(source)
      for (const f of files) if (indexFile(f, source, force)) changed++
      indexStatus[source.id] = { files: files.length, lastScan: Date.now() }
    } catch (e: any) {
      indexStatus[source.id] = { files: 0, lastScan: Date.now(), error: e.message }
    }
  }
  if (changed) emit('conversations')
  return changed
}

// fs.watch is recursive on macOS. Bursts of appends collapse into one pass per second.
export function watchSources() {
  const pending = new Map<string, Source>()
  let timer: NodeJS.Timeout | null = null
  for (const source of allSources()) {
    if (source.id === 'cursor') mkdirSync(source.dir, { recursive: true })
    if (!existsSync(source.dir)) continue
    watch(source.dir, { recursive: true }, (_e, file) => {
      if (!file?.endsWith('.jsonl') || file.includes('/subagents/')) return
      pending.set(join(source.dir, file), source)
      timer ??= setTimeout(() => {
        timer = null
        let changed = false
        for (const [p, s] of pending) if (indexFile(p, s)) changed = true
        pending.clear()
        if (changed) emit('conversations')
      }, 1000)
    })
  }
  setInterval(() => scanAll(), 60_000) // catches anything the watcher missed
}

// PostHog tasks: Slack @PostHog requests, desktop tasks, scouts, ReviewHog. Yours only.
export const posthogStatus: { ok: boolean; error?: string; user?: { id: number; email: string }; tasks?: number; lastSync?: number } = { ok: false }

// Every PostHog call retries dropped connections, 429s and 5xx with backoff.
// A project path built before a project was known (/api/projects/undefined/...) is never sent:
// the indexer's next sync picks the key's own project (ensureUser), or you choose one in Settings.
const NO_PROJECT = /^\/api\/projects\/(?:undefined|null|0)?\//
export async function posthogFetch(path: string, init: RequestInit = {}) {
  const key = posthogKey()
  if (!key) throw new Error('No PostHog personal API key (Settings → PostHog)')
  if (NO_PROJECT.test(path)) throw new Error('No PostHog project chosen yet (Settings → PostHog)')
  return withRetry(async () => {
    const res = await fetch(settings.posthog.host + path, { ...init, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...init.headers } })
    if (!res.ok) {
      const err: any = new Error(`PostHog ${res.status}: ${(await res.text()).slice(0, 200)}`)
      err.status = res.status
      err.retryAfter = Number(res.headers.get('retry-after')) || undefined
      throw err
    }
    return res.json()
  })
}

// Who you are in PostHog, fetched once and on demand ("mine" filters depend on it).
export async function ensureUser() {
  if (!posthogStatus.user) posthogStatus.user = await posthogFetch('/api/users/@me/').then((u: any) => {
    // No project chosen yet (a fresh install): use the one the key's owner has open in PostHog.
    if (!settings.posthog.projectId && u.team?.id) updateSettings({ posthog: { ...settings.posthog, projectId: u.team.id } })
    return { id: u.id, email: u.email }
  })
  return posthogStatus.user!
}

const runSeen = new Set<string>()

// When PostHog can't be reached (VPN off, laptop asleep, an outage), the sync pauses and retries
// after a growing wait (1, 2, 4, 8, then 15 minutes) instead of logging one error per tick.
let phFailures = 0, phOfflineUntil = 0
export const posthogBackoff = () => ({ failures: phFailures, until: phOfflineUntil })

export async function syncTasks() {
  if (!posthogKey()) { Object.assign(posthogStatus, { ok: false, error: 'No API key' }); return }
  if (Date.now() < phOfflineUntil) return
  try {
    await ensureUser()
    await syncCloudOrigins(posthogFetch, posthogStatus.user!.id)
    const { host, projectId } = settings.posthog
    const page: any = await posthogFetch(`/api/projects/${projectId}/tasks/?created_by=${posthogStatus.user!.id}&ordering=-last_activity_at&limit=100&basic=true&archived=all`)
    // Basic responses truncate descriptions, including inherited markers. Read a new
    // workflow task once in full before assigning it a root of its own.
    const fresh = (page.results ?? []).filter((t: any) => t.origin_product === 'workflow' && !originFor(chatSubject(`task:${t.id}`)))
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let t; (t = fresh.shift());) {
        try { Object.assign(t, await posthogFetch(`/api/projects/${projectId}/tasks/${t.id}/`)) } catch {} // next sync retries unrecorded tasks
      }
    }))
    const runDetails: { id: string; taskId: string; runId: string; status: string }[] = []
    tx(() => {
      for (const t of page.results ?? []) {
        const id = `task:${t.id}`
        const updated = Date.parse(t.last_activity_at ?? t.latest_run?.completed_at ?? t.updated_at ?? t.created_at)
        run(`insert into conversations (id, source, title, first_prompt, started_at, updated_at, status, url, origin, cwd)
             values (?, 'posthog-task', ?, ?, ?, ?, ?, ?, ?, ?)
             on conflict(id) do update set title = excluded.title, updated_at = excluded.updated_at, status = excluded.status`,
          id, t.title ? readableTitle(t.title).slice(0, 160) : t.title, t.title, Date.parse(t.created_at), updated, t.latest_run?.status ?? 'not_started',
          `${host}/project/${projectId}/tasks/${t.id}`, t.origin_product, t.repository)
        indexCloudTask(t, posthogStatus.user!.id)
        const pr = t.latest_run?.output?.pr_url
        if (pr) run('insert or ignore into conversation_prs (conversation_id, url, created) values (?, ?, 1)', id, pr)
        // PR shepherds and babysitters name their PR as owner/repo#123 or a URL: link it so the PR shows the run.
        for (const m of String(t.title ?? '').matchAll(/(?:github\.com\/)?([\w.-]+)\/([\w.-]+)(?:#|\/pull\/)(\d+)/g)) {
          run('insert or ignore into conversation_prs (conversation_id, url, created) values (?, ?, 0)', id, `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`)
        }
        refreshMeta(id) // so a shepherd task is found by its PR's title
        if (t.latest_run?.id) runDetails.push({ id, taskId: t.id, runId: t.latest_run.id, status: t.latest_run.status })
      }
      updateSearch((page.results ?? []).map((t: any) => ({ id: `task:${t.id}`, title: t.title ?? '', body: t.description_preview ?? t.description ?? '' })))
    })
    // The run holds the Slack thread a task came from and what it cost. Fetch each run once it
    // settles (and while it runs, at most every few minutes).
    for (const r of runDetails.slice(0, 30)) {
      const key = `${r.runId}:${r.status}`
      if (runSeen.has(key)) continue
      try {
        const run_: any = await posthogFetch(`/api/projects/${projectId}/tasks/${r.taskId}/runs/${r.runId}/`)
        run('update conversations set slack_url = coalesce(?, slack_url), cost = ?, summary = coalesce(?, summary) where id = ?', run_.state?.slack_thread_url ?? null, run_.total_spend ?? run_.output?.total_cost ?? null,
          String(run_.task_summary ?? run_.output?.final_message ?? '').slice(0, 3000) || null, r.id)
        if (!['in_progress', 'queued'].includes(r.status)) runSeen.add(key)
      } catch {}
    }
    phFailures = 0; phOfflineUntil = 0
    Object.assign(posthogStatus, { ok: true, error: undefined, tasks: page.count, lastSync: Date.now() })
    resolveErrors('PostHog sync')
    emit('conversations')
  } catch (e: any) {
    if (friendly(e).transient) { phFailures++; phOfflineUntil = Date.now() + Math.min(15, 2 ** (phFailures - 1)) * 60_000 }
    const f = recordError('PostHog sync', e, 'Syncing PostHog tasks')
    Object.assign(posthogStatus, { ok: false, error: f.message })
  }
}

// PR status for PRs touched in the last 30 days, in GraphQL batches of 25. One PR GitHub doesn't
// know (deleted, a repo you lost access to, a number misread from a transcript) no longer sinks its
// batch: the others update, and it is marked gone so it isn't asked for again for a day.
try { db.exec('alter table prs add column gone_at integer') } catch {}
export async function syncPrs() {
  if (ghOffline()) return
  const urls = all<{ url: string }>(`
    select distinct cp.url from conversation_prs cp join conversations c on c.id = cp.conversation_id
    left join prs p on p.url = cp.url
    where c.updated_at > ? and (p.fetched_at is null or p.fetched_at < ? or p.state = 'OPEN') and (p.gone_at is null or p.gone_at < ?)
    union select url from prs where authored = 1 and (state = 'OPEN' or state is null) and (gone_at is null or gone_at < ?)`,
    Date.now() - 30 * 86400_000, Date.now() - 600_000, Date.now() - 86400_000, Date.now() - 86400_000).map(r => r.url)
  if (!urls.length) return
  const { prs, missing, failed } = await prBatch(urls,
    'title state isDraft reviewDecision updatedAt baseRefName headRefName commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }')
  const touched = new Set<string>()
  tx(() => {
    for (const [url, pr] of prs) {
      const [, owner, repo, , n] = new URL(url).pathname.split('/')
      const was = get<{ title: string | null; head: string | null }>('select title, head from prs where url = ?', url)
      run(`insert into prs (url, repo, number, title, state, draft, review, checks, updated_at, fetched_at, base, head) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(url) do update set title = excluded.title, state = excluded.state, draft = excluded.draft, review = excluded.review,
             checks = excluded.checks, updated_at = excluded.updated_at, fetched_at = excluded.fetched_at, base = excluded.base, head = excluded.head, gone_at = null`,
        url, `${owner}/${repo}`, Number(n), pr.title, pr.state, pr.isDraft ? 1 : 0, pr.reviewDecision,
        pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null, Date.parse(pr.updatedAt), Date.now(), pr.baseRefName, pr.headRefName)
      // Search text holds a PR's title, repo and branch: only a change to those is worth re-indexing
      // its conversations. Re-indexing all of them on every sync was 13% of profiled freeze time.
      if (!was || was.title !== pr.title || was.head !== pr.headRefName) for (const r of all<{ conversation_id: string }>('select conversation_id from conversation_prs where url = ?', url)) touched.add(r.conversation_id)
    }
    for (const url of missing) {
      const [, owner, repo, , n] = new URL(url).pathname.split('/')
      run(`insert into prs (url, repo, number, fetched_at, gone_at) values (?, ?, ?, ?, ?) on conflict(url) do update set gone_at = excluded.gone_at, fetched_at = excluded.fetched_at`,
        url, `${owner}/${repo}`, Number(n), Date.now(), Date.now())
    }
  })
  tx(() => touched.forEach(id => refreshMeta(id))) // PR titles and branches are searchable
  if (failed) recordError('GitHub PR status', failed, 'Updating PR status')
  else resolveErrors('GitHub PR status')
  if (prs.size) emit('conversations')
}

// Every open PR you authored, including ones no conversation here knows about.
export async function syncMyPrs() {
  if (ghOffline()) return
  try {
    const open = await ghJson<any[]>(['search', 'prs', '--author=@me', '--state=open', '--limit', '100', '--json', 'url,title,repository,isDraft,updatedAt,number'], { maxBuffer: 10e6, timeout: 45_000 })
    tx(() => {
      run('update prs set authored = 0 where authored = 1')
      for (const p of open) {
        run(`insert into prs (url, repo, number, title, draft, updated_at, authored, state) values (?, ?, ?, ?, ?, ?, 1, 'OPEN')
             on conflict(url) do update set authored = 1, title = excluded.title`, p.url, p.repository?.nameWithOwner, p.number, p.title, p.isDraft ? 1 : 0, Date.parse(p.updatedAt))
      }
    })
  } catch (e: any) { recordError('GitHub PR status', e, 'Listing your open PRs') }
}

// Chats started with a pasted image were named after its path ("- /Users/…/perch/attachments/…") until
// titles learned to skip attachment blocks, and chats started with a shared link after it ("🔗 slack.com/…").
// Re-read those so they take their name from the ask. Links-only chats keep the link, so cap the window.
export function renameAttachmentTitled() {
  const rows = all<{ path: string }>(`select path from conversations where path is not null and (first_prompt like '- /%/perch/attachments/%'
    or (title is null and (first_prompt like '🔗%' or first_prompt like '📄%') and updated_at > ?))`, Date.now() - 30 * 86400_000)
  for (const r of rows) {
    const source = allSources().find(s => r.path.startsWith(s.dir + '/'))
    if (source) try { indexFile(r.path, source, true) } catch {}
  }
  return rows.length
}

export function startIndexer() {
  const t0 = Date.now()
  const renamed = renameAttachmentTitled()
  if (renamed) console.log(`[index] re-read ${renamed} chats named after an attachment path`)
  const n = scanAll()
  console.log(`[index] ${n} transcripts updated in ${Date.now() - t0}ms`)
  watchSources()
  let syncing = false
  const tick = async () => {
    if (syncing) return
    syncing = true
    try {
      await ensureOriginOwner().catch(() => {})
      await syncTasks()
      backfillLocalOrigins()
      await syncMyPrs(); await syncPrs()
      await reconcileOriginPrs({ write: autonomyOn() }).catch(e => recordError('Work origin PRs', e, 'Reconciling hidden origin markers'))
      onTick.forEach(f => f())
    } finally { syncing = false }
  }
  tick()
  setInterval(tick, settings.posthog.pollSeconds * 1000)
}
