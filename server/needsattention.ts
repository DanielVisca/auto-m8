// The user's attention is the scarce resource, and their habits are fixed: we adapt to them.
// No cards, no pings. When they type in a chat, the agent there may get one short note about one
// waiting item and mention it in a sentence. Each source has credit: asks they answer earn it,
// asks that weren't needed (or an agent could have handled) spend it, and asks they ignore cost
// half. Low-credit sources stop reaching him; their items go back to agents to decide or park.
import { all, db, get, run } from './db.ts'
import { HOUR, need, updateNeed, type Need } from './needsstore.ts'
import { convLink } from '../shared/brand.ts'

db.exec(`create table if not exists needs_credit (
  source text primary key, used integer not null default 0, wasted integer not null default 0,
  ignored integer not null default 0, updated_at integer not null
);
create table if not exists needs_surfaced (
  need_id text not null, revision text not null, conversation_id text not null, at integer not null,
  outcome text, outcome_at integer, primary key (need_id, revision)
);`)

export const DAY = 24 * HOUR
export const ATTENTION = {
  perDay: 3, // asks that may reach the user in any 24 hours
  crossChatPerDay: 1, // of those, raised in a chat that doesn't own the item
  ignoredAfter: 72 * HOUR,
  unseenAfter: 7 * DAY, // a needs_you item that never earned a mention is not worth their attention
  minCredit: 0.3, // below this a source's asks never reach them
  crossChatCredit: 0.5,
}
export type Outcome = 'used' | 'wasted' | 'ignored'

