// Work, Personal…: which profile this window shows, switching, and carrying a conversation across.
import { useEffect, useRef, useState } from 'react'
import { api, post, shell, toast, useLive } from './api'

type P = { id: string; label: string; color: string; port: number; enabled: boolean; borrows: string[] }
export const useProfiles = () => useLive<{ current: string; profiles: P[] }>('/api/profile', ['settings'])

// The pill in the sidebar header, and the profile's colour along the top of the window.
export function ProfileSwitch({ onSettings }: { onSettings: () => void }) {
  const { data, reload } = useProfiles()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const cur = data?.profiles.find(p => p.id === data.current)
  useEffect(() => { if (cur) { document.documentElement.style.setProperty('--profile', cur.color); document.documentElement.dataset.profile = cur.id } }, [cur?.id, cur?.color])
  useEffect(() => { if (!open) return; const c = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }; addEventListener('mousedown', c); return () => removeEventListener('mousedown', c) }, [open])
  if (!data || !cur) return null
  const go = async (p: P) => {
    setOpen(false)
    if (!p.enabled) await post(`/api/profile/${p.id}/enable`, { on: true })
    if (shell.switchProfile) await shell.switchProfile(p.id)
    else location.href = `http://${location.hostname}:${p.port}/`
    reload()
  }
  return (
    <div className="profile-switch no-drag" ref={ref}>
      <button className="profile-pill" onClick={() => setOpen(!open)} title="Switch profile: each has its own accounts, MCPs and conversations">
        <span className="profile-dot" style={{ background: cur.color }} />{cur.label} <span className="muted">▾</span>
      </button>
      {open && (
        <div className="profile-menu">
          {data.profiles.map(p => (
            <button key={p.id} onClick={() => p.id !== cur.id && go(p)} className={p.id === cur.id ? 'on' : ''}>
              <span className="profile-dot" style={{ background: p.color }} />{p.label}
              <span className="muted small grow right">{p.id === cur.id ? 'this window' : p.enabled ? 'switch' : 'turn on'}</span>
            </button>
          ))}
          <hr />
          <button onClick={() => { setOpen(false); onSettings() }} className="small">Accounts and logins…</button>
        </div>
      )}
    </div>
  )
}

// Settings → Profiles: what this profile is logged in to, and one-click logins in its own accounts.
export function ProfilesCard({ onTerminal }: { onTerminal: (cmd: string, title: string) => void }) {
  const { data, reload } = useProfiles()
  const [st, setSt] = useState<any>(null)
  useEffect(() => { if (data) api.get(`/api/profile/${data.current}/status`).then(setSt).catch(() => {}) }, [data?.current])
  if (!data) return null
  const cur = data.profiles.find(p => p.id === data.current)!
  const others = data.profiles.filter(p => p.id !== cur.id)
  const setBorrow = async (other: string, on: boolean) => { await post(`/api/profile/${cur.id}/borrows`, { other, on }); reload() }
  return (
    <section className="card">
      <h3><span className="profile-dot" style={{ background: cur.color }} /> Profile: {cur.label}</h3>
      <div className="muted small">Everything in this window belongs to {cur.label}: its own conversations, PRs and settings, its own Claude subscription and MCP servers{st?.claudeDir ? ` (${st.claudeDir.replace(/^\/Users\/[^/]+/, '~')})` : ''}, its own GitHub login and PostHog key. Other profiles keep running; nothing crosses over unless you copy it.</div>
      {!st ? <div className="muted small">Checking logins…</div> : (
        <div className="profile-logins">
          <div className="row-flex small"><b>Claude</b><span className={st.claude ? 'ok-text' : 'bad'}>{st.claude ?? 'not logged in'}</span><span className="grow" />
            <button onClick={() => { post('/api/claude/login'); toast('Finish signing in to Claude in your browser', { kind: 'info' }) }}>{st.claude ? 'Switch account' : 'Log in'}</button></div>
          <div className="row-flex small"><b>GitHub</b><span className={st.github ? 'ok-text' : 'bad'}>{st.github ?? 'not logged in'}</span><span className="grow" />
            <button onClick={() => onTerminal('gh auth login', `GitHub login (${cur.label})`)}>{st.github ? 'Switch account' : 'Log in'}</button></div>
          <div className="muted small">PostHog: set this profile’s key under Connections above.</div>
        </div>
      )}
      {others.length > 0 && (
        <div className="profile-logins">
          <div className="muted small">Borrowing: offer another profile's Claude and OpenAI logins here too, as extra subscriptions in the model menu. One-directional — it doesn't let that profile see {cur.label}'s.</div>
          {others.map(o => (
            <label key={o.id} className="line small">
              <input type="checkbox" checked={cur.borrows.includes(o.id)} onChange={e => setBorrow(o.id, e.target.checked)} />
              <span className="profile-dot" style={{ background: o.color }} /> Also offer {o.label}'s logins here
            </label>
          ))}
        </div>
      )}
    </section>
  )
}

