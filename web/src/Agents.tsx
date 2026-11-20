// Who is on a PR, Google Docs style: overlapping avatars, one per agent. The ring says the state:
// green and pulsing = working now, grey = waiting for its next look, amber = late (its signal went
// quiet). Hover for what each is doing, since when, and what proves it.
import { useEffect, useState } from 'react'
import { ago, onTopic } from './api'
import { Brand } from './Brand'

export type Agent = { key: string; name: string; icon?: string; avatar?: string; brand?: string; glyph?: string; state: 'working' | 'waiting' | 'late'; status: string
  since: number | null; next: number | null; proof: string; conversation?: string; link?: string }

// One shared copy for every badge on screen, refreshed when the server says presence changed.
let agents: Record<string, Agent[]> = {}
const subs = new Set<() => void>()
let on = false
const load = () => fetch('/api/pr/agents').then(r => r.json()).then(d => { agents = d ?? {}; subs.forEach(f => f()) }).catch(() => {})
export function usePrAgents(url: string): Agent[] {
  const [, bump] = useState(0)
  useEffect(() => {
    const f = () => bump(n => n + 1)
    subs.add(f)
    if (!on) { on = true; load(); let t: any; onTopic('prs', () => { clearTimeout(t); t = setTimeout(load, 500) }); setInterval(load, 60_000) }
    return () => { subs.delete(f) }
  }, [])
  return agents[url] ?? []
}

const inMin = (t: number) => { const m = Math.round((t - Date.now()) / 60_000); return m <= 0 ? 'any minute' : m < 90 ? `in ~${m}m` : `in ~${Math.round(m / 60)}h` }
export const agentLine = (a: Agent) => [a.status, a.since ? (ago(a.since) === 'now' ? 'just now' : `${a.state === 'working' ? 'for' : 'last'} ${ago(a.since)}${a.state === 'working' ? '' : ' ago'}`) : null, a.next ? `next look ${inMin(a.next)}` : null].filter(Boolean).join(' · ')

export function AgentAvatar({ a, size = 18 }: { a: Agent; size?: number }) {
  const [broken, setBroken] = useState(false)
  return (
    <span className={`agent-av ${a.state}`} style={{ width: size, height: size }} title={`${a.name}: ${agentLine(a)}\n(${a.proof})`}>
      {a.icon && !broken ? <img className="agent-art" src={a.icon} alt={a.name} onError={() => setBroken(true)} />
        : a.avatar && !broken ? <img src={`${a.avatar}${a.avatar.includes('?') ? '&' : '?'}s=${size * 2}`} alt={a.name} onError={() => setBroken(true)} />
        : a.brand ? <Brand id={a.brand} size={Math.round(size * 0.66)} />
        : <span className="agent-glyph" style={{ fontSize: Math.round(size * 0.6) }}>{a.glyph ?? a.name[0]}</span>}
    </span>
  )
}

export function AgentStack({ list, size = 16, max = 4 }: { list: Agent[]; size?: number; max?: number }) {
  if (!list.length) return null
  const shown = list.slice(0, max)
  return (
    <span className="agent-stack" title={list.map(a => `${a.name}: ${agentLine(a)}`).join('\n')}>
      {shown.map(a => <AgentAvatar key={a.key} a={a} size={size} />)}
      {list.length > max && <span className="agent-more">+{list.length - max}</span>}
    </span>
  )
}

// The live stack for any PR url (conversation-list badges, previews).
export function PrAgents({ url, size }: { url: string; size?: number }) {
  return <AgentStack list={usePrAgents(url)} size={size} />
}

// One row per agent, for the PR page and previews.
export function AgentRows({ list, onOpen, now }: { list: (Agent & { now?: string | null })[]; onOpen?: (id: string) => void; now?: boolean }) {
  return <>{list.map(a => (
    <div key={a.key} className={`agent-row${a.conversation && onOpen ? '' : ' static'}`} onClick={() => a.conversation && onOpen?.(a.conversation)}>
      <AgentAvatar a={a} size={22} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="small"><b>{a.name}</b> <span className={`agent-state ${a.state}`}>{a.state === 'working' ? 'working' : a.state === 'late' ? 'late' : 'waiting'}</span></div>
        <div className="small ellipsis" title={agentLine(a)}>{agentLine(a)}</div>
        {now && a.now && <div className="small muted ellipsis" title={a.now}>{a.now}</div>}
        <div className="tiny muted">from {a.proof}</div>
      </div>
    </div>))}</>
}
