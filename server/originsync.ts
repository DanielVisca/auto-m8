// Reconcile source records, not author names or prose guesses. The inbox can launch a task
// under a different user; the report -> scout relationship still identifies its origin.
import { createHash } from 'node:crypto'
import { all, get, run } from './db.ts'
import { ghJson, ghOffline, prBatch } from './gh.ts'
import { recordError, resolveErrors } from './errors.ts'
import { settings } from './settings.ts'
import { candidatePr, chatSubject, confirmPr, indexLocalOrigin, originFor, originOwner, originRef, parseOriginMarkers, recordOrigin, setOriginOwner, withOriginMarker } from './origin.ts'

type Fetch = (path: string, init?: RequestInit) => Promise<any>
const rows = (d: any): any[] => Array.isArray(d) ? d : d.results ?? []
const scope = () => `${new URL(settings.posthog.host).host}/${settings.posthog.projectId}`
export const cloudSubject = (kind: string, id: string) => `${kind}:${scope()}:${id}`
const digest = (s: string) => createHash('sha256').update(s.trim()).digest('hex')
const state = (key: string) => get<{ value: string }>('select value from work_origin_sync where key = ?', key)?.value
const save = (key: string, value: string) => run('insert into work_origin_sync values (?, ?) on conflict(key) do update set value = excluded.value', key, value)
let cloudBusy = false, githubBusy = false

export async function ensureOriginOwner() {
  if (originOwner()) return originOwner()
  const user = await ghJson<{ login: string }>(['api', 'user'])
  setOriginOwner(user.login)
  return originOwner()
}

// Pagination is bounded per pass and resumed next time; missing/slow source metadata never
// becomes an empty authoritative result. Restrict next links to this configured API host.
export async function cloudPages(fetch: Fetch, first: string, max = 20) {
  const out: any[] = []
  let next: string | null = first
  for (let i = 0; next && i < max; i++) {
    const d = await fetch(next)
    out.push(...rows(d))
    const u: URL | null = d.next ? new URL(d.next, settings.posthog.host) : null
    if (u && u.origin !== new URL(settings.posthog.host).origin) throw new Error('Unexpected pagination host')
    next = u ? u.pathname + u.search : null
  }
  return { rows: out, next }
}

export function indexCloudTask(t: any, me: number, parent?: string) {
  const id = `task:${t.id}`, subject = chatSubject(id)
  if (!parent && t.signal_report) parent = originFor(cloudSubject('report', typeof t.signal_report === 'string' ? t.signal_report : t.signal_report.id))?.subject
  // A marker is a portable reference, not proof of who initiated a foreign task. Only
  // source-system report links or the authenticated creator can establish that ownership.
  if (!parent && t.created_by?.id !== me && t.created_by !== me) return
  const workflow = t.description ? state(`template:${digest(t.description)}`) : undefined
  if (workflow && t.origin_key) {
    const invocation = cloudSubject('workflow-run', t.origin_key)
    recordOrigin(invocation, { parent: parent ?? workflow, kind: 'workflow-run', label: originFor(workflow)?.label, evidence: `Task origin_key ${t.origin_key}; exact published workflow prompt matches ${workflow}` })
    parent = invocation
  }
  const marker = parseOriginMarkers(t.description ?? '')
  if (!parent && marker.length) {
    // A copied marker alone cannot establish ownership: its source must be in our ledger.
    parent = all<any>('select subject, root from work_origins where owner = ?', originOwner())
      .find(o => marker.some(m => m.owner === originOwner() && m.source === originRef(o.subject) && m.root === originRef(o.root)))?.subject
  }
  if (!parent && t.description) parent = state(`template:${digest(t.description)}`)
  if (!parent && t.signal_report) parent = originFor(cloudSubject('report', typeof t.signal_report === 'string' ? t.signal_report : t.signal_report.id))?.subject
  // A task can work on a PR that already exists. Candidate timestamps prevent claiming it.
  const o = recordOrigin(subject, { parent, kind: 'task', label: t.title, evidence: parent ? 'PostHog task linked to its source report or task template' : `PostHog task created_by matches authenticated user ${me}` })
  if (!o) return
  const start = Date.parse(t.latest_run?.created_at ?? t.created_at)
  for (const url of new Set<string>([t.latest_run?.output?.pr_url, ...(t.latest_run?.output?.pr_urls ?? [])].filter(Boolean))) {
    candidatePr(url, subject, start, `PostHog task ${t.id}, run ${t.latest_run?.id}, output PR; PR must be newer than this run`)
  }
}

