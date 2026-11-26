// The conversation sidebar, organised by state rather than by folders:
// - Pinned: what you pinned, always on top, set apart.
// - Now: the few you've been in that moved last: you sent a message, or the agent finished answering
//   one (activityOf). Opening a chat never reorders it, and neither does an agent mid-turn.
// - Needs you: an agent asked something, failed, or stalled.
// - Working: agents running right now that aren't already in Now.
// - By work: everything else still open, grouped by what it's about: its PR (or the stack the PR
//   sits in), otherwise its repo. Finished work archives itself (see effectiveState) and is found by search.
// - Agent runs: threads perch's automation started (helpers, shepherds, routines, autopilot fixes),
//   kept out of the sections above so those are only conversations you're driving. Collapsed in the UI.
import { basename } from 'node:path'
import { all } from './db.ts'
import { list, type Row } from './conversations.ts'

const NOW = 5

// Which of your chats count as ones you've been in. "everywhere": you opened or wrote it here, or you
// typed into it elsewhere (a terminal, the Claude desktop app, an @PostHog in Slack). "here": only
// what you touched in auto-m8. Automation is in neither; it stays under Agent runs.
export type Scope = 'everywhere' | 'here'
export const scopeOf = (v: unknown): Scope => v === 'here' ? 'here' : 'everywhere'
const engagedIn = (scope: Scope) => (r: Row) => Math.max(r.seen_at ?? 0, r.state_at ?? 0, scope === 'everywhere' ? r.you_at ?? 0 : 0)

export function sidebar(scope: Scope = 'everywhere') {
  let { conversations: rows, counts } = list({ limit: 400 })
  // Pinned: what matters most right now. Always first, whatever its state (even auto-archived or automated; hiding or archiving yourself unpins).
  const pinned = list({ q: 'is:pinned is:any', states: ['running', 'waiting', 'active', 'later', 'idle', 'done', 'archived'], limit: 100, focus: false }).conversations
    .sort((a, b) => (b.activity_at ?? b.updated_at ?? 0) - (a.activity_at ?? a.updated_at ?? 0))
  const pinnedIds = new Set(pinned.map(r => r.id))
  rows = rows.filter(r => !pinnedIds.has(r.id))
  const engaged = engagedIn(scope)
  // A conversation you're in stays here while its agent answers you (it shows its running dot);
  // "working" is for agents running in the background.
  const now = [...rows].filter(r => engaged(r) > 0).sort((a, b) => (b.activity_at ?? b.updated_at ?? 0) - (a.activity_at ?? a.updated_at ?? 0)).slice(0, NOW)
  const taken = new Set(now.map(r => r.id))
  const needs = rows.filter(r => r.effective === 'waiting' && !taken.has(r.id))
  needs.forEach(r => taken.add(r.id))
  const working = rows.filter(r => r.effective === 'running' && !taken.has(r.id))
  working.forEach(r => taken.add(r.id))

  // Stacks: an open PR whose base is another open PR's branch sits on it. Group by the bottom one.
  const prs = all<any>(`select url, repo, number, title, head, base, state from prs where state = 'OPEN'`)
  const byHead = new Map(prs.map(p => [`${p.repo}:${p.head}`, p]))
  const rootOf = (url: string) => {
    let p = prs.find(x => x.url === url)
    for (let i = 0; p && i < 20; i++) { const parent = byHead.get(`${p.repo}:${p.base}`); if (!parent || parent === p) break; p = parent }
    return p
  }
  const stackSize = new Map<string, number>()
  for (const p of prs) { const r = rootOf(p.url); if (r) stackSize.set(r.url, (stackSize.get(r.url) ?? 0) + 1) }
  const short = (t: string) => String(t ?? '').replace(/^\w+(\([^)]*\))?!?:\s*/, '').replace(/^./, c => c.toUpperCase())

  const groups = new Map<string, { key: string; kind: 'pr' | 'stack' | 'repo'; title: string; url?: string; items: Row[]; last: number }>()
  for (const r of rows) {
    if (taken.has(r.id) || ['archived', 'hidden', 'done'].includes(r.effective)) continue
    const open = (r.prs ?? []).filter((p: Row) => p.url && p.state === 'OPEN')
    const pick = open.find((p: Row) => p.created) ?? open[0]
    let g: { key: string; kind: 'pr' | 'stack' | 'repo'; title: string; url?: string }
    if (pick) {
      const root = rootOf(pick.url) ?? pick
      const n = stackSize.get(root.url) ?? 1
      g = n > 1 ? { key: root.url, kind: 'stack', title: `${short(root.title)} · ${n}-PR stack`, url: root.url } : { key: root.url, kind: 'pr', title: `${short(root.title ?? pick.title)}`, url: root.url }
    } else {
      const repo = r.source === 'posthog-task' ? (r.origin === 'slack' ? 'Slack asks' : 'PostHog tasks') : r.cwd ? basename(r.cwd) : 'Other'
      g = { key: `repo:${repo}`, kind: 'repo', title: repo }
    }
    const cur = groups.get(g.key) ?? { ...g, items: [], last: 0 }
    cur.items.push(r)
    cur.last = Math.max(cur.last, r.activity_at ?? r.updated_at)
    groups.set(g.key, cur)
  }
  const archived = counts.archived ?? 0 // the same pool as the list above, so the same number as listing them
  // Agent runs still open, running ones first. Their parent (who delegated it) is named when known.
  const agents = list({ q: 'is:auto', states: ['running', 'waiting', 'active', 'later', 'idle'], limit: 200, focus: false }).conversations
    .filter(r => !pinnedIds.has(r.id))
    .sort((a, b) => Number(b.effective === 'running') - Number(a.effective === 'running') || (b.activity_at ?? b.updated_at ?? 0) - (a.activity_at ?? a.updated_at ?? 0))
  let parents = new Map<string, any>()
  try {
    parents = new Map(all<any>(`select d.child, coalesce(u.title, c.title, c.first_prompt) title, d.parent from delegations d
      left join conversations c on c.id = d.parent left join user_state u on u.id = d.parent`).map(p => [p.child, p]))
  } catch {} // no delegations table until the first helper is started
  for (const r of agents) { const p = parents.get(r.id); if (p) r.parent = { id: p.parent, title: String(p.title ?? '').slice(0, 80) } }
  return { pinned, now, needs, working, groups: [...groups.values()].sort((a, b) => b.last - a.last), archived, agents, scope }
}

// "More recent": the chats you've been in, past the first few shown in Now, by your last message or the agent's last finished answer.
// Paged for the sidebar's scroll-to-load list. Reaches done and archived ones too, since finished
// work you were just in is exactly what you go back for; pinned ones already sit on top.
export function recentPage(offset = 0, limit = 15, scope: Scope = 'everywhere') {
  offset = Math.max(0, Math.floor(offset) || 0)
  limit = Math.min(200, Math.max(1, Math.floor(limit) || 15))
  const engaged = engagedIn(scope)
  const inNow = new Set(sidebar(scope).now.map(r => r.id))
  const rows = list({ states: ['running', 'waiting', 'active', 'later', 'idle', 'done', 'archived'], limit: 100_000 }).conversations
    .filter(r => !r.pinned && !inNow.has(r.id) && engaged(r) > 0)
    .sort((a, b) => (b.activity_at ?? b.updated_at ?? 0) - (a.activity_at ?? a.updated_at ?? 0))
  return { conversations: rows.slice(offset, offset + limit), total: rows.length, offset, limit }
}
