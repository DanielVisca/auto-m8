// Draws a layout file (server/layout.ts) as the window: rows and columns of perch's own views
// (sidebar, main, details) and tiles. The shipped "default" layout keeps App.tsx's hand-built
// window, with its drag-to-resize columns; every other layout comes through here.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { api, onTopic, post, useLive } from './api'
import { inlineDoc, tileTheme } from './tileBridge'

export type LayoutNode = {
  id: string
  type: 'row' | 'column' | 'block'
  size?: { px: number } | { weight: number }
  min?: number
  max?: number
  hidden?: boolean
  divider?: boolean
  children?: LayoutNode[]
  content?: { view: 'sidebar' | 'main' | 'details' } | { tile: string; vars?: Record<string, string | number | boolean> }
}
export type Layout = LayoutNode & { theme?: 'system' | 'light' | 'dark'; colors?: Record<string, string> }
export type LayoutState = { name: string; active: string; layout: Layout; shipped: boolean; error: string | null; layouts: { name: string; shipped: boolean }[]; dir: string }

export function useLayout() {
  return useLive<LayoutState>('/api/layouts', ['layouts']).data
}

// Puts the layout's colours on the page, and takes them off again when it changes.
export function useLayoutColors(colors: Record<string, string> | undefined) {
  const key = JSON.stringify(colors ?? {})
  useEffect(() => {
    const root = document.documentElement
    const set = Object.entries(colors ?? {})
    for (const [k, v] of set) root.style.setProperty(`--${k}`, v)
    return () => { for (const [k] of set) root.style.removeProperty(`--${k}`) }
  }, [key]) // eslint-disable-line
}

// The escape hatch: ⌘⌥⇧Escape goes back to the shipped default, however broken a layout is.
export function useLayoutEscape() {
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === 'Escape' && e.metaKey && e.altKey && e.shiftKey) { e.preventDefault(); post('/api/layouts/reset', {}) } }
    addEventListener('keydown', f)
    return () => removeEventListener('keydown', f)
  }, [])
}

export type Slots = { sidebar: ReactNode | null; main: ReactNode; details: ReactNode | null }

// A command a layout tile asked for. Each one only navigates; none changes data.
export type Run = (command: string, args: any) => string | null

// What sits in the window's top-left corner, under the Mac window buttons: a view's name, or a tile's
// node id. Leaves that are hidden or have nothing to show right now don't count.
export function topLeftOf(node: LayoutNode, shown: { sidebar: boolean; details: boolean }): string | null {
  if (node.hidden) return null
  if (node.type === 'block') {
    const c = node.content!
    if ('view' in c) return c.view === 'main' || shown[c.view] ? c.view : null
    return node.id
  }
  for (const child of node.children ?? []) { const t = topLeftOf(child, shown); if (t) return t }
  return null
}

export function LayoutTree({ node, slots, run, corner, dir = 'row' }: { node: LayoutNode; slots: Slots; run: Run; corner?: string | null; dir?: 'row' | 'column' }) {
  const content = (n: LayoutNode): ReactNode | null => {
    if (n.hidden) return null
    if (n.type !== 'block') {
      const kids = (n.children ?? []).map(c => [c, content(c)] as const).filter(([, el]) => el !== null)
      if (!kids.length) return null
      const d = n.type === 'row' ? 'row' : 'column'
      return <div className={`layout-${d}`}>{kids.map(([c, el]) => <Cell key={c.id} node={c} dir={d} corner={corner}>{el}</Cell>)}</div>
    }
    const c = n.content!
    if ('view' in c) return slots[c.view] ?? null
    return <LayoutTile path={c.tile} vars={c.vars ?? {}} run={run} />
  }
  const el = content(node)
  return <Cell node={node} dir={dir} corner={corner} root>{el}</Cell>
}

