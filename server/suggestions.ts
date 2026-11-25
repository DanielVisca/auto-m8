// The unblocker: one-line cards on Home, each with one action and an ×, driven by what actually
// happened (an agent said it lacked something, a chat talks about a tool that isn't connected, a
// PR is red while nobody is allowed to fix it, search never used). Dismissed is dismissed forever.
// Other parts of auto-m8 add their own with add(kind, key, text, action).
// Only on installs with settings.nudges on (fresh installs): an existing install sees nothing new.
import { all, db, get, run } from './db.ts'
import { settings } from './settings.ts'
import { status } from './status.ts'
import { track } from './telemetry.ts'

db.exec(`create table if not exists unblock_cards (kind text not null, key text not null, text text not null, action text,
  created_at integer, shown_at integer, acted_at integer, dismissed_at integer, primary key (kind, key))`)
db.exec(`create table if not exists feature_usage (feature text primary key, n integer not null default 0, first_at integer, last_at integer)`)

// One action per card: start a chat that does the work, open a view, or change a setting.
export type Action = { label: string; chat?: string; href?: string; settings?: Record<string, unknown> }
export type Suggestion = { kind: string; key: string; text: string; action: Action }

export const nudgesOn = () => !!settings.nudges?.enabled

// Adds a card, or refreshes its text. A dismissed or acted-on card never comes back.
export function add(kind: string, key: string, text: string, action: Action) {
  run(`insert into unblock_cards (kind, key, text, action, created_at) values (?, ?, ?, ?, ?)
       on conflict(kind, key) do update set text = excluded.text, action = excluded.action where dismissed_at is null and acted_at is null`,
    kind, key.slice(0, 80), text.slice(0, 200), JSON.stringify(action), Date.now())
}

export function active(limit = 3): Suggestion[] {
  if (!nudgesOn()) return []
  const rows = all<any>('select * from unblock_cards where dismissed_at is null and acted_at is null order by created_at desc limit ?', limit)
  for (const r of rows) if (!r.shown_at) { run('update unblock_cards set shown_at = ? where kind = ? and key = ?', Date.now(), r.kind, r.key); track('suggestion_shown', { kind: r.kind }) }
  return rows.map(r => ({ kind: r.kind, key: r.key, text: r.text, action: JSON.parse(r.action ?? '{}') }))
}
export function dismiss(kind: string, key: string) {
  if (run('update unblock_cards set dismissed_at = ? where kind = ? and key = ? and dismissed_at is null', Date.now(), kind, key).changes) track('suggestion_dismissed', { kind })
}
export function acted(kind: string, key: string) {
  if (run('update unblock_cards set acted_at = ? where kind = ? and key = ? and acted_at is null', Date.now(), kind, key).changes) track('suggestion_acted', { kind })
}

// Local counts of the main surfaces (for the "never used search" signal), plus feature_used.
export function noteFeature(feature: string) {
  run('insert into feature_usage (feature, n, first_at, last_at) values (?, 1, ?, ?) on conflict(feature) do update set n = n + 1, last_at = excluded.last_at', feature, Date.now(), Date.now())
  track('feature_used', { feature })
}
const used = (feature: string) => (get<any>('select n from feature_usage where feature = ?', feature)?.n ?? 0) > 0

// Tools people mention in chats that have an MCP server worth connecting.
export const VENDORS = ['sentry', 'datadog', 'linear', 'jira', 'notion', 'grafana', 'slack', 'figma', 'vercel', 'supabase', 'stripe', 'posthog', 'pagerduty', 'asana']
const label = (v: string) => ({ posthog: 'PostHog', pagerduty: 'PagerDuty' } as Record<string, string>)[v] ?? v[0].toUpperCase() + v.slice(1)

// Every signal, read from what's already recorded. Cheap: a few small queries.
export function scan(extraMcp: string[] = []) {
  if (!nudgesOn()) return
  const since = Date.now() - 14 * 86400_000
  // 1. An agent said it couldn't do the job without some data or tool.
  for (const w of all<any>(`select need, suggested from capability_wishes where created_at > ? and coalesce(kind, 'data') = 'data' order by created_at desc limit 5`, since)) {
    const what = String(w.suggested || w.need).trim()
    if (!what) continue
    add('missing_capability', what.toLowerCase(), `An agent couldn't reach ${what.slice(0, 60)}. Connect it?`,
      { label: 'Connect', chat: `An agent in auto-m8 said it was missing: ${what}. Find an MCP server that provides it (discover_mcp), then connect it for me with \`claude mcp add\`, asking only for what you can't do yourself (a key or a sign-in). Keep it short.` })
  }
  // 2. Chats talk about a tool that has no MCP server connected.
  const connected = [...(status.mcp?.servers ?? []).map(s => s.name), ...extraMcp].join(' ').toLowerCase()
  const text = all<any>('select lower(coalesce(title, \'\') || \' \' || coalesce(first_prompt, \'\')) t from conversations where updated_at > ? limit 500', since).map(r => r.t).join('\n')
  for (const v of VENDORS) {
    if (connected.includes(v)) continue
    const hits = text.match(new RegExp(`\\b${v}\\b`, 'g'))?.length ?? 0
    if (hits < 2) continue
    add('missing_mcp', v, `Your chats mention ${label(v)}, but agents can't reach it. Connect its MCP server?`,
      { label: 'Connect', chat: `My chats often mention ${label(v)}, but no ${label(v)} MCP server is connected. Find the official one (discover_mcp), connect it with \`claude mcp add\`, and walk me through any sign-in. Keep it short.` })
  }
  // 3. Your PRs are red and nothing is allowed to fix them.
  if (settings.autonomy?.enabled === false) {
    const red = get<any>(`select count(*) n from prs where authored = 1 and state = 'OPEN' and checks in ('FAILURE', 'ERROR')`)?.n ?? 0
    if (red > 0) add('red_ci_autonomy_off', 'red_ci', `${red} of your open PRs ${red === 1 ? 'has' : 'have'} red CI. Let agents fix it?`,
      { label: 'Turn on', settings: { autonomy: { enabled: true } } })
  }
  // 4. Several chats, and never searched: the history is there to use.
  const started = get<any>(`select count(*) n from perch_started where by = 'you'`)?.n ?? 0
  if (started >= 3 && !used('search')) add('search_unused', 'search', 'Every past chat, PR and note is searchable. Press ⌘⇧K or ask "what did I decide about…"',
    { label: 'Search', href: '#search' })
}

// The once-per-chat nudge in each chat's system prompt (chat.ts).
export const NUDGE = 'UNBLOCK: at most once in this chat, if a missing connection (an MCP server, a login) or an auto-m8 feature (search_conversations for past work, delegate or race for parallel work, the PR shepherd, the browser tool, routines, boards) would clearly unblock the current task, say so in one short line and offer to set it up. For a missing data source, also call report_missing_capability. Never repeat it, and never interrupt the task for it.'
