import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { db } from './db.ts'
import * as R from './productresearch.ts'

beforeEach(() => db.exec('delete from research_evidence; delete from research_items; delete from research_products'))
const setup = () => {
  const p = R.saveProduct({ name: 'Example', url: 'https://app.example.com/', docs_url: 'https://example.com/docs', scope: 'Traces', context: 'Test tier; synthetic traces' })
  const it = R.saveItem({ product_id: p.id, key: 'trace', title: 'Trace detail', url: 'https://app.example.com/traces', kind: 'workflow', capability: 'trace-investigation' })
  return { p, it }
}

test('seeding is idempotent and preserves research and explicit blockers', () => {
  R.seed()
  const first = R.overview(), it = first.items.find(it => it.product_id === 'datadog-apm' && it.status === 'blocked')!
  R.saveItem({ ...it, status: 'queued', notes: 'Account now available' })
  R.seed()
  assert.equal(R.overview().items.length, first.items.length)
  assert.equal(R.item(it.id).status, 'queued')
  assert.equal(R.overview().products.length, 4)
})

test('documentation cannot become successful product evidence; later docs preserve tested state', () => {
  const { it } = setup()
  assert.throws(() => R.saveItem({ ...it, status: 'tested' }), /Capture evidence/)
  assert.throws(() => R.addEvidence(it.id, { source: 'docs', summary: 'Claim', url: 'https://example.com/docs/traces', data: { assertion: { passed: true } } }), /Documentation/)
  R.addEvidence(it.id, { source: 'docs', summary: 'Docs describe waterfall', url: 'https://example.com/docs/traces', data: {} })
  assert.equal(R.item(it.id).status, 'documented')
  assert.throws(() => R.addEvidence(it.id, { source: 'product', summary: 'Claim', url: it.url, data: { assertion: { passed: false, expected: 'trace' }, steps: [{}] } }), /successful/)
  R.addEvidence(it.id, { source: 'product', summary: 'Expanded trace and checked duration', url: it.url, data: { assertion: { passed: true, expected: '150ms' }, steps: [{ do: 'click' }] } })
  R.addEvidence(it.id, { source: 'docs', summary: 'More docs', url: 'https://example.com/docs/traces', data: {} })
  assert.equal(R.item(it.id).status, 'tested')
  assert.equal(R.detail(it.id).evidence.length, 3)
})

test('benchmarks including total failure do not prove feature availability', () => {
  const { it } = setup()
  R.addEvidence(it.id, { source: 'product', summary: 'No successful samples', url: it.url, data: { measurement: { successes: 0 } } })
  assert.equal(R.item(it.id).status, 'queued')
  assert.deepEqual(R.summarizeSamples([{ ready_ms: 800 }, { error: 'timeout' }, { ready_ms: 100 }, { ready_ms: 300 }, { ready_ms: 500 }]), { attempts: 5, successes: 4, failures: 1, median_ms: 400, min_ms: 100, max_ms: 800 })
  assert.equal(R.summarizeSamples([{ error: 'timeout' }]).median_ms, null)
})

test('sandbox screenshots cannot masquerade as vendor product evidence', () => {
  const { p, it } = setup()
  assert.throws(() => R.discoverLinks(p.id, it.id, [], Infinity), /limit/)
  assert.throws(() => R.addEvidence(it.id, { source: 'sandbox', summary: 'Demo', url: it.url, data: {} }), /Sandbox/)
  R.saveProduct({ id: p.id, sandbox: true })
  assert.throws(() => R.addEvidence(it.id, { source: 'product', summary: 'Demo', url: it.url, data: {} }), /Sandbox/)
  assert.equal(R.addEvidence(it.id, { source: 'sandbox', summary: 'Demo', url: it.url, data: {} }).source, 'sandbox')
})

test('URL scope checks origins and path boundaries and rejects credentials', () => {
  assert.equal(R.within('https://example.com/docs/a', 'https://example.com/docs'), true)
  assert.equal(R.within('https://example.com/docs-evil', 'https://example.com/docs'), false)
  assert.equal(R.within('https://example.com.evil.test/docs', 'https://example.com/docs'), false)
  assert.equal(R.within('http://example.com/docs', 'https://example.com/docs'), false)
  for (const url of ['javascript:alert(1)', 'https://me:password@example.com', 'https://example.com/?api_key=secret', 'https://example.com/?code=secret']) assert.throws(() => R.cleanUrl(url))
  assert.equal(R.cleanUrl('https://example.com/?utm_source=ads&b=2&a=1'), 'https://example.com/?a=1&b=2')
  const { it } = setup()
  assert.throws(() => R.addEvidence(it.id, { source: 'product', summary: 'Docs page', url: 'https://example.com/docs/a', data: {} }), /source/)
})

test('discovery stays scoped, bounded and idempotent; anchors and actions do not explode the frontier', () => {
  const { p, it } = setup()
  const links = [{ url: 'https://app.example.com/traces/1', title: 'First trace' }, { url: 'https://app.example.com/traces/2', title: 'Second trace' }, { url: 'https://app.example.com/traces/3', title: 'Third trace' }, { url: 'https://outside.test', title: 'External' }, { url: 'https://app.example.com/logout', title: 'Logout' }, { url: 'https://app.example.com/#a', title: 'Anchor' }, { url: 'https://app.example.com/?session=secret', title: 'Sensitive' }]
  assert.equal(R.discoverLinks(p.id, it.id, links, 2).length, 2)
  assert.equal(R.discoverLinks(p.id, it.id, links).length, 1)
  assert.equal(R.discoverLinks(p.id, it.id, links).length, 0)
  assert.equal(R.next(p.id).next.length, 4)
})

test('map cannot gain cross-product parents or cycles; queue cannot hide unexplained gaps', () => {
  const { p, it } = setup(), other = setup()
  assert.throws(() => R.saveItem({ ...it, parent_id: other.it.id, status: 'queued' }), /Parent/)
  const child = R.saveItem({ product_id: p.id, key: 'child', title: 'Child', url: it.url, parent_id: it.id })
  assert.throws(() => R.saveItem({ ...it, parent_id: child.id, status: 'queued' }), /cycle/)
  assert.throws(() => R.saveItem({ ...it, status: 'blocked', notes: '' }), /Explain/)
  R.saveItem({ ...it, status: 'blocked', notes: 'Needs an account' })
  assert.equal(R.next(p.id).blocked.length, 1)
  assert.equal(R.next(p.id).next.length, 1)
  assert.equal(R.screenshotFile('../../settings.json'), null)
})