function Cell({ node, dir, root, corner, children }: { node: LayoutNode; dir: 'row' | 'column'; root?: boolean; corner?: string | null; children: ReactNode }) {
  if (children === null) return null
  const along = dir === 'row' ? 'Width' : 'Height'
  const style: CSSProperties = { display: 'flex', minWidth: 0, minHeight: 0 }
  if (root) style.flex = 1
  else if (node.size && 'px' in node.size) style.flex = `0 0 ${node.size.px}px`
  else style.flex = `${node.size && 'weight' in node.size ? node.size.weight : 1} 1 0`
  if (node.min !== undefined) (style as any)[`min${along}`] = node.min
  if (node.max !== undefined) (style as any)[`max${along}`] = node.max
  if (node.divider) (style as any)[dir === 'row' ? 'borderRight' : 'borderBottom'] = '1px solid var(--line)'
  const view = node.content && 'view' in node.content ? node.content.view : undefined
  // The main view and the sidebar already leave room for the window buttons; anything else gets a strip.
  const inCorner = node.type === 'block' && !!corner && (view ? view === corner : node.id === corner)
  if (inCorner && view !== 'main' && view !== 'sidebar') style.paddingTop = 28
  return <div className={`layout-cell ${inCorner ? 'layout-corner' : ''}`} data-layout-id={node.id} style={style}>{children}</div>
}

const SOURCES = new Set(['posthog', 'github', 'perch'])

function LayoutTile({ path, vars, run }: { path: string; vars: Record<string, string | number | boolean>; run: Run }) {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  // Saving the tile's file reloads it; the folder watch sends 'layouts'.
  useEffect(() => {
    let live = true
    const load = () => api.get<{ html?: string; error?: string }>(`/api/layouts/tile?path=${encodeURIComponent(path)}`)
      .then(r => { if (!live) return; if (r.error) { setError(`${path}: ${r.error}`); setHtml(null) } else { setHtml(r.html ?? ''); setError(null) } })
      .catch(e => live && setError(String(e?.message ?? e)))
    load()
    const off = onTopic('layouts', load)
    return () => { live = false; off() }
  }, [path])
  const doc = useMemo(() => html === null ? null : inlineDoc(tileTheme(), vars, html), [html, JSON.stringify(vars)]) // eslint-disable-line
  const runRef = useRef(run)
  runRef.current = run
  useEffect(() => {
    const on = async (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return
      const m = e.data ?? {}
      const reply = (data: any, err?: string) => frame.current?.contentWindow?.postMessage({ perch: 'reply', id: m.id, data, error: err }, '*')
      if (m.perch === 'data') {
        if (!SOURCES.has(m.payload?.source)) return reply(null, `A layout tile can read posthog, github or perch data, not ${m.payload?.source ?? 'nothing'}.`)
        const r = await post<any>('/api/canvas/data', m.payload).catch((err: any) => ({ error: String(err?.message ?? err) }))
        if (r?.error) reply(null, r.error); else reply(r.data)
      }
      if (m.perch === 'run') { const err = runRef.current(String(m.payload?.command ?? ''), m.payload?.args ?? {}); err ? reply(null, err) : reply(true) }
      if (m.perch === 'save') reply(true)
      if (m.perch === 'error') setError(`${path}: ${m.payload}`)
    }
    addEventListener('message', on)
    const kick = () => { if (document.visibilityState === 'visible') frame.current?.contentWindow?.postMessage({ perch: 'refresh' }, '*') }
    let soon: any
    const debounced = () => { clearTimeout(soon); soon = setTimeout(kick, 600) }
    const offs = (['canvasdata', 'prs', 'prflow', 'home', 'conversations'] as const).map(tp => onTopic(tp, debounced))
    document.addEventListener('visibilitychange', kick)
    return () => { removeEventListener('message', on); offs.forEach(o => o()); clearTimeout(soon); document.removeEventListener('visibilitychange', kick) }
  }, [path])
  return (
    <div className="layout-tile">
      {doc !== null && <iframe ref={frame} sandbox="allow-scripts" srcDoc={doc} title={path} onLoad={() => frame.current?.contentWindow?.postMessage({ perch: 'refresh' }, '*')} />}
      {error && <div className="bad small layout-tile-err">{error}</div>}
    </div>
  )
}
