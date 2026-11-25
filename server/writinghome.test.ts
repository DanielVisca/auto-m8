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

test('preview takes the opening text and serves only the first local image by key', async () => {
  const { preview, imageFile, findWriting } = await import('./writinghome.ts')
  const dir = mkdtempSync(join(tmpdir(), 'prev-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'chart.png'), 'png')
  const p = preview('# Title\n\n<!-- note -->\nFirst para.\n\n![a chart](assets/chart.png)\n\nMore.', join(dir, 'draft.md'))
  assert.equal(p.excerpt, 'First para.\n\nMore.')
  assert.equal(imageFile(p.image!.split('/').pop()!), join(dir, 'assets', 'chart.png'))
  assert.equal(preview('![x](../../etc/passwd)', join(dir, 'd.md')).image, null)
  assert.equal(preview('![x](https://example.com/a.png)', join(dir, 'd.md')).image, 'https://example.com/a.png')
  writeFileSync(join(dir, 'notes.md'), 'x'); writeFileSync(join(dir, 'pic.png'), 'x')
  const f = await findWriting(dir + '/')
  assert.deepEqual(f.items.map(i => [i.name, i.dir]), [['assets', true], ['draft.md', false], ['notes.md', false]].filter(([n]) => n !== 'draft.md'))
  assert.deepEqual((await findWriting(dir + '/no')).items.map(i => i.name), ['notes.md'])
})
