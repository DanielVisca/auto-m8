// The window as files. A layout is a JSON tree that says where perch's built-in views (the sidebar,
// the main view, the details column) sit and what tiles go around them, and how it all looks.
// It changes only how things are shown: conversations, PRs and settings stay where they are, and a
// tile in a layout changes them only through the commands in COMMANDS.
//
// Safety, after herdr's app (github.com/herdrdev/herdr-app):
// - Shipped layouts live in code, so they can't be edited or broken; clone one to change it.
// - A broken file never breaks the window: perch keeps the last good version, writes why to
//   <name>.error, and shows the error in Settings.
// - ⌘⌥⇧Escape (or POST /api/layouts/reset) always goes back to the shipped default.
// - AGENTS.md in the folder is rewritten on every start, so an agent asked to "move the PR list to
//   the right" edits these files from one source of truth.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join, normalize, relative, resolve } from 'node:path'
import { DATA_DIR } from './settings.ts'

export const LAYOUT_DIR = join(DATA_DIR, 'layouts')

export type Size = { px: number } | { weight: number }
export type Content = { view: View } | { tile: string; vars?: Record<string, string | number | boolean> }
export type LayoutNode = {
  id: string
  type: 'row' | 'column' | 'block'
  size?: Size
  min?: number
  max?: number
  hidden?: boolean
  divider?: boolean
  children?: LayoutNode[]
  content?: Content
}
export type Layout = LayoutNode & {
  theme?: 'system' | 'light' | 'dark'
  colors?: Record<string, string>
  cloned_from?: string
}

export const VIEWS = ['sidebar', 'main', 'details'] as const
export type View = typeof VIEWS[number]
// What a layout tile may ask perch to do. Each one only navigates or starts a chat; none edits data.
export const COMMANDS = ['open', 'view', 'chat.new', 'search', 'sidebar.toggle', 'details.toggle', 'layout.switch'] as const
// The colours a layout may override; the names match the CSS variables in web/src/styles.css.
export const COLORS = ['bg', 'bg2', 'fg', 'muted', 'line', 'accent', 'ok', 'bad', 'warn'] as const

const DEFAULT: Layout = {
  id: 'root', type: 'row',
  children: [
    { id: 'sidebar', type: 'block', size: { px: 300 }, min: 220, max: 560, content: { view: 'sidebar' } },
    { id: 'main', type: 'block', content: { view: 'main' } },
    { id: 'details', type: 'block', size: { px: 320 }, min: 240, max: 520, content: { view: 'details' } },
  ],
}
// A second shipped layout, so switching has somewhere to go and the guide has an example of moving things.
const SIDEBAR_RIGHT: Layout = {
  id: 'root', type: 'row',
  children: [
    { id: 'details', type: 'block', size: { px: 320 }, min: 240, max: 520, content: { view: 'details' } },
    { id: 'main', type: 'block', content: { view: 'main' } },
    { id: 'sidebar', type: 'block', size: { px: 300 }, min: 220, max: 560, content: { view: 'sidebar' } },
  ],
}
export const SHIPPED: Record<string, Layout> = { default: DEFAULT, 'sidebar-right': SIDEBAR_RIGHT }

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/

