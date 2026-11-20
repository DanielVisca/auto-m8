// Source adapters are read-only. In particular, neither an API error nor a report disappearing
// from a filtered page means resolved. Existing cloud items are fetched by id on every pass.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { all, get } from './db.ts'
import { toItems } from './transcript.ts'
import { settings } from './settings.ts'
import { ownerName } from './owner.ts'
import { activeNeed, needByKey, reportNeed, saveSync, syncValue, updateNeed, type Need } from './needsstore.ts'

export function blockerText(text: string) {
  const me = ownerName().replace(/[^\w ]/g, '')
  return new RegExp(String.raw`\b(?:needs? (?:you|human|${me})|requires? (?:human|your)|waiting (?:on|for) (?:you|human|${me})|blocked (?:on|by|until)|cannot (?:proceed|continue)|can't (?:proceed|continue)|only (?:you|the user) can|human (?:approval|input)|please (?:approve|decide|sign in|unlock))\b|requires_human_input|NEEDS HELP:`, 'i').test(text)
}
// One ledger item per PR: every shepherd run (local chat or cloud task) for the same PR reports
// into it, instead of each run adding a duplicate (posthog#120731 had 6 on 2026-11-19).
const SHEPHERD_TITLE = /^(?:☁\s*)?(?:PR shepherd|Shepherd): (?:PostHog\/)?([\w.-]+)#(\d+)\s*$/
export const chatNeedKey = (id: string, ...titles: (string | null | undefined)[]) => {
  for (const t of titles) { const m = t?.trim().match(SHEPHERD_TITLE); if (m) return `pr:PostHog/${m[1]}#${m[2]}` }
  return `chat:${id}`
}

