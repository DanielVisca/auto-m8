// The product overlay: PostHog usage, errors and latency drawn onto the page in an agent browser window.
// Turn it on per window (live view button, POST /api/browser/:owner/overlay, or the browser tool's
// action=overlay). The page script (overlaypage.ts) draws; this side picks the PostHog project for the
// site, queries it with the user's PostHog session from the Agent Chrome, and answers the page's requests
// (an element's details, an investigation) by polling it, since an isolated world can't call out.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import * as B from './browser.ts'
import { OVERLAY_SCRIPT, OVERLAY_VERSION } from './overlaypage.ts'
import { DATA_DIR } from './settings.ts'
import * as I from './overlayinsights.ts'
export { describeLeaf, mergeFriction } from './overlayinsights.ts'

const PH = process.env.PERCH_POSTHOG_HOST ?? 'https://us.posthog.com'
const MAP_FILE = join(DATA_DIR, 'overlay-projects.json')
const POLL_MS = 700
const STATS_TTL = 5 * 60_000

type Item = { key: string; type: string; count: number; tag: string; text?: string; attr?: string; scope?: string; id?: string; href?: string; aria?: string; placeholder?: string; cls?: string; parentCls?: string; bem?: string; pbem?: string; label: string; match: string
  // counted with overlayinsights' normalised identity (badges and card agree exactly)
  norm?: I.Norm; clicks?: number; rage?: number; dead?: number; people?: number; orgs?: number
  // precomputed with the badges so a card opens with them at once
  hours?: [number, number][]; topOrgs?: { key: string; name: string; url: string }[]; topPeople?: { id: string; url: string }[] }
type Click = { key: string; at: number }
type State = { owner: string; on: boolean; timer?: NodeJS.Timeout; path: string; project?: number; cohort: I.Cohort; loadKey?: string; lastFreshCheck?: number; items: Item[]; adhoc: Map<string, Item>; clicks: Click[]; busy: boolean; error?: string; mode: string }
const states = new Map<string, State>()
// While the overlay is on it polls the page, so the window must not be frozen as idle.
B.keepAwakeChecks.add(owner => !!states.get(owner)?.on)

