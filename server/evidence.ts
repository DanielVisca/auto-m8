// The numbers a conversation stands on: every data query its agent ran (Grafana PromQL and
// LogQL, PostHog SQL and query tools), with the key figures it got back and a link that opens the
// same query in Grafana or PostHog. Read from the transcript (cached per file version), so it costs
// nothing until asked. Shown in the right panel; agents refind it through get_evidence.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { get } from './db.ts'
import { HOME, settings } from './settings.ts'
import { toItems, itemsOf } from './transcript.ts'

export type Evidence = { at: number | null; source: 'grafana' | 'posthog'; tool: string; title: string; query: string; numbers: { label: string; value: string }[]; link: string | null; linkLabel: string }

// Your Grafana, from the Grafana MCP's config (only its URL is read).
let grafanaBase: string | null | undefined
function grafana() {
  if (grafanaBase !== undefined) return grafanaBase
  grafanaBase = null
  try {
    const find = (o: any): string | null => {
      for (const [k, v] of Object.entries(o ?? {})) {
        if (k === 'grafana' && (v as any)?.env?.GRAFANA_URL) return String((v as any).env.GRAFANA_URL).replace(/\/$/, '')
        if (v && typeof v === 'object') { const r = find(v); if (r) return r }
      }
      return null
    }
    grafanaBase = find(JSON.parse(readFileSync(join(HOME, '.claude.json'), 'utf8')))
  } catch {}
  return grafanaBase
}
const labels = (m: Record<string, string>) => Object.entries(m ?? {}).filter(([k]) => k !== '__name__').map(([k, v]) => `${k}=${v}`).join(', ') || (m?.__name__ ?? 'value')
const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? (Math.abs(n) >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : String(+n.toPrecision(4))) : String(v) }
const explore = (uid: string, type: string, expr: string, from = 'now-1h', to = 'now') =>
  grafana() ? `${grafana()}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify({ a: { datasource: uid, queries: [{ refId: 'A', expr, datasource: { type, uid } }], range: { from, to } } }))}` : null

function fromGrafana(name: string, input: any, result: string): Evidence | null {
  let r: any = null
  try { r = JSON.parse(result) } catch {}
  if (name.endsWith('query_prometheus')) {
    const series: any[] = Array.isArray(r?.data) ? r.data : r?.data?.result ?? []
    const numbers = series.slice(0, 6).map(s => ({ label: labels(s.metric), value: num(s.value?.[1] ?? s.values?.at(-1)?.[1]) }))
    return { at: null, source: 'grafana', tool: 'PromQL', title: input.expr, query: input.expr, numbers, link: r?.exploreUrl ?? explore(input.datasourceUid, 'prometheus', input.expr, input.startTime, input.endTime), linkLabel: 'Open in Grafana' }
  }
  if (name.endsWith('query_loki_logs')) {
    const lines = (r?.streams ?? []).reduce((n: number, s: any) => n + (s.lines?.length ?? 0), 0) || (r?.data?.length ?? 0)
    return { at: null, source: 'grafana', tool: 'LogQL', title: input.logql, query: input.logql, numbers: [{ label: 'log lines', value: String(lines) }], link: r?.exploreUrl ?? explore(input.datasourceUid, 'loki', input.logql, input.startRfc3339, input.endRfc3339), linkLabel: 'Open in Grafana' }
  }
  if (/get_dashboard/.test(name) && input.uid) return { at: null, source: 'grafana', tool: 'Dashboard', title: `Dashboard ${input.uid}`, query: input.uid, numbers: [], link: grafana() ? `${grafana()}/d/${input.uid}` : null, linkLabel: 'Open dashboard' }
  return null
}

// PostHog's MCP: `call <tool> <json>`. Only calls that return data count (not search/info).
const DATA = /^(execute-sql|query-|logs-count|insight|insights-|trends|funnel|retention|metric|metrics-|error-tracking|session-recordings-list|events-|persons-)/
function fromPostHog(server: string, input: any, result: string): Evidence | null {
  const m = String(input.command ?? '').match(/^call\s+([\w-]+)\s*(\{[\s\S]*\})?\s*$/)
  if (!m || !DATA.test(m[1])) return null
  let args: any = {}
  try { args = m[2] ? JSON.parse(m[2]) : {} } catch {}
  const sql = m[1] === 'execute-sql' ? String(args.query ?? '') : null
  const numbers: Evidence['numbers'] = []
  if (sql) {
    // "col|col\nv|v": the header names each value.
    const rows = result.trim().split('\n').map(l => l.split('|'))
    const [head, ...body] = rows
    for (const row of body.slice(0, 3)) head.forEach((h, i) => { if (row[i] !== undefined && numbers.length < 8) numbers.push({ label: body.length > 1 ? `${h} (row ${body.indexOf(row) + 1})` : h, value: row[i] }) })
  } else {
    for (const line of result.split('\n').slice(0, 40)) {
      const kv = line.match(/^\s*([\w .-]{2,40}):\s*([-\d.,]+%?)\s*$/)
      if (kv && numbers.length < 6) numbers.push({ label: kv[1].trim(), value: kv[2] })
    }
  }
  const url = result.match(/https:\/\/[\w.-]*posthog\.com\/project\/\d+\/[^\s"')]+/)?.[0]
  // Only production PostHog gets a link; a local dev instance's would point nowhere useful.
  const prod = !/dev/.test(server)
  const link = url ?? (sql && prod ? `${settings.posthog.host}/project/${settings.posthog.projectId}/sql?open_query=${encodeURIComponent(sql)}` : null)
  return { at: null, source: 'posthog', tool: m[1], title: sql ?? `${m[1]} ${m[2] ? m[2].slice(0, 160) : ''}`.trim(), query: sql ?? m[2] ?? '', numbers, link, linkLabel: sql ? 'Open in PostHog SQL' : 'Open in PostHog' }
}

const cache = new Map<string, { m: number; items: Evidence[] }>()
export function evidence(conversationId: string): Evidence[] {
  const c = get<any>('select path from conversations where id = ?', conversationId)
  if (!c?.path || !existsSync(c.path)) return []
  const m = statSync(c.path).mtimeMs
  const hit = cache.get(conversationId)
  if (hit?.m === m) return hit.items
  const items: Evidence[] = []
  for (const it of itemsOf(c.path) as any[]) {
    for (const b of it.blocks ?? []) {
      if (b.type !== 'tool' || b.isError || !b.result || /^Error:/.test(String(b.result))) continue
      const name: string = b.name
      const e = name.startsWith('mcp__grafana__') ? fromGrafana(name, b.input ?? {}, String(b.result))
        : /^mcp__.*posthog.*__exec$/i.test(name) ? fromPostHog(name, b.input ?? {}, String(b.result)) : null
      if (e) items.push({ ...e, at: it.ts ?? null, title: e.title.replace(/\s+/g, ' ').slice(0, 300) })
    }
  }
  // Links we built use the MCP's Grafana address; Grafana's own links know its public one. Prefer that.
  const pub = items.map(e => e.link?.match(/^(https:\/\/[^/]*grafana[^/]*)\/explore/)?.[1]).find(Boolean)
  const mine = grafana()
  if (pub && mine) for (const e of items) if (e.link?.startsWith(mine)) e.link = pub + e.link.slice(mine.length)
  // Newest first; a repeated query keeps only its latest result.
  const seen = new Set<string>()
  const out = items.reverse().filter(e => { const k = `${e.tool}|${e.query}`; if (seen.has(k)) return false; seen.add(k); return true }).slice(0, 60)
  cache.set(conversationId, { m, items: out })
  return out
}