export function indexScoutReport(report: any, scoutSubject: string) {
  const source = recordOrigin(cloudSubject('report', report.id), { parent: scoutSubject, kind: 'report', label: `Inbox report ${report.id}`, evidence: `PostHog report source scout: ${report.scout_name}` })
  if (!source) return []
  const taskIds = new Set<string>()
  for (const pr of report.pull_requests ?? []) {
    if (pr.attached_by?.kind === 'task' && pr.attached_by.task_id) taskIds.add(pr.attached_by.task_id)
  }
  if (report.assignee?.task_id) taskIds.add(report.assignee.task_id)
  // Only the implementation output, never URLs merely mentioned in a report or a summary.
  if (report.implementation_pr_url) candidatePr(report.implementation_pr_url, source.subject, Date.parse(report.created_at), `PostHog report ${report.id} implementation_pr_url; report predates PR`)
  return [...taskIds]
}

export async function syncCloudOrigins(fetch: Fetch, me: number, force = false) {
  const key = `cloud:${scope()}`
  if (cloudBusy || !force && Date.now() - Number(state(key) ?? 0) < 5 * 60_000) return
  cloudBusy = true
  try {
    await ensureOriginOwner()
    const configs = await cloudPages(fetch, `/api/projects/${settings.posthog.projectId}/signals/scout/configs/?limit=200`)
    // Shared/built-in scouts aren't claimed just because we're a reviewer or one owner.
    const mine = configs.rows.filter(s => s.scout_origin === 'custom' && s.owners?.length === 1 && Number(s.owners[0]?.id ?? s.owners[0]) === me)
    const user = await fetch('/api/users/@me/')
    const flows = await cloudPages(fetch, `/api/projects/${settings.posthog.projectId}/hog_flows/?${new URLSearchParams({ ...(user.uuid ? { created_by: user.uuid } : {}), limit: '100' })}`)
    for (const f of flows.rows.filter(f => f.created_by?.id === me)) {
      const source = recordOrigin(cloudSubject('workflow', f.id), { kind: 'workflow', label: f.name, evidence: `Workflow created_by=${me}` })
      if (!source) continue
      const full = f.actions ? f : await fetch(`/api/projects/${settings.posthog.projectId}/hog_flows/${f.id}/`)
      for (const a of full.actions ?? []) {
        const inputs = a.config?.inputs
        const description = a.config?.template_id === 'template-posthog-create-task' ? inputs?.prompt?.value : undefined
        if (typeof description === 'string' && description.length > 100) save(`template:${digest(description)}`, source.subject)
      }
    }
    for (const s of mine) {
      const source = recordOrigin(cloudSubject('scout', s.id), { kind: 'scout', label: s.skill_name, evidence: `Custom scout exclusively owned by authenticated PostHog user ${me}; config ${s.id}` })
      if (!source) continue
      const cursorKey = `reports:${scope()}:${s.id}`
      const first = `/api/projects/${settings.posthog.projectId}/signals/reports/?${new URLSearchParams({ scout: s.skill_name, has_implementation_pr: 'true', include_all_statuses: 'true', include_unlisted: 'true', include_source_metadata: 'true', ordering: '-updated_at', limit: '100' })}`
      const page = await cloudPages(fetch, state(cursorKey) || first, 3)
      for (const report of page.rows) {
        // The API filter may include a contributing scout. Only claim when the report's
        // actual origin agrees; multi-source or missing metadata remains unconfirmed.
        if (report.scout_name !== s.skill_name) continue
        const parent = cloudSubject('report', report.id)
        for (const taskId of indexScoutReport(report, source.subject)) {
          if (originFor(chatSubject(`task:${taskId}`)) && get('select 1 from conversations where id = ?', `task:${taskId}`)) {
            recordOrigin(chatSubject(`task:${taskId}`), { parent, kind: 'task', evidence: `Report ${report.id} names this task as its implementer` })
            continue
          }
          const t = await fetch(`/api/projects/${settings.posthog.projectId}/tasks/${taskId}/`)
          indexCloudTask(t, me, parent)
          // Index tasks even if the inbox launched them under someone else's account.
          const id = `task:${t.id}`
          run(`insert into conversations (id, source, title, first_prompt, started_at, updated_at, status, url, origin, cwd)
            values (?, 'posthog-task', ?, ?, ?, ?, ?, ?, ?, ?) on conflict(id) do update set title = excluded.title, updated_at = excluded.updated_at, status = excluded.status`,
            id, t.title, t.title, Date.parse(t.created_at), Date.parse(t.last_activity_at ?? t.updated_at), t.latest_run?.status ?? 'not_started',
            `${settings.posthog.host}/project/${settings.posthog.projectId}/tasks/${t.id}`, t.origin_product, t.repository)
          run('insert or ignore into conversation_prs (conversation_id, url, created) values (?, ?, 1)', id, report.implementation_pr_url)
        }
      }
      save(cursorKey, page.next ?? '')
    }
    // Catch up tasks made while this Mac was asleep, even if newer tasks filled the first
    // page of the normal activity sync. Keep the cursor when the per-pass budget is used.
    const taskCursor = `tasks:${scope()}`
    const tasks = await cloudPages(fetch, state(taskCursor) || `/api/projects/${settings.posthog.projectId}/tasks/?created_by=${me}&ordering=-created_at&limit=100&archived=all`, 2)
    for (const t of tasks.rows) indexCloudTask(t, me)
    save(taskCursor, tasks.next ?? '')
    save(key, String(Date.now()))
    resolveErrors('Work origin sources')
  } catch (e) { recordError('Work origin sources', e, 'Reading scout, workflow and report lineage') }
  finally { cloudBusy = false }
}

