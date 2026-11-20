// A draggable edge for a side column. The width is remembered per column; double-click resets it.
import { useEffect, useState } from 'react'

export function useColumnWidth(key: string, def: number, min: number, max: number) {
  const [w, setW] = useState(() => { const v = Number(localStorage.getItem(`perch.w.${key}`)); return v >= min && v <= max ? v : def })
  useEffect(() => { try { localStorage.setItem(`perch.w.${key}`, String(w)) } catch {} }, [key, w])
  return { width: w, setWidth: (n: number) => setW(Math.round(Math.max(min, Math.min(max, n)))), reset: () => setW(def) }
}

// side: which edge of the window the column is on, so dragging toward the middle widens it.
export function Splitter({ side, width, onWidth, onReset }: { side: 'left' | 'right'; width: number; onWidth: (w: number) => void; onReset: () => void }) {
  const [drag, setDrag] = useState(false)
  useEffect(() => {
    if (!drag) return
    const start = { w: width }
    let x0: number | null = null
    const move = (e: PointerEvent) => {
      x0 ??= e.clientX
      onWidth(start.w + (side === 'left' ? e.clientX - x0 : x0 - e.clientX))
    }
    const up = () => setDrag(false)
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    document.body.classList.add('resizing')
    return () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); document.body.classList.remove('resizing') }
  }, [drag]) // eslint-disable-line
  return <div className={`splitter ${side} ${drag ? 'on' : ''}`} onPointerDown={e => { e.preventDefault(); setDrag(true) }} onDoubleClick={onReset} title="Drag to resize · double-click to reset" />
}
