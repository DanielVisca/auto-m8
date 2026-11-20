import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { itemsCache, itemsOf, toItems } from './transcript.ts'
import { readFileSync } from 'node:fs'

const user = (uuid: string, text: string) => JSON.stringify({ type: 'user', uuid, timestamp: '2026-11-19T00:00:00Z', message: { role: 'user', content: text } }) + '\n'
const tool = (id: string) => JSON.stringify({ type: 'assistant', uuid: 'a' + id, timestamp: '2026-11-19T00:00:01Z', message: { id: 'msg' + id, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } }) + '\n'
const result = (id: string, text: string) => JSON.stringify({ type: 'user', uuid: 'r' + id, timestamp: '2026-11-19T00:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } }) + '\n'

test('itemsOf reads only what was appended and matches a full parse, including results for earlier tools', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'perch-items-')), 't.jsonl')
  writeFileSync(path, user('u1', 'hello') + tool('t1'))
  const full0 = itemsCache.full
  assert.deepEqual(itemsOf(path), toItems(readFileSync(path, 'utf8')))
  assert.equal(itemsCache.full, full0 + 1)
  // A result for a tool parsed earlier, a new message, and a half-written last line.
  appendFileSync(path, result('t1', 'done') + user('u2', 'more') + '{"type":"user","uuid":"u3","mess')
  const grown = itemsOf(path)
  assert.equal(itemsCache.full, full0 + 1, 'appended bytes do not start a full parse')
  assert.equal((grown[1] as any).blocks[0].result, 'done')
  assert.equal(grown.length, 3)
  appendFileSync(path, 'age":{"role":"user","content":"late"}}\n')
  assert.deepEqual(itemsOf(path), toItems(readFileSync(path, 'utf8')))
  assert.equal(itemsOf(path).length, 4)
  // A complete last line without its newline is read now, and not twice once the file grows.
  appendFileSync(path, user('u4', 'no newline').trimEnd())
  assert.equal(itemsOf(path).length, 5)
  appendFileSync(path, '\n' + user('u5', 'after'))
  assert.deepEqual(itemsOf(path), toItems(readFileSync(path, 'utf8')))
  assert.equal(itemsOf(path).length, 6)
  // Rewritten in place (same or larger size, different bytes): parsed from the start again.
  writeFileSync(path, user('x1', 'a different thread, long enough to be larger than the file it replaces '.repeat(12)))
  assert.deepEqual(itemsOf(path).map((i: any) => i.uuid), ['x1'])
  assert.equal(itemsCache.full, full0 + 2)
})
