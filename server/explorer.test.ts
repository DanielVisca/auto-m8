import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildTimeline, checkRepo, conceptOf, drillGraph, dream, focusGraph, ghMemo, grouping, importsOf, MECHANICAL, namesIt, prOf, rootsOf, scan } from './explorer.ts'

// A tiny product repo: dashboards are built on insights, alerts on insights, everything on core.
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'explorer-'))
  const sh = (args: string[], env: Record<string, string> = {}) => execFileSync('git', ['-C', repo, ...args], { env: { ...process.env, ...env } })
  sh(['init', '-q', '-b', 'main'])
  const write = (f: string, s: string) => { mkdirSync(dirname(join(repo, f)), { recursive: true }); writeFileSync(join(repo, f), s) }
  const commit = (msg: string, date: string, author: string) => sh(['-c', `user.name=${author}`, '-c', 'user.email=a@example.com', 'commit', '-q', '-m', msg],
    { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: author })
  write('products/core/models.py', 'from django.db import models\n\nclass Team(models.Model):\n    name = models.CharField()\n')
  sh(['add', '-A']); commit('Add core (#1)', '2020-01-01T00:00:00Z', 'Ada')
  write('products/insights/models.py', 'from django.db import models\n\nclass Insight(models.Model):\n    team = models.ForeignKey("core.Team", on_delete=models.CASCADE)\n')
  write('products/insights/query.py', 'from products.core.models import Team\n')
  sh(['add', '-A']); commit('Insights (#12)', '2020-06-01T00:00:00Z', 'Bob')
  write('products/dashboards/models.py', 'from django.db import models\n\nclass Dashboard(models.Model):\n    team = models.ForeignKey("core.Team", on_delete=models.CASCADE)\n\nclass DashboardTile(models.Model):\n    dashboard = models.ForeignKey(Dashboard, on_delete=models.CASCADE)\n    insight = models.ForeignKey(\n        "insights.Insight", on_delete=models.CASCADE\n    )\n')
  write('products/dashboards/ui/Board.tsx', "import { run } from '../../insights/web/run'\nimport {\n  Thing,\n} from 'products/core/web/thing'\nimport React from 'react'\n")
  write('products/insights/web/run.ts', 'export const run = 1\n')
  write('products/core/web/thing.ts', 'export const Thing = 1\n')
  sh(['add', '-A']); commit('feat: dashboards (#30)', '2021-03-01T00:00:00Z', 'Cy')
  write('products/alerts/models.py', 'from django.db import models\nfrom products.insights.models import Insight\n\nclass Alert(models.Model):\n    insight = models.ForeignKey(Insight, on_delete=models.CASCADE)\n')
  write('products/alerts/tests/test_alert.py', 'from products.dashboards.models import Dashboard\n')
  sh(['add', '-A']); commit('Alerts on insights (#45)', '2022-02-01T00:00:00Z', 'Di')
  return repo
}
const repo = fixture()

test('conceptOf picks <container>/<child>, deepest container wins', () => {
  assert.equal(conceptOf('products/dashboards/backend/x.py', ['products']), 'products/dashboards')
  assert.equal(conceptOf('posthog/models/team/team.py', ['posthog', 'posthog/models']), 'posthog/models/team')
  assert.equal(conceptOf('posthog/models/team.py', ['posthog', 'posthog/models']), 'posthog/models')
  assert.equal(conceptOf('README.md', ['products']), '(root)')
})

test('importsOf reads python, multi-line TS, go and rust imports', () => {
  const py = importsOf('a.py', 'from x.y import (\n  A,\n  B as C,\n)\nimport z.w\n')
  assert.deepEqual(py.map(r => r.spec), ['x.y', 'z.w'])
  assert.deepEqual(py[0].names, ['A', 'B'])
  assert.deepEqual(importsOf('a.ts', "import {\n a,\n} from './b'\nconst c = await import('../c')\n").map(r => [r.spec, r.line]), [['./b', 3], ['../c', 4]])
  assert.deepEqual(importsOf('a.go', 'import (\n\t"fmt"\n\tk "github.com/x/repo/pkg/kafka"\n)\n').map(r => r.spec), ['fmt', 'github.com/x/repo/pkg/kafka'])
  assert.deepEqual(importsOf('a.rs', 'use crate::x;\npub use common_kafka::Producer;\n').map(r => r.spec), ['common_kafka::Producer'])
})

