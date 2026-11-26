// Sharing a board somewhere other people can open it. auto-m8 stays the source of truth: a share
// is a one-way publish that translates the board into what the target needs. Each target uses its
// platform's own permissions, versions and state rather than inventing ours:
//   posthog: a PostHog canvas. Who can see it = the PostHog channel it lives in (your private
//   channel by default). Versions, drafts and revert = PostHog's canvas versions. Tile state =
//   ph.state (per viewer). Data runs as the viewer, with their own PostHog access.
// More targets (a Claude artifact, ...) plug in by adding to TARGETS.
import { createHash } from 'node:crypto'
import { all, db, get, run } from './db.ts'
import { ensureUser, posthogFetch, posthogStatus } from './indexer.ts'
import { settings } from './settings.ts'
import { board as getBoard } from './boards.ts'
import type { Tile } from './canvas.ts'

db.exec(`create table if not exists board_shares (
  board_id text not null, target text not null, remote_id text not null, url text,
  audience text, audience_label text, version_id text, shared_at integer not null,
  notes text, primary key (board_id, target)
)`)
if (!all<any>('pragma table_info(board_shares)').some(c => c.name === 'source_hash')) db.exec('alter table board_shares add column source_hash text')

export type Audience = { id: string; label: string; kind?: 'private' | 'project' | 'members'; hint?: string; group?: string; private?: boolean }
export type Share = { board_id: string; target: string; remote_id: string; url: string | null; audience: string | null; audience_label: string | null; version_id: string | null; shared_at: number; notes: string[] }
export type ShareResult = Share & { conflict?: boolean }
type Board = NonNullable<ReturnType<typeof getBoard>>
export type Viewer = { name: string; email: string | null; last: number; views: number; now: boolean }
export type ShareStatus = Share & { label: string; local_changes: boolean; remote_changed: boolean; viewers: Viewer[] | null; views: number | null }
type Target = {
  id: string; label: string; about: string
  // Optional: what the other side knows now (edited there? who opened it lately?).
  status?(s: Share): Promise<{ remote_changed: boolean; viewers: Viewer[] | null; views: number | null }>
  available(): Promise<{ ok: boolean; why?: string }>
  audiences(): Promise<Audience[]>
  share(b: Board, opts: { audience?: string; overwrite?: boolean; prev?: Share; created: (remote: { remote_id: string; url: string | null; audience: string | null }) => void }): Promise<Omit<Share, 'board_id' | 'target' | 'shared_at'> & { conflict?: boolean }>
}

const parse = (r: any): Share => { const { source_hash: _h, ...rest } = r; return { ...rest, notes: r.notes ? JSON.parse(r.notes) : [] } }
// What a share depends on: the board's name, about and tiles (layout and content, not their saved state).
export function boardHash(b: { name: string; about?: string | null; tiles: Tile[] }) {
  const tiles = [...b.tiles].sort((x, y) => x.id.localeCompare(y.id)).map(t => ({ id: t.id, kind: t.kind, x: t.x, y: t.y, w: t.w, h: t.h, config: t.config }))
  return createHash('sha1').update(JSON.stringify({ name: b.name, about: b.about ?? '', tiles })).digest('hex')
}
export const sharesOf = (boardId: string): Share[] => all<any>('select * from board_shares where board_id = ? order by shared_at desc', boardId).map(parse)

// ---------- Translation: a board as a PostHog canvas source project ----------
// Canvases are built React projects with a strict CSP (no inline scripts, no CDNs, no network),
// so each code tile's markup goes into a shadow root and its scripts become a bundled module that
// gets a `perch` shim: posthog queries run live through ph.query; other sources (GitHub, http,
// auto-m8's own API) can't be reached from PostHog, so they ship as a snapshot of the last answer.
const LIBS: Record<string, { pkg: string; name: string; star?: boolean }> = {
  d3: { pkg: 'd3', name: 'd3', star: true }, three: { pkg: 'three', name: 'THREE', star: true }, dayjs: { pkg: 'dayjs', name: 'dayjs' },
  lodash: { pkg: 'lodash-es', name: '_', star: true }, papaparse: { pkg: 'papaparse', name: 'Papa' },
}
type Translated = { project: any; notes: string[]; usesState: boolean }

