// The explorer's runtime layer: where code runs and how it's doing, from real sources only. Every number carries the
// query and source that produced it; a source we can't reach says so, and how to connect it, instead of guessing.
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const run = (cmd: string, args: string[], timeout = 15_000) => new Promise<{ ok: boolean; out: string; err: string }>(res =>
  execFile(cmd, args, { timeout, maxBuffer: 64 << 20 }, (e, out, err) => res({ ok: !e, out: String(out), err: String(err || (e as any)?.message || '') })))
const memo = new Map<string, { at: number; v: Promise<any> }>()
function cached<T>(key: string, ttl: number, f: () => Promise<T>): Promise<T> {
  const m = memo.get(key)
  if (m && Date.now() - m.at < ttl) return m.v
  const v = f(); memo.set(key, { at: Date.now(), v }); v.catch(() => memo.delete(key))
  return v
}

// ---------- repos on this machine ----------

// Commits on the default branch (as of the last fetch) that the checkout doesn't have: how stale the map is.
async function behindDefault(p: string): Promise<number | null> {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master']) {
    const r = await run('git', ['-C', p, 'rev-list', '--count', `HEAD..${ref}`], 6000)
    if (r.ok) return Number(r.out.trim())
  }
  return null
}

export type RepoInfo = { path: string; name: string; remote: string | null; org: string | null; lastCommit: string | null; lastFetch: string | null; shallow: boolean; branch: string | null; behindOrigin: number | null }
export function listRepos(roots = [join(homedir(), 'Development')]): Promise<RepoInfo[]> {
  return cached(`repos:${roots.join(',')}`, 60_000, async () => {
    const dirs: string[] = []
    for (const r of roots) { try { for (const d of readdirSync(r)) { const p = join(r, d); if (!d.startsWith('.') && existsSync(join(p, '.git'))) dirs.push(p) } } catch {} }
    const info = await Promise.all(dirs.map(async p => {
      const [remote, last, branch, shallow, behind] = await Promise.all([
        run('git', ['-C', p, 'remote', 'get-url', 'origin'], 4000), run('git', ['-C', p, 'log', '-1', '--format=%cI'], 4000),
        run('git', ['-C', p, 'branch', '--show-current'], 4000), run('git', ['-C', p, 'rev-parse', '--is-shallow-repository'], 4000),
        // Commits on the default branch (as of the last fetch) that the checkout doesn't have: how stale the map is.
        behindDefault(p)])
      const slug = /github\.com[:/](.+?)(\.git)?$/.exec(remote.out.trim())?.[1] ?? null
      // When it was last pulled matters: a stale checkout maps an old system.
      let lastFetch: string | null = null
      try { lastFetch = statSync(join(p, '.git', 'FETCH_HEAD')).mtime.toISOString() } catch {}
      return { path: p, name: p.split('/').pop()!, remote: slug, org: slug?.split('/')[0] ?? null, lastCommit: last.out.trim() || null, lastFetch, shallow: shallow.out.trim() === 'true', branch: branch.out.trim() || null, behindOrigin: behind }
    }))
    return info.sort((a, b) => (b.lastCommit ?? '').localeCompare(a.lastCommit ?? ''))
  })
}

// ---------- connectors ----------

type Grafana = { name: string; url: string; token: string }
// Grafana connections: the ones already configured for agents (Claude's MCP servers), so there's one place to set them.
export function grafanas(): Grafana[] {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'))
    const servers = { ...(cfg.projects?.[join(homedir(), 'Development')]?.mcpServers ?? {}), ...(cfg.mcpServers ?? {}) }
    return Object.entries<any>(servers).filter(([n, s]) => /grafana/i.test(n) && s?.env?.GRAFANA_URL).map(([n, s]) => ({
      name: n, url: String(s.env.GRAFANA_URL).replace(/\/$/, ''),
      token: String(Object.entries<any>(s.env).find(([k]) => /TOKEN|API_KEY/.test(k))?.[1] ?? ''),
    })).filter(g => g.token)
  } catch { return [] }
}
async function gget(g: Grafana, path: string, timeout = 20_000): Promise<any> {
  const r = await fetch(g.url + path, { headers: { Authorization: `Bearer ${g.token}` }, signal: AbortSignal.timeout(timeout) })
  if (!r.ok) throw new Error(`${g.name} ${r.status}`)
  return r.json()
}
const datasources = (g: Grafana) => cached(`ds:${g.name}`, 10 * 60_000, async () => (await gget(g, '/api/datasources')) as { name: string; uid: string; type: string }[])

