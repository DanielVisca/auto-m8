// Files an agent made for you: listed per conversation, viewable in perch, and one click from
// Finder, your clipboard (the contents, or the file itself to paste into Slack) or a download.
import { useEffect, useRef, useState } from 'react'
import { CustomizeItem } from './Layout'
import { api, post, shell, toast, useLive } from './api'
import { copyText, focusInChat, Markdown, type FocusAt } from './Chat'
import { Brand } from './Brand'

export type FileRef = { path: string; name: string; size: number; mtime: number; kind: 'text' | 'image' | 'video' | 'pdf' | 'archive' | 'other'; how?: string; uses?: (FocusAt & { how: string })[] }
const ICON = { text: '📄', image: '🖼', video: '🎬', pdf: '📕', archive: '🗜', other: '📦' }
const size = (n: number) => n < 1024 ? `${n} B` : n < 1 << 20 ? `${Math.round(n / 1024)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`
const raw = (p: string, download = false) => `/api/files/raw?path=${encodeURIComponent(p)}${download ? '&download=1' : ''}`
const act = (path: string, action: string, done: string) => post<any>('/api/files/action', { path, action }).then(r => r?.error ? toast(String(r.error)) : toast(done, { kind: 'ok' }), () => {})
// Finder lives on the Mac running auto-m8: offer it in the app, or in a browser on this Mac.
const onMac = () => !!shell.isElectron || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
// Paths with an extension are files; without one, treat it as a folder (Show in Finder works for both).
const looksLikeFile = (p: string) => /\.[A-Za-z0-9]{1,8}$/.test(p)

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
      {(all ? files : files.slice(0, 6)).map(f => <FileRow key={f.path} f={f} convId={id} />)}
      {files.length > 6 && <button className="link small" onClick={() => setAll(!all)}>{all ? 'show fewer' : `all ${files.length}`}</button>}
    </section>
  )
}

