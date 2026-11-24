// A folder's canvas: a board of tiles you arrange. Web pages (with your logins, even sites that
// refuse to be embedded), chats, terminals, notes, and code tiles: small apps Claude writes when
// you describe one. Code tiles are sandboxed and reach data only through perch.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { onTopic, post, shell, titleOf, toast, useLive, type Conversation, type Term } from './api'
import { Markdown } from './Chat'
import { MiniChat } from './Mini'
import { TermView } from './Term'
import { BrowserTile } from './BrowserView'
import { PlanTile } from './ProjectPlan'
import { BRIDGE } from './tileBridge'

type Tile = { id: string; folder_id: string; kind: 'web' | 'chat' | 'term' | 'note' | 'code' | 'browser' | 'plan'; x: number; y: number; w: number; h: number; config: any; state: any; error: string | null }
const COLS = 12, ROW = 56, GAP = 8
const ICON: Record<Tile['kind'], string> = { web: '◍', chat: '💬', term: '⌘_', note: '✎', code: '✦', browser: '◐', plan: '◎' }

export function Canvas({ folderId, ttlSeconds, conversations, cwd, onOpen }: { folderId: string; ttlSeconds?: number | null; conversations: Conversation[]; cwd?: string | null; onOpen: (id: string) => void }) {
  const { data, reload } = useLive<{ tiles: Tile[] }>(`/api/canvas/${encodeURIComponent(folderId)}`, ['canvas' as any])
  const host = useRef<HTMLDivElement>(null)
  const activityHost = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(800)
  const [ask, setAsk] = useState('')
  const [making, setMaking] = useState(false)
  useEffect(() => {
    if (ttlSeconds == null) return
    let last = 0
    const used = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus() || Date.now() - last < 15_000) return
      last = Date.now()
      post(`/api/boards/${encodeURIComponent(folderId)}/activity`, {}).catch(() => {})
    }
    const root = activityHost.current
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'focusin', 'canvas-activity']
    events.forEach(e => root?.addEventListener(e, used, { passive: true, capture: true }))
    document.addEventListener('visibilitychange', used)
    window.addEventListener('focus', used)
    used()
    return () => {
      events.forEach(e => root?.removeEventListener(e, used, true))
      document.removeEventListener('visibilitychange', used)
      window.removeEventListener('focus', used)
    }
  }, [folderId, ttlSeconds])
  useLayoutEffect(() => {
    if (!host.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(host.current)
    return () => ro.disconnect()
  }, [])
  const tiles = data?.tiles ?? []
  const stacked = W < 480 // narrow window: one column, in board order, no dragging
  const add = (t: Partial<Tile>) => post('/api/canvas/tile', { folder_id: folderId, w: 6, h: 5, ...t }).then(reload)
  const submit = async () => {
    const v = ask.trim()
    if (!v) return
    setAsk('')
    if (/^https?:\/\/\S+$/.test(v)) return add({ kind: 'web', config: { url: v }, w: 6, h: 6 })
    setMaking(true)
    const r = await post<any>('/api/canvas/make', { folder_id: folderId, ask: v })
    setMaking(false)
    if (r.error) toast(r.error)
    reload()
  }
  const colW = (W - GAP * (COLS - 1)) / COLS
  const height = stacked ? undefined : Math.max(...tiles.map(t => (t.y + t.h) * (ROW + GAP)), 200)
  return (
    <div className="canvas" ref={activityHost}>
      <div className="canvas-add row-flex">
        <input className="grow" value={ask} disabled={making} placeholder={making ? 'Claude is making your tile… (~30s)' : '✦ Describe a tile, or paste a URL'}
          title="e.g. “PRs waiting on review, by repo, refresh every 5 min”"
          onChange={e => setAsk(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit() }} />
        <select className="canvas-chat" value="" onChange={e => { const v = e.target.value; if (v) add({ kind: 'chat', config: { conversation_id: v }, w: 4, h: 5 }) }} title="Put a thread from this folder on the board">
          <option value="">+ Chat</option>{conversations.slice(0, 40).map(c => <option key={c.id} value={c.id}>{titleOf(c).slice(0, 60)}</option>)}
        </select>
        <button onClick={() => add({ kind: 'term', config: { cwd }, w: 6, h: 5 })}>+ Terminal</button>
        <button onClick={() => add({ kind: 'note', config: { text: '' }, w: 3, h: 4 })}>+ Note</button>
      </div>
      {!tiles.length && <div className="muted small pad">An empty board. Describe a tile to have Claude build it, paste a URL for a live page (Grafana, a PostHog dashboard), or add a chat, terminal or note.</div>}
      <div ref={host} className={`board${stacked ? ' stacked' : ''}`} style={{ height }}>
        {tiles.map(t => <TileBox key={t.id} t={t} colW={colW} stacked={stacked} onChange={reload} onOpen={onOpen} />)}
      </div>
    </div>
  )
}

