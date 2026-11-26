// Drag a box over part of a board beside a chat to ask the agent about it. The chat box gets a
// screenshot of the box (in the app; the browser has no way to capture it) and a short reference:
// the board, the tiles under the box and the text inside it.
import { useEffect, useRef, useState } from 'react'
import { shell } from './api'

export type BoardPickDetail = { conversationId: string; png: string | null; note: string }

type Rect = { x: number; y: number; width: number; height: number }
const hits = (a: DOMRect | Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

// The words inside the box, in reading order, from every text node whose line touches it.
function textIn(root: HTMLElement, r: Rect) {
  const out: string[] = [], walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), range = document.createRange()
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const s = n.textContent ?? ''
    if (!s.trim() || (n.parentElement && n.parentElement.closest('.tile-head, button'))) continue
    range.selectNodeContents(n)
    if ([...range.getClientRects()].some(c => hits(c, r))) out.push(s.trim())
  }
  return out.join(' ').replace(/\s+/g, ' ')
}

export function describe(root: HTMLElement, r: Rect, boardName: string) {
  const tiles = [...root.querySelectorAll<HTMLElement>('[data-tile-id]')].filter(t => hits(t.getBoundingClientRect(), r))
  const names = tiles.map(t => `“${t.dataset.tileTitle}” (${t.dataset.tileKind} tile ${t.dataset.tileId})`)
  const text = textIn(root, r)
  const quote = text.length > 400 ? `${text.slice(0, 400)}…` : text
  return `About this part of the board “${boardName}”${names.length ? `, ${names.length === 1 ? 'tile' : 'tiles'} ${names.join(', ')}` : ''}${quote ? `, where it says: “${quote}”` : ''}:\n`
}

// The see-through layer over the board while picking. Esc or a click without a drag cancels.
export function BoardPicker({ root, boardName, conversationId, onDone }: { root: () => HTMLElement | null; boardName: string; conversationId: string; onDone: () => void }) {
  const [box, setBox] = useState<Rect | null>(null)
  const [hidden, setHidden] = useState(false)
  const start = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onDone(); addEventListener('keydown', k); return () => removeEventListener('keydown', k) }, [onDone])
  const down = (e: React.PointerEvent) => { e.preventDefault(); (e.target as Element).setPointerCapture(e.pointerId); start.current = { x: e.clientX, y: e.clientY }; setBox({ x: e.clientX, y: e.clientY, width: 0, height: 0 }) }
  const move = (e: React.PointerEvent) => {
    const s = start.current; if (!s) return
    const el = root()?.getBoundingClientRect()
    const cx = el ? Math.max(el.left, Math.min(el.right, e.clientX)) : e.clientX, cy = el ? Math.max(el.top, Math.min(el.bottom, e.clientY)) : e.clientY
    setBox({ x: Math.min(s.x, cx), y: Math.min(s.y, cy), width: Math.abs(cx - s.x), height: Math.abs(cy - s.y) })
  }
  const up = async () => {
    const r = box, el = root(); start.current = null
    if (!r || !el || r.width < 12 || r.height < 12) { setBox(null); return }
    const note = describe(el, r, boardName)
    // Take the overlay away first so the screenshot shows the board, not the selection box.
    setHidden(true)
    await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)))
    const png = shell.captureRect ? await shell.captureRect(r).catch(() => null) : null
    window.dispatchEvent(new CustomEvent<BoardPickDetail>('perch-board-pick', { detail: { conversationId, png, note } }))
    onDone()
  }
  if (hidden) return null
  const at = root()?.getBoundingClientRect()
  return (
    <div className="board-pick" style={at ? { left: at.left, top: at.top, width: at.width, height: at.height } : undefined} onPointerDown={down} onPointerMove={move} onPointerUp={up}>
      {!box && <div className="board-pick-hint">Drag over the part you want to ask about · Esc to cancel</div>}
      {box && box.width > 0 && <div className="board-pick-box" style={{ left: box.x, top: box.y, width: box.width, height: box.height }} />}
    </div>
  )
}