// ---------- PostHog API with the Agent profile's session ----------
export async function ph(path: string, init: { method?: string; body?: any } = {}) {
  const url = PH + path
  const { cookie, userAgent } = await B.cookiesFor(url)
  if (!cookie) throw new Error(`Not signed in to ${PH} in the Agent Chrome. Open it in an auto-m8 browser window and sign in once.`)
  const method = init.method ?? 'GET'
  const r = await fetch(url, { method, signal: AbortSignal.timeout(60_000), body: init.body ? JSON.stringify(init.body) : undefined,
    headers: { 'User-Agent': userAgent, Accept: 'application/json', 'Content-Type': 'application/json', Cookie: cookie, ...B.csrfHeaders(method, url, cookie) } })
  const text = await r.text()
  if (!r.ok) throw new Error(`PostHog ${r.status} on ${path.split('?')[0]}: ${text.slice(0, 200)}`)
  return JSON.parse(text)
}
// PostHog caps concurrent queries per user (503 clickhouse_at_capacity, 429): keep 4 in flight
// and retry the busy answers with backoff.
const MAX_INFLIGHT = 4
let inflight = 0
const waitingHi: (() => void)[] = [], waiting: (() => void)[] = []
// hi: something you just clicked (an inspect card) goes ahead of panels and background refreshes.
async function slot<T>(f: () => Promise<T>, hi = false): Promise<T> {
  if (inflight >= MAX_INFLIGHT) await new Promise<void>(r => (hi ? waitingHi : waiting).push(r))
  inflight++
  try { return await f() } finally { inflight--; (waitingHi.shift() ?? waiting.shift())?.() }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function hogql(project: number, query: string, values: Record<string, any> = {}, hi = false) {
  for (let attempt = 0; ; attempt++) {
    try {
      const t0 = Date.now()
      let started = 0
      const r = await slot(() => { started = Date.now(); return ph(`/api/environments/${project}/query/`, { method: 'POST', body: { query: { kind: 'HogQLQuery', query, values }, name: 'perch product overlay' } }) }, hi)
      const ran = Date.now() - started, queued = started - t0
      if (ran > 4000 || queued > 4000) console.log(`[overlay] slow query ran ${ran}ms after ${queued}ms queued${hi ? ' (card)' : ''}: ${query.replace(/\s+/g, ' ').slice(0, 140)}`)
      return (r.results ?? []) as any[][]
    } catch (e: any) {
      console.log(`[overlay] query failed (attempt ${attempt + 1}): ${String(e.message).slice(0, 160)} :: ${query.replace(/\s+/g, ' ').slice(0, 100)}`)
      if (attempt < 3 && /PostHog (503|429|502)/.test(e.message)) { await sleep(1500 * 2 ** attempt); continue }
      throw e
    }
  }
}

// ---------- which project holds a site's data ----------
const readMap = (): Record<string, number> => { try { return existsSync(MAP_FILE) ? JSON.parse(readFileSync(MAP_FILE, 'utf8')) : {} } catch { return {} } }
export function setProjectFor(host: string, project: number) { const m = readMap(); m[host] = project; writeFileSync(MAP_FILE, JSON.stringify(m, null, 1)); memCache.clear() }
let projectsCache: { at: number; list: { id: number; name: string; app_urls: string[] }[] } | null = null
export async function projectFor(host: string): Promise<number> {
  const m = readMap()
  if (m[host]) return m[host]
  // PostHog's own app and website: its product analytics live in project 2.
  if (/(^|\.)posthog\.com$/.test(host)) return 2
  if (!projectsCache || Date.now() - projectsCache.at > 3600_000) {
    const r = await ph('/api/projects/?limit=200')
    projectsCache = { at: Date.now(), list: (r.results ?? []).map((p: any) => ({ id: p.id, name: p.name, app_urls: p.app_urls ?? [] })) }
  }
  const hit = projectsCache.list.find(p => p.app_urls.some(u => { try { return new URL(u).hostname === host } catch { return false } }))
  if (hit) return hit.id
  throw new Error(`No PostHog project lists ${host} in its app URLs. Set one with the browser tool: action=overlay value=on host=${host} project=<id>.`)
}

// /project/123/logs → ^/project/[^/]+/logs/?$ : ids, uuids and long tokens become wildcards.
export function pathPattern(pathname: string) {
  const seg = (s: string) => /^\d+$/.test(s) || /^[0-9a-f-]{16,}$/i.test(s) || (s.length >= 20 && /\d/.test(s)) ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = pathname.replace(/\/+$/, '').split('/').map((s, i) => i === 0 ? '' : seg(s))
  return `^${parts.join('/') || ''}/?$`
}

// ---------- element stats → items the page can match ----------
export function toItems(rows: any[]): Item[] {
  const out: Item[] = []
  for (const r of rows) {
    const chain = r.elements ?? [], leaf = chain[0]
    if (!leaf?.tag_name) continue
    const a = leaf.attributes ?? {}
    const attr = a['attr__data-attr'] || undefined
    const scope = attr ? undefined : chain.slice(1).find((e: any) => e.attributes?.['attr__data-attr'])?.attributes['attr__data-attr']
    const text = leaf.text ? String(leaf.text).replace(/\s+/g, ' ').trim().slice(0, 400) : undefined
    const aria = a['attr__aria-label'] || undefined
    const href = leaf.href || undefined
    const id = leaf.attr_id || undefined
    if (!attr && !id && !text && !aria && !href) continue // nothing stable to find it by
    const match = attr ? `[data-attr="${attr}"]` : id ? `#${id}` : `${scope ? `[data-attr="${scope}"] ` : ''}${leaf.tag_name}${text ? ` "${text.slice(0, 40)}"` : ''}${aria ? ` [aria-label="${aria}"]` : ''}${href ? ` [href="${href}"]` : ''}`
    out.push({ key: match, type: r.type, count: r.count, tag: leaf.tag_name, text, attr, scope, id, href, aria, label: text || aria || attr || id || href || leaf.tag_name, match })
  }
  return out
}

const PAGE_FILTER = I.PAGE_FILTER
// Badges come from HogQL over the last 24 hours (overlayinsights.elementRows), the same window the panel
// and cards use. The old elements stats endpoint could only count whole days and isn't used any more.

// ---------- responsiveness: show the last known numbers at once, refresh behind them ----------
// Every page's results are kept on disk (survives restarts). Opening a page draws them immediately,
// labelled with their age, while fresh ones load; identical loads share one flight. Badges count
// whole days so they go stale slowly; the panel and pins are refreshed every couple of minutes.
const ITEMS_TTL = 10 * 60_000, SUMMARY_TTL = 2 * 60_000, DETAIL_TTL = 10 * 60_000
const CACHE_DIR = join(DATA_DIR, 'overlay-cache')
mkdirSync(CACHE_DIR, { recursive: true })
const memCache = new Map<string, { at: number; v: any }>()
const cacheFile = (k: string) => join(CACHE_DIR, createHash('sha1').update(k).digest('hex').slice(0, 20) + '.json')
function cacheGet(k: string) {
  const m = memCache.get(k)
  if (m) return m
  try { const e = JSON.parse(readFileSync(cacheFile(k), 'utf8')); if (e?.at) { memCache.set(k, e); return e as { at: number; v: any } } } catch {}
  return null
}
function cachePut(k: string, v: any, disk = true) {
  const e = { at: Date.now(), v }
  memCache.set(k, e)
  if (disk) writeFile(cacheFile(k), JSON.stringify(e)).catch(() => {})
}
const flights = new Map<string, Promise<any>>()
function once<T>(k: string, f: () => Promise<T>): Promise<T> {
  const have = flights.get(k)
  if (have) return have
  const p = f().finally(() => flights.delete(k))
  flights.set(k, p)
  return p
}

async function fetchItems(project: number, path: string, cohort: I.Cohort, pass: 'counts' | 'people' = 'counts') {
  return normItems(await I.elementRows((q, v) => hogql(project, q, v), path, await unitFor(project), cohort, pass))
}
// people and customer counts onto badges that have their click counts
export function withPeople(items: Item[], people: Item[]) {
  const by = new Map(people.map(p => [p.key, p]))
  return items.map(it => { const p = by.get(it.key); return p ? { ...it, people: p.people, orgs: p.orgs, topOrgs: p.topOrgs, topPeople: p.topPeople } : it })
}
// One badge per clicked control. Nothing stable to find it by (a bare div): no badge.
export function normItems(rows: { norm: I.Norm; clicks: number; rage: number; dead: number; people: number; orgs: number; hours?: [number, number][] }[]): Item[] {
  const out: Item[] = []
  for (const r of rows) {
    const n = r.norm
    if (!n.tag || (!n.attr && !n.id && !n.text && !n.aria && !n.href && !n.bem)) continue
    const text = n.text ? n.text.replace(/\s+/g, ' ').trim().slice(0, 400) : undefined
    const match = n.attr ? `[data-attr="${n.attr}"]` : n.id ? `#${n.id}` : `${n.scope ? `[data-attr="${n.scope}"] ` : ''}${n.tag}${n.pbem ? '.' + n.pbem + ' > ' : ''}${n.bem ? '.' + n.bem : ''}${text ? ` "${text.slice(0, 40)}"` : ''}${n.aria ? ` [aria-label="${n.aria}"]` : ''}${n.href ? ` [href="${n.href}"]` : ''}`
    out.push({ key: Object.values(n).join('|'), type: 'norm', count: r.clicks, tag: n.tag, text, attr: n.attr || undefined, scope: n.scope || undefined, id: n.id || undefined,
      href: n.href || undefined, aria: n.aria || undefined, bem: n.bem || undefined, pbem: n.pbem || undefined, label: text || n.aria || n.attr || n.id || n.href || n.bem || n.tag, match,
      norm: n, clicks: r.clicks, rage: r.rage, dead: r.dead, people: r.people, orgs: r.orgs, hours: r.hours })
  }
  return out
}
// Fresh panel numbers in the background. With nothing cached, partial results are pushed as they land;
// with a cached view on screen, it stays until the complete new one replaces it.
function refreshSummary(st: State, s: B.Session, key: string, project: number, path: string, cohort: I.Cohort, hasCached: boolean) {
  const send = (sum: any, meta: any) => { if (st.loadKey === key) B.evalIn(s, `__perchOverlay.summary(${js(sum)}, ${js({ ...meta, path })})`).catch(() => {}) }
  if (hasCached) send(null, { refreshing: true })
  return once(`summary ${key}`, async () => I.pageSummary((q, v) => hogql(project, q, v), project, PH, path, await unitFor(project), cohort,
      hasCached ? undefined : partial => send(partial, { at: Date.now(), refreshing: true })))
    .then(sum => { if (!sum.missing.length) cachePut(`summary ${key}`, sum); send(sum, { at: Date.now(), refreshing: false }) },
      (e: any) => send({ failed: e.message }, { at: Date.now(), refreshing: false }))
}
function refreshItems(st: State, s: B.Session, key: string, project: number, path: string, cohort: I.Cohort) {
  const show = (items: Item[]) => { if (st.loadKey !== key) return; st.items = items; return B.evalIn(s, `__perchOverlay.items(${js(items)}, ${js(Date.now())})`) }
  return once(`items8 ${key}`, async () => {
    // clicks first (fast), then people and customers onto the same badges
    const counts = await fetchItems(project, path, cohort, 'counts')
    await show(counts)
    const unit = await unitFor(project)
    const peopleRows: { norm: I.Norm; people: number; orgs: number; clicks: number; rage: number; dead: number; topOrgs?: string[]; topPeople?: { who: string; did: string }[] }[] =
      await I.elementRows((q, v) => hogql(project, q, v), path, unit, cohort, 'people').catch(() => null as any)
    // people failed: show the click counts, but don't cache them as complete (the next refresh retries)
    if (!peopleRows) { await show(counts); return counts }
    const names = await I.orgNames((q, v) => hogql(project, q, v), unit, [...new Set(peopleRows.flatMap(r => r.topOrgs ?? []))]).catch(() => new Map<string, string>())
    const rowOf = new Map(peopleRows.map(r => [Object.values(r.norm).join('|'), r])) // same key as normItems
    const people = normItems(peopleRows).map(it => { const r = rowOf.get(it.key); return { ...it,
      // only teams we could name: an id fragment tells you nothing
      topOrgs: (r?.topOrgs ?? []).filter(k => names.get(k)).map(k => ({ key: k, name: names.get(k)!, url: `${PH}/project/${project}/groups/${unit.index}/${encodeURIComponent(k)}` })),
      topPeople: (r?.topPeople ?? []).map(p => ({ id: p.who === p.did ? 'user without an email' : p.who, url: `${PH}/project/${project}/person/${encodeURIComponent(p.did)}` })) } })
    const full = withPeople(counts, people)
    cachePut(`items8 ${key}`, full)
    await show(full)
    return full
  })
}

// Who the customer is in this project: organizations (or companies, accounts, teams) when it has
// that group type, else people.
const unitCache = new Map<number, I.Unit>()
async function unitFor(project: number): Promise<I.Unit> {
  const hit = unitCache.get(project)
  if (hit) return hit
  let u: I.Unit = { index: null, label: 'people', singular: 'person' }
  try {
    const r: any = await ph(`/api/projects/${project}/groups_types/`)
    const list: any[] = Array.isArray(r) ? r : r.results ?? []
    const g = ['organization', 'company', 'account', 'team', 'workspace'].map(t => list.find(x => x.group_type === t)).find(Boolean)
    if (g) u = { index: g.group_type_index, label: g.name_plural || `${g.group_type}s`, singular: g.name_singular || g.group_type }
  } catch {}
  unitCache.set(project, u)
  return u
}

// ---------- one element in depth ----------
function elementFilter(it: Item) {
  if (it.norm) return I.normFilter(it.norm)
  const parts: string[] = [], values: Record<string, any> = {}
  if (it.attr) { parts.push(`elements_chain ILIKE {attrLike}`); values.attrLike = `%attr__data-attr="${it.attr}"%` }
  if (it.id) { parts.push(`elements_chain ILIKE {idLike}`); values.idLike = `%attr_id="${it.id}"%` }
  if (it.scope) { parts.push(`elements_chain ILIKE {scopeLike}`); values.scopeLike = `%attr__data-attr="${it.scope}"%` }
  if (it.text) { parts.push(`has(elements_chain_texts, {text})`); values.text = it.text }
  if (it.placeholder) { parts.push(`elements_chain ILIKE {phLike}`); values.phLike = `%attr__placeholder="${it.placeholder}"%` }
  if (it.aria && !it.attr && !it.id) { parts.push(`elements_chain ILIKE {ariaLike}`); values.ariaLike = `%attr__aria-label="${it.aria}"%` }
  if (it.href) { parts.push(`elements_chain ILIKE {hrefLike}`); values.hrefLike = `%href="${it.href}"%` }
  if (it.cls) { parts.push(`splitByChar(';', elements_chain)[1] LIKE {leafLike}`); values.leafLike = `${it.tag}.%${it.cls}%` }
  else if (!it.attr && !it.id) { parts.push(`startsWith(elements_chain, {tag})`); values.tag = it.tag }
  if (it.parentCls) { parts.push(`elements_chain LIKE {parentLike}`); values.parentLike = `%${it.parentCls}%` }
  return { sql: parts.join(' AND '), values }
}
// emit: push partial cards to the page as sections land. hi=false: a background prefetch (pins, hover).
async function detail(st: State, s: B.Session, key: string, keys?: string[], opts: { emit?: (d: any) => void; hi?: boolean } = {}) {
  const it = st.items.find(i => i.key === key) ?? st.adhoc.get(key)
  if (!it || !st.project) return { error: 'This element is no longer in the stats; reload the overlay.' }
  const project = st.project
  // every identity the badge sums (see normFilterAny)
  const all = [...new Set([key, ...(keys ?? [])])].map(k => st.items.find(i => i.key === k)).filter((i): i is Item => !!i?.norm)
  const filter = all.length > 1 ? I.normFilterAny(all.map(i => i.norm!)) : elementFilter(it)
  const ck = `detail ${project} ${st.path} ${st.cohort} ${all.map(i => i.key).sort().join('+') || key}`, hit = cacheGet(ck)
  const unit = await unitFor(project)
  const d = hit && Date.now() - hit.at < DETAIL_TTL ? hit.v
    : await once(ck, () => I.elementInsights((q, v) => hogql(project, q, v, opts.hi !== false), project, PH, st.path, unit, st.cohort, filter, it.norm,
        opts.emit ? partial => opts.emit!({ ...partial, live: liveFor(st, s, key) }) : undefined))
  if (!hit || hit.v !== d) cachePut(ck, d, false)
  return { ...d, live: liveFor(st, s, key) }
}

// ---------- live latency from this window's network ----------
const isApi = (n: any) => n.type === 'XHR' || n.type === 'Fetch'
const pct = (xs: number[], p: number) => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))] }
function liveSummary(s: B.Session, st?: State) {
  const done = s.net.filter(n => isApi(n) && n.ms != null)
  const ms = done.map(n => n.ms!)
  // Per element you clicked: its slowest request in the 3s after, and whether any failed. Drawn on it.
  const byKey: Record<string, { ms: number; failed: boolean }> = {}
  for (const c of st?.clicks ?? []) {
    for (const n of done) if (n.at >= c.at && n.at <= c.at + 3000) {
      const k = byKey[c.key] ?? (byKey[c.key] = { ms: 0, failed: false })
      k.ms = Math.max(k.ms, n.ms!); k.failed ||= !!n.failed || (n.status ?? 0) >= 400
    }
  }
  return { count: done.length, p50: pct(ms, 0.5), p95: pct(ms, 0.95), failed: done.filter(n => n.failed || (n.status ?? 0) >= 400).length, byKey }
}
// Requests the page made in the 3s after each of your clicks on this element.
function liveFor(st: State, s: B.Session, key: string) {
  const at = st.clicks.filter(c => c.key === key).map(c => c.at)
  return s.net.filter(n => isApi(n) && at.some(t => n.at >= t && n.at <= t + 3000)).slice(-12).reverse()
    .map(n => { let path = n.url; try { const u = new URL(n.url); path = u.pathname } catch {} ; return { method: n.method, path, status: n.status, ms: n.ms, failed: n.failed, logs: n.rid && st.project ? I.logsUrl(PH, st.project, [n.rid], '-1h') : null } })
}

