import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, post, useLive } from './api'
import { Popover } from './Popover'
import './browser.css'

// The agent browser (server/browser.ts): one window per chat in a dedicated Chrome profile.
// Here: its live view, the approvals it holds for you, and a small "needs you" flag.

export type BrowserSession = { owner: string; url: string; title: string; paused: boolean; shown?: boolean; goal: string | null; steps: number; runDir?: string; created?: number; lastUsed?: number }
export type BrowserApproval = { id: string; owner: string; host: string; what: string; url: string; at: number; state: 'pending' | 'approved' | 'denied' }
export type BrowserStatus = { connected: boolean; profileDir: string; headless: boolean; back?: { owner: string; at: number } | null; sessions: BrowserSession[]; approvals: BrowserApproval[] }

// Open the chat's window in the real Agent Chrome, in front; its pages get a "← perch" pill back here.
export const openInChrome = (owner: string) => post(`/api/browser/${encodeURIComponent(owner)}/show`)

export const useBrowser = () => useLive<BrowserStatus>('/api/browser', ['browser'])
const hostOf = (u: string) => { try { return new URL(u).host } catch { return u } }
const enc = encodeURIComponent

// "Agent wants to: clicking button "Send" on mail.google.com — Approve / Decline"
export function ApprovalBar({ approvals }: { approvals: BrowserApproval[] }) {
  const [busy, setBusy] = useState<string | null>(null)
  if (!approvals.length) return null
  const answer = async (id: string, ok: boolean, always?: boolean) => { setBusy(id); try { await post(`/api/browser/approvals/${enc(id)}`, { ok, ...(always ? { always: true } : {}) }) } finally { setBusy(null) } }
  return <>{approvals.map(a => (
    <div key={a.id} className="browser-approval">
      <span className="grow">Agent wants to: <b>{a.what}</b> on {a.host}</span>
      <button className="primary" disabled={busy === a.id} onClick={() => answer(a.id, true)}>Approve</button>
      <button disabled={busy === a.id} title={`Approve, and don't ask again for this exact action on ${a.host}`} onClick={() => answer(a.id, true, true)}>Always allow</button>
      <button disabled={busy === a.id} onClick={() => answer(a.id, false)}>Decline</button>
    </div>
  ))}</>
}

// Keys sent as named presses ("Meta+a", "Shift+Tab"); plain printable characters go as text.
const NAMED = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End'])
function keyOf(e: React.KeyboardEvent): { type: 'key'; key: string } | { type: 'text'; text: string } | null {
  if (['Meta', 'Control', 'Alt', 'Shift', 'CapsLock'].includes(e.key)) return null
  const mods = [e.metaKey && 'Meta', e.ctrlKey && 'Control', e.altKey && 'Alt'].filter(Boolean) as string[]
  if (NAMED.has(e.key)) return { type: 'key', key: [...mods, ...(e.shiftKey ? ['Shift'] : []), e.key].join('+') }
  if (e.key === ' ' && !mods.length) return { type: 'text', text: ' ' }
  if (e.key.length === 1) return mods.length ? { type: 'key', key: [...mods, e.key.toLowerCase()].join('+') } : { type: 'text', text: e.key }
  return null
}

