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
