// The parsing that everything else trusts: transcripts, cron, `claude mcp list`, search queries.
// Run with `npm test`. The transcript lines mirror real Claude Code output.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ftsQuery } from './context.ts'
import { cronMatches, isDue, lastDue } from './routines.ts'
import { parseMcpList } from './status.ts'
import { applyLine, asksUser, emptyMeta, stallOf, toItems, userText } from './transcript.ts'

const line = (o: object) => JSON.stringify(o)
const ts = (m: number) => `2026-11-04T10:${String(m).padStart(2, '0')}:00.000Z`

const transcript = [
  line({ type: 'user', timestamp: ts(0), cwd: '/repo', gitBranch: 'main', message: { role: 'user', content: '<command-name>/review</command-name><command-args>opus</command-args>' } }),
  line({ type: 'user', timestamp: ts(1), isMeta: true, message: { role: 'user', content: 'Caveat: meta' } }),
  line({ type: 'user', timestamp: ts(2), cwd: '/repo', gitBranch: 'feat/x', message: { role: 'user', content: 'Open a PR that fixes the flaky test' } }),
  line({ type: 'assistant', timestamp: ts(3), message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } }),
  line({ type: 'assistant', timestamp: ts(3), message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'gh pr create --fill' } }] } }),
  line({ type: 'user', timestamp: ts(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'https://github.com/PostHog/posthog/pull/123' }] } }),
  line({ type: 'assistant', timestamp: ts(5), message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'mcp__grafana__query_prometheus', input: { expr: 'up' } }] } }),
  line({ type: 'user', timestamp: ts(6), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: '502' }] }] } }),
  line({ type: 'assistant', timestamp: ts(7), message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'Also see https://github.com/PostHog/charts/pull/9' }] } }),
  line({ type: 'ai-title', aiTitle: 'Fix flaky test', sessionId: 's' }),
  line({ type: 'assistant', isSidechain: true, timestamp: ts(9), message: { id: 'x', role: 'assistant', content: [{ type: 'text', text: 'subagent noise' }] } }),
].join('\n')

test('transcript metadata', () => {
  const m = emptyMeta()
  for (const l of transcript.split('\n')) applyLine(m, l)
  assert.equal(m.title, 'Fix flaky test')
  assert.equal(m.firstPrompt, 'Open a PR that fixes the flaky test') // a slash command loses to a real request
  assert.equal(m.messages, 2) // the command and the request; meta lines don't count
  assert.equal(m.cwd, '/repo')
  assert.equal(m.branch, 'feat/x') // latest branch wins
  assert.equal(m.updatedAt, Date.parse(ts(7))) // sidechain lines don't move the clock
  assert.deepEqual([...m.prs], [['https://github.com/PostHog/posthog/pull/123', true], ['https://github.com/PostHog/charts/pull/9', false]])
  assert.deepEqual(m.tools.map(t => t.name), ['Bash', 'mcp__grafana__query_prometheus'])
  assert.deepEqual(m.errors, ['t2'])
  assert.ok(!m.text.some(t => t.includes('subagent noise')))
})

test('a custom title beats the generated one', () => {
  const m = emptyMeta()
  applyLine(m, line({ type: 'custom-title', customTitle: 'Mine' }))
  applyLine(m, line({ type: 'ai-title', aiTitle: 'Generated' }))
  assert.equal(m.title, 'Mine')
})

test('items group one message and attach tool results', () => {
  const items = toItems(transcript)
  assert.deepEqual(items.map(i => i.kind), ['user', 'user', 'assistant', 'assistant', 'assistant'])
  const first = items[2]
  assert.ok(first.kind === 'assistant')
  assert.equal(first.blocks.length, 2) // text + tool from two lines sharing message id m1
  const tool = first.blocks[1]
  assert.ok(tool.type === 'tool' && tool.result?.includes('/pull/123'))
  const failed = (items[3] as any).blocks[0]
  assert.equal(failed.isError, true)
})

test('user text drops harness noise', () => {
  assert.equal(userText('<local-command-stdout>x</local-command-stdout>'), null)
  assert.equal(userText('<system-reminder>r</system-reminder>'), null)
  assert.equal(userText('hi <system-reminder>r</system-reminder>'), 'hi')
  assert.equal(userText([{ type: 'tool_result', content: 'x' }]), null)
  assert.equal(userText('<github_pr number="72707" title="Loading..." url="u"></github_pr> review it'), 'PR #72707 review it')
  assert.equal(userText('<file path="/tmp/a/pasted.txt" /> see this'), '[pasted.txt] see this')
})

test('cron', () => {
  const at = (s: string) => new Date(s)
  assert.ok(cronMatches('0 9 * * 1-5', at('2026-11-04T09:00:00'))) // Wednesday
  assert.ok(!cronMatches('0 9 * * 1-5', at('2026-11-08T09:00:00'))) // Sunday
  assert.ok(cronMatches('*/15 * * * *', at('2026-11-04T10:45:00')))
  assert.ok(!cronMatches('*/15 * * * *', at('2026-11-04T10:46:00')))
  assert.ok(cronMatches('0 18 * * 0,6', at('2026-11-08T18:00:00')))
  assert.ok(cronMatches('0 0 * * 7', at('2026-11-08T00:00:00'))) // 7 is Sunday too
  assert.ok(!cronMatches('bad', at('2026-11-04T10:00:00')))
})

test('routines catch up a slot missed during a restart', () => {
  const at = (s: string) => new Date(s)
  const t = (s: string) => at(s).getTime()
  const daily = { enabled: 1, cron: '0 9 * * 1-5', created_at: t('2026-11-04T19:05:00') }
  assert.equal(lastDue('0 9 * * 1-5', at('2026-11-10T12:50:00'))?.getTime(), t('2026-11-10T09:00:00'))
  // Server was down at 09:00 Tuesday; last run was Monday. It fires once when back.
  assert.ok(isDue({ ...daily, last_run_at: t('2026-11-09T09:00:05') }, at('2026-11-10T12:50:00')))
  // Then not again that day.
  assert.ok(!isDue({ ...daily, last_run_at: t('2026-11-10T12:50:02') }, at('2026-11-10T12:51:00')))
  // On time still works.
  assert.ok(isDue({ ...daily, last_run_at: t('2026-11-09T09:00:05') }, at('2026-11-10T09:00:00')))
  // Too stale (over 6h) is dropped, as is a slot from before the routine existed.
  assert.ok(!isDue({ ...daily, last_run_at: t('2026-11-09T09:00:05') }, at('2026-11-10T15:30:00')))
  assert.ok(!isDue({ ...daily, last_run_at: null }, at('2026-11-04T20:00:00')))
  assert.ok(!isDue({ ...daily, enabled: 0, last_run_at: null }, at('2026-11-05T09:00:00')))
  assert.ok(isDue({ ...daily, last_run_at: null }, at('2026-11-05T09:00:00')))
})

test('claude mcp list parsing', () => {
  const out = [
    'Checking MCP server health…', '',
    'claude.ai Typefully - Social Media Scheduler: https://mcp.typefully.com/mcp - ! Needs authentication',
    'plugin:slack:slack: https://mcp.slack.com/mcp (HTTP) - ✔ Connected',
    'grafana: mcp-grafana --disable-write - ✔ Connected',
    'broken: node x.js - ✗ Failed to connect',
    'plugin:design:gmail:  (HTTP) - - Not configured',
  ].join('\n')
  const s = parseMcpList(out)
  assert.deepEqual(s.map(x => [x.name, x.status, x.kind]), [
    ['claude.ai Typefully - Social Media Scheduler', 'needs-auth', 'claude.ai'],
    ['plugin:slack:slack', 'connected', 'plugin'],
    ['grafana', 'connected', 'local'],
    ['broken', 'failed', 'local'],
    ['plugin:design:gmail', 'not-configured', 'plugin'],
  ])
})

test('related-search query keeps meaningful words', () => {
  assert.equal(ftsQuery('How do I drop the cilium "envoy" metrics?'), '"drop"* OR "cilium"* OR "envoy"* OR "metrics"*')
  assert.equal(ftsQuery('the and of'), '')
})

test('search query language', async () => {
  const { parseQuery } = await import('./conversations.ts')
  const q = parseQuery('#intent-clustering -#done in:code state:needs repo:posthog pr:#123 project:dash is:pinned older:7d "hogql review" flaky test')
  assert.deepEqual(q.labels, ['intent-clustering'])
  assert.deepEqual(q.notLabels, ['done'])
  assert.deepEqual(q.sources, ['posthog-code'])
  assert.deepEqual(q.states, ['waiting'])
  assert.equal(q.repo, 'posthog')
  assert.equal(q.pr, '123')
  assert.equal(q.project, 'dash')
  assert.equal(q.pinned, true)
  assert.equal(q.olderThan, 7 * 86400_000)
  assert.deepEqual(q.terms, ['"hogql review"', 'flaky', 'test'])
  assert.deepEqual(parseQuery('see https://x.dev/a').terms, ['see', 'https', 'x', 'dev', 'a']) // a colon that isn't a filter
})

