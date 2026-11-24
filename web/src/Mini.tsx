// Picture in picture: perch shrunk to a small always-on-top window that follows you across
// desktops and over full-screen apps. With a conversation open it shows that one live (what it's
// doing, its latest reply, a reply box); otherwise what's running and what needs you.
import { useEffect, useRef, useState } from 'react'
import { ago, post, sendChat, shell, titleOf, useLive, type Conversation, type Item } from './api'
import { Chat, isLong, Markdown, shrink, sniff, toBase64, useDraft } from './Chat'
import { SideList } from './List'

// It opens as a slim pill: what's running, what needs you, and an ask box. Opening or starting a
// chat grows it into the card for that conversation; going back from the chat shrinks it again.
// The side panel (↕) is the same window grown into a tall chat column you keep beside your work:
// the whole conversation and the full reply box, not just the latest reply.
export function Mini({ id, pill, panel, onOpen, onExpand }: { id: string | null; pill: boolean; panel?: boolean; onOpen: (id: string) => void; onExpand: () => void }) {
  const first = useRef(true)
  useEffect(() => { if (first.current) { first.current = false; return } if (id && !panel) shell.miniSize?.('card') }, [id]) // eslint-disable-line
  const back = () => { onOpen(''); if (!panel) shell.miniSize?.('pill') }
  const toPanel = shell.onMiniSize ? () => shell.miniSize?.('panel') : undefined
  if (pill && !panel) return <Pill onOpen={id => { onOpen(id); shell.miniSize?.('card') }} onExpand={onExpand} onPanel={toPanel} />
  if (panel) return (
    <MiniDrop id={id} onOpen={onOpen}>
      {id ? <PanelChat id={id} onOpen={onOpen} onBack={back} onExpand={onExpand} />
        : <PanelList onOpen={onOpen} onExpand={onExpand} />}
    </MiniDrop>
  )
  return (
    <MiniDrop id={id} onOpen={onOpen}>
      {id ? <MiniChat id={id} onExpand={onExpand} onBack={back} onPanel={toPanel} /> : <MiniFeed onOpen={onOpen} onExpand={onExpand} onShrink={() => shell.miniSize?.('pill')} onPanel={toPanel} />}
    </MiniDrop>
  )
}

function PanelChat({ id, onOpen, onBack, onExpand }: { id: string; onOpen: (id: string) => void; onBack: () => void; onExpand: () => void }) {
  const { data: c } = useLive<Conversation>(`/api/conversations/${encodeURIComponent(id)}`, ['conversations'])
  const { data: settings } = useLive<any>('/api/settings', ['settings'])
  return (
    <>
      <Head title={c ? titleOf(c) : '…'} dot={c?.effective} onExpand={onExpand} onBack={onBack} onPanel={() => shell.miniSize?.('card')} panelOn />
      <div className="panel-chat">
        <Chat key={id} id={id} onOpen={onOpen} onTerminal={() => {}} settings={settings} compact panel detailsOpen={false} onToggleDetails={() => {}} />
      </div>
    </>
  )
}

// The side panel with no chat open: your list as in the full window's sidebar (pinned, recent,
// needs you, working, by work). Click one to open it here; ‹ in its header comes back to this.
function PanelList({ onOpen, onExpand }: { onOpen: (id: string) => void; onExpand: () => void }) {
  const { data } = useLive<{ needsMe: Conversation[]; running: Conversation[] }>('/api/home', ['conversations', 'home'])
  const [q, setQ] = useDraft(null)
  const ask = async () => { if (!q.trim()) return; const p = q.trim(); setQ(''); const r = await sendChat<{ id: string }>({ prompt: p }); onOpen(r.id) }
  const running = data?.running?.length ?? 0, needs = data?.needsMe?.length ?? 0
  return (
    <>
      <Head title={`${running} running · ${needs} need you`} onExpand={onExpand} onPanel={() => shell.miniSize?.('pill')} panelOn />
      <div className="mini-body panel-list"><SideList onOpen={onOpen} onSearch={() => onExpand()} /></div>
      <input className="mini-input no-drag" value={q} placeholder="Ask Claude…" onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') ask() }} />
    </>
  )
}

