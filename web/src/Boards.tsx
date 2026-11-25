// Boards: canvases that stand on their own. A board page, the index of boards, the button a chat
// uses to show one, and the frame that puts a board beside a chat or instead of it.
import { useEffect, useRef, useState } from 'react'
import { post, toast, useLive, type Conversation } from './api'
import { Canvas } from './Canvas'
import { Splitter, useColumnWidth } from './Splitter'

export type BoardSummary = { id: string; name: string; about: string | null; pinned: number; updated_at: number; ttl_seconds: number | null; expires_at: number | null; tiles: { id: string; kind: string; title: string; error: string | null }[] }
export const useBoards = () => useLive<{ boards: BoardSummary[] }>('/api/boards', ['canvas'])
const useRecent = () => useLive<Conversation[] | { conversations: Conversation[] }>('/api/conversations?limit=40', ['conversations'])
const recentList = (d: any): Conversation[] => Array.isArray(d) ? d : d?.conversations ?? []
const duration = (s: number) => s >= 86400 && s % 86400 === 0 ? `${s / 86400}d` : s >= 3600 && s % 3600 === 0 ? `${s / 3600}h` : `${Math.round(s / 60)}m`
function LifetimeSelect({ value, onChange }: { value: number | null; onChange: (ttl: number | null) => void }) {
  const options = [3600, 86400, 604800]
  if (value != null && !options.includes(value)) options.push(value)
  return <select className="small" aria-label="Canvas lifetime" title="Temporary canvases disappear after this long without use. Opening or interacting resets the timer." value={value ?? ''} onChange={e => onChange(e.target.value ? Number(e.target.value) : null)}>
    <option value="">Keep permanently</option>
    {options.sort((a, b) => a - b).map(s => <option key={s} value={s}>Temporary · {duration(s)} idle</option>)}
  </select>
}
function KeepBoard({ b }: { b: BoardSummary }) {
  return b.ttl_seconds == null ? null : <button className="small" title="Keep this canvas permanently" onClick={() => post<any>(`/api/boards/${b.id}`, { temporary: false }).then(r => r?.error && toast(r.error))}>Keep</button>
}

export function BoardPage({ id, onOpen, onBoards }: { id: string; onOpen: (id: string) => void; onBoards: () => void }) {
  const { data, error } = useLive<any>(`/api/boards/${encodeURIComponent(id)}`, ['canvas'])
  const recent = recentList(useRecent().data)
  if (error) return <div className="pad muted">{error === 'No such board' ? 'This canvas expired or was removed.' : error} <button className="link" onClick={onBoards}>All boards</button></div>
  if (!data) return <div className="pad muted">…</div>
  if (data.error) return <div className="pad muted">This board is gone. <button className="link" onClick={onBoards}>All boards</button></div>
  return (
    <div className="page board-page">
      <BoardHead b={data} onBoards={onBoards} />
      <Canvas folderId={id} ttlSeconds={data.ttl_seconds} conversations={recent} onOpen={onOpen} />
    </div>
  )
}

function BoardHead({ b, onBoards }: { b: BoardSummary; onBoards?: () => void }) {
  const [name, setName] = useState(b.name)
  useEffect(() => setName(b.name), [b.name])
  const save = (patch: any) => post<any>(`/api/boards/${b.id}`, patch).then(r => r?.error && toast(r.error))
  return (
    <div className="row-flex board-head" style={{ flexWrap: 'wrap' }}>
      {onBoards && <button className="link small" onClick={onBoards}>← Boards</button>}
      <input className="board-name grow" value={name} onChange={e => setName(e.target.value)} onBlur={() => name.trim() && name !== b.name && save({ name: name.trim() })} />
      <LifetimeSelect value={b.ttl_seconds} onChange={ttl_seconds => save({ ttl_seconds })} />
      <KeepBoard b={b} />
      <button className={`small ${b.pinned ? 'on' : ''}`} onClick={() => save({ pinned: !b.pinned })} title="Pinning keeps this canvas permanently and adds a link on Home (3 at most)">{b.pinned ? '⌂ On Home' : '⌂ Pin to Home'}</button>
    </div>
  )
}

export function BoardsIndex({ onOpenBoard }: { onOpenBoard: (id: string) => void }) {
  const list = useBoards().data?.boards ?? []
  const [name, setName] = useState('')
  const [ttl, setTtl] = useState<number | null>(null)
  const make = async () => { const n = name.trim(); if (!n) return; const b = await post<any>('/api/boards', { name: n, ttl_seconds: ttl }); if (b?.error) return toast(b.error); setName(''); if (b?.id) onOpenBoard(b.id) }
  return (
    <div className="page">
      <h2>Boards</h2>
      <div className="muted small">Keep a live view, or make a temporary canvas for a quick visualization. Temporary canvases disappear after their idle time; opening or using one resets its timer.</div>
      <div className="row-flex" style={{ margin: '12px 0', flexWrap: 'wrap' }}>
        <input className="grow" value={name} placeholder="New board name" onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && make()} />
        <LifetimeSelect value={ttl} onChange={setTtl} />
        <button onClick={make} disabled={!name.trim()}>New board</button>
      </div>
      {[false, true].map(temporary => <section key={String(temporary)}>
        {list.some(b => (b.ttl_seconds != null) === temporary) && <h3>{temporary ? 'Temporary canvases' : 'Kept boards'}</h3>}
        {list.filter(b => (b.ttl_seconds != null) === temporary).map(b => (
        <button key={b.id} className="board-row" onClick={() => onOpenBoard(b.id)}>
          <b>{b.name}</b>{b.pinned ? <span className="muted small"> · on Home</span> : null}
          {b.ttl_seconds != null && <span className="muted small">Temporary · {duration(b.ttl_seconds)} idle</span>}
          <span className="muted small ellipsis">{b.tiles.map(t => t.title).join(' · ') || 'empty'}</span>
        </button>
        ))}
      </section>)}
    </div>
  )
}

