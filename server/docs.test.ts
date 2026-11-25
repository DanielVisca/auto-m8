import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addComment, addResearch, agentEdit, getDoc, GUARD_FILE, locate, openDoc, restoreVersion, saveDoc, toSlack, updateDoc } from './docs.ts'
import { check } from './docguard.ts'

const dir = mkdtempSync(join(tmpdir(), 'docs-'))
const file = (name: string, text: string) => { const p = join(dir, name); writeFileSync(p, text); return p }
const agent = { kind: 'agent' as const, name: 'Claude', conversation_id: 'c1' }

test('opens markdown only, keeps the file as the text, and saves with a revision', () => {
  assert.throws(() => openDoc(join(dir, 'x.json')), /markdown/)
  const d = openDoc(file('a.md', '# Hello\n\nworld'))
  assert.equal(d.title, 'Hello')
  const g = getDoc(d.id)
  assert.equal(g.text, '# Hello\n\nworld')
  const r = saveDoc(d.id, '# Hello\n\nthere', g.doc.rev)
  assert.ok('ok' in r)
  assert.equal(readFileSync(d.path, 'utf8'), '# Hello\n\nthere')
  // A stale save is a conflict, not an overwrite.
  const stale = saveDoc(d.id, 'mine', g.doc.rev)
  assert.ok('conflict' in stale)
})

test('agent edits come back as replayable steps; no agent text mode refuses them', () => {
  const d = openDoc(file('b.md', 'one two three'))
  const base = getDoc(d.id).doc.rev
  agentEdit(d.id, 'two', 'TWO', agent)
  const r: any = saveDoc(d.id, 'one two three four', base)
  assert.equal(r.conflict, true)
  assert.deepEqual(r.ops.map((o: any) => [o.old, o.new]), [['two', 'TWO']])
  updateDoc(d.id, { agent_text: 'blocked' })
  assert.throws(() => agentEdit(d.id, 'one', 'ONE', agent), /no agent text/)
  assert.ok(JSON.parse(readFileSync(GUARD_FILE, 'utf8')).includes(d.path))
  // Agents may still comment and add research.
  const c = addComment(d.id, { body: 'tighten', quote: 'three' }, agent)
  assert.equal(c.author_kind, 'agent')
  addResearch(d.id, { title: 'Source', url: 'https://example.com' }, agent)
  assert.equal(getDoc(d.id).research.length, 1)
})

test('the hook stops file tools and shell writes on a locked doc, not reads', () => {
  const p = '/Users/x/blog.md'
  assert.match(check({ tool_name: 'Write', tool_input: { file_path: p } }, [p])!, /no agent text/)
  assert.match(check({ tool_name: 'Edit', tool_input: { file_path: 'blog.md' }, cwd: '/Users/x' }, [p])!, /no agent text/)
  assert.match(check({ tool_name: 'Bash', tool_input: { command: `echo hi >> ${p}` } }, [p])!, /no agent text/)
  assert.equal(check({ tool_name: 'Bash', tool_input: { command: `cat ${p}` } }, [p]), null)
  assert.equal(check({ tool_name: 'Read', tool_input: { file_path: p } }, [p]), null)
  assert.equal(check({ tool_name: 'Write', tool_input: { file_path: '/Users/x/other.md' } }, [p]), null)
})

test('comments follow their quote, and versions restore', () => {
  assert.deepEqual(locate('aa bb aa', 'aa', 5), [6, 8])
  assert.equal(locate('abc', 'zz', 0), null)
  const d = openDoc(file('c.md', 'first draft'))
  const c = addComment(d.id, { body: 'hmm', quote: 'draft' }, { kind: 'person' })
  const g = getDoc(d.id)
  saveDoc(d.id, 'my first draft', g.doc.rev)
  const after = getDoc(d.id).comments.find(x => x.id === c.id)!
  assert.equal(after.start, 9)
  updateDoc(d.id, { agent_text: 'allowed' })
  agentEdit(d.id, 'my', 'our', agent)
  const v = getDoc(d.id).versions.find(x => x.author_name?.startsWith('before'))!
  restoreVersion(v.id)
  assert.equal(getDoc(d.id).text, 'my first draft')
})

test('slack formatting', () => {
  assert.equal(toSlack('# Title\n**bold** [x](https://a.b)\n- item'), '*Title*\n*bold* <https://a.b|x>\n• item')
})
