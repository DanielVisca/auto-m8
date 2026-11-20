import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { all, get, run, tx } from './db.ts'
import { updateSearch } from './searchindex.ts'
import { DATA_DIR, settings } from './settings.ts'
import { indexTranscript } from './indexer.ts'

const matches = (word: string) => all<{ id: string }>('select id from search where search match ? order by id', word).map(r => r.id)
const changes = () => get<{ n: number }>('select total_changes() n')!.n

test('repeated task sync leaves unchanged search documents unwritten, while new and changed tasks stay searchable', () => {
  const tasks = Array.from({ length: 100 }, (_, i) => ({ id: `task:search-test-${i}`, title: 'beforetitle', body: 'beforebody' }))
  tx(() => updateSearch(tasks))
  const before = changes()
  tx(() => updateSearch(tasks))
  assert.equal(changes(), before, 'an unchanged poll must not rewrite FTS documents')
  tx(() => updateSearch([{ ...tasks[0], title: 'aftertitle', body: 'afterbody' }, { id: 'task:search-new', title: 'newtitle', body: 'newbody' }]))
  assert.deepEqual(matches('aftertitle'), [tasks[0].id])
  assert.deepEqual(matches('afterbody'), [tasks[0].id])
  assert.equal(matches('beforebody').length, 99)
  assert.deepEqual(matches('newbody'), ['task:search-new'])
})

test('search replacement removes duplicates and rolls back with its conversation transaction', () => {
  run('insert into search(id,title,body) values(?,?,?)', 'duplicate', 'first', 'staleduplicate')
  run('insert into search(id,title,body) values(?,?,?)', 'duplicate', 'second', 'staleduplicate')
  tx(() => updateSearch([{ id: 'duplicate', title: 'clean', body: 'deduplicatedbody' }]))
  assert.deepEqual(matches('staleduplicate'), [])
  assert.deepEqual(matches('deduplicatedbody'), ['duplicate'])
  assert.throws(() => tx(() => { updateSearch([{ id: 'duplicate', title: 'aborted', body: 'abortedbody' }]); throw new Error('rollback') }), /rollback/)
  assert.deepEqual(matches('deduplicatedbody'), ['duplicate'])
  assert.deepEqual(matches('abortedbody'), [])
})

test('transcript indexing preserves appends, title changes, tool-only updates and a full rebuild', () => {
  const dir = join(DATA_DIR, 'search-transcripts')
  mkdirSync(dir, { recursive: true })
  settings.sources = [{ id: 'claude', label: 'test', dir, configDir: dir }]
  const path = join(dir, 'search-transcript.jsonl')
  const line = (value: unknown) => JSON.stringify(value) + '\n'
  writeFileSync(path, line({ type: 'user', timestamp: '2026-11-14T00:00:00Z', message: { role: 'user', content: 'initialsearchword' } }))
  indexTranscript(path)
  appendFileSync(path, line({ type: 'assistant', timestamp: '2026-11-14T00:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'appendedsearchword' }] } }))
  indexTranscript(path)
  appendFileSync(path, line({ type: 'ai-title', aiTitle: 'renamedsearchword' }))
  indexTranscript(path)
  const before = get<any>('select rowid, title, body from search where id = ?', 'search-transcript')
  appendFileSync(path, line({ type: 'assistant', timestamp: '2026-11-14T00:02:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'search-tool', name: 'Bash', input: {} }] } }))
  indexTranscript(path)
  assert.deepEqual(get('select rowid, title, body from search where id = ?', 'search-transcript'), before)
  assert.ok(get('select 1 from tool_calls where tool_use_id = ?', 'search-tool'), 'tool activity still indexes')
  for (const word of ['initialsearchword', 'appendedsearchword', 'renamedsearchword']) assert.deepEqual(matches(word), ['search-transcript'])
  writeFileSync(path, line({ type: 'user', timestamp: '2026-11-14T01:00:00Z', message: { role: 'user', content: 'replacementsearchword' } }))
  indexTranscript(path)
  assert.deepEqual(matches('appendedsearchword'), [])
  assert.deepEqual(matches('replacementsearchword'), ['search-transcript'])
})

test('per-chat updates go through the id map and keep exactly one document per chat (2026-11-16 freeze)', () => {
  tx(() => { for (let i = 0; i < 300; i++) run('insert into search (id, title, body) values (?, ?, ?)', `bulk-${i}`, 't', `seed${i}`) })
  tx(() => updateSearch(Array.from({ length: 300 }, (_, i) => ({ id: `bulk-${i}`, title: 't', body: `seed${i}` })))) // maps them
  assert.equal(get<{ n: number }>("select count(*) n from search_rowids where id like 'bulk-%'")!.n, 300)
  for (let i = 0; i < 50; i++) tx(() => updateSearch([{ id: `bulk-${i}`, title: 't', body: old => old + ` appended${i}` }]))
  assert.deepEqual(matches('appended7'), ['bulk-7'])
  assert.deepEqual(matches('seed7'), ['bulk-7']) // the old text was carried over, not lost
  assert.equal(get<{ n: number }>("select count(*) n from search where id = 'bulk-7'")!.n, 1)
  const mapped = get<{ rowid: number }>("select rowid from search_rowids where id = 'bulk-7'")!.rowid
  assert.equal(get<{ id: string }>('select id from search where rowid = ?', mapped)!.id, 'bulk-7') // the map points at the live row
})
