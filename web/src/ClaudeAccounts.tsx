// How claude is billed (server/account.ts): Claude Code's own login by default, or an Anthropic API
// key kept in the macOS keychain and passed to claude processes as ANTHROPIC_API_KEY.
import { useState } from 'react'
import { api, post, useLive } from './api'

type Win = { key: string; label: string; pct: number; resetsAt: number }
export type Billing = { billing: 'login' | 'api'; apiKey: boolean; out: boolean; until: number | null; usage: { windows: Win[] } | null; login?: { email: string | null; org: string | null; plan: string | null } | null }

export const useBilling = () => useLive<Billing>('/api/claude-billing', ['settings', 'chats'], undefined, 60_000)
const time = (t: number) => new Date(t).toLocaleTimeString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })

export function ClaudeBillingCard() {
  const { data, reload } = useBilling()
  const [key, setKey] = useState('')
  const [err, setErr] = useState('')
  if (!data) return null
  const save = async () => { setErr(''); const r: any = await post('/api/claude-billing/key', { key }); if (r?.error) setErr(r.error); else { setKey(''); reload() } }
  return (
    <section className="card">
      <h3>Claude billing</h3>
      <div className="muted small">Uses your Claude Code login by default. Add an API key to bill usage to the API instead.</div>
      {data.apiKey
        ? <div className="row-flex small" style={{ marginTop: 6 }}><span className="grow">Anthropic API key in the keychain</span><button className="link" onClick={async () => { await api.send('DELETE', '/api/claude-billing/key'); reload() }}>remove</button></div>
        : <div className="row-flex" style={{ marginTop: 6 }}>
            <input className="grow" type="password" placeholder="sk-ant-api03-…" value={key} onChange={e => setKey(e.target.value)} onKeyDown={e => e.key === 'Enter' && key && save()} />
            <button disabled={!key} onClick={save}>Save</button>
          </div>}
      {err && <div className="bad small">{err}</div>}
    </section>
  )
}

// Quiet by default: shows only when Claude's usage is filling up (>=70% on any window) or out,
// from what the claude CLI itself reports.
const worstOf = (b: Billing) => (b.usage?.windows ?? []).reduce((m, w) => Math.max(m, w.pct), 0)
export function ClaudePressure() {
  const { data } = useBilling()
  if (!data || !(data.out || worstOf(data) >= 0.7)) return null
  const p = worstOf(data)
  const heat = data.out || p >= 0.9 ? 'hot' : 'warm'
  const detail = `${data.usage?.windows?.length ? data.usage.windows.map(w => `${w.label} ${Math.round(w.pct * 100)}%, resets ${time(w.resetsAt)}`).join('; ') : 'no usage seen yet'}${data.out && data.until ? `; at limit until ${time(data.until)}` : ''}`
  return <span className="usage-chips" title={detail}><span className={`usage-chip ${heat}`}>Claude {data.out ? 'full' : `${Math.round(p * 100)}%`}</span></span>
}

// Claude subscriptions in this profile (server/account.ts): a Team seat and a personal Max plan,
// say. Each is the claude CLI's own login in its own folder; chats keep their context when Auto
// moves them between subscriptions. Order = preference; a pin makes Auto use only that one while it can.
export type ClaudeSub = { id: string; label: string; main: boolean; enabled: boolean; pinned: boolean; active: boolean; login: { loggedIn: boolean; email?: string; org?: string; plan?: string } | null; usage: { windows: Win[]; blocked?: boolean } | null }
export const useClaudeSubs = () => useLive<ClaudeSub[]>('/api/claude-subs', ['settings', 'chats'], undefined, 60_000)
const who = (s: ClaudeSub) => !s.login ? 'checking…' : !s.login.loggedIn ? 'not signed in' : [s.login.email, s.login.org, s.login.plan].filter(Boolean).join(' · ')
export const subChips = (s: { usage: { windows: Win[] } | null }) => (s.usage?.windows ?? []).map(w => `${w.label} ${Math.round(w.pct * 100)}%`).join(' · ')

export function ClaudeSubsCard({ Login }: { Login: (p: { login?: any }) => any }) {
  const { data, reload } = useClaudeSubs()
  const { data: st } = useLive<any>('/api/status', ['status'], undefined, 3000)
  const [name, setName] = useState('')
  const [edit, setEdit] = useState<string | null>(null)
  if (!data) return null
  const put = async (id: string, p: any) => { await api.send('PUT', `/api/claude-subs/${encodeURIComponent(id)}`, p); reload() }
  const add = async () => { if (!name.trim()) return; await post('/api/claude-subs', { label: name.trim() }); setName(''); reload() }
  return (
    <section className="card">
      <h3>Claude subscriptions</h3>
      <div className="muted small">Every Claude plan this profile can use. Auto starts new chats on the first one with room, keeps a chat where it is while that plan is on pace, and moves it (same conversation, same context) when it runs ahead of its weekly budget or hits a limit. Pin one to use only it while it can work.</div>
      {data.map((s, i) => (
        <div key={s.id} className="line" style={{ alignItems: 'flex-start' }}>
          <span className={`ex-dot ${s.login?.loggedIn ? 'connected' : s.login ? 'missing' : 'expired'}`} style={{ marginTop: 6 }} />
          <div className="grow">
            {edit === s.id
              ? <input autoFocus defaultValue={s.label} onBlur={e => { put(s.id, { label: e.target.value }); setEdit(null) }} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
              : <b onDoubleClick={() => setEdit(s.id)} title="Double-click to rename">{s.label}</b>}
            {s.active && <span className="ex-badge yours" style={{ marginLeft: 6 }}>Auto's pick now</span>}
            {s.pinned && <span className="ex-badge" style={{ marginLeft: 6 }}>pinned</span>}
            {!s.enabled && <span className="ex-badge" style={{ marginLeft: 6 }}>off</span>}
            <div className="muted small">{who(s)}{subChips(s) ? ` · ${subChips(s)}` : ''}{s.main ? ' · this profile’s main login' : ''}</div>
          </div>
          {s.login && !s.login.loggedIn && <button className="small primary" onClick={() => post(`/api/claude-subs/${s.id}/login`)}>Sign in</button>}
          <button className="small" title={s.pinned ? 'Let Auto choose again' : 'Use only this one while it can work'} onClick={() => put(s.id, { pinned: !s.pinned })}>{s.pinned ? 'Unpin' : 'Pin'}</button>
          <button className="small" disabled={i === 0} title="Prefer this one" onClick={() => put(s.id, { move: -1 })}>↑</button>
          <button className="small" disabled={i === data.length - 1} title="Prefer it less" onClick={() => put(s.id, { move: 1 })}>↓</button>
          <button className="small" onClick={() => put(s.id, { enabled: !s.enabled })}>{s.enabled ? 'Turn off' : 'Turn on'}</button>
          {!s.main && <button className="link small" onClick={async () => { if (confirm(`Remove ${s.label}? Its sign-in stays in ~/.claude-subs until you delete it.`)) { await api.send('DELETE', `/api/claude-subs/${s.id}`); reload() } }}>remove</button>}
        </div>
      ))}
      <Login login={st?.claudeLogin} />
      <div className="row-flex small" style={{ marginTop: 6, gap: 6 }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Name, e.g. Max (personal)" onKeyDown={e => { if (e.key === 'Enter') add() }} />
        <button className="small" disabled={!name.trim()} onClick={add}>Add a Claude subscription</button>
        <span className="muted">opens the Claude sign-in in your browser; pick the account and plan there</span>
      </div>
    </section>
  )
}