// Checks a layout and returns the first problem in plain words, or null when it's fine.
export function problemWith(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'the file must hold one JSON object (the root node)'
  const root = raw as Layout
  if (root.theme !== undefined && !['system', 'light', 'dark'].includes(root.theme)) return `theme must be system, light or dark, not ${JSON.stringify(root.theme)}`
  if (root.colors !== undefined) {
    if (typeof root.colors !== 'object' || Array.isArray(root.colors)) return 'colors must be an object such as {"accent": "#a7b4c6"}'
    for (const [k, v] of Object.entries(root.colors)) {
      if (!(COLORS as readonly string[]).includes(k)) return `colors.${k} isn't a colour auto-m8 knows (use ${COLORS.join(', ')})`
      if (typeof v !== 'string' || !/^#[0-9a-f]{3,8}$/i.test(v)) return `colors.${k} must be #rgb, #rrggbb or #rrggbbaa`
    }
  }
  const ids = new Set<string>()
  const views: string[] = []
  const walk = (n: any, path: string): string | null => {
    if (!n || typeof n !== 'object' || Array.isArray(n)) return `${path} must be an object`
    if (typeof n.id !== 'string' || !n.id) return `${path} needs an "id"`
    if (ids.has(n.id)) return `id "${n.id}" is used twice`
    ids.add(n.id)
    const at = `node "${n.id}"`
    if (!['row', 'column', 'block'].includes(n.type)) return `${at}: type must be row, column or block`
    if (n.size !== undefined) {
      const px = n.size?.px, w = n.size?.weight
      if (!((typeof px === 'number' && px > 0 && px < 4000) || (typeof w === 'number' && w > 0 && w < 100))) return `${at}: size must be {"px": n} or {"weight": n}`
    }
    for (const k of ['min', 'max'] as const) if (n[k] !== undefined && !(typeof n[k] === 'number' && n[k] >= 0)) return `${at}: ${k} must be a number of px`
    if (n.type === 'block') {
      const c = n.content
      if (!c || typeof c !== 'object') return `${at}: a block needs "content": {"view": ...} or {"tile": ...}`
      if ('view' in c) {
        if (!(VIEWS as readonly string[]).includes(c.view)) return `${at}: view must be one of ${VIEWS.join(', ')}`
        views.push(c.view)
      } else if ('tile' in c) {
        if (tilePath(c.tile) === null) return `${at}: tile must be a .html file inside the layouts folder, such as "tiles/clock.html"`
      } else return `${at}: content needs "view" or "tile"`
      if (n.children !== undefined) return `${at}: a block has content, not children`
    } else {
      if (!Array.isArray(n.children) || !n.children.length) return `${at}: a ${n.type} needs "children"`
      for (let i = 0; i < n.children.length; i++) { const p = walk(n.children[i], `${at} child ${i + 1}`); if (p) return p }
    }
    return null
  }
  const p = walk(root, 'the root')
  if (p) return p
  // The main view is how you reach everything; a layout without it (or that hides it) would strand you.
  const mains = views.filter(v => v === 'main').length
  if (mains !== 1) return mains ? 'the "main" view can only appear once' : 'a layout must show the "main" view once'
  for (const v of VIEWS) if (views.filter(x => x === v).length > 1) return `the "${v}" view can only appear once`
  // True when the main view, or any node around it, is hidden.
  const mainHidden = (n: LayoutNode, hidden: boolean): boolean => {
    const h = hidden || !!n.hidden
    if (n.content && 'view' in n.content && n.content.view === 'main') return h
    return !!n.children?.some(c => mainHidden(c, h))
  }
  if (mainHidden(root, false)) return 'the "main" view can\'t be hidden'
  return null
}

// A tile path, resolved inside the layouts folder, or null if it points anywhere else.
export function tilePath(p: unknown): string | null {
  if (typeof p !== 'string' || !p.endsWith('.html') || p.includes('\0')) return null
  const full = resolve(LAYOUT_DIR, normalize(p))
  return full.startsWith(resolve(LAYOUT_DIR) + '/') ? full : null
}

const lastGood = new Map<string, Layout>()

export type Loaded = { name: string; layout: Layout; shipped: boolean; error: string | null }

// Reads a layout. A shipped one comes from code. A file that's missing falls back to the default;
// a broken one keeps the last version that loaded (or the default) and says why.
export function loadLayout(name: string): Loaded {
  if (SHIPPED[name]) return { name, layout: SHIPPED[name], shipped: true, error: null }
  const file = join(LAYOUT_DIR, `${name}.json`)
  const errFile = join(LAYOUT_DIR, `${name}.error`)
  const fallback = (error: string): Loaded => {
    try { writeFileSync(errFile, error + '\n') } catch {}
    return { name, layout: lastGood.get(name) ?? DEFAULT, shipped: false, error }
  }
  if (!NAME.test(name)) return { name: 'default', layout: DEFAULT, shipped: true, error: `"${name}" isn't a layout name` }
  if (!existsSync(file)) return { name: 'default', layout: DEFAULT, shipped: true, error: `layouts/${name}.json doesn't exist, showing the default` }
  let raw: unknown
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch (e: any) { return fallback(`layouts/${name}.json isn't valid JSON: ${e.message}`) }
  const p = problemWith(raw)
  if (p) return fallback(`layouts/${name}.json: ${p}`)
  lastGood.set(name, raw as Layout)
  try { rmSync(errFile, { force: true }) } catch {}
  return { name, layout: raw as Layout, shipped: false, error: null }
}

export function listLayouts(): { name: string; shipped: boolean }[] {
  const own = existsSync(LAYOUT_DIR) ? readdirSync(LAYOUT_DIR).filter(f => f.endsWith('.json')).map(f => basename(f, '.json')).filter(n => NAME.test(n) && !SHIPPED[n]) : []
  return [...Object.keys(SHIPPED).map(name => ({ name, shipped: true })), ...own.sort().map(name => ({ name, shipped: false }))]
}

// Copies a layout to a new file you own. Never overwrites.
export function cloneLayout(from: string, as: string): { name: string } | { error: string } {
  if (!NAME.test(as)) return { error: 'name it with lowercase letters, digits and dashes' }
  if (SHIPPED[as] || existsSync(join(LAYOUT_DIR, `${as}.json`))) return { error: `a layout called "${as}" already exists` }
  const src = loadLayout(from)
  if (src.name !== from) return { error: src.error ?? `no layout called "${from}"` }
  mkdirSync(LAYOUT_DIR, { recursive: true })
  writeFileSync(join(LAYOUT_DIR, `${as}.json`), JSON.stringify({ ...src.layout, cloned_from: from }, null, 2) + '\n')
  return { name: as }
}

export function readTile(p: unknown): string | null {
  const full = tilePath(p)
  if (!full || !existsSync(full)) return null
  return readFileSync(full, 'utf8')
}

// Calls back (debounced) when anything in the folder changes, so the window follows an edit at once.
export function watchLayouts(onChange: () => void) {
  mkdirSync(join(LAYOUT_DIR, 'tiles'), { recursive: true })
  let soon: NodeJS.Timeout | undefined
  try {
    watch(LAYOUT_DIR, { recursive: true }, (_e, file) => {
      const f = String(file ?? '')
      if (f.endsWith('.error') || f === 'AGENTS.md' || f.startsWith('.history') || f.startsWith('.state')) return
      clearTimeout(soon); soon = setTimeout(onChange, 150)
    })
  } catch {}
}

// Versions. Every change to the folder (an agent's edit, a hand edit, a copy) is kept as a snapshot
// in .history/<id>/: the layout files and tiles as they were, plus which layout was active. Restoring
// one first snapshots what's there now, so a restore can be undone too. The newest 60 are kept.
export const HISTORY_DIR = join(LAYOUT_DIR, '.history')
const KEEP = 60
export type Version = { id: string; at: number; label: string; active: string; files: number }

function ownFiles(dir = LAYOUT_DIR): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const f of readdirSync(dir)) {
    if (f.startsWith('.') || f.endsWith('.error') || f === 'AGENTS.md' || f === 'AGENTS.local.md') continue
    const full = join(dir, f)
    if (statSync(full).isDirectory()) { if (relative(LAYOUT_DIR, full) === 'tiles' || full.startsWith(join(LAYOUT_DIR, 'tiles') + '/')) out.push(...ownFiles(full)) }
    else if (f.endsWith('.json') || f.endsWith('.html')) out.push(relative(LAYOUT_DIR, full))
  }
  return out.sort()
}
function fingerprint(base: string, files: string[], active: string) {
  const h = createHash('sha1').update(active)
  for (const f of files) h.update('\0' + f + '\0').update(readFileSync(join(base, f)))
  return h.digest('hex')
}

