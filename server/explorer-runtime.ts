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
const tokensOf = (concept: string) => [...new Set(concept.split('/').pop()!.toLowerCase().split(/[_\-\s]+/).map(t => t.replace(/s$/, '')).filter(t => t.length >= 4))]

export function whereItRuns(concept: string, opts: { charts?: string | null; repos?: string[]; org?: string | null } = {}) {
  // Live numbers: fine to reuse for two minutes while you click around.
  return cached(`runs:${concept}:${(opts.repos ?? []).join(',')}`, 120_000, () => whereItRunsNow(concept, opts))
}
async function whereItRunsNow(concept: string, opts: { charts?: string | null; repos?: string[]; org?: string | null }) {
  const toks = tokensOf(concept)
  let apps: string[] = [], argoError: string | null = null
  try { apps = await argoApps() } catch (e: any) { argoError = String(e?.message ?? e) }
  const bases = new Map<string, string[]>()
  for (const a of apps) { const b = baseOf(a); if (toks.some(t => b.includes(t))) (bases.get(b) ?? bases.set(b, []).get(b)!).push(a) }
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

// Listing Argo CD apps takes about a minute: warm it in the background so the first click is quick.
export function prewarmRuntime() { argoApps().catch(() => {}) }
