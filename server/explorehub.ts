// Explore's landing data: galleries of canvases and researched products, each linked back to
// the chats that made or used them. Read-only views over boards.ts and productresearch.ts.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { all, get } from './db.ts'
import { cachedGraph } from './explorer.ts'
import { listRepos } from './explorer-runtime.ts'
import { DATA_DIR } from './settings.ts'
import { boardChats, boards } from './boards.ts'
import { product, type ResearchItem } from './productresearch.ts'

type ChatRef = { id: string; title: string; role: string; at: number }
const title = (id: string) => {
  const c = get<{ title: string | null; first_prompt: string | null }>('select title, first_prompt from conversations where id = ?', id)
  return c ? (c.title || (c.first_prompt ?? '').slice(0, 80) || 'Untitled chat') : null
}
const chatRefs = (rows: { conversation_id: string; role: string; at: number }[]): ChatRef[] => {
  const seen = new Map<string, ChatRef>()
  for (const r of rows) {
    if (seen.has(r.conversation_id)) continue
    const t = title(r.conversation_id)
    if (t) seen.set(r.conversation_id, { id: r.conversation_id, title: t, role: r.role, at: r.at })
  }
  return [...seen.values()]
}

// Canvas previews: a screenshot the app takes of each board in a hidden window, kept on disk.
const THUMBS = join(DATA_DIR, 'board-thumbs')
const safeId = (id: string) => { if (!/^[\w-]{1,100}$/.test(id)) throw new Error('Bad board id'); return id }
export const thumbFile = (id: string) => { const f = join(THUMBS, `${safeId(id)}.jpg`); return existsSync(f) ? f : null }
export function saveThumb(id: string, jpegBase64: string) {
  if (!get('select 1 from boards where id = ?', id)) throw new Error('No such board')
  const buf = Buffer.from(String(jpegBase64), 'base64')
  if (buf.length < 100 || buf.length > 3_000_000 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('Expected a JPEG under 3 MB')
  mkdirSync(THUMBS, { recursive: true, mode: 0o700 })
  writeFileSync(join(THUMBS, `${safeId(id)}.jpg`), buf, { mode: 0o600 })
  return { ok: true }
}
const thumbAt = (id: string) => { try { const f = thumbFile(id); return f ? statSync(f).mtimeMs : null } catch { return null } }

export function canvases() {
  const opened = new Map(all<{ id: string; opened_at: number | null }>('select id, opened_at from boards').map(r => [r.id, r.opened_at]))
  return boards().map(b => {
    const kinds: Record<string, number> = {}
    for (const t of b.tiles) kinds[t.kind] = (kinds[t.kind] ?? 0) + 1
    // A chat tile on the board is a link too.
    const tileChats = all<{ c: string }>("select json_extract(config, '$.conversation_id') c from canvas_tiles where folder_id = ? and json_extract(config, '$.conversation_id') is not null", b.id)
      .map(r => ({ conversation_id: r.c, role: 'tile', at: b.updated_at }))
    // Where each tile sits, so the gallery card is a scaled-down picture of the board.
    const at = new Map(all<any>('select id, x, y, w, h from canvas_tiles where folder_id = ?', b.id).map(r => [r.id, r]))
    const layout = b.tiles.map(t => { const r = at.get(t.id); return { ...t, x: r?.x ?? 0, y: r?.y ?? 0, w: r?.w ?? 6, h: r?.h ?? 4 } })
    return { ...b, tiles: layout, opened_at: opened.get(b.id) ?? null, thumb_at: thumbAt(b.id), kinds, errors: b.tiles.filter(t => t.error).length, chats: chatRefs([...boardChats(b.id), ...tileChats]) }
  })
}

const RANK: Record<string, number> = { queued: 0, blocked: 0, not_found: 0, documented: 1, observed: 2, tested: 3 }
const DEPTH = ['not started', 'docs only', 'seen in the product', 'workflows tested']

export function competitors() {
  const products = all<any>('select * from research_products order by created_at, name')
  return products.map(p => summary(p))
}
function summary(p: any) {
  const items = all<ResearchItem>('select * from research_items where product_id = ?', p.id)
  const ev = all<any>(`select e.id, e.source, e.captured_at, e.screenshot, json_extract(e.data, '$.conversation_id') conv from research_evidence e
    join research_items i on i.id = e.item_id where i.product_id = ? order by e.captured_at desc`, p.id)
  const status: Record<string, number> = {}
  for (const it of items) status[it.status] = (status[it.status] ?? 0) + 1
  const covered = items.filter(it => RANK[it.status] > 0).length
  const depth = Math.max(0, ...items.map(it => RANK[it.status] ?? 0))
  return {
    ...p, sandbox: !!p.sandbox,
    items: items.length, status, covered, coverage: items.length ? covered / items.length : 0, depth: DEPTH[depth],
    first_at: ev.length ? ev[ev.length - 1].captured_at : null, last_at: ev.length ? ev[0].captured_at : null,
    evidence: ev.length, screenshots: ev.filter(e => e.screenshot).length,
    cover: ev.find(e => e.screenshot)?.id ?? null,
    chats: chatRefs(ev.filter(e => e.conv).map(e => ({ conversation_id: e.conv, role: e.source, at: e.captured_at }))),
  }
}

// One product: its map (items as a tree, depth-first) with the evidence on each, in tour order.
export function competitor(id: string) {
  const p = product(id)
  const items = all<ResearchItem>('select * from research_items where product_id = ? order by rowid', id)
  const ev = all<any>(`select e.id, e.item_id, e.source, e.summary, e.url, e.captured_at, e.screenshot is not null shot,
    json_extract(e.data, '$.friction') friction, json_extract(e.data, '$.assertion.expected') expected, json_extract(e.data, '$.conversation_id') conv
    from research_evidence e join research_items i on i.id = e.item_id where i.product_id = ? order by e.captured_at`, id)
  const byItem = new Map<string, any[]>()
  for (const e of ev) byItem.set(e.item_id, [...(byItem.get(e.item_id) ?? []), { ...e, shot: !!e.shot, chat: e.conv ? title(e.conv) : null }])
  const kids = new Map<string | null, ResearchItem[]>()
  const ids = new Set(items.map(i => i.id))
  for (const it of items) { const k = it.parent_id && ids.has(it.parent_id) ? it.parent_id : null; kids.set(k, [...(kids.get(k) ?? []), it]) }
  const tree: (ResearchItem & { depth: number; evidence: any[] })[] = []
  const walk = (parent: string | null, depth: number) => { for (const it of kids.get(parent) ?? []) { tree.push({ ...it, depth, evidence: byItem.get(it.id) ?? [] }); walk(it.id, depth + 1) } }
  walk(null, 0)
  return { ...summary(all<any>('select * from research_products where id = ?', p.id)[0]), tree }
}

// ── Codebases: a small picture of each repo for the gallery ──────────────────────────────────
// Mapped repos get their biggest modules and the links between them (from the cached scan, never a
// new one); the rest get their top folders by file count, from git.
const run$ = promisify(execFile)

export type CodePreview =
  | { kind: 'graph'; sha: string; concepts: number; nodes: { id: string; name: string; files: number }[]; edges: { from: string; to: string; fk: boolean; weight: number }[] }
  | { kind: 'folders'; files: number; folders: { name: string; files: number }[] }
  | { kind: 'none' }

export async function codePreview(repo: string): Promise<CodePreview> {
  const g = await cachedGraph(repo).catch(() => null)
  if (g?.concepts?.length) {
    const top = [...g.concepts].sort((a, b) => b.files - a.files).slice(0, 14)
    const ids = new Set(top.map(c => c.id))
    const pairs = new Map<string, { from: string; to: string; fk: boolean; weight: number }>()
    for (const e of g.edges) {
      if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue
      const k = `${e.from}\0${e.to}`, old = pairs.get(k)
      pairs.set(k, { from: e.from, to: e.to, fk: (old?.fk ?? false) || e.kind === 'fk', weight: (old?.weight ?? 0) + e.weight })
    }
    const edges = [...pairs.values()].sort((a, b) => b.weight - a.weight).slice(0, 40)
    return { kind: 'graph', sha: g.sha, concepts: g.concepts.length, nodes: top.map(c => ({ id: c.id, name: c.name, files: c.files })), edges }
  }
  try {
    const { stdout } = await run$('git', ['-C', repo, 'ls-files'], { maxBuffer: 1 << 28, timeout: 10_000 })
    const counts = new Map<string, number>()
    let files = 0
    for (const f of stdout.split('\n')) { if (!f) continue; files++; const i = f.indexOf('/'); const top = i < 0 ? '(root files)' : f.slice(0, i); counts.set(top, (counts.get(top) ?? 0) + 1) }
    return { kind: 'folders', files, folders: [...counts].map(([name, n]) => ({ name, files: n })).sort((a, b) => b.files - a.files).slice(0, 10) }
  } catch { return { kind: 'none' } }
}

export async function codebases() {
  const repos = await listRepos()
  const out = []
  for (const r of repos) out.push({ ...r, preview: await codePreview(r.path) })
  return out
}
