// Orchestration for one agent driving many conversations and PRs.
// - watch: the agent says what it cares about (conversations, PRs) and perch watches for it:
//   a chat's turn ending, asking something, erroring, going idle; a PR going red or green, getting
//   approved, changes requested, new review threads, new commits, merged or closed, shepherd stage.
// - inbox: every event lands in the owner's inbox. perch wakes the owner ONCE per burst, after a
//   short quiet period and never mid-turn, with all pending events in one message.
// - board: one call with the live state of everything the owner drives (PRs from gh, not the index).
// No caps on how many things an agent may watch; GitHub is polled with a few requests in flight.
import { isPaused } from './pausehold.ts'
import { readFileSync } from 'node:fs'
import { chats, send, subscribe } from './chat.ts'
import { all, get, run } from './db.ts'
import { ghPressure } from './gh.ts'
import { parsePr, pool, prLine, prState, type PrState } from './ghpr.ts'
import { scorePrs, todaysArm } from './learn.ts'
import { liveSessions } from './presence.ts'
import { titleFor } from './relay.ts'
import { toItems, itemsOf } from './transcript.ts'

run(`create table if not exists watches (
  owner text not null, target text not null, kind text not null, events text, idle_minutes integer,
  snapshot text, created_at integer not null, active integer not null default 1, primary key (owner, target))`)
run(`create table if not exists inbox (
  id integer primary key autoincrement, owner text not null, at integer not null, target text, event text not null, text text not null, delivered_at integer)`)
run('create index if not exists inbox_owner on inbox(owner, delivered_at)')

export const CONV_EVENTS = ['turn_end', 'asked', 'error', 'idle', 'moved'] as const
export const PR_EVENTS = ['ci_red', 'ci_green', 'approved', 'changes_requested', 'new_threads', 'new_commit', 'ready', 'merged', 'closed', 'shepherd'] as const
const QUIET_MS = 15_000 // wait this long after the last event before waking the owner
const PR_POLL_MS = 180_000 // one GraphQL query per watched PR per tick: 90s spent ~1,300 points an hour
const CONV_POLL_MS = 60_000
const MAX_EVENT_TEXT = 3000

export const onInbox = new Set<() => void>()
const changed = () => onInbox.forEach(f => f())

type Watch = { owner: string; target: string; kind: 'conv' | 'pr'; events: string | null; idle_minutes: number | null; snapshot: string | null; created_at: number; active: number }
const wants = (w: Watch, ev: string) => !w.events || w.events.split(',').includes(ev)
// Tables owned by other modules (delegations, projects, shepherd, promises, decisions) may not exist yet.
const rows = <T,>(sql: string, ...args: any[]): T[] => { try { return all<T>(sql, ...args) } catch { return [] } }
const row = <T,>(sql: string, ...args: any[]): T | undefined => { try { return get<T>(sql, ...args) } catch { return undefined } }
const ours = (id: string) => chats.has(id) || !!get('select 1 from perch_started where id = ?', id)

