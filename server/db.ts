// One SQLite file. Transcripts stay where Claude Code writes them; this holds only what we
// derive from them (metadata, search text, tool calls, PRs) plus the state you add (state,
// links, routines). Everything derived can be rebuilt by deleting the file.
import { DatabaseSync } from 'node:sqlite'
import { appendFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DATA_DIR } from './settings.ts'
import { recordDb } from './latency.ts'

export const db = new DatabaseSync(process.env.PERCH_DB ?? join(DATA_DIR, 'perch.db'))

db.exec(`
pragma journal_mode = wal;
pragma busy_timeout = 3000;

-- Derived: one row per conversation from any source.
create table if not exists conversations (
  id text primary key,           -- session uuid, or task:<uuid> for PostHog tasks
  source text not null,          -- claude | posthog-code | posthog-task
  title text,
  first_prompt text,
  cwd text,
  branch text,
  path text,                     -- transcript file
  started_at integer,
  updated_at integer,
  messages integer default 0,
  status text,                   -- remote run status for tasks
  url text,
  origin text                    -- task origin_product (slack, review_hog, ...)
);
create index if not exists conversations_updated on conversations(updated_at desc);

-- Yours: survives reindexing.
create table if not exists user_state (
  id text primary key,
  state text,                    -- active | waiting | later | done | archived; null = inferred
  state_auto integer default 1,  -- 1 while automation may still move it
  pinned integer default 0,
  note text,
  state_at integer
);

create table if not exists files (path text primary key, size integer, mtime integer, offset integer);

create virtual table if not exists search using fts5(id unindexed, title, body, tokenize = 'porter unicode61');

-- Derived: every tool call, for usage analytics.
create table if not exists tool_calls (
  conversation_id text not null,
  tool_use_id text primary key,
  name text not null,
  server text,                   -- mcp server, or null for built-in tools
  ts integer,
  is_error integer
);
create index if not exists tool_calls_ts on tool_calls(ts);


-- Derived: PRs mentioned or created in a conversation; status refreshed from GitHub.
create table if not exists conversation_prs (
  conversation_id text not null,
  url text not null,
  created integer default 0,     -- 1 when the conversation opened it (gh pr create / pr-link)
  primary key (conversation_id, url)
);
create table if not exists prs (
  url text primary key, repo text, number integer, title text, state text, draft integer,
  review text, checks text, updated_at integer, fetched_at integer
);

-- Yours and automatic: the context graph.
-- Short intent titles perch writes for chats Claude never named (perch's own -p chats).
create table if not exists auto_titles (id text primary key, title text, created_at integer);
create table if not exists links (
  a text not null, b text not null,
  kind text not null,            -- continues | context | related | manual
  note text, created_at integer,
  primary key (a, b, kind)
);
-- Lookups by either end (link counts on every list): without it each count scanned every link.
create index if not exists links_b on links(b);

-- Yours: prompts that run on a schedule or a webhook.
create table if not exists routines (
  id text primary key, name text, prompt text, cwd text,
  cron text, webhook_secret text, conversation_id text,  -- continue this conversation, or start fresh
  mode text default 'resume',    -- resume | fresh
  enabled integer default 1, last_run_at integer, last_status text, created_at integer
);
`)

// Prepared once per distinct SQL text, not on every call. Bounded: SQL built with a variable
// number of placeholders would otherwise grow it forever.
const stmts = new Map<string, ReturnType<typeof db.prepare>>()
function stmt(sql: string) {
  let s = stmts.get(sql)
  if (!s) { if (stmts.size > 400) stmts.clear(); s = db.prepare(sql); stmts.set(sql, s) }
  return s
}
// Bumped on every write made through here, so read caches (the conversation list) know when to refresh.
export let writes = 0
// Writes someone would notice in a list right away: state, labels, decisions, chat settings, links,
// browser windows, who started a chat. Background churn (indexing, tool calls, usage, search) only
// bumps writes. conversations.ts rebuilds its list at once for these, and lazily for the rest.
export let userWrites = 0
const USER_TABLES = /\b(?:into|update|from)\s+(?:user_state|labels|decisions|perch_started|chat_prefs|links|browser_sessions|attention)\b/i
// Every query is timed into the current request's trace (latency.ts), or background totals.
export const all = <T = any>(sql: string, ...p: any[]) => { const t = performance.now(); try { return stmt(sql).all(...p) as T[] } finally { recordDb('all', sql, performance.now() - t) } }
export const get = <T = any>(sql: string, ...p: any[]) => { const t = performance.now(); try { return stmt(sql).get(...p) as T | undefined } finally { recordDb('get', sql, performance.now() - t) } }
// Slow writes, from every process that opens this db (the server and each agent's mcp.ts): a write
// that waits on another process's lock blocks this one's event loop for up to busy_timeout. Stalls
// on 2026-11-14 were 95% a blocked write; this names both the waiter and the holder (a long tx).
const SLOW_MS = 500, WHO = `${process.pid} ${basename(process.argv[1] ?? 'node')}`
const slow = (what: string, ms: number, sql: string) => { if (ms > SLOW_MS && !process.env.NODE_TEST_CONTEXT) try { appendFileSync(join(DATA_DIR, 'db-slow.log'), `${new Date().toISOString()} ${WHO} ${what} ${Math.round(ms)}ms ${sql.replace(/\s+/g, ' ').slice(0, 160)}\n`) } catch {} }
export const run = (sql: string, ...p: any[]) => { writes++; if (USER_TABLES.test(sql)) userWrites++; const t = performance.now(); try { return stmt(sql).run(...p) } finally { const ms = performance.now() - t; slow('write', ms, sql); recordDb('run', sql, ms) } }

