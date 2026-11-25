import { test } from 'node:test'
import assert from 'node:assert/strict'
import { frontTitle, insightUrl, isPage, kindOf, urlPath } from './published.ts'

test('maps site content files to pages and URLs', () => {
  assert.equal(urlPath('contents/docs/metrics/index.mdx'), '/docs/metrics')
  assert.equal(urlPath('contents/product-engineers/what-is-x.md'), '/product-engineers/what-is-x')
  assert.ok(isPage('contents/docs/metrics/basics.mdx'))
  assert.ok(!isPage('contents/docs/metrics/installation/_snippets/next.mdx'))
  assert.ok(!isPage('contents/teams/apm/index.mdx'))
  assert.ok(!isPage('src/data/authors.json'))
  assert.equal(kindOf('contents/docs/logs/x.mdx'), 'docs')
  assert.equal(kindOf('contents/blog/x.md'), 'article')
  assert.equal(frontTitle("---\ntitle: 'What is tracing? (A guide)'\nauthor:\n  - someone\n---\n# Other"), 'What is tracing? (A guide)')
  assert.equal(frontTitle('# Only a heading'), 'Only a heading')
  const u = decodeURIComponent(insightUrl(['/docs/a']).split('#q=')[1])
  assert.deepEqual(JSON.parse(u).source.properties[1].value, ['/docs/a', '/docs/a/'])
})
