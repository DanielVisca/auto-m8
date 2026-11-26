// Live architecture boards. A board can name the parts of the system its diagram draws
// ("sections": query_batch, Redis, ClickHouse…). Each section gathers, live:
// - the PRs working on it (listed, matched by title, or from a project workstream), with where each is;
// - findings: what turned out different from the plan (a wrong assumption, a bottleneck, a surprise),
//   recorded by agents as they work, plus ones auto-m8 derives when a measurement breaks an assumption;
// - timing: a query (e.g. HogQL over trace spans) that returns the part's latency, against what the
//   design assumed, kept over time so the board shows the trend and which part is the bottleneck.
// The tile bridge (web/src/tileBridge.ts) draws this over any code tile: rings, badges, hover, drill-in.
import { all, db, get, run } from './db.ts'
import { data } from './canvas.ts'
import { phaseOf, prInfo, projectStatus } from './projects.ts'

db.exec(`create table if not exists board_sections (
  board_id text not null, key text not null, config text not null, position integer default 0, updated_at integer,
  primary key (board_id, key)
)`)
db.exec(`create table if not exists board_findings (
  id integer primary key autoincrement, board_id text not null, section text not null,
  kind text not null,              -- wrong (an assumption that was wrong) | bottleneck | surprise | confirmed | note
  title text not null, expected text, observed text, evidence text, by_ text, at integer not null, resolved_at integer
)`)
db.exec(`create table if not exists board_section_readings (board_id text not null, section text not null, value real not null, p95 real, at integer not null)`)
db.exec('create index if not exists board_section_readings_i on board_section_readings (board_id, section, at)')

export type SectionInput = {
  key: string; label?: string; about?: string
  match?: string                      // text in the diagram that marks the part (default: label)
  prs?: string[]                      // PR urls that work on it
  pr_match?: string                   // regex over PR titles (case-insensitive), e.g. "query.?batch"
  project?: string; workstream?: string // a project's conversation id + workstream key: its PRs, agents and metric
  timing?: { hogql: string; expected_ms?: number | null; what?: string } // first row: [value_ms, p95_ms?]
}
export const FINDING_KINDS = ['wrong', 'bottleneck', 'surprise', 'confirmed', 'note'] as const
const slug = (s: string) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
const parse = (s: string) => { try { return JSON.parse(s) } catch { return {} } }

export function setSections(boardId: string, list: SectionInput[], replace = false) {
  if (!get('select 1 from boards where id = ?', boardId)) throw new Error(`No board ${boardId}`)
  if (!Array.isArray(list)) throw new Error('sections must be a list')
  for (const s of list) if (s.pr_match) new RegExp(s.pr_match, 'i') // throws on a bad regex
  if (replace) run('delete from board_sections where board_id = ?', boardId)
  const base = (get<any>('select max(position) m from board_sections where board_id = ?', boardId)?.m ?? -1) + 1
  list.forEach((s, i) => {
    const key = slug(s.key || s.label || '')
    if (!key) return
    const old = get<any>('select config, position from board_sections where board_id = ? and key = ?', boardId, key)
    const merged = { ...(old ? parse(old.config) : {}), ...s, key }
    run(`insert into board_sections (board_id, key, config, position, updated_at) values (?, ?, ?, ?, ?)
      on conflict(board_id, key) do update set config = excluded.config, updated_at = excluded.updated_at`, boardId, key, JSON.stringify(merged), old?.position ?? base + i, Date.now())
  })
  return sectionsOf(boardId)
}
export const removeSection = (boardId: string, key: string) => run('delete from board_sections where board_id = ? and key = ?', boardId, slug(key))
export const sectionsOf = (boardId: string): SectionInput[] => all<any>('select config from board_sections where board_id = ? order by position', boardId).map(r => parse(r.config))