// Copy a conversation to another profile, after seeing exactly what goes.
export function CarryDialog() {
  const { data } = useProfiles()
  const [id, setId] = useState<string | null>(null)
  const [mode, setMode] = useState<'brief' | 'full'>('brief')
  const [to, setTo] = useState('')
  const [preview, setPreview] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { const on = (e: Event) => { setId((e as CustomEvent).detail); setPreview(null); setMode('brief') }; addEventListener('perch-carry', on); return () => removeEventListener('perch-carry', on) }, [])
  useEffect(() => { if (id) api.get(`/api/conversations/${encodeURIComponent(id)}/carry?mode=${mode}`).then(setPreview) }, [id, mode])
  const others = (data?.profiles ?? []).filter(p => p.id !== data?.current)
  useEffect(() => { if (others.length && !others.some(o => o.id === to)) setTo(others[0].id) }, [others.map(o => o.id).join()]) // eslint-disable-line
  if (!id) return null
  const target = others.find(o => o.id === to)
  const send = async () => {
    setBusy(true)
    const r = await post<any>(`/api/conversations/${encodeURIComponent(id)}/carry`, { to, mode })
    setBusy(false)
    if (!r?.error) { toast(`Copied to ${r.to}. It’s in that profile’s list, ready to continue.`, { kind: 'ok' }); setId(null) }
  }
  return (
    <div className="file-viewer-back" onClick={() => setId(null)}>
      <div className="file-viewer carry" onClick={e => e.stopPropagation()}>
        <div className="file-viewer-head">
          <b className="grow">Copy to another profile</b>
          {others.length > 1 && <select value={to} onChange={e => setTo(e.target.value)}>{others.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</select>}
          <button className="icon" onClick={() => setId(null)}>×</button>
        </div>
        <div className="carry-opts row-flex small">
          <label><input type="radio" checked={mode === 'brief'} onChange={() => setMode('brief')} /> The ask and latest answer</label>
          <label><input type="radio" checked={mode === 'full'} onChange={() => setMode('full')} /> The whole thread (condensed)</label>
        </div>
        <div className="muted small carry-note">Only this text goes to {target?.label ?? 'the other profile'}: no files, keys or connections. Read it first if it might hold {data?.current === 'work' ? 'company' : 'private'} details.</div>
        <div className="file-viewer-body"><pre className="file-text">{preview ? `${preview.title}\n\n${preview.text}` : 'Loading…'}</pre></div>
        <div className="carry-foot row-flex">
          <span className="muted small grow">{preview ? `${preview.text.length.toLocaleString()} characters` : ''}</span>
          <button onClick={() => setId(null)}>Cancel</button>
          <button className="primary" disabled={!preview || busy || !target} onClick={send}>{busy ? 'Copying…' : `Copy to ${target?.label ?? '…'}`}</button>
        </div>
      </div>
    </div>
  )
}
export const carry = (id: string) => window.dispatchEvent(new CustomEvent('perch-carry', { detail: id }))
