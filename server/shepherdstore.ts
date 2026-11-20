// The shepherd's watch list, shared by the server (which runs the shepherd) and the MCP process
// (where agents add and remove PRs). No chat or GitHub imports here: the MCP process stays light.
import { all, db, run } from './db.ts'

db.exec(`create table if not exists shepherd_watch (
  url text primary key, enabled integer not null default 1,
  source text,                       -- auto | manual
  conversation_id text,              -- the shepherd conversation for this PR, resumed per event
  -- Highest id already handed to a run, per kind: GitHub numbers issue comments, review
  -- comments and reviews in separate sequences, so one watermark would hide new review comments.
  seen_comment integer default 0, seen_thread integer default 0, seen_review integer default 0,
  handled_ci text,                   -- head:failing-checks signature already handed to a run
  handled_stamp text,                -- head already handed to a run for stamphog
  pending text, pending_since integer,
  runs_day text, runs integer default 0, paused_reason text, last_run_at integer, created_at integer
)`)

// After review: merge (when the PR's plan opts in), then follow it to production and verify it.
//   stage: open -> deploying -> verifying -> verified | failed | handed-off, or closed.
//   handed-off: live, a verify check wasn't met but nothing regressed, and a follow-up PR owns it.
//   awaiting: the run whose answer perch reads next (verify:1, verify:2), and since when.
for (const sql of [
  "alter table shepherd_watch add column stage text default 'open'",
  'alter table shepherd_watch add column handled_merge text',
  'alter table shepherd_watch add column merged_at integer',
  'alter table shepherd_watch add column merge_sha text',
  'alter table shepherd_watch add column verify_round integer default 0',
  'alter table shepherd_watch add column verify_due_at integer',
  'alter table shepherd_watch add column verify_attempts integer default 0',
  'alter table shepherd_watch add column awaiting text',
  'alter table shepherd_watch add column awaiting_since integer',
  'alter table shepherd_watch add column outcome text',
  // Runs from your account: [start, end] windows. Anything you "posted" inside one was the shepherd.
  'alter table shepherd_watch add column own_windows text',
  'alter table shepherd_watch add column plan_status text', // head:state of the perch/plan status last set
  'alter table shepherd_watch add column receipt_at integer', // when the prerequisites receipt was posted
  'alter table shepherd_watch add column last_detail text', // the last "not deployed" reason, to spot one that never changes
  'alter table shepherd_watch add column after_urls text', // the plan's after: lines (json), for project graphs
  'alter table shepherd_watch add column needs_read_at integer',
  'alter table shepherd_watch add column start_failures integer default 0', // runs that couldn't start in a row // when the last run's NEEDS YOU lines were read
  'alter table shepherd_watch add column paused_at integer', // when paused_reason was set, so a paused PR is retried later
  'alter table shepherd_watch add column revive_at integer', // when a blocked or unverified PR is checked again
  'alter table shepherd_watch add column revives integer default 0', // how many times it was checked again, for the backoff
  'alter table shepherd_watch add column stopped_at integer', // someone took it off with shepherd stop: nothing turns it back on by itself
  'alter table shepherd_watch add column follow_up text', // handed-off: the PR that owns the unmet check
]) { try { db.exec(sql) } catch {} }

// Older shepherd runs marked what they posted with this. Still ignored, no longer written: perch now
// knows the shepherd's comments by when they were posted (during one of its runs).
export const MARK = '<!-- perch-shepherd -->'
export function watch(url: string, source: 'auto' | 'manual' = 'manual') {
  run(`insert into shepherd_watch (url, enabled, source, created_at) values (?, 1, ?, ?)
       on conflict(url) do update set enabled = 1, paused_reason = null, paused_at = null, start_failures = 0, stopped_at = null`, url, source, Date.now())
}
// A deliberate stop: revive() leaves it alone, and the verify run it may have out is dropped.
export const unwatch = (url: string) => run('update shepherd_watch set enabled = 0, awaiting = null, stopped_at = ? where url = ?', Date.now(), url)
export const watched = () => all<any>('select url, enabled, source, stage, outcome, conversation_id, pending, paused_reason, runs, runs_day, last_run_at from shepherd_watch where source != \'not-agent\' order by created_at desc')


// Nothing the shepherd stops on is permanent: blockers clear (a bump merges, a release gets
// approved, a fetch stops failing) without anyone answering the decision. So every stop has a
// way back on its own, checked each tick:
//  - the daily run cap lifts the next day;
//  - a PR that couldn't start a run is tried again an hour later;
//  - a merged PR blocked on someone else, or never verified, is checked again on a backoff
//    (2h, 4h, 8h, 16h, then daily) for a week after the merge. Regressions, hand-offs and PRs
//    someone stopped stay off.
const HOUR = 3600_000
export const reviveBackoff = (revives: number) => Math.min(2 * HOUR * 2 ** revives, 24 * HOUR)
export function revive(now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10)
  run(`update shepherd_watch set paused_reason = null, paused_at = null
       where paused_reason like 'hit % runs today' and coalesce(runs_day, '') != ?`, today)
  run(`update shepherd_watch set paused_reason = null, paused_at = null, start_failures = 0
       where paused_reason like 'couldn''t start a run%' and coalesce(paused_at, 0) <= ?`, now - HOUR)
  run(`update shepherd_watch set stage = 'deploying', enabled = 1, paused_reason = null, awaiting = null,
         verify_attempts = 0, verify_due_at = ?, revive_at = null, revives = coalesce(revives, 0) + 1
       where enabled = 0 and source != 'not-agent' and stopped_at is null
         and (stage = 'blocked' or (stage = 'failed' and outcome like 'NEEDS YOU: no verification%'))
         and coalesce(revive_at, 0) <= ? and merged_at > ?`, now, now, now - 7 * 24 * HOUR)
}
