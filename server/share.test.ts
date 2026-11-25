import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { board, createBoard } from './boards.ts'
import { saveTile } from './canvas.ts'
import { db, run } from './db.ts'
import { sharesOf, splitTile, translateForPostHog } from './share.ts'

beforeEach(() => db.exec('delete from canvas_tiles; delete from boards; delete from board_shares; delete from canvas_data_cache'))

test('splitTile pulls scripts out, scopes page-level CSS and renames the palette tokens', () => {
  const s = splitTile(`<!doctype html><html><head><style>body{padding:8px} :root{color:var(--muted)}</style></head><body><div id="x"></div><script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script><script>perch.onRefresh(()=>{})</script></body></html>`)
  assert.deepEqual(s.scripts, ['perch.onRefresh(()=>{})'])
  assert.deepEqual(s.external, ['https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js'])
  assert.match(s.markup, /\.tile-body\{padding:8px\}/)
  assert.match(s.markup, /:host\{color:var\(--am-muted\)\}/)
  assert.doesNotMatch(s.markup, /<script|<html|<body/)
})

test('a board becomes a PostHog canvas project: live HogQL, snapshots for local data, placeholders for the rest', () => {
  const b = createBoard('Ops')
  saveTile({ folder_id: b.id, kind: 'code', x: 0, y: 0, w: 6, h: 4, config: { title: 'Live', html: `<div id="o"></div><script>perch.data({source:'posthog',hogql:'select 1'})</script>` } })
  saveTile({ folder_id: b.id, kind: 'code', x: 6, y: 0, w: 6, h: 4, config: { title: 'Local', html: `<script>perch.data({source:'perch',path:'/api/deploys?days=14'})</script>` } })
  saveTile({ folder_id: b.id, kind: 'code', x: 0, y: 4, w: 6, h: 4, config: { title: 'Charty', html: `<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"></script>` } })
  saveTile({ folder_id: b.id, kind: 'term', x: 6, y: 4, w: 6, h: 4, config: {} })
  run('insert into canvas_data_cache (key, v, at) values (?, ?, ?)', JSON.stringify({ source: 'perch', path: '/api/deploys?days=14' }), JSON.stringify({ totals: { merged: 3 } }), 1)
  const t = translateForPostHog(board(b.id)!)
  const files = t.project.files
  assert.equal(t.project.capabilities.posthog.inlineQueries, true)
  assert.ok(files['src/tiles/t0.js'].includes("hogql:'select 1'"))
  const snaps = JSON.parse(files['src/snapshots.json'])
  assert.deepEqual(Object.values<any>(Object.values<any>(snaps)[0])[0].v, { totals: { merged: 3 } })
  const tiles = JSON.parse(files['src/board.json']).tiles
  assert.equal(tiles.find((x: any) => x.title === 'Charty').kind, 'other') // Chart.js isn't on PostHog's allowed list
  assert.ok(tiles.find((x: any) => x.kind === 'term').placeholder)
  assert.equal(t.notes.length, 3)
  for (const f of Object.values<string>(files)) assert.doesNotMatch(f, /var\(--(muted|bg|fg|accent)\)/)
  assert.deepEqual(sharesOf(b.id), [])
})

test('generated files never trip PostHog\'s text checks, and still mean the same thing', async () => {
  const { defuseCode, jsonFile } = await import('./share.ts')
  const data = { note: "no bulk or Prometheus-rules import'], see <script> and fetch( from 'x' require(" }
  const j = jsonFile(data)
  assert.deepEqual(JSON.parse(j), data)
  const checks = [/\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/, /\bimport\s*\(/, /\brequire\s*\(/, /<script\b/i, /\bfetch\s*\(/]
  for (const re of checks) assert.doesNotMatch(j, re)
  const code = defuseCode(`const a = ['rules import'], b = "data from 'x'", c = '<script>'`)
  for (const re of [checks[0], checks[3]]) assert.doesNotMatch(code, re)
  assert.deepEqual(new Function(`${code}; return [a, b, c]`)(), [['rules import'], "data from 'x'", '<script>'])
})

test('share status flags local changes made after the last share', async () => {
  const { boardHash, shareStatus } = await import('./share.ts')
  const b = createBoard('Ops')
  const t = saveTile({ folder_id: b.id, kind: 'note', x: 0, y: 0, w: 3, h: 3, config: { text: 'one' } })
  run(`insert into board_shares (board_id, target, remote_id, url, audience, audience_label, version_id, shared_at, notes, source_hash) values (?, 'posthog', 'not-a-canvas', 'https://example.test/c', 'a', 'Only me', 'v1', 1, '[]', ?)`, b.id, boardHash(board(b.id)!))
  assert.equal((await shareStatus(b.id, true))[0].local_changes, false)
  saveTile({ ...t, state: { seen: true } }) // saved tile state isn't a change to the board
  assert.equal((await shareStatus(b.id, true))[0].local_changes, false)
  saveTile({ ...t, config: { text: 'two' } })
  const s = (await shareStatus(b.id, true))[0]
  assert.equal(s.local_changes, true)
  assert.equal(s.viewers, null) // no PostHog here: no viewer data, not an error
})