export function addFinding(boardId: string, f: { section: string; kind?: string; title: string; expected?: string; observed?: string; evidence?: string; by?: string }) {
  const section = slug(f.section)
  if (!get('select 1 from board_sections where board_id = ? and key = ?', boardId, section)) throw new Error(`No section "${f.section}" on this board. Known: ${sectionsOf(boardId).map(s => s.key).join(', ') || 'none (add sections first)'}`)
  const kind = (FINDING_KINDS as readonly string[]).includes(f.kind ?? '') ? f.kind! : 'note'
  if (!f.title) throw new Error('A finding needs a title')
  run('insert into board_findings (board_id, section, kind, title, expected, observed, evidence, by_, at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    boardId, section, kind, f.title, f.expected ?? null, f.observed ?? null, f.evidence ?? null, f.by ?? null, Date.now())
  return Number(get<any>('select last_insert_rowid() id').id)
}
export const resolveFinding = (id: number) => run('update board_findings set resolved_at = ? where id = ?', Date.now(), id)

const READING_EVERY = 5 * 60_000
async function timingOf(boardId: string, s: SectionInput) {
  if (!s.timing?.hogql) return null
  try {
    const r = await data({ source: 'posthog', hogql: s.timing.hogql })
    const row = r.v?.rows?.[0] ?? []
    const value = Number(row[0]), p95 = row[1] == null ? null : Number(row[1])
    if (!Number.isFinite(value)) return { error: 'The timing query returned no number', expected_ms: s.timing.expected_ms ?? null, what: s.timing.what ?? null }
    const last = get<any>('select at from board_section_readings where board_id = ? and section = ? order by at desc limit 1', boardId, s.key)
    if (!last || r.at - last.at >= READING_EVERY) run('insert into board_section_readings (board_id, section, value, p95, at) values (?, ?, ?, ?, ?)', boardId, s.key, value, Number.isFinite(p95) ? p95 : null, r.at)
    return { value, p95: Number.isFinite(p95) ? p95 : null, at: r.at, expected_ms: s.timing.expected_ms ?? null, what: s.timing.what ?? null }
  } catch (e: any) { return { error: String(e?.message ?? e).slice(0, 200), expected_ms: s.timing.expected_ms ?? null, what: s.timing.what ?? null } }
}

const titleOf = (u: string) => get<any>('select title from prs where url = ?', u)?.title ?? null
function prsFor(s: SectionInput, ws: any) {
  const urls = new Set<string>(s.prs ?? [])
  if (s.pr_match) {
    const re = new RegExp(s.pr_match, 'i'), since = Date.now() - 60 * 86400_000
    for (const r of all<any>("select url, title from prs where authored = 1 and coalesce(updated_at, 0) > ? and state != 'CLOSED'", since)) if (re.test(r.title ?? '')) urls.add(r.url)
  }
  for (const p of ws?.prs ?? []) urls.add(p.url)
  const order: Record<string, number> = { 'needs you': 0, 'CI red': 1, 'changes requested': 2, 'ready: merge is yours': 3, 'ready to merge': 4, 'in review': 5, 'waiting on another PR': 6, 'merged, deploying': 7, 'live, second check due': 8, verified: 9, proven: 10, closed: 11 }
  return [...urls].map(u => { const p = prInfo(u); return { url: u, title: p.title ?? titleOf(u), phase: phaseOf(p) } })
    .sort((a, b) => (order[a.phase] ?? 6) - (order[b.phase] ?? 6))
}

// Everything the overlay draws for one board.
export async function archOf(boardId: string) {
  const sections = sectionsOf(boardId)
  if (!sections.length) return { sections: [] }
  const projects = new Map<string, any>()
  const wsOf = (s: SectionInput) => {
    if (!s.project || !s.workstream) return null
    if (!projects.has(s.project)) projects.set(s.project, projectStatus(s.project))
    return projects.get(s.project)?.workstreams?.find((w: any) => w.key === slug(s.workstream!)) ?? null
  }
  const timings = await Promise.all(sections.map(s => timingOf(boardId, s)))
  const out = sections.map((s, i) => {
    const ws = wsOf(s), timing = timings[i]
    const findings = all<any>('select id, kind, title, expected, observed, evidence, by_ by, at from board_findings where board_id = ? and section = ? and resolved_at is null order by at desc', boardId, s.key)
    // A measurement that breaks the design's assumption is a finding on its own.
    if (timing && 'value' in timing && timing.expected_ms && timing.value! > timing.expected_ms * 1.5)
      findings.unshift({ id: null, kind: 'wrong', auto: true, title: `${timing.what ?? 'Latency'} is ${(timing.value! / timing.expected_ms).toFixed(1)}× what the design assumed`, expected: `${fmtMs(timing.expected_ms)}`, observed: `${fmtMs(timing.value!)}${timing.p95 != null ? ` (p95 ${fmtMs(timing.p95)})` : ''}`, evidence: null, by: 'auto-m8', at: timing.at })
    const readings = all<any>('select value, p95, at from board_section_readings where board_id = ? and section = ? order by at desc limit 48', boardId, s.key).reverse()
    return {
      key: s.key, label: s.label ?? s.key, about: s.about ?? null, match: s.match ?? s.label ?? s.key,
      prs: prsFor(s, ws), findings, timing, readings,
      workstream: ws ? { key: ws.key, name: ws.name, north_star: ws.north_star, current: ws.current, target: ws.target, unit: ws.unit, progress: ws.progress, gate: ws.gate, status: ws.status } : null,
      agents: (ws?.agents ?? []).map((a: any) => ({ name: a.name, status: a.status, id: a.id })),
    }
  })
  // The bottleneck: the timed part that takes the most time, and its share of the measured total.
  const timed = out.filter(s => s.timing && 'value' in s.timing && Number.isFinite(s.timing.value))
  const total = timed.reduce((n, s) => n + (s.timing as any).value, 0)
  const worst = timed.reduce<any>((w, s) => !w || (s.timing as any).value > (w.timing as any).value ? s : w, null)
  return {
    sections: out.map(s => {
      const t: any = s.timing
      const share = t && 'value' in t && total ? t.value / total : null
      const ratio = t?.value != null && t.expected_ms ? t.value / t.expected_ms : null
      const state = s.findings.some((f: any) => f.kind === 'wrong') || (ratio != null && ratio > 1.5) ? 'wrong'
        : ratio != null && ratio > 1.15 ? 'slow' : s.prs.some(p => /needs you|CI red|changes requested/.test(p.phase)) ? 'attention'
        : s.prs.some(p => !/verified|proven|closed|merged|live/.test(p.phase)) ? 'building' : s.prs.length || t ? 'ok' : 'idle'
      return { ...s, state, share, ratio, bottleneck: timed.length > 1 && s === worst }
    }),
  }
}
const fmtMs = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`

export function archText(boardId: string, a: Awaited<ReturnType<typeof archOf>>) {
  if (!a.sections.length) return 'This board has no sections yet. Add them with canvas action=sections.'
  const n = (u: string) => u.replace('https://github.com/', '').replace('/pull/', '#')
  return a.sections.map((s: any) => [
    `- ${s.key} "${s.label}" · ${s.state}${s.bottleneck ? ' · BOTTLENECK' : ''}${s.timing?.value != null ? ` · ${fmtMs(s.timing.value)}${s.timing.expected_ms ? ` vs assumed ${fmtMs(s.timing.expected_ms)}` : ''}${s.share != null ? ` (${Math.round(s.share * 100)}% of measured time)` : ''}` : ''}${s.timing?.error ? ` · timing error: ${s.timing.error}` : ''}`,
    ...(s.prs.length ? [`  PRs: ${s.prs.map((p: any) => `${n(p.url)} (${p.phase})`).join(', ')}`] : []),
    ...s.findings.map((f: any) => `  ${f.kind}${f.id ? ` #${f.id}` : ' (auto)'}: ${f.title}${f.expected ? ` | expected ${f.expected}` : ''}${f.observed ? ` | observed ${f.observed}` : ''}`),
  ].join('\n')).join('\n') + `\n(board ${boardId})`
}