test('the agent asked you something', () => {
  const ask = (t: string) => asksUser({ lastRole: 'assistant', lastAssistant: t })
  assert.ok(ask('Done. Want me to open the PR?'))
  assert.ok(ask('I can draft the charts PR now, or write the RFC. Let me know which.'))
  assert.ok(ask('Should I rebase the stack first?\n'))
  assert.ok(!ask('Done: the PR is merged and CI is green.'))
  assert.ok(!asksUser({ lastRole: 'user', lastAssistant: 'Want me to?' }))
})

test('stalls: the work stopped without finishing', () => {
  const run = (lines: object[]) => { const m = emptyMeta(); for (const l of lines) applyLine(m, JSON.stringify(l)); return stallOf(m) }
  const user = (content: any) => ({ type: 'user', timestamp: ts(1), message: { role: 'user', content } })
  const said = (content: any[], extra = {}) => ({ type: 'assistant', timestamp: ts(2), message: { id: 'a', role: 'assistant', content }, ...extra })
  assert.equal(run([user('do it'), said([{ type: 'text', text: 'done' }])]), null)
  assert.match(run([user('do it'), said([{ type: 'tool_use', id: 't', name: 'Bash', input: {} }])])!, /mid tool call/)
  assert.match(run([user('do it'), said([{ type: 'tool_use', id: 't', name: 'Bash', input: {} }]), user([{ type: 'tool_result', tool_use_id: 't', content: 'ok' }])])!, /after a tool result/)
  assert.match(run([user('do it')])!, /never answered/)
  assert.match(run([user('do it'), said([{ type: 'text', text: 'API Error: overloaded' }], { isApiErrorMessage: true })])!, /API error/)
  assert.equal(run([user('do it'), said([{ type: 'tool_use', id: 't', name: 'Bash', input: {} }]), user([{ type: 'text', text: '[Request interrupted by user for tool use]' }])]), null)
})

test('autopilot owns what it creates: pause on failure or idle loops, graduate on success', async () => {
  const { db } = await import('./db.ts')
  const { review } = await import('./autopilot.ts')
  const { saveRoutine } = await import('./routines.ts')
  const add = (id: string, outcomes: string[]) => outcomes.forEach((o, i) => db.prepare('insert into routine_runs (id, routine_id, conversation_id, started_at, outcome) values (?, ?, ?, ?, ?)').run(`${id}-${i}`, id, `c-${id}`, 1000 - i, o))
  const state = (id: string) => db.prepare('select enabled, trusted, paused_reason from routines where id = ?').get(id) as any
  const failing = saveRoutine({ name: 'failing', prompt: 'x', cron: '0 * * * *' }).id
  add(failing, ['error', 'stalled', 'error', 'ok'])
  review(failing)
  assert.equal(state(failing).enabled, 0)
  assert.match(state(failing).paused_reason, /3 failed/)
  const loop = saveRoutine({ name: 'babysitter', prompt: 'x', cron: '0 * * * *' }).id
  add(loop, Array(8).fill('noop'))
  review(loop)
  assert.match(state(loop).paused_reason, /nothing to do/)
  const good = saveRoutine({ name: 'good', prompt: 'x', cron: '0 9 * * 1-5' }).id
  add(good, ['ok', 'noop', 'ok', 'ok', 'ok'])
  review(good)
  assert.equal(state(good).enabled, 1)
  assert.equal(state(good).trusted, 1)
})

test('search picks a mode from the question', async () => {
  const { autoMode } = await import('./seek.ts')
  assert.equal(autoMode('where is the vmagent config').mode, 'fast')
  assert.equal(autoMode('how does grafana handle dashboard variables').mode, 'deep')
  assert.equal(autoMode('deep dive into everything about intent clustering').mode, 'deep')
  assert.equal(autoMode('summarise what we decided about metrics retention last month').mode, 'balanced')
})

test('playbook tactics earn their place or get retired', async () => {
  const { db } = await import('./db.ts')
  const { addTactic, evaluatePlaybook } = await import('./seek.ts')
  const good = addTactic('read charts on origin/main for infra questions')
  const bad = addTactic('always search Google Drive first')
  db.prepare('update playbook set uses = 4, wins = 3, losses = 1 where id = ?').run(good)
  db.prepare('update playbook set uses = 7, wins = 1, losses = 5 where id = ?').run(bad)
  evaluatePlaybook()
  const st = (id: string) => (db.prepare('select status from playbook where id = ?').get(id) as any).status
  assert.equal(st(good), 'active')
  assert.equal(st(bad), 'retired')
})

test('errors read as one plain sentence with what happens next', async () => {
  const { friendly } = await import('./errors.ts')
  assert.equal(friendly(new Error('TypeError: terminated NGHTTP2_INTERNAL_ERROR')).status, 'retrying')
  assert.match(friendly(new Error('export 403: {"detail":"This action does not support personal API key access"}'), 'Exporting a skill').message, /web app/)
  assert.equal(friendly(new Error('No PostHog personal API key (Settings → PostHog)')).status, 'needs-you')
})

test('autoresearch reads the same report block PostHog Desktop uses', async () => {
  const { parseReport, best, kickoff } = await import('./optimize.ts')
  const r = parseReport('Changed the cache.\n```autoresearch\nmetric: 1,234.5\nname: bundle size\nunit: kB\nsummary: drop moment\n```')
  assert.ok(r && r.kind === 'metric')
  assert.equal(r.value, 1234.5)
  assert.equal(r.fields.unit, 'kB')
  assert.equal(parseReport('```autoresearch\ntype: research\nfinding: x\n```')?.kind, 'research')
  assert.equal(parseReport('no block here'), null)
  const its = [{ value: 10 }, { value: 7 }, { value: 9 }].map((x, i) => ({ ...x, index: i + 1, kept: true, at: 0 }))
  assert.equal(best(its, 'minimize')!.value, 7)
  assert.equal(best(its, 'maximize')!.value, 10)
  assert.match(kickoff({ brief: 'make it fast', direction: 'minimize', maxIterations: 5, target: 3 }), /drops to 3[\s\S]*make it fast/)
})

