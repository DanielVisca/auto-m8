// Boards: canvases that stand on their own, not inside a folder. A board is a set of tiles
// (canvas.ts). Agents find, read, build and change them through the perch MCP `canvas` tool,
// and can show one beside a chat or instead of it. A few can be pinned to Home.
// A board's id is the tiles' folder_id, so a folder's old canvas is just a board with that id.
import { randomUUID } from 'node:crypto'
import './folders.ts' // the legacy migration below reads the folders table
import { all, db, get, run } from './db.ts'
import { makeTile, onCanvas, removeTile, saveTile, tiles, type Tile } from './canvas.ts'

db.exec(`create table if not exists boards (
  id text primary key, name text not null, about text, pinned integer not null default 0,
  created_by text, updated_at integer
)`)
db.exec(`create table if not exists chat_boards (conversation_id text primary key, board_id text not null, layout text not null default 'side')`)
const columns = new Set(all<any>('pragma table_info(boards)').map(c => c.name))
if (!columns.has('ttl_seconds')) db.exec('alter table boards add column ttl_seconds integer')
if (!columns.has('last_used_at')) db.exec('alter table boards add column last_used_at integer')

// Canvases made before boards existed (one per folder) become boards named after their folder.
for (const r of all<any>(`select distinct t.folder_id id, f.name from canvas_tiles t left join folders f on f.id = t.folder_id where t.folder_id not in (select id from boards)`))
  run('insert into boards (id, name, updated_at) values (?, ?, ?)', r.id, r.name ?? 'Board', Date.now())

export const PIN_LIMIT = 3
export const DEFAULT_BOARD_TTL = 24 * 60 * 60
type Lifetime = { temporary?: boolean; ttl_seconds?: number | null }
function lifetime(patch: Lifetime, current: number | null = null): number | null {
  if (patch.temporary != null && typeof patch.temporary !== 'boolean') throw new Error('temporary must be true or false')
  if (patch.ttl_seconds != null && (!Number.isSafeInteger(patch.ttl_seconds) || patch.ttl_seconds < 60 || patch.ttl_seconds > 365 * 86400))
    throw new Error('ttl_seconds must be a whole number from 60 to 31536000 (one minute to one year)')
  if (patch.temporary === false || patch.ttl_seconds === null) return null
  return patch.ttl_seconds ?? (patch.temporary ? current ?? DEFAULT_BOARD_TTL : current)
}
const changed = () => onCanvas.forEach(f => f())
export type Board = { id: string; name: string; about: string | null; pinned: number; created_by: string | null; updated_at: number; ttl_seconds: number | null; last_used_at: number | null; expires_at: number | null; tiles: { id: string; kind: string; title: string; error: string | null }[] }

const summary = (t: Tile) => ({ id: t.id, kind: t.kind, title: t.config.title ?? t.config.url ?? (t.kind === 'note' ? String(t.config.text ?? '').slice(0, 40) : t.kind), error: t.error })
const withExpiry = (b: any) => ({ ...b, expires_at: b.ttl_seconds == null ? null : (b.last_used_at ?? b.updated_at) + b.ttl_seconds * 1000 })
const withTiles = (b: any): Board => ({ ...withExpiry(b), tiles: tiles(b.id).map(summary) })

// Reading/listing or refreshing tile data must never renew a temporary board. Expiry removes
// the tiles and chat links in the same transaction, so the legacy migration can't revive it.
export function expireBoards(now = Date.now()): number {
  const expired = all<{ id: string }>('select id from boards where ttl_seconds is not null and coalesce(last_used_at, updated_at) + ttl_seconds * 1000 <= ?', now)
  if (!expired.length) return 0
  db.exec('begin immediate')
  try {
    for (const { id } of expired) {
      run('delete from canvas_tiles where folder_id = ?', id)
      run('delete from chat_boards where board_id = ?', id)
      run('delete from boards where id = ?', id)
    }
    db.exec('commit')
  } catch (e) { db.exec('rollback'); throw e }
  changed()
  return expired.length
}

