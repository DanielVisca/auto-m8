import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { addFinding, archOf, archText, resolveFinding, sectionsOf, setSections } from './archmap.ts'
import { createBoard } from './boards.ts'
import { db, run } from './db.ts'

beforeEach(() => db.exec('delete from board_sections; delete from board_findings; delete from board_section_readings; delete from boards; delete from canvas_tiles'))

test('sections merge by key and gather PRs by url and title regex', async () => {
  const b = createBoard('Arch')
  run("insert or replace into prs (url, title, state, authored, updated_at) values ('https://github.com/o/r/pull/1', 'feat: query batch streams', 'OPEN', 1, ?)", Date.now())
  run("insert or replace into prs (url, title, state, authored, updated_at) values ('https://github.com/o/r/pull/2', 'fix: unrelated', 'OPEN', 1, ?)", Date.now())
  setSections(b.id, [{ key: 'query_batch', label: 'query_batch (front door)', pr_match: 'query.?batch' }, { key: 'Redis', prs: ['https://github.com/o/r/pull/2'] }])
  setSections(b.id, [{ key: 'query_batch', about: 'the front door' }])
  assert.deepEqual(sectionsOf(b.id).map(s => s.key), ['query-batch', 'redis'])
  assert.equal(sectionsOf(b.id)[0].pr_match, 'query.?batch')
  const a = await archOf(b.id)
  assert.deepEqual(a.sections[0].prs.map((p: any) => p.url), ['https://github.com/o/r/pull/1'])
  assert.equal(a.sections[0].state, 'building')
  assert.equal(a.sections[1].prs.length, 1)
})

test('findings mark a section wrong until resolved', async () => {
  const b = createBoard('Arch')
  setSections(b.id, [{ key: 'clickhouse' }])
  assert.throws(() => addFinding(b.id, { section: 'nope', title: 'x' }), /No section/)
  const id = addFinding(b.id, { section: 'clickhouse', kind: 'wrong', title: 'Scans 157 GB of JSON', expected: '<1 GB', observed: '157 GB' })
  let a = await archOf(b.id)
  assert.equal(a.sections[0].state, 'wrong')
  assert.match(archText(b.id, a), /wrong #\d+: Scans 157 GB/)
  resolveFinding(id)
  a = await archOf(b.id)
  assert.equal(a.sections[0].state, 'idle')
})