export function listVersions(): Version[] {
  if (!existsSync(HISTORY_DIR)) return []
  return readdirSync(HISTORY_DIR).filter(d => /^\d+$/.test(d)).sort((a, b) => Number(b) - Number(a)).flatMap(id => {
    try { const m = JSON.parse(readFileSync(join(HISTORY_DIR, id, 'meta.json'), 'utf8')); return [{ id, at: m.at, label: m.label, active: m.active, files: m.files?.length ?? 0 }] } catch { return [] }
  })
}

// Saves the folder as a version, unless nothing changed since the last one. Returns its id.
export function snapshot(label: string, active: string): string | null {
  const files = ownFiles()
  const fp = fingerprint(LAYOUT_DIR, files, active)
  const last = listVersions()[0]
  if (last) { try { if (JSON.parse(readFileSync(join(HISTORY_DIR, last.id, 'meta.json'), 'utf8')).fp === fp) return last.id } catch {} }
  let id = String(Date.now())
  while (existsSync(join(HISTORY_DIR, id))) id = String(Number(id) + 1)
  const dir = join(HISTORY_DIR, id)
  mkdirSync(dir, { recursive: true })
  for (const f of files) { mkdirSync(join(dir, f, '..'), { recursive: true }); cpSync(join(LAYOUT_DIR, f), join(dir, f)) }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ at: Date.now(), label: label.slice(0, 200), active, files, fp }) + '\n')
  for (const old of listVersions().slice(KEEP)) rmSync(join(HISTORY_DIR, old.id), { recursive: true, force: true })
  return id
}

