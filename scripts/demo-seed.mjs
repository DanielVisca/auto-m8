#!/usr/bin/env node
// Builds a throwaway, entirely fictional perch environment for README screenshots and demos.
// Nothing here touches your real ~/.claude, GitHub or perch data: it writes a fake HOME with
// synthetic Claude Code transcripts (a fictional engineer, "Ana", on three fictional repos in the
// fictional GitHub org "acme-co", plus a seeded 90-day history of ~300 PRs across ten repos for
// Insights → PRs), a perch data folder with a brief, notes, needs, routines and
// labels, and fake `claude`, `gh` and `security` commands that the demo server finds first on PATH.
//
// Regenerate and run the demo (then open http://127.0.0.1:4799):
//   npm run demo                      # seed /tmp/ana + /tmp/ana-data, then serve on port 4799
//   npm run demo -- --empty           # first-run state (setup checklist): /tmp/ana-empty, port 4798
//   node scripts/demo-seed.mjs        # seed only, prints the command that serves it
//
// Options: --home <dir> --data <dir> --port <n> --empty --serve
// Safety: the home and data folders are wiped on every seed, so they must live under /tmp.
// Timestamps are relative to "now", so seed right before taking screenshots (the "running"
// conversations are pinned as running in the database; everything else ages normally).
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const flag = n => args.includes(`--${n}`)
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d)
const EMPTY = flag('empty')
const HOME = resolve(opt('home', EMPTY ? '/tmp/ana-empty' : '/tmp/ana'))
const DATA = resolve(opt('data', EMPTY ? '/tmp/ana-empty-data' : '/tmp/ana-data'))
const PORT = Number(opt('port', EMPTY ? 4798 : 4799))
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REAL_HOME = homedir()

for (const d of [HOME, DATA]) {
  const ok = (d.startsWith('/tmp/') || d.startsWith(resolve(tmpdir()) + '/') || d.startsWith('/private/tmp/')) && d !== REAL_HOME && !d.startsWith(REAL_HOME + '/')
  if (!ok) { console.error(`Refusing to use ${d}: the demo wipes its folders, so they must be under /tmp.`); process.exit(1) }
}
rmSync(HOME, { recursive: true, force: true }); rmSync(DATA, { recursive: true, force: true })
const SHIMS = join(HOME, '.local', 'bin') // perch puts ~/.local/bin first on PATH (server/path.ts), ahead of any real claude or gh
mkdirSync(SHIMS, { recursive: true }); mkdirSync(DATA, { recursive: true })
writeFileSync(join(HOME, '.gitconfig'), '[user]\n\tname = Ana Demo\n\temail = ana@acme-co.example\n') // perch derives the owner name from git config