function TileBox({ t, colW, stacked, onChange, onOpen }: { t: Tile; colW: number; stacked: boolean; onChange: () => void; onOpen: (id: string) => void }) {
  const [box, setBox] = useState({ x: t.x, y: t.y, w: t.w, h: t.h })
  const [front, setFront] = useState(false)
  useEffect(() => setBox({ x: t.x, y: t.y, w: t.w, h: t.h }), [t.x, t.y, t.w, t.h])
  const save = (patch: Partial<Tile>) => post('/api/canvas/tile', { id: t.id, folder_id: t.folder_id, kind: t.kind, ...patch }).then(onChange)
  // Drag by the header to move, by the corner to resize; both snap to the grid.
  const drag = (e: React.PointerEvent, mode: 'move' | 'size') => {
    if (stacked || (e.target as HTMLElement).closest('button, input, select')) return
    e.preventDefault()
    setFront(true)
    const start = { px: e.clientX, py: e.clientY, ...box }
    let cur = box
    const move = (ev: PointerEvent) => {
      const dx = Math.round((ev.clientX - start.px) / (colW + GAP)), dy = Math.round((ev.clientY - start.py) / (ROW + GAP))
      cur = mode === 'move'
        ? { ...start, x: Math.max(0, Math.min(COLS - start.w, start.x + dx)), y: Math.max(0, start.y + dy) }
        : { ...start, w: Math.max(2, Math.min(COLS - start.x, start.w + dx)), h: Math.max(2, start.h + dy) }
      setBox(cur)
    }
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); setFront(false); save(cur) }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }
  const style = stacked ? { height: Math.max(240, box.h * ROW) } : { left: box.x * (colW + GAP), top: box.y * (ROW + GAP), width: box.w * colW + (box.w - 1) * GAP, height: box.h * ROW + (box.h - 1) * GAP, zIndex: front ? 5 : 1 }
  const title = t.config.title || (t.kind === 'web' ? hostOf(t.config.url) : t.kind === 'term' ? 'Terminal' : t.kind === 'browser' ? 'Agent browser' : t.kind === 'note' ? 'Note' : t.kind === 'chat' ? 'Chat' : t.kind === 'plan' ? 'Plan' : 'Tile')
  return (
    <div className={`tile tile-${t.kind}${front ? ' dragging' : ''}`} style={style}>
      <div className="tile-head" onPointerDown={e => drag(e, 'move')}>
        <span className="muted">{ICON[t.kind]}</span><span className="grow ellipsis" title={title}>{title}</span>
        {t.error && <span className="bad small" title={t.error}>error</span>}
        {(t.kind === 'chat' || t.kind === 'plan') && <button className="icon" onClick={() => onOpen(t.config.conversation_id)} title="Open the full chat">⤢</button>}
        {t.kind === 'web' && <button className="icon" onClick={() => window.open(t.config.url)} title="Open in your browser">↗</button>}
        <button className="icon" onClick={() => { if (confirm(`Remove “${title}” from the board?`)) post(`/api/canvas/tile/${t.id}/delete`).then(onChange) }} title="Remove from the board">×</button>
      </div>
      <div className="tile-body">
        {t.kind === 'web' && <WebTile url={t.config.url} />}
        {t.kind === 'chat' && <MiniChat id={t.config.conversation_id} bare />}
        {t.kind === 'term' && <TermTile t={t} save={save} />}
        {t.kind === 'browser' && <BrowserTile owner={t.config.owner ?? t.config.conversation_id} />}
        {t.kind === 'note' && <NoteTile t={t} save={save} />}
        {t.kind === 'code' && <CodeTile t={t} save={save} onChange={onChange} />}
        {t.kind === 'plan' && <PlanTile id={t.config.conversation_id} />}
      </div>
      {!stacked && <div className="tile-resize" onPointerDown={e => drag(e, 'size')} title="Drag to resize" />}
    </div>
  )
}

