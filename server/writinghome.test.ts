import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseShelfTable, readShelf } from './writinghome.ts'

test('reads the shelf table, drafts and inbox ideas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shelf-'))
  mkdirSync(join(dir, 'posts', 'a-post'), { recursive: true })
  mkdirSync(join(dir, 'posts', 'no-row'), { recursive: true })
  mkdirSync(join(dir, 'inbox'))
  writeFileSync(join(dir, 'README.md'), '| Post | One thing | Status | Words | Draft |\n| --- | --- | --- | --- | --- |\n| Fast traces, slow page | Measure the queue | draft-for-edit | 300 | [Read](posts/a-post/draft.md) |\n')
  writeFileSync(join(dir, 'posts', 'a-post', 'draft.md'), '# Ignored heading\n\none two three <!-- note -->\n')
  writeFileSync(join(dir, 'posts', 'a-post', 'worksheet.md'), 'x')
  writeFileSync(join(dir, 'posts', 'no-row', 'draft.md'), '# From heading\n')
  writeFileSync(join(dir, 'inbox', '2026-11-24-abc-idea.md'), '# An idea\n\n- Point: the short version.\n')
  writeFileSync(join(dir, 'inbox', 'evidence.json'), '{}')
  const s = readShelf(dir)!
  const a = s.posts.find(p => p.slug === 'a-post')!
  assert.equal(a.title, 'Fast traces, slow page')
  assert.equal(a.status, 'draft-for-edit')
  assert.equal(a.words, 5)
  assert.ok(a.worksheet)
  assert.equal(s.posts.find(p => p.slug === 'no-row')!.title, 'From heading')
  assert.deepEqual(s.ideas.map(i => [i.title, i.point, i.captured]), [['An idea', 'the short version.', '2026-11-24']])
  assert.equal(readShelf(join(dir, 'missing')), null)
  assert.equal(parseShelfTable('no table').size, 0)
})