test('branching copies the transcript up to a message under a new session', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { db } = await import('./db.ts')
  const { fork } = await import('./branch.ts')
  const dir = mkdtempSync(join(tmpdir(), 'perch-branch-'))
  const path = join(dir, 'orig.jsonl')
  const L = (o: object) => JSON.stringify({ sessionId: 'orig', ...o })
  writeFileSync(path, [
    L({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } }),
    L({ type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'one' }] } }),
    L({ type: 'assistant', uuid: 'a1b', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }),
    L({ type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }),
    L({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } }),
    L({ type: 'ai-title', aiTitle: 'Original' }),
  ].join('\n'))
  db.prepare(`insert into conversations (id, source, path, title, started_at, updated_at) values ('orig', 'claude', ?, 'Original', 1, 1)`).run(path)
  const b = fork('orig', 'a1')
  const copy = readFileSync(join(dir, `${b.id}.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(copy.filter(e => e.uuid).map(e => e.uuid), ['u1', 'a1', 'a1b', 'r1']) // the whole answer, not the next prompt
  assert.ok(copy.every(e => e.sessionId === b.id))
  assert.equal(copy.at(-1).customTitle, 'Original (branch)')
  assert.ok(existsSync(path)) // the original is untouched
})

test('restore points snapshot and restore the working tree through git', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const { snapshot, restoreFiles } = await import('./branch.ts')
  const repo = mkdtempSync(join(tmpdir(), 'perch-snap-repo-'))
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim()
  g('init', '-q'); writeFileSync(join(repo, 'a.txt'), 'v1'); g('add', '.'); g('-c', 'commit.gpgsign=false', 'commit', '-qm', 'init')
  writeFileSync(join(repo, 'a.txt'), 'v2 uncommitted'); writeFileSync(join(repo, 'new.txt'), 'untracked')
  const sha = await snapshot('conv1', repo)
  assert.ok(sha)
  assert.equal(g('status', '--porcelain').split('\n').length, 2) // snapshot touched nothing
  writeFileSync(join(repo, 'a.txt'), 'v3 later')
  const r = await restoreFiles('conv1', 0)
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'v2 uncommitted')
  assert.ok(r.undo) // the state before restoring was saved too
  assert.match(g('for-each-ref', 'refs/perch/'), /conv1\/0/)
})

test('Apple Notes bodies decode from gzipped protobuf', async () => {
  const { gzipSync } = await import('node:zlib')
  const { noteText } = await import('./applenotes.ts')
  const ld = (no: number, payload: Buffer) => Buffer.concat([Buffer.from([(no << 3) | 2, payload.length]), payload])
  const doc = ld(2, ld(3, Buffer.concat([ld(2, Buffer.from('Ingestion lag ideas')), Buffer.from([0x18, 0x01])])))
  assert.equal(noteText(gzipSync(Buffer.concat([Buffer.from([0x08, 0x00]), doc]))), 'Ingestion lag ideas')
  assert.equal(noteText(Buffer.from('not gzip')), '')
})

test('duplicates: a schedule is not a duplicate, overlapping runs are; copies share a lineage', async () => {
  const { db } = await import('./db.ts')
  const { findDuplicates } = await import('./autopilot.ts')
  const H = 3600_000, now = Date.now()
  const task = (id: string, start: number, end: number, pr: string) => {
    db.prepare(`insert into conversations (id, source, origin, title, started_at, updated_at, status) values (?, 'posthog-task', 'workflow', 't', ?, ?, 'completed')`).run(id, start, end)
    db.prepare(`insert into conversation_prs (conversation_id, url) values (?, ?)`).run(id, pr)
  }
  // Hourly loop: back to back, never overlapping.
  for (let i = 0; i < 4; i++) task(`loop${i}`, now - (5 - i) * H, now - (5 - i) * H + 2 * 60_000, 'https://github.com/o/r/pull/1')
  // Two agents on the same PR at once.
  task('par1', now - 2 * H, now - H, 'https://github.com/o/r/pull/2')
  task('par2', now - 1.5 * H, now - 0.5 * H, 'https://github.com/o/r/pull/2')
  findDuplicates()
  const titles = (db.prepare(`select title from suggestions where kind = 'consolidate' and status = 'open'`).all() as any[]).map(r => r.title)
  assert.ok(!titles.some(t => t.includes('pull/1')), 'a schedule must not be flagged')
  assert.ok(titles.some(t => t.includes('pull/2') && t.includes('at the same time')))
  const m = emptyMeta()
  applyLine(m, JSON.stringify({ type: 'user', uuid: 'root-1', timestamp: ts(1), message: { role: 'user', content: 'hi' } }))
  applyLine(m, JSON.stringify({ type: 'assistant', uuid: 'a-2', timestamp: ts(2), message: { id: 'x', role: 'assistant', content: [{ type: 'text', text: 'yo' }] } }))
  assert.equal(m.rootUuid, 'root-1')
})

// ---------- shepherd: what wakes a shepherd on a PR ----------
import { AGENT_PR, byShepherd, detect, MARK as SHEPHERD_MARK, mergeBlocker, parsePlan, stalledDraft, STALLED_DRAFT_MS, verifyOutcome, waitingOn, type Snapshot } from './shepherd.ts'

const pr = (o: Partial<Snapshot> = {}): Snapshot => ({
  state: 'OPEN', isDraft: false, head: 'abc123', rollup: 'PENDING', failing: [], labels: [], reviewDecision: 'REVIEW_REQUIRED',
  body: '', mergedAt: null, mergeSha: null, threads: [], comments: [], reviews: [], ...o,
})
const zero = { seen_comment: 0, seen_thread: 0, seen_review: 0, handled_ci: null, handled_stamp: null }

test('shepherd wakes on a new review thread comment, not on its own marked reply', () => {
  const thread = { resolved: false, last: { id: 4484027706, author: 'posthog[bot]', body: 'P2: count copied attributes' } }
  assert.equal(detect(pr({ threads: [thread] }), zero, true).events.length, 1)
  const marked = { resolved: false, last: { id: 4484027707, author: 'octocat', body: `Fixed in 94d636d.\n${SHEPHERD_MARK}` } }
  assert.equal(detect(pr({ threads: [marked] }), zero, true).events.length, 0)
  // Already handed to a run.
  assert.equal(detect(pr({ threads: [thread] }), { ...zero, seen_thread: 4484027706 }, true).events.length, 0)
})

test('shepherd keeps one watermark per id sequence', () => {
  // Issue comment ids run far ahead of review comment ids: a single watermark would hide the thread.
  const snap = pr({
    comments: [{ id: 6665221734, author: 'someone', body: 'looks good' }],
    threads: [{ resolved: false, last: { id: 4484100000, author: 'reviewer', body: 'rename this' } }],
  })
  const d = detect(snap, { ...zero, seen_comment: 6665221734 }, true)
  assert.deepEqual(d.events.map(e => e.split(':')[0]), ['review thread comment from reviewer'])
  assert.equal(d.seen.comment, 6665221734)
  assert.equal(d.seen.thread, 4484100000)
})

test('shepherd ignores slash commands', () => {
  const snap = pr({ comments: [{ id: 1, author: 'octocat', body: '/trunk merge' }, { id: 2, author: 'octocat', body: 'Can you rename this?' }] })
  assert.deepEqual(detect(snap, zero, true).events, ['comment from octocat: Can you rename this?'])
})

test('shepherd ignores bot summaries but not changes requested', () => {
  const snap = pr({
    comments: [{ id: 1, author: 'trunk-io[bot]', body: 'Merging is managed by Trunk' }, { id: 2, author: 'github-actions[bot]', body: 'CI report' }],
    reviews: [{ id: 3, author: 'veria-ai[bot]', body: '', state: 'COMMENTED' }, { id: 4, author: 'stamphog[bot]', body: 'Too large to auto-approve', state: 'CHANGES_REQUESTED' }],
  })
  assert.deepEqual(detect(snap, zero, true).events, ['changes requested by stamphog[bot]: Too large to auto-approve'])
})

test('shepherd wakes once per red head and once per green head for stamphog', () => {
  const red = pr({ rollup: 'FAILURE', failing: ['Lint Rust services'] })
  const d = detect(red, zero, true)
  assert.equal(d.events.length, 1)
  assert.equal(detect(red, { ...zero, handled_ci: d.ci }, true).events.length, 0)

  const green = pr({ rollup: 'SUCCESS' })
  const s = detect(green, zero, true)
  assert.match(s.events[0], /apply stamphog/)
  assert.equal(detect(green, { ...zero, handled_stamp: s.stamp }, true).events.length, 0)
  // Not when stamphog doesn't run in the repo, threads are open, it is labelled, a draft, or approved.
  assert.equal(detect(green, zero, false).events.length, 0)
  const open = detect(pr({ rollup: 'SUCCESS', threads: [{ resolved: false, last: { id: 9, author: 'reviewer', body: 'still open' } }] }), zero, true)
  assert.equal(open.stamp, null)
  assert.equal(detect(pr({ rollup: 'SUCCESS', labels: ['stamphog'] }), zero, true).events.length, 0)
  assert.equal(detect(pr({ rollup: 'SUCCESS', isDraft: true }), zero, true).events.length, 0)
  assert.equal(detect(pr({ rollup: 'SUCCESS', reviewDecision: 'APPROVED' }), zero, true).events.length, 0)
})

const PLAN_BODY = `## Problem
x
<!-- perch-plan
merge: auto            # comment
after: https://github.com/PostHog/posthog/pull/130330
deploy: ArgoCD capture-apm-metrics-prod-us
verify:
- prod-us Grafana: 400 rate under 0.1/s
- project 2: vmagent rows carry k8s.namespace.name
-->`

test('shepherd reads the perch-plan in a PR description', () => {
  const p = parsePlan(PLAN_BODY)!
  assert.equal(p.merge, 'auto')
  assert.deepEqual(p.after, ['https://github.com/PostHog/posthog/pull/130330'])
  assert.equal(p.deploy, 'ArgoCD capture-apm-metrics-prod-us')
  assert.deepEqual(p.verify, ['prod-us Grafana: 400 rate under 0.1/s', 'project 2: vmagent rows carry k8s.namespace.name'])
  assert.equal(parsePlan('no plan here'), null)
  assert.equal(parsePlan('<!-- perch-plan\nverify: one check\n-->')!.merge, 'manual')
})

test('shepherd merges only when approved, green, clear, opted in, and dependencies are verified in production', () => {
  const dep = 'https://github.com/PostHog/posthog/pull/130330'
  const ready = pr({ body: PLAN_BODY, reviewDecision: 'APPROVED', rollup: 'SUCCESS' })
  const plan = parsePlan(PLAN_BODY)
  assert.equal(mergeBlocker(ready, plan, { [dep]: 'verified' }, null), null)
  assert.match(mergeBlocker(ready, plan, { [dep]: 'deploying' }, null)!, /waiting for #130330 \(deploying\) to pass a production check/)
  // The first production check is enough; the two-hour check doesn't hold the PRs after it.
  assert.equal(mergeBlocker(ready, plan, { [dep]: 'verifying' }, null), null)
  assert.match(mergeBlocker(ready, plan, {}, null)!, /not watched/)
  assert.equal(mergeBlocker(ready, null, {}, null), 'no perch-plan in the description')
  assert.equal(mergeBlocker(ready, parsePlan('<!-- perch-plan\nmerge: manual\n-->'), {}, null), 'plan says merge: manual')
  assert.equal(mergeBlocker({ ...ready, reviewDecision: 'REVIEW_REQUIRED' }, plan, { [dep]: 'verified' }, null), 'not approved')
  assert.equal(mergeBlocker({ ...ready, isDraft: true }, plan, { [dep]: 'verified' }, null), 'draft')
  assert.equal(mergeBlocker({ ...ready, rollup: 'FAILURE' }, plan, { [dep]: 'verified' }, null), 'CI failure')
  assert.equal(mergeBlocker({ ...ready, threads: [{ resolved: false, last: null }] }, plan, { [dep]: 'verified' }, null), 'open review threads')
  assert.equal(mergeBlocker(ready, plan, { [dep]: 'verified' }, 'abc123'), 'merge already requested for this head')
})

test('shepherd readies a stalled green draft it opened, and leaves held ones alone', () => {
  const now = Date.parse('2026-11-13T20:00:00Z')
  const ORIGIN = '<!-- perch-origin:v1\nowner: octocat\n-->'
  const PLANNED = `Fix it.\n${ORIGIN}\n<!-- perch-plan\nmerge: auto\nverify:\n- errors fall to 0\n-->`
  const stale = now - STALLED_DRAFT_MS - 60_000
  const draft = (o: Partial<Snapshot> = {}) => pr({ isDraft: true, rollup: 'SUCCESS', body: PLANNED, headAt: stale, ...o })
  assert.equal(stalledDraft(draft(), now)?.kind, 'ready')
  // Not ours, not green, too fresh, not a draft: not a candidate.
  assert.equal(stalledDraft(draft({ body: PLANNED.replace(ORIGIN, '') }), now), null)
  assert.equal(stalledDraft(draft({ rollup: 'PENDING' }), now), null)
  assert.equal(stalledDraft(draft({ rollup: 'SUCCESS', failing: ['Visual regression tests pass'] }), now), null)
  assert.equal(stalledDraft(draft({ headAt: now - 60_000 }), now), null)
  assert.equal(stalledDraft(draft({ headAt: null }), now), null)
  assert.equal(stalledDraft(draft({ isDraft: false }), now), null)
  // No plan: surfaced, not readied.
  assert.equal(stalledDraft(draft({ body: `Fix it.\n${ORIGIN}` }), now)?.kind, 'needs')
  // Held on purpose, in the body or in a comment: never readied.
  for (const said of ['WIP: still wiring the UI', 'Do not merge until the cutover', 'Parked as a draft on purpose', 'Keep this as a draft for now', 'on hold for the RFC'])
    assert.equal(stalledDraft(draft({ comments: [{ id: 1, author: 'octocat', body: said }] }), now)?.kind, 'held', said)
  assert.equal(stalledDraft(draft({ body: `WIP\n${PLANNED}` }), now)?.kind, 'held')
  // Ordinary words that contain "hold" don't count.
  assert.equal(stalledDraft(draft({ comments: [{ id: 2, author: 'x', body: 'the threshold holds at 5%' }] }), now)?.kind, 'ready')
})

test('shepherd reads what a production check concluded', () => {
  assert.equal(verifyOutcome('Table...\n\n**VERIFIED**').kind, 'verified')
  assert.equal(verifyOutcome('NOT DEPLOYED: Kargo prod-us still on the old freight').kind, 'not-deployed')
  const r = verifyOutcome('VERIFIED for 2 checks\nREGRESSION: 400 rate 3/s — revert PR https://github.com/x/y/pull/1\nNEEDS YOU: merge the revert')
  assert.equal(r.kind, 'regression')
  assert.match(r.detail, /^REGRESSION: 400 rate/)
  assert.equal(verifyOutcome('I looked around.').kind, 'unclear')
  const nm = verifyOutcome('Evidence posted.\n**NOT MET: p95 still at the top bucket — no regression; follow-up https://github.com/PostHog/posthog/pull/135090**')
  assert.equal(nm.kind, 'not-met')
  assert.equal(nm.followUp, 'https://github.com/PostHog/posthog/pull/135090')
  assert.equal(verifyOutcome('NOT MET: p95 high\nREGRESSION: errors doubled — revert PR https://github.com/x/y/pull/2').kind, 'regression')
  assert.equal(verifyOutcome('NOT DEPLOYED: npm still on 1.2.3').kind, 'not-deployed')
  // No signal is not a pass, even next to a VERIFIED line.
  const ns = verifyOutcome('VERIFIED for errors\n**NO SIGNAL: page views (0 on the flag-gated page)**')
  assert.equal(ns.kind, 'no-signal')
  assert.match(ns.detail, /page views/)
  assert.equal(verifyOutcome('NO SIGNAL: clicks\nREGRESSION: errors doubled — revert PR https://github.com/x/y/pull/3').kind, 'regression')
})

test('a prerequisite handed off to a follow-up no longer blocks the PRs after it', () => {
  assert.deepEqual(waitingOn(parsePlan('<!-- perch-plan\nmerge: auto\nafter: https://github.com/x/y/pull/1\n-->'), { 'https://github.com/x/y/pull/1': 'handed-off' }), [])
  // Live with no usage data yet still lets the PRs after it merge.
  assert.deepEqual(waitingOn(parsePlan('<!-- perch-plan\nmerge: auto\nafter: https://github.com/x/y/pull/1\n-->'), { 'https://github.com/x/y/pull/1': 'live' }), [])
  assert.deepEqual(waitingOn(parsePlan('<!-- perch-plan\nmerge: auto\nafter: https://github.com/x/y/pull/1\n-->'), { 'https://github.com/x/y/pull/1': 'deploying' }), ['https://github.com/x/y/pull/1'])
})

test('shepherd recognises PRs agents wrote', () => {
  assert.ok(AGENT_PR.test('🤖 Generated with [Claude Code](https://claude.com/claude-code)'))
  assert.ok(AGENT_PR.test('*Created with [PostHog Code](https://posthog.com/code?ref=pr)*'))
  assert.ok(AGENT_PR.test('Created with [PostHog Desktop](https://posthog.com/desktop)'))
  assert.ok(AGENT_PR.test('Created with [PostHog](https://posthog.com?ref=pr) from a Slack thread'))
  assert.ok(!AGENT_PR.test('Fixes the login bug. Tested locally.'))
})

test("shepherd knows its own comments by when they were posted, not by a marker", () => {
  const run: [number, number] = [1_000_000, 2_000_000]
  const own = { me: 'octocat', windows: [run] }
  const during = { id: 10, author: 'octocat', body: '/trunk merge', at: 1_500_000 }
  const after = { id: 11, author: 'octocat', body: 'Please also rename this', at: 3_000_000 }
  const someoneElse = { id: 12, author: 'frankh', body: 'Looks off', at: 1_500_000 }
  assert.ok(byShepherd(during, own))
  assert.ok(!byShepherd(after, own))
  assert.ok(!byShepherd(someoneElse, own))
  // A run still going has no end yet.
  assert.ok(byShepherd({ ...after, at: 9e12 }, { me: 'octocat', windows: [[1_000_000, Infinity]] }))
  const snap = pr({ threads: [{ resolved: false, last: { id: 20, author: 'octocat', body: 'Fixed in abc.', at: 1_500_000 } }, { resolved: false, last: { id: 21, author: 'frankh', body: 'Why?', at: 1_500_000 } }] })
  assert.deepEqual(detect(snap, zero, true, own).events, ['review thread comment from frankh: Why?'])
})

test('where: filters say where a conversation runs, and several are OR-ed', async () => {
  const { parseQuery } = await import('./conversations.ts')
  assert.deepEqual(parseQuery('where:slack on:Mac #x').where, ['slack', 'mac'])
  assert.deepEqual(parseQuery('where:review_hog').where, ['review_hog'])
  assert.deepEqual(parseQuery('state:waiting').where, [])
})

test('attention tail keeps the last turns short', async () => {
  const { tail } = await import('./attention.ts')
  const items: any[] = [{ kind: 'user', text: 'fix it' }, { kind: 'assistant', blocks: [{ type: 'text', text: 'Done. Want me to open the PR?' }, { type: 'tool', id: '1', name: 'Bash', input: {}, isError: true }] }]
  const t = tail(items)
  assert.match(t, /USER: fix it/)
  assert.match(t, /AGENT: Done\. Want me to open the PR\? \[tools: Bash\(error\)\]/)
  assert.ok(tail(Array.from({ length: 30 }, () => ({ kind: 'user', text: 'x'.repeat(400) })) as any).length <= 1801)
})

// ---------- decisions, gates, listings, projects ----------
import { isHumanGate, needsYou, noSignalRecheckAt } from './shepherd.ts'
import { raise, resolveKey, openDecisions, decisionsFor } from './decisionstore.ts'
import { projectStatus, setProject, phaseOf } from './projects.ts'
import { run as dbRun } from './db.ts'

test('a no-signal answer is rechecked when its window closes, not every hour', () => {
  const now = Date.parse('2026-11-19T01:00:00Z'), H = 3_600_000
  assert.equal(noSignalRecheckAt('waiting for 7-day window (2026-11-25)', now), Date.parse('2026-11-25T12:00:00Z'))
  assert.equal(noSignalRecheckAt('judged at 2026-11-19 20:00 UTC', now), Date.parse('2026-11-19T20:00:00Z'))
  assert.equal(noSignalRecheckAt('waiting for 24h window', now), now + 24 * H)
  assert.equal(noSignalRecheckAt('copy events, activation', now), now + 6 * H)
  assert.equal(noSignalRecheckAt('window closed 2026-11-01', now), now + H)
})

test('a blocker only a person can clear is recognised; a slow deploy is not', () => {
  assert.ok(isHumanGate("NOT DEPLOYED: Release run is waiting for a `client-libraries-approvers` approval of the NPM Release environment, which Ana's account can't give"))
  assert.ok(isHumanGate('NOT DEPLOYED: needs CODEOWNERS review from team-cloud-platform'))
  assert.ok(!isHumanGate('NOT DEPLOYED: Kargo stage prod-us still on the old image'))
  assert.ok(!isHumanGate('NOT DEPLOYED: pods still run 0227344739a2 in environment prod-us'))
})

test('NEEDS YOU lines become one decision each', () => {
  assert.deepEqual(needsYou('Did x.\n**NEEDS YOU: pick A or B for the logs writes**\n- NEEDS YOU: approve the prod flip\nok'), ['pick A or B for the logs writes', 'approve the prod flip'])
  assert.deepEqual(needsYou('all fine'), [])
})

test('a tool result listing many PRs does not link them; a created PR still does', () => {
  const m = emptyMeta()
  const many = Array.from({ length: 6 }, (_, i) => `https://github.com/PostHog/posthog/pull/${i + 1}`).join('\n')
  applyLine(m, JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-11-10T10:00:00Z', message: { content: [{ type: 'tool_use', id: 'l1', name: 'mcp__perch__open_prs', input: {} }] } }))
  applyLine(m, JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-11-10T10:00:01Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'l1', content: many }] } }))
  assert.equal(m.prs.size, 0)
  applyLine(m, JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-11-10T10:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'l2', content: 'https://github.com/PostHog/charts/pull/7' }] } }))
  assert.deepEqual([...m.prs.keys()], ['https://github.com/PostHog/charts/pull/7'])
})