test('scan finds concepts, models, foreign-key and import edges with evidence', async () => {
  const g = await scan(repo)
  const ids = g.concepts.map(c => c.id).sort()
  assert.deepEqual(ids, ['products/alerts', 'products/core', 'products/dashboards', 'products/insights'])
  assert.equal(g.models.DashboardTile.concept, 'products/dashboards')
  const edge = (from: string, to: string, kind: string) => g.edges.find(e => e.from === `products/${from}` && e.to === `products/${to}` && e.kind === kind)
  const fk = edge('dashboards', 'insights', 'fk')!
  assert.ok(fk, 'multi-line ForeignKey to a string target')
  assert.match(fk.evidence[0].text, /DashboardTile → Insight/)
  assert.equal(fk.evidence[0].file, 'products/dashboards/models.py')
  assert.ok(edge('alerts', 'insights', 'fk'))
  assert.equal(edge('dashboards', 'core', 'fk')!.weight, 1)
  const imp = edge('dashboards', 'insights', 'import')!
  assert.deepEqual([imp.evidence[0].file, imp.evidence[0].line], ['products/dashboards/ui/Board.tsx', 1])
  assert.ok(edge('dashboards', 'core', 'import'), 'multi-line TS import by repo path')
  assert.ok(edge('alerts', 'insights', 'import'), 'python import attributed through the model name')
  assert.ok(!edge('alerts', 'dashboards', 'import'), 'tests are not architecture')
  assert.equal(g.concepts.find(c => c.id === 'products/dashboards')!.relations.length, 3)
})

test('focusGraph centres the focus, splits dependencies and dependents, caps and counts the rest', async () => {
  const g = await scan(repo)
  const f = focusGraph(g, 'insight', 25)
  const role = (id: string) => f.nodes.find(n => n.id === `products/${id}`)?.role
  assert.equal(role('insights'), 'focus')
  assert.equal(role('dashboards'), 'dependent')
  assert.equal(role('alerts'), 'dependent')
  assert.equal(role('core'), 'dependency')
  assert.ok(f.edges.every(e => f.nodes.some(n => n.id === e.from) && f.nodes.some(n => n.id === e.to)))
  // "Focus here" sends the module path: it must focus exactly that module (it used to match nothing).
  assert.deepEqual(focusGraph(g, 'products/dashboards').nodes.filter(n => n.role === 'focus').map(n => n.id), ['products/dashboards'])
  // The model name finds the module too.
  assert.equal(focusGraph(g, 'DashboardTile').nodes.find(n => n.role === 'focus')?.id, 'products/dashboards')
  const tiny = focusGraph(g, 'insight', 2)
  assert.equal(tiny.nodes.length, 2)
  assert.equal(tiny.hidden.dependencies + tiny.hidden.dependents, 2)
})

test('dream: removing insights breaks dashboards and alerts, adding links new nodes', async () => {
  const g = await scan(repo)
  const r = dream(g, [{ op: 'remove', id: 'products/insights' }])
  // Dashboards lose a foreign key and an import, alerts the same: tie broken by name.
  assert.deepEqual(r.broken.map(b => b.id).sort(), ['products/alerts', 'products/dashboards'])
  assert.ok(r.broken.every(b => b.loses.some(l => l.kind === 'fk')))
  assert.ok(r.edgesRemoved.every(e => e.from === 'products/insights' || e.to === 'products/insights'))
  assert.match(r.summary, /foreign keys/)
  // Transitive: something built on dashboards is affected one hop further out.
  const g2 = { concepts: [...g.concepts, { id: 'x' }], edges: [...g.edges, { from: 'x', to: 'products/dashboards', kind: 'import' as const, weight: 1, evidence: [] }] }
  assert.deepEqual(dream(g2, [{ op: 'remove', id: 'products/insights' }]).affected, [{ id: 'x', depth: 2, via: 'products/dashboards' }])
  const add = dream(g, [{ op: 'remove', id: 'products/insights' }, { op: 'add', id: 'queries', dependsOn: ['products/core', 'products/insights'], usedBy: ['products/dashboards'] }])
  assert.equal(add.edgesAdded.length, 3)
  assert.match(add.warnings.join(), /depends on products\/insights, which this dream removes/)
})

