// The product research canvas: a pinned board with one code tile that reads /api/product-research.
// Product research lives on a board rather than a tab. This keeps the board in step with the
// tile source (productresearchboard.html) on every start, and never duplicates it.
import { readFileSync } from 'node:fs'
import { board, boards, createBoard, putTile, updateBoard } from './boards.ts'

export const PRODUCT_BOARD_NAME = 'Product research'
export const PRODUCT_TILE_TITLE = 'Product research'
const html = readFileSync(new URL('./productresearchboard.html', import.meta.url), 'utf8')

export async function ensureProductBoard(): Promise<string> {
  const existing = boards(PRODUCT_BOARD_NAME).find(b => b.name === PRODUCT_BOARD_NAME)
  const id = existing?.id ?? createBoard(PRODUCT_BOARD_NAME, 'Products, workflows and screenshots from the product research queue. Docs only is not tested; not found is not absent.', 'perch').id
  const b = board(id)!
  if (!b.pinned) updateBoard(id, { pinned: true })
  const tile = (b.tiles as any[]).find(t => t.kind === 'code' && t.config?.title === PRODUCT_TILE_TITLE)
  if (!tile) await putTile({ board_id: id, kind: 'code', title: PRODUCT_TILE_TITLE, html, w: 12, h: 10 })
  else if (tile.config?.html !== html) await putTile({ tile_id: tile.id, html })
  return id
}
