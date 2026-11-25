// Writing → Published: pages you put on a docs/blog site that lives in a GitHub repo (default
// PostHog/posthog.com), with their views from PostHog. Found on its own: content files your merged
// PRs added, plus posts that name you as author. Views come from $pageview on that site's host.
//   PERCH_PUBLISHED_REPO     owner/name of the site repo          (PostHog/posthog.com)
//   PERCH_PUBLISHED_HOST     the site's $host in PostHog           (posthog.com)
//   PERCH_PUBLISHED_PROJECT  PostHog project holding its pageviews (your auto-m8 project)
import { ghExec } from './gh.ts'
import { posthogFetch } from './indexer.ts'
import { settings } from './settings.ts'
import { swr } from './swr.ts'

const REPO = () => process.env.PERCH_PUBLISHED_REPO || 'PostHog/posthog.com'
const HOST = () => process.env.PERCH_PUBLISHED_HOST || 'posthog.com'
const PROJECT = () => Number(process.env.PERCH_PUBLISHED_PROJECT) || settings.posthog.projectId

export type Page = { file: string; path: string; url: string; title: string; kind: 'article' | 'docs' | 'page'; byline: boolean; pr: number | null; published_at: number | null }

// contents/docs/metrics/index.mdx → /docs/metrics; contents/product-engineers/x.md → /product-engineers/x
export function urlPath(file: string) {
  return file.replace(/^contents/, '').replace(/\.mdx?$/, '').replace(/\/index$/, '') || '/'
}
// Content pages only: not snippets, partials or team pages.
export const isPage = (file: string) => /^contents\/.+\.mdx?$/.test(file) && !/\/_|^contents\/(teams|handbook\/company\/team)\//.test(file)
export const kindOf = (file: string): Page['kind'] => /^contents\/docs\//.test(file) ? 'docs' : /^contents\/(blog|product-engineers|founders|newsletter|tutorials|spotlight)\//.test(file) ? 'article' : 'page'
export function frontTitle(text: string) {
  const fm = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
  const t = fm.match(/^title:\s*(.+)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2')
  return t || text.match(/^#\s+(.+)$/m)?.[1]?.trim() || ''
}

const gh = async (args: string[]) => (await ghExec(args, { maxBuffer: 20e6, timeout: 30_000 })).stdout
const raw = async (file: string) => { try { return await gh(['api', `repos/${REPO()}/contents/${file}`, '-H', 'Accept: application/vnd.github.raw']) } catch { return null } }

async function discover(): Promise<{ login: string; handle: string | null; pages: Page[] }> {
  const me = JSON.parse(await gh(['api', 'user']))
  const prs: { number: number; mergedAt: string }[] = JSON.parse(await gh(['pr', 'list', '-R', REPO(), '--author', me.login, '--state', 'merged', '--limit', '300', '--json', 'number,mergedAt']))
  const added = new Map<string, { pr: number; at: number }>()
  for (const pr of prs) {
    let files: { filename: string; status: string }[] = []
    try { files = JSON.parse(await gh(['api', `repos/${REPO()}/pulls/${pr.number}/files?per_page=100`])) } catch { continue }
    for (const f of files) if (f.status === 'added' && isPage(f.filename)) {
      const at = Date.parse(pr.mergedAt), had = added.get(f.filename)
      if (!had || at < had.at) added.set(f.filename, { pr: pr.number, at })
    }
  }
  // Bylines: the site's authors list maps your name to a handle that posts put in `author:`.
  let handle: string | null = null
  const bylined = new Set<string>()
  try {
    const authors = JSON.parse((await raw('src/data/authors.json')) ?? '[]')
    handle = (Array.isArray(authors) ? authors : []).find((a: any) => me.name && a.name?.toLowerCase() === String(me.name).toLowerCase())?.handle ?? null
    if (handle) for (const p of JSON.parse(await gh(['search', 'code', handle, '--repo', REPO(), '--limit', '100', '--json', 'path'])) as { path: string }[]) if (isPage(p.path)) bylined.add(p.path)
  } catch {}
  const pages: Page[] = []
  for (const file of new Set([...added.keys(), ...bylined])) {
    const text = await raw(file)
    if (text == null) continue // moved or deleted since
    const byline = !!handle && new RegExp(`^\\s*-?\\s*${handle}\\s*$|author:.*\\b${handle}\\b`, 'm').test(text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '')
    if (!added.has(file) && !byline) continue
    const path = urlPath(file)
    pages.push({ file, path, url: `https://${HOST()}${path}`, title: frontTitle(text) || path, kind: byline ? 'article' : kindOf(file), byline, pr: added.get(file)?.pr ?? null, published_at: added.get(file)?.at ?? null })
  }
  return { login: me.login, handle, pages }
}

const hogql = async (query: string) => ((await posthogFetch(`/api/projects/${PROJECT()}/query/`, { method: 'POST', body: JSON.stringify({ query: { kind: 'HogQLQuery', query }, name: 'auto-m8-writing-published' }) })) as any)?.results ?? []
const sqlList = (xs: string[]) => xs.map(x => `'${x.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(', ')

type PageViews = { weekly: number[]; views30: number; visitors30: number; reads30: number; leaves30: number; total: number }
async function views(paths: string[]) {
  if (!paths.length) return { weeks: [] as number[], byPath: {} as Record<string, PageViews>, summary: { views: 0, visitors: 0, reads: 0, leaves: 0 } }
  const norm = `if(length(properties.$pathname) > 1, replaceRegexpOne(properties.$pathname, '/+$', ''), properties.$pathname)`
  const where = `event = '$pageview' AND properties.$host = '${HOST().replace(/'/g, '')}' AND ${norm} IN (${sqlList(paths)})`
  // A read: the visit ended ($pageleave) after scrolling through at least 60% of the page's content
  // and staying 30 seconds or more. Visits with no $pageleave (tab killed, app closed) can't count.
  const leaveWhere = where.replace("event = '$pageview'", "event = '$pageleave'")
  const read = `toFloat(properties.$prev_pageview_max_content_percentage) >= 0.6 AND toFloat(properties.$prev_pageview_duration) >= 30`
  const [weekly, recent, reads, total] = await Promise.all([
    hogql(`SELECT ${norm} AS p, toStartOfWeek(timestamp) AS w, count() FROM events WHERE ${where} AND timestamp > now() - interval 26 week GROUP BY p, w ORDER BY w LIMIT 10000`),
    hogql(`SELECT ${norm} AS p, count(), count(DISTINCT person_id) FROM events WHERE ${where} AND timestamp > now() - interval 30 day GROUP BY p LIMIT 10000`),
    hogql(`SELECT ${norm} AS p, count(), countIf(${read}) FROM events WHERE ${leaveWhere} AND timestamp > now() - interval 30 day GROUP BY p LIMIT 10000`),
    hogql(`SELECT countIf(event = '$pageview'), count(DISTINCT if(event = '$pageview', person_id, NULL)), countIf(event = '$pageleave'), countIf(event = '$pageleave' AND ${read}) FROM events WHERE (${where} OR ${leaveWhere}) AND timestamp > now() - interval 30 day`),
  ])
  const start = Date.now() - 26 * 7 * 86400_000
  const weeks: number[] = []
  for (let t = start; t <= Date.now(); t += 7 * 86400_000) { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); weeks.push(d.getTime()) }
  const byPath: Record<string, PageViews> = {}
  for (const p of paths) byPath[p] = { weekly: weeks.map(() => 0), views30: 0, visitors30: 0, reads30: 0, leaves30: 0, total: 0 }
  for (const [p, w, n] of weekly as [string, string, number][]) {
    // Nearest bucket, so a project timezone or week-start mode a day off still lands in the right week.
    const t = Date.parse(String(w).length <= 10 ? `${w}T00:00:00Z` : String(w)), i = Math.round((t - weeks[0]) / (7 * 86400_000))
    if (byPath[p]) { if (i >= 0 && i < weeks.length) byPath[p].weekly[i] += n; byPath[p].total += n }
  }
  for (const [p, n, u] of recent as [string, number, number][]) if (byPath[p]) { byPath[p].views30 = n; byPath[p].visitors30 = u }
  for (const [p, l, r] of reads as [string, number, number][]) if (byPath[p]) { byPath[p].leaves30 = l; byPath[p].reads30 = r }
  const [views, visitors, leaves, readN] = (total[0] ?? [0, 0, 0, 0]) as number[]
  return { weeks, byPath, summary: { views, visitors, reads: readN, leaves } }
}