// PostHog's platform stylesheet owns names like --muted, so the tile palette gets its own prefix.
const TOKENS = /--(bg|fg|muted|line|accent|ok|bad|warn)\b/g
const retoken = (s: string) => s.replace(TOKENS, '--am-$1')

export function splitTile(html: string) {
  html = retoken(html)
  const scripts: string[] = [], external: string[] = []
  const markup = html
    .replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_m, attrs: string, body: string) => {
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]
      if (src) external.push(src); else if (!/type\s*=\s*["']application\/(ld\+)?json/i.test(attrs)) scripts.push(body)
      return ''
    })
    .replace(/<!doctype[^>]*>/gi, '').replace(/<\/?(html|head|body)\b[^>]*>/gi, '').replace(/<meta\b[^>]*>/gi, '').replace(/<title>[\s\S]*?<\/title>/gi, '')
    // Inside a shadow root: :root/html rules mean the tile's host, body rules its body wrapper.
    .replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_m, a: string, css: string) => `<style${a}>${css.replace(/(^|[\s,}])(:root|html|body)(?=[\s,{.:#[])/g, (_x, pre: string, sel: string) => pre + (sel === 'body' ? '.tile-body' : ':host'))}</style>`)
  return { markup: markup.trim(), scripts, external }
}

