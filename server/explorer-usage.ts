// Usage, as a side note on the map: for a concept that is a product in the PostHog app itself, how many people
// use its pages each week, its shape over the last 26 weeks, and its rank among products. Grounded twice: the
// product's pages come from its own manifest (urls: '/dashboard', ...), and the numbers from $pageview events in
// the PostHog project in settings (PostHog's own analytics). Concepts without pages or traffic get nothing.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { posthogFetch } from './indexer.ts'
import { settings } from './settings.ts'
import { checkRepo, graphFor, remoteOf } from './explorer.ts'

const SAMPLE = 20 // 1/20 of users (events are sampled by user), scaled back up: cheap, and plenty for a trend
const memo = new Map<string, { at: number; v: Promise<any> }>()
function cached<T>(key: string, ttl: number, f: () => Promise<T>): Promise<T> {
  const m = memo.get(key)
  if (m && Date.now() - m.at < ttl) return m.v
  const v = f(); memo.set(key, { at: Date.now(), v }); v.catch(() => memo.delete(key))
  return v
}
const hogql = async (sql: string) => (await posthogFetch(`/api/projects/${settings.posthog.projectId}/query/`, { method: 'POST', body: JSON.stringify({ query: { kind: 'HogQLQuery', query: sql }, name: 'auto-m8-explorer-usage' }) } as any) as any)?.results ?? []

// The first path segment of every URL a product's manifest declares: urls: { dashboard: id => `/dashboard/${id}` } → dashboard.
export function manifestSegments(src: string): string[] {
  const block = /\burls\s*:\s*\{([\s\S]*?)\n\s{4}\}/.exec(src)?.[1] ?? ''
  const out = new Set<string>()
  for (const m of block.matchAll(/[`'"]\/([a-z0-9][a-z0-9_-]*)/g)) out.add(m[1])
  return [...out]
}

// Its shape in words, from weekly counts (complete weeks only).
export function shapeOf(weeks: number[]): { trend: 'growing' | 'declining' | 'steady'; spiky: boolean; change: number | null } {
  if (weeks.length < 6) return { trend: 'steady', spiky: false, change: null }
  const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length)
  const recent = avg(weeks.slice(-4)), before = avg(weeks.slice(-12, -4))
  const change = before ? (recent - before) / before : null
  const m = avg(weeks), sd = Math.sqrt(avg(weeks.map(x => (x - m) ** 2)))
  return { trend: change == null || Math.abs(change) < 0.1 ? 'steady' : change > 0 ? 'growing' : 'declining', spiky: m > 0 && sd / m > 0.35, change }
}

// Users per page area over the last 4 weeks: the denominator for "rank among products". One query, cached 6h.
const areaUsers = () => cached('areas', 6 * 3600_000, async () => {
  const rows = await hogql(`SELECT extract(properties.$pathname, '^/project/[0-9]+/([a-z0-9_-]+)') AS seg, count(DISTINCT person_id) * ${SAMPLE} AS users
    FROM events SAMPLE 1/${SAMPLE}
    WHERE event = '$pageview' AND timestamp > now() - INTERVAL 28 DAY AND match(properties.$pathname, '^/project/[0-9]+/[a-z]')
    GROUP BY seg HAVING users > 0`)
  return new Map<string, number>(rows.map((r: any[]) => [String(r[0]), Number(r[1])]))
})

// Which page areas belong to which product module, from the manifests in the repo.
const productAreas = (repo: string) => cached(`pa:${repo}`, 3600_000, async () => {
  const g = await graphFor(repo)
  const map = new Map<string, string[]>()
  for (const c of g.concepts) {
    const f = join(repo, c.path, 'manifest.tsx')
    if (c.path.startsWith('products/') && existsSync(f)) { const segs = manifestSegments(readFileSync(f, 'utf8')); if (segs.length) map.set(c.id, segs) }
  }
  return map
})

export async function usageFor(repoPath: string, id: string) {
  const repo = await checkRepo(repoPath)
  const r = await remoteOf(repo)
  // Only PostHog's own app is measured by PostHog's own analytics.
  if (!r || `${r.owner}/${r.name}`.toLowerCase() !== 'posthog/posthog') return { applies: false, why: 'Usage comes from PostHog’s own analytics, so it only covers the PostHog app.' }
  const areas = await productAreas(repo)
  let segs = areas.get(id)
  // A frontend scene folder (frontend/src/scenes/dashboard) counts when its name is a real page area.
  if (!segs) { const name = id.split('/').pop()!; const users = await areaUsers().catch(() => new Map()); if (id.includes('/scenes/') && users.has(name)) segs = [name] }
  if (!segs?.length) return { applies: false, why: 'No pages of its own in the app (not a product, or a backend piece).' }
  const users = await areaUsers()
  const segRe = segs.map(s => s.replace(/[^a-z0-9_-]/g, '')).join('|')
  const weekly = await cached(`w:${segRe}`, 6 * 3600_000, async () => (await hogql(`SELECT toStartOfWeek(timestamp) AS w, count(DISTINCT person_id) * ${SAMPLE} AS users
    FROM events SAMPLE 1/${SAMPLE}
    WHERE event = '$pageview' AND timestamp > toStartOfWeek(now()) - INTERVAL 26 WEEK AND timestamp < toStartOfWeek(now())
      AND match(properties.$pathname, '^/project/[0-9]+/(${segRe})(/|$|\\\\?)')
    GROUP BY w ORDER BY w`)).map((x: any[]) => ({ week: String(x[0]), users: Number(x[1]) })))
  // Skip the first week (the window starts mid-week); the current week is already excluded.
  const weeks = weekly.slice(1)
  if (!weeks.length || weeks.every((w: any) => !w.users)) return { applies: false, why: 'Its pages had no traffic in the last 26 weeks.' }
  // Rank by 4-week users against every product's areas (each product counted once, by its busiest area).
  const productUsers = [...areas].map(([cid, s]) => [cid, Math.max(0, ...s.map(x => users.get(x) ?? 0))] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  const rank = productUsers.findIndex(([cid]) => cid === id) + 1
  return {
    applies: true, segments: segs, weeks, latest: weeks[weeks.length - 1].users, ...shapeOf(weeks.map((w: any) => w.users)),
    rank: rank || null, of: productUsers.length, monthUsers: Math.max(0, ...segs.map(s => users.get(s) ?? 0)) || null,
    source: `PostHog project ${settings.posthog.projectId} ($pageview on /${segs.join(', /')}), 1/${SAMPLE} user sample scaled up, weekly`,
    link: `${settings.posthog.host}/project/${settings.posthog.projectId}/sql`,
  }
}