// A PostHog trends insight of these pages' views, broken down by page, for "See more in PostHog".
export function insightUrl(paths: string[]) {
  const q = { kind: 'InsightVizNode', source: { kind: 'TrendsQuery', interval: 'week', dateRange: { date_from: '-180d' },
    series: [{ kind: 'EventsNode', event: '$pageview', name: '$pageview', math: 'total' }],
    properties: [{ type: 'event', key: '$host', operator: 'exact', value: [HOST()] }, { type: 'event', key: '$pathname', operator: 'exact', value: paths.flatMap(p => [p, p + '/']) }],
    breakdownFilter: { breakdowns: [{ property: '$pathname', type: 'event' }] } } }
  return `${settings.posthog.host}/project/${PROJECT()}/insights/new#q=${encodeURIComponent(JSON.stringify(q))}`
}

export async function published() {
  const found = await swr('writing-published-pages', 12 * 3600_000, discover, { deadline: 300 })
  if ('pending' in found || 'error' in (found as any)) return found
  const paths = found.pages.map(p => p.path)
  const v = await swr(`writing-published-views3:${paths.join(',')}`, 3600_000, () => views(paths), { deadline: 300 })
  if ('pending' in v) return { ...found, repo: REPO(), host: HOST(), pending_views: true, weeks: [], pages: found.pages.map(p => ({ ...p, weekly: [], views30: 0, visitors30: 0, reads30: 0, leaves30: 0, total: 0 })), insight: insightUrl(paths) }
  if ('error' in (v as any)) return { ...found, repo: REPO(), host: HOST(), views_error: (v as any).error, weeks: [], pages: found.pages.map(p => ({ ...p, weekly: [], views30: 0, visitors30: 0, reads30: 0, leaves30: 0, total: 0 })), insight: insightUrl(paths) }
  return { ...found, repo: REPO(), host: HOST(), weeks: v.weeks, insight: insightUrl(paths), summary: v.summary,
    pages: found.pages.map(p => ({ ...p, ...v.byPath[p.path] })).sort((a, b) => Number(b.byline) - Number(a.byline) || b.views30 - a.views30 || b.total - a.total) }
}