// PostHog validates canvas files with plain-text patterns, so prose in a tile ("…rules import'],")
// reads as an import statement. A function body can't hold a static import or a <script> tag
// outside a string or comment, so escaping one letter there changes nothing at runtime.
// Data files (JSON) can be escaped freely: \u escapes decode to the same text.
export const defuseCode = (js: string) => js.replace(/\b(imp)o(rt\s*['"])/g, '$1\\u006f$2').replace(/\b(fr)o(m\s*['"])/g, '$1\\u006f$2').replace(/<(script)/gi, '\\u003c$1')
export const jsonFile = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\b(imp|fr|fetch|requir|XMLHttpReq)([oe]?)/g, (m: string) => m.slice(0, -1) + '\\u' + m.charCodeAt(m.length - 1).toString(16).padStart(4, '0'))

function libFor(src: string) {
  const name = Object.keys(LIBS).find(k => new RegExp(`[/@.-]${k}([@./-]|$)`, 'i').test(src))
  return name ? LIBS[name] : null
}

// The last answers auto-m8 has for a tile's non-PostHog queries, matched by what the tile's code mentions.
function snapshotsFor(html: string) {
  const out: Record<string, any> = {}
  for (const r of all<any>('select key, v, at from canvas_data_cache')) {
    let q: any; try { q = JSON.parse(r.key) } catch { continue }
    if (!q || q.source === 'posthog') continue
    const where = String(q.path ?? q.url ?? '').split('?')[0]
    if (where && html.includes(where) && r.v.length < 400_000) out[r.key] = { v: JSON.parse(r.v), at: r.at }
  }
  return out
}

const RUNTIME = `import { ph } from '@posthog/canvas-sdk'
// auto-m8's tile API ("perch") on top of PostHog's canvas SDK.
export function makePerch(tile, snapshots, note) {
  const subs = []
  const base = s => String(s || '').split('?')[0]
  const perch = {
    vars: {}, state: null,
    async data(q) {
      q = q || {}
      if (q.source === 'posthog') {
        const r = await ph.query(String(q.hogql ?? q.query ?? ''))
        return { columns: r.columns || [], rows: r.results || [], types: r.types }
      }
      const key = JSON.stringify(q)
      const hit = snapshots[key] || Object.entries(snapshots).map(([k, v]) => [JSON.parse(k), v]).find(([k]) => k.source === q.source && base(k.path || k.url) === base(q.path || q.url))?.[1]
      if (hit) { note(hit.at); return hit.v }
      throw new Error('This data (' + (q.source || '?') + ') is only live in auto-m8')
    },
    async save(o) { perch.state = o; try { await ph.state.set('tile:' + tile, o) } catch {} },
    onRefresh(f) { subs.push(f) },
    async run() {}, ok() {},
  }
  // Saved state is a nicety: never hold the tile back more than a moment waiting for it.
  const load = async () => { try { perch.state = (await Promise.race([ph.state.get('tile:' + tile), new Promise(ok => setTimeout(() => ok(null), 1500))])) ?? null } catch {} }
  const refresh = () => subs.forEach(f => { try { const p = f(); if (p && p.catch) p.catch(e => console.error(e)) } catch (e) { console.error(e) } })
  return { perch, load, refresh }
}
// The tile's own document: lookups stay inside its shadow root.
export function scopedDocument(root) {
  return new Proxy(document, {
    get(t, k) {
      if (k === 'getElementById') return id => root.getElementById(id)
      if (k === 'querySelector') return s => root.querySelector(s)
      if (k === 'querySelectorAll') return s => root.querySelectorAll(s)
      if (k === 'getElementsByClassName') return c => root.querySelectorAll('.' + String(c).trim().split(/\\s+/).join('.'))
      if (k === 'getElementsByTagName') return n => root.querySelectorAll(n)
      if (k === 'body') return root.firstElementChild
      const v = Reflect.get(t, k)
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
}
`

const APP = `import React, { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import BOARD from './board.json'
import SNAPSHOTS from './snapshots.json'
import TILES from './tiles/index.js'
import { makePerch, scopedDocument } from './perch.js'

const ROW = 56, GAP = 8
const THEME = ':host{--am-bg:#fff;--am-fg:#1d1f27;--am-muted:#6b6f7b;--am-line:#e3e4e8;--am-accent:#1d4aff;--am-ok:#2f9e44;--am-bad:#e03131;--am-warn:#f08c00;display:block;height:100%;background:var(--am-bg);color:var(--am-fg);font:12.5px -apple-system,BlinkMacSystemFont,system-ui,sans-serif}:host-context(.dark){--am-bg:#1d1f27;--am-fg:#eceef2;--am-muted:#9a9eab;--am-line:#34363f;--am-accent:#7b9bff}a{color:var(--am-accent)}'

function CodeTile({ t }) {
  const host = useRef(null)
  const [snapAt, setSnapAt] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    const el = host.current
    if (!el || el.shadowRoot) return
    const root = el.attachShadow({ mode: 'open' })
    root.innerHTML = '<style>' + THEME + '</style><div class="tile-body" style="height:100%;overflow:auto">' + t.markup + '</div>'
    const run = TILES[t.id]
    if (!run) return
    const { perch, load, refresh } = makePerch(t.id, SNAPSHOTS[t.id] || {}, at => setSnapAt(at))
    const doc = scopedDocument(root)
    const win = new Proxy(window, { get: (w, k) => k === 'perch' ? perch : k === 'document' ? doc : (typeof w[k] === 'function' ? w[k].bind(w) : w[k]) })
    let timer
    load().then(() => run(doc, win, perch)).then(() => {
      refresh()
      if (t.refresh) timer = setInterval(refresh, Math.max(30, t.refresh) * 1000)
    }).catch(e => setErr(String(e && e.message || e)))
    return () => timer && clearInterval(timer)
  }, [])
  return <>
    <div ref={host} style={{ flex: 1, minHeight: 0 }} />
    {err && <div style={{ color: '#e03131', fontSize: 11, padding: 4 }}>{err}</div>}
    {snapAt && <div style={{ fontSize: 10, opacity: 0.6, padding: '2px 6px' }}>Some data is a snapshot from auto-m8, {new Date(snapAt).toLocaleString()}</div>}
  </>
}

function TileBody({ t }) {
  if (t.kind === 'code' && t.markup != null) return <CodeTile t={t} />
  if (t.kind === 'note') return <div style={{ padding: 10, overflow: 'auto' }}><ReactMarkdown>{t.text || ''}</ReactMarkdown></div>
  return <div style={{ padding: 12, opacity: 0.7, fontSize: 12 }}>{t.placeholder}</div>
}

export default function Canvas() {
  const [w, setW] = useState(window.innerWidth)
  useEffect(() => { const f = () => setW(window.innerWidth); addEventListener('resize', f); return () => removeEventListener('resize', f) }, [])
  const stacked = w < 640
  const colW = (w - 24 - GAP * 11) / 12
  const height = Math.max(200, ...BOARD.tiles.map(t => (t.y + t.h) * (ROW + GAP)))
  return (
    <div style={{ padding: 12, fontFamily: '-apple-system,BlinkMacSystemFont,system-ui,sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{BOARD.name}</h2>
        {BOARD.about && <span style={{ opacity: 0.6, fontSize: 12 }}>{BOARD.about}</span>}
      </div>
      <div style={{ position: 'relative', height: stacked ? undefined : height }}>
        {BOARD.tiles.map(t => (
          <section key={t.id} style={stacked
            ? { height: t.h * ROW, marginBottom: GAP, display: 'flex', flexDirection: 'column', border: '1px solid rgba(128,128,128,.25)', borderRadius: 8, overflow: 'hidden' }
            : { position: 'absolute', left: t.x * (colW + GAP), top: t.y * (ROW + GAP), width: t.w * colW + (t.w - 1) * GAP, height: t.h * ROW + (t.h - 1) * GAP, display: 'flex', flexDirection: 'column', border: '1px solid rgba(128,128,128,.25)', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ fontSize: 11, fontWeight: 600, padding: '4px 8px', borderBottom: '1px solid rgba(128,128,128,.2)' }}>{t.title}</div>
            <TileBody t={t} />
          </section>
        ))}
      </div>
    </div>
  )
}
`

const INDEX_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`
const MAIN = `import React from 'react'
import { createRoot } from 'react-dom/client'
import Canvas from './canvas'
createRoot(document.getElementById('root')).render(<Canvas />)
`

const PLACEHOLDER: Record<string, string> = {
  chat: 'A conversation. It stays in auto-m8.', term: 'A terminal. It stays in auto-m8.', browser: 'A live browser view. It stays in auto-m8.',
  plan: 'A project plan. It stays in auto-m8.',
}

export function translateForPostHog(b: Board): Translated {
  const notes: string[] = []
  const files: Record<string, string> = {}
  const snapshots: Record<string, any> = {}
  const tilesOut: any[] = []
  const runners: string[] = []
  let usesState = false
  const uses = new Set<string>(['react-markdown'])
  b.tiles.forEach((t: Tile, i: number) => {
    const title = String(t.config?.title ?? (t.kind === 'web' ? t.config?.url : t.kind) ?? '')
    const base = { id: t.id, kind: t.kind, title, x: t.x, y: t.y, w: t.w, h: t.h }
    if (t.kind === 'code' && t.config?.html) {
      const { markup, scripts, external } = splitTile(String(t.config.html))
      const libs = external.map(libFor)
      if (libs.some(l => !l)) {
        notes.push(`"${title}" loads a library PostHog canvases don't allow (${external.filter(s => !libFor(s)).join(', ')}), so it shows as a placeholder.`)
        tilesOut.push({ ...base, kind: 'other', placeholder: 'This tile uses a library PostHog canvases don\'t allow. Open it in auto-m8.' })
        return
      }
      if (/\son[a-z]+\s*=\s*["']/i.test(markup)) notes.push(`"${title}" uses inline event handlers (onclick=…), which PostHog's sandbox blocks; those buttons may not respond.`)
      const snaps = snapshotsFor(String(t.config.html))
      if (Object.keys(snaps).length) { snapshots[t.id] = snaps; notes.push(`"${title}" reads data PostHog can't reach (GitHub, http or auto-m8's own API); it ships a snapshot from now.`) }
      if (/perch\.(save|state)\b/.test(String(t.config.html))) usesState = true
      libs.forEach(l => uses.add(l!.pkg))
      const imports = libs.map((l, j) => l!.star ? `import * as lib${j} from '${l!.pkg}'` : `import lib${j} from '${l!.pkg}'`).join('\n')
      const params = libs.map((l, j) => `${l!.name} = lib${j}`).join(', ')
      files[`src/tiles/t${i}.js`] = `${imports}\n// "${title.replace(/\n/g, ' ')}" from auto-m8\nexport default async function run(document, window, perch${params ? ', ' + params : ''}) {\n${defuseCode(scripts.join('\n;\n'))}\n}\n`
      runners.push(`import t${i} from './t${i}.js'`)
      tilesOut.push({ ...base, markup, refresh: Number(t.config.refresh) || 0, _i: i })
    } else if (t.kind === 'note') {
      tilesOut.push({ ...base, text: String(t.config?.text ?? '') })
    } else if (t.kind === 'web') {
      tilesOut.push({ ...base, placeholder: `A live web page: ${t.config?.url ?? ''}` })
    } else {
      tilesOut.push({ ...base, placeholder: PLACEHOLDER[t.kind] ?? 'This tile stays in auto-m8.' })
      notes.push(`"${title}" is a ${t.kind} tile; it stays in auto-m8 and shows as a placeholder.`)
    }
  })
  const withIdx = tilesOut.filter(t => t._i != null)
  files['src/tiles/index.js'] = `${runners.join('\n')}\nexport default {\n${withIdx.map(t => `  ${JSON.stringify(t.id)}: t${t._i},`).join('\n')}\n}\n`
  files['src/board.json'] = jsonFile({ name: b.name, about: b.about ?? '', tiles: tilesOut.map(({ _i, ...t }) => t) })
  files['src/snapshots.json'] = jsonFile(snapshots)
  files['src/perch.js'] = RUNTIME
  files['src/canvas.tsx'] = APP
  files['src/main.tsx'] = MAIN
  files['index.html'] = INDEX_HTML
  return {
    notes, usesState,
    project: {
      schemaVersion: 1, files, entryHtml: 'index.html', uses,
      capabilities: { posthog: { insights: [], inlineQueries: true, captureEvents: [], state: ['user'] }, network: { origins: [] } },
    },
  }
}