export function tx(fn: () => void) {
  writes++
  const t = performance.now()
  db.exec('begin')
  try { fn(); db.exec('commit') } catch (e) { db.exec('rollback'); throw e } finally { slow('tx', performance.now() - t, new Error().stack?.split('\n')[2]?.trim() ?? '') }
}

// ---------- organising: labels, snooze, notes, briefs, rules ----------
db.exec(`
create table if not exists labels (
  conversation_id text not null, label text not null,
  auto integer default 0,        -- 1 when a rule applied it
  created_at integer,
  primary key (conversation_id, label)
);
create index if not exists labels_label on labels(label);

-- One free-form note per day: the notepad.
create table if not exists notes (day text primary key, body text not null default '', updated_at integer);

-- The daily "welcome back" brief Claude writes.
create table if not exists briefs (day text primary key, created_at integer, data text);

-- Saved searches that act on whatever they match: add a label, archive, or snooze.
create table if not exists rules (
  id text primary key, name text, query text not null,
  action text not null,          -- label | archive | snooze
  value text, enabled integer default 1, created_at integer, last_matched integer
);

-- What agents said they were missing to answer confidently: the backlog of MCPs worth connecting.
create table if not exists capability_wishes (id text primary key, conversation_id text, need text, would_help text, suggested text, created_at integer);

-- Restore points: the working tree at the start of each turn of a perch chat, as a git commit
-- kept under refs/perch/ (never on a branch, never touching the checkout).
create table if not exists snapshots (conversation_id text, turn integer, sha text, cwd text, created_at integer, primary key (conversation_id, turn));

-- Search over what you add (labels, notes) and what GitHub knows (PR titles, branches).
create virtual table if not exists meta_search using fts5(id unindexed, text, tokenize = 'porter unicode61');
`)

// Columns added after the first release. SQLite has no "add column if not exists".
for (const sql of [
  'alter table user_state add column snooze_until integer',
  'alter table prs add column authored integer default 0',
  'alter table prs add column base text',
  'alter table prs add column head text',
  'alter table tool_calls add column detail text',
  'alter table tool_calls add column ms integer', // tool_use to tool_result, from the transcript
  'drop table if exists mcp_events', // briefly duplicated tool_calls (Nov 26); folded into detail + ms
  'alter table conversations add column asks integer default 0',
  'alter table user_state add column seen_at integer',
  'alter table conversations add column stall text',
  'alter table conversations add column slack_url text',
  'alter table conversations add column cost real',
  'alter table conversations add column root_uuid text', // shared by copies of one conversation
  'alter table conversations add column summary text', // a PostHog task run's own summary of what it did
  'alter table user_state add column title text', // a display title perch sets (branches, autoresearch runs)
  'alter table capability_wishes add column kind text', // data | skill | tool
  'alter table conversations add column entrypoint text', // cli, claude-desktop, sdk-cli...: how a transcript's session was started
  'alter table conversations add column you_at integer', // when a person last typed into it, wherever that was
]) { try { db.exec(sql) } catch {} }

// Rebuilds one conversation's meta_search row from its labels, note, branch and PR titles.
export function refreshMeta(id: string) {
  const row = get<{ text: string }>(`
    select coalesce((select group_concat(label, ' ') from labels where conversation_id = ?), '') || ' ' ||
           coalesce((select note from user_state where id = ?), '') || ' ' ||
           coalesce((select title from user_state where id = ?), '') || ' ' ||
           coalesce((select branch from conversations where id = ?), '') || ' ' ||
           coalesce((select group_concat(coalesce(p.title, '') || ' ' || coalesce(p.repo, '') || ' ' || coalesce(p.head, ''), ' ')
                     from conversation_prs cp left join prs p on p.url = cp.url where cp.conversation_id = ?), '') text`, id, id, id, id, id)
  // Called on every transcript append and task sync, almost always with nothing changed: only a
  // different text is worth two full-text writes.
  const text = row?.text.trim() ? row.text : ''
  if (metaText.get(id) === text) return
  run('delete from meta_search where id = ?', id)
  if (text) run('insert into meta_search (id, text) values (?, ?)', id, text.replace(/-/g, ' ') + ' ' + text)
  metaText.set(id, text)
}
const metaText = new Map<string, string>() // what this process last wrote per conversation

// One-time data fixes, each run once and remembered.
db.exec('create table if not exists migrations (name text primary key, at integer)')
export function once(name: string, fn: () => void) {
  if (get('select 1 from migrations where name = ?', name)) return
  fn()
  run('insert or ignore into migrations (name, at) values (?, ?)', name, Date.now())
}

// Conversations that read a PR listing (open_prs, shepherd status) used to be linked to every PR
// in it, so each PR showed the same dozen conversations. Drop those mention links and re-index the
// conversations, which now skip listings. Main calls this before the indexer starts: run from
// any other process, a still-running old perch would write the links straight back.
export function cleanListingLinks() {
  once('2026-11-10-pr-listing-links-v2', () => {
    const noisy = all<{ id: string }>(`select conversation_id id from conversation_prs group by conversation_id having count(*) > 10`).map(r => r.id)
    for (const id of noisy) {
      run('delete from conversation_prs where conversation_id = ? and created = 0', id)
      run(`delete from files where path = (select path from conversations where id = ?)`, id)
    }
  })
}