test('timeline orders concept and link introductions with authors and PR numbers', async () => {
  const g = await scan(repo)
  const f = focusGraph(g, 'insight')
  const t = await buildTimeline(repo, f.nodes, f.edges, () => {})
  assert.equal(t.status, 'done')
  assert.equal(t.shallow, false)
  const concept = (id: string) => t.events.find(e => e.kind === 'concept' && e.id === `products/${id}`)!
  assert.equal(concept('insights').commit.author, 'Bob')
  assert.equal(concept('insights').commit.pr, 12)
  assert.equal(concept('alerts').commit.pr, 45)
  assert.deepEqual(t.events.filter(e => e.kind === 'concept').map(e => e.id), ['products/core', 'products/insights', 'products/dashboards', 'products/alerts'])
  const link = t.events.find(e => e.kind === 'edge' && e.from === 'products/dashboards' && e.to === 'products/insights')!
  assert.equal(link.commit.pr, 30)
  assert.equal(link.approx, false)
  assert.ok(t.events.every((e, i) => i === 0 || t.events[i - 1].date <= e.date))
  assert.equal(prOf('Merge pull request #7 from x/y'), 7)
  // A concept is only “mentioned” when the subject names it as a word.
  assert.ok(namesIt('feat: Dashboards v2 (#9)', 'dashboard'))
  assert.ok(!namesIt('add alertmanager config', 'alert'))
  // Blame on a line rewritten by tooling isn't when the link was made.
  for (const m of ['chore: upgraded Ruff linter (#18188)', 'chore(frontend): Sort imports (#18663)', 'chore(dashboards): move dashboard models and API to product (#51924)', 'chore(flags): Add type annotations and fix mypy baseline'])
    assert.ok(MECHANICAL.test(m), m)
  assert.ok(!MECHANICAL.test('feat(bi): Insight variables rollups on dashboards (#25545)'))
})

test('checkRepo accepts git repos inside home only', async () => {
  const home = dirname(repo)
  assert.equal(await checkRepo(join(repo, 'products'), home), await checkRepo(repo, home))
  await assert.rejects(checkRepo(repo, mkdtempSync(join(tmpdir(), 'home-'))), /inside your home/)
  await assert.rejects(checkRepo(mkdtempSync(join(home, 'plain-')), home), /Not a git repository/)
  await assert.rejects(checkRepo(join(home, 'nope-missing'), home), /No such folder/)
})

test('GitHub history answers are kept, failures are retried', async () => {
  let calls = 0
  const f = async () => { calls++; return { date: '2020-01-01' } }
  assert.deepEqual(await ghMemo('t:keep', f), { date: '2020-01-01' })
  assert.deepEqual(await ghMemo('t:keep', f), { date: '2020-01-01' })
  assert.equal(calls, 1)
  let tries = 0
  const fail = async () => { tries++; return null }
  await ghMemo('t:fail', fail); await ghMemo('t:fail', fail)
  assert.equal(tries, 2)
})

test('grouping splits a module too big to reason about into its subfolders, and leaves noise alone', () => {
  const files = [...Array(30)].flatMap((_, i) => [`src/app/api/a${i}.py`, `src/app/issues/b${i}.py`, `src/app/grouping/c${i}.py`, `vendor/lib${i}/x.go`])
  const g = grouping(files, [], 40)
  assert.equal(g.of('src/app/issues/b1.py'), 'src/app/issues')
  assert.equal(g.of('src/app/api/a1.py'), 'src/app/api')
  assert.equal(g.of('vendor/lib3/x.go'), 'vendor')
})

test('rootsOf finds src/ Python packages, Go module paths and JS workspace names', () => {
  const files = ['src/sentry/__init__.py', 'src/sentry/api/__init__.py', 'go.mod', 'packages/core/package.json', 'package.json']
  const content: Record<string, string> = { 'go.mod': 'module github.com/acme/vm\n', 'packages/core/package.json': '{"name":"@acme/core"}', 'package.json': '{"name":"acme"}' }
  const r = rootsOf(files, f => content[f] ?? '')
  assert.deepEqual(r.pyRoots, ['src'])
  assert.deepEqual(r.go, [['github.com/acme/vm', '']])
  assert.deepEqual(r.js.find(([n]) => n === '@acme/core'), ['@acme/core', 'packages/core'])
})