// ---------- Targets ----------
const project = () => settings.posthog.projectId
const posthogTarget: Target = {
  id: 'posthog', label: 'PostHog canvas',
  about: "Publishes the board as a PostHog canvas. You choose who can open it; PostHog keeps its versions and runs its queries with each viewer's own access.",
  async available() {
    if (!project()) return { ok: false, why: 'Choose a PostHog project in Settings first' }
    try { await posthogFetch(`/api/projects/${project()}/canvases/?limit=1`); return { ok: true } } catch (e: any) { return { ok: false, why: e.message } }
  },
  // Who can open it, named by its real scope rather than PostHog's labels ("Public" in PostHog
  // means everyone with access to the project, not the internet). Personal channel: only you.
  // Any public channel: everyone with access to the project (the channel only files it; #general
  // is PostHog's default home). Private channel: its members.
  async audiences() {
    const [r, proj]: any[] = await Promise.all([posthogFetch(`/api/projects/${project()}/task_channels/?limit=500`), posthogFetch(`/api/projects/${project()}/`).catch(() => null)])
    const name = String(proj?.name ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim()
    const scope = name ? `the PostHog project "${name}"` : 'this PostHog project'
    const rank = { private: 0, project: 1, members: 2 } as const
    return (r.results ?? r).map((c: any): Audience => {
      if (c.channel_type === 'personal' || c.system_role === 'personal') return { id: c.id, kind: 'private', private: true, label: 'Only me', hint: 'Only you can open it.', group: 'Only me' }
      if (c.channel_type === 'private') return { id: c.id, kind: 'members', label: `Members of #${c.name}`, hint: `Only members of the private channel #${c.name} can open it.`, group: 'Members of a private channel' }
      return { id: c.id, kind: 'project', group: `Everyone with access to ${scope}`,
        label: c.system_role === 'general' ? `Everyone in ${name || 'the project'} (filed in #general)` : `Everyone in ${name || 'the project'}, filed in #${c.name}`,
        hint: `Anyone with access to ${scope} can open it, whichever channel it's filed in. Not the public internet: PostHog canvases have no public link. Snapshots of auto-m8 data on the board go with it.` }
    }).sort((a: Audience, b: Audience) => rank[a.kind!] - rank[b.kind!] || Number(b.label.includes('#general')) - Number(a.label.includes('#general')) || a.label.localeCompare(b.label))
  },
  // Edited in PostHog since we published? Who has opened it lately? Views come from PostHog's own
  // product analytics (its 'Canvas viewed' event and pageviews), so they show up only where the
  // PostHog app reports usage into the configured project; elsewhere this stays empty.
  async status(sh) {
    const p = project()
    const canvas: any = await posthogFetch(`/api/projects/${p}/canvases/${sh.remote_id}/`).catch(() => null)
    const remote_changed = !!(canvas?.current_version_id && sh.version_id && canvas.current_version_id !== sh.version_id)
    if (!/^[0-9a-f-]{20,}$/i.test(sh.remote_id)) return { remote_changed, viewers: null, views: null }
    const me = (await ensureUser().catch(() => null), posthogStatus.user?.email ?? '').toLowerCase()
    const id = sh.remote_id
    const r: any = await posthogFetch(`/api/projects/${p}/query/`, { method: 'POST', body: JSON.stringify({ query: { kind: 'HogQLQuery', query: `
      select person.properties.email as email, any(person.properties.name) as name, any(person.properties.first_name) as first, max(timestamp) as last, count() as n
      from events
      where timestamp > now() - interval 30 day
        and ((event = 'Canvas viewed' and properties.dashboard_id = '${id}') or (event = '$pageview' and properties.$pathname like '%${id}%'))
      group by email order by last desc limit 50` } }) }).catch(() => null)
    if (!r?.results) return { remote_changed, viewers: null, views: null }
    const viewers: Viewer[] = r.results
      .filter((x: any[]) => String(x[0] ?? '').toLowerCase() !== me)
      .map((x: any[]) => {
        const email = x[0] ? String(x[0]) : null, ts = String(x[3]), last = Date.parse(/(z|[+-]\d\d:\d\d)$/i.test(ts) ? ts : ts.replace(' ', 'T') + 'Z')
        return { name: String(x[1] || x[2] || (email ? email.split('@')[0] : 'Someone')), email, last, views: Number(x[4]) || 0, now: Date.now() - last < 5 * 60_000 }
      })
    return { remote_changed, viewers, views: viewers.reduce((a, v) => a + v.views, 0) }
  },
  async share(b, { audience, overwrite, prev, created }) {
    const p = project()
    const { project: source, notes } = translateForPostHog(b)
    const description = (b.about || `Shared from auto-m8: ${b.tiles.length} tiles`).slice(0, 2000)
    let canvas: any
    if (prev) {
      try { canvas = await posthogFetch(`/api/projects/${p}/canvases/${prev.remote_id}/`) } catch (e: any) { if (e.status !== 404) throw e }
    }
    if (canvas && audience && audience !== prev?.audience) canvas = await posthogFetch(`/api/projects/${p}/canvases/${canvas.id}/`, { method: 'PATCH', body: JSON.stringify({ channel_id: audience }) })
    if (!canvas) {
      const channel = audience ?? (await this.audiences()).find(a => a.private)?.id
      if (!channel) throw new Error('No PostHog channel to share into')
      canvas = await posthogFetch(`/api/projects/${p}/canvases/`, { method: 'POST', body: JSON.stringify({ name: b.name.slice(0, 400), channel_id: channel, kind: 'freeform', description }) })
      created({ remote_id: canvas.id, url: canvas.url ?? null, audience: canvas.channel ?? channel }) // a failed first publish reuses it next time
    }
    // Pin the platform's own dependency versions and SDK, as PostHog reports them for this canvas.
    const current: any = await posthogFetch(`/api/projects/${p}/canvases/${canvas.id}/source/`)
    source.dependencies = Object.fromEntries(Object.entries(current.project?.dependencies ?? {}).filter(([k]) => k === 'react' || k === 'react-dom' || source.uses.has(k)))
    if (current.project?.canvasSdkVersion) source.canvasSdkVersion = current.project.canvasSdkVersion
    delete source.uses
    // Someone changed it in PostHog since we last published: don't overwrite their version silently.
    const head = canvas.current_version_id ?? null
    if (prev && head && prev.version_id && head !== prev.version_id && !overwrite)
      return { remote_id: canvas.id, url: canvas.url, audience: canvas.channel, audience_label: prev.audience_label, version_id: prev.version_id, notes: [...notes, 'It was changed in PostHog since auto-m8 last shared it. Share again with overwrite to replace that version (PostHog keeps it in the history).'], conflict: true }
    const v: any = await posthogFetch(`/api/projects/${p}/canvases/${canvas.id}/validate/`, { method: 'POST', body: JSON.stringify({ project: source }) })
    const problems = (v.diagnostics ?? []).filter((x: any) => x.severity === 'error')
    if (problems.length) throw new Error(`PostHog rejected the translation: ${problems.map((x: any) => `${x.file ?? ''}${x.line ? ':' + x.line : ''} ${x.code}: ${x.message}`).join('; ').slice(0, 800)}`)
    const r: any = await posthogFetch(`/api/projects/${p}/canvases/${canvas.id}/publish/`, { method: 'POST', body: JSON.stringify({ project: source, prompt: 'Shared from auto-m8', name: b.name.slice(0, 400), expected_current_version_id: head }) })
    // The server waits a few seconds for the build; if it's still going, poll until it settles.
    let build = r.build ?? {}
    for (let i = 0; i < 30 && ['queued', 'building'].includes(build.build_status); i++) {
      await new Promise(ok => setTimeout(ok, 2000))
      const l: any = await posthogFetch(`/api/projects/${p}/canvases/${canvas.id}/builds/?scope=slim`)
      build = (l.builds ?? []).find((x: any) => x.id === build.id) ?? build
    }
    const failed = (d: any) => (d?.diagnostics ?? []).filter((x: any) => x.severity === 'error').map((x: any) => `${x.file ?? ''}${x.line ? ':' + x.line : ''} ${x.message}`).join('; ')
    if (build.build_status === 'failed') throw new Error(`PostHog couldn't build it: ${(failed(build) || 'build failed').slice(0, 600)}`)
    const fresh = r.canvas ?? canvas
    return { remote_id: canvas.id, url: fresh.url ?? canvas.url, audience: fresh.channel ?? canvas.channel, audience_label: null, version_id: r.current_version_id ?? fresh.current_version_id ?? null, notes }
  },
}

export const TARGETS: Target[] = [posthogTarget]

// The Share popover waits on these, and each is a PostHog round trip (with retries and no timeout
// of its own), so opening it took seconds. Keep answers for a while, share one in-flight call, and
// give up on availability after a few seconds instead of leaving the popover on "Loading…".
const memo = new Map<string, { at: number; ttl: number; v: Promise<any> }>()
function cached<T>(key: string, ttl: (v: T) => number, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(key)
  if (hit && Date.now() - hit.at < hit.ttl) return hit.v
  const entry = { at: Date.now(), ttl: 60_000, v: fn() }
  memo.set(key, entry)
  entry.v.then(v => { entry.at = Date.now(); entry.ttl = ttl(v) }, () => { if (memo.get(key) === entry) memo.delete(key) })
  return entry.v
}
const within = <T>(ms: number, p: Promise<T>, why: string) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(why)), ms).unref?.())])