function Pill({ onOpen, onExpand, onPanel }: { onOpen: (id: string) => void; onExpand: () => void; onPanel?: () => void }) {
  const { data } = useLive<{ needsMe: Conversation[]; running: Conversation[] }>('/api/home', ['conversations', 'home'])
  const [q, setQ] = useDraft(null)
  const running = data?.running?.length ?? 0, needs = data?.needsMe?.length ?? 0
  const ask = async () => { if (!q.trim()) return; const p = q.trim(); setQ(''); const r = await sendChat<{ id: string }>({ prompt: p }); onOpen(r.id) }
  return (
    <div className="mini-pill drag" onDoubleClick={e => { if (e.target === e.currentTarget) onExpand() }}>
      <button className="pill-count no-drag" onClick={() => onOpen('')} title={`${running} running · ${needs} need you: show them`}>
        <span className="dot s-running" />{running}<span className="dot s-waiting" />{needs}
      </button>
      <input className="pill-input no-drag" value={q} placeholder="Ask Claude…" onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') ask() }} />
      {onPanel && <button className="icon no-drag" onClick={onPanel} title="Open as a side panel: the chat in a tall column you can drag anywhere">↕</button>}
      {shell.tuck && <button className="icon no-drag" onClick={() => shell.tuck?.(true)} title="Tuck into the edge of the screen  ⌘⇧.">⇥</button>}
      <button className="icon no-drag expand" onClick={onExpand} title="Back to the full window  ⌘⇧M">⤢</button>
    </div>
  )
}

// Tucked into the edge of the screen: a small tab that brings perch back out, with what needs you.
export function Tab() {
  const { data } = useLive<{ needsMe: Conversation[]; running: Conversation[] }>('/api/home', ['conversations', 'home'])
  const needs = data?.needsMe?.length ?? 0, running = data?.running?.length ?? 0
  // Which edge we're on (the arrow points back onto the screen), and how far the window hangs off
  // it: the shell pushes the tab partly off screen so it sits flush, so pad the visible part.
  const sx = screen as any, L = sx.availLeft ?? 0, T = sx.availTop ?? 0
  const side = innerHeight > innerWidth
  const edge = side ? (screenX + innerWidth / 2 < L + screen.availWidth / 2 ? 'left' : 'right') : (screenY + innerHeight / 2 < T + screen.availHeight / 2 ? 'top' : 'bottom')
  const over = Math.max(0, edge === 'left' ? L - screenX : edge === 'right' ? screenX + innerWidth - (L + screen.availWidth) : edge === 'bottom' ? screenY + innerHeight - (T + screen.availHeight) : 0)
  const pad = { left: { paddingLeft: over }, right: { paddingRight: over }, bottom: { paddingBottom: over }, top: {} }[edge]
  return (
    <button className={`tuck-tab ${edge}`} style={pad} onClick={() => shell.tuck?.(false)} title={`Bring auto-m8 back · ${running} running · ${needs} need you  ⌘⇧.`}>
      <span className="tuck-arrow">{{ left: '›', right: '‹', top: '⌄', bottom: '⌃' }[edge]}</span>
      {needs > 0 && <span className="tuck-n">{needs}</span>}
      {running > 0 && <i className="spin" />}
    </button>
  )
}

