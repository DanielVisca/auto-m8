// Sections for your open PRs, like folders: Claude groups them into workstreams once ("Metrics
// ingestion", "MCP analytics", "Canvas", "Personal & old repos"), and after that each new PR is
// filed into an existing section (or a new one when it really is new work). You can move a PR by
// hand and that sticks. Until Claude answers, a PR sits under its code area.
import { cleanIcon } from './folders.ts'
import { all, db, get, run } from './db.ts'
import { ephemeral } from './chat.ts'
import { settings } from './settings.ts'

db.exec(`
create table if not exists pr_sections (url text primary key, section text not null, manual integer default 0, at integer);
create table if not exists pr_section_meta (name text primary key, icon text, ord integer default 0);
`)

export const onPrSections = new Set<() => void>()
export type SectionInput = { url: string; title: string; repo: string; area: string; folder: string | null; updatedAt: number }

let running = false
let lastAsked = ''

export function sectionsFor(prs: SectionInput[]) {
  const have = new Map(all<any>('select url, section from pr_sections').map(r => [r.url, r.section]))
  const meta = new Map(all<any>('select name, icon, ord from pr_section_meta').map(r => [r.name, r]))
  const missing = prs.filter(p => !have.has(p.url))
  if (missing.length && !running) void organise(prs, missing)
  return {
    sorting: running,
    of: (url: string) => have.get(url) ?? null,
    meta: (name: string) => meta.get(name) ?? null,
  }
}

export function moveToSection(url: string, section: string, icon?: string) {
  run('insert into pr_sections (url, section, manual, at) values (?, ?, 1, ?) on conflict(url) do update set section = excluded.section, manual = 1, at = excluded.at', url, section.trim(), Date.now())
  if (!get('select 1 from pr_section_meta where name = ?', section.trim())) run('insert into pr_section_meta (name, icon, ord) values (?, ?, 99)', section.trim(), cleanIcon(icon ?? '📁'))
  for (const l of onPrSections) l()
}

// Re-sort everything Claude filed (your manual moves stay).
export function resortSections() {
  run('delete from pr_sections where manual = 0')
  lastAsked = ''
  for (const l of onPrSections) l()
}

const line = (p: SectionInput) => `- ${p.url} | ${p.repo} | area: ${p.area}${p.folder ? ` | auto-m8 folder: ${p.folder}` : ''} | ${p.title.slice(0, 110)} | updated ${new Date(p.updatedAt).toISOString().slice(0, 10)}`

function organise(prs: SectionInput[], missing: SectionInput[]) {
  const key = missing.map(p => p.url).sort().join(',')
  if (key === lastAsked) return // asked already and Claude left these out: don't loop
  lastAsked = key
  running = true
  for (const l of onPrSections) l()
  const existing = all<any>(`select m.name, m.icon, count(s.url) n from pr_section_meta m left join pr_sections s on s.section = m.name group by m.name order by m.ord`)
  const first = !existing.length
  const prompt = `You sort a developer's open pull requests into sidebar sections, like folders, one per workstream.
${first ? `Make 4-9 sections from all of these PRs.` : `Existing sections (reuse them; add a new one only for clearly new work with 2+ PRs):\n${existing.map(s => `- ${s.icon} ${s.name} (${s.n} PRs)`).join('\n')}\n\nFile only these new PRs.`}
Rules:
- Name a section after the product or workstream, short (1-3 words), e.g. "Metrics ingestion", "Metrics UI", "MCP analytics", "Canvas", "Logs & traces".
- The conventional-commit scope in the title (feat(metrics-ingestion): ...) is the strongest hint; the auto-m8 folder and code area help.
- Work in the same product across repos (posthog, charts, posthog.com docs) belongs together.
- Personal, school or long-dormant repos go in one section named "Personal & old".
- Every PR gets exactly one section.
Reply with ONLY JSON: {"sections": [{"name": "...", "icon": "one emoji"}], "assign": {"<pr url>": "<section name>"}}

PRs:
${(first ? prs : missing).map(line).join('\n')}`
  return new Promise<void>(resolve => {
    let out = ''
    ephemeral(['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', settings.ai.model, '--no-session-persistence',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk'], settings.chat.cwd, ev => {
      if (ev.type === 'result') out = String(ev.result ?? '')
      if (ev.type !== 'perch_done') return
      try {
        const v = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
        const ord = (get<any>('select max(ord) m from pr_section_meta')?.m ?? -1) + 1
        ;(v.sections ?? []).forEach((s: any, i: number) => {
          if (s?.name) run('insert into pr_section_meta (name, icon, ord) values (?, ?, ?) on conflict(name) do nothing', String(s.name).trim(), cleanIcon(String(s.icon ?? '📁')).slice(0, 8), ord + i)
        })
        for (const [url, name] of Object.entries(v.assign ?? {})) {
          if (typeof name !== 'string' || !prs.some(p => p.url === url)) continue
          if (!get('select 1 from pr_section_meta where name = ?', name.trim())) run('insert into pr_section_meta (name, icon, ord) values (?, ?, 98)', name.trim(), cleanIcon('📁'))
          run('insert into pr_sections (url, section, manual, at) values (?, ?, 0, ?) on conflict(url) do update set section = excluded.section, at = excluded.at where manual = 0', url, name.trim(), Date.now())
        }
      } catch {}
      running = false
      for (const l of onPrSections) l()
      resolve()
    })
  })
}
