// Every dropdown renders here: in a portal above everything (so no scrolling or clipped parent
// can hide it), fixed to its anchor, kept inside the window, and flipped up when there is no
// room below. On a narrow screen it becomes a full-width sheet.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

export function Popover({ anchor, open, onClose, children, align = 'end', width }: {
  anchor: RefObject<HTMLElement | null>; open: boolean; onClose: () => void; children: ReactNode; align?: 'start' | 'end'; width?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: 'hidden' })
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const a = anchor.current?.getBoundingClientRect()
      const el = ref.current
      if (!a || !el) return
      const m = 8, vw = innerWidth, vh = innerHeight
      if (vw < 480) { setStyle({ left: m, right: m, bottom: m, maxHeight: vh * 0.7 }); return } // sheet on a phone
      const w = Math.min(width ?? el.offsetWidth, vw - 2 * m)
      let left = align === 'end' ? a.right - w : a.left
      left = Math.max(m, Math.min(left, vw - w - m))
      // Measure the content, not the box (the box is capped by the last measurement).
      const content = (el.firstElementChild as HTMLElement | null)?.scrollHeight ?? el.scrollHeight
      // Pick the side first (below if it fits, else whichever is roomier), then fit to that side.
      const below = vh - a.bottom - m - 4, above = a.top - m - 4
      const down = content <= below || below >= above
      const room = Math.max(120, Math.min(down ? below : above, vh - 2 * m))
      const h = Math.min(content + 2, room)
      // Whatever happens, the box stays inside the window.
      const top = Math.max(m, Math.min(down ? a.bottom + 4 : a.top - 4 - h, vh - h - m))
      setStyle({ left, top, width: width ? w : undefined, maxHeight: room, height: h })
    }
    place()
    const ro = new ResizeObserver(place)
    if (ref.current) { ro.observe(ref.current); if (ref.current.firstElementChild) ro.observe(ref.current.firstElementChild) }
    const mo = new MutationObserver(place)
    if (ref.current) mo.observe(ref.current, { childList: true, subtree: true })
    addEventListener('resize', place)
    addEventListener('scroll', place, true)
    return () => { ro.disconnect(); mo.disconnect(); removeEventListener('resize', place); removeEventListener('scroll', place, true) }
  }, [open, anchor, align, width])
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('mousedown', down)
    addEventListener('keydown', key)
    return () => { removeEventListener('mousedown', down); removeEventListener('keydown', key) }
  }, [open, onClose, anchor])
  if (!open) return null
  return createPortal(<div ref={ref} className="popover" style={style}>{children}</div>, document.body)
}