// The button in a chat's header: pick a board and how to show it.
export function BoardButton({ conversationId }: { conversationId: string }) {
  const { data } = useLive<{ board: { board_id: string; layout: 'side' | 'full' } | null }>(`/api/chat-board/${encodeURIComponent(conversationId)}`, ['canvas'])
  const boards = useBoards().data?.boards ?? []
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (!open) return; const f = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false); addEventListener('mousedown', f); return () => removeEventListener('mousedown', f) }, [open])
  const cur = data?.board
  const set = (board_id: string | null, layout: 'side' | 'full' = cur?.layout ?? 'side') => { post(`/api/chat-board/${encodeURIComponent(conversationId)}`, { board_id, layout }); setOpen(false) }
  return (
    <div className="board-btn" ref={ref}>
      <button className={`icon ${cur ? 'on' : ''}`} title="Show a board with this chat" onClick={() => setOpen(!open)}>▦</button>
      {open && (
        <div className="menu board-menu">
          {cur && <div className="row-flex small">
            <button className={cur.layout === 'side' ? 'on' : ''} onClick={() => set(cur.board_id, 'side')}>Beside chat</button>
            <button className={cur.layout === 'full' ? 'on' : ''} onClick={() => set(cur.board_id, 'full')}>Instead of chat</button>
            <button onClick={() => set(null)}>Hide</button>
          </div>}
          {boards.map(b => <button key={b.id} className={`menu-item ${cur?.board_id === b.id ? 'on' : ''}`} onClick={() => set(b.id)}>{b.name}{b.ttl_seconds != null ? ` · temporary (${duration(b.ttl_seconds)} idle)` : ''}</button>)}
          {!boards.length && <div className="muted small pad">No boards yet. Ask the agent to make one.</div>}
        </div>
      )}
    </div>
  )
}

// A chat with its board: beside it (resizable split) or instead of it (board full, chat one click away).
export function WithBoard({ conversationId, chat, onOpen }: { conversationId: string | null; chat: React.ReactNode; onOpen: (id: string) => void }) {
  const { data } = useLive<{ board: { board_id: string; layout: 'side' | 'full' } | null }>(conversationId ? `/api/chat-board/${encodeURIComponent(conversationId)}` : null, ['canvas'])
  const [peek, setPeek] = useState(false)
  const width = useColumnWidth('board', 560, 280, 1600)
  const cb = conversationId ? data?.board : null
  const recent = recentList(useRecent().data)
  const { data: b, error } = useLive<any>(cb ? `/api/boards/${encodeURIComponent(cb.board_id)}` : null, ['canvas'])
  if (!cb || !b || b.error || error) return <>{chat}</>
  const set = (patch: any) => post(`/api/chat-board/${encodeURIComponent(conversationId!)}`, { board_id: cb.board_id, layout: cb.layout, ...patch })
  const head = (
    <div className="row-flex board-strip">
      <b className="grow ellipsis">▦ {b.name}</b>
      {b.ttl_seconds != null && <span className="muted small" title="Expires after this long without use">{duration(b.ttl_seconds)} idle</span>}
      <KeepBoard b={b} />
      {cb.layout === 'full'
        ? <><button className="small" onClick={() => setPeek(!peek)}>{peek ? 'Hide chat' : 'Show chat'}</button><button className="small" onClick={() => set({ layout: 'side' })}>Beside chat</button></>
        : <button className="small" onClick={() => set({ layout: 'full' })}>Instead of chat</button>}
      <button className="icon" title="Hide the board" onClick={() => set({ board_id: null })}>×</button>
    </div>
  )
  const board = <div className="with-board-board">{head}<div className="scroll"><Canvas folderId={b.id} ttlSeconds={b.ttl_seconds} conversations={recent} onOpen={onOpen} fit={cb.layout} /></div></div>
  if (cb.layout === 'full') return <div className={`with-board full ${peek ? 'peek' : ''}`}>{board}{peek && <div className="with-board-chat">{chat}</div>}</div>
  return <div className="with-board side"><div className="with-board-chat">{chat}</div>
    <Splitter side="right" width={width.width} onWidth={width.setWidth} onReset={width.reset} />
    <div className="with-board-col" style={{ width: width.width }}>{board}</div></div>
}