const NODE_DIR = dirname(process.execPath)
const ENV = {
  HOME, PATH: `${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
  PERCH_DATA: DATA, PERCH_PORT: String(PORT), PERCH_OWNER_NAME: 'Ana', PERCH_NO_GH_PROBE: '1', PERCH_DEMO_FIXTURE: join(DATA, 'demo-gh.json'),
}
const serveCmd = `env -i ${Object.entries(ENV).map(([k, v]) => `${k}=${v}`).join(' ')} node server/main.ts`

// ---------- fake CLIs ----------
const shim = (name, body) => { writeFileSync(join(SHIMS, name), `#!/usr/bin/env node\n${body}\n`); chmodSync(join(SHIMS, name), 0o755) }
shim('security', `process.exit(44)`) // no keychain: the real one would hold real keys
shim('claude', `
const a = process.argv.slice(2)
if (a[0] === '--version') console.log('2.1.0 (Claude Code)')
else if (a[0] === 'auth') console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'ana@acme-co.example', subscriptionType: 'max' }))
else if (a[0] === 'mcp') console.log('linear: https://mcp.linear.example/mcp (HTTP) - ✓ Connected\\nsentry: https://mcp.sentry.example/mcp (HTTP) - ✓ Connected')
else if (a.includes('-p')) console.log(JSON.stringify({ type: 'result', subtype: 'success', result: '{"greeting":"","mode":"drive","pickup":[],"dropping":[],"groups":[],"fromNotes":[]}' })) // background jobs get an empty answer
else { console.error('demo claude shim: not available in the demo'); process.exit(1) }`)
shim('gh', String.raw`
const fs = require('fs')
const a = process.argv.slice(2)
const fx = JSON.parse(fs.readFileSync(process.env.PERCH_DEMO_FIXTURE || '/dev/null', 'utf8') || '{"prs":[]}')
// The 90-day history (bulk) only feeds the Insights flow chart and lookups by number; every other
// view (sidebar, PR list, search) sees the hand-written PRs, so the other screenshots stay the same.
const current = fx.prs.filter(p => !p.bulk)
const out = v => { fs.writeSync(1, typeof v === 'string' ? v : JSON.stringify(v)); process.exit(0) } // sync: exit() would cut a piped write at 64 KB
const key = u => u.replace(/^.*github\.com\//, '')
const find = (owner, repo, n) => fx.prs.find(p => p.repo === owner + '/' + repo && p.number === Number(n))
const timeline = p => {
  const t = Date.parse(p.updatedAt), at = m => new Date(t - m * 60000).toISOString()
  const ev = [{ __typename: 'PullRequestCommit', commit: { committedDate: at(240), messageHeadline: p.title } }]
  if (p.review === 'CHANGES_REQUESTED') ev.push({ __typename: 'PullRequestReview', author: { login: 'sam-reviewer', __typename: 'User' }, state: 'CHANGES_REQUESTED', submittedAt: at(90), body: 'Key should be scoped per customer.', comments: { totalCount: 3 } })
  if (p.review === 'APPROVED') ev.push({ __typename: 'PullRequestReview', author: { login: 'sam-reviewer', __typename: 'User' }, state: 'APPROVED', submittedAt: at(45), body: 'Looks good.', comments: { totalCount: 0 } })
  return ev
}
const node = p => {
  const checks = p.checks.map(c => ({ name: c[0], conclusion: c[1], status: c[1] ? 'COMPLETED' : 'IN_PROGRESS', completedAt: c[1] ? p.updatedAt : null, isRequired: true }))
  return { url: p.url, number: p.number, title: p.title, state: p.state, isDraft: !!p.draft, createdAt: p.createdAt, updatedAt: p.updatedAt, mergedAt: p.mergedAt || null, closedAt: p.mergedAt || p.closedAt || null,
    reviewDecision: p.review, headRefName: p.head, baseRefName: p.base, headRefOid: 'a1b2c3d' + p.number, mergeable: 'MERGEABLE', mergeStateStatus: p.review === 'APPROVED' ? 'CLEAN' : 'BLOCKED',
    additions: p.additions, deletions: p.deletions, body: '', repository: { nameWithOwner: p.repo }, author: { login: 'ana-dev' },
    commits: { nodes: [{ commit: { oid: 'a1b2c3d' + p.number, committedDate: p.updatedAt, statusCheckRollup: { id: 'R_' + p.number, state: p.rollup, contexts: { totalCount: checks.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes: checks } } } }] },
    files: { nodes: p.files.map(f => ({ path: f, additions: Math.ceil(p.additions / p.files.length), deletions: Math.floor(p.deletions / p.files.length) })) },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'sam-reviewer' } }] },
    reviewThreads: { nodes: Array.from({ length: p.threads }, () => ({ isResolved: false, isOutdated: false, comments: { nodes: [{ author: { login: 'sam-reviewer', __typename: 'User' } }] } })) },
    timelineItems: { nodes: timeline(p) },
    latestReviews: { nodes: p.review === 'CHANGES_REQUESTED' ? [{ author: { login: 'sam-reviewer', __typename: 'User' }, state: 'CHANGES_REQUESTED', commit: { oid: 'a1b2c3d' + p.number } }] : p.review === 'APPROVED' ? [{ author: { login: 'sam-reviewer', __typename: 'User' }, state: 'APPROVED', commit: { oid: 'a1b2c3d' + p.number } }] : [] },
    comments: { totalCount: p.threads, nodes: [] }, reviews: { nodes: [{ submittedAt: p.updatedAt }] } }
}
const arg = n => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined }
const sub = a.slice(0, 2).join(' ')
if (a[0] === 'auth') { process.stdout.write('github.com\n  ✓ Logged in to github.com account ana-dev (keyring)\n  - Active account: true\n'); process.exit(0) }
if (a[0] === '--version') out('gh version 2.60.0 (demo)\n')
if (sub === 'search prs') {
  const mine = a.some(x => x.startsWith('--author')), words = String(a[2] || '').toLowerCase().split(/\s+/).filter(w => w && !w.includes(':'))
  out(current.filter(p => mine ? p.state === 'OPEN' : words.every(w => (p.title + ' ' + p.repo).toLowerCase().includes(w)))
    .map(p => ({ url: p.url, title: p.title, repository: { nameWithOwner: p.repo }, state: p.state, isDraft: !!p.draft, updatedAt: p.updatedAt, number: p.number })))
}
if (a[0] === 'api' && a[1] === 'rate_limit') out({ resources: { core: { limit: 5000, remaining: 4900, reset: 0 }, search: { limit: 30, remaining: 30, reset: 0 }, graphql: { limit: 5000, remaining: 4900, reset: 0 } } })
if (a[0] === 'api' && a[1] === 'graphql') {
  const q = (a.find(x => x.startsWith('query=')) || '').slice(6)
  const o = a.find(x => x.startsWith('o=')), r = a.find(x => x.startsWith('r=')), n = a.find(x => x.startsWith('n='))
  if (o && r && n) { const p = find(o.slice(2), r.slice(2), n.slice(2)); out({ data: { repository: { pullRequest: p ? node(p) : null } } }) }
  if (/viewer\s*\{\s*login/.test(q) && !/search\(/.test(q)) out({ data: { viewer: { login: 'ana-dev' } } })
  // Insights → PRs (server/prflow.ts): "author:@me is:pr created:>=DATE", "… is:open", and for today "merged:>=" / "closed:>=".
  if (/search\(query:\$q/.test(q)) {
    const s = (a.find(x => x.startsWith('q=')) || '').slice(2), since = f => { const m = s.match(new RegExp(f + ':>=(\\S+)')); return m && Date.parse(m[1]) }
    const keep = p => /is:open/.test(s) ? p.state === 'OPEN' : since('created') ? Date.parse(p.createdAt) >= since('created')
      : since('merged') ? p.mergedAt && Date.parse(p.mergedAt) >= since('merged') : since('closed') ? (p.mergedAt || p.closedAt) && Date.parse(p.mergedAt || p.closedAt) >= since('closed') : false
    out({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: fx.prs.filter(keep).map(node) } } })
  }
  if (/search\(query:/.test(q)) out({ data: { s: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: current.filter(p => p.state === 'OPEN').map(node) } } })
  if (/rateLimit/.test(q)) out({ data: { rateLimit: { remaining: 4900 } } })
  const data = {}
  for (const m of q.matchAll(/(p\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)/g)) { const p = find(m[2], m[3], m[4]); data[m[1]] = { pullRequest: p ? node(p) : null } }
  out({ data })
}
if (a[0] === 'api' && a[1] === 'user') out({ login: 'ana-dev' })
if (sub === 'pr view') out({ state: 'OPEN' })
out('[]')`.replace("const fs = require('fs')", "const fs = require('node:fs')"))

// ---------- the fiction ----------
const NOW = Date.now(), MIN = 60_000, HOUR = 3600_000, DAY = 86400_000
const ORG = 'acme-co'
const uuid = s => { const h = createHash('sha1').update('perch-demo:' + s).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}` }
const iso = t => new Date(t).toISOString()
const prUrl = (repo, n) => `https://github.com/${ORG}/${repo}/pull/${n}`

const PRS = [
  { repo: 'billing-api', number: 212, title: 'Add idempotency key middleware', head: 'ana/idempotency-middleware', base: 'main', review: 'APPROVED', rollup: 'SUCCESS', age: 2 * HOUR, additions: 148, deletions: 12, threads: 0,
    files: ['app/middleware/idempotency.py', 'app/middleware/__init__.py', 'tests/test_idempotency.py'], checks: [['lint', 'SUCCESS'], ['typecheck', 'SUCCESS'], ['unit-tests', 'SUCCESS'], ['integration-tests', 'SUCCESS']] },
  { repo: 'billing-api', number: 213, title: 'Use idempotency keys in charge creation', head: 'ana/idempotency-charges', base: 'ana/idempotency-middleware', review: 'CHANGES_REQUESTED', rollup: 'FAILURE', age: 3 * HOUR, additions: 96, deletions: 31, threads: 3,
    files: ['app/charges/create.py', 'app/charges/schemas.py', 'tests/test_charges.py'], checks: [['lint', 'SUCCESS'], ['typecheck', 'SUCCESS'], ['unit-tests', 'FAILURE'], ['integration-tests', 'SUCCESS']] },
  { repo: 'billing-api', number: 214, title: 'Backfill idempotency keys for pending charges', head: 'ana/idempotency-backfill', base: 'ana/idempotency-charges', review: 'REVIEW_REQUIRED', rollup: 'PENDING', age: 5 * HOUR, additions: 212, deletions: 4, threads: 0,
    files: ['scripts/backfill_idempotency.py', 'migrations/0042_idempotency_keys.sql'], checks: [['lint', 'SUCCESS'], ['typecheck', 'SUCCESS'], ['unit-tests', null], ['integration-tests', null]] },
  { repo: 'billing-api', number: 215, title: 'Fix duplicate invoice emails on retry', head: 'ana/invoice-email-dedupe', base: 'main', review: 'APPROVED', rollup: 'SUCCESS', age: 20 * HOUR, additions: 57, deletions: 9, threads: 0,
    files: ['app/invoices/mailer.py', 'tests/test_mailer.py'], checks: [['lint', 'SUCCESS'], ['typecheck', 'SUCCESS'], ['unit-tests', 'SUCCESS']] },
  { repo: 'web-dashboard', number: 88, title: 'Usage chart: server-side bucketing', head: 'ana/usage-bucketing', base: 'main', review: 'REVIEW_REQUIRED', rollup: 'SUCCESS', age: 2 * HOUR, additions: 184, deletions: 96, threads: 1,
    files: ['src/charts/UsageChart.tsx', 'src/api/usage.ts', 'src/charts/bucketing.test.ts'], checks: [['lint', 'SUCCESS'], ['typecheck', 'SUCCESS'], ['vitest', 'SUCCESS'], ['playwright', 'SUCCESS']] },
  { repo: 'web-dashboard', number: 91, title: 'Dark mode design tokens', head: 'ana/dark-tokens', base: 'main', draft: true, review: null, rollup: 'SUCCESS', age: 26 * HOUR, additions: 320, deletions: 118, threads: 0,
    files: ['src/theme/tokens.ts', 'src/theme/dark.css'], checks: [['lint', 'SUCCESS'], ['typecheck', 'SUCCESS'], ['vitest', 'SUCCESS']] },
  { repo: 'web-dashboard', number: 86, title: 'Fix tooltip overflow on mobile Safari', head: 'ana/tooltip-overflow', base: 'main', state: 'MERGED', review: 'APPROVED', rollup: 'SUCCESS', age: 2 * DAY, additions: 22, deletions: 5, threads: 0,
    files: ['src/components/Tooltip.tsx'], checks: [['lint', 'SUCCESS'], ['vitest', 'SUCCESS']] },
  { repo: 'docs-site', number: 31, title: 'Document webhook retries', head: 'ana/webhook-retries-docs', base: 'main', state: 'MERGED', review: 'APPROVED', rollup: 'SUCCESS', age: 22 * HOUR, additions: 74, deletions: 3, threads: 0,
    files: ['docs/webhooks/retries.md'], checks: [['build', 'SUCCESS'], ['link-check', 'SUCCESS']] },
  { repo: 'docs-site', number: 34, title: 'Rewrite the quickstart for the new SDK', head: 'ana/quickstart-rewrite', base: 'main', draft: true, review: null, rollup: 'SUCCESS', age: 7 * DAY, additions: 210, deletions: 160, threads: 0,
    files: ['docs/quickstart.md', 'docs/sdk/install.md'], checks: [['build', 'SUCCESS'], ['link-check', 'SUCCESS']] },
].map(p => ({ ...p, url: prUrl(p.repo, p.number), repo: `${ORG}/${p.repo}`, state: p.state ?? 'OPEN', draft: !!p.draft,
  createdAt: iso(NOW - p.age - 2 * DAY), updatedAt: iso(NOW - p.age), mergedAt: p.state === 'MERGED' ? iso(NOW - p.age) : null }))

// Ninety days of Ana's PRs across ten repos, for Insights → PRs. Seeded, so every run draws the same
// history (only "now" moves). Outcomes follow server/prflow.ts: merged, closed = abandoned, and for open
// PRs the idle time (3 and 14 days) plus review decision and CI rollup decide moving / needs you / stalled / stale.
function history() {
  let seed = 0x5eed1e5
  const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const pick = l => l[Math.floor(rnd() * l.length)]
  const between = (a, b) => a + rnd() * (b - a)
  const normal = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd())
  const REPOS = [
    ['billing-api', 'billing', 48, 140, ['invoice PDFs', 'charge creation', 'refunds', 'subscription renewals', 'tax rates', 'dunning emails']],
    ['web-dashboard', 'dashboard', 44, 30, ['usage chart', 'settings page', 'team table', 'date picker', 'billing page', 'empty states']],
    ['ingest', 'ingest', 36, 410, ['batch endpoint', 'event parser', 'dedupe step', 'queue consumer', 'rate limiter']],
    ['sdk-js', 'sdk', 30, 260, ['fetch client', 'retry queue', 'type definitions', 'browser bundle', 'Node build']],
    ['search', 'search', 28, 180, ['query parser', 'index builder', 'facets', 'autocomplete', 'ranking']],
    ['auth', 'auth', 26, 330, ['session tokens', 'SSO login', 'password reset', 'API keys', 'two-factor setup']],
    ['data-pipeline', 'pipeline', 24, 90, ['nightly export', 'warehouse sync', 'dbt models', 'backfill job', 'schema checks']],
    ['mobile-app', 'mobile', 22, 520, ['push notifications', 'offline sync', 'onboarding', 'settings screen', 'deep links']],
    ['infra', 'infra', 22, 640, ['staging cluster', 'CI runners', 'Postgres backups', 'load balancer', 'alert rules']],
    ['docs-site', 'docs', 20, 1, ['quickstart', 'API reference', 'webhook guide', 'changelog', 'search page']],
  ]
  const TEMPLATES = [
    'fix({s}): handle missing fields in {c}', 'fix({s}): {c} fails on empty input', 'feat({s}): add metrics to {c}', 'refactor({s}): simplify {c}',
    'perf({s}): speed up {c}', 'test({s}): add tests for {c}', 'chore({s}): clean up {c} config', 'fix({s}): flaky {c} test',
    'feat({s}): put the new {c} behind a flag', 'fix({s}): clearer error message in {c}', 'chore({s}): remove unused {c} code', 'fix({s}): {c} timeout under load',
    'feat({s}): log a warning when {c} retries', 'refactor({s}): move {c} into its own module', 'fix({s}): off-by-one in {c} pagination',
  ]
  // Outcome mix for 300 PRs: ~72% merged, 6% moving, 7% needs you, 5% stalled, 2% stale, 8% abandoned.
  const outcomes = [...Array(216).fill('merged'), ...Array(18).fill('moving'), ...Array(21).fill('needs-you'), ...Array(14).fill('stalled'), ...Array(6).fill('stale'), ...Array(25).fill('abandoned')]
  for (let i = outcomes.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [outcomes[i], outcomes[j]] = [outcomes[j], outcomes[i]] }
  const repos = REPOS.flatMap(r => Array(r[2]).fill(r))
  for (let i = repos.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [repos[i], repos[j]] = [repos[j], repos[i]] }
  const used = new Set(PRS.map(p => p.url)), titles = new Set()
  let needs = 0
  const out = outcomes.map((outcome, i) => {
    const [repo, scope, , , comps] = repos[i]
    let title
    do title = pick(TEMPLATES).replace('{s}', scope).replace('{c}', pick(comps)); while (titles.has(title))
    titles.add(title)
    let created, updated, state = 'OPEN', mergedAt = null, closedAt = null, review = 'REVIEW_REQUIRED', rollup = 'SUCCESS', draft = false, threads = 0
    if (outcome === 'merged') {
      created = NOW - between(0.4, 89.5) * DAY
      let hours = Math.min(20 * 24, Math.max(0.4, Math.exp(Math.log(10) + 1.1 * normal()))) // median ~10h
      if (created + hours * HOUR > NOW - 10 * MIN) hours = (NOW - created) / HOUR * between(0.3, 0.9)
      updated = created + hours * HOUR; state = 'MERGED'; mergedAt = iso(updated); review = 'APPROVED'
    } else if (outcome === 'abandoned') {
      created = NOW - between(1, 89.5) * DAY
      updated = Math.min(NOW - HOUR, created + between(2, 12 * 24) * HOUR); state = 'CLOSED'; closedAt = iso(updated)
      review = pick(['REVIEW_REQUIRED', 'REVIEW_REQUIRED', 'CHANGES_REQUESTED', null]); rollup = pick(['SUCCESS', 'FAILURE', 'FAILURE'])
    } else if (outcome === 'moving') {
      updated = NOW - between(0.05, 2.8) * DAY; created = updated - between(0, 3) * DAY
      draft = rnd() < 0.3; review = draft ? null : 'REVIEW_REQUIRED'; rollup = pick(['SUCCESS', 'SUCCESS', 'PENDING'])
    } else if (outcome === 'needs-you') {
      updated = NOW - between(0.1, 9) * DAY; created = updated - between(0, 4) * DAY
      const kind = needs++ % 3 // changes requested, red CI, approved and green
      if (kind === 0) { review = 'CHANGES_REQUESTED'; rollup = pick(['SUCCESS', 'FAILURE']); threads = 1 + Math.floor(rnd() * 4) }
      else if (kind === 1) rollup = 'FAILURE'
      else review = 'APPROVED'
    } else if (outcome === 'stalled') {
      updated = NOW - between(3.3, 13.5) * DAY; created = updated - between(0, 6) * DAY
      draft = rnd() < 0.25; review = draft ? null : 'REVIEW_REQUIRED'
    } else {
      updated = NOW - between(15, 60) * DAY; created = updated - between(0, 10) * DAY
      draft = rnd() < 0.4; review = draft ? null : 'REVIEW_REQUIRED'
    }
    const additions = Math.round(Math.exp(between(Math.log(6), Math.log(420)))), deletions = Math.round(additions * between(0.05, 0.8))
    const ok = rollup === 'FAILURE' ? 'FAILURE' : rollup === 'PENDING' ? null : 'SUCCESS'
    return { repo, title, created, updated, state, mergedAt, closedAt, review, rollup, draft, threads, additions, deletions,
      checks: [['lint', 'SUCCESS'], ['typecheck', 'SUCCESS'], ['tests', ok]], files: [`src/${scope}/${title.split(': ')[1].split(' ').slice(-1)[0].toLowerCase()}.ts`] }
  })
  // Numbers grow with time inside each repo, below the hand-written PRs where those exist.
  const next = Object.fromEntries(REPOS.map(r => [r[0], r[3]]))
  const org = out.sort((a, b) => a.created - b.created).map(p => {
    let n = next[p.repo]; while (used.has(prUrl(p.repo, n))) n++
    next[p.repo] = n + 1; used.add(prUrl(p.repo, n))
    const head = 'ana/' + p.title.split(': ')[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
    return { ...p, bulk: true, number: n, url: prUrl(p.repo, n), repo: `${ORG}/${p.repo}`, head, base: 'main',
      createdAt: iso(p.created), updatedAt: iso(p.updated), created: undefined, updated: undefined }
  })
  // A few in Ana's own dotfiles repo, so the chart offers "All repos" next to the org.
  const own = ['chore: bump node to 22 in the toolchain file', 'feat: shell alias for the staging tunnel', 'fix: git prune alias on macOS', 'chore: tidy the editor settings'].map((title, i) => {
    const created = NOW - between(2, 80) * DAY, merged = created + between(0.2, 3) * HOUR
    return { repo: 'ana-dev/dotfiles', number: 41 + i, url: `https://github.com/ana-dev/dotfiles/pull/${41 + i}`, title, head: `ana/dotfiles-${i}`, base: 'main', bulk: true,
      state: 'MERGED', review: null, rollup: 'SUCCESS', draft: false, threads: 0, additions: 12, deletions: 4, checks: [], files: ['.zshrc'],
      createdAt: iso(created), updatedAt: iso(merged), mergedAt: iso(merged), closedAt: null }
  })
  return [...org, ...own]
}
writeFileSync(ENV.PERCH_DEMO_FIXTURE, JSON.stringify({ prs: EMPTY ? [] : [...PRS, ...history()] }))

const PROJECTS = { 'billing-api': 'billing-api', 'web-dashboard': 'web-dashboard', 'docs-site': 'docs-site' }
const dir = r => join(HOME, 'Development', r)

// A turn is [userText, ...assistant parts]; a part is a string (text) or { tool, input, result, error? }.
// `end`: where the conversation stands now. `age`: minutes since its last message.
const CONVOS = [
  { id: 'idem-mw', repo: 'billing-api', branch: 'ana/idempotency-middleware', age: 95, pr: 212, labels: ['billing', 'idempotency'], title: 'Add idempotency key middleware',
    turns: [
      ['Customers are getting double-charged when our mobile client retries a POST /charges after a timeout. Add idempotency key support as middleware: same Idempotency-Key header within 24h returns the stored response instead of running the handler again.',
        'I will start by looking at how requests flow through the app and where a store for keys would fit.',
        { tool: 'Read', input: { file_path: 'app/main.py' }, result: 'from fastapi import FastAPI\nfrom app.middleware import request_id\n\napp = FastAPI()\napp.add_middleware(request_id.RequestIdMiddleware)\n...' },
        { tool: 'Grep', input: { pattern: 'redis', path: 'app' }, result: 'app/cache.py:3:import redis.asyncio as redis\napp/cache.py:11:client = redis.from_url(settings.REDIS_URL)' },
        'There is already a Redis client in `app/cache.py`, so keys can live there with a 24h TTL. Plan:\n\n1. `IdempotencyMiddleware` reads `Idempotency-Key` on POST/PATCH only.\n2. First request takes a short lock (`SET NX`), runs the handler, stores status + body.\n3. A replay returns the stored response with `Idempotent-Replayed: true`.\n4. A concurrent duplicate gets a `409` while the first is still running.\n\nWriting it now.',
        { tool: 'Write', input: { file_path: 'app/middleware/idempotency.py' }, result: 'File created successfully at: app/middleware/idempotency.py' },
        { tool: 'Edit', input: { file_path: 'app/main.py', old_string: 'app.add_middleware(request_id.RequestIdMiddleware)', new_string: 'app.add_middleware(request_id.RequestIdMiddleware)\napp.add_middleware(IdempotencyMiddleware)' }, result: 'The file app/main.py has been updated.' },
        { tool: 'Bash', input: { command: 'pytest tests/test_idempotency.py -q' }, result: '.......                                                                  [100%]\n7 passed in 0.84s' },
        'The middleware is in and tested: replay, concurrent duplicate, key reuse with a different body (`422`), and expiry. I have not wired it into charge creation yet, that is the next PR.'],
      ['Nice. Open a PR for just the middleware.',
        { tool: 'Bash', input: { command: 'gh pr create --title "Add idempotency key middleware" --body "Stores responses by Idempotency-Key for 24h so retried POSTs replay instead of re-running."' }, result: prUrl('billing-api', 212) },
        'Opened ' + prUrl('billing-api', 212) + '. CI is green and Sam approved. The stacked PR that uses it in charge creation is #213.'],
    ] },
  { id: 'idem-charges', repo: 'billing-api', branch: 'ana/idempotency-charges', age: 180, pr: 213, labels: ['billing', 'idempotency'], title: 'Use idempotency keys in charge creation',
    turns: [
      ['Now use the idempotency middleware in charge creation. Stack it on the middleware branch.',
        { tool: 'Read', input: { file_path: 'app/charges/create.py' }, result: 'async def create_charge(payload: ChargeIn, db: Session):\n    ...' },
        { tool: 'Edit', input: { file_path: 'app/charges/create.py' }, result: 'The file app/charges/create.py has been updated.' },
        { tool: 'Bash', input: { command: 'gh pr create --base ana/idempotency-middleware --title "Use idempotency keys in charge creation"' }, result: prUrl('billing-api', 213) },
        'Done: charge creation now records the idempotency key on the charge row and short-circuits on a replay. Stacked on #212: ' + prUrl('billing-api', 213)],
      ['Sam asked for changes and unit-tests is red. Look at it.',
        { tool: 'Bash', input: { command: 'pytest tests/test_charges.py -q' }, result: 'FAILED tests/test_charges.py::test_replay_returns_original_amount - assert 4200 == 4250\n1 failed, 12 passed', error: true },
        'The replay test fails because the stored response is written before the tax line is added. I will move the write after `apply_tax` and add the case Sam described (two keys, same payload).'],
    ] },
  { id: 'idem-backfill', repo: 'billing-api', branch: 'ana/idempotency-backfill', age: 300, pr: 214, labels: ['billing', 'idempotency'], title: 'Backfill idempotency keys for pending charges',
    turns: [
      ['Pending charges created before the middleware have no key. Write a backfill that derives one from the charge id and attempt number, in batches.',
        { tool: 'Write', input: { file_path: 'scripts/backfill_idempotency.py' }, result: 'File created successfully at: scripts/backfill_idempotency.py' },
        { tool: 'Bash', input: { command: 'gh pr create --base ana/idempotency-charges --title "Backfill idempotency keys for pending charges"' }, result: prUrl('billing-api', 214) },
        'The backfill runs in batches of 500 with a sleep between them, is safe to re-run, and logs a count per batch. Opened ' + prUrl('billing-api', 214) + ' on top of #213. CI is still running.'],
    ] },
  { id: 'invoice-dedupe', repo: 'billing-api', branch: 'ana/invoice-email-dedupe', age: 20 * 60, pr: 215, labels: ['billing'], title: 'Fix duplicate invoice emails on retry',
    turns: [
      ['Customers get the same invoice email twice when the mailer job retries. Fix it.',
        { tool: 'Read', input: { file_path: 'app/invoices/mailer.py' }, result: 'def send_invoice_email(invoice_id): ...' },
        { tool: 'Edit', input: { file_path: 'app/invoices/mailer.py' }, result: 'The file app/invoices/mailer.py has been updated.' },
        { tool: 'Bash', input: { command: 'gh pr create --title "Fix duplicate invoice emails on retry"' }, result: prUrl('billing-api', 215) },
        'The job now records `emailed_at` in the same transaction as the send, and skips when it is set. ' + prUrl('billing-api', 215)],
    ] },
  { id: 'proration', repo: 'billing-api', branch: 'main', age: 25, labels: ['billing'], title: 'Decide proration rounding for plan downgrades', att: 'asks whether to round proration half-up or half-even before it changes the invoice maths',
    turns: [
      ['When a customer downgrades mid-cycle we credit the unused part of the old plan. Finance wants the rounding to match what the invoice PDF shows. What do we do today?',
        { tool: 'Grep', input: { pattern: 'def prorate', path: 'app' }, result: 'app/plans/proration.py:18:def prorate(old, new, days_left, days_in_cycle):' },
        'Today `prorate` computes in floating point and rounds half-even at the very end, so a credit of 12.345 becomes 12.34 while the invoice PDF (which rounds each line) shows 12.35. They disagree by one cent on about 1 in 8 downgrades.\n\nTwo ways to fix it: round every line half-up like the PDF, or switch the PDF to half-even like the ledger. Half-up matches what customers already see on past invoices, and half-even is what the ledger and the tax export use.\n\nWhich do you prefer: should I round half-up everywhere?'],
    ] },
  { id: 'flaky-refund', repo: 'billing-api', branch: 'ana/fix-flaky-refund', age: 40, labels: ['billing', 'ci'], title: 'Flaky test_refund_flow on CI', stall: true, att: 'stopped mid-command: the 100-run pytest loop needs your approval to continue',
    turns: [
      ['test_refund_flow fails about one in ten CI runs. Find out why.',
        { tool: 'Bash', input: { command: 'pytest tests/test_refunds.py -q --count=30 -x' }, result: 'FAILED tests/test_refunds.py::test_refund_flow - AssertionError: expected status "refunded", got "pending" (run 17 of 30)', error: true },
        'It fails when the webhook handler runs before the refund row is committed. Re-running a few more times with a sleep removed to confirm the ordering.',
        { tool: 'Bash', input: { command: 'pytest tests/test_refunds.py -q --count=100 -p no:randomly' }, pending: true }],
    ] },
  { id: 'webhook-design', repo: 'billing-api', branch: 'main', age: 4 * 24 * 60, labels: ['billing', 'design'], state: 'done', title: 'Webhook retry backoff: design notes',
    turns: [
      ['Sketch a retry schedule for outbound webhooks. We currently retry 3 times, 1 minute apart.',
        'Proposal: exponential backoff with full jitter, 8 attempts over about 24 hours (1m, 5m, 30m, 2h, 6h, 12h, 24h), then park the delivery as failed and surface it in the dashboard. Use a per-endpoint circuit breaker after 20 consecutive failures so one dead endpoint cannot starve the queue.'],
    ] },
  { id: 'indexes', repo: 'billing-api', branch: 'main', age: 30, running: true, labels: ['billing', 'database'], title: 'Postgres index review for the invoices table',
    turns: [
      ['Slow query log shows invoices lookups by customer and status taking 400ms+. Review the indexes.',
        { tool: 'Bash', input: { command: 'psql -c "EXPLAIN ANALYZE SELECT * FROM invoices WHERE customer_id = 4821 AND status = \'open\'"' }, result: 'Seq Scan on invoices  (cost=0.00..18934.00 rows=3 width=212) (actual time=412.318..412.351 rows=3 loops=1)' },
        'Sequential scan confirmed. A partial composite index on `(customer_id) WHERE status = \'open\'` covers the hot path and stays small. Creating it concurrently on the staging copy now.'],
    ] },
  { id: 'usage-chart', repo: 'web-dashboard', branch: 'ana/usage-bucketing', age: 120, pr: 88, labels: ['dashboard', 'charts'], title: 'Usage chart: server-side bucketing',
    turns: [
      ['The usage chart downloads every raw point and buckets in the browser, which is slow for 90-day ranges. Move bucketing to the API.',
        { tool: 'Read', input: { file_path: 'src/charts/UsageChart.tsx' }, result: 'const buckets = useMemo(() => bucketize(points, interval), [points, interval])' },
        { tool: 'Edit', input: { file_path: 'src/api/usage.ts' }, result: 'The file src/api/usage.ts has been updated.' },
        { tool: 'Bash', input: { command: 'npx vitest run src/charts' }, result: 'Test Files  3 passed (3)\n     Tests  21 passed (21)' },
        { tool: 'Bash', input: { command: 'gh pr create --title "Usage chart: server-side bucketing"' }, result: prUrl('web-dashboard', 88) },
        'The chart now asks the API for `interval=hour|day|week` buckets, so a 90-day view loads 90 points instead of about 130k. ' + prUrl('web-dashboard', 88)],
    ] },
  { id: 'v2-query', repo: 'web-dashboard', branch: 'ana/v2-query-endpoint', age: 50, labels: ['dashboard', 'charts'], title: 'Migrate charts to the v2 query endpoint', att: 'asks whether to keep the v1 query endpoint behind a flag until the CSV export moves',
    turns: [
      ['Move the charts over to /api/v2/query. Is the old endpoint used by anything else?',
        { tool: 'Grep', input: { pattern: '/api/v1/query', path: '.' }, result: 'src/charts/useSeries.ts:14\nsrc/export/csv.ts:9\nscripts/smoke.sh:4' },
        'Charts are migrated and tests pass. The old endpoint is still called by the CSV export and the smoke script, so deleting it now would break both.\n\nWant me to keep `/api/v1/query` behind a feature flag until the export moves over?'],
    ] },
  { id: 'dark-mode', repo: 'web-dashboard', branch: 'ana/dark-tokens', age: 26 * 60, pr: 91, labels: ['dashboard', 'design'], title: 'Dark mode design tokens',
    turns: [
      ['Start dark mode: extract our colors into design tokens first, no visual changes yet.',
        { tool: 'Write', input: { file_path: 'src/theme/tokens.ts' }, result: 'File created successfully at: src/theme/tokens.ts' },
        { tool: 'Bash', input: { command: 'gh pr create --draft --title "Dark mode design tokens"' }, result: prUrl('web-dashboard', 91) },
        'Tokens extracted (surface, text, border, accent, chart series) with a light and a dark value each. Draft PR: ' + prUrl('web-dashboard', 91)],
    ] },
  { id: 'tooltip', repo: 'web-dashboard', branch: 'ana/tooltip-overflow', age: 2 * 24 * 60, pr: 86, labels: ['dashboard'], title: 'Fix tooltip overflow on mobile Safari',
    turns: [
      ['Tooltips run off the right edge on iOS Safari. Fix it.',
        { tool: 'Edit', input: { file_path: 'src/components/Tooltip.tsx' }, result: 'The file src/components/Tooltip.tsx has been updated.' },
        { tool: 'Bash', input: { command: 'gh pr create --title "Fix tooltip overflow on mobile Safari"' }, result: prUrl('web-dashboard', 86) },
        'The tooltip now flips to the left when it would cross the viewport, using `visualViewport` width (Safari reports the layout viewport otherwise). ' + prUrl('web-dashboard', 86)],
    ] },
  { id: 'first-paint', repo: 'web-dashboard', branch: 'main', age: 6 * 60, labels: ['dashboard', 'performance'], title: 'Investigate slow dashboard first paint',
    turns: [
      ['The dashboard takes 3+ seconds to show anything on a cold load. Where does the time go?',
        { tool: 'Bash', input: { command: 'npx lighthouse http://localhost:5173 --only-categories=performance --quiet' }, result: 'First Contentful Paint 3.1 s\nLargest Contentful Paint 4.4 s\nTotal Blocking Time 640 ms' },
        'Two things dominate: a 1.4 MB charting bundle loaded up front, and three sequential API calls before the first chart renders. Lazy-loading the chart library and fetching the layout and series in parallel should bring FCP under 1.5 s. I wrote both up as separate small changes in the notes.'],
    ] },
  { id: 'a11y', repo: 'web-dashboard', branch: 'main', age: 3 * 24 * 60, later: true, labels: ['dashboard', 'a11y'], title: 'Accessibility pass on the filter bar',
    turns: [
      ['Run an accessibility pass over the filter bar: keyboard order, labels, contrast.',
        'Found 4 issues: the date picker traps focus, the segmented control lacks a group label, two chips are below 4.5:1 contrast, and the clear button has no accessible name. Fixes are small; I can batch them into one PR when you want them.'],
    ] },
  { id: 'sig-docs', repo: 'docs-site', branch: 'ana/webhook-signatures', age: 65, labels: ['docs'], title: 'Document webhook signature verification', att: 'asks whether to add a Python example to the signature docs',
    turns: [
      ['Add a docs page explaining how to verify our webhook signatures. Node example first.',
        { tool: 'Write', input: { file_path: 'docs/webhooks/signatures.md' }, result: 'File created successfully at: docs/webhooks/signatures.md' },
        'The page covers the `Acme-Signature` header format, the timestamp tolerance (5 minutes), a constant-time comparison, and a Node example using `crypto.timingSafeEqual`. Several readers will be on Python.\n\nShall I add a Python example too?'],
    ] },
  { id: 'retry-docs', repo: 'docs-site', branch: 'ana/webhook-retries-docs', age: 22 * 60, pr: 31, labels: ['docs'], title: 'Document webhook retries',
    turns: [
      ['Document the new webhook retry schedule from the design notes.',
        { tool: 'Write', input: { file_path: 'docs/webhooks/retries.md' }, result: 'File created successfully at: docs/webhooks/retries.md' },
        { tool: 'Bash', input: { command: 'gh pr create --title "Document webhook retries"' }, result: prUrl('docs-site', 31) },
        'Written and merged: the page lists the 8-attempt schedule, the circuit breaker, and how to replay a failed delivery. ' + prUrl('docs-site', 31)],
    ] },
  { id: 'quickstart', repo: 'docs-site', branch: 'ana/quickstart-rewrite', age: 8 * 60, pr: 34, labels: ['docs'], title: 'Rewrite the quickstart for the new SDK',
    turns: [
      ['Rewrite the quickstart so a new user gets a first charge in under 5 minutes with the new SDK.',
        { tool: 'Edit', input: { file_path: 'docs/quickstart.md' }, result: 'The file docs/quickstart.md has been updated.' },
        { tool: 'Bash', input: { command: 'gh pr create --draft --title "Rewrite the quickstart for the new SDK"' }, result: prUrl('docs-site', 34) },
        'The new quickstart is 6 steps: install, set the key, create a customer, create a charge, handle the webhook, go live. Draft PR: ' + prUrl('docs-site', 34)],
    ] },
  { id: 'links', repo: 'docs-site', branch: 'main', age: 2 * 24 * 60, state: 'done', labels: ['docs'], title: 'Broken links audit',
    turns: [
      ['Crawl the docs and list broken links.',
        { tool: 'Bash', input: { command: 'npx linkinator ./build --recurse' }, result: 'Scanned 412 links in 9.2 seconds.\n3 broken links found.' },
        'Three broken links, all in the changelog (two renamed pages, one removed). I fixed them and added `link-check` to CI.'],
    ] },
  { id: 'rate-limit', repo: 'billing-api', branch: 'main', age: 2 * 24 * 60 + 300, labels: ['billing', 'design'], title: 'Rate limiting: token bucket vs sliding window',
    turns: [
      ['Compare a token bucket and a sliding window for per-customer rate limiting on /charges.',
        'For bursty billing clients a token bucket is the better fit: it allows short bursts up to the bucket size while enforcing the average rate, and it needs one counter and one timestamp per customer in Redis. A sliding window log is exact but costs memory proportional to the request rate. Recommendation: token bucket, 50 burst, 10 per second.'],
    ] },
  { id: 'release-notes', repo: 'billing-api', branch: 'main', age: 6 * 24 * 60, labels: ['billing'], title: 'Release notes for v2.4',
    turns: [
      ['Draft the release notes for v2.4 from the merged PRs.',
        'Drafted: three features (partial refunds API, invoice PDF locale, webhook signing v2), five fixes, and one deprecation (the v1 refunds endpoint, removal in v3.0).'],
    ] },
]

// ---------- transcripts ----------
const slug = p => p.replace(/[^a-zA-Z0-9]/g, '-')
const usage = () => ({ input_tokens: 1200 + Math.floor(Math.random() * 3000), output_tokens: 300 + Math.floor(Math.random() * 900), cache_read_input_tokens: 20000 + Math.floor(Math.random() * 30000), cache_creation_input_tokens: 800 })
function transcript(c) {
  const cwd = dir(c.repo), sessionId = uuid(c.id), end = NOW - c.age * MIN
  const lines = []
  let n = 0, parent = null
  const total = c.turns.reduce((s, t) => s + t.length, 0)
  const at = () => iso(end - (total - n) * 70_000)
  const base = (type, extra) => { const u = uuid(`${c.id}:${n++}`); const line = { parentUuid: parent, isSidechain: false, userType: 'external', cwd, sessionId, version: '2.1.0', gitBranch: c.branch, type, uuid: u, timestamp: at(), ...extra }; parent = u; lines.push(line); return u }
  lines.push({ type: 'ai-title', sessionId, aiTitle: c.title })
  for (const turn of c.turns) {
    base('user', { message: { role: 'user', content: turn[0] } })
    for (const part of turn.slice(1)) {
      const mid = 'msg_' + uuid(`${c.id}:m${n}`).replace(/-/g, '').slice(0, 24)
      if (typeof part === 'string') base('assistant', { requestId: 'req_' + mid, message: { id: mid, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: part }], stop_reason: 'end_turn', usage: usage() } })
      else {
        const tid = 'toolu_' + uuid(`${c.id}:t${n}`).replace(/-/g, '').slice(0, 22)
        base('assistant', { requestId: 'req_' + mid, message: { id: mid, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: tid, name: part.tool, input: part.input }], stop_reason: 'tool_use', usage: usage() } })
        if (!part.pending) base('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: part.result, ...(part.error ? { is_error: true } : {}) }] } })
      }
    }
  }
  const folder = join(HOME, '.claude', 'projects', slug(cwd)); mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, sessionId + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return sessionId
}