// Explicit user/agent activity only; no broadcast on heartbeats (that would reload every tile).
export function useBoard(id: string): boolean {
  expireBoards()
  const b = get<any>('select ttl_seconds from boards where id = ?', id)
  if (!b) return false
  if (b.ttl_seconds != null) run('update boards set last_used_at = ? where id = ?', Date.now(), id)
  return true
}

export function boards(q = ''): Board[] {
  expireBoards()
  const list = all<any>('select * from boards order by pinned desc, updated_at desc').map(withTiles)
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return list
  return list.filter(b => {
    const hay = [b.name, b.about ?? '', ...tiles(b.id).map(t => `${t.config.title ?? ''} ${t.config.ask ?? ''} ${t.config.url ?? ''} ${t.config.text ?? ''}`)].join(' ').toLowerCase()
    return words.every(w => hay.includes(w))
  })
}
export const board = (id: string) => { expireBoards(); const b = get<any>('select * from boards where id = ?', id); return b ? { ...withExpiry(b), tiles: tiles(id) } : null }
// Old folder canvases remain supported. Reject late requests for a removed temporary board
// before they can leave orphan tiles for the legacy migration to rediscover on restart.
export function requireCanvas(id: string) {
  if (!board(id) && !get('select 1 from folders where id = ?', id)) throw new Error('This canvas expired or was removed')
}

export function createBoard(name: string, about?: string, by?: string, options: Lifetime = {}) {
  const ttl = lifetime(options)
  const id = randomUUID()
  run('insert into boards (id, name, about, created_by, updated_at, ttl_seconds, last_used_at) values (?, ?, ?, ?, ?, ?, ?)', id, name || 'Board', about ?? null, by ?? null, Date.now(), ttl, Date.now())
  changed()
  return board(id)!
}
export function updateBoard(id: string, patch: { name?: string; about?: string; pinned?: boolean } & Lifetime) {
  expireBoards()
  const b = get<any>('select * from boards where id = ?', id)
  if (!b) throw new Error(`No board ${id}`)
  const ttl = lifetime(patch, b.ttl_seconds)
  if (patch.pinned && !b.pinned && (get<any>('select count(*) n from boards where pinned = 1')?.n ?? 0) >= PIN_LIMIT)
    throw new Error(`Home holds ${PIN_LIMIT} boards. Unpin one first.`)
  // Pinning means keep; choosing a temporary lifetime takes an existing board off Home.
  const keep = patch.pinned === true
  const pinned = keep ? 1 : ttl != null ? 0 : patch.pinned === false ? 0 : b.pinned
  run('update boards set name = ?, about = ?, pinned = ?, updated_at = ?, ttl_seconds = ?, last_used_at = ? where id = ?', patch.name ?? b.name, patch.about ?? b.about, pinned, Date.now(), keep ? null : ttl, Date.now(), id)
  changed()
  return board(id)
}
export function deleteBoard(id: string) {
  for (const t of tiles(id)) removeTile(t.id)
  run('delete from boards where id = ?', id)
  run('delete from chat_boards where board_id = ?', id)
  changed()
}