test('a decision is raised once per key and never reopened once answered', () => {
  const a = raise({ key: 'test:k1', source: 'agent', conversationId: 'conv-1', title: 'A or B?', options: ['A', 'B'], recommendation: 'A' })
  const b = raise({ key: 'test:k1', source: 'agent', conversationId: 'conv-1', title: 'A or B, fresher?', options: ['A', 'B'] })
  assert.equal(a.id, b.id)
  assert.equal(decisionsFor('conv-1').length, 1)
  resolveKey('test:k1')
  assert.equal(raise({ key: 'test:k1', source: 'agent', title: 'again' }).status, 'resolved')
  assert.ok(!openDecisions().some(d => d.key === 'test:k1'))
})

test('a project gathers its PRs, the ones they wait on, and its decisions', () => {
  dbRun(`insert into conversations (id, source, started_at, updated_at) values ('proj-c', 'claude', 1, 1)`)
  dbRun(`insert into conversation_prs (conversation_id, url, created) values ('proj-c', 'https://github.com/PostHog/charts/pull/2', 1)`)
  dbRun(`insert into shepherd_watch (url, enabled, source, stage, after_urls, outcome) values ('https://github.com/PostHog/charts/pull/2', 1, 'auto', 'open', '["https://github.com/PostHog/charts/pull/1"]', 'not merging: waiting for #1 (deploying) to pass a production check')`)
  dbRun(`insert into shepherd_watch (url, enabled, source, stage) values ('https://github.com/PostHog/charts/pull/1', 1, 'auto', 'verified')`)
  setProject('proj-c', { goal: 'All metrics into PostHog', done_when: '100% sample' })
  raise({ key: 'test:proj', source: 'agent', conversationId: 'proj-c', title: 'Drop the logs writes?' })
  const s = projectStatus('proj-c')!
  assert.equal(s.prs.length, 2)
  assert.equal(s.prs.find((p: any) => p.url.endsWith('/2')).phase, 'waiting on another PR')
  assert.equal(s.prs.find((p: any) => p.url.endsWith('/1')).phase, 'verified')
  assert.equal(s.decisions.length, 1)
  assert.equal(phaseOf({ url: '', title: null, state: 'OPEN', review: 'APPROVED', checks: 'SUCCESS', stage: 'open', outcome: 'not merging: plan says merge: manual', after: [] }), 'ready: merge is yours')
})

