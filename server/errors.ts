// Errors, for people. Every failure (a route, a background sync, a crash in the UI) is turned
// into one plain sentence saying what happened and what perch is doing about it, recorded with
// a count, and retried when it is the kind of failure that fixes itself. Recurring ones are
// surfaced in Settings → Health and handed to autopilot.
import { db, run, all } from './db.ts'

db.exec(`create table if not exists errors (
  key text primary key, source text, message text, action text, detail text, count integer default 1,
  first_at integer, last_at integer, status text default 'open' -- open | retrying | needs-you | resolved
)`)

// setup: a connection that isn't set up yet (no Claude, no GitHub login, no PostHog key). The setup checklist
// on Home shows those, so they stay out of Health instead of piling up there on a fresh install.
// authorize: an MCP server (as `claude mcp` names it) that needs OAuth; the UI offers to authorize it.
export type Friendly = { message: string; action: string; status: 'retrying' | 'needs-you' | 'open'; transient: boolean; setup?: boolean; authorize?: string }

import { serverNeedingAuth, serverLabel } from '../web/src/blockers.ts'
export { serverNeedingAuth, serverLabel }

// What a raw error means for the user. Order matters: the first match wins.
export function friendly(e: unknown, what = 'That'): Friendly {
  const raw = String((e as any)?.message ?? e)
  const m = (re: RegExp) => re.test(raw)
  const mcp = serverNeedingAuth(raw)
  if (mcp) return { message: `${serverLabel(mcp)} needs you to authorize it.`, action: `auto-m8 opened ${serverLabel(mcp)}'s sign-in in your browser. Approve it there, then try again.`, status: 'needs-you', transient: false, authorize: mcp }
  if (m(/No PostHog project chosen yet/)) return { message: `${what} needs a PostHog project.`, action: 'It is picked from your key on the next sync, or choose one in Settings → Connections.', status: 'needs-you', transient: false, setup: true }
  if (m(/No PostHog personal API key/)) return { message: `${what} needs your PostHog key.`, action: 'Add it in Settings → Connections.', status: 'needs-you', transient: false, setup: true }
  if (m(/does not support personal API key/)) return { message: `PostHog only allows ${what.toLowerCase()} from its web app, not with a personal API key.`, action: 'auto-m8 used a different way where it can; otherwise do this one in PostHog.', status: 'needs-you', transient: false }
  if (m(/PostHog 401|authentication_failed|invalid.*(api )?key/i)) return { message: 'PostHog rejected your key.', action: 'Create a new personal API key and save it in Settings.', status: 'needs-you', transient: false }
  if (m(/PostHog 403|permission_denied|missing.*scope/i)) return { message: `Your PostHog key can't do this: ${what.toLowerCase()}.`, action: 'Add the missing scope to the key in PostHog → Personal API keys.', status: 'needs-you', transient: false }
  if (m(/^(Error: )?GitHub budget: /)) return { message: raw.replace(/^(Error: )?GitHub budget: /, ''), action: 'Shared by every tool on your GitHub account; when it runs out auto-m8 pauses those calls until the reset. GET /api/github/budget has the per-hour breakdown.', status: 'open', transient: false }
  // GitHub before PostHog: gh's "API rate limit already exceeded" used to be reported as PostHog's.
  if (m(/rate limit is used up|API rate limit (already )?exceeded|graphql_rate_limit|secondary rate limit/i) && !m(/PostHog \d/)) {
    const at = raw.match(/resumes at ([^)]+)\)/)?.[1]
    return { message: `GitHub's API limit for your account is used up${at ? ` until ${at}` : ' for now'}, so ${what.toLowerCase()} is paused.`, action: 'auto-m8 stops calling that GitHub API until it resets, then carries on. Settings → Health shows which parts of auto-m8 used it.', status: 'retrying', transient: false }
  }
  if (m(/PostHog 429/i) || m(/PostHog/) && m(/rate.?limit|throttled/i)) return { message: 'PostHog is rate-limiting auto-m8 for a moment.', action: 'Retrying automatically after a short wait.', status: 'retrying', transient: true }
  if (m(/PostHog 5\d\d|terminated|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|socket hang up|NGHTTP2|network/i)) return { message: 'The connection dropped.', action: 'Retrying automatically.', status: 'retrying', transient: true }
  if (m(/api\.github\.com was unreachable|error connecting to api\.github\.com|TLS handshake timeout|connection reset by peer|i\/o timeout|no such host/i)) return { message: `${what} couldn't reach GitHub (network or VPN).`, action: 'auto-m8 pauses GitHub calls and retries with a growing wait, up to 15 minutes.', status: 'retrying', transient: true }
  if (m(/gh api graphql: (empty reply|.*(HTTP 5\d\d|Something went wrong while executing your query|No server is currently available|unexpected EOF))/i)) return { message: `${what} hit a GitHub hiccup.`, action: 'It tries again on the next pass.', status: 'retrying', transient: true }
  if (m(/gh auth|not logged in.*github|gh: command not found/i)) return { message: 'GitHub CLI isn\'t logged in, so PR status can\'t update.', action: 'Run gh auth login (Settings has a button).', status: 'needs-you', transient: false, setup: true }
  if (m(/spawn claude ENOENT|claude not found/)) return { message: 'Claude Code isn\'t installed yet.', action: 'Install it, then log in from Settings → Connections.', status: 'needs-you', transient: false, setup: true }
  if (m(/claude.*(not logged in|login)/i) || m(/OAuth (session|token)[^.]*(expired|revoked|could not be refreshed)|Failed to authenticate/i) && !m(/codex|PostHog|github/i)) return { message: 'Claude Code isn\'t logged in.', action: 'Log in from Settings → Connections.', status: 'needs-you', transient: false, setup: true }
  if (m(/spend limit|usage-credits|Claude AI usage limit|hit your [\w -]*limit/i)) return { message: `${what} is waiting for Claude's usage limit to reset.`, action: 'It retries on its next pass; nothing was changed.', status: 'retrying', transient: false }
  if (m(/unreadable reply/i)) return { message: `${what} got an answer from Claude it couldn't read.`, action: 'It tries again on its next pass; nothing was changed.', status: 'retrying', transient: false }
  if (m(/timed out|timeout/i)) return { message: `${what} took too long.`, action: 'Retrying with a longer wait.', status: 'retrying', transient: true }
  return { message: `${what} failed: ${raw.replace(/^Error:\s*/, '').slice(0, 140)}`, action: 'Logged. auto-m8 will flag it if it keeps happening.', status: 'open', transient: false }
}

