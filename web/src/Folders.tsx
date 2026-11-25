// Folders in the sidebar (Recent first, then workspaces the organiser built or you made) and the
// workspace view: one folder's threads, what needs you there, its PRs, and new chats inside it.
import { Canvas } from './Canvas'
import { useState } from 'react'
import { ago, api, post, titleOf, useLive, type Conversation } from './api'
import { PrBadge } from './List'

export type Folder = { id: string; name: string; description: string | null; label: string; query: string | null; icon: string | null; cwd: string | null; auto: number; n: number; waiting: number; running: number; updated_at: number }
type FolderData = { folders: Folder[]; organizer: { running: boolean; lastRun: number; error: string } }

export function FolderList({ selected, onOpen, onRecent, recentOn, zenAreas }: { selected: string | null; onOpen: (f: Folder) => void; onRecent: () => void; recentOn: boolean; zenAreas?: { name: string; query: string }[] | null }) {
  const { data } = useLive<FolderData>('/api/folders', ['folders' as any, 'conversations'])
  const [open, setOpen] = useState(() => localStorage.getItem('perch.folders') !== '0')
  const toggle = () => { setOpen(!open); try { localStorage.setItem('perch.folders', open ? '0' : '1') } catch {} }
  // In zen only the folders you're focused on stay; with no matching folder the section goes away.
  const all = data?.folders ?? []
  const list = zenAreas ? all.filter(f => zenAreas.some(a => a.query.includes(`#${f.label}`) || a.name === f.name || (f.query && a.query === f.query))) : all
  if (zenAreas && !list.length) return null
  return (
    <div className="folders">
      <div className="section-head folders-head" onClick={toggle}>
        <span>{open ? '▾' : '▸'} Folders</span>
        <span className="grow" />
        {data?.organizer.running ? <span className="muted">organising…</span> : <button className="link small" onClick={e => { e.stopPropagation(); post('/api/folders/organize', { full: !list.length }) }} title="Let the organiser regroup your threads">{list.length ? 'tidy' : 'organise'}</button>}
      </div>
      {open && (
        <>
          <div className={`folder-row ${recentOn ? 'active' : ''}`} onClick={onRecent}><span className="folder-icon">🕘</span><span className="grow">Recent</span></div>
          {list.map(f => (
            <div key={f.id} className={`folder-row ${selected === f.id ? 'active' : ''}`} onClick={() => onOpen(f)} title={f.description ?? ''} data-path={f.cwd || undefined} data-dir="1">
              <span className="folder-icon">{f.icon || '📁'}</span>
              <span className="grow ellipsis">{f.name}</span>
              {f.running > 0 && <span className="dot s-running" />}
              {f.waiting > 0 && <span className="badge">{f.waiting}</span>}
              <span className="muted small">{f.n}</span>
            </div>
          ))}
          {!list.length && !data?.organizer.running && <div className="muted small pad-s">No folders yet. “organise” groups your threads into workstreams.</div>}
        </>
      )}
    </div>
  )
}