// ---------- seed ----------
mkdirSync(join(HOME, '.claude', 'projects'), { recursive: true })
mkdirSync(join(HOME, 'Development'), { recursive: true })
if (!EMPTY) {
  for (const repo of Object.keys(PROJECTS)) {
    mkdirSync(dir(repo), { recursive: true })
    try { execFileSync('git', ['init', '-q', '-b', 'main', dir(repo)], { env: { ...process.env, HOME } }); execFileSync('git', ['-C', dir(repo), 'remote', 'add', 'origin', `https://github.com/${ORG}/${repo}.git`], { env: { ...process.env, HOME } }) } catch {}
  }
  writeFileSync(join(DATA, 'settings.json'), JSON.stringify({
    port: PORT, ui: { theme: 'dark' }, sources: [{ id: 'claude', label: 'Claude Code', dir: join(HOME, '.claude', 'projects'), configDir: join(HOME, '.claude') }], owner: { name: 'Ana' }, welcome: false, autonomy: { enabled: true },
    chat: { permissionMode: 'auto', model: '', cwd: join(HOME, 'Development'), chrome: false, idleMinutes: 20 },
    ai: { model: 'sonnet', dailyBrief: false, attention: false }, needs: { enabled: false, engine: 'claude:sonnet', maxRunsPerDay: 0 },
    shepherd: { auto: false, autoSince: 0, pollSeconds: 45, quietSeconds: 60, maxRunsPerDay: 0 }, evolve: { enabled: false, forge: false, tune: false, resume: false },
    lifecycle: { enabled: false }, browser: { enabled: false }, posthog: { host: 'https://us.posthog.com', projectId: 0, pollSeconds: 60 },
    window: { alwaysOnTop: false, hotkey: 'Control+Alt+Space', bounds: null, autoMini: false, autoTuck: false },
  }, null, 2))
  const ids = Object.fromEntries(CONVOS.map(c => [c.id, transcript(c)]))

  // Perch's own state lives in its database. Importing db.ts creates the schema in DATA.
  process.env.HOME = HOME; process.env.PERCH_DATA = DATA
  const { run } = await import('../server/db.ts')
  await import('../server/attention.ts') // creates the attention table
  const day = new Date(NOW).toLocaleDateString('sv'), ago = n => new Date(NOW - n * DAY).toLocaleDateString('sv')
  for (const c of CONVOS) {
    const id = ids[c.id]
    const state = c.running ? 'running' : c.later ? 'later' : c.state ?? null
    const auto = c.running || c.later || c.state ? 0 : 1
    run('insert or replace into user_state (id, state, state_auto, pinned, note, state_at, seen_at, snooze_until) values (?, ?, ?, ?, ?, ?, ?, ?)',
      id, state, auto, c.id === 'idem-mw' ? 1 : 0, null, NOW - c.age * MIN, c.age > 60 && !c.att ? NOW - (c.age - 30) * MIN : null, c.later ? NOW + 2 * DAY : null)
    if (c.att) run('insert or replace into attention (id, verdict, reason, judged_at, judged_updated_at) values (?, 1, ?, ?, ?)', id, c.att, NOW - 2 * MIN, NOW - c.age * MIN)
    for (const l of c.labels ?? []) run('insert or ignore into labels (conversation_id, label, auto, created_at) values (?, ?, 0, ?)', id, l, NOW)
  }
  const link = (a, b, kind, note) => run('insert or ignore into links (a, b, kind, note, created_at) values (?, ?, ?, ?, ?)', ids[a], ids[b], kind, note, NOW)
  link('idem-mw', 'idem-charges', 'continues', 'stacked on the middleware PR')
  link('idem-charges', 'idem-backfill', 'continues', 'backfill for charges created before the middleware')
  link('proration', 'invoice-dedupe', 'related', 'both touch invoice rounding and the invoice mailer')
  link('webhook-design', 'retry-docs', 'context', 'the retry schedule these docs describe')
  link('first-paint', 'usage-chart', 'related', 'payload size drives first paint')

  run('insert into briefs (day, created_at, data) values (?, ?, ?)', day, NOW - 40 * MIN, JSON.stringify({
    greeting: 'A driving day: three billing PRs are stacked and one is blocked on review, so finishing them matters more than starting anything new.',
    mode: 'drive',
    pickup: [
      { id: ids['idem-charges'], pr: prUrl('billing-api', 213), title: 'Unblock the charge-creation PR', why: 'Sam requested changes and unit-tests is red; #214 is stacked on it, so both wait until this is green.' },
      { id: ids['proration'], pr: '', title: 'Answer the proration rounding question', why: 'The agent has the analysis ready and is waiting on one word from you: half-up or half-even.' },
      { id: ids['usage-chart'], pr: prUrl('web-dashboard', 88), title: 'Get the usage chart PR reviewed', why: 'Green and ready, it only needs a reviewer, and it removes the slowest chart load.' },
    ],
    dropping: [
      { id: ids['quickstart'], pr: prUrl('docs-site', 34), title: 'Quickstart rewrite is going stale', why: 'A draft untouched for a week; the SDK it documents ships on Monday.' },
    ],
    groups: [], fromNotes: ['Lazy-load the charting bundle', 'Write the v3.0 migration guide for the v1 refunds endpoint'],
  }))
  run('insert into notes (day, body, updated_at) values (?, ?, ?)', day, '## Today\n- [ ] Answer proration rounding (half-up?)\n- [ ] Get Sam to re-review #213 once unit-tests is green\n- [ ] Ship #88 behind the `usage-buckets` flag\n\nIdeas: lazy-load the charting bundle, parallelise the three startup API calls.', NOW - 30 * MIN)
  run('insert into notes (day, body, updated_at) values (?, ?, ?)', ago(1), 'Idempotency stack opened (#212 to #214). Remember: backfill must be re-runnable. Docs for retries merged.', NOW - 1 * DAY)
  run('insert into notes (day, body, updated_at) values (?, ?, ?)', ago(3), 'Retry schedule decided: 8 attempts over 24h with jitter and a per-endpoint circuit breaker.', NOW - 3 * DAY)
  const rt = (name, prompt, cwd, cron, last, status) => run('insert into routines (id, name, prompt, cwd, cron, webhook_secret, conversation_id, mode, enabled, last_run_at, last_status, created_at) values (?, ?, ?, ?, ?, null, null, ?, 1, ?, ?, ?)',
    uuid('routine:' + name), name, prompt, cwd, cron, 'fresh', last, status, NOW - 20 * DAY)
  rt('Morning PR digest', 'Summarise my open PRs: what is blocked, what is green, what needs a reviewer. Keep it to ten lines.', dir('billing-api'), '0 9 * * 1-5', NOW - 20 * HOUR, 'ok')
  rt('Weekly dependency check', 'Check billing-api and web-dashboard for outdated or vulnerable dependencies and list the three most urgent upgrades.', dir('web-dashboard'), '0 10 * * 1', NOW - 3 * DAY, 'ok')
  rt('Friday docs sweep', 'Look for docs pages that mention behaviour changed this week and list the ones that need updating.', dir('docs-site'), '0 16 * * 5', NOW - 6 * DAY, 'ok')

  const { reportNeed } = await import('../server/needsstore.ts')
  run("insert or replace into needs_sync values ('cloudAttempt', ?)", String(NOW + 365 * DAY)) // never try PostHog from the demo
  run("insert or replace into needs_sync values ('cloudAt', ?)", String(NOW - 4 * MIN))
  const need = (key, title, ctx, conv, humanAction, evidence, url) => {
    const n = reportNeed({ key, source: 'github', title, context: ctx, conversation_id: ids[conv], url })
    run(`update needs set status = 'needs_you', human_action = ?, evidence = ?, checked_at = ?, next_check_at = ?, created_at = ? where id = ?`, humanAction, evidence, NOW - 12 * MIN, NOW + 20 * HOUR, NOW - 3 * HOUR, n.id)
  }
  need('demo:pr-213', 'Sam requested changes on billing-api#213', 'Review thread on charge creation and a failing unit-tests check.', 'idem-charges',
    'Reply to Sam on #213: he wants the key stored per customer, not globally', 'Sam left 3 review threads on #213. Two are small fixes the agent can make; the third (scope of the key) is a design call only you can make. unit-tests is red because the replay test reads the stale amount.', prUrl('billing-api', 213))
  need('demo:proration', 'Proration rounding for plan downgrades', 'The agent is asking whether to round half-up or half-even.', 'proration',
    'Choose half-up or half-even rounding for proration credits', 'The credit and the invoice PDF disagree by one cent on about 1 in 8 downgrades. The agent recommends half-up (matches existing invoices) and is waiting for your call.', null)
  need('demo:flag-88', 'Roll out the usage-buckets flag', 'Approve turning the flag on for internal users.', 'usage-chart',
    'Approve the usage-buckets flag for internal users before merging #88', 'The PR is green and approved by nobody yet; the flag is created at 0%. Turning it on for the internal cohort is the safe first step.', prUrl('web-dashboard', 88))
}

console.log(`Seeded ${EMPTY ? 'an empty first-run' : 'the demo'} environment.\n  HOME  ${HOME}\n  DATA  ${DATA}\n  URL   http://127.0.0.1:${PORT}\nServe it with:\n  ${serveCmd}`)

if (flag('serve')) {
  const child = spawn(process.execPath, ['server/main.ts'], { cwd: ROOT, env: ENV, stdio: 'inherit' })
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s))
  child.on('exit', code => process.exit(code ?? 0))
} else process.exit(0)