export async function targets() {
  return Promise.all(TARGETS.map(async t => ({ id: t.id, label: t.label, about: t.about,
    ...(await cached(`avail:${t.id}:${project()}`, (v: { ok: boolean }) => v.ok ? 10 * 60_000 : 20_000,
      () => within(6000, t.available(), `${t.label} didn't answer in 6s. Try again in a moment.`).catch((e: any) => ({ ok: false, why: e.message })))) })))
}
export async function audiences(target: string) {
  const t = TARGETS.find(x => x.id === target)
  if (!t) throw new Error(`No share target "${target}"`)
  return cached(`aud:${target}:${project()}`, () => 5 * 60_000, () => t.audiences())
}

// Where a board is shared, whether the local board has changes the shared copy lacks, and who has
// opened it lately (cached a minute: views don't need to be second-fresh).
const statusCache = new Map<string, { at: number; v: ShareStatus[] }>()
export async function shareStatus(boardId: string, fresh = false): Promise<ShareStatus[]> {
  const hit = statusCache.get(boardId)
  if (hit && !fresh && Date.now() - hit.at < 60_000) return hit.v
  const b = getBoard(boardId)
  if (!b) return []
  const hash = boardHash(b)
  const rows = all<any>('select * from board_shares where board_id = ? order by shared_at desc', boardId)
  // Shares made before hashes were kept: take the board as it is now as their baseline.
  for (const r of rows) if (!r.source_hash) { r.source_hash = hash; run('update board_shares set source_hash = ? where board_id = ? and target = ?', hash, boardId, r.target) }
  const v = await Promise.all(rows.map(async r => {
    const sh = parse(r), t = TARGETS.find(x => x.id === sh.target)
    const remote = await t?.status?.(sh).catch(() => null)
    return { ...sh, label: t?.label ?? sh.target, local_changes: !!r.source_hash && r.source_hash !== hash, remote_changed: remote?.remote_changed ?? false, viewers: remote?.viewers ?? null, views: remote?.views ?? null }
  }))
  statusCache.set(boardId, { at: Date.now(), v })
  return v
}