export function backfillLocalOrigins() {
  for (const c of all<any>(`select id, source, title from conversations where source in ('claude', 'posthog-code')`)) indexLocalOrigin(c.id, c.source, c.title)
  for (const c of all<any>(`select cp.conversation_id, cp.url, c.started_at from conversation_prs cp join conversations c on c.id = cp.conversation_id
    where cp.created = 1 and c.source in ('claude', 'posthog-code')`)) {
    candidatePr(c.url, chatSubject(c.conversation_id), c.started_at, 'Local transcript records PR creation')
  }
}

export async function reconcileOriginPrs(opts: { write?: boolean; limit?: number } = {}) {
  if (githubBusy || ghOffline()) return { checked: 0, tagged: 0 }
  githubBusy = true
  let tagged = 0
  try {
    await ensureOriginOwner()
    const candidates = all<any>(`select c.url, min(c.checked_at) checked from work_origin_candidates c join work_origins o on o.subject = c.source
      group by c.url having checked < ? order by checked, min(case o.kind when 'report' then 0 when 'task' then 1 else 2 end) limit ?`, Date.now() - 10 * 60_000, opts.limit ?? 30)
    const { prs, failed } = await prBatch(candidates.map(c => c.url), 'id body createdAt updatedAt title state isDraft author { login }')
    if (failed) recordError('Work origin PRs', failed, 'Reading PR creation dates and hidden markers')
    else resolveErrors('Work origin PRs')
    for (const [url, p] of prs) {
      try {
        const o = confirmPr(url, p.createdAt, p.author?.login, p.body)
        if (o) {
          const [, owner, repo, , number] = new URL(url).pathname.split('/')
          run(`insert into prs (url, repo, number, title, state, draft) values (?, ?, ?, ?, ?, ?)
            on conflict(url) do update set title = excluded.title, state = excluded.state, draft = excluded.draft`, url, `${owner}/${repo}`, Number(number), p.title, p.state, p.isDraft ? 1 : 0)
          const body = withOriginMarker(p.body ?? '', o)
          if (opts.write && body !== p.body) {
            // Re-read immediately before editing so a shepherd's description edit is not
            // replaced by our earlier snapshot. The only change is the hidden suffix.
            const latest = await ghJson<any>(['api', `repos/${owner}/${repo}/pulls/${number}`])
            const next = withOriginMarker(latest.body ?? '', o)
            if (next !== latest.body) {
              await ghJson(['api', `repos/${owner}/${repo}/pulls/${number}`, '--method', 'PATCH', '-f', `body=${next}`])
              tagged++
            }
          }
        }
        run('update work_origin_candidates set checked_at = ?, error = null where url = ?', Date.now(), url)
      } catch (e: any) {
        run('update work_origin_candidates set checked_at = ?, error = ? where url = ?', Date.now(), String(e.message).slice(0, 500), url)
      }
    }
    return { checked: prs.size, tagged }
  } finally { githubBusy = false }
}

export function originSyncStatus() {
  return { owner: originOwner(), counts: all('select kind, count(*) count from work_origins group by kind'),
    pending: get<any>('select count(distinct url) n from work_origin_candidates where checked_at = 0')?.n ?? 0,
    errors: all('select distinct url, error from work_origin_candidates where error is not null'),
    cloudAt: Number(state(`cloud:${scope()}`) ?? 0) }
}