test('only big decisions reach you; small ones are perch\'s to decide right away', async () => {
  const { updateSettings } = await import('./settings.ts')
  updateSettings({ decisions: { autoAfterHours: 4, autoFixesPerDay: 3, askMe: true } })
  const { dueDecisions, recommendedOption } = await import('./decisionstore.ts')
  const low = raise({ key: 'test:low', source: 'shepherd', conversationId: 'conv-s', title: 'Verify again?', options: ['Verify it again', 'Leave it'], recommendation: 'Verify it again', stakes: 'low' })
  assert.ok(!openDecisions().some(d => d.id === low.id))
  assert.ok(dueDecisions().some(d => d.id === low.id))
  const high = raise({ key: 'test:high', source: 'agent', conversationId: 'conv-s', title: 'Drop the writes?', options: ['A: drop', 'B: keep'], recommendation: 'A: drop. It frees disk', stakes: 'high', autoAfterMinutes: 60 })
  assert.ok(openDecisions().some(d => d.id === high.id))
  assert.ok(!dueDecisions().some(d => d.id === high.id))
  assert.ok(dueDecisions(Date.now() + 61 * 60_000).some(d => d.id === high.id))
  assert.equal(recommendedOption(high), 'A: drop')
  const never = raise({ key: 'test:never', source: 'agent', title: 'Delete the table?', options: ['Yes', 'No'], recommendation: 'No', autoAfterMinutes: 0 })
  assert.equal(never.auto_at, null)
})

test('with asking off (the default), even big decisions are due at once and nothing reaches you', async () => {
  const { updateSettings } = await import('./settings.ts')
  const { dueDecisions } = await import('./decisionstore.ts')
  updateSettings({ decisions: { autoAfterHours: 4, autoFixesPerDay: 3, askMe: false } })
  const big = raise({ key: 'test:askoff', source: 'agent', conversationId: 'conv-s', title: 'Merge the revert?', options: ['Merge it', 'Leave it'], recommendation: 'Merge it', stakes: 'high', autoAfterMinutes: 60 })
  assert.ok(big.auto_at! <= Date.now())
  assert.ok(dueDecisions().some(d => d.id === big.id))
  updateSettings({ decisions: { autoAfterHours: 4, autoFixesPerDay: 3, askMe: true } })
})

test('perch decides what is due with the recommendation, and you can change it after', async () => {
  const { decideDue, autoDecided, decision } = await import('./decisions.ts')
  raise({ key: 'test:due', source: 'agent', title: 'Opus or Sonnet?', options: ['Keep Opus', 'Sonnet'], recommendation: 'Keep Opus: it found real leads', stakes: 'low' })
  for (let i = 0; i < 5; i++) decideDue()
  const d = autoDecided().find(x => x.key === 'test:due')!
  assert.equal(d.status, 'auto')
  assert.equal(d.answer, 'Keep Opus')
  // The same question again isn't news.
  assert.equal(raise({ key: 'test:due', source: 'agent', title: 'Opus or Sonnet?', reopen: true, stakes: 'low' }).status, 'auto')
  const { answerDecision } = await import('./decisions.ts')
  answerDecision(d.id, 'Sonnet')
  assert.equal(decision(d.id)!.status, 'answered')
  assert.equal(decision(d.id)!.answer, 'Sonnet')
})

