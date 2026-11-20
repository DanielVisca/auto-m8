// Folders: workspaces that group your threads by what they're about (Metrics, MCP analytics, …).
// A folder is a label plus an optional saved search, so a thread can be in it by hand, by
// label, or by matching. The organiser (Claude) creates folders from your history and keeps
// filing new threads into them; folders you edit become yours and it stops touching them.
import { randomUUID } from 'node:crypto'
import { ephemeral, type ChatEvent } from './chat.ts'
import { editLabels, list, normLabel } from './conversations.ts'
import { link } from './context.ts'
import { all, db, get, run } from './db.ts'
import { settings } from './settings.ts'
import { recordError, resolveErrors } from './errors.ts'

db.exec(`create table if not exists folders (
  id text primary key, name text not null, description text, label text not null unique, query text, icon text, cwd text,
  auto integer default 1,        -- 1 = the organiser owns it; 0 = you edited it
  position integer default 0, created_at integer, updated_at integer
)`)

export const onFolders = new Set<() => void>()
const changed = () => onFolders.forEach(f => f())
export const organizerStatus = { running: false, lastRun: 0, error: '' }

const memberQuery = (f: any) => f.query?.trim() ? f.query : `#${f.label}`

export function folders() {
  return all<any>('select * from folders order by position, name').map(f => {
    const { conversations, counts } = list({ q: `${memberQuery(f)} is:any`, limit: 500, focus: false })
    return {
      ...f, n: conversations.filter(c => !['archived', 'hidden'].includes(c.effective)).length,
      waiting: counts.waiting ?? 0, running: counts.running ?? 0,
      updated_at: Math.max(0, ...conversations.map(c => c.updated_at)),
    }
  })
}

export function folder(id: string) {
  const f = get<any>('select * from folders where id = ?', id)
  if (!f) return null
  const { conversations } = list({ q: `${memberQuery(f)} is:any`, limit: 500, focus: false, sort: 'updated' })
  return { ...f, conversations: conversations.filter(c => c.effective !== 'hidden') }
}

// Folder icons are one emoji. Models sometimes answer with the emoji's name ("chart", "bird"):
// map the common ones, otherwise fall back to a folder, so a word never spills over the name.
const NAMED: Record<string, string> = { chart: '📊', graph: '📈', bird: '🐦', bug: '🐛', rocket: '🚀', gear: '⚙️', tools: '🛠️', wrench: '🔧', book: '📚', brain: '🧠', robot: '🤖', search: '🔎', lock: '🔒', bell: '🔔', fire: '🔥', star: '⭐', folder: '📁', mail: '✉️', chat: '💬', clock: '⏰', money: '💰', test: '🧪', package: '📦', link: '🔗', eye: '👀', shield: '🛡️', database: '🗄️', server: '🖥️', paint: '🎨', pencil: '✏️', calendar: '📅', people: '👥', person: '🧑', team: '👥', metrics: '📈', dashboard: '📊', telescope: '🔭', microscope: '🔬', lightning: '⚡', puzzle: '🧩', sparkles: '✨', hammer: '🔨', key: '🔑', map: '🗺️', flag: '🚩', target: '🎯', hedgehog: '🦔' }
export function cleanIcon(icon: unknown): string {
  const v = String(icon ?? '').trim()
  if (!v) return '📁'
  if (/^[\x00-\x7F]+$/.test(v)) return NAMED[v.toLowerCase().replace(/[^a-z]/g, '')] ?? '📁'
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(v)][0]?.segment ?? '📁'
}

export function saveFolder(f: { id?: string; name: string; description?: string; query?: string; icon?: string; cwd?: string }) {
  const id = f.id ?? randomUUID()
  const existing = get<any>('select * from folders where id = ?', id)
  const label = existing?.label ?? normLabel(f.name)
  run(`insert into folders (id, name, description, label, query, icon, cwd, auto, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       on conflict(id) do update set name = excluded.name, description = excluded.description, query = excluded.query, icon = excluded.icon,
         cwd = excluded.cwd, auto = 0, updated_at = excluded.updated_at`,
    id, f.name, f.description ?? existing?.description ?? null, label, f.query ?? existing?.query ?? null, f.icon != null ? cleanIcon(f.icon) : existing?.icon ?? '📁', f.cwd ?? existing?.cwd ?? null, Date.now(), Date.now())
  changed()
  return id
}