// The first couple of KB of a text file, fetched once per version (byte range, so big logs stay cheap).
const heads = new Map<string, Promise<string>>()
const textHead = (f: FileRef) => {
  const k = `${f.path}@${f.mtime}`
  if (!heads.has(k)) heads.set(k, fetch(raw(f.path), { headers: { Range: 'bytes=0-4095' } }).then(r => r.ok ? r.text() : '').catch(() => ''))
  return heads.get(k)!
}
function useTextHead(f: FileRef, on: boolean) {
  const [t, setT] = useState<string | null>(null)
  useEffect(() => { if (on && f.kind === 'text') { let live = true; textHead(f).then(x => { if (live) setT(x) }); return () => { live = false } } }, [f.path, f.mtime, on])
  return t
}
const firstLine = (t: string) => (t.split('\n').map(l => l.replace(/^[#>*\-\s`|]+/, '').trim()).find(Boolean) ?? '').slice(0, 140)

// Small always-on preview: the image or video frame itself, or a few lines of text.
function Thumb({ f, text }: { f: FileRef; text: string | null }) {
  if (f.kind === 'image') return <span className="file-thumb"><img src={raw(f.path)} alt="" loading="lazy" /></span>
  if (f.kind === 'video') return <span className="file-thumb"><video src={`${raw(f.path)}#t=0.5`} preload="metadata" muted playsInline /></span>
  if (f.kind === 'text' && text) return <span className="file-thumb text"><span>{text.slice(0, 240)}</span></span>
  return <span className="file-thumb icon">{ICON[f.kind]}</span>
}

// Bigger preview while hovering a row, floated beside the panel.
function HoverPreview({ f, text, at }: { f: FileRef; text: string | null; at: DOMRect }) {
  const w = 340
  const left = at.left - w - 10 > 8 ? at.left - w - 10 : Math.min(at.right + 10, innerWidth - w - 8)
  const top = Math.max(8, Math.min(at.top - 40, innerHeight - 300))
  return (
    <div className="file-hover" style={{ left, top, width: w }}>
      {f.kind === 'image' && <img src={raw(f.path)} alt={f.name} />}
      {f.kind === 'video' && <video src={raw(f.path)} autoPlay muted loop playsInline />}
      {f.kind === 'text' && <pre>{text == null ? 'Loading…' : text.split('\n').slice(0, 40).join('\n') || '(empty)'}</pre>}
      {f.kind === 'pdf' && <div className="muted small pad">PDF: click to open it in the viewer.</div>}
      <div className="file-hover-name muted small ellipsis">{f.name} · {size(f.size)}</div>
    </div>
  )
}

// Bring the chat to where a file came up: opens that chat if another view is showing, then the folds.
const showInChat = (convId: string, at: FocusAt) => {
  const want = `#chat/${encodeURIComponent(convId)}`
  if (location.hash !== want) location.hash = want
  focusInChat(convId, at)
}
const clock = (t?: number) => t ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''

function FileRow({ f, convId }: { f: FileRef; convId: string }) {
  const [usesOpen, setUsesOpen] = useState(false)
  const uses = f.uses ?? []
  const ref = useRef<HTMLButtonElement>(null)
  const [hover, setHover] = useState<DOMRect | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const text = useTextHead(f, true)
  const enter = () => { clearTimeout(timer.current); timer.current = window.setTimeout(() => ref.current && setHover(ref.current.getBoundingClientRect()), 250) }
  const leave = () => { clearTimeout(timer.current); setHover(null) }
  useEffect(() => () => clearTimeout(timer.current), [])
  const sub = f.kind === 'text' && text ? firstLine(text) : ''
  return (
    <div className="file-row" data-path={f.path}>
      <button ref={ref} className="file-main" onClick={() => { leave(); openFile(f.path) }} onMouseEnter={enter} onMouseLeave={leave} title={`${f.path}\nClick to view`}>
        <Thumb f={f} text={text} />
        <span className="grow file-names">
          <span className="ellipsis">{f.name}</span>
          <span className="muted small ellipsis">{sub || size(f.size)}</span>
        </span>
        {sub && <span className="muted small nowrap">{size(f.size)}</span>}
      </button>
      {uses.length > 0 && <button className="icon file-jump" title={uses.length === 1 ? `Show where it was ${uses[0].how} in the chat` : `Show where it came up in the chat (${uses.length} places)`}
        onClick={() => uses.length === 1 ? showInChat(convId, uses[0]) : setUsesOpen(v => !v)}>↥{uses.length > 1 && <sup>{uses.length}</sup>}</button>}
      <FileActions f={f} compact />
      {usesOpen && <div className="file-uses">{uses.map((u, i) =>
        <button key={i} className="link small" onClick={() => showInChat(convId, u)}>{u.how}{u.ts ? ` · ${clock(u.ts)}` : ''}</button>)}</div>}
      {hover && f.kind !== 'archive' && f.kind !== 'other' && <HoverPreview f={f} text={text} at={hover} />}
    </div>
  )
}

function FileActions({ f, compact }: { f: FileRef; compact?: boolean }) {
  const copyContents = async () => { const t = await fetch(raw(f.path)).then(r => r.text()); if (await copyText(t)) toast(`Copied ${f.name}`, { kind: 'ok' }) }
  return (
    <span className={`file-actions${compact ? ' compact' : ''}`}>
      {f.kind === 'text' && f.size < 2e6 && <button className="icon" onClick={copyContents} title="Copy its contents">⧉</button>}
      {/\.(md|markdown|mdx|txt)$/i.test(f.path) && <button className="icon" title="Edit in auto-m8's writing editor: comments, research, versions" onClick={async () => { const d = await post<{ id?: string }>('/api/docs', { path: f.path }); if (d?.id) { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); location.hash = `#doc/${d.id}` } }}>✎</button>}
      {shell.isElectron && <button className="icon" onClick={() => act(f.path, 'copy-file', `${f.name} is on your clipboard: paste it into Slack, Mail or Finder`)} title="Copy the file itself (paste into Slack, Mail, Finder)">📎</button>}
      {shell.isElectron && <button className="icon" onClick={() => act(f.path, 'reveal', 'Shown in Finder')} title="Show in Finder">⌕</button>}
      {!compact && shell.isElectron && <button className="icon" onClick={() => act(f.path, 'open', 'Opened')} title="Open in its app">↗</button>}
      <a className="icon" href={raw(f.path, true)} download={f.name} title="Download">⤓</a>
      {!compact && <button className="icon" onClick={() => copyText(f.path).then(() => toast('Path copied', { kind: 'ok' }))} title="Copy the path">⌁</button>}
    </span>
  )
}

// Right-click any file or folder path (anything with data-path: a path in a reply, a tool call, a
// file row, a chat's folder) for Show in Finder, Open, View and Copy path.
function PathMenu() {
  const [at, setAt] = useState<{ x: number; y: number; path: string; dir: boolean } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Capture on window so it wins over the message and list menus underneath.
    const on = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-path]') as HTMLElement | null
      const path = el?.dataset.path
      if (!path) return
      e.preventDefault(); e.stopPropagation()
      setAt({ x: e.clientX, y: e.clientY, path, dir: el!.dataset.dir === '1' || !looksLikeFile(path) })
    }
    addEventListener('contextmenu', on, true)
    return () => removeEventListener('contextmenu', on, true)
  }, [])
  useEffect(() => {
    if (!at) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setAt(null) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAt(null) }
    const t = setTimeout(() => addEventListener('mousedown', close), 0)
    addEventListener('keydown', esc); addEventListener('blur', () => setAt(null), { once: true })
    return () => { clearTimeout(t); removeEventListener('mousedown', close); removeEventListener('keydown', esc) }
  }, [at])
  if (!at) return null
  const go = (f: () => unknown) => () => { setAt(null); f() }
  const name = at.path.replace(/\/+$/, '').split('/').pop() || at.path
  return (
    <div className="ctx" ref={ref} style={{ left: Math.min(at.x, innerWidth - 240), top: Math.min(at.y, innerHeight - 170) }} onContextMenu={e => e.preventDefault()}>
      <div className="ctx-head ellipsis" title={at.path}>{at.dir ? '📁' : '📄'} {name}</div>
      {onMac() && <button onClick={go(() => act(at.path, 'reveal', 'Shown in Finder'))}><Brand id="finder" size={15} /> Show in Finder</button>}
      {onMac() && <button onClick={go(() => act(at.path, 'open', 'Opened'))}>↗ {at.dir ? 'Open folder' : 'Open in its app'}</button>}
      {!at.dir && <button onClick={go(() => openFile(at.path))}>👁 View in auto-m8</button>}
      <button onClick={go(() => copyText(at.path).then(() => toast('Path copied', { kind: 'ok' })))}>⌁ Copy path</button>
      <CustomizeItem onDone={() => setAt(null)} />
    </div>
  )
}

// One viewer for the whole app: opened from the panel or by clicking a path in a reply.
export function FileViewer() {
  return <><PathMenu /><FileViewerModal /></>
}
function FileViewerModal() {
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
        <div className="muted small ellipsis file-viewer-path" title={f.path} data-path={f.path}>{f.path}</div>
        <div className="file-viewer-body">
          {f.kind === 'image' && <img src={raw(f.path)} alt={f.name} />}
          {f.kind === 'video' && <video src={raw(f.path)} controls autoPlay playsInline />}
          {f.kind === 'pdf' && <iframe src={raw(f.path)} title={f.name} />}
          {f.kind === 'text' && (text == null ? <div className="muted small pad">{f.size > 2e6 ? 'Too big to show here: download it or open it in its app.' : 'Loading…'}</div>
            : /\.(md|markdown)$/i.test(f.name) ? <div className="pad"><Markdown text={text} /></div> : <pre className="file-text">{text}</pre>)}
          {(f.kind === 'archive' || f.kind === 'other') && <div className="pad muted">auto-m8 can’t show this kind of file. Download it, copy it to your clipboard, or show it in Finder.</div>}
        </div>
      </div>
    </div>
  )
}