// Drop things on the mini window (a Slack conversation, a link, an image or file, selected text) and
// they're added to the conversation it's showing, or your most recent one. They wait as chips with
// a note box until you press Enter, so you can say what you want done with them.
type Drop = { key: string; label: string; kind: 'link' | 'slack' | 'text' | 'file' | 'image'; context?: string; url?: string; file?: any; busy?: boolean; failed?: string }
const SLACK = /^https:\/\/[\w-]+\.slack\.com\/archives\/\S+/
function MiniDrop({ id, onOpen, children }: { id: string | null; onOpen: (id: string) => void; children: React.ReactNode }) {
  const { data: side } = useLive<any>(id ? null : '/api/sidebar', ['conversations'])
  const target: { id: string; title: string } | null = id ? { id, title: '' } : side?.now?.[0] ? { id: side.now[0].id, title: titleOf(side.now[0]) } : null
  const [items, setItems] = useState<Drop[]>([])
  const [note, setNote] = useState('')
  const [over, setOver] = useState(false)
  const update = (key: string, patch: Partial<Drop>) => setItems(xs => xs.map(x => x.key === key ? { ...x, ...patch } : x))
  const upload = async (key: string, f: Blob, name: string, kind: 'image' | 'file', text?: string) => {
    try {
      const r = await post<any>('/api/attachments', text != null ? { name, text } : { name, base64: await toBase64(f) })
      if (r.error) throw new Error(r.error)
      update(key, { busy: false, file: { path: r.path, name, kind, media_type: f.type, bytes: r.bytes, lines: r.lines } })
    } catch (e: any) { update(key, { busy: false, failed: e.message ?? 'couldn’t attach it' }) }
  }
  const drop = async (dt: DataTransfer) => {
    const k = () => Math.random().toString(36).slice(2)
    const files = [...(dt.files ?? [])]
    for (const f of files.slice(0, 10)) {
      const key = k(), image = /^image\//.test(f.type)
      setItems(xs => [...xs, { key, label: f.name || 'image', kind: image ? 'image' : 'file', busy: true }])
      image ? shrink(f).then(b => upload(key, b, f.name || `image-${Date.now()}.png`, 'image')) : upload(key, f, f.name, 'file')
    }
    if (files.length) return
    const uris = (dt.getData('text/uri-list') || '').split(/\r?\n/).filter(u => /^https?:/.test(u))
    const text = (dt.getData('text/plain') || '').trim()
    const urls = uris.length ? uris : (text.match(/https?:\/\/\S+/g) ?? [])
    if (urls.length && (uris.length || text.split(/\s+/).length <= urls.length)) {
      for (const url of [...new Set(urls)].slice(0, 6)) {
        const key = k()
        // Slack needs your login: the agent opens it with its Slack tools instead of perch fetching it.
        if (SLACK.test(url)) { setItems(xs => [...xs, { key, label: 'Slack conversation', kind: 'slack', url, context: `A Slack conversation the user shared: ${url}\nRead the whole thread with the Slack tools (slack_read_thread) before answering.` }]); continue }
        setItems(xs => [...xs, { key, label: url.replace(/^https?:\/\//, '').slice(0, 50), kind: 'link', url, busy: true }])
        post<any>('/api/enrich', { url }).then(r => update(key, r.error ? { busy: false, context: url } : { busy: false, label: String(r.title ?? url).slice(0, 50), context: r.context ?? url }))
      }
      return
    }
    if (!text) return
    const key = k()
    if (isLong(text)) {
      setItems(xs => [...xs, { key, label: `${text.split('\n').length} lines of text`, kind: 'text', busy: true }])
      upload(key, new Blob([text], { type: 'text/plain' }), `pasted-${Date.now()}.${sniff(text)}`, 'file', text)
    } else setItems(xs => [...xs, { key, label: `“${text.slice(0, 40)}${text.length > 40 ? '…' : ''}”`, kind: 'text', context: `Selected text the user shared:\n> ${text.replace(/\n/g, '\n> ')}` }])
  }
  const send = async () => {
    if (!target || items.some(x => x.busy)) return
    const files = items.filter(x => x.file).map(x => x.file)
    const shared = items.filter(x => !x.file && x.context).map(x => ({ title: x.label, summary: '', context: x.context, url: x.url }))
    const prompt = note.trim() || `(see the ${items.length === 1 ? 'item' : `${items.length} items`} I added)`
    setItems([]); setNote('')
    await sendChat({ id: target.id, prompt, shared, attachments: files })
    if (!id) onOpen(target.id)
  }
  return (
    <div className={`mini${over ? ' drop-over' : ''}`}
      onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={e => { if (e.currentTarget === e.target) setOver(false) }}
      onDrop={e => { e.preventDefault(); setOver(false); drop(e.dataTransfer) }}>
      {children}
      {over && <div className="mini-drop-hint">{target ? `Drop to add to ${target.title ? `“${target.title.slice(0, 40)}”` : 'this conversation'}` : 'Open a conversation first'}</div>}
      {items.length > 0 && (
        <div className="mini-tray no-drag">
          <div className="mini-tray-items">
            {items.map(x => <span key={x.key} className={`chip shared${x.failed ? ' failed' : ''}`} title={x.failed ?? x.url ?? x.label}>
              {x.busy ? '…' : { slack: '💬', link: '🔗', text: '❝', file: '📄', image: '🖼' }[x.kind]} {x.label}
              <button onClick={() => setItems(xs => xs.filter(y => y.key !== x.key))}>×</button></span>)}
          </div>
          <input className="mini-input" autoFocus value={note} placeholder={`Add a note, then Enter${target?.title ? ` → ${target.title.slice(0, 24)}` : ''}`} onChange={e => setNote(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') send(); if (e.key === 'Escape') { setItems([]); setNote('') } }} />
        </div>
      )}
    </div>
  )
}

// In the side panel the ↕ that opened it stays lit and collapses it back to the small window.
function Head({ title, dot, onExpand, onBack, onShrink, onPanel, panelOn }: { title: string; dot?: string; onExpand: () => void; onBack?: () => void; onShrink?: () => void; onPanel?: () => void; panelOn?: boolean }) {
  return (
    <div className="mini-head drag" onDoubleClick={onExpand}>
      {onBack && <button className="icon no-drag" onClick={onBack} title="Back to your chats">‹</button>}
      {dot && <span className={`dot s-${dot}`} />}
      <b className="grow ellipsis">{title}</b>
      {onShrink && !panelOn && <button className="icon no-drag" onClick={onShrink} title="Shrink to the slim bar">–</button>}
      {onPanel && (panelOn
        ? <button className="icon no-drag on" onClick={onPanel} title="Collapse the side panel back to the small window">↕</button>
        : <button className="icon no-drag" onClick={onPanel} title="Open as a side panel: the whole chat in a tall column">↕</button>)}
      {shell.tuck && <button className="icon no-drag" onClick={() => shell.tuck?.(true)} title="Tuck into the edge of the screen  ⌘⇧.">⇥</button>}
      <button className="icon no-drag expand" onClick={onExpand} title="Back to the full window  ⌘⇧M (or double-click here)">⤢</button>
    </div>
  )
}

// Also the body of a chat tile on a canvas (bare: the tile draws its own header).
export function MiniChat({ id, onExpand, onBack, onPanel, bare, readOnly }: { id: string; onExpand?: () => void; onBack?: () => void; onPanel?: () => void; bare?: boolean; readOnly?: string }) {
  const { data: c } = useLive<Conversation>(`/api/conversations/${encodeURIComponent(id)}`, ['conversations', 'chats'])
  const { data: m, reload } = useLive<{ items: Item[] }>(`/api/conversations/${encodeURIComponent(id)}/messages`, ['chats', 'conversations'])
  const [text, setText] = useDraft(id) // same draft as the full window's box for this chat
  const running = c?.effective === 'running'
  // The transcript grows during a turn; follow it while it runs.
  useEffect(() => { if (!running) return; const t = setInterval(reload, 2500); return () => clearInterval(t) }, [running]) // eslint-disable-line
  const items = m?.items ?? []
  const lastAssistant = [...items].reverse().find(i => i.kind === 'assistant') as Extract<Item, { kind: 'assistant' }> | undefined
  const reply = lastAssistant?.blocks.filter(b => b.type === 'text').map((b: any) => b.text).join('\n') ?? ''
  const lastTool = running ? [...(lastAssistant?.blocks ?? [])].reverse().find(b => b.type === 'tool') as any : null
  const lastUser = [...items].reverse().find(i => i.kind === 'user') as any
  const send = async () => { if (!text.trim()) return; const t = text.trim(); setText(''); await sendChat({ id, prompt: t }); reload() }
  return (
    <>
      {!bare && <Head title={c ? titleOf(c) : '…'} dot={c?.effective} onExpand={onExpand!} onBack={onBack} onPanel={onPanel} />}
      <div className="mini-body">
        {lastUser && <div className="muted small ellipsis">You: {lastUser.text}</div>}
        {running && <div className="small mini-now"><i className="spin" /> {lastTool ? `${lastTool.name}${toolLine(lastTool) ? `: ${toolLine(lastTool)}` : ''}` : 'thinking…'}</div>}
        {reply ? <div className="mini-reply"><Markdown text={reply.length > 1500 ? '…' + reply.slice(-1500) : reply} /></div> : !running && <div className="muted small">No reply yet.</div>}
      </div>
      {readOnly ? <div className="muted small mini-readonly">{readOnly}</div>
        : <input className="mini-input no-drag" value={text} placeholder={running ? 'Queue a follow-up…' : 'Reply…'} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') send() }} />}
    </>
  )
}

function MiniFeed({ onOpen, onExpand, onShrink, onPanel, panelOn, limit = 5 }: { onOpen: (id: string) => void; onExpand: () => void; onShrink: () => void; onPanel?: () => void; panelOn?: boolean; limit?: number }) {
  const { data } = useLive<{ needsMe: Conversation[]; running: Conversation[] }>('/api/home', ['conversations', 'home'])
  const [q, setQ] = useDraft(null) // carries over to the new-chat box when you expand
  const running = data?.running ?? [], needs = data?.needsMe ?? []
  const ask = async () => { if (!q.trim()) return; const p = q.trim(); setQ(''); const r = await sendChat<{ id: string }>({ prompt: p }); onOpen(r.id) }
  return (
    <>
      <Head title={`${running.length} running · ${needs.length} need you`} onExpand={onExpand} onShrink={onShrink} onPanel={onPanel} panelOn={panelOn} />
      <div className="mini-body">
        {!running.length && !needs.length && <div className="muted small">All quiet.</div>}
        {running.slice(0, limit - 1).map(c => <button key={c.id} className="mini-line" onClick={() => onOpen(c.id)}><i className="spin" /><span className="grow ellipsis">{titleOf(c)}</span><span className="muted small">{ago(c.updated_at)}</span></button>)}
        {needs.slice(0, limit).map(c => <button key={c.id} className="mini-line" onClick={() => onOpen(c.id)}><span className="dot s-waiting" /><span className="grow ellipsis">{titleOf(c)}</span><span className="muted small ellipsis mini-why">{(c as any).reason ?? ''}</span></button>)}
      </div>
      <input className="mini-input no-drag" value={q} placeholder="Ask Claude…" onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') ask() }} />
    </>
  )
}

const toolLine = (b: any) => String(b.input?.description ?? b.input?.command ?? b.input?.file_path ?? b.input?.pattern ?? b.input?.query ?? '').slice(0, 80)
