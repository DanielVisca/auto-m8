// The phone side of perch. Simple mode is the phone's default: what needs you, what's running,
// and one box to start or continue something. Advanced is the full app, one tap away.
// Handoff: each screen reports where it is; when you come back to a device, perch offers
// whatever you were last looking at on the other one.
import { useEffect, useState } from 'react'
import { NeedsMe } from './NeedsMe'
import { ago, api, post, sendChat, shell, titleOf, useLive, type Conversation } from './api'

const touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
export const useSimple = () => {
  const [simple, setSimple] = useState(() => { try { return touch && !shell.isElectron && localStorage.getItem('perch.simple') !== '0' } catch { return false } })
  const set = (on: boolean) => { setSimple(on); try { localStorage.setItem('perch.simple', on ? '1' : '0') } catch {} }
  return [simple, set, touch && !shell.isElectron] as const
}

// ---------- push ----------
const b64 = (s: string) => { const p = '='.repeat((4 - s.length % 4) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, c => c.charCodeAt(0)) }
export const pushSupported = () => typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && !shell.isElectron

export function registerSw() {
  if (!pushSupported()) return
  navigator.serviceWorker.register('/sw.js').catch(() => {})
  navigator.serviceWorker.addEventListener('message', e => { if (e.data?.open) location.hash = String(e.data.open).replace(/^\/?/, '').replace(/^#?/, '#') })
}

export function usePush() {
  const [state, setState] = useState<'unsupported' | 'off' | 'on' | 'denied' | 'busy'>(() => pushSupported() ? 'off' : 'unsupported')
  useEffect(() => {
    if (!pushSupported()) return
    if (Notification.permission === 'denied') return setState('denied')
    navigator.serviceWorker.ready.then(r => r.pushManager.getSubscription()).then(s => setState(s ? 'on' : 'off')).catch(() => {})
  }, [])
  const enable = async () => {
    setState('busy')
    try {
      if ((await Notification.requestPermission()) !== 'granted') return setState('denied')
      const reg = await navigator.serviceWorker.ready
      const { key } = await api.get<{ key: string }>('/api/push/key')
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) })
      await post('/api/push/subscribe', { subscription: sub.toJSON() })
      setState('on')
    } catch { setState('off') }
  }
  const disable = async () => {
    const s = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
    if (s) { await post('/api/push/unsubscribe', { endpoint: s.endpoint }); await s.unsubscribe() }
    setState('off')
  }
  return { state, enable, disable }
}

// ---------- presence and handoff ----------
export function usePresence(hash: string, title: string) {
  useEffect(() => {
    const beat = () => { if (document.visibilityState === 'visible') fetch('/api/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ view: hash, title }) }).catch(() => {}) }
    beat()
    const t = setInterval(beat, 30_000)
    document.addEventListener('visibilitychange', beat)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', beat) }
  }, [hash, title])
}

// "Continue where you were on iPhone": shown when you come back and another device was used since.
export function Handoff({ current, onGo }: { current: string; onGo: (hash: string) => void }) {
  const [h, setH] = useState<{ name: string; view: string; title: string; at: number } | null>(null)
  useEffect(() => {
    const check = () => { if (document.visibilityState === 'visible') api.get<{ handoff: any }>('/api/handoff').then(r => setH(r.handoff && r.handoff.view !== current ? r.handoff : null)).catch(() => {}) }
    check()
    addEventListener('focus', check); document.addEventListener('visibilitychange', check)
    return () => { removeEventListener('focus', check); document.removeEventListener('visibilitychange', check) }
  }, [current])
  if (!h || !h.view || h.view === '#home') return null
  return (
    <div className="handoff" onClick={() => { onGo(h.view); setH(null) }}>
      <span className="grow ellipsis">Continue from {h.name}: <b>{h.title || h.view}</b> <span className="muted small">{ago(h.at)} ago</span></span>
      <button className="icon" onClick={e => { e.stopPropagation(); setH(null) }} title="Dismiss">×</button>
    </div>
  )
}

// ---------- Simple mode ----------
type HomeData = { needsMe: Conversation[]; running: Conversation[]; active: Conversation[]; decisions: any[] }

function Row({ c, onOpen }: { c: Conversation; onOpen: (id: string) => void }) {
  return (
    <button className="s-row" onClick={() => onOpen(c.id)}>
      <span className={`dot s-${c.effective}`} />
      <span className="grow s-text">
        <span className="ellipsis s-title">{titleOf(c)}</span>
        {c.reason && <span className="muted small s-reason">{c.reason}</span>}
      </span>
      <span className="muted small">{ago(c.updated_at)}</span>
    </button>
  )
}

export function SimpleHome({ onOpen, onAdvanced }: { onOpen: (id: string) => void; onAdvanced: () => void }) {
  const { data } = useLive<HomeData>('/api/home', ['home', 'conversations'])
  const push = usePush()
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const start = async () => {
    if (!prompt.trim()) return
    setBusy(true)
    try { setPrompt(''); const r = await sendChat<{ id: string }>({ prompt }); onOpen(r.id) } finally { setBusy(false) }
  }
  const running = (data?.running ?? []).filter(c => !c.origin)
  const recent = (data?.active ?? []).filter(c => !c.origin).slice(0, 8)
  return (
    <div className="simple">
      <header className="s-head">
        <div className="grow s-brand">perch</div>
        <button className="s-mode" onClick={onAdvanced}>Advanced</button>
      </header>
      <div className="s-scroll">
        {push.state === 'off' && <button className="s-banner" onClick={push.enable}>🔔 Tell me when something needs me</button>}
        {push.state === 'denied' && <div className="s-banner muted">Notifications are blocked for auto-m8 in the phone's settings.</div>}
        {push.state === 'unsupported' && !window.isSecureContext && <div className="s-banner muted small">Notifications need the https (Tailscale) address. Turn it on in auto-m8 Settings → Phone access on the Mac.</div>}
        <NeedsMe onOpen={onOpen} />
        {running.length > 0 && <section><h3>Running <span className="muted small">{running.length}</span></h3>{running.map(c => <Row key={c.id} c={c} onOpen={onOpen} />)}</section>}
        {recent.length > 0 && <section><h3>Pick up</h3>{recent.map(c => <Row key={c.id} c={c} onOpen={onOpen} />)}</section>}
      </div>
      <form className="s-compose" onSubmit={e => { e.preventDefault(); start() }}>
        <textarea rows={1} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Start something new…" enterKeyHint="send"
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); start() } }} />
        <button className="primary" disabled={busy || !prompt.trim()}>{busy ? '…' : 'Go'}</button>
      </form>
    </div>
  )
}