test('the shared conversation list never serves stale rows after a write, and link counts stay right', async () => {
  const { run } = await import('./db.ts')
  const { list, editLabels, setStates } = await import('./conversations.ts')
  const now = Date.now()
  for (const id of ['cache-a', 'cache-b']) run(`insert into conversations (id, source, started_at, updated_at) values (?, 'claude', ?, ?)`, id, now, now)
  run(`insert into links (a, b, kind) values ('cache-a', 'cache-b', 'manual'), ('cache-b', 'cache-a', 'related'), ('cache-a', 'cache-a', 'manual')`)
  const row = (id: string) => list({ limit: 5000, focus: false }).conversations.find(r => r.id === id)
  assert.equal(row('cache-a')!.link_count, 3) // same as counting "a = id or b = id": a self-link counts once
  assert.equal(row('cache-b')!.link_count, 2)
  editLabels(['cache-a'], ['fresh'])
  assert.deepEqual(row('cache-a')!.labels, ['fresh']) // written here, seen right away
  setStates(['cache-b'], { pinned: true })
  assert.equal(row('cache-b')!.pinned, 1)
  // Callers get their own rows: changing one doesn't leak into the next list.
  row('cache-a')!.title = 'scribbled'
  assert.notEqual(row('cache-a')!.title, 'scribbled')
})

test('legacy needs-me flags become durable work, even when old or naming a merged PR', async () => {
  const { run, get } = await import('./db.ts')
  const { revalidate } = await import('./attention.ts')
  const { needByKey } = await import('./needsstore.ts')
  const now = Date.now()
  run(`insert or replace into prs (url, repo, number, state) values ('u1', 'PostHog/posthog', 990001, 'MERGED')`)
  for (const [id, reason] of [['t-merged', 'Verify posthog#990001 in production'], ['t-old', 'Unlock 1Password']]) {
    run(`insert or replace into attention (id, verdict, reason, judged_at, judged_updated_at) values (?, 1, ?, ?, 0)`, id, reason, now - 3 * 86400_000)
  }
  revalidate(now)
  for (const id of ['t-merged', 't-old']) {
    assert.equal(get<any>('select verdict from attention where id = ?', id).verdict, 0)
    assert.equal(needByKey(`chat:${id}`)?.status, 'checking')
  }
})

test('stalled chats of yours get resumed, at most twice a day, never automation', async () => {
  const { resumeStalls } = await import('./resumestalls.ts')
  const now = Date.now(); const sent: string[] = []
  const fake: any = (o: any) => { sent.push(o.id); return o.id }
  const base = { source: 'claude', stall: 'stopped mid tool call', effective: 'active', agent_kind: null }
  const rows: any[] = [
    { ...base, id: 's-mine', updated_at: now - 10 * 60_000 },
    { ...base, id: 's-fresh', updated_at: now - 60_000 },
    { ...base, id: 's-shepherd', agent_kind: 'shepherd', updated_at: now - 10 * 60_000 },
    { ...base, id: 's-none', stall: null, updated_at: now - 10 * 60_000 },
  ]
  assert.deepEqual(resumeStalls(rows, now, fake), ['s-mine'])
  assert.deepEqual(resumeStalls(rows, now, fake), []) // same stall: once
  resumeStalls([{ ...rows[0], updated_at: now - 9 * 60_000 }], now, fake)
  resumeStalls([{ ...rows[0], updated_at: now - 8 * 60_000 }], now, fake) // third stall in a day: skipped
  assert.deepEqual(sent, ['s-mine', 's-mine'])
})