// Puts the folder back as it was at a version. Returns the layout that was active then.
export function restoreVersion(id: string, activeNow: string): { active: string } | { error: string } {
  if (!/^\d+$/.test(id) || !existsSync(join(HISTORY_DIR, id, 'meta.json'))) return { error: 'no such version' }
  const meta = JSON.parse(readFileSync(join(HISTORY_DIR, id, 'meta.json'), 'utf8'))
  snapshot('Before restoring a version', activeNow)
  for (const f of ownFiles()) rmSync(join(LAYOUT_DIR, f), { force: true })
  for (const f of meta.files as string[]) { const dest = join(LAYOUT_DIR, f); mkdirSync(join(dest, '..'), { recursive: true }); cpSync(join(HISTORY_DIR, id, f), dest) }
  return { active: meta.active }
}

// The gallery: layouts other people shared. Like herdr.dev/layouts, a shared layout is a public GitHub
// repo with the topic auto-m8-layout, holding <name>.json, any tiles/, a RECIPE.md (the brief an
// agent can rebuild it from) and a preview.png. Read with GitHub's public search, cached 10 minutes.
export const GALLERY_TOPIC = 'auto-m8-layout'
export type Shared = { repo: string; name: string; description: string; stars: number; url: string; preview: string; updated: string }
let gallery: { at: number; items: Shared[]; problem: string | null } | null = null
export async function sharedLayouts(): Promise<{ items: Shared[]; problem: string | null; topic: string }> {
  if (gallery && Date.now() - gallery.at < 10 * 60_000) return { items: gallery.items, problem: gallery.problem, topic: GALLERY_TOPIC }
  try {
    const r = await fetch(`https://api.github.com/search/repositories?q=topic:${GALLERY_TOPIC}&sort=stars&per_page=50`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'auto-m8' }, signal: AbortSignal.timeout(8000) })
    if (!r.ok) throw new Error(`GitHub search answered ${r.status}`)
    const j: any = await r.json()
    const items: Shared[] = (j.items ?? []).map((x: any) => ({ repo: x.full_name, name: x.name, description: x.description ?? '', stars: x.stargazers_count ?? 0, url: x.html_url, updated: x.pushed_at, preview: `https://raw.githubusercontent.com/${x.full_name}/${x.default_branch}/preview.png` }))
    gallery = { at: Date.now(), items, problem: null }
  } catch (e: any) { gallery = { at: Date.now() - 9 * 60_000, items: gallery?.items ?? [], problem: String(e?.message ?? e) } }
  return { items: gallery.items, problem: gallery.problem, topic: GALLERY_TOPIC }
}

export function writeGuide() {
  mkdirSync(join(LAYOUT_DIR, 'tiles'), { recursive: true })
  writeFileSync(join(LAYOUT_DIR, 'AGENTS.md'), GUIDE)
}