export async function shareBoard(boardId: string, target: string, opts: { audience?: string; overwrite?: boolean } = {}): Promise<ShareResult> {
  const b = getBoard(boardId)
  if (!b) throw new Error('No such board')
  const t = TARGETS.find(x => x.id === target)
  if (!t) throw new Error(`No share target "${target}"`)
  const prev = sharesOf(boardId).find(s => s.target === target)
  const remember = (x: { remote_id: string; url: string | null; audience: string | null }) => run(`insert into board_shares (board_id, target, remote_id, url, audience, shared_at, notes) values (?, ?, ?, ?, ?, ?, '[]')
    on conflict(board_id, target) do update set remote_id = excluded.remote_id, url = excluded.url, audience = excluded.audience`, boardId, target, x.remote_id, x.url, x.audience, Date.now())
  const r = await t.share(b, { ...opts, prev, created: remember })
  let label = r.audience_label
  if (!label && r.audience) label = (await t.audiences().catch(() => [] as Audience[])).find(a => a.id === r.audience)?.label ?? null
  const row: Share = { board_id: boardId, target, remote_id: r.remote_id, url: r.url ?? null, audience: r.audience ?? null, audience_label: label, version_id: r.version_id ?? null, shared_at: r.conflict ? prev?.shared_at ?? Date.now() : Date.now(), notes: r.notes }
  if (!r.conflict) run(`insert into board_shares (board_id, target, remote_id, url, audience, audience_label, version_id, shared_at, notes, source_hash) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(board_id, target) do update set remote_id = excluded.remote_id, url = excluded.url, audience = excluded.audience, audience_label = excluded.audience_label, version_id = excluded.version_id, shared_at = excluded.shared_at, notes = excluded.notes, source_hash = excluded.source_hash`,
    row.board_id, row.target, row.remote_id, row.url, row.audience, row.audience_label, row.version_id, row.shared_at, JSON.stringify(row.notes), boardHash(b))
  statusCache.delete(boardId)
  return { ...row, conflict: r.conflict }
}

// Forget a share here. The copy on the other platform stays; delete it there if you want it gone.
export const forgetShare = (boardId: string, target: string) => { run('delete from board_shares where board_id = ? and target = ?', boardId, target); return !get('select 1 from board_shares where board_id = ? and target = ?', boardId, target) }