export function FolderView({ id, onOpen, onNewChat, onFocus }: { id: string; onOpen: (c: Conversation) => void; onNewChat: (f: Folder) => void; onFocus: (f: Folder) => void }) {
  const { data: f } = useLive<Folder & { conversations: Conversation[] }>(`/api/folders/${id}`, ['folders' as any, 'conversations'])
  const [edit, setEdit] = useState(false)
  const [tab, setTab] = useState(() => { try { return localStorage.getItem(`perch.folder.tab.${id}`) ?? 'threads' } catch { return 'threads' } })
  const pick = (t: string) => { setTab(t); try { localStorage.setItem(`perch.folder.tab.${id}`, t) } catch {} }
  if (!f || (f as any).error) return <div className="pad muted">…</div>
  const needs = f.conversations.filter(c => c.effective === 'waiting' || c.effective === 'running')
  const rest = f.conversations.filter(c => !needs.includes(c) && !['archived', 'done'].includes(c.effective))
  const done = f.conversations.filter(c => ['archived', 'done'].includes(c.effective))
  const prs = [...new Map(f.conversations.flatMap(c => c.prs).filter(p => p.state === 'OPEN').map(p => [p.url, p])).values()]
  const row = (c: Conversation) => (
    <div key={c.id} className="conv-line" onClick={() => onOpen(c)}>
      <span className={`dot s-${c.effective}`} />
      <span className="grow ellipsis">{titleOf(c)}{c.reason ? <span className="muted small"> · {c.reason}</span> : null}</span>
      {c.prs.slice(0, 2).map(p => <PrBadge key={p.url} pr={p} />)}
      <span className="muted small">{ago(c.updated_at)}</span>
    </div>
  )
  return (
    <div className="page folder-view">
      <div className="row-flex">
        <h2 className="grow">{f.name}</h2>
        <button className="primary" onClick={() => onNewChat(f)}>+ Chat here</button>
        <button onClick={() => onFocus(f)} title="Focus the whole app on this folder">◎ Focus</button>
        <button onClick={() => setEdit(!edit)}>Edit</button>
      </div>
      {f.description && <div className="muted">{f.description}</div>}
      <div className="muted small">{f.auto ? 'Organised automatically: new threads are filed here as they come in. Edit it to make it yours.' : 'Yours: the organiser files threads into it but never renames or removes it.'} Matches <code>{f.query || `#${f.label}`}</code></div>
      {edit && <FolderEditor f={f} onDone={() => setEdit(false)} />}
      <div className="tabs">{[['threads', 'Threads'], ['canvas', 'Canvas']].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => pick(k)}>{l}</button>)}</div>
      {tab === 'canvas' && <Canvas folderId={f.id} conversations={f.conversations} cwd={f.cwd} onOpen={id => onOpen({ id, source: 'claude' } as any)} />}
      {tab === 'threads' && <>
      {needs.length > 0 && <section className="card"><h4>Needs you / running</h4>{needs.map(row)}</section>}
      {prs.length > 0 && <section className="card"><h4>Open PRs</h4><div className="row-flex">{prs.map(p => <PrBadge key={p.url} pr={p} full />)}</div></section>}
      <section className="card"><h4>Threads · {rest.length}</h4>{rest.map(row)}{!rest.length && <div className="muted small">Nothing active.</div>}</section>
      {done.length > 0 && <details className="card"><summary className="muted small">{done.length} done or archived</summary>{done.map(row)}</details>}
      </>}
    </div>
  )
}

function FolderEditor({ f, onDone }: { f: Folder; onDone: () => void }) {
  const [v, setV] = useState({ name: f.name, icon: f.icon ?? '📁', description: f.description ?? '', query: f.query ?? '', cwd: f.cwd ?? '' })
  return (
    <div className="card editor">
      <label className="field">Name <input value={v.icon} style={{ width: 44 }} onChange={e => setV({ ...v, icon: e.target.value })} /><input className="wide" value={v.name} onChange={e => setV({ ...v, name: e.target.value })} /></label>
      <label className="field">About <input className="wide" value={v.description} onChange={e => setV({ ...v, description: e.target.value })} /></label>
      <label className="field">Also include matches for <input className="wide" value={v.query} placeholder={`#${f.label} (default), or e.g. #${f.label} repo:charts`} onChange={e => setV({ ...v, query: e.target.value })} /></label>
      <label className="field">New chats start in <input className="wide" value={v.cwd} placeholder="default folder" onChange={e => setV({ ...v, cwd: e.target.value })} /></label>
      <div className="row-flex">
        <button className="primary" onClick={async () => { await post('/api/folders', { id: f.id, ...v }); onDone() }}>Save</button>
        <button onClick={onDone}>Cancel</button>
        <span className="grow" />
        <button className="bad" onClick={async () => { await api.send('DELETE', `/api/folders/${f.id}`); location.hash = '#home' }}>Delete folder</button>
      </div>
    </div>
  )
}

export async function newFolder(name: string) { return post<{ id: string }>('/api/folders', { name }) }
