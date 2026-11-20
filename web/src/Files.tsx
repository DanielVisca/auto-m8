// Files an agent made for you: listed per conversation, viewable in perch, and one click from
// Finder, your clipboard (the contents, or the file itself to paste into Slack) or a download.
import { useEffect, useState } from 'react'
import { api, post, shell, toast, useLive } from './api'
import { copyText, Markdown } from './Chat'

export type FileRef = { path: string; name: string; size: number; mtime: number; kind: 'text' | 'image' | 'video' | 'pdf' | 'archive' | 'other'; how?: string }
const ICON = { text: '📄', image: '🖼', video: '🎬', pdf: '📕', archive: '🗜', other: '📦' }
const size = (n: number) => n < 1024 ? `${n} B` : n < 1 << 20 ? `${Math.round(n / 1024)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`
const raw = (p: string, download = false) => `/api/files/raw?path=${encodeURIComponent(p)}${download ? '&download=1' : ''}`
const act = (path: string, action: string, done: string) => post<any>('/api/files/action', { path, action }).then(r => { if (!r?.error) toast(done, { kind: 'ok' }) })

export const openFile = (path: string) => window.dispatchEvent(new CustomEvent('perch-file', { detail: path }))

// The right panel's list.
export function FilesSection({ id }: { id: string }) {
  const { data } = useLive<{ files: FileRef[] }>(`/api/conversations/${encodeURIComponent(id)}/files`, ['conversations', 'chats'])
  const [all, setAll] = useState(false)
  const files = data?.files ?? []
  if (!files.length) return null
  return (
    <section>
      <h4>Files <span className="muted small">{files.length}</span></h4>
      {(all ? files : files.slice(0, 6)).map(f => <FileRow key={f.path} f={f} />)}
      {files.length > 6 && <button className="link small" onClick={() => setAll(!all)}>{all ? 'show fewer' : `all ${files.length}`}</button>}
    </section>
  )
}

function FileRow({ f }: { f: FileRef }) {
  return (
    <div className="file-row">
      <button className="file-main" onClick={() => openFile(f.path)} title={`${f.path}\nClick to view`}>
        <span className="file-icon">{ICON[f.kind]}</span>
        <span className="grow ellipsis">{f.name}</span>
        <span className="muted small nowrap">{size(f.size)}</span>
      </button>
      <FileActions f={f} compact />
    </div>
  )
}

function FileActions({ f, compact }: { f: FileRef; compact?: boolean }) {
  const copyContents = async () => { const t = await fetch(raw(f.path)).then(r => r.text()); if (await copyText(t)) toast(`Copied ${f.name}`, { kind: 'ok' }) }
  return (
    <span className={`file-actions${compact ? ' compact' : ''}`}>
      {f.kind === 'text' && f.size < 2e6 && <button className="icon" onClick={copyContents} title="Copy its contents">⧉</button>}
      {shell.isElectron && <button className="icon" onClick={() => act(f.path, 'copy-file', `${f.name} is on your clipboard: paste it into Slack, Mail or Finder`)} title="Copy the file itself (paste into Slack, Mail, Finder)">📎</button>}
      {shell.isElectron && <button className="icon" onClick={() => act(f.path, 'reveal', 'Shown in Finder')} title="Show in Finder">⌕</button>}
      {!compact && shell.isElectron && <button className="icon" onClick={() => act(f.path, 'open', 'Opened')} title="Open in its app">↗</button>}
      <a className="icon" href={raw(f.path, true)} download={f.name} title="Download">⤓</a>
      {!compact && <button className="icon" onClick={() => copyText(f.path).then(() => toast('Path copied', { kind: 'ok' }))} title="Copy the path">⌁</button>}
    </span>
  )
}

// One viewer for the whole app: opened from the panel or by clicking a path in a reply.
export function FileViewer() {
  const [f, setF] = useState<FileRef | null>(null)
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    const on = async (e: Event) => {
      const path = (e as CustomEvent).detail as string
      const r = await api.get<{ file: FileRef | null }>(`/api/files/check?path=${encodeURIComponent(path)}`)
      if (!r.file) return toast('That file isn’t there any more, or isn’t one a conversation made.')
      setText(null); setF(r.file)
      if (r.file.kind === 'text') setText(r.file.size > 2e6 ? null : await fetch(raw(r.file.path)).then(x => x.text()))
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setF(null) }
    addEventListener('perch-file', on); addEventListener('keydown', esc)
    return () => { removeEventListener('perch-file', on); removeEventListener('keydown', esc) }
  }, [])
  if (!f) return null
  return (
    <div className="file-viewer-back" onClick={() => setF(null)}>
      <div className="file-viewer" onClick={e => e.stopPropagation()}>
        <div className="file-viewer-head">
          <span className="file-icon">{ICON[f.kind]}</span>
          <b className="grow ellipsis" title={f.path}>{f.name}</b>
          <span className="muted small nowrap">{size(f.size)}</span>
          <FileActions f={f} />
          <button className="icon" onClick={() => setF(null)} title="Close (Esc)">×</button>
        </div>
        <div className="muted small ellipsis file-viewer-path" title={f.path}>{f.path}</div>
        <div className="file-viewer-body">
          {f.kind === 'image' && <img src={raw(f.path)} alt={f.name} />}
          {f.kind === 'video' && <video src={raw(f.path)} controls autoPlay playsInline />}
          {f.kind === 'pdf' && <iframe src={raw(f.path)} title={f.name} />}
          {f.kind === 'text' && (text == null ? <div className="muted small pad">{f.size > 2e6 ? 'Too big to show here: download it or open it in its app.' : 'Loading…'}</div>
            : /\.(md|markdown)$/i.test(f.name) ? <div className="pad"><Markdown text={text} /></div> : <pre className="file-text">{text}</pre>)}
          {(f.kind === 'archive' || f.kind === 'other') && <div className="pad muted">perch can’t show this kind of file. Download it, copy it to your clipboard, or show it in Finder.</div>}
        </div>
      </div>
    </div>
  )
}