export type Connector = { id: string; name: string; status: 'connected' | 'expired' | 'missing' | 'error'; detail: string; fix?: { command?: string; how: string } }
export function connectors(fresh = false): Promise<Connector[]> {
  if (fresh) memo.delete('connectors')
  return cached('connectors', 60_000, async () => {
    const out: Connector[] = []
    const argo = await run('argocd', ['account', 'get-user-info', '-o', 'json'], 10_000)
    const argoUser = argo.ok ? (() => { try { return JSON.parse(argo.out) } catch { return null } })() : null
    out.push(argoUser?.loggedIn
      ? { id: 'argocd', name: 'Argo CD', status: 'connected', detail: `${argoUser.username ?? 'signed in'}: app health, sync, images, revisions` }
      : { id: 'argocd', name: 'Argo CD', status: argo.err.includes('not found') || argo.err.includes('ENOENT') ? 'missing' : 'expired', detail: argo.err.split('\n')[0].slice(0, 160) || 'not signed in',
        fix: { command: 'argocd login argocd-internal:80 --sso --grpc-web', how: 'Signs in through your browser (needs Tailscale for the internal host).' } })
    const gs = grafanas()
    if (!gs.length) out.push({ id: 'grafana', name: 'Grafana', status: 'missing', detail: 'No Grafana connection configured', fix: { how: 'Add a Grafana MCP server (GRAFANA_URL and a service account token) to Claude; the explorer reuses it.' } })
    for (const g of gs) {
      try { const ds = await datasources(g); out.push({ id: `grafana:${g.name}`, name: `Grafana (${g.name})`, status: 'connected', detail: `${ds.length} datasources: ${ds.filter(d => /prometheus|clickhouse|loki/.test(d.type)).map(d => d.name).slice(0, 8).join(', ')}` }) }
      catch (e: any) { out.push({ id: `grafana:${g.name}`, name: `Grafana (${g.name})`, status: 'error', detail: String(e?.message ?? e).slice(0, 160), fix: { how: 'Check Tailscale is up (the Grafana hosts are internal) and the token is still valid.' } }) }
    }
    const profiles = (await run('aws', ['configure', 'list-profiles'], 8000)).out.split('\n').filter(Boolean)
    if (!profiles.length) out.push({ id: 'aws', name: 'AWS', status: 'missing', detail: 'No AWS CLI profiles', fix: { how: 'Install the AWS CLI and configure SSO profiles (aws configure sso).' } })
    else {
      // One SSO session usually covers every profile: check one read-only prod profile.
      const p = profiles.find(x => /prod-us$/.test(x) && !/write|admin/.test(x)) ?? profiles[0]
      const id = await run('aws', ['sts', 'get-caller-identity', '--profile', p, '--output', 'json'], 12_000)
      out.push(id.ok
        ? { id: 'aws', name: 'AWS', status: 'connected', detail: `${profiles.length} profiles; ${p} works (instance types, volumes, databases)` }
        : { id: 'aws', name: 'AWS', status: /expired|sso/i.test(id.err) ? 'expired' : 'error', detail: `${profiles.length} profiles; ${p}: ${id.err.split('\n').find(Boolean)?.slice(0, 140)}`, fix: { command: `aws sso login --profile ${p}`, how: 'Opens your browser to renew the SSO session; read-only profiles are enough.' } })
    }
    const ctx = (await run('kubectl', ['config', 'get-contexts', '-o', 'name'], 5000)).out.split('\n').filter(Boolean)
    out.push(ctx.length
      ? { id: 'kube', name: 'Kubernetes', status: 'connected', detail: `${ctx.length} contexts configured (auth uses the AWS SSO session above); pod facts come from Prometheus instead` }
      : { id: 'kube', name: 'Kubernetes', status: 'missing', detail: 'No kubectl contexts', fix: { how: 'Not needed for the explorer: Prometheus already has pod facts.' } })
    return out
  })
}

// ---------- where a concept runs ----------