// The view takes the page's shape at its width. cap: the most the whole view may take (a dragged dock);
// past it the page is fitted inside instead.
export type DockMode = 'bottom' | 'side' | 'pip'
// mode/onMode: the dock's layout buttons. fit: tell the agent's window to take this view's shape (side
// panel). mini: picture in picture, a small live picture with its buttons on hover.
export type FeedSide = 'below' | 'left' | 'right'
export function BrowserView({ owner, compact, onCollapse, cap, mode, onMode, fit, mini, feedOn, onFeed, feedSide = 'below', onFeedSide }: { owner: string; compact?: boolean; onCollapse?: () => void; cap?: number | null; mode?: DockMode; onMode?: (m: DockMode) => void; fit?: boolean; mini?: boolean; feedOn?: boolean; onFeed?: (on: boolean) => void; feedSide?: FeedSide; onFeedSide?: (s: FeedSide) => void }) {
  const img = useRef<HTMLImageElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const [chrome, setChrome] = useState(0) // header and approval rows above the page
  const chromeRef = useRef(0); chromeRef.current = chrome
  const feedOnRef = useRef(feedOn); feedOnRef.current = feedOn
  const feedSideRef = useRef(feedSide); feedSideRef.current = feedSide
  const [feedH, setFeedH] = useState(0)
  const stage = useRef<HTMLDivElement>(null)
  const sock = useRef<WebSocket | null>(null)
  const meta = useRef<{ deviceWidth: number; deviceHeight: number }>({ deviceWidth: 0, deviceHeight: 0 })
  const [st, setSt] = useState<{ url: string; title: string; paused: boolean; approvals: BrowserApproval[] }>({ url: '', title: '', paused: false, approvals: [] })
  const [conn, setConn] = useState<'connecting' | 'live' | 'none'>('connecting')
  const [hasFrame, setHasFrame] = useState(false)
  const [ratio, setRatio] = useState<number | null>(null) // the page's width/height, so the view fills its width without side bars
  const [err, setErr] = useState<string | null>(null)
  const [feedItems, setFeedItems] = useState<FeedItem[]>([])

  // What sits above the page in the dock (the header, approval rows), so a cap leaves the page the rest.
  useLayoutEffect(() => {
    const el = root.current, st = stage.current
    if (!el || !st) return
    const dock = el.closest('.browser-dock') as HTMLElement | null
    const c = Math.round(st.getBoundingClientRect().top - (dock ?? el).getBoundingClientRect().top) + 2 // + the dock's top border and a pixel of slack
    if (Math.abs(c - chrome) > 1) setChrome(c)
  })
  // The stream: frames go straight into the <img> (no re-render per frame); reconnects when it drops.
  useEffect(() => {
    let closed = false, retry: any, wait = 1000
    const connect = () => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/browser/${enc(owner)}`)
      sock.current = ws
      ws.onopen = () => { wait = 1000; setConn('live') }
      ws.onmessage = e => {
        let m: any
        try { m = JSON.parse(e.data) } catch { return }
        if (m.t === 'frame') {
          if (img.current) img.current.src = `data:image/jpeg;base64,${m.d}`
          if (m.m?.deviceWidth) {
            meta.current = { deviceWidth: m.m.deviceWidth, deviceHeight: m.m.deviceHeight }
            const r = Math.round((m.m.deviceWidth / m.m.deviceHeight) * 100) / 100
            setRatio(old => old === r ? old : r)
          }
          setHasFrame(true)
        } else if (m.t === 'state') setSt({ url: m.url, title: m.title, paused: !!m.paused, approvals: m.approvals ?? [] })
        else if (m.t === 'feed') setFeedItems(old => {
          // The first message is the backlog; then one entry at a time, new or an update to a running span.
          if (m.items.length !== 1) return m.items.slice(-150)
          const it = m.items[0], i = old.findIndex(x => x.id === it.id)
          if (i < 0) return [...old, it].slice(-150)
          const next = old.slice(); next[i] = it; return next
        })
        else if (m.t === 'error') setErr(m.error)
      }
      ws.onclose = e => {
        if (sock.current === ws) sock.current = null
        if (closed) return
        // 4404: no window (yet). Keep checking, slowly; the parent usually unmounts us first.
        setConn(e.code === 4404 ? 'none' : 'connecting')
        retry = setTimeout(connect, e.code === 4404 ? 5000 : wait)
        wait = Math.min(wait * 2, 8000)
      }
    }
    connect()
    return () => { closed = true; clearTimeout(retry); sock.current?.close() }
  }, [owner])

  // Side panel: the agent's window takes the panel's shape once a resize settles, so the page fills it.
  // Leaving the side panel puts the window back to its usual size.
  const sentRatio = useRef<number | null>(null)
  const sentKey = useRef('')
  const feedBox = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = root.current
    if (!fit || !el) {
      // The strip below wants the usual shape back, even if an earlier side panel (another window, before
      // a reload) left it tall; the server skips it when the window is already that size. PiP fits any
      // shape, so it leaves the window alone.
      if (sentRatio.current != null || mode === 'bottom') { sentRatio.current = null; post(`/api/browser/${enc(owner)}/fit`, { ratio: null }).catch(() => {}) }
      return
    }
    let t: any
    const check = () => {
      clearTimeout(t)
      t = setTimeout(() => {
        const beside = feedOnRef.current && feedSideRef.current !== 'below'
        const w = el.clientWidth - (beside ? feedBox.current?.offsetWidth ?? 0 : 0), h = el.clientHeight - chromeRef.current - (beside ? 0 : feedBox.current?.offsetHeight ?? 0)
        if (w < 100 || h < 100) return
        const r = w / h, last = sentRatio.current, key = `${r.toFixed(3)}:${w}`
        if (last != null && Math.abs(r - last) / last < 0.04 && sentKey.current.split(':')[1] === String(w)) return
        sentRatio.current = r; sentKey.current = key
        post(`/api/browser/${enc(owner)}/fit`, { ratio: r, width: w }).catch(() => {})
      }, 600)
    }
    const ro = new ResizeObserver(check)
    ro.observe(el); check()
    el.addEventListener('perch-refit', check)
    return () => { ro.disconnect(); clearTimeout(t); el.removeEventListener('perch-refit', check) }
  }, [fit, owner, feedOn, feedSide])
  // Something else (another view of this window) changed its shape: put the panel's shape back, at
  // most every 10s so two views can't fight over it.
  useEffect(() => { if (fit) root.current?.dispatchEvent(new Event('perch-refit')) }, [feedH]) // eslint-disable-line react-hooks/exhaustive-deps
  const reassertAt = useRef(0)
  useEffect(() => {
    const want = sentRatio.current
    if (!fit || !ratio || want == null || Math.abs(ratio - want) / want < 0.06) return
    const t = setTimeout(() => {
      if (Date.now() - reassertAt.current < 10_000) return
      reassertAt.current = Date.now(); sentRatio.current = null; sentKey.current = ''
      root.current && root.current.dispatchEvent(new Event('perch-refit'))
    }, 1500)
    return () => clearTimeout(t)
  }, [ratio, fit])
  useEffect(() => () => { if (sentRatio.current != null) post(`/api/browser/${enc(owner)}/fit`, { ratio: null }).catch(() => {}) }, [owner])

  const send = (ev: any) => { const ws = sock.current; if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'input', ev })) }
  // Page CSS px from a pointer position: the frame is letterboxed (object-fit: contain) in the stage.
  const toPage = (clientX: number, clientY: number) => {
    const el = img.current
    if (!el || !el.naturalWidth) return null
    const r = el.getBoundingClientRect(), nw = el.naturalWidth, nh = el.naturalHeight
    const s = Math.min(r.width / nw, r.height / nh), cw = nw * s, ch = nh * s
    const ox = (r.width - cw) / 2, oy = (r.height - ch) / 2
    const fx = (clientX - r.left - ox) / cw, fy = (clientY - r.top - oy) / ch
    if (fx < 0 || fy < 0 || fx > 1 || fy > 1) return null
    const W = meta.current.deviceWidth || nw, H = meta.current.deviceHeight || nh
    return { x: Math.round(fx * W), y: Math.round(fy * H) }
  }
  const taken = st.paused

  // Wheel needs a non-passive listener to keep the chat from scrolling while you scroll the page.
  useEffect(() => {
    const el = stage.current
    if (!el || !taken) return
    let acc = { dx: 0, dy: 0 }, t: any = null, at: { x: number; y: number } | null = null
    const f = (e: WheelEvent) => {
      const p = toPage(e.clientX, e.clientY)
      if (!p) return
      e.preventDefault()
      acc.dx += e.deltaX; acc.dy += e.deltaY; at = p
      if (!t) t = setTimeout(() => { send({ type: 'wheel', ...at!, ...acc }); acc = { dx: 0, dy: 0 }; t = null }, 50)
    }
    el.addEventListener('wheel', f, { passive: false })
    return () => { el.removeEventListener('wheel', f); clearTimeout(t) }
  }, [taken]) // eslint-disable-line react-hooks/exhaustive-deps

  const setPaused = async (paused: boolean) => {
    setSt(s => ({ ...s, paused }))
    await post(`/api/browser/${enc(owner)}/pause`, { paused })
    if (paused) stage.current?.focus()
  }
  const act = async (f: () => Promise<any>) => { try { setErr(null); await f() } catch (e: any) { setErr(e.message) } }
  const url = st.url
  // The PostHog product overlay (server/overlay.ts): usage, errors and latency drawn on the page.
  const [ov, setOv] = useState<{ on: boolean; mode?: string; project?: number | null; elements?: number; error?: string | null }>({ on: false })
  useEffect(() => { fetch(`/api/browser/${enc(owner)}/overlay`).then(r => r.json()).then(setOv).catch(() => {}) }, [owner])
  const overlay = (on: boolean, mode?: string) => act(async () => {
    setOv(o => ({ ...o, on, mode }))
    const r = await post(`/api/browser/${enc(owner)}/overlay`, { on, mode })
    setOv(r); if (r?.error) setErr(r.error)
  })

  return (
    <div ref={root} className={`browserview ${compact ? 'compact' : ''} ${mini ? 'mini' : ''} ${feedOn ? `feed-${feedSide}` : ''}`}>
      {mini ? <div className="view-head pip-head">
        <div className="grow title ellipsis small" title={url}>🌐 {st.title || hostOf(url) || 'Agent browser'}{taken && <span className="term-ask"> · you have control</span>}</div>
        {onFeed && <button className={`icon ${feedOn ? 'on' : ''}`} title={feedOn ? 'Hide activity' : 'Show activity: what the agent does here'} onClick={() => onFeed(!feedOn)}>≡</button>}
        {onMode && <button className="icon" title="Dock at the side" onClick={() => onMode('side')}>◨</button>}
        {onMode && <button className="icon" title="Dock below the chat" onClick={() => onMode('bottom')}>⬓</button>}
        <button className="icon" title="Close the window (the agent is told)" onClick={() => act(() => api.send('DELETE', `/api/browser/${enc(owner)}`))}>×</button>
      </div> :
      <div className="view-head">
        <div className="grow title ellipsis" title={url}>🌐 {st.title || hostOf(url) || 'Agent browser'} {url && <span className="muted small">{hostOf(url)}</span>}
          {taken ? <span className="term-ask"> · you have control</span> : conn === 'live' ? <span className="muted small" title="The agent in this chat drives this window."> · agent driving</span> : <span className="muted small"> · {conn === 'none' ? 'no window' : 'connecting…'}</span>}
        </div>
        <button className={taken ? 'primary' : ''} title={taken ? 'Give the window back to the agent; it takes a fresh look first' : 'Pause the agent and use the page yourself (log in, solve a captcha)'} onClick={() => setPaused(!taken)}>{taken ? 'Hand back' : 'Take over'}</button>
        <button className={ov.on ? 'primary' : ''} title={ov.on ? `PostHog data on (project ${ov.project ?? '?'}, ${ov.elements ?? 0} click patterns). Click to turn off.` : 'Draw PostHog usage, rage/dead clicks, errors and latency on this page'} onClick={() => overlay(!ov.on)}>📊 PostHog data</button>
        {ov.on && <button className={ov.mode === 'inspect' ? 'primary' : ''} title="Inspect: hover an element to see its numbers, click it for usage, errors, live latency, replays and Investigate (Alt+I in the page)" onClick={() => overlay(true, ov.mode === 'inspect' ? 'ambient' : 'inspect')}>Inspect</button>}
        <button className="open-chrome" title="Open this window in the real Agent Chrome. Its pages show a ← auto-m8 button that brings you back here." onClick={() => act(() => openInChrome(owner))}>Open in Chrome ↗</button>
        {onFeed && <button className={`icon ${feedOn ? 'on' : ''}`} title={feedOn ? 'Hide the live feed of what the agent does here' : 'Show a live feed of what the agent does here'} onClick={() => onFeed(!feedOn)}>≡</button>}
        {onMode && mode !== 'side' && <button className="icon" title="Dock at the side: the page takes the panel's shape" onClick={() => onMode('side')}>◨</button>}
        {onMode && mode !== 'bottom' && <button className="icon" title="Dock below the chat" onClick={() => onMode('bottom')}>⬓</button>}
        {onMode && <button className="icon" title="Picture in picture: a small live view in the corner" onClick={() => onMode('pip')}>⧉</button>}
        {onCollapse && <button className="icon" title="Collapse" onClick={onCollapse}>▾</button>}
        <button className="icon" title="Close the window (the agent is told)" onClick={() => act(() => api.send('DELETE', `/api/browser/${enc(owner)}`))}>×</button>
      </div>}
      <ApprovalBar approvals={st.approvals} />
      {err && <div className="muted small pad-x bad">{err}</div>}
      <div ref={stage} className={`browser-stage ${taken ? 'taken' : ''} ${ratio ? 'fit' : ''}`} tabIndex={0} style={ratio ? { aspectRatio: String(ratio), maxHeight: cap ? Math.max(80, cap - chrome - (feedOn && feedSide === 'below' ? feedH : 0)) : undefined } : undefined}
        onClick={e => { if (mini && !taken) { onMode?.('side'); return } if (!taken) return; const p = toPage(e.clientX, e.clientY); if (p) { stage.current?.focus(); send({ type: 'click', ...p }) } }}
        onKeyDown={e => { if (!taken) return; const k = keyOf(e); if (!k) return; e.preventDefault(); e.stopPropagation(); send(k) }}
        onPaste={e => { if (!taken) return; const text = e.clipboardData.getData('text'); if (text) { e.preventDefault(); send({ type: 'text', text }) } }}>
        <img ref={img} alt="" draggable={false} style={{ visibility: hasFrame ? 'visible' : 'hidden' }} />
        {!hasFrame && <div className="browser-empty muted small">{conn === 'none' ? 'No browser window for this chat right now.' : 'Waiting for the first picture…'}</div>}
        {!taken && hasFrame && !mini && <div className="browser-hint" onClick={() => setPaused(true)}>Take over to click and type</div>}
      </div>
      {feedOn && <BrowserFeed items={feedItems} boxRef={feedBox} onHeight={setFeedH} store={mini ? 'perch.pipFeed' : 'perch.browserFeed'} side={mini ? feedSide : undefined} onSide={mini ? onFeedSide : undefined} />}
    </div>
  )
}

export type FeedItem = { id: string; at: number; kind: 'tool' | 'step' | 'nav' | 'net' | 'note'; text: string; level?: 'ok' | 'warn' | 'bad'; ms?: number; running?: boolean; concern?: string; detail?: Record<string, string>; children?: FeedItem[] }
const FEED_ICON: Record<FeedItem['kind'], string> = { tool: '◆', step: '·', nav: '→', net: '⇅', note: '!' }
const FEED_KIND: Record<FeedItem['kind'], string> = { tool: 'Agent action', step: 'Step', nav: 'Page changed', net: 'Page request', note: 'Event' }
const fmtMs = (ms?: number) => ms == null ? '' : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round(ms / 1000) % 60).padStart(2, '0')}s`
const ago = (at: number, now: number) => { const s = Math.max(0, Math.round((now - at) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h` }
const WINDOW_MAX = 5 * 60_000 // the timeline covers at most the last 5 minutes; older bars are clipped at its left edge
const MONO = new Set(['url', 'script', 'result', 'error', 'request id', 'page after', 'from'])

// One span or event on the shared timeline [t0, t1]: a bar for spans (growing while running), a tick
// for instant events. Concerns show in amber with their reason, always visible.
function FeedRow({ it, t0, t1, now, depth = 0 }: { it: FeedItem; t0: number; t1: number; now: number; depth?: number }) {
  const [open, setOpen] = useState(false)
  const dur = it.running ? now - it.at : it.ms
  const span = Math.max(1, t1 - t0)
  const left = Math.max(0, Math.min(100, ((it.at - t0) / span) * 100))
  const width = dur == null ? 0 : Math.max(0, Math.min(100 - left, ((Math.min(it.at + dur, t1) - Math.max(it.at, t0)) / span) * 100))
  const clipped = it.at < t0
  const expandable = !!(it.children?.length || (it.detail && Object.keys(it.detail).length))
  const tone = it.level === 'bad' ? 'bad' : it.concern || it.level === 'warn' ? 'warn' : it.running ? 'run' : it.kind
  return <>
    <div className={`feed-row ${tone} ${expandable ? 'can-open' : ''} ${open ? 'open' : ''}`} style={{ paddingLeft: 4 + depth * 14 }}
      onClick={() => expandable && setOpen(o => !o)} title={`${FEED_KIND[it.kind]} · started ${new Date(it.at).toLocaleTimeString()}`}>
      <span className="chev">{expandable ? (open ? '⌄' : '›') : ''}</span>
      <span className="ic">{it.concern ? '⚠' : FEED_ICON[it.kind]}</span>
      <span className="lbl">
        <span className="tx">{it.text}</span>
        {it.concern && <span className="concern">{it.concern}</span>}
        {!open && (() => { const n = it.children?.filter(c => c.concern || c.level === 'bad').length ?? 0; return n ? <span className="concern">{n} step{n > 1 ? 's' : ''} inside to look at</span> : null })()}
      </span>
      <span className="track">
        {dur == null ? <span className="tick" style={{ left: `${left}%` }} /> :
          <span className={`bar ${it.running ? 'live' : ''} ${clipped ? 'clipped' : ''}`} style={{ left: `${left}%`, width: `max(3px, ${width}%)` }} />}
      </span>
      <span className="dur">{it.running ? <span className="live-dot">{fmtMs(dur)}</span> : fmtMs(dur)}</span>
      <span className="ago">{ago(it.at, now)}</span>
    </div>
    {open && <div className="feed-detail" style={{ marginLeft: 22 + depth * 14 }}>
      {it.detail && Object.entries(it.detail).filter(([k, v]) => v && k !== 'host').map(([k, v]) => (
        <div key={k} className="kv"><span className="k">{k}</span><span className={`v ${MONO.has(k) ? 'mono' : ''}`}>{v}</span></div>
      ))}
    </div>}
    {open && it.children?.length ? (() => {
      // Children on their parent's own timeline, so the steps inside one call are readable.
      const c0 = it.at, c1 = Math.max(it.at + (dur ?? 0), ...it.children.map(c => c.at + (c.ms ?? 0)))
      return it.children.map(c => <FeedRow key={c.id} it={c} t0={c0} t1={c1} now={now} depth={depth + 1} />)
    })() : null}
  </>
}

// The activity panel: what the agent does in this window as spans on one timeline, newest at the
// bottom; sticks to the bottom unless you scroll up. Click a row with › to see its details and steps.
// store: where its collapsed state and height are remembered (the side panel and PiP keep their own).
// side/onSide: in PiP, which side of the picture it sits on, chosen from its header.
function BrowserFeed({ items, boxRef, onHeight, store = 'perch.browserFeed', side, onSide }: { items: FeedItem[]; boxRef: React.RefObject<HTMLDivElement | null>; onHeight: (h: number) => void; store?: string; side?: FeedSide; onSide?: (s: FeedSide) => void }) {
  const list = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [now, setNow] = useState(Date.now())
  const running = items.some(i => i.running)
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), running ? 250 : 5000); return () => clearInterval(t) }, [running])
  useLayoutEffect(() => { const el = list.current; if (el && stick.current) el.scrollTop = el.scrollHeight }, [items.length])
  useLayoutEffect(() => {
    const el = boxRef.current; if (!el) return
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight)); ro.observe(el); onHeight(el.offsetHeight)
    return () => { ro.disconnect(); onHeight(0) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const t1 = Math.max(now, ...items.map(i => i.at + (i.ms ?? 0)))
  const t0 = Math.max(t1 - WINDOW_MAX, Math.min(t1 - 10_000, ...items.map(i => i.at)))
  const concerns = items.reduce((n, i) => n + (i.concern ? 1 : 0) + (i.children?.filter(c => c.concern).length ?? 0), 0)
  // Collapse to its header (click it); drag the line above it to any height. Both remembered.
  const CKEY = `${store}.collapsed`, HKEY = `${store}.height`
  const [collapsed, setCollapsedState] = useState(() => { try { return localStorage.getItem(CKEY) === '1' } catch { return false } })
  const setCollapsed = (v: boolean) => { setCollapsedState(v); try { localStorage.setItem(CKEY, v ? '1' : '0') } catch {} }
  const [height, setHeightState] = useState<number | null>(() => { try { return Number(localStorage.getItem(HKEY)) || null } catch { return null } })
  const drag = (e: React.PointerEvent) => {
    e.preventDefault()
    const el = boxRef.current; if (!el) return
    const panel = el.parentElement?.getBoundingClientRect()
    // Like the sidebar: drag it down past its smallest size and it collapses to its header; drag a
    // collapsed one up and it opens again, following the pointer. The last open height is kept.
    const startY = e.clientY, startH = el.offsetHeight
    let last: number | null = null, shut = collapsed
    const move = (ev: PointerEvent) => {
      const want = startH + (startY - ev.clientY)
      if (want < 60) { if (!shut) { shut = true; setCollapsed(true) } return }
      if (shut) { shut = false; setCollapsed(false) }
      last = Math.round(Math.max(90, Math.min((panel?.height ?? 900) - 160, want)))
      setHeightState(last)
    }
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); document.body.style.cursor = ''; if (last != null && !shut) try { localStorage.setItem(HKEY, String(last)) } catch {} }
    document.body.style.cursor = 'ns-resize'
    addEventListener('pointermove', move); addEventListener('pointerup', up)
  }
  const latest = items[items.length - 1]
  return (
    <div ref={boxRef} className={`browser-feed ${collapsed ? 'collapsed' : ''} ${side ? `at-${side}` : ''}`} style={!collapsed && height && side !== 'left' && side !== 'right' ? { height } : undefined}>
      {side !== 'left' && side !== 'right' && <div className="feed-grip" onPointerDown={drag} onDoubleClick={() => { setHeightState(null); try { localStorage.removeItem(HKEY) } catch {} }} title="Drag to resize the activity panel; drag it all the way down to collapse it, up to open it. Double-click for the default size." />}
      <div className="feed-head" onClick={() => setCollapsed(!collapsed)} title={collapsed ? 'Show the activity panel' : 'Collapse the activity panel'}>
        <span className="chev">{collapsed ? '›' : '⌄'}</span>
        <span className="ttl">Activity</span>
        {concerns > 0 && <span className="feed-concerns">⚠ {concerns} to look at</span>}
        {collapsed && latest && <span className={`feed-latest ${latest.running ? 'run' : ''}`}>{latest.running ? '● ' : ''}{latest.text}</span>}
        <span className="grow" />
        {onSide && <span className="feed-side" onClick={e => e.stopPropagation()}>
          {(['left', 'below', 'right'] as FeedSide[]).map(p => <button key={p} className={`icon ${side === p ? 'on' : ''}`} title={`Activity ${p === 'below' ? 'below' : `on the ${p}`}`} onClick={() => onSide(p)}>{p === 'left' ? '◧' : p === 'below' ? '⬓' : '◨'}</button>)}
        </span>}
        {!collapsed && side !== 'left' && side !== 'right' && <><span className="axis"><span>{fmtMs(t1 - t0)} ago</span><span>now</span></span>
        <span className="dur-h" /><span className="ago-h" /></>}
      </div>
      {!collapsed && <div ref={list} className="browser-feed-list" onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }}>
        {!items.length && <div className="muted small browser-feed-empty">No activity yet</div>}
        {items.map(it => <FeedRow key={it.id} it={it} t0={t0} t1={t1} now={now} />)}
      </div>}
    </div>
  )
}

// Under a chat: the window this conversation owns, in one of three layouts (remembered):
// bottom: a strip under the chat, collapsible, drag its top edge;
// side: a full-height panel on the right, drag its left edge; the page takes the panel's shape;
// pip: a small live picture in the corner, over the chat; click it to dock it at the side.
// With no choice made yet, a wide chat starts at the side and a narrow one at the bottom.
// Its approvals stay visible in every layout.
const MODE_KEY = 'perch.browserDock.mode'
export function useDockMode(): [DockMode | null, (m: DockMode) => void] {
  const [mode, setModeState] = useState<DockMode | null>(() => { try { return (localStorage.getItem(MODE_KEY) as DockMode) || null } catch { return null } })
  const setMode = (m: DockMode) => { setModeState(m); try { localStorage.setItem(MODE_KEY, m) } catch {} }
  return [mode, setMode]
}
export const SIDE_MIN_CHAT = 1100 // below this chat width, "side" falls back to the strip below
export function BrowserDock({ owner, approvals, mode, onMode }: { owner: string; approvals: BrowserApproval[]; mode: DockMode; onMode: (m: DockMode) => void }) {
  const KEY = 'perch.browserDock.collapsed'
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(KEY) === '1' } catch { return false } })
  const toggle = (v: boolean) => { setCollapsed(v); try { localStorage.setItem(KEY, v ? '1' : '0') } catch {} }
  const { data } = useBrowser()
  const s = data?.sessions.find(x => x.owner === owner)
  // Drag the top edge to any height (remembered); double-click goes back to fitting the page.
  const HKEY = 'perch.browserDock.height'
  const box = useRef<HTMLDivElement>(null)
  const [height, setHeightState] = useState<number | null>(() => { try { return Number(localStorage.getItem(HKEY)) || null } catch { return null } })
  const setHeight = (h: number | null) => { setHeightState(h); try { h ? localStorage.setItem(HKEY, String(Math.round(h))) : localStorage.removeItem(HKEY) } catch {} }
  // The side panel's width: drag its left edge (remembered as a share of the chat).
  const WKEY = 'perch.browserDock.sideShare'
  const [share, setShareState] = useState<number>(() => { try { return Number(localStorage.getItem(WKEY)) || 0.5 } catch { return 0.5 } })
  const setShare = (v: number) => { setShareState(v); try { localStorage.setItem(WKEY, v.toFixed(3)) } catch {} }
  const [panelH, setPanelH] = useState<number | null>(null)
  const FKEY = 'perch.browserDock.feed'
  const [feedOn, setFeedOnState] = useState(() => { try { return localStorage.getItem(FKEY) !== '0' } catch { return true } })
  const setFeedOn = (v: boolean) => { setFeedOnState(v); try { localStorage.setItem(FKEY, v ? '1' : '0') } catch {} }
  // Picture in picture: drag its header to move it, its corner to resize it (both remembered). Once
  // resized, the agent's window takes its shape too, like the side panel, so the picture has no bars.
  const PKEY = 'perch.browserDock.pip'
  const [pip, setPipState] = useState<{ w: number; h: number | null; right: number; top: number }>(() => { try { return { w: 340, h: null, right: 18, top: 52, ...JSON.parse(localStorage.getItem(PKEY) ?? '{}') } } catch { return { w: 340, h: null, right: 18, top: 52 } } })
  // PiP activity: off until you open it (≡ in its top bar); then below, left or right of the picture.
  const [pipFeed, setPipFeedState] = useState(() => { try { return localStorage.getItem('perch.pipFeed.on') === '1' } catch { return false } })
  const setPipFeed = (v: boolean) => { setPipFeedState(v); try { localStorage.setItem('perch.pipFeed.on', v ? '1' : '0') } catch {} }
  const [pipSide, setPipSideState] = useState<FeedSide>(() => { try { return (localStorage.getItem('perch.pipFeed.side') as FeedSide) || 'right' } catch { return 'right' } })
  const setPipSide = (v: FeedSide) => { setPipSideState(v); try { localStorage.setItem('perch.pipFeed.side', v) } catch {} }
  const PIP_FEED_W = 300, PIP_FEED_H = 190
  const extraW = pipFeed && pipSide !== 'below' ? PIP_FEED_W : 0, extraH = pipFeed && pipSide === 'below' ? PIP_FEED_H : 0
  const setPip = (p: typeof pip) => { setPipState(p); try { localStorage.setItem(PKEY, JSON.stringify(p)) } catch {} }
  // The chat's size: the saved PiP is fitted inside it (smaller, nearer the corner) when the chat is
  // narrower or shorter than when you placed it, instead of hanging off its edge.
  const [chatBox, setChatBox] = useState<{ w: number; h: number } | null>(null)
  useLayoutEffect(() => {
    const chat = box.current?.closest('.chat') as HTMLElement | null
    if (mode !== 'pip' || !chat) return
    const f = () => setChatBox({ w: chat.clientWidth, h: chat.clientHeight })
    const ro = new ResizeObserver(f); ro.observe(chat); f()
    return () => ro.disconnect()
  }, [mode])
  const shown = (() => {
    if (!chatBox) return pip
    const w = Math.max(160, Math.min(pip.w, chatBox.w - 24 - extraW))
    const h = pip.h == null ? null : Math.max(100, Math.min(pip.h * (w / pip.w), chatBox.h - 140))
    const right = Math.max(8, Math.min(pip.right, chatBox.w - w - extraW - 8))
    const top = Math.max(8, Math.min(pip.top, chatBox.h - (h ?? w * 0.62) - extraH - 110))
    return { w, h, right, top }
  })()
  const pipDrag = (e: React.PointerEvent, kind: 'move' | 'size') => {
    if (kind === 'move' && (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    const chat = box.current?.closest('.chat') as HTMLElement | null
    const el = box.current
    if (!chat || !el) return
    const cr = chat.getBoundingClientRect(), start = { x: e.clientX, y: e.clientY, ...shown, h: shown.h ?? el.offsetHeight }
    let last = pip
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y
      last = kind === 'move'
        ? { ...start, h: shown.h, right: Math.max(0, Math.min(cr.width - start.w, start.right - dx)), top: Math.max(0, Math.min(cr.height - 60, start.top + dy)) }
        : { ...start, w: Math.max(200, Math.min(cr.width - 40, start.w - dx)), h: Math.max(120, Math.min(cr.height - start.top - 10, start.h + dy)) }
      setPipState(last)
    }
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); document.body.style.cursor = ''; setPip(last) }
    document.body.style.cursor = kind === 'move' ? 'grabbing' : 'nesw-resize'
    addEventListener('pointermove', move); addEventListener('pointerup', up)
  }
  useLayoutEffect(() => {
    const el = box.current
    if (mode !== 'side' || !el) return
    const ro = new ResizeObserver(() => setPanelH(el.clientHeight))
    ro.observe(el); setPanelH(el.clientHeight)
    return () => ro.disconnect()
  }, [mode])
  // The chat leaves room for the side panel.
  useLayoutEffect(() => {
    const chat = box.current?.closest('.chat') as HTMLElement | null
    if (!chat) return
    if (mode !== 'side') return
    // In px: a percentage padding would be a share of the chat's parent, not the chat.
    const apply = () => chat.style.setProperty('--side-w', `${Math.round(chat.clientWidth * share)}px`)
    chat.classList.add('with-side-browser'); apply()
    const ro = new ResizeObserver(apply); ro.observe(chat)
    return () => { ro.disconnect(); chat.classList.remove('with-side-browser'); chat.style.removeProperty('--side-w') }
  }, [mode, share])
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    const startY = e.clientY, startH = box.current?.getBoundingClientRect().height ?? 320
    const move = (ev: PointerEvent) => setHeight(Math.max(120, Math.min(innerHeight - 120, startH + (startY - ev.clientY))))
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); document.body.style.cursor = '' }
    document.body.style.cursor = 'ns-resize'
    addEventListener('pointermove', move); addEventListener('pointerup', up)
  }
  const startSideDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    const chat = box.current?.closest('.chat') as HTMLElement | null
    if (!chat) return
    const r = chat.getBoundingClientRect()
    const move = (ev: PointerEvent) => setShare(Math.max(0.25, Math.min(Math.max(0.3, 1 - 420 / r.width), (r.right - ev.clientX) / r.width)))
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); document.body.style.cursor = '' }
    document.body.style.cursor = 'ew-resize'
    addEventListener('pointermove', move); addEventListener('pointerup', up)
  }
  if (mode === 'pip') return (
    <div ref={box} className={`browser-dock pip ${shown.h ? 'sized' : ''} ${pipFeed ? `with-feed feed-${pipSide}` : ''}`} style={{ width: shown.w + extraW, height: shown.h != null ? shown.h + extraH : undefined, right: shown.right, top: shown.top }}
      onPointerDown={e => { if ((e.target as HTMLElement).closest('.pip-head')) pipDrag(e, 'move') }}>
      <ApprovalBar approvals={approvals} />
      <BrowserView owner={owner} compact mini mode={mode} onMode={onMode} cap={shown.h != null ? shown.h + extraH : null} fit={!!shown.h}
        feedOn={pipFeed} onFeed={setPipFeed} feedSide={pipSide} onFeedSide={setPipSide} />
      <div className="pip-resize" onPointerDown={e => { e.stopPropagation(); pipDrag(e, 'size') }} onDoubleClick={() => setPip({ ...pip, w: 340, h: null })} title="Drag to resize. Double-click for the default size." />
    </div>
  )
  if (mode === 'side') return (
    <div ref={box} className="browser-dock side">
      <div className="browser-dock-grip side" onPointerDown={startSideDrag} onDoubleClick={() => setShare(0.5)}
        title="Drag to resize the side panel. Double-click for half and half." />
      <BrowserView owner={owner} compact cap={panelH} fit mode={mode} onMode={onMode} feedOn={feedOn} onFeed={setFeedOn} />
    </div>
  )
  if (collapsed) return (
    <div className="browser-dock collapsed">
      <button className="browser-dock-bar" onClick={() => toggle(false)} title="Show the live view">
        ▸ 🌐 <span className="ellipsis">{s?.title || (s ? hostOf(s.url) : 'Agent browser')}</span>{s?.paused && <span className="term-ask"> · you have control</span>}
      </button>
      <ApprovalBar approvals={approvals} />
    </div>
  )
  return (
    // The dragged height is a ceiling, not a size: in a narrow pane the page needs less, and the view
    // shrinks to it instead of letterboxing the page between empty bands.
    <div ref={box} className={`browser-dock ${height ? 'sized' : 'fit'}`} style={height ? { maxHeight: height } : undefined}>
      <div className="browser-dock-grip" onPointerDown={startDrag} onDoubleClick={() => setHeight(null)}
        title="Drag to resize the live view. Double-click to fit the page again." />
      <BrowserView owner={owner} compact cap={height} mode={mode} onMode={onMode} onCollapse={() => toggle(true)} />
    </div>
  )
}

// A canvas tile: the live view of a chat's window, or a calm note when it has none.
export function BrowserTile({ owner }: { owner?: string }) {
  const { data } = useBrowser()
  if (!owner) return <div className="tile-empty muted small">No chat set for this browser tile.</div>
  const has = data?.sessions.some(s => s.owner === owner)
  if (!has) return <div className="tile-empty muted small">No browser window open for this chat. It appears here when the agent opens one.</div>
  return <BrowserView owner={owner} compact />
}

// Header: every agent's browser window, one click from its chat or the real Chrome window. Lights up
// when an agent waits on your approval. Also brings you to the chat when you click "← perch" in Chrome.
const titles = new Map<string, string>()
function useChatTitles(owners: string[]) {
  const [, bump] = useState(0)
  useEffect(() => {
    for (const id of owners) if (!titles.has(id)) {
      titles.set(id, '')
      api.get<any>(`/api/conversations/${encodeURIComponent(id)}`).then(d => { titles.set(id, d?.title || d?.conversation?.title || d?.first_prompt || ''); bump(n => n + 1) }).catch(() => {})
    }
  }, [owners.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps
  return (id: string) => titles.get(id) || 'A chat'
}

export function BrowserFlag({ onOpen }: { onOpen: (id: string) => void }) {
  const { data } = useBrowser()
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const seenBack = useRef<number>(Date.now())
  const sessions = data?.sessions ?? []
  const pending = data?.approvals.filter(a => a.state === 'pending') ?? []
  const title = useChatTitles(sessions.map(s => s.owner))
  // "← perch" clicked in the Agent Chrome: open that chat here
  useEffect(() => {
    const b = data?.back
    if (b && b.at > seenBack.current) { seenBack.current = b.at; onOpen(b.owner) }
  }, [data?.back?.at]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!sessions.length && !pending.length) return null
  return <>
    <button ref={btn} className={`icon no-drag decision-flag browser-flag ${pending.length ? 'on-flag' : 'has-windows'}`} onClick={() => setOpen(o => !o)}
      title={pending.length ? `${pending.length} browser action${pending.length > 1 ? 's' : ''} wait for your approval` : `${sessions.length} agent browser window${sessions.length > 1 ? 's' : ''}`}>
      🌐<span className="flag-n">{pending.length || sessions.length}</span>
    </button>
    <Popover anchor={btn} open={open} onClose={() => setOpen(false)} width={380}>
      <div className="browser-list">
        <div className="browser-list-head muted small">Agent browsers</div>
        {pending.length > 0 && <ApprovalBar approvals={pending} />}
        {sessions.map(s => (
          <div key={s.owner} className="browser-list-row">
            <div className="grow min0">
              <div className="ellipsis">{title(s.owner)}</div>
              <div className="muted small ellipsis">{s.paused ? 'you have control · ' : ''}{s.title || hostOf(s.url)} · {hostOf(s.url)}</div>
            </div>
            <button onClick={() => { setOpen(false); onOpen(s.owner) }} title="Open the chat, with its live view">Chat</button>
            <button onClick={() => { setOpen(false); openInChrome(s.owner) }} title="Open this window in the real Agent Chrome">Chrome ↗</button>
          </div>
        ))}
        {!sessions.length && <div className="muted small pad-x">No windows open.</div>}
      </div>
    </Popover>
  </>
}
