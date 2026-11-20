// Codex transcript appends read only what's new (2026-11-16: a 52.7s stall from re-parsing whole files).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from './db.ts'
import { codexMessageUuid, recordCodexMessage } from './codex-history.ts'

const rows = (path: string) => readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l))
function chat(lines: object[]) {
  const id = `c-${Math.random().toString(36).slice(2)}`, cwd = '/tmp/x'
  const path = join(mkdtempSync(join(tmpdir(), 'codexhist-')), `${id}.jsonl`)
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''))
  run(`insert into conversations (id, source, started_at, updated_at, messages, path) values (?, 'claude', 0, 0, 0, ?)`, id, path)
  return { id, cwd, path }
}

test('appends chain to the last main-thread entry, skip duplicates, and see lines another writer added', () => {
  const c = chat([{ type: 'user', uuid: 'u1', isSidechain: false }, { type: 'assistant', uuid: 'side', isSidechain: true }])
  recordCodexMessage({ ...c, turnId: 't', itemId: 'a', text: 'one' })
  const first = codexMessageUuid('t', 'a')
  assert.equal(rows(c.path).at(-1).parentUuid, 'u1') // the sidechain entry is skipped
  recordCodexMessage({ ...c, turnId: 't', itemId: 'a', text: 'one again' }) // same id: not written twice
  assert.equal(rows(c.path).filter(r => r.uuid === first).length, 1)
  appendFileSync(c.path, JSON.stringify({ type: 'user', uuid: 'u2', isSidechain: false }) + '\n') // another writer
  recordCodexMessage({ ...c, turnId: 't', itemId: 'b', text: 'two' })
  assert.equal(rows(c.path).at(-1).parentUuid, 'u2')
  writeFileSync(c.path, JSON.stringify({ type: 'user', uuid: 'fresh' }) + '\n') // replaced file: start over
  recordCodexMessage({ ...c, turnId: 't', itemId: 'c', text: 'three' })
  assert.equal(rows(c.path).at(-1).parentUuid, 'fresh')
})

test('200 appends to a 20MB transcript stay fast (no whole-file re-read per append)', () => {
  const big = Array.from({ length: 20_000 }, (_, i) => ({ type: 'assistant', uuid: `old-${i}`, isSidechain: false, message: { content: 'x'.repeat(1000) } }))
  const c = chat(big)
  const t = performance.now()
  for (let i = 0; i < 200; i++) recordCodexMessage({ ...c, turnId: 'big', itemId: String(i), text: `block ${i}` })
  const ms = performance.now() - t
  assert.equal(rows(c.path).at(-1).parentUuid, codexMessageUuid('big', '198'))
  assert.ok(ms < 3000, `200 appends took ${Math.round(ms)}ms`)
})
