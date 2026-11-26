// A folder's canvas: tiles on a board. Web pages, chats, terminals, notes, and small apps
// ("code tiles") that Claude writes on request. Code tiles run sandboxed in the page and get
// data only through perch (data() below), so tokens and keys never reach tile code.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { ephemeral } from './chat.ts'
import { all, db, get, run } from './db.ts'
import { posthogFetch } from './indexer.ts'
import { settings } from './settings.ts'
import { ghExec } from './gh.ts'

const exec = promisify(execFile)
db.exec(`create table if not exists canvas_tiles (
  id text primary key, folder_id text not null, kind text not null,
  x integer not null, y integer not null, w integer not null, h integer not null,
  config text not null default '{}', state text, error text, updated_at integer
)`)

export const onCanvas = new Set<() => void>()
const changed = () => onCanvas.forEach(f => f())
export type Tile = { id: string; folder_id: string; kind: 'web' | 'chat' | 'term' | 'note' | 'code' | 'browser' | 'plan'; x: number; y: number; w: number; h: number; config: any; state: any; error: string | null }
const parse = (r: any): Tile => ({ ...r, config: JSON.parse(r.config ?? '{}'), state: r.state ? JSON.parse(r.state) : null })

export const tiles = (folderId: string) => all<any>('select * from canvas_tiles where folder_id = ? order by y, x', folderId).map(parse)

export function saveTile(t: Partial<Tile> & { folder_id: string; kind: Tile['kind'] }) {
  const id = t.id ?? randomUUID()
  const old = get<any>('select * from canvas_tiles where id = ?', id)
  if (t.id && !old) throw new Error('This tile was removed or its board expired')
  // New tiles go below everything else on the board.
  const y = t.y ?? old?.y ?? (Number(get<any>('select max(y + h) m from canvas_tiles where folder_id = ?', t.folder_id)?.m) || 0)
  run(`insert into canvas_tiles (id, folder_id, kind, x, y, w, h, config, state, error, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h, config = excluded.config, state = excluded.state, error = excluded.error, updated_at = excluded.updated_at`,
    id, t.folder_id, t.kind, t.x ?? old?.x ?? 0, y, t.w ?? old?.w ?? 6, t.h ?? old?.h ?? 4,
    JSON.stringify(t.config ?? (old ? JSON.parse(old.config) : {})), t.state !== undefined ? JSON.stringify(t.state) : old?.state ?? null,
    t.error !== undefined ? t.error : old?.error ?? null, Date.now())
  changed()
  return parse(get<any>('select * from canvas_tiles where id = ?', id))
}
export const removeTile = (id: string) => { run('delete from canvas_tiles where id = ?', id); changed() }

// The only door a code tile has to the outside. Read-only on purpose.
// Stale-while-revalidate: a tile gets the last answer at once (kept on disk, so it survives
// restarts) and, if that answer is older than FRESH_MS, perch refetches in the background and
// tells tiles (event 'canvasdata') when the result changed. One fetch per query at a time.
db.exec(`create table if not exists canvas_data_cache (key text primary key, v text not null, at integer not null)`)
const FRESH_MS = 5_000
const cache = new Map<string, { at: number; v: any; json: string }>()
const inflight = new Map<string, Promise<any>>()
export const onCanvasData = new Set<() => void>()
function remembered(key: string) {
  let hit = cache.get(key)
  if (!hit) { const r = get<any>('select v, at from canvas_data_cache where key = ?', key); if (r) { hit = { at: r.at, v: JSON.parse(r.v), json: r.v }; cache.set(key, hit) } }
  return hit
}
function refetch(key: string, q: any) {
  let p = inflight.get(key)
  if (p) return p
  p = fetchSource(q).then(v => {
    const json = JSON.stringify(v), old = cache.get(key)
    const at = Date.now()
    cache.set(key, { at, v, json })
    if (json.length < 2_000_000) run('insert into canvas_data_cache (key, v, at) values (?, ?, ?) on conflict(key) do update set v = excluded.v, at = excluded.at', key, json, at)
    // A snapshot's own timestamp isn't a change worth waking tiles for.
    const same = (a: string, b: string) => a.replace(/^\{"at":\d+,/, '{') === b.replace(/^\{"at":\d+,/, '{')
    if (old && !same(old.json, json)) onCanvasData.forEach(f => f())
    return { v, at }
  }).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}
export async function data(q: any): Promise<{ v: any; at: number; stale: boolean }> {
  const key = JSON.stringify(q)
  const hit = remembered(key)
  if (hit) {
    const stale = Date.now() - hit.at > FRESH_MS
    if (stale) refetch(key, q).catch(() => {})
    return { v: hit.v, at: hit.at, stale }
  }
  const r = await refetch(key, q)
  return { v: r.v, at: r.at, stale: false }
}
async function fetchSource(q: any) {
  let v: any
  if (q.source === 'posthog') {
    const r: any = await posthogFetch(`/api/projects/${settings.posthog.projectId}/query/`, { method: 'POST', body: JSON.stringify({ query: { kind: 'HogQLQuery', query: String(q.hogql ?? q.query ?? '') } }) })
    v = { columns: r.columns, rows: r.results, types: r.types }
  } else if (q.source === 'github') {
    const path = String(q.path ?? '')
    if (!/^[\w./?&=%:+,-]+$/.test(path) || path.startsWith('-')) throw new Error('GitHub path should look like repos/OWNER/REPO/pulls?state=open')
    v = JSON.parse((await ghExec(['api', path, '--method', 'GET'], { maxBuffer: 20e6, timeout: 30_000 })).stdout)
  } else if (q.source === 'http') {
    const url = String(q.url ?? '')
    if (!/^https?:\/\//.test(url)) throw new Error('http needs a full http(s) URL')
    const r = await fetch(url, { headers: { Accept: 'application/json, text/plain, */*' }, signal: AbortSignal.timeout(20_000) })
    const text = await r.text()
    try { v = JSON.parse(text) } catch { v = text.slice(0, 500_000) }
  } else if (q.source === 'perch') {
    const path = String(q.path ?? '')
    if (!path.startsWith('/api/')) throw new Error("source 'perch' paths start with /api/")
    const port = process.env.PERCH_PORT ?? 4777
    v = await (await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Host: `127.0.0.1:${port}` } })).json()
  } else throw new Error(`Unknown source "${q.source}". Use posthog, github, http or perch (auto-m8's own data).`)
  return v
}

