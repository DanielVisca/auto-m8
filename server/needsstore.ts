// Durable intervention ledger. Looking at a chat, elapsed time, a started agent or a merged
// linked PR are not proof that its blocker went away. Keep the evidence for every transition.
import { createHash, randomUUID } from 'node:crypto'
import { all, db, get, run, tx } from './db.ts'

db.exec(`create table if not exists needs (
  id text primary key, source_key text unique not null, source text not null,
  conversation_id text, url text, title text not null, context text not null,
  revision text not null, status text not null default 'checking',
  created_at integer not null, updated_at integer not null, checked_at integer,
  next_check_at integer not null, evidence text, human_action text,
  reviewer_id text, lease_until integer, attempts integer not null default 0
);
create index if not exists needs_due on needs(status, next_check_at);
create table if not exists needs_events (
  id integer primary key, need_id text not null, at integer not null,
  status text not null, evidence text not null, actor text not null
);
create index if not exists needs_events_item on needs_events(need_id, at);
create table if not exists needs_sync (key text primary key, value text not null);
create table if not exists needs_runs (id text primary key, started_at integer not null);`)

export type NeedStatus = 'checking' | 'needs_you' | 'agent' | 'resolved' | 'dismissed'
export type Need = {
  id: string; source_key: string; source: string; conversation_id: string | null; url: string | null
  title: string; context: string; revision: string; status: NeedStatus; created_at: number; updated_at: number
  checked_at: number | null; next_check_at: number; evidence: string | null; human_action: string | null
  reviewer_id: string | null; lease_until: number | null; attempts: number
}
export const HOUR = 3600_000
export const activeNeed = (n: Need) => !['resolved', 'dismissed'].includes(n.status)
// chat.ts's runningChats() is an inventory and includes idle/exited processes too.
export const busyChatIds = (rows: { id: string; state: string }[]) => new Set(rows.filter(c => c.state === 'running').map(c => c.id))
export const need = (id: string) => get<Need>('select * from needs where id = ?', id)
export const needByKey = (key: string) => get<Need>('select * from needs where source_key = ?', key)
export const syncValue = (key: string) => get<{ value: string }>('select value from needs_sync where key = ?', key)?.value
export const saveSync = (key: string, value: string) => run('insert into needs_sync values (?, ?) on conflict(key) do update set value = excluded.value', key, value)
const event = (id: string, status: string, evidence: string, actor: string, at = Date.now()) => run('insert into needs_events (need_id, at, status, evidence, actor) values (?, ?, ?, ?, ?)', id, at, status, evidence, actor)

export function reportNeed(input: { key: string; source: string; title: string; context?: string; conversation_id?: string | null; url?: string | null }, now = Date.now()) {
  if (!input.key?.trim() || !input.title?.trim()) throw new Error('A source key and title are required')
  const title = input.title.trim().slice(0, 240), context = (input.context ?? '').slice(0, 12000)
  const revision = createHash('sha256').update(JSON.stringify([title, context, input.url ?? null])).digest('hex')
  const old = needByKey(input.key)
  if (old?.revision === revision) return old // polling never resets cooldowns, dismissals or history
  const id = old?.id ?? randomUUID()
  tx(() => {
    run(`insert into needs (id, source_key, source, conversation_id, url, title, context, revision, created_at, updated_at, next_check_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(source_key) do update set
      title = excluded.title, context = excluded.context, revision = excluded.revision,
      conversation_id = coalesce(excluded.conversation_id, needs.conversation_id), url = excluded.url,
      status = case when needs.status = 'needs_you' then 'needs_you' else 'checking' end,
      updated_at = excluded.updated_at, next_check_at = excluded.next_check_at,
      human_action = case when needs.status = 'needs_you' then needs.human_action else null end,
      reviewer_id = null, lease_until = null`,
    id, input.key, input.source, input.conversation_id ?? null, input.url ?? null, title, context, revision, now, now, now)
    event(id, old?.status === 'needs_you' ? 'needs_you' : 'checking', old ? 'Source changed; checking again. Any confirmed human action stays visible until reviewed.' : 'Captured from source; awaiting review.', 'source', now)
  })
  return need(id)!
}