const hostOf = (u: string) => { try { return new URL(u).host } catch { return u } }

// In the app, a real browser view that keeps your logins (one shared profile for all web tiles)
// and works with sites that refuse iframes. In a plain browser (phone), an iframe where allowed.
function WebTile({ url }: { url: string }) {
  if (shell.isElectron) return <webview src={url} partition={`persist:canvas-${document.documentElement.dataset.profile ?? 'work'}`} allowpopups={'true' as any} style={{ width: '100%', height: '100%' }} />
  return <iframe src={url} title={url} style={{ width: '100%', height: '100%', border: 0 }} />
}

function TermTile({ t, save }: { t: Tile; save: (p: Partial<Tile>) => void }) {
  const { data } = useLive<{ terms: Term[] }>('/api/terms', ['terms'])
  const term = data?.terms.find(x => x.id === t.config.term_id && !x.exited)
  if (term) return <TermView term={term as any} onClose={() => save({ config: { ...t.config, term_id: null } })} />
  return (
    <div className="tile-empty">
      <button onClick={async () => { const r = await post<{ id: string }>('/api/terms', { cwd: t.config.cwd, cmd: t.config.cmd, title: t.config.title }); save({ config: { ...t.config, term_id: r.id } }) }}>Start terminal{t.config.cmd ? `: ${t.config.cmd}` : ''}</button>
      <div className="muted small">Terminals end when auto-m8 restarts; this starts a fresh one here.</div>
    </div>
  )
}

function NoteTile({ t, save }: { t: Tile; save: (p: Partial<Tile>) => void }) {
  const [text, setText] = useState<string>(t.config.text ?? '')
  const [edit, setEdit] = useState(!t.config.text)
  const timer = useRef<any>(null)
  const change = (v: string) => { setText(v); clearTimeout(timer.current); timer.current = setTimeout(() => save({ config: { ...t.config, text: v } }), 600) }
  return edit
    ? <textarea className="note-edit" autoFocus value={text} placeholder="Markdown…" onChange={e => change(e.target.value)} onBlur={() => text && setEdit(false)} />
    : <div className="note-view" onDoubleClick={() => setEdit(true)} title="Double-click to edit"><Markdown text={text} /></div>
}


