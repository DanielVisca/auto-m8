// The writing docs list (Home card and #writing). Kept apart from the editor so Home never loads CodeMirror.
import { useEffect, useState } from 'react'
import { post, useLive } from './api'
import './writing.css'

type Doc = { id: string; path: string; title: string; status: 'draft' | 'final'; agent_text: 'allowed' | 'blocked'; updated_at: number; open_comments?: number }
const ago = (t: number) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(t).toLocaleDateString() }

export function WritingList({ onOpen, limit }: { onOpen: (id: string) => void; limit?: number }) {
  const { data } = useLive<{ docs: Doc[]; dir: string }>('/api/docs', ['docs'])
  // The full list page (not the Home card): load the editor and its grammar checker while you pick a doc.
  useEffect(() => { if (limit) return; const t = setTimeout(() => import('./Writing').then(m => m.warmWriting()).catch(() => {}), 300); return () => clearTimeout(t) }, [limit])
  const [path, setPath] = useState('')
  const open = async (body: any) => { const d = await post<Doc & { error?: string }>('/api/docs', body); if (d?.id) onOpen(d.id) }
  const docs = (data?.docs ?? []).slice(0, limit ?? 50)
  return (
    <div className="writing-list">
      <div className="row-flex">
        <button className="primary" onClick={() => open({ title: 'Untitled' })}>+ New doc</button>
        <input className="grow" value={path} placeholder="Open a .md file: ~/path/to/file.md" onChange={e => setPath(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && path.trim()) open({ path: path.trim() }) }} />
        <button disabled={!path.trim()} onClick={() => open({ path: path.trim() })}>Open</button>
      </div>
      {docs.length === 0 && <div className="muted small">No docs yet. New docs go in {data?.dir ?? '~/Documents/auto-m8'}; any markdown file opens too.</div>}
      {docs.map(d => (
        <button key={d.id} className="writing-row" onClick={() => onOpen(d.id)} title={d.path}>
          <span className="grow ellipsis"><b>{d.title || 'Untitled'}</b> <span className="muted small">{d.path.replace(/^\/Users\/[^/]+/, '~')}</span></span>
          {d.agent_text === 'blocked' && <span className="chip small" title="Agents may comment and research, not write">✍ yours only</span>}
          <span className={`chip small ${d.status}`}>{d.status}</span>
          {!!d.open_comments && <span className="muted small">💬 {d.open_comments}</span>}
          <span className="muted small">{ago(d.updated_at)}</span>
        </button>
      ))}
    </div>
  )
}