// Failures that aren't bugs in perch's code: they fix themselves (network, rate limits, an expired
// login) or come from outside perch (another tool spending the shared GitHub budget). Self-fix skips them.
export const notPerchBug = (text: string) => /rate.?limit|connect|timed? ?out|ENOTFOUND|ECONNRESET|OAuth|authori[sz]|internet|githubstatus|isn.t running|503|502|504|other tools on your GitHub account/i.test(text)

const keyOf = (source: string, raw: string) => `${source}:${raw.replace(/[0-9a-f]{8,}|\d+/gi, '#').slice(0, 120)}`
export const onError = new Set<() => void>()

export function recordError(source: string, e: unknown, what?: string): Friendly {
  const f = friendly(e, what)
  if (f.setup) return f // the setup checklist covers it
  const raw = String((e as any)?.stack ?? (e as any)?.message ?? e).slice(0, 2000)
  const key = keyOf(source, String((e as any)?.message ?? e))
  run(`insert into errors (key, source, message, action, detail, first_at, last_at, status) values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(key) do update set count = count + 1, last_at = excluded.last_at, message = excluded.message, action = excluded.action, detail = excluded.detail,
         status = case when errors.status = 'resolved' then excluded.status else excluded.status end`,
    key, source, f.message, f.action, raw, Date.now(), Date.now(), f.status)
  onError.forEach(fn => fn())
  return f
}

// A later success clears the matching open errors for that source.
export function resolveErrors(source: string) {
  const n = run(`update errors set status = 'resolved' where source = ? and status != 'resolved'`, source).changes
  if (n) onError.forEach(fn => fn())
}

// Retries a transient failure with backoff (0.5s, 1.5s, 4s), honouring Retry-After.
export async function withRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown
  for (let i = 0; i < tries; i++) {
    try { return await fn() } catch (e: any) {
      last = e
      if (!friendly(e).transient || i === tries - 1) throw e
      const wait = (e?.retryAfter ? e.retryAfter * 1000 : [500, 1500, 4000][i] ?? 4000)
      await new Promise(r => setTimeout(r, wait))
    }
  }
  throw last
}

export const recentErrors = () => all<any>(`select * from errors where last_at > ? order by status = 'resolved', last_at desc limit 50`, Date.now() - 7 * 86400_000)
export const recurring = () => all<any>(`select * from errors where status != 'resolved' and count >= 3 and last_at > ?`, Date.now() - 86400_000)