function CodeTile({ t, save, onChange }: { t: Tile; save: (p: Partial<Tile>) => void; onChange: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [changing, setChanging] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [fresh, setFresh] = useState<{ at: number; stale: boolean } | null>(null)
  const [, tick] = useState(0)
  useEffect(() => { const i = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(i) }, [])
  // Built once per version of the tile's code: saving state must not reload the tile.
  const doc = useMemo(() => {
    const css = getComputedStyle(document.documentElement)
    const theme = Object.fromEntries(['--bg', '--fg', '--muted', '--line', '--accent', '--ok', '--bad', '--warn'].map(k => [k, css.getPropertyValue(k).trim()]))
    return BRIDGE(theme, t.state) + (t.config.html ?? '')
  }, [t.config.html]) // eslint-disable-line
  useEffect(() => {
    const on = async (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return
      const m = e.data ?? {}
      if (m.perch === 'activity') frame.current?.dispatchEvent(new Event('canvas-activity', { bubbles: true }))
      const reply = (data: any, error?: string) => frame.current?.contentWindow?.postMessage({ perch: 'reply', id: m.id, data, error }, '*')
      if (m.perch === 'data') {
        const r = await post<any>('/api/canvas/data', m.payload).catch((err: any) => ({ error: String(err?.message ?? err) }))
        if (r?.error) { reply(null, r.error); post(`/api/canvas/tile/${t.id}/report`, { error: r.error }) } else { reply(r.data); setFresh({ at: r.at, stale: r.stale }); if (t.error) post(`/api/canvas/tile/${t.id}/report`, { error: null }) }
      }
      if (m.perch === 'save') { post('/api/canvas/tile', { id: t.id, folder_id: t.folder_id, kind: t.kind, state: m.payload }); reply(true) }
      if (m.perch === 'error') post(`/api/canvas/tile/${t.id}/report`, { error: m.payload })
      if (m.perch === 'run') reply(null, 'Only tiles in a layout can run commands.')
    }
    addEventListener('message', on)
    // Live: refresh when perch's data changes (a background refetch found something new, a PR moved),
    // on the tile's own timer as a fallback, and at once when the window comes back. Never while hidden.
    const refresh = Number(t.config.refresh) || 0
    const kick = () => { if (document.visibilityState === 'visible') frame.current?.contentWindow?.postMessage({ perch: 'refresh' }, '*') }
    let soon: any
    const debounced = () => { clearTimeout(soon); soon = setTimeout(kick, 600) }
    const offs = (['canvasdata', 'prs', 'prflow', 'home'] as const).map(tp => onTopic(tp, debounced))
    const timer = refresh ? setInterval(kick, Math.max(5, refresh) * 1000) : null
    document.addEventListener('visibilitychange', kick)
    return () => { removeEventListener('message', on); if (timer) clearInterval(timer); offs.forEach(o => o()); clearTimeout(soon); document.removeEventListener('visibilitychange', kick) }
  }, [t.id, t.config.refresh, t.error]) // eslint-disable-line
  const change = async (ask: string) => {
    setBusy(true)
    const r = await post<any>('/api/canvas/make', { folder_id: t.folder_id, tile_id: t.id, ask, html: t.config.html, error: t.error })
    setBusy(false); setChanging(null)
    if (r.error) toast(r.error)
    onChange()
  }
  return (
    <div className="code-tile">
      <iframe ref={frame} sandbox="allow-scripts allow-popups" srcDoc={doc} title={t.config.title ?? 'tile'} onLoad={() => frame.current?.contentWindow?.postMessage({ perch: 'refresh' }, '*')} />
      <div className="code-tile-bar">
        {changing == null
          ? <><button className="link small" onClick={() => setChanging('')} disabled={busy}>{busy ? 'changing…' : t.error ? '✦ fix it' : '✦ change'}</button>
              {t.error && <span className="bad small ellipsis" title={t.error}>{t.error}</span>}
              {fresh && <Freshness {...fresh} />}</>
          : <input autoFocus className="grow small" value={changing} placeholder={t.error ? 'Enter to fix the error, or say what to change' : 'What should change?'}
              onChange={e => setChanging(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') change(changing.trim() || 'Fix the error.'); if (e.key === 'Escape') setChanging(null) }} onBlur={() => !changing && setChanging(null)} />}
      </div>
    </div>
  )
}

// How old the data on screen is. Green while fresh; "refreshing" when perch served the last answer
// and is fetching a newer one behind it.
function Freshness({ at, stale }: { at: number; stale: boolean }) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  const age = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
  return <span className={`small tile-fresh ${s < 30 ? 'ok' : 'muted'}`} title={`Data read ${new Date(at).toLocaleTimeString()}${stale ? '; a newer read is on its way' : ''}`}>● {stale ? `${age} · refreshing` : age}</span>
}

declare global { namespace JSX { interface IntrinsicElements { webview: any } } }
