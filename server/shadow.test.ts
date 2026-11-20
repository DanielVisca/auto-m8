import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shapeOf, verdict } from './shadow.ts'

test('shape: repo, conventional type and size bucket', () => {
  assert.equal(shapeOf({ repo: 'PostHog/posthog', title: 'fix(metrics): x', additions: 40, deletions: 10 }), 'posthog/posthog · fix · S')
  assert.equal(shapeOf({ repo: 'PostHog/charts', title: 'feat!: y', additions: 300, deletions: 100 }), 'posthog/charts · feat · M')
  assert.equal(shapeOf({ repo: 'a/b', title: 'Remove the thing', additions: 900, deletions: 0 }), 'a/b · other · L')
})

const orig = { write: { usd: 10, activeMs: 30 * 60_000 } }
const t = (model: string, o: Partial<any>) => ({ model, status: 'done', control: 0, outcome: 'same', score: 90, usd: 3, duration_ms: 10 * 60_000, costRatio: 0.3, timeRatio: 1 / 3, ...o })

test('verdict: control that cannot reproduce itself makes the PR inconclusive', () => {
  const v = verdict(orig, [t('opus', { control: 1, outcome: 'partial', score: 60 }), t('sonnet', {})], 'done')
  assert.equal(v.kind, 'inconclusive')
})

test('verdict: cheapest same-outcome model wins, with dollars and minutes saved', () => {
  const v: any = verdict(orig, [t('opus', { control: 1, usd: 9, costRatio: 0.9 }), t('sonnet', { usd: 4, costRatio: 0.4 }), t('haiku', { usd: 1, costRatio: 0.1, duration_ms: 5 * 60_000 })], 'done')
  assert.equal(v.kind, 'cheaper')
  assert.equal(v.model, 'haiku')
  assert.equal(v.savedUsd, 9)
  assert.equal(v.savedMs, 25 * 60_000)
})

test('verdict: no cheaper model with the same outcome means the cost was right', () => {
  const v = verdict(orig, [t('opus', { control: 1 }), t('haiku', { outcome: 'different', score: 20 }), t('sonnet', { score: 70 })], 'done')
  assert.equal(v.kind, 'right-cost')
})

test('verdict: a cheaper model as good as the control replay is a signal when the control falls short', () => {
  const v: any = verdict(orig, [t('opus', { control: 1, outcome: 'partial', score: 76, usd: 1.9, duration_ms: 1000 }), t('sonnet', { outcome: 'partial', score: 74, usd: 0.46, duration_ms: 740 }), t('haiku', { outcome: 'partial', score: 40, usd: 0.17 })], 'done')
  assert.equal(v.kind, 'matches-control')
  assert.equal(v.model, 'sonnet')
})

test('verdict: a local model that matches and is faster wins over a cheaper cloud model', () => {
  const v: any = verdict(orig, [t('opus', { control: 1, usd: 9, costRatio: 0.9 }), t('haiku', { usd: 1, costRatio: 0.1, duration_ms: 5 * 60_000 }), t('qwen3-coder:30b', { usd: 0, costRatio: 0, duration_ms: 20 * 60_000, timeRatio: 2 / 3 })], 'done')
  assert.equal(v.model, 'qwen3-coder:30b')
  assert.equal(v.local, true)
  assert.match(v.text, /free/)
})

test('fetched context keeps what the agent read outside the repo, minus anything carrying the merged change', async () => {
  const { fetchedContext } = await import('./shadow.ts')
  const diff = ['+++ b/x.py', ...Array.from({ length: 6 }, (_, i) => `+    value_${i} = compute_something_long_enough(${i})`)].join('\n')
  const tool = (name: string, input: any, result: string) => ({ kind: 'assistant', blocks: [{ type: 'tool', id: name, name, input, result }] })
  const items = [
    tool('mcp__claude_ai_Slack__slack_read_thread', { channel: 'C1' }, 'Ben: the range variable is empty in promql panels'),
    tool('Bash', { command: 'gh pr diff 133244' }, diff.replace(/^\+\+\+.*\n/, '')),
    tool('Bash', { command: 'ls server' }, 'a.ts b.ts'),
    tool('Read', { file_path: 'x.py' }, 'local file'),
  ]
  const f = fetchedContext(items, diff)
  assert.match(f.text, /range variable is empty/)
  assert.doesNotMatch(f.text, /compute_something/)
  assert.doesNotMatch(f.text, /a\.ts b\.ts|local file/)
  assert.equal(f.dropped, 1)
})

test('edit detection: reads and quoted comparisons are not edits, writes are', async () => {
  const { editsFiles } = await import('./shadow.ts')
  assert.equal(editsFiles(`gh pr list -R a/b --json number -q '.[] | select(.createdAt > "2026-11-10")' 2>&1 | head`), false)
  assert.equal(editsFiles('git status && git diff origin/master | head -50 2>/dev/null'), false)
  assert.equal(editsFiles('echo hi > out.txt'), true)
  assert.equal(editsFiles(`python3 - <<'EOF'\nopen('x','w').write('1')\nEOF`), true)
  assert.equal(editsFiles('git commit -qm x'), true)
  assert.equal(editsFiles(`python3 -c "import pathlib; pathlib.Path('a').write_text('b')"`), true)
})
