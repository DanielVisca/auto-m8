import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { board, boards, chatBoard, copyTile, createBoard, DEFAULT_BOARD_TTL, expireBoards, putTile, requireCanvas, showBoard, updateBoard, useBoard } from './boards.ts'
import { onCanvas, reportTile, saveTile, tiles } from './canvas.ts'
import { db, get, run } from './db.ts'

beforeEach(() => db.exec('delete from chat_boards; delete from canvas_tiles; delete from boards'))

test('existing boards and new lasting boards never expire; temporary defaults to 24 hours', t => {
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  run("insert into boards (id, name, updated_at) values ('legacy', 'Legacy', 1)")
  const kept = createBoard('Kept')
  const temp = createBoard('Sketch', undefined, undefined, { temporary: true })
  assert.equal(temp.ttl_seconds, DEFAULT_BOARD_TTL)
  assert.equal(temp.expires_at, now + DEFAULT_BOARD_TTL * 1000)
  now += DEFAULT_BOARD_TTL * 1000
  assert.equal(expireBoards(), 1)
  assert.deepEqual(boards().map(b => b.id).sort(), [kept.id, 'legacy'].sort())
  assert.equal(board('legacy')!.expires_at, null)
})

test('opening and using renew the idle lifetime; reads and background writes do not', async t => {
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  const b = createBoard('Temporary', undefined, undefined, { ttl_seconds: 60 })
  const tile = await putTile({ board_id: b.id, text: 'a chart' })
  showBoard('chat', b.id)
  now += 40_000
  assert.equal(useBoard(b.id), true)
  const expires = now + 60_000
  now += 30_000
  boards(); board(b.id); chatBoard('chat')
  saveTile({ id: tile.id, folder_id: b.id, kind: 'note', state: { refreshed: true } })
  reportTile(tile.id, 'background refresh error')
  assert.equal(board(b.id)!.expires_at, expires)
  now = expires - 1
  assert.equal(expireBoards(), 0)
  now++
  assert.equal(expireBoards(), 1)
  assert.equal(board(b.id), null)
  assert.equal(chatBoard('chat'), null)
  assert.deepEqual(tiles(b.id), [])
  assert.equal(useBoard(b.id), false)
  assert.throws(() => showBoard('chat', b.id), /No board/)
  assert.throws(() => requireCanvas(b.id), /expired/)
  assert.throws(() => saveTile({ id: tile.id, folder_id: b.id, kind: 'note', state: {} }), /expired/)
})

test('explicit tile edits, copies and showing a board renew it', async t => {
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  const b = createBoard('Temporary', undefined, undefined, { ttl_seconds: 60 })
  const source = createBoard('Source')
  const tile = await putTile({ board_id: source.id, text: 'source' })
  now += 50_000
  copyTile(tile.id, b.id)
  now += 50_000
  showBoard('chat', b.id)
  now += 50_000
  await putTile({ board_id: b.id, text: 'edit' })
  now += 50_000
  assert.ok(board(b.id))
})

test('Keep and pinning disable expiry; choosing a TTL unpins; Home limit remains enforced', t => {
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  const a = createBoard('Keep me', undefined, undefined, { ttl_seconds: 60 })
  const b = createBoard('Pin me', undefined, undefined, { temporary: true })
  updateBoard(a.id, { temporary: false })
  updateBoard(b.id, { pinned: true })
  now += 100_000_000
  assert.equal(expireBoards(), 0)
  assert.equal(board(b.id)!.ttl_seconds, null)
  updateBoard(b.id, { ttl_seconds: 3600 })
  assert.equal(board(b.id)!.pinned, 0)
  assert.equal(board(b.id)!.expires_at, now + 3600_000)
  for (let i = 0; i < 3; i++) updateBoard(createBoard(`pin ${i}`).id, { pinned: true })
  assert.throws(() => updateBoard(b.id, { pinned: true }), /Home holds 3/)
  assert.equal(board(b.id)!.ttl_seconds, 3600)
})

test('invalid TTLs are rejected without changing an existing board', () => {
  const b = createBoard('Kept')
  for (const ttl_seconds of [0, -1, 59, 60.5, NaN, Infinity, 31536001, '60']) {
    assert.throws(() => createBoard('Invalid', undefined, undefined, { ttl_seconds: ttl_seconds as number }), /ttl_seconds/)
    assert.throws(() => updateBoard(b.id, { ttl_seconds: ttl_seconds as number }), /ttl_seconds/)
  }
  assert.equal(boards().length, 1)
  assert.equal(board(b.id)!.ttl_seconds, null)
})

test('renewals do not broadcast reloads, expiry emits once after complete cleanup', t => {
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  const b = createBoard('Temporary', undefined, undefined, { ttl_seconds: 60 })
  showBoard('chat', b.id)
  let changes = 0
  const on = () => { changes++; assert.equal(get('select 1 from boards where id = ?', b.id), undefined); assert.equal(chatBoard('chat'), null) }
  onCanvas.add(on)
  try {
    now += 10_000
    useBoard(b.id)
    assert.equal(changes, 0)
    now += 60_000
    expireBoards()
    assert.equal(changes, 1)
  } finally { onCanvas.delete(on) }
})
