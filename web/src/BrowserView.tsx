import { useEffect, useRef, useState } from 'react'
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

// fill: the parent sets the height (a dragged dock); the page is fitted inside it. Otherwise the view takes the page's shape.
export function BrowserView({ owner, compact, onCollapse, fill }: { owner: string; compact?: boolean; onCollapse?: () => void; fill?: boolean }) {
  const img = useRef<HTMLImageElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const sock = useRef<WebSocket | null>(null)
  const meta = useRef<{ deviceWidth: number; deviceHeight: number }>({ deviceWidth: 0, deviceHeight: 0 })
  const [st, setSt] = useState<{ url: string; title: string; paused: boolean; approvals: BrowserApproval[] }>({ url: '', title: '', paused: false, approvals: [] })
  const [conn, setConn] = useState<'connecting' | 'live' | 'none'>('connecting')
  const [hasFrame, setHasFrame] = useState(false)
  const [ratio, setRatio] = useState<number | null>(null) // the page's width/height, so the view fills its width without side bars
  const [err, setErr] = useState<string | null>(null)

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
    <div className={`browserview ${compact ? 'compact' : ''}`}>
      <div className="view-head">
        <div className="grow title ellipsis" title={url}>🌐 {st.title || hostOf(url) || 'Agent browser'} {url && <span className="muted small">{hostOf(url)}</span>}
          {taken ? <span className="term-ask"> · you have control</span> : conn === 'live' ? <span className="muted small" title="The agent in this chat drives this window."> · agent driving</span> : <span className="muted small"> · {conn === 'none' ? 'no window' : 'connecting…'}</span>}
        </div>
        <button className={taken ? 'primary' : ''} title={taken ? 'Give the window back to the agent; it takes a fresh look first' : 'Pause the agent and use the page yourself (log in, solve a captcha)'} onClick={() => setPaused(!taken)}>{taken ? 'Hand back' : 'Take over'}</button>
        <button className={ov.on ? 'primary' : ''} title={ov.on ? `PostHog data on (project ${ov.project ?? '?'}, ${ov.elements ?? 0} click patterns). Click to turn off.` : 'Draw PostHog usage, rage/dead clicks, errors and latency on this page'} onClick={() => overlay(!ov.on)}>📊 PostHog data</button>
        {ov.on && <button className={ov.mode === 'inspect' ? 'primary' : ''} title="Inspect: hover an element to see its numbers, click it for usage, errors, live latency, replays and Investigate (Alt+I in the page)" onClick={() => overlay(true, ov.mode === 'inspect' ? 'ambient' : 'inspect')}>Inspect</button>}
        <button className="open-chrome" title="Open this window in the real Agent Chrome. Its pages show a ← Mothership button that brings you back here." onClick={() => act(() => openInChrome(owner))}>Open in Chrome ↗</button>
        {onCollapse && <button className="icon" title="Collapse" onClick={onCollapse}>▾</button>}
        <button className="icon" title="Close the window (the agent is told)" onClick={() => act(() => api.send('DELETE', `/api/browser/${enc(owner)}`))}>×</button>
      </div>
      <ApprovalBar approvals={st.approvals} />
      {err && <div className="muted small pad-x bad">{err}</div>}
      <div ref={stage} className={`browser-stage ${taken ? 'taken' : ''} ${ratio && !fill ? 'fit' : ''}`} tabIndex={0} style={ratio && !fill ? { aspectRatio: String(ratio) } : undefined}
        onClick={e => { if (!taken) return; const p = toPage(e.clientX, e.clientY); if (p) { stage.current?.focus(); send({ type: 'click', ...p }) } }}
        onKeyDown={e => { if (!taken) return; const k = keyOf(e); if (!k) return; e.preventDefault(); e.stopPropagation(); send(k) }}
        onPaste={e => { if (!taken) return; const text = e.clipboardData.getData('text'); if (text) { e.preventDefault(); send({ type: 'text', text }) } }}>
        <img ref={img} alt="" draggable={false} style={{ visibility: hasFrame ? 'visible' : 'hidden' }} />
        {!hasFrame && <div className="browser-empty muted small">{conn === 'none' ? 'No browser window for this chat right now.' : 'Waiting for the first picture…'}</div>}
        {!taken && hasFrame && <div className="browser-hint" onClick={() => setPaused(true)}>Take over to click and type</div>}
      </div>
    </div>
  )
}

// Under a chat: the window this conversation owns, collapsible; its approvals stay visible collapsed.
export function BrowserDock({ owner, approvals }: { owner: string; approvals: BrowserApproval[] }) {
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
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    const startY = e.clientY, startH = box.current?.getBoundingClientRect().height ?? 320
    const move = (ev: PointerEvent) => setHeight(Math.max(120, Math.min(innerHeight - 120, startH + (startY - ev.clientY))))
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); document.body.style.cursor = '' }
    document.body.style.cursor = 'ns-resize'
    addEventListener('pointermove', move); addEventListener('pointerup', up)
  }
  if (collapsed) return (
    <div className="browser-dock collapsed">
      <button className="browser-dock-bar" onClick={() => toggle(false)} title="Show the live view">
        ▸ 🌐 <span className="ellipsis">{s?.title || (s ? hostOf(s.url) : 'Agent browser')}</span>{s?.paused && <span className="term-ask"> · you have control</span>}
      </button>
      <ApprovalBar approvals={approvals} />
    </div>
  )
  return (
    <div ref={box} className={`browser-dock ${height ? 'sized' : 'fit'}`} style={height ? { height } : undefined}>
      <div className="browser-dock-grip" onPointerDown={startDrag} onDoubleClick={() => setHeight(null)}
        title="Drag to resize the live view. Double-click to fit the page again." />
      <BrowserView owner={owner} compact fill={!!height} onCollapse={() => toggle(true)} />
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