const MAKER = `You write small single-file web apps ("tiles") that live on a dashboard canvas inside auto-m8.
Reply with one line of JSON, then the app in one \`\`\`html block. Nothing else.
{"title": "short name", "refresh": seconds between refreshes, or 0 if it never needs one}

The app runs in a sandboxed iframe: plain HTML/CSS/JS, no build step. Prefer no libraries (SVG or canvas for charts). If you need one, load it from cdnjs.cloudflare.com with an exact version.
It talks to the outside only through this API, already on the page (it is called perch for historical reasons; keep the names exactly):
- await perch.data({ source: 'posthog', hogql: 'select … from events where timestamp > now() - interval 1 day …' }) → { columns, rows }
- await perch.data({ source: 'github', path: 'repos/PostHog/posthog/pulls?state=open&per_page=50' }) → GitHub REST JSON (GET only)
- await perch.data({ source: 'http', url: 'https://…' }) → JSON (or text)
- await perch.data({ source: 'perch', path: '/api/home' }) → auto-m8's own data: /api/home (needsMe, running), /api/insights/prs (your PRs with area and outcome), /api/conversations?q=…
- perch.state: whatever you saved last time (or null); await perch.save(obj) saves it.
- perch.onRefresh(fn): fn runs every refresh interval; call your load function there and once at start.
- Colours: use the CSS variables --bg --fg --muted --line --accent (light and dark are set for you). Body margin 0, font inherits.
For architecture or flow diagrams, put data-section="<short-key>" on the element (box, rect, group) that draws each part of the system: auto-m8 then draws that part's PRs, findings and measured timings over it.
Fill the whole tile (it can be any size; keep it legible at 320×200). Show a short loading state, and on errors show the message in the tile: never fail silently.`

export function makeTile(input: { folder_id: string; ask: string; tile_id?: string; html?: string; error?: string }, beforeSave?: () => void): Promise<Tile> {
  const fix = input.html ? `\n\nThis is the current tile. ${input.error ? `It fails with: ${input.error}\n` : ''}Change it as asked, keeping what works:\n\`\`\`html\n${input.html}\n\`\`\`` : ''
  return new Promise((resolve, reject) => {
    let out = ''
    ephemeral(['-p', `${MAKER}\n\nThe user wants: ${input.ask}${fix}`, '--output-format', 'stream-json', '--verbose', ...(settings.chat.model ? ['--model', settings.chat.model] : []),
      '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk'], settings.chat.cwd, ev => {
      if (ev.type === 'result') out = String(ev.result ?? '')
      if (ev.type !== 'perch_done') return
      const html = out.match(/```html\s*([\s\S]*?)```/)?.[1]
      if (!html) return reject(new Error('Claude didn’t return a tile. Try saying more about what it should show.'))
      let meta: any = {}
      try { meta = JSON.parse(out.slice(out.indexOf('{'), out.indexOf('}') + 1)) } catch {}
      const old = input.tile_id ? get<any>('select config from canvas_tiles where id = ?', input.tile_id) : null
      try {
        beforeSave?.()
        resolve(saveTile({ id: input.tile_id, folder_id: input.folder_id, kind: 'code', error: null,
          config: { ...(old ? JSON.parse(old.config) : {}), title: meta.title ?? input.ask.slice(0, 40), refresh: Number(meta.refresh) || 0, html, ask: input.ask } }))
      } catch (e) { reject(e) }
    })
  })
}

// A tile reports how its last run went; autopilot and Home read this.
export const reportTile = (id: string, error: string | null) => { run('update canvas_tiles set error = ? where id = ?', error ? error.slice(0, 500) : null, id); changed() }