export function updateNeed(id: string, input: { status: NeedStatus; evidence: string; human_action?: string; reviewer_id?: string; revision?: string }, actor = 'agent', now = Date.now()) {
  const n = need(id)
  if (!n) throw new Error('Unknown Needs me item')
  if (!['checking', 'needs_you', 'agent', 'resolved', 'dismissed'].includes(input.status)) throw new Error('Invalid status')
  if (!input.evidence?.trim()) throw new Error('Evidence is required; starting work is not resolution')
  if (input.status === 'needs_you' && !input.human_action?.trim()) throw new Error('State the concrete action only the user can take')
  if (input.reviewer_id) {
    // The lease schedules another check; it is not the review's identity. A cap failure
    // can close it before Codex continues, and a recorded outcome can have follow-up evidence.
    // For closed leases, also check the last writer: older rows retained reviewer_id even
    // after a user/source update. Those results must not be overwritten by a resumed review.
    const lastActor = n.lease_until ? input.reviewer_id : get<{ actor: string }>('select actor from needs_events where need_id = ? order by at desc, id desc limit 1', id)?.actor
    if (n.reviewer_id !== input.reviewer_id || n.revision !== input.revision || lastActor !== input.reviewer_id) throw new Error('Source changed or review was replaced; read the item again')
  }
  // Unknown/tool failure stays visible and is retried, never converted into "resolved".
  const delay = input.status === 'needs_you' ? 24 * HOUR : input.status === 'checking' ? Math.min(24, 2 ** Math.min(n.attempts, 4)) * HOUR : 4 * HOUR
  tx(() => {
    run(`update needs set status = ?, evidence = ?, human_action = ?, checked_at = ?, updated_at = ?, next_check_at = ?, reviewer_id = ?, lease_until = null where id = ?`,
      input.status, input.evidence.trim().slice(0, 12000), input.human_action?.trim().slice(0, 1000) ?? null, now, now, now + delay, input.reviewer_id ?? null, id)
    event(id, input.status, input.evidence.trim().slice(0, 12000), input.reviewer_id ?? actor, now)
  })
  return need(id)!
}

export function recheckNeed(id: string, now = Date.now(), reason = 'Requested another check.') {
  const old = need(id)
  if (!old) throw new Error('Unknown Needs me item')
  const status = old.status === 'needs_you' ? 'needs_you' : 'checking'
  const evidence = old.status === 'needs_you' && old.evidence ? `${reason}\nPrevious evidence: ${old.evidence}`.slice(0, 12000) : reason
  run(`update needs set status = ?, next_check_at = ?, reviewer_id = null, lease_until = null, updated_at = ?, evidence = ? where id = ?`, status, now, now, evidence, id)
  event(id, status, reason, 'user', now)
}

export function needsList() {
  const items = all<Need>(`select * from needs where status not in ('resolved', 'dismissed') order by case status when 'needs_you' then 0 when 'checking' then 1 else 2 end, created_at`)
  const history = all<Need>(`select * from needs where status in ('resolved', 'dismissed') order by updated_at desc limit 100`)
  return { items, history, counts: { needs_you: items.filter(n => n.status === 'needs_you').length, checking: items.filter(n => n.status === 'checking').length, agent: items.filter(n => n.status === 'agent').length }, sync: { cloudAt: Number(syncValue('cloudAt') ?? 0), cloudError: syncValue('cloudError') ?? null } }
}
export const needHistory = (id: string) => all('select * from needs_events where need_id = ? order by at, id', id)

export function claimNeeds(reviewer: string, busy: Set<string>, maxRuns: number, now = Date.now()) {
  let claimed: Need[] = []
  tx(() => {
    if (get('select 1 from needs where lease_until > ?', now)) return
    if (all('select 1 from needs_runs where started_at > ?', now - 24 * HOUR).length >= maxRuns) return
    claimed = all<Need>(`select * from needs where status not in ('resolved', 'dismissed') and next_check_at <= ? order by next_check_at, created_at`, now)
      .filter(n => !n.conversation_id || !busy.has(n.conversation_id)).slice(0, 6)
    if (!claimed.length) return
    run('insert into needs_runs values (?, ?)', reviewer, now)
    for (const n of claimed) {
      run('update needs set reviewer_id = ?, lease_until = ?, attempts = attempts + 1, next_check_at = ? where id = ?', reviewer, now + HOUR, now + HOUR, n.id)
      event(n.id, n.status, 'Agent started a check.', reviewer, now)
    }
  })
  return claimed.map(n => need(n.id)!)
}

export function finishReview(reviewer: string, why: string, now = Date.now()) {
  for (const n of all<Need>('select * from needs where reviewer_id = ? and lease_until is not null', reviewer)) {
    // A failed recheck must not hide an already confirmed human action.
    updateNeed(n.id, { status: n.status, evidence: why, human_action: n.human_action ?? undefined, reviewer_id: reviewer, revision: n.revision }, reviewer, now)
  }
}