export function deleteFolder(id: string, keepLabels = true) {
  const f = get<any>('select * from folders where id = ?', id)
  if (!f) return
  run('delete from folders where id = ?', id)
  if (!keepLabels) run('delete from labels where label = ? and auto = 1', f.label)
  changed()
}

// Threads worth organising: yours, recent, not hidden or automated.
function candidates(onlyUnfiled: boolean) {
  const labels = new Set(all<any>('select label from folders').map(f => f.label))
  return list({ q: 'newer:180d', limit: 400, focus: false }).conversations
    .filter(c => !c.automated && c.effective !== 'hidden')
    .filter(c => !onlyUnfiled || !c.labels.some((l: string) => labels.has(l)))
    .slice(0, onlyUnfiled ? 120 : 260)
}

const line = (c: any) => `- ${c.id} | ${String(c.title ?? c.first_prompt ?? '').slice(0, 110)} | ${c.source}${c.cwd ? ' ' + c.cwd.split('/').pop() : ''}${c.branch && !['main', 'master'].includes(c.branch) ? ' @' + c.branch : ''}${c.labels.length ? ' #' + c.labels.join(' #') : ''}${c.prs.length ? ' PRs: ' + c.prs.map((p: any) => (p.title ?? '#' + p.number)).join('; ').slice(0, 120) : ''}`

const PROMPT = `You organise an engineer's agent conversations into folders: workstreams they would want to open as a workspace (for example "Metrics", "MCP analytics", "Dashboards 2.0", "Infra / charts"). Folders are about WHAT the work is, not where it ran.

Reply with ONLY JSON:
{"folders": [{"name": "Short Name", "label": "kebab-case", "icon": "one emoji", "description": "one line: what this workstream is", "cwd": "the main repo folder if obvious, else empty", "assign": ["conversation ids"]}],
 "retire": ["labels of existing organiser folders that no longer make sense"]}
Rules: 4-10 folders. Reuse existing folders (same label) wherever they fit, and add new ones only for real workstreams with 3+ threads. A thread goes in at most one folder; leave one-off threads unassigned. Don't create a folder for tests, smoke checks or trivia.`

const ADD_PROMPT = `File these new conversations into the existing folders where they clearly belong, and connect conversations that continue the same piece of work (the same PR, bug, feature or question picked up again). Reply with ONLY JSON:
{"assign": {"<label>": ["conversation ids"]}, "new": [{"name": "...", "label": "...", "icon": "...", "description": "...", "assign": ["ids"]}], "links": [["new conversation id", "earlier conversation id it continues"]]}
Propose a new folder only for 3+ threads of one new workstream. Only link when it is clearly the same work. Leave the rest alone.`

export function organizerReply(result: ChatEvent | undefined, done: ChatEvent): any {
  const out = String(result?.result ?? '')
  if (result?.is_error || done.error || done.code !== 0) {
    const error = out || done.error || result?.error || result?.errors?.join('\n') || `Folder model exited with ${done.code ?? 'no status'}`
    return { error: String(error).slice(0, 300) }
  }
  try { return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) }
  catch { return { error: `unreadable reply: ${(out || 'empty').slice(0, 300)}` } }
}

function ask(prompt: string): Promise<any> {
  return new Promise(resolve => {
    let result: ChatEvent | undefined
    ephemeral(['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', settings.ai.model, '--no-session-persistence',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk'], settings.chat.cwd, ev => {
      if (ev.type === 'result') result = ev
      if (ev.type === 'perch_done') resolve(organizerReply(result, ev))
    })
  })
}