test('a word search lists where the thing also lives inside other modules', () => {
  const c = (id: string, models: string[] = []) => ({ id, name: id.split('/').pop()!, path: id, files: 10, models, relations: [] })
  const g = {
    repo: 'r', sha: 's', edges: [], models: {},
    concepts: [c('products/alerts', ['Alert']), c('products/logs', ['LogsAlertConfiguration', 'LogEntry']), c('products/errors'), c('products/metrics')],
    folders: ['products/alerts/backend', 'products/errors/backend/platform_alerts', 'products/errors/backend/platform_alerts/sub', 'products/metrics/frontend/alerting', 'products/metrics/backend'],
  }
  const f = focusGraph(g, 'alert', 25, false, g.folders)
  assert.deepEqual(f.nodes.filter(n => n.role === 'focus').map(n => n.id), ['products/alerts'])
  assert.deepEqual(f.alsoIn, [
    { concept: 'products/errors', folders: ['backend/platform_alerts'], models: [] },
    { concept: 'products/metrics', folders: ['frontend/alerting'], models: [] },
    { concept: 'products/logs', folders: [], models: ['LogsAlertConfiguration'] },
  ])
  assert.equal(focusGraph(g, 'billing', 25, false, g.folders).alsoIn, undefined)
})

test('drilling into a module shows its parts, their links, and outside modules collapsed', async () => {
  const g = await scan(repo)
  const d = await drillGraph(g, 'products/dashboards')
  assert.deepEqual(d.drill?.crumbs, ['products', 'products/dashboards'])
  assert.equal(d.drill?.owner, 'products/dashboards')
  const parts = d.nodes.filter(n => n.role === 'focus').map(n => n.id).sort()
  assert.deepEqual(parts, ['products/dashboards', 'products/dashboards/ui'])
  assert.deepEqual(d.nodes.find(n => n.id === 'products/dashboards')?.models, ['Dashboard', 'DashboardTile'])
  const e = (from: string, to: string, kind: string) => d.edges.find(x => x.from === from && x.to === to && x.kind === kind)
  assert.ok(e('products/dashboards/ui', 'products/insights', 'import'), 'a part links to the outside module')
  assert.ok(e('products/dashboards', 'products/insights', 'fk'), 'foreign keys land on the part that holds the model')
  assert.ok(d.nodes.some(n => n.id === 'products/insights' && n.role !== 'focus'))
})

test('drilling into a flat folder makes its files the parts, linked by their imports', async () => {
  const r = mkdtempSync(join(tmpdir(), 'explorer-flat-'))
  const sh = (args: string[]) => execFileSync('git', ['-C', r, ...args])
  sh(['init', '-q', '-b', 'main'])
  const w = (f: string, s: string) => { mkdirSync(dirname(join(r, f)), { recursive: true }); writeFileSync(join(r, f), s) }
  for (const n of ['chat', 'db', 'git', 'main', 'mcp', 'ui']) w(`server/${n}.ts`, n === 'main' ? "import { a } from './chat.ts'\nimport { b } from './db'\n" : n === 'chat' ? "import { b } from './db.ts'\n" : 'export const x = 1\n')
  w('web/app.ts', "import { x } from '../server/mcp'\n")
  sh(['add', '-A']); sh(['-c', 'user.name=A', '-c', 'user.email=a@example.com', 'commit', '-q', '-m', 'init'])
  const g = await scan(r)
  const d = await drillGraph(g, 'server')
  assert.deepEqual(d.nodes.filter(n => n.role === 'focus').map(n => n.id).sort(), ['server/chat.ts', 'server/db.ts', 'server/git.ts', 'server/main.ts', 'server/mcp.ts', 'server/ui.ts'])
  const has = (from: string, to: string) => d.edges.some(e => e.from === from && e.to === to)
  assert.ok(has('server/main.ts', 'server/chat.ts') && has('server/main.ts', 'server/db.ts') && has('server/chat.ts', 'server/db.ts'))
  assert.ok(has('web', 'server/mcp.ts'), 'an outside module lands on the file it imports')
})
