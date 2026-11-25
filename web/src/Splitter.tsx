// A draggable edge for a side column. The width is remembered per column; double-click resets it.
import React, { useEffect, useState } from 'react'

export function useColumnWidth(key: string, def: number, min: number, max: number) {
  const [w, setW] = useState(() => { const v = Number(localStorage.getItem(`perch.w.${key}`)); return v >= min && v <= max ? v : def })
  useEffect(() => { try { localStorage.setItem(`perch.w.${key}`, String(w)) } catch {} }, [key, w])
  return { width: w, setWidth: (n: number) => setW(Math.round(Math.max(min, Math.min(max, n)))), reset: () => setW(def) }
}

// side: which edge of the window the column is on, so dragging toward the middle widens it.
// onCollapse: dragging well past the narrowest width hides the column (its width is kept for when it comes back).
export function Splitter({ side, width, onWidth, onReset, onCollapse, collapseBelow = 150 }: { side: 'left' | 'right'; width: number; onWidth: (w: number) => void; onReset: () => void; onCollapse?: () => void; collapseBelow?: number }) {
  const [drag, setDrag] = useState(false)
  useEffect(() => {
    if (!drag) return
    const start = { w: width }
    let x0: number | null = null
    const move = (e: PointerEvent) => {
      x0 ??= e.clientX
      const want = start.w + (side === 'left' ? e.clientX - x0 : x0 - e.clientX)
      if (onCollapse && want < collapseBelow) { onWidth(start.w); setDrag(false); onCollapse(); return }
      onWidth(want)
    }
    const up = () => setDrag(false)
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    document.body.classList.add('resizing')
    return () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); document.body.classList.remove('resizing') }
  }, [drag]) // eslint-disable-line
  return <div className={`splitter ${side} ${drag ? 'on' : ''}`} onPointerDown={e => { e.preventDefault(); setDrag(true) }} onDoubleClick={onReset} title="Drag to resize · double-click to reset" />
}

// The tab left at the window edge when a column is collapsed. Click it to bring the column back at its
// remembered width; drag it to pull the column out, its width following the pointer. Letting go while it is
// still narrower than collapseBelow puts it away again.
export function EdgeHandle({ side, onOpen, title, onWidth, onClose, collapseBelow = 150 }: { side: 'left' | 'right'; onOpen: () => void; title: string; onWidth?: (w: number) => void; onClose?: () => void; collapseBelow?: number }) {
  const down = (e: React.PointerEvent) => {
    e.preventDefault()
    const x0 = e.clientX
    let opened = false
    const dist = (x: number) => side === 'left' ? x : innerWidth - x
    const move = (m: PointerEvent) => {
      if (!opened && (side === 'left' ? m.clientX - x0 : x0 - m.clientX) > 24) {
        opened = true
        if (onWidth) document.body.classList.add('resizing')
        onOpen()
      }
      if (opened && onWidth) onWidth(dist(m.clientX))
    }
    const up = (u: PointerEvent) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up)
      document.body.classList.remove('resizing')
      if (!opened) return onOpen()
      if (onWidth && onClose && dist(u.clientX) < collapseBelow) onClose()
    }
    addEventListener('pointermove', move); addEventListener('pointerup', up)
  }
  return <div className={`edge-handle ${side} no-drag`} onPointerDown={down} title={title} role="button" aria-label={title} />
}