const argoApps = () => cached('argo:apps', 15 * 60_000, async () => {
  const r = await run('argocd', ['app', 'list', '-o', 'name'], 120_000)
  if (!r.ok) throw new Error(r.err.split('\n')[0] || 'argocd app list failed')
  return r.out.split('\n').map(s => s.trim()).filter(Boolean)
})
// metrics-ingestion-prod-us → base metrics-ingestion, region prod-us
const REGION = /-(prod-us|prod-eu|dev|staging|kargo-project)$/
const baseOf = (app: string) => app.replace(/^argocd\//, '').replace(REGION, '')

export type Fact = { label: string; value: number | string | null; unit?: string; source: string; query: string; link?: string }
// behind: commits your checkout has that prod doesn't; ahead: commits prod has that your checkout doesn't (pull first).
export type Code = { image: string; sha: string; repo: string; behind: number | null; ahead: number | null; github: string | null }
export type Deployment = { base: string; origin: 'yours' | 'org' | 'third-party' | 'unknown'; apps: { name: string; region: string; health?: string; sync?: string; revision?: string; deployedAt?: string; images?: string[]; chart?: string; namespace?: string; cluster?: string; code?: Code[]; error?: string }[]; facts: Fact[]; chartPath?: string }

// Whose code an image runs: a tag that is a commit in one of your repos is the strongest evidence there is.
const shaHome = new Map<string, Promise<{ repo: string; behind: number | null; ahead: number | null } | null>>()
async function findSha(sha: string, repos: string[]) {
  if (!shaHome.has(sha)) shaHome.set(sha, (async () => {
    for (const r of repos) {
      if (!(await run('git', ['-C', r, 'cat-file', '-e', `${sha}^{commit}`], 4000)).ok) continue
      const [b, a] = await Promise.all([run('git', ['-C', r, 'rev-list', '--count', `${sha}..HEAD`], 8000), run('git', ['-C', r, 'rev-list', '--count', `HEAD..${sha}`], 8000)])
      return { repo: r, behind: b.ok ? Number(b.out.trim()) : null, ahead: a.ok ? Number(a.out.trim()) : null }
    }
    // Shallow or stale checkouts miss recent shas: ask GitHub for each repo's origin.
    for (const r of repos) {
      const slug = /github\.com[:/](.+?)(\.git)?$/.exec((await run('git', ['-C', r, 'remote', 'get-url', 'origin'], 3000)).out.trim())?.[1]
      if (slug && (await run('gh', ['api', `repos/${slug}/commits/${sha}`, '--jq', '.sha'], 10_000)).ok) return { repo: r, behind: null, ahead: null }
    }
    return null
  })())
  return shaHome.get(sha)!
}
async function codeOf(images: string[], repos: string[]): Promise<Code[]> {
  const out: Code[] = []
  for (const image of images) {
    const sha = /:([0-9a-f]{40})(@|$)/.exec(image)?.[1]
    if (!sha) continue
    const hit = await findSha(sha, repos)
    if (!hit) continue
    const slug = /github\.com[:/](.+?)(\.git)?$/.exec((await run('git', ['-C', hit.repo, 'remote', 'get-url', 'origin'], 3000)).out.trim())?.[1]
    out.push({ image, sha, repo: hit.repo, behind: hit.behind, ahead: hit.ahead, github: slug ? `https://github.com/${slug}/commit/${sha}` : null })
  }
  return out
}
// Third-party: version-tagged images from public registries or mirrors. Org-built: your registry, but not a commit we can find.
export const originOf = (images: string[], code: Code[], org: string | null): Deployment['origin'] =>
  code.length ? 'yours' : !images.length ? 'unknown'
    : images.every(i => /mirror\/|public\.ecr\.aws|docker\.io|quay\.io|registry\.k8s\.io|\/dhi\/|:v?\d+(\.\d+)*(-[\w.]+)?(@|$)/.test(i) && !(org && i.toLowerCase().includes(`/${org.toLowerCase()}/`))) ? 'third-party' : 'org'

const promLink = (g: Grafana, dsUid: string, q: string) => `${g.url}/explore?left=${encodeURIComponent(JSON.stringify({ datasource: dsUid, queries: [{ refId: 'A', expr: q }], range: { from: 'now-1h', to: 'now' } }))}`
async function prom(g: Grafana, dsName: string, q: string): Promise<{ value: number | null; link: string }> {
  const ds = (await datasources(g)).find(d => d.name === dsName)
  if (!ds) throw new Error(`no datasource ${dsName}`)
  const r = await gget(g, `/api/datasources/proxy/uid/${ds.uid}/api/v1/query?query=${encodeURIComponent(q)}`)
  const v = r?.data?.result?.[0]?.value?.[1]
  return { value: v == null ? null : Number(v), link: promLink(g, ds.uid, q) }
}

// The tokens that name a concept, e.g. products/metrics → metrics; alerts_platform → alerts, platform.
const tokensOf = (concept: string) => [...new Set(concept.split('/').pop()!.toLowerCase().split(/[_\-\s]+/).map(t => t.replace(/s$/, '')).filter(t => t.length >= 3 && !['api', 'app', 'web', 'lib', 'src', 'ui'].includes(t)))]

export function whereItRuns(concept: string, opts: { charts?: string | null; repos?: string[]; org?: string | null } = {}) {
  // Live numbers: fine to reuse for two minutes while you click around.
  return cached(`runs:${concept}:${(opts.repos ?? []).join(',')}`, 120_000, () => whereItRunsNow(concept, opts))
}
async function whereItRunsNow(concept: string, opts: { charts?: string | null; repos?: string[]; org?: string | null }) {
  const toks = tokensOf(concept)
  let apps: string[] = [], argoError: string | null = null
  try { apps = await argoApps() } catch (e: any) { argoError = String(e?.message ?? e) }
  const bases = new Map<string, string[]>()
  for (const a of apps) { const b = baseOf(a); if (toks.some(t => b.split('-').some(seg => seg === t || seg.startsWith(t)))) (bases.get(b) ?? bases.set(b, []).get(b)!).push(a) }
  // Deployed in prod first, then by how many regions run it.
  const ranked = [...bases].sort((a, b) => Number(b[1].some(x => /prod/.test(x))) - Number(a[1].some(x => /prod/.test(x))) || b[1].length - a[1].length).slice(0, 10)
  const g = grafanas()[0]
  const deployments: Deployment[] = await Promise.all(ranked.map(async ([base, names]) => {
    const prodish = names.filter(n => /prod-(us|eu)$/.test(n)).concat(names.filter(n => !/-(dev|kargo-project)$/.test(n) && !/prod-(us|eu)$/.test(n))).slice(0, 3)
    const appInfo = await Promise.all(prodish.map(async name => {
      const r = await run('argocd', ['app', 'get', name, '-o', 'json'], 20_000)
      const region = REGION.exec(name)?.[1] ?? 'default'
      if (!r.ok) return { name, region, error: r.err.split('\n')[0].slice(0, 160) }
      try {
        const a = JSON.parse(r.out), s = a.status ?? {}, sp = a.spec ?? {}
        const src = (sp.sources ?? [sp.source]).filter(Boolean)[0] ?? {}
        const images: string[] = s.summary?.images ?? []
        // posthog images are tagged with the posthog commit they were built from: the code that is live.
        const code = await codeOf(images, opts.repos ?? [])
        return { name, region, health: s.health?.status, sync: s.sync?.status, revision: String(s.sync?.revision ?? s.sync?.revisions?.[0] ?? '').slice(0, 12), deployedAt: s.operationState?.finishedAt, images, chart: src.path ?? src.chart, namespace: sp.destination?.namespace, cluster: sp.destination?.name ?? sp.destination?.server, code }
      } catch { return { name, region, error: 'unreadable argocd output' } }
    }))
    const facts: Fact[] = []
    const allImages = appInfo.flatMap(a => a.images ?? []), allCode = appInfo.flatMap(a => a.code ?? [])
    const origin = originOf(allImages, allCode, opts.org ?? null)
    // Live numbers only for what runs your code or your org's: plumbing named like the concept isn't worth the queries.
    if (g && origin !== 'third-party') {
      const pod = `pod=~"${base}-.*"`
      const qs: [string, string, string?][] = [
        ['Pods', `count(kube_pod_info{${pod}})`],
        ['CPU used (cores)', `sum(rate(container_cpu_usage_seconds_total{${pod},container!=""}[5m]))`, 'cores'],
        ['CPU requested (cores)', `sum(kube_pod_container_resource_requests{${pod},resource="cpu"})`, 'cores'],
        ['Memory used', `sum(container_memory_working_set_bytes{${pod},container!=""})`, 'bytes'],
        ['Restarts (1h)', `sum(increase(kube_pod_container_status_restarts_total{${pod}}[1h]))`],
        ['CPU throttled (5m)', `sum(rate(container_cpu_cfs_throttled_periods_total{${pod}}[5m])) / sum(rate(container_cpu_cfs_periods_total{${pod}}[5m]))`, '%'],
      ]
      // Two sources on purpose: VictoriaMetrics is today's reference, PostHog metrics is where it's moving.
      for (const ds of ['VictoriaMetrics', 'posthog-prometheus']) {
        await Promise.all(qs.map(async ([label, q, unit]) => {
          try { const r = await prom(g, ds, q); facts.push({ label, value: r.value, unit, source: `${g.name} · ${ds}`, query: q, link: r.link }) }
          catch (e: any) { facts.push({ label, value: null, unit, source: `${g.name} · ${ds}`, query: q, link: undefined }) }
        }))
      }
    }
    const chartPath = opts.charts && existsSync(join(opts.charts, 'apps', base)) ? join(opts.charts, 'apps', base) : undefined
    return { base, origin, apps: appInfo, facts, chartPath }
  }))
  const order = { yours: 0, org: 1, unknown: 2, 'third-party': 3 }
  deployments.sort((a, b) => order[a.origin] - order[b.origin])
  return { concept, tokens: toks, argoError, grafana: g ? g.name : null, deployments, matchedBy: 'Argo CD apps whose name contains the concept name; "runs your code" when an image tag is a commit in one of your workspace repos' }
}

// ClickHouse fleet disk: how full the nodes are, fullest first. Cluster names aren't on these series yet, so
// the fullest nodes are named by instance.
export async function clickhouseDisks() {
  const g = grafanas()[0]
  if (!g) return { error: 'No Grafana connection' }
  const q1 = 'quantile(0.5, ClickHouseAsyncMetrics_DiskUsed / ClickHouseAsyncMetrics_DiskTotal)'
  const q2 = 'topk(8, max by (instance, disk)(ClickHouseAsyncMetrics_DiskUsed / ClickHouseAsyncMetrics_DiskTotal))'
  const q3 = 'count(ClickHouseAsyncMetrics_DiskTotal)'
  const ds = (await datasources(g)).find(d => d.name === 'prometheus-clickhouse')
  if (!ds) return { error: 'No prometheus-clickhouse datasource' }
  const raw = async (q: string) => (await gget(g, `/api/datasources/proxy/uid/${ds.uid}/api/v1/query?query=${encodeURIComponent(q)}`))?.data?.result ?? []
  const [med, top, n] = await Promise.all([raw(q1), raw(q2), raw(q3)])
  return {
    source: `${g.name} · prometheus-clickhouse`,
    median: med[0] ? Number(med[0].value[1]) : null, disks: n[0] ? Number(n[0].value[1]) : null,
    fullest: top.map((x: any) => ({ instance: x.metric.instance, disk: x.metric.disk, used: Number(x.value[1]) })),
    queries: [q1, q2, q3].map(q => ({ query: q, link: promLink(g, ds.uid, q) })),
  }
}

// ---------- datastores and tiers: which ClickHouse clusters and tables hold a concept's data ----------

// Terraform/terragrunt instance sizes, each with the file:line and the block it sits in. Pure, so it's tested.
export type TfType = { key: string; value: string; file: string; line: number; context: string[] }
export function tfInstanceTypes(text: string, file: string): TfType[] {
  const out: TfType[] = []
  const stack: { name: string; depth: number }[] = []
  let depth = 0
  text.split('\n').forEach((raw, i) => {
    const l = raw.replace(/(^|\s)(#|\/\/).*$/, '')
    const kv = /^\s*"?(instance_type|node_type|instance_class|instance_types)"?\s*=\s*(\[?\s*"[^"]+".*)$/.exec(l)
    if (kv) for (const m of kv[2].matchAll(/"([^"]+)"/g)) if (!m[1].includes('${')) out.push({ key: kv[1], value: m[1], file, line: i + 1, context: stack.map(s => s.name) })
    // A block opener: resource "a" "b" {, module "x" {, inputs = {, "ch-2c" = {, name = {
    const open = /^\s*(?:(resource|module|data|locals|inputs)\b((?:\s+"[^"]+")*)|"?([\w.\-]+)"?\s*=)\s*[{[]\s*$/.exec(l)
    const opens = (l.match(/[{[]/g) ?? []).length, closes = (l.match(/[}\]]/g) ?? []).length
    if (open) { stack.push({ name: open[1] ? `${open[1]}${open[2].replace(/"/g, '').replace(/\s+/g, ' ')}` : open[3], depth }); depth += opens - closes; return }
    depth += opens - closes
    while (stack.length && depth <= stack[stack.length - 1].depth) stack.pop()
  })
  return out
}

// Table names a piece of code reads or writes: SQL FROM/INTO/JOIN/TABLE, Django db_table, and quoted
// identifiers that look like ClickHouse tables (sharded_x, x_mv, x32). Pure; real matches are only kept
// when ClickHouse actually has a table by that name.
export function sqlTableNames(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/\b(?:FROM|INTO|JOIN|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?|ALTER\s+TABLE)\s+`?(?:\{[^}]*\}\.|\w+\.)?`?([a-zA-Z_][a-zA-Z0-9_]{2,})/g)) out.add(m[1].toLowerCase())
  for (const m of text.matchAll(/\bdb_table\s*=\s*["']([\w]+)["']/g)) out.add(m[1].toLowerCase())
  for (const m of text.matchAll(/["'`]((?:sharded_|writable_|kafka_)?[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\d+|_mv|_samples|_kafka))["'`]/g)) out.add(m[1])
  return [...out]
}

export type ChTable = { db: string; table: string; engine: string; cluster?: string | null }
export type TableMatch = ChTable & { how: string[] }
// Which ClickHouse tables belong to a concept, and how we know: the code names it (strongest), it's a Django
// db_table of the concept's models, or its name contains the concept's name.
export function matchTables(tables: ChTable[], opts: { tokens: string[]; codeNames: Map<string, string>; dbTables?: string[] }): TableMatch[] {
  const out: TableMatch[] = []
  const dbt = new Set((opts.dbTables ?? []).map(t => t.toLowerCase()))
  for (const t of tables) {
    const n = t.table.toLowerCase(), how: string[] = []
    const where = opts.codeNames.get(n)
    if (where) how.push(`named in code at ${where}`)
    if (dbt.has(n)) how.push('db_table of a model in this concept')
    // The concept's name must lead the table name (metrics4_samples, sharded_logs34): app_metrics2 or query_log_archive are other concepts' tables.
    const words = n.replace(/^(sharded|writable|kafka|distributed)_/, '').split(/[_\d]+/).filter(Boolean)
    const tok = opts.tokens.find(k => words[0] === k || words[0] === `${k}s`)
    if (tok) how.push(`table name starts with “${tok}”`)
    if (how.length) out.push({ ...t, how })
  }
  const rank = (m: TableMatch) => (m.how.some(h => h.startsWith('named in code')) ? 2 : 0) + (m.how.some(h => h.startsWith('db_table')) ? 1 : 0)
  return out.sort((a, b) => rank(b) - rank(a) || a.table.localeCompare(b.table))
}
// Distributed('cluster', 'db', 'table', ...) names the cluster that holds the data.
export const distributedCluster = (engineFull: string) => /^Distributed\(\s*'([^']+)'/.exec(engineFull ?? '')?.[1] ?? null
// prod-us-iad-ch-2c → ch-2c, so Prometheus instances line up with system.clusters host names.
export const nodeKey = (s: string) => s.toLowerCase().split('.')[0].replace(/^(prod|dev|staging)-(us|eu)-[a-z]+\d?-/, '')

type Ds = { name: string; uid: string; type: string }
// The Grafana ClickHouse plugin returns arrays either as arrays or as JSON text.
const arr = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : typeof v === 'string' ? (() => { try { const j = JSON.parse(v); return Array.isArray(j) ? j.map(String) : [v] } catch { return v ? [v] : [] } })() : []
const chLink = (g: Grafana, uid: string, sql: string) => `${g.url}/explore?left=${encodeURIComponent(JSON.stringify({ datasource: uid, queries: [{ refId: 'A', datasource: { uid, type: 'grafana-clickhouse-datasource' }, rawSql: sql, format: 1, editorType: 'sql', queryType: 'table' }], range: { from: 'now-5m', to: 'now' } }))}`
// Read-only SELECTs on system tables, through Grafana's ClickHouse datasource. Returns rows as objects.
async function chQuery(g: Grafana, ds: Ds, sql: string, timeout = 20_000): Promise<Record<string, any>[]> {
  if (!/^\s*SELECT\b/i.test(sql) || /;\s*\S/.test(sql)) throw new Error('only single SELECTs')
  const r = await fetch(g.url + '/api/ds/query', {
    method: 'POST', headers: { Authorization: `Bearer ${g.token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeout),
    body: JSON.stringify({ queries: [{ refId: 'A', datasource: { uid: ds.uid }, rawSql: sql, format: 1 }], from: 'now-5m', to: 'now' }),
  })
  const j: any = await r.json().catch(() => null)
  const res = j?.results?.A
  if (!r.ok || res?.error) throw new Error(`${ds.name}: ${String(res?.error ?? j?.message ?? r.status).split('\n')[0].slice(0, 200)}`)
  const fr = res?.frames?.[0]
  if (!fr) return []
  const names: string[] = fr.schema.fields.map((f: any) => f.name), cols: any[][] = fr.data?.values ?? []
  return (cols[0] ?? []).map((_: any, i: number) => Object.fromEntries(names.map((n, k) => [n, cols[k]?.[i]])))
}

// The concept's code: table names it mentions, with the first file:line for each.
async function codeTableNames(repo: string | undefined, path: string): Promise<{ names: Map<string, string>; dbTables: string[]; files: number; error?: string }> {
  const names = new Map<string, string>(), dbTables: string[] = []
  if (!repo || !path) return { names, dbTables, files: 0, error: 'no repo' }
  const ls = await run('git', ['-C', repo, 'ls-files', '--', path], 10_000)
  if (!ls.ok) return { names, dbTables, files: 0, error: ls.err.split('\n')[0] }
  // Tests and fixtures name tables too, but that's not evidence the concept uses them.
  const files = ls.out.split('\n').filter(f => /\.(py|ts|tsx|sql|rs|go)$/.test(f) && !/(^|\/)(__snapshots__|node_modules|tests?|__tests__|fixtures)\/|(^|\/)test_[^/]*$|_test\.(py|go|rs)$|\.(test|spec)\.tsx?$|fixtures?\.py$/.test(f)).slice(0, 3000)
  for (const f of files) {
    let text = ''
    try { const p = join(repo, f); if (statSync(p).size > 400_000) continue; text = readFileSync(p, 'utf8') } catch { continue }
    if (!/FROM|INTO|TABLE|db_table|_samples|sharded_|\d["'`]/.test(text)) continue
    const lines = text.split('\n')
    for (const n of sqlTableNames(text)) {
      if (names.has(n)) continue
      const at = lines.findIndex(l => l.toLowerCase().includes(n))
      names.set(n, `${f}:${at + 1}`)
    }
    for (const m of text.matchAll(/\bdb_table\s*=\s*["']([\w]+)["']/g)) dbTables.push(m[1].toLowerCase())
  }
  return { names, dbTables, files: files.length }
}

// Terraform sizes for ClickHouse nodes in posthog-cloud-infra (or any infra repo in the workspace).
function infraTypes(infra: string | null): { types: TfType[]; files: number; error?: string } {
  if (!infra) return { types: [], files: 0, error: 'posthog-cloud-infra not found under ~/Development' }
  const root = join(infra, 'terraform', 'environments')
  const files: string[] = []
  const walk = (d: string, depth: number, inCh: boolean) => {
    if (depth > 5) return
    let ents: string[] = []
    try { ents = readdirSync(d) } catch { return }
    for (const e of ents) {
      if (e.startsWith('.') || e === 'node_modules') continue
      const p = join(d, e), ch = inCh || /clickhouse/i.test(e)
      const st = (() => { try { return statSync(p) } catch { return null } })()
      if (!st) continue
      if (st.isDirectory()) walk(p, depth + 1, ch)
      else if (ch && /\.(tf|hcl|tfvars)$/.test(e) && st.size < 1_000_000) files.push(p)
    }
  }
  walk(root, 0, false)
  if (!files.length) return { types: [], files: 0, error: `no ClickHouse terraform under ${root}` }
  const types = files.flatMap(f => { try { return tfInstanceTypes(readFileSync(f, 'utf8'), f.slice(infra.length + 1)) } catch { return [] } })
  return { types, files: files.length }
}

export function dataFor(concept: string, repos: string[] = []) {
  return cached(`data:${concept}:${repos.join(',')}`, 120_000, () => dataForNow(concept, repos))
}
async function dataForNow(concept: string, repos: string[]) {
  // Like tokensOf, but short names count here (products/logs → log): table names are matched as whole words.
  const toks = [...new Set(concept.split('/').pop()!.toLowerCase().split(/[_\-\s]+/).map(t => t.replace(/s$/, '')).filter(t => t.length >= 3))]
  const problems: { source: string; error: string; fix?: string }[] = []
  const g = grafanas()[0]
  const code = await codeTableNames(repos[0], concept)
  if (code.error) problems.push({ source: 'code', error: code.error })
  const allRepos = await listRepos().catch(() => [] as RepoInfo[])
  const infraRepo = allRepos.find(r => r.name === 'posthog-cloud-infra') ?? null
  const tf = infraTypes(infraRepo?.path ?? null)
  if (tf.error) problems.push({ source: 'terraform', error: tf.error, fix: 'gh repo clone PostHog/posthog-cloud-infra ~/Development/posthog-cloud-infra' })
  const slug = infraRepo?.remote ?? 'PostHog/posthog-cloud-infra'
  const infraSha = infraRepo ? (await run('git', ['-C', infraRepo.path, 'rev-parse', 'HEAD'], 4000)).out.trim() : ''
  const tfLink = (t: TfType) => infraSha ? `https://github.com/${slug}/blob/${infraSha}/${t.file}#L${t.line}` : undefined
  if (!g) return { concept, tokens: toks, grafana: null, clusters: [], tables: [], problems: [...problems, { source: 'grafana', error: 'No Grafana connection', fix: 'Add a Grafana MCP server to Claude (GRAFANA_URL and a token); the explorer reuses it.' }], terraform: [], infra: null, code: { files: code.files, names: code.names.size } }

  const dss = (await datasources(g)).filter(d => d.type === 'grafana-clickhouse-datasource')
  // One cheap pass per ClickHouse datasource: who it connects to, its clusters, tables, and local sizes.
  const qHost = `SELECT hostName() AS host, version() AS version`
  const qClusters = `SELECT cluster, count() AS replicas, uniqExact(shard_num) AS shards, groupUniqArray(host_name) AS hosts FROM system.clusters GROUP BY cluster ORDER BY cluster LIMIT 200`
  const qTables = `SELECT database AS db, name AS table, engine, engine_full FROM system.tables WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') AND NOT is_temporary LIMIT 10000`
  const seen = await Promise.all(dss.map(async ds => {
    try {
      const [host, clusters, tables] = await Promise.all([chQuery(g, ds, qHost), chQuery(g, ds, qClusters), chQuery(g, ds, qTables)])
      return { ds, host: String(host[0]?.host ?? '?'), clusters, tables }
    } catch (e: any) { problems.push({ source: `${g.name} · ${ds.name}`, error: String(e?.message ?? e).slice(0, 200) }); return null }
  }))
  const tables: (TableMatch & { ds: string; host: string; bytes?: number | null; rows?: number | null; parts?: number | null; sizeScope?: string; query?: string; link?: string })[] = []
  const clusterNames = new Map<string, { ds: string; replicas: number; shards: number; hosts: string[] }>()
  for (const s of seen) {
    if (!s) continue
    for (const c of s.clusters) if (!clusterNames.has(c.cluster)) clusterNames.set(String(c.cluster), { ds: s.ds.name, replicas: Number(c.replicas), shards: Number(c.shards), hosts: arr(c.hosts) })
    const chTables: ChTable[] = s.tables.map(t => ({ db: String(t.db), table: String(t.table), engine: String(t.engine), cluster: distributedCluster(String(t.engine_full ?? '')) }))
    const m = matchTables(chTables, { tokens: toks, codeNames: code.names, dbTables: code.dbTables })
      // Only the kinds of table that hold or route data; skip views of views and Kafka consumers' noise last.
      .filter(t => !/^(View|LiveView|Dictionary)$/.test(t.engine)).slice(0, 40)
    // The same table is visible through several datasources: keep the first (datasources are listed with the data's own cluster first or not; sizes are filled per datasource below, so dedupe after).
    // A local (non-Distributed) table lives on the node this datasource reaches: its cluster is the smallest one listing that host.
    const hostCluster = s.clusters.filter(c => arr(c.hosts).includes(s.host)).sort((a, b) => arr(a.hosts).length - arr(b.hosts).length)[0]?.cluster
    for (const t of m) if (!tables.some(x => x.db === t.db && x.table === t.table && x.engine === t.engine)) tables.push({ ...t, cluster: t.cluster ?? (/MergeTree|Buffer/.test(t.engine) && hostCluster ? String(hostCluster) : null), ds: s.ds.name, host: s.host })
  }
  // Sizes: across every replica of the data's cluster when we know it, else on the node the datasource reaches.
  await Promise.all(seen.filter(Boolean).map(async s => {
    const mine = tables.filter(t => t.ds === s!.ds.name)
    if (!mine.length) return
    const local = mine.filter(t => /MergeTree/.test(t.engine))
    // Distributed tables point at local tables on a cluster: size those, across all replicas of that cluster.
    const byCluster = new Map<string, ChTable[]>()
    for (const t of mine) if (t.engine === 'Distributed' && t.cluster) {
      const raw = String(s!.tables.find(x => x.db === t.db && x.table === t.table)?.engine_full ?? '')
      const a = /^Distributed\(\s*'[^']+'\s*,\s*'?([\w{}]+)'?\s*,\s*'?(\w+)'?/.exec(raw)
      if (a) (byCluster.get(t.cluster) ?? byCluster.set(t.cluster, []).get(t.cluster)!).push({ db: a[1].replace(/[{}]/g, '') === 'currentDatabase()' ? t.db : a[1], table: a[2], engine: 'MergeTree' })
    }
    const esc = (x: string) => x.replace(/[^\w]/g, '')
    const sizeSql = (from: string, ts: ChTable[]) => `SELECT database AS db, table, sum(bytes_on_disk) AS bytes, sum(rows) AS rows, count() AS parts FROM ${from} WHERE active AND (database, table) IN (${ts.map(t => `('${esc(t.db)}', '${esc(t.table)}')`).join(', ')}) GROUP BY db, table LIMIT 500 SETTINGS max_execution_time = 15`
    const apply = (rows: Record<string, any>[], scope: string, sql: string, targets: (t: typeof tables[number]) => ChTable | null) => {
      for (const t of mine) {
        const tgt = targets(t); if (!tgt) continue
        const r = rows.find(x => x.db === tgt.db && x.table === tgt.table)
        if (r && t.bytes == null) Object.assign(t, { bytes: Number(r.bytes), rows: Number(r.rows), parts: Number(r.parts), sizeScope: scope, query: sql, link: chLink(g, s!.ds.uid, sql) })
      }
    }
    for (const [cl, ts] of byCluster) {
      const sql = sizeSql(`clusterAllReplicas('${esc(cl)}', system.parts)`, ts)
      try {
        const rows = await chQuery(g, s!.ds, sql, 25_000)
        apply(rows, `all replicas of ${cl} (counts each replica's copy)`, sql, t => {
          if (t.engine !== 'Distributed' || t.cluster !== cl) return null
          const a = /^Distributed\(\s*'[^']+'\s*,\s*'?([\w{}]+)'?\s*,\s*'?(\w+)'?/.exec(String(s!.tables.find(x => x.db === t.db && x.table === t.table)?.engine_full ?? ''))
          return a ? { db: a[1] === 'currentDatabase()' ? t.db : a[1], table: a[2], engine: '' } : null
        })
      } catch (e: any) { problems.push({ source: `${g.name} · ${s!.ds.name}`, error: `sizes across ${cl}: ${String(e?.message ?? e).slice(0, 160)}` }) }
    }
    if (local.length) {
      const sql = sizeSql('system.parts', local)
      try { apply(await chQuery(g, s!.ds, sql), `on ${s!.host} only (the node this datasource reaches)`, sql, t => /MergeTree/.test(t.engine) ? t : null) }
      catch (e: any) { problems.push({ source: `${g.name} · ${s!.ds.name}`, error: `local sizes: ${String(e?.message ?? e).slice(0, 160)}` }) }
    }
  }))

  // The clusters that hold the concept's data: named by its Distributed tables.
  const used = [...new Set(tables.map(t => t.cluster).filter(Boolean) as string[])]
  // Disk fullness per node, from Prometheus, joined to clusters by host name.
  let disks: { instance: string; disk: string; used: number; ec2: string | null; role: string | null }[] = []
  const pq = 'max by (instance, disk, ec2_instance_id, role)(ClickHouseAsyncMetrics_DiskUsed / ClickHouseAsyncMetrics_DiskTotal)'
  const pds = (await datasources(g)).find(d => d.name === 'prometheus-clickhouse')
  if (!pds) problems.push({ source: `${g.name} · prometheus-clickhouse`, error: 'datasource not found' })
  else try {
    const r = await gget(g, `/api/datasources/proxy/uid/${pds.uid}/api/v1/query?query=${encodeURIComponent(pq)}`)
    disks = (r?.data?.result ?? []).map((x: any) => ({ instance: String(x.metric.instance), disk: String(x.metric.disk ?? ''), used: Number(x.value[1]), ec2: x.metric.ec2_instance_id ?? null, role: x.metric.role ?? null }))
  } catch (e: any) { problems.push({ source: `${g.name} · prometheus-clickhouse`, error: String(e?.message ?? e).slice(0, 160) }) }

  const tfFor = (cl: string, nodes: string[]) => {
    const keys = [...(/^(posthog|default|main)$/.test(cl.toLowerCase()) ? [] : [cl.toLowerCase()]), ...cl.toLowerCase().split(/[_\-]/).filter(w => w.length >= 4 && !/posthog|cluster|prod/.test(w)), ...nodes.map(nodeKey)]
    // These disks come from prod-us Prometheus, so only prod-us terraform describes them (dev accounts reuse block names).
    const prodUs = tf.types.filter(t => /prod-us|prod_us/.test(t.file))
    return (prodUs.length ? prodUs : tf.types.filter(t => !/[-_/](dev|staging|sandbox|lab)[-_/]/.test(t.file)))
      .map(t => ({ t, hit: keys.find(k => k && (t.context.join(' ').toLowerCase().includes(k) || t.file.toLowerCase().includes(k))) }))
      .filter(x => x.hit).slice(0, 12).map(({ t, hit }) => ({ ...t, matchedBy: `“${hit}” in ${t.context.length ? t.context.join(' › ') : t.file}`, link: tfLink(t) }))
  }
  // AWS confirmation of the instance types, only when the SSO session works (read-only describe).
  const awsTypes = new Map<string, string>()
  const ids = [...new Set(disks.filter(d => used.some(cl => clusterNames.get(cl)?.hosts.some(h => nodeKey(h) === nodeKey(d.instance)))).map(d => d.ec2).filter(Boolean) as string[])].slice(0, 50)
  let awsError: string | null = null
  if (ids.length) {
    const r = await run('aws', ['ec2', 'describe-instances', '--profile', 'ch-prod-us', '--region', 'us-east-1', '--instance-ids', ...ids, '--query', 'Reservations[].Instances[].[InstanceId,InstanceType]', '--output', 'json'], 20_000)
    if (r.ok) { try { for (const [id, ty] of JSON.parse(r.out)) awsTypes.set(id, ty) } catch {} }
    else { awsError = r.err.split('\n').find(Boolean)?.slice(0, 160) ?? 'aws failed'; problems.push({ source: 'AWS (ch-prod-us)', error: awsError, fix: 'aws sso login --profile ch-prod-us' }) }
  }

  const clusters = used.map(cl => {
    const info = clusterNames.get(cl)
    const nodes = disks.filter(d => info?.hosts.some(h => nodeKey(h) === nodeKey(d.instance)))
    const fill = nodes.map(n => n.used)
    return {
      name: cl, ds: info?.ds ?? null, shards: info?.shards ?? null, replicas: info?.replicas ?? null, hosts: info?.hosts ?? [],
      disk: nodes.length ? { nodes: [...new Set(nodes.map(n => n.instance))].length, max: Math.max(...fill), median: fill.sort((a, b) => a - b)[Math.floor(fill.length / 2)], fullest: nodes.sort((a, b) => b.used - a.used).slice(0, 5), query: pq, link: pds ? promLink(g, pds.uid, pq) : undefined, source: `${g.name} · prometheus-clickhouse` }
        : { nodes: 0, note: info ? `no Prometheus instance matched these hosts (${info.hosts.slice(0, 3).join(', ')}…); instance labels look like ${disks.slice(0, 2).map(d => d.instance).join(', ') || 'nothing'}` : 'cluster not in system.clusters of any datasource' },
      aws: [...new Set(nodes.map(n => n.ec2 && awsTypes.get(n.ec2)).filter(Boolean) as string[])],
      terraform: tfFor(cl, nodes.map(n => n.instance)),
    }
  })
  const q = { host: qHost, clusters: qClusters, tables: qTables }
  return {
    concept, tokens: toks, grafana: g.name, clusters, tables,
    datasources: seen.filter(Boolean).map(s => ({ name: s!.ds.name, host: s!.host, tables: s!.tables.length, link: chLink(g, s!.ds.uid, qTables) })),
    queries: q, problems,
    infra: infraRepo ? { path: infraRepo.path, behind: infraRepo.behindOrigin, lastFetch: infraRepo.lastFetch, sha: infraSha.slice(0, 12), files: tf.files, types: tf.types.length } : null,
    code: { files: code.files, names: code.names.size },
    matchedBy: 'Tables: named in the concept’s code (SQL or db_table), or whose name contains the concept’s name. Clusters: the cluster in each Distributed table’s engine. Disks: Prometheus nodes whose name matches a host in system.clusters. Tier: terraform instance types whose block or file names the cluster or its nodes.',
  }
}

// Listing Argo CD apps takes about a minute: warm it in the background so the first click is quick.
export function prewarmRuntime() { argoApps().catch(() => {}) }
