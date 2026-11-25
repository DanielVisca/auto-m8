// Durable product research. Browser recordings are disposable; these observations are not.
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { all, db, get, run } from './db.ts'
import { DATA_DIR } from './settings.ts'

export type ResearchStatus = 'queued' | 'documented' | 'observed' | 'tested' | 'blocked' | 'not_found'
export type ResearchProduct = { id: string; name: string; url: string; docs_url: string; trial_url: string; scope: string; context: string; sandbox: number; created_at: number; data_scale: string; method: string }
export type ResearchItem = { id: string; product_id: string; key: string; title: string; kind: 'page' | 'feature' | 'workflow'; url: string; parent_id: string | null; capability: string; status: ResearchStatus; notes: string; updated_at: number }
export type ResearchEvidence = { id: string; item_id: string; source: 'docs' | 'product' | 'sandbox'; summary: string; url: string; captured_at: number; screenshot: string | null; data: any }
export const onResearch = new Set<() => void>()
const changed = () => onResearch.forEach(f => f())
const DIR = join(DATA_DIR, 'product-research')

db.exec(`
create table if not exists research_products (
 id text primary key, name text not null, url text not null, docs_url text not null,
 trial_url text not null, scope text not null, context text not null, sandbox integer not null default 0, created_at integer not null
);
create table if not exists research_items (
 id text primary key, product_id text not null, key text not null, title text not null,
 kind text not null, url text not null, parent_id text, capability text not null default '',
 status text not null default 'queued', notes text not null default '', updated_at integer not null,
 unique(product_id, key)
);
create index if not exists research_items_product on research_items(product_id, status);
create table if not exists research_evidence (
 id text primary key, item_id text not null, source text not null, summary text not null,
 url text not null, captured_at integer not null, screenshot text, data text not null
);
create index if not exists research_evidence_item on research_evidence(item_id, captured_at);
`)
// What we sent to a trial and at what scale, and how it was explored (skill, scout or manual), for Explore.
for (const c of ['data_scale', 'method']) if (!all<any>('pragma table_info(research_products)').some(x => x.name === c)) db.exec(`alter table research_products add column ${c} text not null default ''`)

