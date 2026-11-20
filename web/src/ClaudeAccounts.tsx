// How claude is billed (server/account.ts): Claude Code's own login by default, or an Anthropic API
// key kept in the macOS keychain and passed to claude processes as ANTHROPIC_API_KEY.
import { useState } from 'react'
import { api, post, useLive } from './api'
import { ConnectSub, subDetail, type SubView } from './EnginePicker'

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

// Settings → Subscriptions: every Claude and OpenAI login (server/subscriptions.ts), who each is
// signed in as, and the controls: sign in again, rename, remove. Connect more at the bottom.
export function SubscriptionsCard() {
  const { data, reload } = useLive<{ subs: SubView[] }>('/api/subscriptions', ['subscriptions'], undefined, 120_000)
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')
  const rename = async (id: string) => { if (name.trim()) await post(`/api/subscriptions/${encodeURIComponent(id)}`, { label: name.trim() }); setEditing(null); reload() }
  return (
    <section className="card sub-list">
      <h3>Subscriptions <button className="link small" onClick={() => api.get('/api/subscriptions?refresh=1').then(reload)}>refresh</button></h3>
      <div className="muted small">Every Claude and OpenAI plan you’re signed in to, personal and team. Pick one per chat in the model menu; a chat keeps its history and tools when you move it between them.</div>
      {(data?.subs ?? []).map(s => (
        <div key={s.id} className="sub-row">
          <span className={`dot ${s.status?.ok ? 'ok' : 'bad'}`} />
          <span className="grow">
            {editing === s.id
              ? <input autoFocus value={name} onChange={e => setName(e.target.value)} onBlur={() => rename(s.id)} onKeyDown={e => { if (e.key === 'Enter') rename(s.id); if (e.key === 'Escape') setEditing(null) }} />
              : <b title="Rename" style={{ cursor: 'text' }} onClick={() => { setEditing(s.id); setName(s.label) }}>{s.provider === 'claude' ? 'Claude' : 'OpenAI'} · {s.label}</b>}
            {s.isDefault && <span className="muted small"> · this profile’s default</span>}
            <div className="muted small">{subDetail(s)}</div>
            {s.login?.state === 'failed' && s.login.error && <div className="bad small">{s.login.error}</div>}
          </span>
          {s.login?.state !== 'waiting' && <button className="small" onClick={async () => { await post(`/api/subscriptions/${encodeURIComponent(s.id)}/login`); reload() }}>{s.status?.ok ? 'Switch account' : 'Sign in'}</button>}
          {!s.builtin && <button className="link small" onClick={async () => { await api.send('DELETE', `/api/subscriptions/${encodeURIComponent(s.id)}`); reload() }}>remove</button>}
        </div>
      ))}
      <ConnectSub onDone={reload} />
    </section>
  )
}
