// Draws a layout file (server/layout.ts) as the window: rows and columns of perch's own views
// (sidebar, main, details) and tiles. The shipped "default" layout keeps App.tsx's hand-built
// window, with its drag-to-resize columns; every other layout comes through here.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { api, onTopic, post, sendChat, useLive } from './api'
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
export type Layout = LayoutNode & { theme?: 'system' | 'light' | 'dark'; colors?: Record<string, string>; css?: string }
export type LayoutDraft = { before: string; text: string; at: number; changed: boolean }
export type LayoutState = { name: string; active: string; layout: Layout; css?: string | null; shipped: boolean; error: string | null; layouts: { name: string; shipped: boolean }[]; dir: string; draft: LayoutDraft | null }
export type LayoutVersion = { id: string; at: number; label: string; active: string; files: number }

// What the person pointed at: enough for an agent to find it again (a CSS selector, its text, a bit of
// its HTML) and for the window to outline it while they type.
export type UiTarget = { selector: string; label: string; text: string; html: string; region: string }

// Asks an agent to change the UI in plain words. The server saves a version first, so the change is a
// draft until it's kept, and Undo puts the window back. With a target, the change is about that part
// only; with saveAs, it goes into a new layout and the one you had stays as it was. Returns the chat id.
export async function askForUi(text: string, l: LayoutState, brief?: string, opts: { target?: UiTarget | null; saveAs?: string | null } = {}): Promise<string | null> {
  const r = await post<any>('/api/layouts/ask', { text })
  if (r?.error) throw new Error(r.error)
  const shipped = l.layouts.find(x => x.name === l.active)?.shipped
  const saveAs = opts.saveAs || null
  const where = saveAs
    ? `Make it a new layout: copy "${l.active}" (with its tiles and stylesheet) to ${l.dir}/${saveAs}.json, make the change there, and switch to it by setting the active layout. Leave "${l.active}" as it is.`
    : shipped
      ? `The active layout is "${l.active}", which ships with auto-m8 and can't be edited: copy it to a new file, make the change there, and switch to it by setting the active layout.`
      : `The active layout is "${l.active}" (${l.dir}/${l.active}.json): change it in place.`
  const t = opts.target
  const pointed = t ? `\n\nThe person pointed at one part of the window, in the ${t.region}. Change that part and nothing else.\n- CSS selector: ${t.selector}\n- Text there: ${JSON.stringify(t.text)}\n- Its HTML starts: ${t.html}\nIf it is inside a built-in view (sidebar, main, details), use the layout's "css" stylesheet (see AGENTS.md); if it is a tile, edit that tile.` : ''
  const prompt = `Change how auto-m8 looks: ${text}${pointed}\n\nWork only in this layouts folder (${l.dir}) and follow its AGENTS.md. ${where} auto-m8 saved a version before you started and shows the person Keep and Undo, so just make the change; don't ask first. If it needs something a layout can't do yet, say exactly what is missing instead of editing app code.`
  const c = await sendChat<{ id: string }>({ prompt: brief ? `${brief}\n\nWork only in this layouts folder (${l.dir}) and follow its AGENTS.md. auto-m8 saved a version before you started and shows the person Keep and Undo.` : prompt, cwd: l.dir, noRoute: true })
  if (c?.id) try { localStorage.setItem('perch.layout.askChat', c.id) } catch {}
  return c?.id ?? null
}

// Classes that say what state something is in, not what it is: no good for finding it again.
const STATE_CLASS = /^(on|off|active|open|closed|selected|hover|focus|focused|busy|dim|drag|no-drag|grow|small|muted|ellipsis)$/
const REGIONS: [string, string][] = [['.layout-tile', 'a layout tile'], ['.sidebar', 'sidebar'], ['.detail-col', 'details column'], ['.main', 'main view']]