// Tiles, as agents see them. A tile with `ask` is built (or rebuilt) by Claude; html/text/url set it directly.
export async function putTile(a: { board_id?: string; tile_id?: string; kind?: Tile['kind']; title?: string; ask?: string; html?: string; text?: string; url?: string; refresh?: number; conversation_id?: string; w?: number; h?: number }) {
  expireBoards()
  const old = a.tile_id ? get<any>('select * from canvas_tiles where id = ?', a.tile_id) : null
  if (a.tile_id && !old) throw new Error(`No tile ${a.tile_id}`)
  const boardId = old?.folder_id ?? a.board_id
  if (!boardId || !get<any>('select 1 from boards where id = ?', boardId)) throw new Error('Give a board_id (from action=list) or a tile_id')
  useBoard(boardId)
  const cfg = old ? JSON.parse(old.config) : {}
  if (a.ask && (old?.kind ?? a.kind ?? 'code') === 'code') {
    const t = await makeTile({ folder_id: boardId, tile_id: a.tile_id, ask: a.ask, html: cfg.html, error: old?.error ?? undefined }, () => { if (!board(boardId)) throw new Error('This board expired or was removed while the tile was being built') })
    if (a.title || a.w || a.h) saveTile({ id: t.id, folder_id: boardId, kind: 'code', w: a.w, h: a.h, config: { ...t.config, ...(a.title ? { title: a.title } : {}) } })
    touch(boardId)
    return tiles(boardId).find(x => x.id === t.id)!
  }
  const kind = (old?.kind ?? a.kind ?? (a.url ? 'web' : a.text != null ? 'note' : a.conversation_id ? 'chat' : 'code')) as Tile['kind']
  const config = { ...cfg, ...(a.title != null ? { title: a.title } : {}), ...(a.html != null ? { html: a.html } : {}), ...(a.text != null ? { text: a.text } : {}),
    ...(a.url != null ? { url: a.url } : {}), ...(a.refresh != null ? { refresh: a.refresh } : {}), ...(a.conversation_id ? { conversation_id: a.conversation_id } : {}),
    ...(kind === 'browser' && a.conversation_id ? { owner: a.conversation_id } : {}) }
  const t = saveTile({ id: a.tile_id, folder_id: boardId, kind, w: a.w ?? (old ? undefined : 6), h: a.h ?? (old ? undefined : 5), config, ...(a.html != null ? { error: null } : {}) })
  touch(boardId)
  return t
}
// Pull a tile from one board onto another (a copy: the two then change independently).
export function copyTile(tileId: string, boardId: string) {
  expireBoards()
  const t = get<any>('select * from canvas_tiles where id = ?', tileId)
  if (!t) throw new Error(`No tile ${tileId}`)
  if (!get<any>('select 1 from boards where id = ?', boardId)) throw new Error(`No board ${boardId}`)
  useBoard(boardId)
  const c = saveTile({ folder_id: boardId, kind: t.kind, w: t.w, h: t.h, config: JSON.parse(t.config), state: t.state ? JSON.parse(t.state) : null })
  touch(boardId)
  return c
}
const touch = (id: string) => run('update boards set updated_at = ? where id = ?', Date.now(), id)

// A project's plan as a board: one `plan` tile (the template every project shares: goal, done-when,
// workstreams with progress bars, sparklines, gates, agents and PRs, all read live from the
// project). Reused when it exists; shown beside the driving chat.
export function ensurePlanBoard(conversationId: string, opts: { show?: boolean } = {}) {
  expireBoards()
  const p = get<any>('select goal from projects where conversation_id = ?', conversationId)
  if (!p) throw new Error('This conversation has no project.')
  let boardId = get<any>(`select t.folder_id from canvas_tiles t join boards b on b.id = t.folder_id
    where t.kind = 'plan' and json_extract(t.config, '$.conversation_id') = ? order by b.updated_at desc limit 1`, conversationId)?.folder_id as string | undefined
  if (!boardId) {
    const goal = String(p.goal).split(/[.:\n]/)[0].trim()
    const made: string = createBoard(`Plan: ${goal.length > 50 ? `${goal.slice(0, 50)}…` : goal}`, `Live plan for perch://${conversationId}: workstreams, north-star metrics, agents and PRs.`, 'perch', { temporary: false })!.id
    saveTile({ folder_id: made, kind: 'plan', w: 12, h: 14, config: { conversation_id: conversationId, title: 'Plan' } })
    boardId = made
  }
  if (opts.show !== false) showBoard(conversationId, boardId, 'side')
  return boardId as string
}

// Which board a chat shows, and how: beside the conversation, or instead of it.
export const chatBoard = (conversationId: string) => { expireBoards(); return get<{ board_id: string; layout: 'side' | 'full' }>('select board_id, layout from chat_boards where conversation_id = ?', conversationId) ?? null }
export function showBoard(conversationId: string, boardId: string | null, layout: 'side' | 'full' = 'side') {
  if (!boardId) run('delete from chat_boards where conversation_id = ?', conversationId)
  else {
    if (!useBoard(boardId)) throw new Error(`No board ${boardId}`)
    run(`insert into chat_boards (conversation_id, board_id, layout) values (?, ?, ?) on conflict(conversation_id) do update set board_id = excluded.board_id, layout = excluded.layout`, conversationId, boardId, layout)
  }
  changed()
}