// ---------- shepherd: nothing it stops on is permanent ----------
import { revive, unwatch, watch as shepherdWatch } from './shepherdstore.ts'
import { get as dbGet } from './db.ts'
test('shepherd brings stopped PRs back on its own: next-day cap, start failures, blocked deploys', () => {
  const now = Date.parse('2026-11-12T12:00:00Z'), H = 3600_000
  const row = (url: string) => dbGet<any>('select enabled, stage, paused_reason, revives from shepherd_watch where url = ?', url)
  const ins = (url: string, cols: string, vals: string) => dbRun(`insert into shepherd_watch (url, source, ${cols}) values ('${url}', 'auto', ${vals})`)
  ins('r/cap-old', 'enabled, paused_reason, runs_day', `1, 'hit 12 runs today', '2026-11-11'`)
  ins('r/cap-today', 'enabled, paused_reason, runs_day', `1, 'hit 12 runs today', '2026-11-12'`)
  ins('r/fetch-old', 'enabled, paused_reason, paused_at', `1, 'couldn''t start a run 3 times: git fetch', ${now - 2 * H}`)
  ins('r/fetch-new', 'enabled, paused_reason, paused_at', `1, 'couldn''t start a run 3 times: git fetch', ${now - 10 * 60_000}`)
  ins('r/blocked-due', 'enabled, stage, merged_at, revive_at', `0, 'blocked', ${now - 24 * H}, ${now - 1}`)
  ins('r/blocked-later', 'enabled, stage, merged_at, revive_at', `0, 'blocked', ${now - 24 * H}, ${now + H}`)
  ins('r/blocked-stale', 'enabled, stage, merged_at', `0, 'blocked', ${now - 8 * 24 * H}`)
  ins('r/unverified', 'enabled, stage, outcome, merged_at', `0, 'failed', 'NEEDS YOU: no verification after 9 tries', ${now - H}`)
  ins('r/regressed', 'enabled, stage, outcome, merged_at', `0, 'failed', 'REGRESSION: p95 up', ${now - H}`)
  revive(now)
  assert.equal(row('r/cap-old').paused_reason, null)
  assert.match(row('r/cap-today').paused_reason, /runs today/)
  assert.equal(row('r/fetch-old').paused_reason, null)
  assert.match(row('r/fetch-new').paused_reason, /couldn't start/)
  assert.deepEqual([row('r/blocked-due').enabled, row('r/blocked-due').stage, row('r/blocked-due').revives], [1, 'deploying', 1])
  assert.equal(row('r/blocked-later').enabled, 0)
  assert.equal(row('r/blocked-stale').enabled, 0)
  assert.equal(row('r/unverified').stage, 'deploying')
  assert.equal(row('r/regressed').enabled, 0)
})

test('shepherd stop sticks: revive never turns a stopped PR back on, watch does', () => {
  const now = Date.parse('2026-11-12T12:00:00Z'), H = 3600_000
  const row = () => dbGet<any>('select enabled, stage, awaiting from shepherd_watch where url = ?', 'r/stopped')
  dbRun(`insert into shepherd_watch (url, source, enabled, stage, outcome, merged_at, awaiting) values ('r/stopped', 'auto', 0, 'failed', 'NEEDS YOU: no verification after 9 tries', ${now - H}, 'verify:1')`)
  unwatch('r/stopped')
  revive(now)
  assert.deepEqual([row().enabled, row().stage, row().awaiting], [0, 'failed', null])
  shepherdWatch('r/stopped')
  assert.equal(row().enabled, 1)

})
import { retryGit } from './pr.ts'
test('retryGit retries a transient failure and surfaces git stderr when it keeps failing', async () => {
  let n = 0
  const waits: number[] = []
  const wait = async (ms: number) => { waits.push(ms) }
  assert.equal(await retryGit(async () => { if (++n < 3) throw new Error('Command failed: git fetch'); return 'ok' }, { wait }), 'ok')
  assert.deepEqual(waits, [2000, 10_000])
  await assert.rejects(
    retryGit(async () => { throw Object.assign(new Error('Command failed: git fetch\nx'), { stderr: 'fatal: unable to access: Could not resolve host\n' }) }, { wait }),
    /Command failed: git fetch: fatal: unable to access/)
})

test('a gh call killed by its timeout is recognised as a timeout', async () => {
  const { ghTimedOut } = await import('./prview.ts')
  assert.equal(ghTimedOut(Object.assign(new Error('Command failed: gh api graphql'), { killed: true, signal: 'SIGTERM' })), true)
  assert.equal(ghTimedOut(new Error('Command failed: gh api graphql\nerror connecting to api.github.com')), false)
})

test('server lock: a second server sees the live owner, a dead owner is taken over', async () => {
  const { claimServerLock, releaseServerLock } = await import('./single.ts')
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const file = join(mkdtempSync(join(tmpdir(), 'lock-')), 'server.pid')
  assert.deepEqual(claimServerLock(file, 111, () => true), { ok: true })
  assert.deepEqual(claimServerLock(file, 222, () => true), { ok: false, owner: 111 })
  assert.deepEqual(claimServerLock(file, 222, () => false), { ok: true })
  assert.equal(readFileSync(file, 'utf8'), '222')
  releaseServerLock(file, 111); assert.equal(readFileSync(file, 'utf8'), '222') // not ours: kept
  releaseServerLock(file, 222)
  writeFileSync(file, 'garbage'); assert.deepEqual(claimServerLock(file, 333, () => true), { ok: true })
})

// ---------- organiser: a provider limit is not a folder answer ----------
import { withCapFallback, type ChatEvent } from './chat.ts'
import { organizerReply } from './folders.ts'
import { friendly } from './errors.ts'

const organiserCap = "You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit · your 5-hour limit resets 6:50pm (America/Los_Angeles)"
const cappedReply = { type: 'result', is_error: true, result: organiserCap }
const jobDone = { type: 'perch_done', code: 0 }
const jobFailed = { type: 'perch_done', code: 1 }

function fakeJob() {
  let emit!: (ev: ChatEvent) => void, stops = 0
  return { run: (l: (ev: ChatEvent) => void) => { emit = l; return () => { stops++ } },
    emit: (ev: ChatEvent) => emit(ev), stops: () => stops }
}

test('the job that discovers a Claude cap finishes on the fallback, with one usable result', () => {
  const claude = fakeJob(), fallback = fakeJob(), events: ChatEvent[] = []
  let attempts = 0
  const stop = withCapFallback(claude.run, () => { attempts++; return fallback.run }, ev => events.push(ev))
  claude.emit(cappedReply)
  assert.deepEqual(events, [], 'the provider error is withheld from JSON consumers')
  claude.emit(jobFailed)
  assert.equal(attempts, 1)
  assert.deepEqual(events, [], 'the original completion must not finish the organiser')
  const answer = { type: 'result', is_error: false, result: '{"assign":{},"new":[],"links":[]}' }
  fallback.emit(answer)
  fallback.emit(jobDone)
  claude.emit(jobFailed)
  assert.deepEqual(events, [answer, jobDone])
  assert.deepEqual(organizerReply(events[0], events[1]), { assign: {}, new: [], links: [] })
  stop()
  assert.equal(fallback.stops(), 1, 'cancellation follows the active provider')
  assert.equal(claude.stops(), 0)
})

test('a cap without a fallback stays a provider error, including existing unreadable-reply reports', () => {
  const claude = fakeJob(), events: ChatEvent[] = []
  withCapFallback(claude.run, () => null, ev => events.push(ev))
  claude.emit(cappedReply)
  claude.emit(jobFailed)
  assert.deepEqual(events, [cappedReply, jobFailed])
  assert.deepEqual(organizerReply(events[0], events[1]), { error: organiserCap })
  for (const raw of [organiserCap, `unreadable reply: ${organiserCap}`]) {
    const error = friendly(new Error(raw), 'Organising folders')
    assert.match(error.message, /Claude's usage limit/)
    assert.doesNotMatch(error.message, /couldn't read/)
    assert.equal(error.status, 'retrying')
    assert.equal(error.transient, false, 'immediate backoff retries cannot reset a subscription cap')
  }
})

test('caps in stderr or the result errors array also trigger a single fallback attempt', () => {
  for (const result of [undefined, { type: 'result', is_error: true, errors: [organiserCap] }]) {
    const claude = fakeJob(), fallback = fakeJob(), events: ChatEvent[] = []
    let attempts = 0
    withCapFallback(claude.run, () => { attempts++; return fallback.run }, ev => events.push(ev))
    if (result) claude.emit(result)
    claude.emit(result ? jobFailed : { ...jobFailed, error: organiserCap })
    fallback.emit({ type: 'result', is_error: true, result: '' })
    fallback.emit({ ...jobFailed, error: 'Codex: usage limit reached' })
    assert.equal(attempts, 1, 'a failing fallback does not loop')
    assert.equal(events.length, 2)
    assert.deepEqual(organizerReply(events[0], events[1]), { error: 'Codex: usage limit reached' })
  }
})

test('cancelling a capped job before it exits prevents a fallback from starting', () => {
  const claude = fakeJob(), events: ChatEvent[] = []
  const stop = withCapFallback(claude.run, () => { assert.fail('cancelled work must not restart') }, ev => events.push(ev))
  claude.emit(cappedReply)
  stop()
  claude.emit(jobFailed)
  assert.equal(claude.stops(), 1)
  assert.deepEqual(events, [cappedReply, jobFailed])
})

test('successful answers mentioning limits and unrelated failures are never retried', () => {
  for (const result of [
    { type: 'result', is_error: false, result: '{"new":[{"name":"spend limit investigation"}]}' },
    { type: 'result', is_error: true, result: 'Failed to authenticate: OAuth session expired' },
  ]) {
    const claude = fakeJob(), events: ChatEvent[] = []
    withCapFallback(claude.run, () => { assert.fail('only a failed cap response can be retried') }, ev => events.push(ev))
    claude.emit(result)
    claude.emit(jobDone)
    assert.deepEqual(events, [result, jobDone])
  }
})

test('the organiser parses only successful replies and keeps provider failures out of the JSON parser', () => {
  const answer = { type: 'result', result: '```json\n{"folders":[]}\n```' }
  assert.deepEqual(organizerReply(answer, jobDone), { folders: [] })
  assert.deepEqual(organizerReply({ ...answer, is_error: true }, jobDone), { error: answer.result })
  assert.deepEqual(organizerReply(answer, jobFailed), { error: answer.result })
  assert.deepEqual(organizerReply(undefined, { ...jobFailed, error: 'spawn claude ENOENT' }), { error: 'spawn claude ENOENT' })
  assert.deepEqual(organizerReply({ type: 'result', is_error: true, errors: ['OAuth session expired'] }, jobFailed), { error: 'OAuth session expired' })
  assert.deepEqual(organizerReply({ type: 'result', result: 'not JSON' }, jobDone), { error: 'unreadable reply: not JSON' })
  assert.deepEqual(organizerReply(undefined, jobDone), { error: 'unreadable reply: empty' })
})

test('a PR in a repo with no local clone gets a checkout in perch\'s source cache instead of failing', async () => {
  const { repoCheckout } = await import('./pr.ts')
  const cloned: string[] = []
  const clone = async (slug: string, dir: string) => { cloned.push(`${slug} ${dir}`) }
  const { mkdtempSync } = await import('node:fs')
  const cache = mkdtempSync('/tmp/perch-src-')
  const repos = [
    { path: '/code/posthog-js', remote: 'git@github.com:PostHog/posthog-js.git' },
    { path: '/code/posthog', remote: 'https://github.com/PostHog/posthog' },
  ]
  // The user's own clone wins, matched exactly (posthog must not pick posthog-js).
  assert.equal(await repoCheckout('PostHog', 'posthog', { repos, cache, clone }), '/code/posthog')
  assert.equal(await repoCheckout('PostHog', 'posthog-js', { repos, cache, clone }), '/code/posthog-js')
  assert.deepEqual(cloned, [])
  // Not cloned anywhere: clone it into the cache once, then reuse it.
  assert.equal(await repoCheckout('PostHog', 'sdk-specs', { repos, cache, clone }), `${cache}/PostHog/sdk-specs`)
  assert.deepEqual(cloned, [`PostHog/sdk-specs ${cache}/PostHog/sdk-specs`])
  assert.equal(await repoCheckout('PostHog', 'sdk-specs', { repos, cache, clone, exists: () => true }), `${cache}/PostHog/sdk-specs`)
  assert.equal(cloned.length, 1)
})

test('a GitHub budget spent by other tools on the account is reported as theirs and left out of self-fix', async () => {
  const { budgetNotice } = await import('./gh.ts')
  const { notPerchBug } = await import('./errors.ts')
  const resetAt = Date.now() + 10 * 60_000
  assert.equal(budgetNotice({ limit: 5000, used: 3000, remaining: 2000, resetAt, at: Date.now() }), null)
  const n = budgetNotice({ limit: 5000, used: 5000, remaining: 0, resetAt, at: Date.now() })!
  assert.match(n, /^GitHub budget: other tools on your GitHub account have used 5,000 of 5,000/)
  assert.match(n, /Mothership made 0 GraphQL calls/)
  assert.ok(notPerchBug(n))
  // perch's own crashes are still fixable
  assert.ok(!notPerchBug('TypeError: Cannot read properties of undefined (reading \'map\')'))
  assert.ok(notPerchBug('gh api graphql: API rate limit already exceeded for user ID 1.'))
})

// Reviewer identity fences results; the scheduling lease may end before a fallback or follow-up.
import { claimNeeds, finishReview, HOUR, need, needHistory, recheckNeed, reportNeed, updateNeed } from './needsstore.ts'

function claimedNeed() {
  for (const table of ['needs', 'needs_events', 'needs_runs']) dbRun(`delete from ${table}`)
  const now = 1_000_000
  const n = reportNeed({ key: 'review-test', source: 'test', title: 'Check the blocker' }, now)
  const [claimed] = claimNeeds('reviewer', new Set(), 12, now)
  assert.equal(claimed.id, n.id)
  return { n: claimed, now, review: { reviewer_id: 'reviewer', revision: claimed.revision } }
}

test('Needs me accepts a resumed reviewer after a spend-cap failure closed its lease', () => {
  const { n, now, review } = claimedNeed()
  finishReview('reviewer', 'Reviewer failed; retry scheduled. Spend limit reached.', now + 1)
  assert.equal(need(n.id)!.lease_until, null)
  const updated = updateNeed(n.id, { ...review, status: 'agent', evidence: 'Codex continued the review and verified the handoff.' }, 'reviewer', now + 2)
  assert.equal(updated.status, 'agent')
  assert.equal(updated.attempts, 1)
  assert.equal(updated.next_check_at, now + 2 + 4 * HOUR)
  assert.equal(needHistory(n.id).length, 4)
})

test('Needs me accepts follow-up evidence from the same reviewer after its first outcome', () => {
  const { n, now, review } = claimedNeed()
  updateNeed(n.id, { ...review, status: 'checking', evidence: 'Waiting for a bounded evidence check.' }, 'reviewer', now + 1)
  assert.equal(need(n.id)!.lease_until, null)
  const updated = updateNeed(n.id, { ...review, status: 'resolved', evidence: 'Follow-up verified the original blocker is gone.' }, 'reviewer', now + 2)
  assert.equal(updated.status, 'resolved')
  assert.equal(updated.reviewer_id, 'reviewer')
  finishReview('reviewer', 'Turn finished.', now + 3)
  assert.equal(needHistory(n.id).length, 4, 'turn cleanup must not overwrite a recorded outcome')
})

test('Needs me rejects resumed reviews superseded by a source, reviewer, user or other writer', () => {
  const supersede = [
    (id: string, now: number) => reportNeed({ key: 'review-test', source: 'test', title: 'Changed blocker' }, now),
    (id: string, now: number) => recheckNeed(id, now),
    (id: string, now: number) => claimNeeds('new-reviewer', new Set(), 12, now + 25 * HOUR),
    ...['user', 'source', 'agent'].map(actor => (id: string, now: number) => updateNeed(id, { status: 'dismissed', evidence: 'Superseded by a newer decision.' }, actor, now)),
    // Existing rows written before this fix kept reviewer_id after another writer intervened.
    (id: string, now: number) => {
      updateNeed(id, { status: 'dismissed', evidence: 'Legacy user dismissal.' }, 'user', now)
      dbRun('update needs set reviewer_id = ? where id = ?', 'reviewer', id)
    },
  ]
  for (const change of supersede) {
    const { n, now, review } = claimedNeed()
    finishReview('reviewer', 'Interrupted.', now + 1)
    change(n.id, now + 2)
    const before = need(n.id), history = needHistory(n.id)
    assert.throws(() => updateNeed(n.id, { ...review, status: 'resolved', evidence: 'Stale result.' }, 'reviewer', now + 26 * HOUR), /Source changed or review was replaced/)
    assert.deepEqual(need(n.id), before)
    assert.deepEqual(needHistory(n.id), history)
  }
})

test('Needs me still requires the exact source revision when the reviewer lease is closed', () => {
  const { n, now } = claimedNeed()
  finishReview('reviewer', 'Interrupted.', now + 1)
  for (const revision of [undefined, 'wrong-revision']) {
    assert.throws(() => updateNeed(n.id, { reviewer_id: 'reviewer', revision, status: 'resolved', evidence: 'Unverified result.' }, 'reviewer', now + 2), /Source changed or review was replaced/)
  }
  assert.equal(need(n.id)!.status, 'checking')
  assert.equal(needHistory(n.id).length, 3)
})

test('Needs me recheck HTTP route retains supplied evidence and still invalidates the old review', { timeout: 30_000 }, async () => {
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const { mkdtempSync } = await import('node:fs')
  const { createServer } = await import('node:net')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { DatabaseSync } = await import('node:sqlite')
  const home = mkdtempSync(join(tmpdir(), 'perch-recheck-home-')), data = mkdtempSync(join(tmpdir(), 'perch-recheck-data-'))
  const socket = createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = (socket.address() as import('node:net').AddressInfo).port
  await new Promise<void>((resolve, reject) => socket.close(e => e ? reject(e) : resolve()))
  // Like fresh.test.ts: no live home, data, credentials or automatic work in this server.
  const srv = spawn(process.execPath, [join(import.meta.dirname, 'main.ts')], {
    env: { HOME: home, USER: 'newperson', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', PERCH_PORT: String(port), PERCH_DATA: data, PERCH_BROWSER_HEADLESS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(srv, 'exit')
  let out = ''
  srv.stdout.on('data', d => { out += d }); srv.stderr.on('data', d => { out += d })
  const request = async (path: string, method = 'GET', payload?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/needs${path}`, {
      method, headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(5000),
    })
    return { status: r.status, json: await r.json() as any }
  }
  try {
    for (let i = 0; i < 100 && !out.includes('Mothership on http') && srv.exitCode === null; i++) await new Promise(r => setTimeout(r, 100))
    assert.match(out, /Mothership on http/, out)
    const created = await request('', 'POST', { key: 'http-recheck', source: 'test', title: 'Check rollout readiness' })
    assert.equal(created.status, 200)
    const n = created.json
    const fixture = new DatabaseSync(join(data, 'perch.db'))
    try {
      fixture.prepare('update needs set reviewer_id = ?, lease_until = ? where id = ?').run('old-reviewer', Date.now() + HOUR, n.id)
    } finally { fixture.close() }
    const leased = (await request(`/${n.id}`)).json
    for (const evidence of [null, 42, { text: 'not a string' }]) {
      const invalid = await request(`/${n.id}/recheck`, 'POST', { evidence })
      assert.notEqual(invalid.status, 200)
      assert.match(invalid.json.error, /Evidence must be text/)
      assert.deepEqual((await request(`/${n.id}`)).json, leased, 'invalid evidence must not clear an active review')
    }
    const evidence = 'Follow-up verified access and sizing.\nAlert parity is still unproven; source: /tmp/readiness.md'
    assert.deepEqual(await request(`/${n.id}/recheck`, 'POST', { evidence }), { status: 200, json: { ok: true } })
    const updated = (await request(`/${n.id}`)).json
    assert.equal(updated.item.evidence, evidence)
    assert.equal(updated.history.at(-1).evidence, evidence)
    assert.equal(updated.item.status, 'checking')
    assert.equal(updated.item.revision, n.revision)
    assert.equal(updated.item.reviewer_id, null)
    assert.equal(updated.item.lease_until, null)
    const stale = await request(`/${n.id}/update`, 'POST', { status: 'resolved', evidence: 'Old review', reviewer_id: 'old-reviewer', revision: n.revision })
    assert.notEqual(stale.status, 200)
    assert.match(stale.json.error, /Source changed or review was replaced/)
    assert.deepEqual((await request(`/${n.id}`)).json, updated, 'stale updates must not alter the item or evidence history')
    // Both MCP's empty JSON body and the UI's bodyless request retain the default reason.
    for (const payload of [{}, undefined]) {
      assert.equal((await request(`/${n.id}/recheck`, 'POST', payload)).status, 200)
      const fallback = (await request(`/${n.id}`)).json
      assert.equal(fallback.item.evidence, 'Requested another check.')
      assert.equal(fallback.history.at(-1).evidence, 'Requested another check.')
      assert.ok(fallback.history.some((e: any) => e.evidence === evidence), 'earlier supplied evidence stays in history')
    }
  } finally {
    srv.kill()
    await exited
  }
})

test('optional GitHub pollers back off once 70% of the hour\'s GraphQL budget is used', async () => {
  const { ghPressure, setGhBudgetForTest } = await import('./gh.ts')
  const now = Date.now(), resetAt = now + 20 * 60_000
  setGhBudgetForTest(null); assert.equal(ghPressure(), false)
  setGhBudgetForTest({ limit: 5000, used: 3000, remaining: 2000, resetAt, at: now }); assert.equal(ghPressure(), false)
  setGhBudgetForTest({ limit: 5000, used: 3600, remaining: 1400, resetAt, at: now }); assert.equal(ghPressure(), true)
  assert.equal(ghPressure(now + 11 * 60_000), false) // stale probe
  assert.equal(ghPressure(resetAt + 1), false) // window rolled over
  setGhBudgetForTest(null)
})