// ---------- investigate: a new perch chat seeded with everything the card knows ----------
async function investigate(st: State, s: B.Session, key: string, keys?: string[]) {
  const it = (st.items.find(i => i.key === key) ?? st.adhoc.get(key))!
  const d: any = await detail(st, s, key, keys)
  const prompt = [
    `Investigate this element of a live product, using the PostHog MCP (project ${st.project}) and the code if you can find it.`,
    ``, `Page: ${s.url}`, `Element: ${it.match} (label "${it.label}")`, `Page path pattern: ${st.path}`,
    ``, `What the auto-m8 product overlay saw in the last 24 hours:`,
    st.cohort === 'new' ? `- Narrowed to ${d.unit} new to this page in the last 7 days (the rollout view).` : '',
    `- ${d.clicks} clicks from ${d.people} people in ${d.orgs} ${d.unit} (a week earlier: ${d.prevOrgs} ${d.unit}, ${d.prevClicks} clicks), ${d.rage} rage clicks, ${d.dead} dead clicks`,
    `- errors within 10s after a click on it: ${d.errors?.length ? d.errors.map((e: any) => `${e.type}: ${e.value} (${e.count}×, ${e.orgs} ${d.unit}${e.noise ? ', likely noise' : ''})`).join('; ') : 'none'}`,
    `- replays worth watching: ${d.sessions?.map((x: any) => `${x.url}${x.why?.length ? ` (${x.why.join(', ')})` : ''}`).join(' ') || 'none'}`,
    `- heaviest users: ${[...(d.power?.orgs ?? []).map((o: any) => `${o.name} (${o.clicks})`), ...(d.power?.people ?? []).map((p: any) => `${p.email} (${p.clicks})`)].join(', ') || 'none'}`,
    `- live requests after the user's clicks in the browser: ${d.live?.length ? d.live.map((r: any) => `${r.method} ${r.path} ${r.status ?? r.failed} ${r.ms}ms`).join('; ') : 'none'}`,
    ``, `Re-derive these numbers yourself before concluding (they come from a quick element match, which can be off). Find out whether something is broken or slow for users here, why, and what the fix is. Watch a replay or two if they help. If you find a real bug, fix it in a PR.`,
  ].join('\n')
  const port = process.env.PERCH_PORT ?? 4777
  const r = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` }, body: JSON.stringify({ prompt, noRoute: true, by: 'you' }) })
  if (!r.ok) throw new Error(`auto-m8 ${r.status}`)
  return ((await r.json()) as any).id as string
}

// ---------- the loop ----------
const js = (v: any) => JSON.stringify(v)
const TAKE = `globalThis.__perchOverlay ? __perchOverlay.take() : null`
async function ensureInjected(s: B.Session) {
  // Cheap poll; the script itself only goes over when a new document lost it, or perch was updated
  // since this page got its copy (then the old one is removed and the new one put in).
  const t = await B.evalIn(s, TAKE)
  if (t && t.version === OVERLAY_VERSION) return t
  if (t) await B.evalIn(s, `globalThis.__perchOverlay && __perchOverlay.remove()`)
  return B.evalIn(s, `(${OVERLAY_SCRIPT}, ${TAKE})`)
}
async function load(st: State, s: B.Session, pathname: string) {
  st.path = pathPattern(pathname)
  const project = st.project = await projectFor(new URL(s.url).hostname)
  const path = st.path, cohort = st.cohort, unit = await unitFor(project)
  const key = st.loadKey = `${project} ${path} ${cohort}`
  st.lastFreshCheck = Date.now()
  const ci = cacheGet(`items8 ${key}`), cs = cacheGet(`summary ${key}`)
  // Draw whatever we know right now (cached badges and panel, labelled with their age)...
  st.items = ci?.v ?? []
  await B.evalIn(s, `__perchOverlay.load(${js({ items: st.items, itemsAt: ci?.at ?? null, summary: cs?.v ?? null, summaryAt: cs?.at ?? null, live: liveSummary(s, st), project, path, cohort, unit: unit.label })})`)
  // ...then bring in what's stale, panel and badges in parallel.
  if (!cs || Date.now() - cs.at > SUMMARY_TTL) refreshSummary(st, s, key, project, path, cohort, !!cs)
  if (!ci || Date.now() - ci.at > ITEMS_TTL) {
    // badges are pushed to the page as each pass lands; nothing here waits for them
    refreshItems(st, s, key, project, path, cohort).catch(() => {})
  }
}
// While the overlay stays on a page, keep it fresh in the background.
function keepFresh(st: State, s: B.Session) {
  if (!st.loadKey || !st.project || Date.now() - (st.lastFreshCheck ?? 0) < 30_000) return
  st.lastFreshCheck = Date.now()
  const key = st.loadKey, cs = cacheGet(`summary ${key}`), ci = cacheGet(`items8 ${key}`)
  if (cs && Date.now() - cs.at > SUMMARY_TTL && !flights.has(`summary ${key}`)) refreshSummary(st, s, key, st.project, st.path, st.cohort, true)
  if (ci && Date.now() - ci.at > ITEMS_TTL && !flights.has(`items8 ${key}`)) refreshItems(st, s, key, st.project, st.path, st.cohort).catch(() => {})
}
async function poll(st: State) {
  if (!st.on || st.busy) return
  st.busy = true
  try {
    const s = B.sessions.get(st.owner)
    if (!s) { stop(st.owner); return }
    const t = await ensureInjected(s)
    if (!t) return
    st.mode = t.mode
    if (pathPattern(t.path) !== st.path || !t.loaded) {
      try { st.error = undefined; await load(st, s, t.path) } catch (e: any) { st.error = e.message; await B.evalIn(s, `__perchOverlay.load(${js({ items: [], summary: { failed: e.message }, project: '?', path: '' })})`) }
    } else { await B.evalIn(s, `__perchOverlay.live(${js(liveSummary(s, st))})`); keepFresh(st, s) }
    for (const q of t.requests ?? []) {
      if (q.type === 'cohort' && (q.value === 'all' || q.value === 'new') && q.value !== st.cohort) { st.cohort = q.value; st.adhoc.clear(); try { await load(st, s, t.path) } catch (e: any) { st.error = e.message } }
      if (q.type === 'click') { st.clicks.push({ key: q.key, at: q.at }); if (st.clicks.length > 200) st.clicks.splice(0, 100) }
      if (q.type === 'detail' && q.adhoc) st.adhoc.set(q.key, { type: '$autocapture', count: 0, ...q.adhoc })
      if (q.type === 'prefetch') detail(st, s, q.key, q.keys, { hi: false }).catch(() => {})
      if (q.type === 'detail') detail(st, s, q.key, q.keys, { emit: d => { B.evalIn(s, `__perchOverlay.detail(${js(q.key)}, ${js(d)})`).catch(() => {}) } }).catch((e: any) => ({ error: e.message })).then(d => B.evalIn(s, `__perchOverlay.detail(${js(q.key)}, ${js(d)})`).catch(() => {}))
      if (q.type === 'investigate') investigate(st, s, q.key, q.keys).then(id => B.evalIn(s, `__perchOverlay.investigated(${js(q.key)}, true, ${js(id)})`), (e: any) => B.evalIn(s, `__perchOverlay.investigated(${js(q.key)}, false, ${js(e.message)})`)).catch(() => {})
    }
  } catch { /* the page navigated mid-poll; the next tick re-injects */ }
  finally { st.busy = false }
}

export function overlayState(owner: string) {
  const st = states.get(owner)
  return { on: !!st?.on, mode: st?.mode ?? 'off', cohort: st?.cohort ?? 'all', project: st?.project ?? null, path: st?.path ?? '', elements: st?.items.length ?? 0, error: st?.error ?? null }
}
export async function start(owner: string, opts: { mode?: string; host?: string; project?: number; cohort?: I.Cohort } = {}) {
  const s = await B.session(owner, false)
  if (!s) throw new Error('No browser window for this conversation: open a page first.')
  if (opts.project) setProjectFor(opts.host || new URL(s.url).hostname, opts.project)
  let st = states.get(owner)
  if (!st) { st = { owner, on: true, path: '', cohort: 'all', items: [], adhoc: new Map(), clicks: [], busy: false, mode: 'ambient' }; states.set(owner, st) }
  st.on = true
  if (opts.project) st.items = []
  if (opts.cohort && opts.cohort !== st.cohort) { st.cohort = opts.cohort; st.path = '' }
  if (!st.timer) st.timer = setInterval(() => poll(st!), POLL_MS)
  await poll(st)
  if (opts.mode) await B.evalIn(s, `__perchOverlay.setMode(${js(opts.mode)})`).catch(() => {})
  return overlayState(owner)
}
export async function stop(owner: string) {
  const st = states.get(owner)
  if (st?.timer) clearInterval(st.timer)
  states.delete(owner)
  const s = B.sessions.get(owner)
  if (s) await B.evalIn(s, `globalThis.__perchOverlay && __perchOverlay.remove()`).catch(() => {})
  return overlayState(owner)
}