export function required(value: unknown, name: string, max = 8000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be a nonempty string (at most ${max} characters).`)
  return value.trim()
}
export function cleanUrl(value: string): string {
  const u = new URL(value)
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Use an HTTP(S) URL without credentials.')
  for (const k of [...u.searchParams.keys()]) {
    if (/token|secret|password|key|auth|code|session|email/i.test(k)) throw new Error('Research URLs must not contain credentials or identity parameters.')
    if (/^utm_|^(fbclid|gclid)$/.test(k)) u.searchParams.delete(k)
  }
  u.searchParams.sort()
  return u.href
}
export function within(url: string, root: string): boolean {
  if (!root) return false
  try {
    const a = new URL(url), b = new URL(root)
    const path = b.pathname.replace(/\/$/, '')
    return a.origin === b.origin && (a.pathname === path || a.pathname.startsWith(path + '/'))
  } catch { return false }
}
export function product(id: string) {
  const p = get<ResearchProduct>('select * from research_products where id = ?', id)
  if (!p) throw new Error('No such research product.')
  return p
}
export function item(id: string) {
  const it = get<ResearchItem>('select * from research_items where id = ?', id)
  if (!it) throw new Error('No such research item.')
  return it
}
export function saveProduct(a: any) {
  const id = a.id ? required(a.id, 'id', 100) : randomUUID()
  const old = get<ResearchProduct>('select * from research_products where id = ?', id)
  const p = { ...old, ...a }
  const name = required(p.name, 'name', 200), url = cleanUrl(required(p.url, 'url'))
  const docs = p.docs_url ? cleanUrl(p.docs_url) : '', trial = p.trial_url ? cleanUrl(p.trial_url) : ''
  const scope = required(p.scope, 'scope'), context = required(p.context ?? 'Tier, role, region and workload not yet recorded.', 'context')
  const dataScale = String(p.data_scale ?? '').slice(0, 2000), method = String(p.method ?? '').slice(0, 2000)
  run(`insert into research_products (id, name, url, docs_url, trial_url, scope, context, sandbox, created_at, data_scale, method) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(id) do update set
    name=excluded.name, url=excluded.url, docs_url=excluded.docs_url, trial_url=excluded.trial_url, scope=excluded.scope, context=excluded.context, sandbox=excluded.sandbox,
    data_scale=excluded.data_scale, method=excluded.method`,
  id, name, url, docs, trial, scope, context, p.sandbox ? 1 : 0, old?.created_at ?? Date.now(), dataScale, method)
  changed(); return product(id)
}
export function saveItem(a: any) {
  const p = product(required(a.product_id, 'product_id', 100))
  const key = required(a.key, 'key', 2000)
  const old = get<ResearchItem>('select * from research_items where product_id = ? and key = ?', p.id, key)
  const v = { ...old, ...a }, id = old?.id ?? randomUUID()
  const title = required(v.title, 'title', 500), kind = v.kind ?? 'page'
  if (!['page', 'feature', 'workflow'].includes(kind)) throw new Error('kind must be page, feature or workflow.')
  const url = cleanUrl(required(v.url, 'url'))
  if (!within(url, p.url) && !within(url, p.docs_url)) throw new Error('URL is outside the product and documentation roots.')
  const parent = v.parent_id || null
  if (parent) {
    let ancestor: ResearchItem | undefined = item(parent)
    const seen = new Set([id])
    while (ancestor) {
      if (ancestor.product_id !== p.id || seen.has(ancestor.id)) throw new Error('Parent must belong to this product and must not create a cycle.')
      seen.add(ancestor.id); ancestor = ancestor.parent_id ? item(ancestor.parent_id) : undefined
    }
  }
  // Evidence is the only way to claim observed/tested/documented. A queue edit cannot manufacture proof.
  if (a.status != null && !['queued', 'blocked', 'not_found'].includes(a.status)) throw new Error('Capture evidence to mark an item documented, observed or tested.')
  const status = a.status ?? old?.status ?? 'queued'
  const notes = String(v.notes ?? '').slice(0, 8000)
  if (['blocked', 'not_found'].includes(status) && !notes.trim()) throw new Error('Explain the blocker or where you looked.')
  run(`insert into research_items values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(product_id, key) do update set
    title=excluded.title, kind=excluded.kind, url=excluded.url, parent_id=excluded.parent_id, capability=excluded.capability,
    status=excluded.status, notes=excluded.notes, updated_at=excluded.updated_at`,
  id, p.id, key, title, kind, url, parent, String(v.capability ?? '').slice(0, 200), status, notes, Date.now())
  changed(); return item(id)
}
export function evidenceFor(id: string): ResearchEvidence[] {
  return all<any>('select * from research_evidence where item_id = ? order by captured_at desc, rowid desc', id).map(e => ({ ...e, data: JSON.parse(e.data) }))
}
export function addEvidence(id: string, a: { source: ResearchEvidence['source']; summary: string; url: string; data: any; jpeg?: string }) {
  const it = item(id), p = product(it.product_id), url = cleanUrl(a.url)
  const summary = required(a.summary, 'summary')
  if (!['docs', 'product', 'sandbox'].includes(a.source)) throw new Error('source must be docs, product or sandbox.')
  if (a.source === 'docs' ? !within(url, p.docs_url) : !within(url, p.url) || within(url, p.docs_url)) throw new Error('Evidence source does not match the configured URL roots.')
  if (a.source !== 'docs' && (a.source === 'sandbox') !== !!p.sandbox) throw new Error('Sandbox evidence cannot count as real product evidence.')
  if (a.source === 'docs' && a.data.assertion) throw new Error('Documentation cannot prove a product workflow works.')
  if (a.data.assertion && (a.data.assertion.passed !== true || !a.data.assertion.expected || !a.data.steps?.length)) throw new Error('Tested evidence needs successful browser steps and a checked outcome.')
  const eid = randomUUID(), screenshot = a.jpeg ? `${eid}.jpg` : null
  if (a.jpeg) { mkdirSync(DIR, { recursive: true, mode: 0o700 }); writeFileSync(join(DIR, screenshot!), Buffer.from(a.jpeg, 'base64'), { mode: 0o600 }) }
  const status = a.data.measurement ? it.status : a.source === 'docs' ? 'documented' : a.data.assertion ? 'tested' : 'observed'
  // Visiting docs after exercising a feature must not erase the stronger evidence.
  const rank: Record<string, number> = { queued: 0, blocked: 0, not_found: 0, documented: 1, observed: 2, tested: 3 }
  db.exec('savepoint research_capture')
  try {
    run('insert into research_evidence values (?, ?, ?, ?, ?, ?, ?, ?)', eid, id, a.source, summary, url, Date.now(), screenshot, JSON.stringify(a.data))
    run('update research_items set status = ?, updated_at = ? where id = ?', rank[it.status] > rank[status] ? it.status : status, Date.now(), id)
    db.exec('release research_capture')
  } catch (e) { db.exec('rollback to research_capture; release research_capture'); throw e }
  changed(); return evidenceFor(id).find(e => e.id === eid)!
}
export function screenshotFile(eid: string): string | null {
  const e = get<{ screenshot: string | null }>('select screenshot from research_evidence where id = ?', eid)
  if (!e?.screenshot || !/^[a-f0-9-]+\.jpg$/.test(e.screenshot)) return null
  const path = join(DIR, e.screenshot)
  return existsSync(path) ? path : null
}
export function overview() {
  const products = all<ResearchProduct>('select * from research_products order by created_at, name')
  const items = all<ResearchItem>('select * from research_items order by updated_at desc, title')
  const evidence = all<any>('select id, item_id, source, summary, url, captured_at, screenshot from research_evidence order by captured_at desc, rowid desc')
  return { products, items, evidence, generated_at: Date.now() }
}
export function detail(id: string) { return { ...item(id), evidence: evidenceFor(id) } }
export function next(id: string) {
  const p = product(id)
  return { product: p, next: all<ResearchItem>("select * from research_items where product_id = ? and status = 'queued' order by rowid limit 10", id), blocked: all<ResearchItem>("select * from research_items where product_id = ? and status = 'blocked' order by rowid", id) }
}
export function seed() {
  const presets = [
    { id: 'datadog-apm', name: 'Datadog APM', url: 'https://app.datadoghq.com/', docs_url: 'https://docs.datadoghq.com/', trial_url: 'https://www.datadoghq.com/free-datadog-trial/', doc: 'https://docs.datadoghq.com/tracing/' },
    { id: 'better-stack', name: 'Better Stack', url: 'https://telemetry.betterstack.com/', docs_url: 'https://betterstack.com/docs/', trial_url: 'https://betterstack.com/telemetry', doc: 'https://betterstack.com/docs/logs/tracing/' },
    { id: 'posthog-apm', name: 'PostHog APM', url: 'https://us.posthog.com/', docs_url: 'https://posthog.com/docs/', trial_url: 'https://app.posthog.com/signup', doc: 'https://posthog.com/docs' },
    { id: 'grafana-play', name: 'Grafana Play', url: 'https://play.grafana.org/', docs_url: 'https://grafana.com/docs/', trial_url: 'https://play.grafana.org/', doc: '' },
  ]
  for (const p of presets) {
    if (!get('select 1 from research_products where id = ?', p.id)) saveProduct({ ...p, scope: p.id === 'grafana-play' ? 'Public demo: dashboard navigation, filtering, layouts and loading. No writes to shared demo.' : 'APM: setup, service discovery, trace investigation, logs correlation, dashboards and alerts.', context: p.id === 'grafana-play' ? 'Anonymous public demo; preloaded vendor data; permissions and dataset differ from paid products.' : 'Accounts pending. Public documentation only; tier, role, region and workload unverified.' })
    const ensure = (a: any) => { if (!get('select 1 from research_items where product_id = ? and key = ?', p.id, a.key)) saveItem({ product_id: p.id, ...a }) }
    if (p.doc) ensure({ key: 'docs:overview', title: 'Documentation and feature discovery', url: p.doc })
    ensure({ key: 'workflow:investigate', title: 'Investigate a slow request', kind: 'workflow', capability: 'trace-investigation', url: p.url, status: p.id === 'grafana-play' ? 'queued' : 'blocked', notes: p.id === 'grafana-play' ? 'Public demo trial; find an example with traces before asserting this workflow works.' : 'Needs a dedicated test account and seeded telemetry. Do not infer product behavior from docs.' })
    if (p.id !== 'grafana-play') for (const [capability, title] of [['onboarding', 'Onboard and see the first trace'], ['logs-correlation', 'Pivot from a trace to its logs'], ['alert-lifecycle', 'Create, trigger and recover an alert']]) ensure({ key: `workflow:${capability}`, title, kind: 'workflow', capability, url: p.url, status: 'blocked', notes: 'Needs a dedicated test account and synthetic workload.' })
  }
  return overview()
}

export function discoverLinks(productId: string, parentId: string, links: { url: string; title: string }[], limit = 30) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 60) throw new Error('Discovery limit must be 1–60.')
  const p = product(productId), parent = item(parentId)
  if (parent.product_id !== p.id) throw new Error('Parent belongs to another product.')
  const added: ResearchItem[] = []
  for (const link of links.slice(0, 1000)) {
    if (added.length >= Math.min(Math.max(limit, 1), 60)) break
    try {
      const url = cleanUrl(link.url), u = new URL(url)
      // A bounded frontier: discard in-page anchors, session variants and action endpoints.
      if (u.hash || u.search || /\/(logout|signout|login|signup|delete|remove|unsubscribe|checkout)(\/|$)/i.test(u.pathname)) continue
      if (!within(url, p.url) && !within(url, p.docs_url)) continue
      if (all('select id from research_items where product_id = ? and url = ?', p.id, url).length) continue
      added.push(saveItem({ product_id: p.id, key: `url:${url}`, title: link.title.trim().slice(0, 500) || u.pathname, url, parent_id: parent.id }))
    } catch { /* malformed or secret-bearing links never enter the queue */ }
  }
  return added
}

export function summarizeSamples(samples: { ready_ms?: number; error?: string }[]) {
  const values = samples.filter(s => !s.error && Number.isFinite(s.ready_ms)).map(s => s.ready_ms!).sort((a, b) => a - b)
  const n = values.length
  return { attempts: samples.length, successes: n, failures: samples.length - n, median_ms: n ? (values[Math.floor((n - 1) / 2)] + values[Math.ceil((n - 1) / 2)]) / 2 : null, min_ms: n ? values[0] : null, max_ms: n ? values[n - 1] : null }
}
