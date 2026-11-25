// Explore's landing data: galleries of canvases and researched products, each linked back to
// the chats that made or used them. Read-only views over boards.ts and productresearch.ts.
import { all, get } from './db.ts'
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
    return { ...b, tiles: layout, opened_at: opened.get(b.id) ?? null, kinds, errors: b.tiles.filter(t => t.error).length, chats: chatRefs([...boardChats(b.id), ...tileChats]) }
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