export function blockerTitle(text: string, fallback: string) {
  const explicit = [...text.matchAll(/(?:^|\n)\s*(?:\*\*)?NEEDS (?:YOU|HELP):\s*([^\n]+)/gi)].at(-1)?.[1]
  if (explicit) return explicit.replace(/\*\*/g, '').slice(0, 240)
  const shepherd = fallback.match(/You are the shepherd for ([\w/#.-]+)/)?.[1]
  if (shepherd) return `PR shepherd: ${shepherd}`
  if (/You are a helper/.test(fallback)) return text.split('\n').find(l => blockerText(l))?.slice(0, 240) ?? 'Helper needs a check'
  return fallback
}
function lastReply(r: any) {
  if (r.source === 'posthog-task') return String(r.summary ?? '')
  let fd: number | undefined
  try {
    fd = openSync(r.path, 'r')
    const size = fstatSync(fd).size, start = Math.max(0, size - 512_000), buffer = Buffer.alloc(size - start)
    const length = readSync(fd, buffer, 0, buffer.length, start)
    let text = buffer.subarray(0, length).toString('utf8')
    if (start) text = text.slice(text.indexOf('\n') + 1) // discard a partial JSONL record
    const last = toItems(text).at(-1)
    return last?.kind === 'assistant' ? last.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').slice(-12000) : ''
  } catch { return '' }
  finally { if (fd !== undefined) closeSync(fd) }
}
const hasTable = (name: string) => !!get('select 1 from sqlite_master where type = ? and name = ?', 'table', name)

export function captureLocalNeeds(busy: Set<string>, now = Date.now()) {
  // Scan indexed conversations (including automated and archived ones), not the UI's filtered list.
  // Save the revision even for non-blockers, so quiet transcripts are read just once per change.
  const candidates = all<any>(`select c.*, coalesce(u.title, a.title, c.title, c.first_prompt) display_title, p.by started_by from conversations c left join perch_started p on p.id = c.id left join user_state u on u.id = c.id left join auto_titles a on a.id = c.id
    where c.updated_at > ? and c.updated_at < ? and (c.path is not null or c.summary is not null)
    and coalesce(p.by, '') != 'needs-review' order by c.updated_at desc`, now - 14 * 86400_000, now - 5 * 60_000)
  let scanned = 0
  for (const c of candidates) {
    if (busy.has(c.id) || ['queued', 'in_progress'].includes(c.status)) continue
    const version = `${c.updated_at}:${createHash('sha1').update(c.summary ?? '').digest('hex')}`
    if (syncValue(`chat:${c.id}`) === version) continue
    if (++scanned > 80) break
    const text = lastReply(c)
    saveSync(`chat:${c.id}`, version)
    const title = blockerTitle(text, c.display_title ?? 'Blocked work')
    const key = chatNeedKey(c.id, title, c.display_title)
    if (blockerText(text)) reportNeed({ key, source: c.source === 'posthog-task' ? `PostHog ${c.origin ?? 'task'}` : c.started_by ?? 'chat', title, context: text, conversation_id: c.id, url: c.url }, now)
    else {
      const old = needByKey(`chat:${c.id}`) ?? (key !== `chat:${c.id}` ? needByKey(key) : undefined)
      // A changed reply may contain the resolution. It still needs a check, never silently closes.
      if (old && activeNeed(old) && text) reportNeed({ key: old.source_key, source: old.source, title: old.title, context: text, conversation_id: c.id, url: c.url }, now)
    }
  }
  for (const c of all<any>(`select c.*, coalesce(u.title, c.title, c.first_prompt) display_title from conversations c join user_state u on u.id = c.id where u.state = 'waiting' and coalesce(u.state_auto, 0) != 1`)) {
    const key = chatNeedKey(c.id, c.display_title)
    if (!busy.has(c.id) && !needByKey(key)) reportNeed({ key, source: 'waiting chat', title: c.display_title ?? 'Waiting chat', context: lastReply(c) || 'Chat explicitly marked waiting; check whether it still needs the user.', conversation_id: c.id, url: c.url }, now)
  }
  if (hasTable('attention')) for (const a of all<any>('select * from attention where verdict = 1')) {
    const c = get<any>('select title, url from conversations where id = ?', a.id)
    // Explicit flags cover cases the phrase detector misses. A richer transcript wins.
    if (!needByKey(`chat:${a.id}`)) reportNeed({ key: `chat:${a.id}`, source: 'attention', title: a.reason ?? c?.title ?? 'Needs a check', context: a.reason ?? '', conversation_id: a.id, url: c?.url }, now)
  }
  if (hasTable('decisions')) for (const d of all<any>(`select * from decisions where status = 'open' or updated_at > ?`, now - 14 * 86400_000)) {
    if (d.stakes === 'low' && !needByKey(`decision:${d.id}`)) continue
    const old = needByKey(`decision:${d.id}`)
    if (d.status === 'resolved') {
      if (old && activeNeed(old)) updateNeed(old.id, { status: 'resolved', evidence: `Decision source resolved: ${d.answer ?? 'condition cleared'}` }, 'source', now)
    } else if (d.status === 'open' || old) reportNeed({ key: `decision:${d.id}`, source: d.source ?? 'decision', title: d.title,
      context: `${d.context ?? ''}\nRecommendation: ${d.recommendation ?? ''}\nDecision status: ${d.status}${d.answer ? `; answer: ${d.answer}. Check that the work followed through.` : ''}`, conversation_id: d.conversation_id, url: d.url }, now)
  }
  if (hasTable('shepherd_watch')) for (const w of all<any>(`select * from shepherd_watch where stage = 'needs-you' or paused_reason like '%human%' or paused_reason like '%needs you%'`)) {
    reportNeed({ key: `shepherd:${w.url}`, source: 'shepherd', title: `Unblock ${w.url.replace('https://github.com/', '').replace('/pull/', '#')}`, context: [w.stage, w.paused_reason, w.outcome].filter(Boolean).join('\n'), conversation_id: w.conversation_id, url: w.url }, now)
  }
}

export function captureScoutReport(r: any, scope: string, base: string, now = Date.now()) {
  const key = `report:${scope}:${r.id}`, old = needByKey(key)
  if (['resolved', 'suppressed', 'deleted'].includes(r.status)) {
    if (old && activeNeed(old)) updateNeed(old.id, { status: r.status === 'resolved' ? 'resolved' : 'dismissed', evidence: `PostHog report is ${r.status}${r.dismissal_note ? `: ${r.dismissal_note}` : ''}. ${base}/inbox/${r.id}` }, 'PostHog', now)
    return
  }
  if (!old && r.actionability !== 'requires_human_input' && r.status !== 'pending_input') return
  reportNeed({ key, source: `PostHog scout${r.scout_name ? ` · ${r.scout_name}` : ''}`, title: r.title ?? 'Scout needs input',
    context: `${r.summary ?? ''}\nSource status: ${r.status}; actionability: ${r.actionability ?? 'unknown'}${r.implementation_pr_url ? `\nImplementation: ${r.implementation_pr_url}` : ''}`,
    url: `${base}/inbox/${r.id}`, conversation_id: r.assignee?.task_id ? `task:${r.assignee.task_id}` : null }, now)
}

export function captureApproval(a: { id: string; owner: string; what: string; url: string; state: string }) {
  const key = `browser:${a.id}`, old = needByKey(key)
  if (a.state === 'pending') reportNeed({ key, source: 'browser approval', title: `Approve or decline ${a.what}`, context: `An explicit browser approval is pending (${a.id}). Check whether the underlying work can proceed safely without it; never bypass this gate.`, conversation_id: a.owner, url: a.url })
  else if (old && activeNeed(old)) updateNeed(old.id, { status: 'resolved', evidence: `The user ${a.state} browser approval ${a.id}. The browser wakes the owning agent to continue.` }, 'browser')
}

let cloudBusy = false
export async function syncScoutNeeds(fetch: (path: string) => Promise<any>, now = Date.now()) {
  const interval = syncValue('cloudError') ? 2 * 60_000 : 15 * 60_000
  if (cloudBusy || now - Number(syncValue('cloudAttempt') ?? 0) < interval) return
  cloudBusy = true
  saveSync('cloudAttempt', String(now))
  const prefix = `/api/projects/${settings.posthog.projectId}`, base = `${settings.posthog.host}/project/${settings.posthog.projectId}`
  const scope = `${new URL(settings.posthog.host).host}/${settings.posthog.projectId}`
  const pages = async (first: string, max = 3) => {
    let next: string | null = first
    const rows: any[] = []
    for (let i = 0; next && i < max; i++) {
      const d: any = await fetch(next)
      rows.push(...(Array.isArray(d) ? d : d.results ?? []))
      const u: URL | null = d.next ? new URL(d.next, settings.posthog.host) : null
      if (u && u.origin !== new URL(settings.posthog.host).origin) throw new Error('Unexpected PostHog pagination host')
      next = u ? u.pathname + u.search : null
    }
    return { rows, next }
  }
  try {
    const me = await fetch('/api/users/@me/')
    const configs = await pages(`${prefix}/signals/scout/configs/?limit=200`, 10)
    if (configs.next) throw new Error('Scout ownership list incomplete; retrying later')
    const mine = new Set(configs.rows.filter(s => Number(s.created_by?.id ?? s.created_by) === Number(me.id) || (s.owners ?? []).some((o: any) => Number(o.id ?? o) === Number(me.id))).map(s => s.skill_name))
    const cursor = `cloudCursor:${scope}`
    const first = `${prefix}/signals/reports/?actionability=requires_human_input&include_all_statuses=true&include_unlisted=true&include_source_metadata=true&ordering=-updated_at&limit=100`
    const result = await pages(syncValue(cursor) || first)
    for (const r of result.rows) if (mine.has(r.scout_name) || r.is_suggested_reviewer === true) captureScoutReport(r, scope, base, now)
    saveSync(cursor, result.next ?? '')
    // Revalidate oldest checked first; an unchanged source still advances its sync cursor.
    const known = all<Need>(`select * from needs where source_key like ? and status not in ('resolved', 'dismissed')`, `report:${scope}:%`)
      .sort((a, b) => Number(syncValue(`reportChecked:${a.id}`) ?? 0) - Number(syncValue(`reportChecked:${b.id}`) ?? 0)).slice(0, 20)
    const errors: string[] = []
    for (const n of known) {
      try { captureScoutReport(await fetch(`${prefix}/signals/reports/${n.source_key.split(':').at(-1)}/?include_source_metadata=true`), scope, base, now) }
      catch (e) { errors.push(String(e).slice(0, 250)) }
      saveSync(`reportChecked:${n.id}`, String(now))
    }
    saveSync('cloudAt', String(now)); saveSync('cloudError', errors.join('; ').slice(0, 1000))
  } catch (e) { saveSync('cloudError', String(e).slice(0, 1000)) }
  finally { cloudBusy = false }
}