// ---------- continue in the cloud ----------
// Who runs this conversation right now: the Mac, or a PostHog cloud task while the Mac is away.
type Lease = { conversation_id: string; task_id: string; url: string | null; branch: string | null; status: string; started_at: number; finished_at: number | null }

// Remembered on the phone, so the offline page can link to cloud tasks when the Mac can't be reached.
function remember(l: Lease | null, id: string, title: string) {
  try {
    const all = JSON.parse(localStorage.getItem('perch.cloud') ?? '[]').filter((x: any) => x.id !== id)
    if (l) all.unshift({ id, title, url: l.url, at: l.started_at })
    localStorage.setItem('perch.cloud', JSON.stringify(all.slice(0, 10)))
  } catch {}
}

// Phone (Simple mode header): pill buttons. Desktop (chat view-head): header icons; disabled mid-turn.
export function CloudBar({ id, desktop = false, running = false }: { id: string; desktop?: boolean; running?: boolean }) {
  const { data, reload } = useLive<{ lease: Lease | null; title: string }>(`/api/cloud/${encodeURIComponent(id)}`, ['conversations'])
  const [busy, setBusy] = useState(false)
  const lease = data?.lease ?? null
  useEffect(() => { if (data) remember(lease, id, data.title) }, [data, id]) // eslint-disable-line
  const act = async (path: string) => { setBusy(true); try { await post(path) } finally { setBusy(false); reload() } }
  const btn = desktop ? 'icon cloud-ctl' : 's-mode'
  if (!data) return null
  if (!lease) return <button className={btn} disabled={busy || (desktop && running)}
    title={running ? 'It is mid-turn: let the turn finish, then continue it in the cloud' : 'Keep this going as a PostHog cloud task while the Mac is away; messages you send here go to it, and it comes back to this conversation after'}
    onClick={() => act(`/api/cloud/${encodeURIComponent(id)}`)}>{busy ? '…' : '☁ Continue in cloud'}</button>
  return (
    <span className={`cloud-bar ${desktop ? 'cloud-ctl' : ''}`}>
      <a href={lease.url ?? '#'} target="_blank" rel="noreferrer" title="Open the cloud task in PostHog">☁ {lease.status === 'returning' ? 'Coming back…' : lease.finished_at ? 'Cloud finished' : 'In the cloud'}</a>
      {lease.status === 'cloud' && <button className={desktop ? 'icon' : 's-mode'} disabled={busy} title="Bring it back to the Mac: the cloud wraps up and pushes, then this conversation continues here" onClick={() => act(`/api/cloud/${encodeURIComponent(id)}/back`)}>{busy ? '…' : 'Bring back'}</button>}
    </span>
  )
}