const GUIDE = `# auto-m8 layouts

<!-- Written by auto-m8 on every start. Edits here are overwritten. -->

This folder is **auto-m8's window, as files**. A layout says where auto-m8's views
go, what tiles sit around them, and how the window looks. auto-m8 redraws within a
second of a save. Layouts only change how things are shown: conversations, PRs
and settings stay as they are.

When someone asks "move the sidebar to the right", "put a clock above the chat"
or "make it warmer", do it by editing a layout here.

## Files

| File | What it is |
|---|---|
| \`<name>.json\` | one whole window (yours) |
| \`<name>.error\` | why \`<name>.json\` didn't load; auto-m8 keeps the last good version meanwhile |
| \`tiles/*.html\` | tiles that layouts put in blocks |
| \`.history/\` | every earlier version of this folder; written by auto-m8, don't edit |

Every change here is saved as a version, so nothing you do is lost: the person can
restore any version in Settings → Layout. When they ask for a change in words (⌘⇧U),
auto-m8 saves a version first and shows them Keep / Undo, so make the change directly
rather than asking for permission.

Shipped layouts (${Object.keys(SHIPPED).map(n => '`' + n + '`').join(', ')}) live in auto-m8's code and can't be
edited. To change one, clone it, then edit the clone:

\`\`\`sh
curl -s -X POST localhost:4777/api/layouts/clone -d '{"from":"default","as":"mine"}'
curl -s -X PUT  localhost:4777/api/layouts/active -d '{"name":"mine"}'
\`\`\`

Or use Settings → Appearance → Layout. **Escape hatch:** ⌘⌥⇧Escape, or
\`POST /api/layouts/reset\`, always goes back to \`default\`.

After every edit, check: \`cat <name>.error\` (no file means it loaded) or
\`curl -s localhost:4777/api/layouts\` (\`error\` is null when fine).

## Layouts other people made (the gallery)

Settings → Layout → Gallery lists public GitHub repos with the topic
\`auto-m8-layout\`. Each holds \`<name>.json\`, any \`tiles/\` it uses, a
\`RECIPE.md\` (the brief to build it from scratch) and a \`preview.png\`.
Asked to add one:

1. Read the recipe and every file before writing anything. Tell the person if a
   tile reads data they might not expect.
2. Copy the layout file here and its tiles into \`tiles/\`. Never overwrite: if a
   name is taken, rename the new one and the tile paths in it. Leave the recipe
   and preview out.
3. If the files don't load on this version (\`<name>.error\`), build it from the
   recipe instead. Then switch to it. Keep / Undo covers the rest.

To share one, only when the person asks: a public repo with that folder, a
\`RECIPE.md\` written from the real files (what you see, how it behaves, every
tile), a screenshot saved as \`preview.png\`, and the topic \`auto-m8-layout\`.
Publishing is public: show the person the repo name and files and get a yes first.

## The tree

Three node types. Every node has a unique \`id\`.

- \`row\` / \`column\`: \`children\` side by side / stacked.
- \`block\`: shows \`content\`:
  - \`{"view": "sidebar"}\`: conversations and PRs list, actions, nav
  - \`{"view": "main"}\`: the current page (chat, home, a PR…). **Required, once, never hidden.**
  - \`{"view": "details"}\`: the details/PR side column. It only takes space when there is something to show.
  - \`{"tile": "tiles/clock.html", "vars": {"tz": "UTC"}}\`: a tile (below)

Any node: \`size\` (\`{"px": 240}\` or \`{"weight": 2}\`, a share of what fixed
siblings leave), \`min\` / \`max\` (px), \`hidden\`, \`divider\` (a line after it).

Root only: \`theme\` (\`system\`, \`light\`, \`dark\`; beats Settings) and
\`colors\` overriding any of ${COLORS.map(c => '`' + c + '`').join(', ')} with \`#rrggbb[aa]\`.

The default:

\`\`\`json
${JSON.stringify(DEFAULT, null, 2)}
\`\`\`

⌘\\\\ still folds the sidebar and ⌘I the details column in any layout. Below
640px wide auto-m8 uses its one-column phone layout, whatever the file says.

## Tiles

A tile is one HTML file with its CSS and JS, run in a sandbox with no network of
its own. It gets the theme colours as CSS variables (\`--bg\`, \`--fg\`,
\`--muted\`, \`--line\`, \`--accent\`, \`--ok\`, \`--bad\`, \`--warn\`) and a \`perch\` object
(the tile API keeps that name; use it exactly):

- \`await perch.data({source: 'posthog', hogql: 'select …'})\`, or \`source: 'github', path\`,
  or \`source: 'perch', path\` (auto-m8's own data; the path starts with \`/api/\`, e.g.
  \`/api/needs\`, \`/api/conversations\`): read data. A failed read rejects the promise and
  shows under the tile, so catch it and show a quiet empty state.
- \`perch.onRefresh(fn)\`: runs at start, when auto-m8's data changes and when vars change
- \`perch.vars\`: the block's \`vars\`
- \`await perch.run(command, args)\`: ask auto-m8 to do something. Commands:
  - \`open {id}\`: open a conversation
  - \`view {kind}\`: home, needs, settings, insights, library, automations, evolve, paused, board, search
  - \`chat.new {prompt?}\`: start a chat, with the prompt typed in
  - \`search {q}\`
  - \`sidebar.toggle\`, \`details.toggle\`
  - \`layout.switch {name}\`

Tiles can't change data directly; these commands are the only way they act.

Keep tiles tidy:
- Fill the block and no more: \`html,body{margin:0;height:100%;overflow:hidden}\`. The block
  clips anything outside it, so a tile can't draw over the views next to it.
- No \`position: fixed\` popovers or menus: they are cut off at the block's edge.
- Don't redo what a view already has (the sidebar has search, the chat has its own header).
  Prefer navigation (rail, top bar) that calls the commands above.
- A full-width bar at the top of the window gets 78px of left padding on macOS for the
  window buttons; don't add your own.
`