// "perch shepherd prod check, cloud-infra#12578" and "... #12482" are one source.
export const sourceFamily = (source: string) => source.replace(/[,(].*$/, '').replace(/\S*#\d+\S*/g, '').replace(/\s+/g, ' ').trim().toLowerCase() || 'unknown'

// Beta(1,1) prior: a new source starts at 0.5. Ignoring counts half of wasting.
export function credit(source: string) {
  const c = get<{ used: number; wasted: number; ignored: number }>('select used, wasted, ignored from needs_credit where source = ?', sourceFamily(source))
  return c ? (c.used + 1) / (c.used + c.wasted + c.ignored / 2 + 2) : 0.5
}
export const credits = () => all<{ source: string; used: number; wasted: number; ignored: number }>('select source, used, wasted, ignored from needs_credit order by updated_at desc')
  .map(c => ({ ...c, credit: Math.round(credit(c.source) * 100) / 100 }))

function bump(source: string, outcome: Outcome, now: number) {
  const col = outcome === 'used' ? 'used' : outcome === 'wasted' ? 'wasted' : 'ignored'
  run(`insert into needs_credit (source, ${col}, updated_at) values (?, 1, ?)
    on conflict(source) do update set ${col} = ${col} + 1, updated_at = excluded.updated_at`, sourceFamily(source), now)
}

export const surfacings = (needId: string) => all<{ revision: string; conversation_id: string; at: number; outcome: string | null }>(
  'select revision, conversation_id, at, outcome from needs_surfaced where need_id = ? order by at', needId)

/** The one item (if any) the agent in this chat may raise, given the budget and credit. */
export function pickForChat(conversationId: string, now = Date.now()): Need | null {
  const recent = all<{ conversation_id: string; owned: number }>(
    `select s.conversation_id, n.conversation_id = s.conversation_id as owned from needs_surfaced s join needs n on n.id = s.need_id where s.at > ? and s.conversation_id != ''`, now - DAY)
  if (recent.length >= ATTENTION.perDay) return null
  // This chat's agent already holds an open note; don't stack a second one on it.
  if (get(`select 1 from needs_surfaced s join needs n on n.id = s.need_id where s.conversation_id = ? and s.outcome is null and n.status = 'needs_you'`, conversationId)) return null
  const crossLeft = recent.filter(r => !r.owned).length < ATTENTION.crossChatPerDay
  const open = all<Need>(`select * from needs n where status = 'needs_you' and human_action is not null
    and not exists (select 1 from needs_surfaced s where s.need_id = n.id and s.revision = n.revision) order by created_at`)
  const ranked = open
    .map(n => ({ n, owned: n.conversation_id === conversationId, c: credit(n.source) }))
    .filter(x => x.c >= ATTENTION.minCredit && (x.owned || (crossLeft && x.c >= ATTENTION.crossChatCredit)))
    .sort((a, b) => Number(b.owned) - Number(a.owned) || b.c - a.c || a.n.created_at - b.n.created_at)
  return ranked[0]?.n ?? null
}

export function attentionNote(n: Need) {
  return `\n\n<perch-attention>\nOne thing is waiting on the user (needs_me item ${n.id}): ${n.human_action}\nTheir attention is limited. After answering their message, mention this in one short sentence, with no detail unless they ask, and don't raise it again. If they answer it, act on the answer within their existing authorization, then call needs_me action=update id=${n.id} with the new status, evidence and attention=used. If they say it wasn't needed, wasn't important, or an agent should have handled it, handle or park it yourself and call update with attention=wasted. If they ignore it, do nothing.\n</perch-attention>`
}

/** Called for a message the user typed. Returns the text to append to it for the agent ('' for none). */
export function attentionFor(conversationId: string, now = Date.now()) {
  const n = pickForChat(conversationId, now)
  if (!n) return ''
  run('insert or ignore into needs_surfaced (need_id, revision, conversation_id, at) values (?, ?, ?, ?)', n.id, n.revision, conversationId, now)
  return attentionNote(n)
}

/** The user's verdict on an ask (via the agent they told). Explicit feedback counts even if never surfaced. */
export function recordAttention(needId: string, outcome: 'used' | 'wasted', now = Date.now()) {
  const n = need(needId)
  if (!n) throw new Error('Unknown Needs me item')
  const open = get<{ revision: string }>('select revision from needs_surfaced where need_id = ? and outcome is null order by at desc limit 1', needId)
  if (open) run('update needs_surfaced set outcome = ?, outcome_at = ? where need_id = ? and revision = ?', outcome, now, needId, open.revision)
  else if (get('select 1 from needs_surfaced where need_id = ? and outcome = ?', needId, outcome)) return // already counted
  bump(n.source, outcome, now)
}

const PARK = 'Take the safe reversible default within the user\'s existing authorization and record it, or park the item (status dismissed, evidence starting "Parked:"). A parked item reopens on its own when its source changes. Keep needs_you only for a blocking sign-in/secret, a destructive production change or new spending.'

/** Ignored mentions and asks that never earned one go back to agents. */
export function sweepAttention(now = Date.now()) {
  for (const s of all<{ need_id: string; revision: string; conversation_id: string; at: number }>(
    'select need_id, revision, conversation_id, at from needs_surfaced where outcome is null and at <= ?', now - ATTENTION.ignoredAfter)) {
    const n = need(s.need_id)
    run('update needs_surfaced set outcome = ?, outcome_at = ? where need_id = ? and revision = ?', 'ignored', now, s.need_id, s.revision)
    if (!n || n.status !== 'needs_you') continue
    bump(n.source, 'ignored', now)
    updateNeed(n.id, { status: 'checking', evidence: `Mentioned to the user on ${new Date(s.at).toISOString().slice(0, 16)}Z in ${convLink(s.conversation_id)}; no response in ${ATTENTION.ignoredAfter / HOUR}h, so it was not worth their attention. ${PARK}\nAsk was: ${n.human_action}` }, 'attention', now)
  }
  for (const n of all<Need>(`select * from needs n where status = 'needs_you' and created_at <= ?
    and not exists (select 1 from needs_surfaced s where s.need_id = n.id and s.revision = n.revision)`, now - ATTENTION.unseenAfter)) {
    // Recorded so the same revision is neither raised later nor sent back again every sweep.
    run(`insert or ignore into needs_surfaced (need_id, revision, conversation_id, at, outcome, outcome_at) values (?, ?, '', ?, 'unseen', ?)`, n.id, n.revision, now, now)
    updateNeed(n.id, { status: 'checking', evidence: `Waited ${Math.round((now - n.created_at) / DAY)} days without earning a mention to the user (attention budget, source credit ${credit(n.source).toFixed(2)}). ${PARK}\nAsk was: ${n.human_action}` }, 'attention', now)
  }
}

/** What the reviewer needs to judge an item against the user's attention. */
export const attentionContext = (n: Need) => ({ source_credit: Math.round(credit(n.source) * 100) / 100, mentioned_to_user: surfacings(n.id).map(s => ({ at: new Date(s.at).toISOString(), outcome: s.outcome ?? 'pending' })) })