function upsertAuto(f: any) {
  const label = normLabel(f.label || f.name)
  const existing = get<any>('select * from folders where label = ?', label)
  if (existing && existing.auto === 0) return label // yours: the organiser only files into it
  if (existing) run('update folders set name = ?, description = ?, icon = ?, cwd = coalesce(nullif(?, \'\'), cwd), updated_at = ? where id = ?', f.name, f.description ?? existing.description, f.icon ? cleanIcon(f.icon) : existing.icon, f.cwd ?? '', Date.now(), existing.id)
  else run('insert into folders (id, name, description, label, icon, cwd, auto, created_at, updated_at) values (?, ?, ?, ?, ?, ?, 1, ?, ?)', randomUUID(), f.name, f.description ?? null, label, cleanIcon(f.icon), f.cwd || null, Date.now(), Date.now())
  return label
}

// Full pass: (re)build the folder set from recent history. Incremental pass: only new threads.
export async function organize(full = !get('select 1 from folders')) {
  if (organizerStatus.running) return { error: 'already running' }
  organizerStatus.running = true
  changed()
  try {
    const existing = folders().map(f => `- ${f.label}: ${f.name} (${f.n} threads, ${f.auto ? 'organiser' : 'user'}) ${f.description ?? ''}`).join('\n') || 'none'
    const conv = candidates(!full)
    if (!conv.length) return { filed: 0 }
    const earlier = full ? [] : candidates(false).filter(c => !conv.some(x => x.id === c.id)).slice(0, 80)
    const r = await ask(`${full ? PROMPT : ADD_PROMPT}\n\n## Existing folders\n${existing}\n\n## ${full ? 'Conversations' : 'New conversations'}\n${conv.map(line).join('\n')}${earlier.length ? `\n\n## Earlier conversations (for links only)\n${earlier.map(line).join('\n')}` : ''}`)
    if (r.error) { organizerStatus.error = recordError('Organiser', new Error(String(r.error)), 'Organising folders').message; return r }
    resolveErrors('Organiser')
    const valid = new Set(conv.map(c => c.id))
    void earlier
    let filed = 0
    const file = (label: string, ids: string[]) => {
      const ok = (ids ?? []).filter(id => valid.has(id))
      if (ok.length) { editLabels(ok, [label], [], 1); filed += ok.length }
    }
    for (const f of [...(r.folders ?? []), ...(r.new ?? [])]) file(upsertAuto(f), f.assign)
    for (const [label, ids] of Object.entries(r.assign ?? {})) if (get('select 1 from folders where label = ?', label)) file(label, ids as string[])
    // Connections between threads of the same work, made automatically (shown in the details panel).
    const known = new Set(all<any>('select id from conversations').map(c => c.id))
    for (const [a, b] of (r.links ?? []) as string[][]) if (known.has(a) && known.has(b) && a !== b) link(a, b, 'related', 'same work (organiser)')
    for (const label of r.retire ?? []) {
      const f = get<any>('select * from folders where label = ? and auto = 1', label)
      if (f) deleteFolder(f.id, false)
    }
    organizerStatus.error = ''
    return { filed, folders: (r.folders ?? r.new ?? []).length }
  } finally {
    organizerStatus.running = false
    organizerStatus.lastRun = Date.now()
    changed()
  }
}

// Always on: a full pass the first time, then filing new threads whenever 5+ are unfiled.
export function startOrganizer() {
  const tick = () => {
    if (organizerStatus.running) return
    if (!get('select 1 from folders')) organize(true)
    else if (Date.now() - organizerStatus.lastRun > 10 * 60_000 && candidates(true).length >= 1) organize(false)
  }
  setTimeout(tick, 60_000).unref()
  setInterval(tick, 5 * 60_000).unref()
}

// Icons saved before cleanIcon existed.
for (const f of all<any>('select id, icon from folders')) { const c = cleanIcon(f.icon); if (c !== f.icon) run('update folders set icon = ? where id = ?', c, f.id) }