// ---------- watching ----------
export function watch(input: { owner: string; targets: string[]; events?: string[]; idle_minutes?: number }) {
  const owner = String(input.owner || '')
  if (!owner) throw new Error('Pass your own conversation_id as owner.')
  const added: string[] = []
  for (const raw of input.targets ?? []) {
    const pr = parsePr(String(raw))
    const target = pr ? pr.url : String(raw).replace(/^perch:\/\//, '').trim()
    if (!target || target === owner) continue
    if (!pr && !get('select 1 from conversations where id = ?', target) && !chats.has(target)) throw new Error(`No conversation ${target}.`)
    const kind = pr ? 'pr' : 'conv'
    const allowed: readonly string[] = kind === 'pr' ? PR_EVENTS : CONV_EVENTS
    const events = input.events?.length ? input.events.filter(e => allowed.includes(e)).join(',') || null : null
    run(`insert into watches (owner, target, kind, events, idle_minutes, created_at) values (?, ?, ?, ?, ?, ?)
         on conflict(owner, target) do update set active = 1, events = excluded.events, idle_minutes = coalesce(excluded.idle_minutes, idle_minutes)`,
      owner, target, kind, events, input.idle_minutes ?? null, Date.now())
    if (kind === 'conv') follow(target)
    else pollPr(target).catch(() => {})
    added.push(target)
  }
  changed()
  return { added }
}

// What a stop request covers. The MCP watch tool sends stop: [ids] or 'all'; older callers sent
// stop: true with targets. Reading only targets made stop: [ids] answer "Stopped." and change nothing,
// so coordinators kept getting duplicate events (2026-11-14).
export function stopTargets(b: { stop?: unknown; targets?: unknown }): string[] | 'all' {
  if (b.stop === 'all') return 'all'
  const list = (v: unknown) => Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []
  return [...new Set([...list(b.stop === true ? [] : b.stop), ...list(b.targets)])]
}

export function unwatch(owner: string, targets: string[] | 'all'): number {
  let n = 0
  if (targets === 'all') n = Number(run('update watches set active = 0 where owner = ? and active = 1', owner).changes)
  else for (const t of targets) n += Number(run('update watches set active = 0 where owner = ? and target = ? and active = 1', owner, parsePr(t)?.url ?? t.replace(/^perch:\/\//, '')).changes)
  changed()
  return n
}

export const watchesOf = (owner: string) => all<Watch>('select * from watches where owner = ? and active = 1 order by created_at', owner)
const watchersOf = (target: string) => all<Watch>('select * from watches where target = ? and active = 1', target)

// Perch chats: listen to their stream (also catches a terminal conversation once perch resumes it).
const followed = new Set<string>()
function follow(target: string) {
  if (followed.has(target)) return
  followed.add(target)
  let text = ''
  subscribe(target, ev => {
    if (ev.parent_tool_use_id) return
    if (ev.type === 'perch_user') text = ''
    if (ev.type === 'stream_event' && ev.event?.delta?.type === 'text_delta') text += ev.event.delta.text
    if (ev.type === 'result') {
      const body = String(ev.result ?? text ?? '').trim()
      const asked = /\?\s*(\*\*)?\s*$/.test(body.split('\n').filter(Boolean).slice(-1)[0] ?? '') || /^\s*NEEDS HELP:/i.test(body)
      for (const w of watchersOf(target)) {
        if (asked && wants(w, 'asked')) push(w.owner, target, 'asked', `"${titleFor(target)}" asked:\n${clip(body)}`)
        else if (wants(w, 'turn_end')) push(w.owner, target, 'turn_end', `"${titleFor(target)}" finished its turn${ev.is_error ? ' with an error' : ''}:\n${clip(body)}`)
      }
    }
    if (ev.type === 'perch_error') for (const w of watchersOf(target)) if (wants(w, 'error')) push(w.owner, target, 'error', `"${titleFor(target)}" stopped: ${String(ev.message ?? '').slice(0, 500)}`)
  }, { background: true })
}
const clip = (s: string) => s.length > MAX_EVENT_TEXT ? `${s.slice(0, MAX_EVENT_TEXT)}… (get_conversation for the rest)` : s || '(no text)'

// Any conversation (terminal ones included): idle and "moved" come from the index's updated_at.
function pollConvs() {
  const now = Date.now()
  for (const w of all<Watch>(`select * from watches where kind = 'conv' and active = 1`)) {
    const c = get<{ updated_at: number }>('select updated_at from conversations where id = ?', w.target)
    if (!c) continue
    const snap = JSON.parse(w.snapshot ?? '{}')
    const running = chats.get(w.target)?.state === 'running'
    // moved: a conversation perch doesn't run got new messages (someone is working in it in a terminal); reported once it settles
    if (snap.seen == null) snap.seen = c.updated_at
    else if (c.updated_at > snap.seen && now - c.updated_at > 2 * 60_000) {
      if (!chats.has(w.target) && wants(w, 'moved')) push(w.owner, w.target, 'moved', `"${titleFor(w.target)}" moved (new messages outside perch, last ${ago(c.updated_at)}). ${lastAgentLine(w.target)}`)
      snap.seen = c.updated_at
    }
    const idleMs = (w.idle_minutes ?? 30) * 60_000
    if (!running && now - c.updated_at > idleMs && snap.idleAt !== c.updated_at && wants(w, 'idle')) {
      push(w.owner, w.target, 'idle', `"${titleFor(w.target)}" has been quiet for ${ago(c.updated_at)}. ${lastAgentLine(w.target)}`)
      snap.idleAt = c.updated_at
    }
    run('update watches set snapshot = ? where owner = ? and target = ?', JSON.stringify(snap), w.owner, w.target)
  }
}

// PRs: live from gh, diffed against the last snapshot each watcher saw.
async function pollPr(url: string) {
  const s = await prState(url, 120_000)
  const stage = row<{ stage: string }>('select stage from shepherd_watch where url = ?', url)?.stage ?? null
  for (const w of watchersOf(url)) {
    const prev = w.snapshot ? JSON.parse(w.snapshot) : null
    const cur = { state: s.state, checks: s.checks, failing: s.failing, review: s.review, unresolved: s.unresolved, head: s.head, stage }
    if (prev) for (const [ev, text] of diffPr(prev, cur, s)) if (wants(w, ev)) push(w.owner, url, ev, text)
    run('update watches set snapshot = ? where owner = ? and target = ?', JSON.stringify(cur), w.owner, w.target)
    if ((s.state === 'merged' || s.state === 'closed') && prev?.state === s.state) run('update watches set active = 0 where owner = ? and target = ?', w.owner, w.target) // reported already
  }
}

export function diffPr(prev: any, cur: any, s: Pick<PrState, 'repo' | 'number' | 'title' | 'failing' | 'approvedBy' | 'changesBy' | 'url'>): [string, string][] {
  const name = `${s.repo}#${s.number} "${s.title}"`, out: [string, string][] = []
  if (cur.state !== prev.state) {
    if (cur.state === 'merged') out.push(['merged', `${name} MERGED.`])
    else if (cur.state === 'closed') out.push(['closed', `${name} was closed without merging.`])
    else if (prev.state === 'draft' && cur.state === 'open') out.push(['ready', `${name} is ready for review.`])
  }
  if (cur.head !== prev.head && cur.state !== 'merged') out.push(['new_commit', `${name} got a new commit (${String(cur.head).slice(0, 7)}).`])
  if (cur.checks === 'failing' && (prev.checks !== 'failing' || cur.head !== prev.head || cur.failing.join() !== prev.failing.join()))
    out.push(['ci_red', `${name} CI RED: ${cur.failing.slice(0, 6).join(', ')}. Dig in: gh pr checks ${s.url}`])
  if (cur.checks === 'passing' && prev.checks !== 'passing') out.push(['ci_green', `${name} CI green.`])
  if (cur.review !== prev.review) {
    if (cur.review === 'approved') out.push(['approved', `${name} approved${s.approvedBy.length ? ` by ${s.approvedBy.join(', ')}` : ''}.`])
    if (cur.review === 'changes requested') out.push(['changes_requested', `${name} changes requested by ${s.changesBy.join(', ') || 'a reviewer'}. Dig in: gh pr view ${s.url} --comments`])
  }
  if (cur.unresolved > prev.unresolved) out.push(['new_threads', `${name} has ${cur.unresolved - prev.unresolved} new unresolved review thread(s) (${cur.unresolved} open).`])
  if (cur.stage && cur.stage !== prev.stage) out.push(['shepherd', `${name} shepherd stage: ${prev.stage ?? 'none'} → ${cur.stage}.`])
  return out
}

let polling = false
async function pollPrs() {
  if (polling || ghPressure()) return // GitHub budget mostly spent: watches catch up after the reset
  polling = true
  try {
    const urls = all<{ target: string }>(`select distinct target from watches where kind = 'pr' and active = 1`).map(r => r.target)
    await pool(urls, 6, u => pollPr(u).catch(e => console.error('orchestra pr', u, e.message)))
  } finally { polling = false }
}

// ---------- inbox ----------
export function push(owner: string, target: string | null, event: string, text: string) {
  run('insert into inbox (owner, at, target, event, text) values (?, ?, ?, ?, ?)', owner, Date.now(), target, event, text)
  changed()
}

export const pendingFor = (owner: string) => all<any>('select * from inbox where owner = ? and delivered_at is null order by id', owner)

function deliver() {
  if (isPaused()) return // paused: events stay queued in the inbox and arrive on resume
  const now = Date.now()
  for (const { owner } of all<{ owner: string }>('select distinct owner from inbox where delivered_at is null')) {
    const items = pendingFor(owner)
    if (!items.length || now - items[items.length - 1].at < QUIET_MS) continue
    if (chats.get(owner)?.state === 'running') continue // delivered at the end of its turn
    if (!ours(owner)) continue // a terminal conversation: the board shows them; never written to behind your back
    run(`update inbox set delivered_at = ? where owner = ? and delivered_at is null and id <= ?`, now, owner, items[items.length - 1].id)
    const body = items.map((e, i) => `${i + 1}. [${e.event}${e.target ? ` · ${e.target.startsWith('http') || e.target.startsWith('term:') ? e.target : `perch://${e.target}`}` : ''}] ${e.text}`).join('\n\n')
    send({ id: owner, resume: true, prompt: `EVENTS (${items.length}) from what you're watching (perch, not the user):\n\n${body}\n\nAct on what needs it (send_to_conversation, gh, the shepherd), then carry on. board gives the full picture.` })
    changed()
  }
}

// ---------- board ----------
const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60_000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago` }
function lastAgentLine(id: string) {
  const path = get<{ path: string }>('select path from conversations where id = ?', id)?.path
  if (!path) return ''
  try {
    const items = itemsOf(path)
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it.kind === 'assistant') { const t = it.blocks.filter(b => b.type === 'text').map((b: any) => b.text).join(' ').replace(/\s+/g, ' ').trim(); if (t) return `Last said: ${t.length > 220 ? '…' + t.slice(-220) : t}` }
    }
  } catch {}
  return ''
}

export async function board(owner: string, opts: { scope?: 'mine' | 'all'; hours?: number } = {}) {
  const ws = watchesOf(owner)
  const convIds = new Set<string>([
    ...ws.filter(w => w.kind === 'conv').map(w => w.target),
    ...rows<{ b: string }>(`select b from links where a = ? and kind in ('drives', 'started')`, owner).map(r => r.b),
    ...rows<{ child: string }>(`select child from delegations where parent = ? and status != 'stopped'`, owner).map(r => r.child),
  ])
  const prUrls = new Set<string>([
    ...ws.filter(w => w.kind === 'pr').map(w => w.target),
    ...rows<{ url: string }>('select url from conversation_prs where conversation_id = ? and created = 1', owner).map(r => r.url),
    ...rows<{ url: string }>('select pp.url from project_prs pp join projects p on p.id = pp.project_id where p.conversation_id = ?', owner).map(r => r.url),
  ].map(u => parsePr(u)?.url).filter(Boolean) as string[])
  if (opts.scope === 'all') {
    const since = Date.now() - (opts.hours ?? 24) * 3600_000
    for (const r of rows<{ id: string }>(`select c.id from conversations c left join user_state u on u.id = c.id
        where c.updated_at > ? and c.source in ('claude', 'posthog-code', 'posthog-task') and coalesce(u.state, '') not in ('done', 'archived', 'hidden') and c.id != ?
        and not (c.source = 'posthog-task' and coalesce(c.origin, '') not in ('', 'slack', 'user_created', 'posthog_ai', 'signals_chat', 'support_reply')) order by c.updated_at desc`, since, owner)) convIds.add(r.id)
    for (const r of rows<{ url: string }>(`select url from prs where state = 'OPEN' or state = 'open'`)) { const u = parsePr(r.url)?.url; if (u) prUrls.add(u) }
  }
  convIds.delete(owner)
  const terminals = new Set(liveSessions().map(s => s.session))
  const watched = new Set(ws.map(w => w.target))
  const convLines = [...convIds].map(id => {
    const c = row<any>(`select c.source, c.updated_at, c.status, u.state, a.reason from conversations c left join user_state u on u.id = c.id left join attention a on a.id = c.id and a.verdict = 1 where c.id = ?`, id)
    const chat = chats.get(id)
    const state = chat?.state === 'running' ? 'RUNNING' : chat ? 'idle in perch' : terminals.has(id) ? 'open in a terminal' : 'not running'
    const extra = [c?.state ? `marked ${c.state}` : '', c?.reason ? `needs you: ${c.reason}` : '', watched.has(id) ? 'watched' : ''].filter(Boolean).join(' · ')
    return { at: c?.updated_at ?? 0, line: `- perch://${id} "${titleFor(id)}" | ${c?.source ?? 'perch'} | ${state} | active ${c?.updated_at ? ago(c.updated_at) : '?'}${extra ? ` | ${extra}` : ''}\n  ${lastAgentLine(id) || '(no transcript)'}` }
  }).sort((a, b) => b.at - a.at).map((x, i) => opts.scope === 'all' && i >= 20 && !/needs you|RUNNING/.test(x.line) ? x.line.split('\n')[0] : x.line)
  const stages = new Map(rows<{ url: string; stage: string; outcome: string }>('select url, stage, outcome from shepherd_watch').map(r => [r.url, r]))
  const prs = await pool([...prUrls], 6, u => prState(u).then(s => ({ s }), e => ({ u, e: String(e.message ?? e).slice(0, 160) })))
  // Most in need of action first: red CI, changes requested, open threads, approved (ready to land), the rest; merged/closed last.
  const rank = (x: any) => !x.s ? 0 : x.s.state === 'merged' || x.s.state === 'closed' ? 9 : x.s.checks === 'failing' ? 1 : x.s.changesBy.length ? 2 : x.s.unresolved ? 3 : x.s.approvedBy.length ? 4 : x.s.state === 'draft' ? 6 : 5
  const since = Date.now() - (opts.hours ?? 24) * 3600_000
  // scope=all: the index's "open" PRs that GitHub says are done only matter if they finished recently.
  const shown = prs.filter((x: any) => opts.scope !== 'all' || !x.s || watched.has(x.s.url) || !(x.s.state === 'closed' || (x.s.state === 'merged' && (x.s.mergedAt ?? 0) < since)))
  // Switchback experiment (learn.ts, phase 2): on 'learned' days, open PRs go by expected proven PRs
  // per hour still to wait instead of the fixed order above. Done PRs stay last either way.
  const arm = todaysArm()
  const score = arm === 'learned' ? scorePrs(shown.filter((x: any) => x.s).map((x: any) => x.s.url)) : null
  const order = (x: any) => score && x.s && rank(x) < 9 ? -(score.get(x.s.url) ?? 0) : rank(x)
  const prLines = shown.sort((a: any, b: any) => (rank(a) === 9 ? 1 : 0) - (rank(b) === 9 ? 1 : 0) || order(a) - order(b)).map((x: any) => {
    if (!x.s) return `- ${x.u} | couldn't read from gh: ${x.e}`
    const st = stages.get(x.s.url)
    return `- ${prLine(x.s, st ? ` | shepherd ${st.stage ?? 'watching'}${st.outcome ? ` (${st.outcome})` : ''}` : '')}${watched.has(x.s.url) ? ' | watched' : ''}`
  })
  const ids = [owner, ...convIds]
  const marks = ids.map(() => '?').join(',')
  const promises = rows<any>(`select conversation_id, text, due_at, pr_url, until from promises where status = 'open' and conversation_id in (${marks}) order by due_at`, ...ids)
  const decisions = rows<any>(`select conversation_id, title, url, stakes from decisions where status = 'open' and conversation_id in (${marks})`, ...ids)
  const inbox = pendingFor(owner)
  return [
    `# Board for perch://${owner} (${new Date().toLocaleString()})`,
    `## Conversations (${convLines.length})`, convLines.join('\n') || '(none: watch some, or use scope=all)',
    `## PRs (${prLines.length}, live from GitHub via gh; dig in with gh pr view/checks/diff <url>)${arm ? ` · ordered by ${arm === 'learned' ? 'learned value per hour' : 'fixed rank'} (switchback day)` : ''}`, prLines.join('\n') || '(none)',
    promises.length ? `## Follow-ups waiting\n${promises.map(p => `- perch://${p.conversation_id}: ${p.text}${p.pr_url ? ` (until ${p.until} on ${p.pr_url})` : ''}${p.due_at ? `, due ${new Date(p.due_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}`).join('\n')}` : '',
    decisions.length ? `## Decisions open\n${decisions.map(d => `- [${d.stakes}] ${d.title}${d.url ? ` (${d.url})` : ''} · perch://${d.conversation_id}`).join('\n')}` : '',
    inbox.length ? `## Events not yet delivered (${inbox.length})\n${inbox.map(e => `- [${e.event}] ${e.text.split('\n')[0]}`).join('\n')}` : '',
    `## Watching (${ws.length})\n${ws.map(w => `- ${w.kind === 'pr' ? w.target : `perch://${w.target}`}${w.events ? ` on ${w.events}` : ' on everything'}`).join('\n') || '(nothing)'}`,
  ].filter(Boolean).join('\n\n')
}

// ---------- loop ----------
export function startOrchestra() {
  for (const w of rows<{ target: string }>(`select distinct target from watches where kind = 'conv' and active = 1`)) follow(w.target)
  setInterval(() => { try { deliver() } catch (e) { console.error('orchestra deliver', e) } }, 5_000).unref()
  setInterval(() => { try { pollConvs() } catch (e) { console.error('orchestra convs', e) } }, CONV_POLL_MS).unref()
  setInterval(() => { pollPrs().catch(e => console.error('orchestra prs', e)) }, PR_POLL_MS).unref()
}
