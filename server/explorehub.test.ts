import assert from 'node:assert/strict'
import { test } from 'node:test'
import { db, run } from './db.ts'
import { createBoard, openedBoard, putTile, showBoard } from './boards.ts'
import * as R from './productresearch.ts'
import { canvases, competitor, competitors } from './explorehub.ts'

const chat = (id: string, title: string) => run('insert into conversations (id, source, title, started_at, updated_at) values (?, ?, ?, ?, ?)', id, 'claude', title, Date.now(), Date.now())

test('a canvas links back to the chats that made, showed and edited it, and records when it was opened', async () => {
  chat('c-make', 'Make the board'); chat('c-show', 'Show the board')
  const b = createBoard('Trains', undefined, 'c-make')
  showBoard('c-show', b.id)
  await putTile({ board_id: b.id, text: 'hi', by: 'c-show' })
  let c = canvases().find(x => x.id === b.id)!
  assert.equal(c.opened_at, null)
  assert.deepEqual(c.chats.map(x => x.id).sort(), ['c-make', 'c-show'])
  assert.equal(c.chats.find(x => x.id === 'c-make')!.role, 'created')
  openedBoard(b.id)
  c = canvases().find(x => x.id === b.id)!
  assert.ok(c.opened_at)
  assert.equal(c.kinds.note, 1)
})

test('a competitor reports coverage, depth, data scale and method, and its map is a tree', () => {
  db.exec('delete from research_evidence; delete from research_items; delete from research_products')
  const p = R.saveProduct({ name: 'Example', url: 'https://app.example.com/', docs_url: 'https://example.com/docs', scope: 'Traces', context: 'Test', data_scale: '1 service, 10k spans', method: 'product_research by hand' })
  const root = R.saveItem({ product_id: p.id, key: 'home', title: 'Home', url: 'https://app.example.com/' })
  const kid = R.saveItem({ product_id: p.id, key: 'traces', title: 'Traces', url: 'https://app.example.com/traces', parent_id: root.id })
  R.addEvidence(kid.id, { source: 'docs', summary: 'Docs describe traces', url: 'https://example.com/docs/traces', data: { conversation_id: 'nope' } })
  const s = competitors().find(x => x.id === p.id)!
  assert.equal(s.items, 2); assert.equal(s.covered, 1); assert.equal(s.coverage, 0.5); assert.equal(s.depth, 'docs only')
  assert.equal(s.data_scale, '1 service, 10k spans'); assert.equal(s.method, 'product_research by hand')
  assert.deepEqual(s.chats, []) // unknown conversations are not listed
  const d = competitor(p.id)
  assert.deepEqual(d.tree.map((i: any) => [i.title, i.depth]), [['Home', 0], ['Traces', 1]])
  assert.equal(d.tree[1].evidence.length, 1)
  // Editing the product without the new fields keeps them.
  R.saveProduct({ id: p.id, scope: 'Traces and logs' })
  assert.equal(competitors().find(x => x.id === p.id)!.data_scale, '1 service, 10k spans')
})
