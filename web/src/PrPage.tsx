// One PR with everything around it: who is working on it and what each agent is doing right now,
// every conversation about it, and the PR itself (checks, review comments, description, files).
import { useEffect, useRef, useState } from 'react'
import { ago, post, sendChat, useLive } from './api'
import { MiniChat } from './Mini'
import { Brand, sourceBrand } from './Brand'
import { PrMenu } from './Home'
import { PrPreviewCard } from './PrPreview'
import { AgentRows } from './Agents'
import { JourneyCard, ReadyCard } from './Journey'


export function PrPage({ url, onOpen, sideConversations }: { url: string; onOpen: (id: string) => void; sideConversations?: boolean }) {
  const { data: p, reload } = useLive<any>(`/api/pr/page?url=${encodeURIComponent(url)}`, ['conversations', 'chats'])
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  useEffect(() => { const t = setInterval(reload, 30_000); return () => clearInterval(t) }, [url]) // eslint-disable-line
  const n = String(url ?? '').split('/').pop()
  const open = (c: any) => onOpen(c.id)
  return (
    <div className="page pr-page">
      <div className="row-flex">
        <h2 className="grow">{p?.title ?? `#${n}`}</h2>
        <a className="button" href={url} target="_blank" rel="noreferrer">↗ GitHub</a>
        <button ref={btn} onClick={() => { const r = btn.current!.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4 }) }}>Actions ▾</button>
      </div>
      {p?.origin?.length > 0 && <details className="card small">
        <summary>Originated with {p.origin[0].owner}</summary>
        <ol>{p.origin.map((o: any) => <li key={o.subject}>
          {o.subject.startsWith('chat:') ? <button className="link" onClick={() => onOpen(o.subject.slice(5))}>{o.label}</button> : o.label}
          <span className="muted"> · {o.kind}</span>
        </li>)}</ol>
      </details>}
      <ReadyCard url={url} />
      <section className="card">
        <h4>Agents on it</h4>
        {!p ? <div className="muted small">…</div> : !p.agents.length
          ? <div className="muted small">○ No agent is working on this PR right now. Use Actions → Push it through to put a shepherd on it.</div>
          : <AgentRows list={p.agents} onOpen={onOpen} now />}
      </section>
      {!sideConversations && p?.conversations?.length > 0 && (
        <section className="card">
          <h4>Conversations about it <span className="muted">{p.conversations.length}</span></h4>
          <div className="pr-convs">{p.conversations.map((c: any) => (
            <div key={c.id} className="pr-conv big" onClick={() => open(c)} title="Open in perch">
              <Brand id={sourceBrand(c)} size={14} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis small"><b>{String(c.title ?? '').replace(/^\[[^\]]*\]\s*/, '')}</b></div>
                {c.now && <div className="ellipsis small muted">{c.now}</div>}
              </div>
              {c.status === 'in_progress' && <span className="dot s-running" title="running" />}
              <span className="muted small nowrap">{ago(c.updated_at)}</span>
            </div>))}</div>
        </section>)}
      <JourneyCard url={url} />
      <section className="card"><PrPreviewCard url={url} inPage /></section>
      {menu && p && <PrMenu target={{ ...menu, pr: url, title: p.title, draft: p.state === 'draft' }} onClose={() => setMenu(null)} onOpen={onOpen} onDone={reload} />}
    </div>
  )
}

// The right column in PR view: every conversation about this PR, the selected one live with a reply
// box, and a box to start a new one about the PR. The PR itself keeps the main area.
export function PrSide({ url, onOpen }: { url: string; onOpen: (id: string) => void }) {
  const { data: p } = useLive<any>(`/api/pr/page?url=${encodeURIComponent(url)}`, ['conversations', 'chats'])
  const [picked, setPicked] = useState<string | null>(null)
  const [ask, setAsk] = useState('')
  const convs: any[] = p?.conversations ?? []
  const auto = convs.find(c => c.status === 'in_progress' || c.status === 'running')?.id ?? convs.find(c => c.source === 'claude')?.id ?? convs[0]?.id ?? null
  const sel = picked && convs.some(c => c.id === picked) ? picked : auto
  const cur = convs.find(c => c.id === sel)
  useEffect(() => { setPicked(null) }, [url])
  const n = String(url ?? '').split('/').pop()
  const start = async () => {
    if (!ask.trim()) return
    const r = await sendChat<{ id: string }>({ prompt: `About PR ${url}${p?.title ? ` ("${p.title}")` : ''}:\n\n${ask.trim()}` })
    setAsk(''); setPicked(r.id)
  }
  return (
    <div className="pr-side">
      <div className="pr-side-head"><b>Conversations about #{n}</b> <span className="muted small">{convs.length || ''}</span></div>
      <div className="pr-side-list">
        {!p ? <div className="muted small pad">…</div> : !convs.length ? <div className="muted small pad">No conversations about this PR yet.</div>
          : convs.map(c => (
            <button key={c.id} className={`pr-side-item${c.id === sel ? ' on' : ''}`} onClick={() => setPicked(c.id)} onDoubleClick={() => onOpen(c.id)} title="Click to show here, double-click to open">
              <Brand id={sourceBrand(c)} size={13} />
              <span className="grow ellipsis">{String(c.title ?? '').replace(/^\[[^\]]*\]\s*/, '')}</span>
              {c.status === 'in_progress' && <span className="dot s-running" />}
              <span className="muted small nowrap">{ago(c.updated_at)}</span>
            </button>))}
      </div>
      {cur && (
        <div className="pr-side-chat">
          <div className="pr-side-chat-head"><span className="grow ellipsis small"><b>{String(cur.title ?? '').replace(/^\[[^\]]*\]\s*/, '')}</b></span><button className="icon" onClick={() => onOpen(cur.id)} title="Open in the main area">↗</button></div>
          <MiniChat key={cur.id} id={cur.id} bare readOnly={cur.source === 'posthog-task' ? 'A cloud task: open it to follow up there.' : undefined} />
        </div>)}
      <textarea className="pr-side-ask" rows={2} value={ask} placeholder={`New chat about #${n}… (Enter to start)`} onChange={e => setAsk(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); start() } }} />
    </div>
  )
}