// A selector for el, from the nearest stable landmark down: a layout block ([data-layout-id]) or a
// built-in view, then up to four steps of tag and stable classes.
export function describeTarget(el: Element): UiTarget {
  const steps: string[] = []
  let n: Element | null = el
  while (n && n !== document.body && steps.length < 5) {
    const cell = n.getAttribute('data-layout-id')
    if (cell) { steps.unshift(`[data-layout-id="${cell}"]`); break }
    const classes = [...n.classList].filter(c => !STATE_CLASS.test(c) && !/\d{3,}/.test(c)).slice(0, 2)
    let part = n.tagName.toLowerCase() + classes.map(c => '.' + CSS.escape(c)).join('')
    // Among look-alike siblings (two tab buttons), say which one.
    const same = n.parentElement ? [...n.parentElement.children].filter(x => x.tagName === n!.tagName) : []
    if (same.length > 1 && same.filter(x => classes.every(c => x.classList.contains(c))).length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`
    if (classes.length || steps.length === 0 || part.includes(':nth')) steps.unshift(part)
    if (['sidebar', 'main', 'detail-col', 'app'].some(c => n!.classList.contains(c))) break
    n = n.parentElement
  }
  const region = REGIONS.find(([sel]) => el.closest(sel))?.[1] ?? 'window'
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const html = el.outerHTML.replace(/\s+/g, ' ').slice(0, 300)
  const label = `${region} › ${text ? `“${text.slice(0, 40)}”` : steps[steps.length - 1]}`
  return { selector: steps.join(' '), label, text, html, region }
}

// The outline over what's being customized. Follows it if the window moves or resizes.
function Highlight({ el }: { el: Element | null }) {
  const [r, setR] = useState<DOMRect | null>(null)
  useEffect(() => {
    if (!el) { setR(null); return }
    let raf = 0
    const tick = () => { setR(el.isConnected ? el.getBoundingClientRect() : null); raf = requestAnimationFrame(tick) }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [el])
  if (!r) return null
  return <div className="ui-highlight" style={{ left: r.left - 3, top: r.top - 3, width: r.width + 6, height: r.height + 6 }} />
}

// Right-click anywhere auto-m8 has no menu of its own: "Customize this…" outlines that part and opens
// the ask box about it. Text fields and selected text keep their usual right-click.
export function UiCustomizeMenu() {
  const [at, setAt] = useState<{ x: number; y: number; el: Element } | null>(null)
  useEffect(() => {
    const f = (e: MouseEvent) => {
      if (e.defaultPrevented) return
      const el = e.target as HTMLElement
      if (!el?.closest || el.closest('input, textarea, select, [contenteditable="true"], .ui-ask, .ui-menu, .xterm')) return
      if (String(getSelection() ?? '').trim()) return
      e.preventDefault()
      setAt({ x: Math.min(e.clientX, innerWidth - 230), y: Math.min(e.clientY, innerHeight - 60), el })
    }
    addEventListener('contextmenu', f)
    return () => removeEventListener('contextmenu', f)
  }, [])
  useEffect(() => {
    if (!at) return
    const close = (e: Event) => { if (!(e.target as HTMLElement)?.closest?.('.ui-menu')) setAt(null) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAt(null) }
    addEventListener('mousedown', close); addEventListener('keydown', esc); addEventListener('scroll', close, true)
    return () => { removeEventListener('mousedown', close); removeEventListener('keydown', esc); removeEventListener('scroll', close, true) }
  }, [at])
  if (!at) return null
  return <>
    <Highlight el={at.el} />
    <div className="ctx ui-menu" style={{ left: at.x, top: at.y }}>
      <button onClick={() => { const el = at.el; setAt(null); window.dispatchEvent(new CustomEvent('perch-ui-ask', { detail: { el } })) }}>🎨 Customize this…</button>
    </div>
  </>
}

// ⌘⇧U: a small box to ask for a UI change. Type, press Enter, keep working; the Keep/Undo bar at the
// top shows up when the window has changed. "Pick" (or right-click → Customize this) points it at one
// part of the window, outlined while you type. It changes the open layout, or saves a new one.
export function UiAsk() {
  const l = useLayout()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [el, setEl] = useState<Element | null>(null)
  const [picking, setPicking] = useState(false)
  const [hover, setHover] = useState<Element | null>(null)
  const [mode, setMode] = useState<'edit' | 'new'>('edit')
  const [name, setName] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'u') { e.preventDefault(); setOpen(o => !o); setErr(null); setEl(null) } }
    const ev = (e: Event) => { setOpen(true); setErr(null); setPicking(false); setEl((e as CustomEvent).detail?.el ?? null); setTimeout(() => input.current?.focus(), 0) }
    addEventListener('keydown', f); addEventListener('perch-ui-ask', ev)
    return () => { removeEventListener('keydown', f); removeEventListener('perch-ui-ask', ev) }
  }, [])
  // Picking: hover outlines, click chooses, Escape gives up. Clicks don't reach the app meanwhile.
  useEffect(() => {
    if (!picking) return
    const under = (e: MouseEvent) => { const t = document.elementsFromPoint(e.clientX, e.clientY).find(x => !x.closest('.ui-highlight, .ui-pick-hint')); return t ?? null }
    const move = (e: MouseEvent) => setHover(under(e))
    const click = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); const t = under(e); setPicking(false); setHover(null); if (t) setEl(t); setTimeout(() => input.current?.focus(), 0) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setPicking(false); setHover(null) } }
    addEventListener('mousemove', move, true); addEventListener('click', click, true); addEventListener('keydown', esc, true)
    return () => { removeEventListener('mousemove', move, true); removeEventListener('click', click, true); removeEventListener('keydown', esc, true) }
  }, [picking])
  const shipped = !!l?.layouts.find(x => x.name === l.active)?.shipped
  useEffect(() => { if (open && l) { setMode(shipped ? 'new' : 'edit'); setName(n => n || `${l.active}-mine`) } }, [open, l?.active]) // eslint-disable-line
  if (!l) return null
  if (picking) return <><Highlight el={hover} /><div className="ui-pick-hint">Click the part to customize · Esc cancels</div></>
  if (!open) return null
  const target = el ? describeTarget(el) : null
  const close = () => { setOpen(false); setEl(null) }
  const go = async () => {
    if (!text.trim()) return
    const saveAs = mode === 'new' ? name.trim() : null
    if (saveAs !== null && !/^[a-z0-9][a-z0-9-]{0,40}$/.test(saveAs)) { setErr('Name the new layout with lowercase letters, digits and dashes'); return }
    if (saveAs && l.layouts.some(x => x.name === saveAs)) { setErr(`There is already a layout called ${saveAs}`); return }
    try { await askForUi(text.trim(), l, undefined, { target, saveAs }); setText(''); close() } catch (e: any) { setErr(String(e?.message ?? e)) }
  }
  return <>
    <Highlight el={el} />
    <div className="ui-ask-scrim" onMouseDown={e => { if (e.target === e.currentTarget) close() }}>
      <div className="ui-ask">
        {target
          ? <div className="ui-ask-target"><span className="ellipsis" title={target.selector}>Customizing <b>{target.label}</b></span><button className="small" onClick={() => setPicking(true)}>Pick again</button><button className="small" onClick={() => setEl(null)}>Whole window</button></div>
          : <div className="ui-ask-target muted"><span>Whole window</span><button className="small" onClick={() => setPicking(true)} title="Point at one part of the window">Pick a part</button></div>}
        <input ref={input} autoFocus value={text} placeholder={target ? 'What should this part look like? e.g. hide it, smaller, bolder, a different colour' : 'Change the UI… e.g. sidebar on the right, warmer colours, a clock above details'} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') go(); if (e.key === 'Escape') close() }} />
        <div className="ui-ask-mode small">
          <label className={shipped ? 'muted' : ''} title={shipped ? `${l.active} ships with auto-m8, so changes go into a new layout` : ''}><input type="radio" disabled={shipped} checked={mode === 'edit'} onChange={() => setMode('edit')} /> Change <b>{l.active}</b></label>
          <label><input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> Save as new layout</label>
          {mode === 'new' && <input className="ui-ask-name" value={name} onChange={e => setName(e.target.value)} placeholder="my-layout" />}
        </div>
        <div className="muted small">{err ? <span className="bad">{err}</span> : <>Enter asks an agent. Keep or Undo it from the bar at the top. Versions are in Settings → Layout. Right-click anything to customize it.</>}</div>
      </div>
    </div>
  </>
}

// The layout's own stylesheet ("css" in the layout file), on the page while that layout shows.
export function useLayoutCss(css: string | null | undefined) {
  useEffect(() => {
    if (!css) return
    const tag = document.createElement('style')
    tag.id = 'layout-css'
    tag.textContent = css
    document.head.appendChild(tag)
    return () => tag.remove()
  }, [css])
}

// The top-bar way in: switch between your layouts in one click, or ask for a change (same as ⌘⇧U).
export function UiButton() {
  const l = useLayout()
  const favs = useLayoutsAll()?.favourites ?? []
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!at) return
    const close = (e: Event) => { if (!(e.target as HTMLElement)?.closest?.('.ui-menu')) setAt(null) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAt(null) }
    addEventListener('mousedown', close); addEventListener('keydown', esc)
    return () => { removeEventListener('mousedown', close); removeEventListener('keydown', esc) }
  }, [at])
  const pick = (name: string) => { setAt(null); switchLayout(name) }
  return <>
    <button className="icon no-drag" title="Layouts and UI changes  ⌘⇧L next layout · ⌘⇧U change" aria-label="Change the UI"
      onClick={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setAt(at ? null : { x: Math.min(r.left, innerWidth - 240), y: r.bottom + 4 }) }}>🎨</button>
    {at && l && <div className="ctx ui-menu" style={{ left: at.x, top: at.y }}>
      <div className="ctx-head">Layout · ⌘⇧L next</div>
      {l.layouts.map(x => { const f = favs.indexOf(x.name); return <button key={x.name} onClick={() => pick(x.name)}>
        <span style={{ width: 12 }}>{l.active === x.name ? '✓' : ''}</span>{f >= 0 ? '★ ' : ''}{x.name}<span className="muted small" style={{ marginLeft: 'auto' }}>{f >= 0 ? `⌘⌥${f + 1}` : x.shipped ? 'built in' : ''}</span>
      </button> })}
      <div className="ctx-head" style={{ borderTop: '1px solid var(--line)', marginTop: 4 }} />
      <button onClick={() => { setAt(null); window.dispatchEvent(new Event('perch-ui-ask')) }}>Change the UI… <span className="muted small" style={{ marginLeft: 'auto' }}>⌘⇧U</span></button>
      <button onClick={() => { setAt(null); location.hash = '#settings/layout' }}>Browse, try and favourite layouts…</button>
    </div>}
  </>
}

export const switchLayout = (name: string) => api.send('PUT', '/api/layouts/active', { name })

export type LayoutEntry = { name: string; shipped: boolean; layout: Layout; error: string | null }
export function useLayoutsAll() {
  return useLive<{ layouts: LayoutEntry[]; favourites: string[] }>('/api/layouts/all', ['layouts', 'settings']).data
}
export const tryLayout = (name: string) => post<any>('/api/layouts/try', { name })
export const favouriteLayout = (name: string, on: boolean) => post<any>('/api/layouts/favourite', { name, on })

// ⌘⇧L: the next favourite (or the next layout when fewer than two are starred), so flipping between
// two is one key. ⌘⌥1-9: straight to favourite 1-9.
export function useLayoutCycle() {
  const l = useLayout()
  const all = useLayoutsAll()
  const ref = useRef({ l, favs: all?.favourites ?? [] })
  ref.current = { l, favs: all?.favourites ?? [] }
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      const { l: s, favs } = ref.current
      if (!s?.layouts.length) return
      const digit = /^Digit([1-9])$/.exec(e.code)
      if (e.metaKey && e.altKey && !e.shiftKey && !e.ctrlKey && digit) {
        const name = favs[Number(digit[1]) - 1]
        if (!name) return
        e.preventDefault(); switchLayout(name); return
      }
      if (!(e.metaKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l')) return
      e.preventDefault()
      const ring = favs.length >= 2 ? favs : s.layouts.map(x => x.name)
      const i = ring.indexOf(s.active)
      switchLayout(ring[(i + 1) % ring.length])
    }
    addEventListener('keydown', f)
    return () => removeEventListener('keydown', f)
  }, [])
}

// A layout in miniature: its rows, columns and blocks as boxes, in its own colours.
export function LayoutPreview({ layout, height = 90 }: { layout: Layout; height?: number }) {
  const dark = layout.theme === 'dark'
  const c = layout.colors ?? {}
  const bg = c.bg ?? (layout.theme ? (dark ? '#1b1d21' : '#fafafa') : 'var(--bg)')
  const box = c.bg2 ?? (layout.theme ? (dark ? '#26292f' : '#eceef1') : 'var(--bg2)')
  const fg = c.muted ?? (layout.theme ? (dark ? '#9aa1ab' : '#6b7280') : 'var(--muted)')
  const accent = c.accent ?? 'var(--accent)'
  const line = c.line ?? 'var(--line)'
  const draw = (n: LayoutNode, dir: 'row' | 'column'): ReactNode => {
    if (n.hidden) return null
    const flex = n.size && 'px' in n.size ? `0 0 ${Math.max(6, n.size.px / 14)}%` : `${n.size && 'weight' in n.size ? n.size.weight : 1} 1 0`
    const st: CSSProperties = { flex, display: 'flex', minWidth: 0, minHeight: 0, gap: 2, flexDirection: n.type === 'column' ? 'column' : 'row' }
    if (n.type !== 'block') return <div key={n.id} style={st}>{(n.children ?? []).map(k => draw(k, n.type === 'column' ? 'column' : 'row'))}</div>
    const v = n.content && 'view' in n.content ? n.content.view : null
    const label = v ?? (n.content && 'tile' in n.content ? n.content.tile.replace(/^.*\//, '').replace(/\.html$/, '') : n.id)
    return <div key={n.id} title={label} style={{ ...st, borderRadius: 3, background: v === 'main' ? bg : box, border: `1px ${v ? 'solid' : 'dashed'} ${v === 'main' ? accent : line}`,
      alignItems: 'center', justifyContent: 'center', fontSize: 9, color: fg, overflow: 'hidden', whiteSpace: 'nowrap', [dir === 'row' ? 'minWidth' : 'minHeight']: 6 }}>{label}</div>
  }
  return <div className="layout-preview" style={{ height, background: bg, borderColor: line }}>{draw(layout, 'row')}</div>
}

// Every layout as a card: a preview, Try (a draft you Keep or Undo from the top bar), Use, and a
// star that puts it on ⌘⌥1-9. Settings → Layout and Explore → Layouts both show this.
export function LayoutCards() {
  const l = useLayout()
  const all = useLayoutsAll()
  const [msg, setMsg] = useState<string | null>(null)
  if (!l || !all) return <div className="muted small">…</div>
  const favs = all.favourites
  const say = (r: any) => setMsg(r?.error ?? null)
  const order = [...all.layouts].sort((a, b) => (favs.indexOf(a.name) + 1 || 99) - (favs.indexOf(b.name) + 1 || 99))
  return <>
    <div className="layout-cards">
      {order.map(x => {
        const fav = favs.indexOf(x.name)
        const on = l.active === x.name
        return <div key={x.name} className={`layout-card ${on ? 'on' : ''}`}>
          <button className="layout-card-art" onClick={() => !on && tryLayout(x.name).then(say)} title={on ? 'This is the layout you are using' : 'Try it: Keep or Undo from the bar at the top'}>
            <LayoutPreview layout={x.layout} />
          </button>
          <div className="row-flex" style={{ gap: 6 }}>
            <b className="grow">{x.name}</b>
            {fav >= 0 && <span className="kbd" title="Switch to it from anywhere">⌘⌥{fav + 1}</span>}
            <button className={`icon small ${fav >= 0 ? 'on' : ''}`} title={fav >= 0 ? 'Remove from favourites' : 'Favourite: gets a ⌘⌥ number and joins the ⌘⇧L cycle'}
              disabled={fav < 0 && favs.length >= 9} onClick={() => favouriteLayout(x.name, fav < 0).then(say)}>{fav >= 0 ? '★' : '☆'}</button>
          </div>
          <div className="muted small">{x.shipped ? 'Built in' : 'Yours'}{x.error ? <span className="bad"> · {x.error}</span> : ''}</div>
          <div className="row-flex" style={{ gap: 6 }}>
            {on ? <span className="muted small">In use</span> : <>
              <button className="small" onClick={() => tryLayout(x.name).then(say)} title="Switch now; Undo in the top bar puts it back">Try</button>
              <button className="small" onClick={() => switchLayout(x.name)}>Use</button>
            </>}
          </div>
        </div>
      })}
      <button className="layout-card layout-card-new" onClick={() => window.dispatchEvent(new Event('perch-ui-ask'))} title="Describe a UI and an agent builds it as a draft">
        <div className="layout-preview" style={{ height: 90, display: 'grid', placeItems: 'center', fontSize: 22 }}>＋</div>
        <b>Make your own</b>
        <span className="muted small">Describe it (⌘⇧U). An agent builds it; Keep or Undo.</span>
      </button>
    </div>
    <div className="muted small" style={{ marginTop: 6 }}>
      {l.draft ? <>Trying <b>{l.active}</b>: <button className="link small" onClick={() => post('/api/layouts/keep', {})}>Keep</button> · <button className="link small" onClick={() => post('/api/layouts/undo', {})}>Undo</button>. </> : null}
      ★ favourites switch with ⌘⌥1–9 and ⌘⇧L cycles them{favs.length < 2 ? ' (all layouts until two are starred)' : ''}. ⌘⌥⇧Esc always goes back to default.
    </div>
    {msg && <div className="bad small">{msg}</div>}
  </>
}

// While a change asked for in words is in flight or waiting: what it is, and Keep / Undo.
export function UiDraftBar() {
  const l = useLayout()
  const d = l?.draft
  if (!d) return null
  const chat = (() => { try { return localStorage.getItem('perch.layout.askChat') } catch { return null } })()
  const openChat = () => chat && window.dispatchEvent(new CustomEvent('perch-open', { detail: chat }))
  return <div className="ui-draft-bar">
    <span className="ui-draft-text">{d.changed ? 'UI changed' : 'Changing the UI'}: <b>{d.text}</b></span>
    {chat && <button className="small" onClick={openChat}>Chat</button>}
    {d.changed && <button className="small" onClick={() => post('/api/layouts/keep', {})}>Keep</button>}
    <button className="small" onClick={() => post('/api/layouts/undo', {})} title="Put the window back as it was before you asked">{d.changed ? 'Undo' : 'Cancel'}</button>
  </div>
}

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
  // parent: which way the node's parent lays out, so a tile in the window's corner knows how to clear the buttons.
  const content = (n: LayoutNode, parent: 'row' | 'column' = dir): ReactNode | null => {
    if (n.hidden) return null
    if (n.type !== 'block') {
      const kids = (n.children ?? []).map(c => [c, content(c, n.type === 'row' ? 'row' : 'column')] as const).filter(([, el]) => el !== null)
      if (!kids.length) return null
      const d = n.type === 'row' ? 'row' : 'column'
      return <div className={`layout-${d}`}>{kids.map(([c, el]) => <Cell key={c.id} node={c} dir={d} corner={corner}>{el}</Cell>)}</div>
    }
    const c = n.content!
    if ('view' in c) return slots[c.view] ?? null
    // A full-width bar in the corner (its parent is a column) clears the window buttons on its left,
    // inside the tile, so its colour runs under them and a 44px bar keeps its 44px.
    return <LayoutTile path={c.tile} vars={c.vars ?? {}} run={run} insetLeft={!!corner && n.id === corner && parent === 'column'} />
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
  if (inCorner && view !== 'main' && view !== 'sidebar' && !(dir === 'column' && !view)) style.paddingTop = 28
  return <div className={`layout-cell ${inCorner ? 'layout-corner' : ''}`} data-layout-id={node.id} style={style}>{children}</div>
}

const SOURCES = new Set(['posthog', 'github', 'perch'])

function LayoutTile({ path, vars, run, insetLeft }: { path: string; vars: Record<string, string | number | boolean>; run: Run; insetLeft?: boolean }) {
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
  const doc = useMemo(() => html === null ? null : inlineDoc(tileTheme(), vars, html + (insetLeft ? '<style>body{padding-left:78px!important;box-sizing:border-box}</style>' : '')), [html, insetLeft, JSON.stringify(vars)]) // eslint-disable-line
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
