import { BoardPage, BoardsIndex, WithBoard } from './Boards'
import { PrList } from './PrList'
import { FileViewer } from './Files'
import { CarryDialog, ProfileSwitch } from './Profile'
import { PrPage, PrSide } from './PrPage'
import { Mini, Tab } from './Mini'
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, post, sendChat, shell, titleOf, useLive, type Conversation, type Term } from './api'
import { Ask } from './Ask'
import { Automations } from './Automations'
import { Home } from './Home'
import { NeedsMe } from './NeedsMe'
import { ContextMenu, useMenu } from './Menu'
import { FocusButton } from './Focus'
import { FolderList, FolderView, type Folder } from './Folders'
import { Search } from './Search'
import { Compare } from './Compare'
import { AskCard } from './Autopilot'
import { Boundary } from './Boundary'
import { EdgeHandle, Splitter, useColumnWidth } from './Splitter'
import { toast, useToasts } from './api'
import { Chat, forgetNewChatAttachments } from './Chat'
import { Details } from './Details'
import { DecisionFlag } from './Decisions'
import { ProdAlert } from './ProdAlert'
import { BrowserFlag } from './BrowserView'
import { Resources } from './Resources'
import { Insights } from './Insights'
import { Explore } from './Explore'
import { CanvasGallery, CodebaseGallery, CompetitorGallery, CompetitorPage, ExploreHub, LayoutsPage } from './ExploreHub'
import { Library } from './Library'
import { List } from './List'
import { Settings } from './Settings'
import { WritingHome } from './WritingHome'
const DocEditor = lazy(() => import('./Writing').then(m => ({ default: m.DocSplit })))
// Fetch and parse the editor's code once the app is idle, so the first doc you open doesn't wait on it.
// Only the code: Harper (grammar, 20 MB) starts from the docs list or the doc itself.
if (typeof window !== 'undefined') ((window as any).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 3000)))(() => { import('./Writing').catch(() => {}) }, { timeout: 8000 })
import { Paused, PauseBar, PauseButton } from './Paused'
import { TermView } from './Term'
import { CloudBar, Handoff, SimpleHome, usePresence, useSimple } from './Mobile'
import { LayoutTree, topLeftOf, UiAsk, UiButton, UiCustomizeMenu, UiDraftBar, useLayout, useLayoutColors, useLayoutCss, useLayoutCycle, useLayoutEscape, type Run } from './Layout'

type View =
  | { kind: 'chat'; id: string | null }
  | { kind: 'term'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'ask'; q: string }
  | { kind: 'search'; q: string; agent?: string }
  | { kind: 'folder'; id: string }
  | { kind: 'compare'; ids: string[] }
  | { kind: 'pr'; id: string }
  | { kind: 'board'; id: string | null }
  | { kind: 'explore'; id: string | null }
  | { kind: 'doc'; id: string }
  | { kind: 'home' | 'needs' | 'settings' | 'insights' | 'library' | 'automations' | 'evolve' | 'paused' | 'writing' }

// The layout follows the window, not a setting: drag it narrow and it becomes one column,
// drag it short and it becomes a single command bar.
type Mode = 'tab' | 'bar' | 'mini' | 'compact' | 'medium' | 'wide'
function modeFor(w: number, h: number, panel = false): Mode {
  if (w < 60 || h < 40) return 'tab' // tucked into the edge of the screen (side edges: narrow; top or bottom: short)
  if (panel && w < 700) return 'mini' // the side panel: tall, but still picture in picture
  if (w < 480 && h < 330) return 'mini' // picture in picture (the slim pill or the card)
  if (h < 150) return 'bar'
  if (w < 640) return 'compact'
  if (w < 1100) return 'medium'
  return 'wide'
}

function useSize() {
  const [size, setSize] = useState({ w: innerWidth, h: innerHeight })
  useLayoutEffect(() => {
    const f = () => setSize({ w: innerWidth, h: innerHeight })
    addEventListener('resize', f)
    return () => removeEventListener('resize', f)
  }, [])
  return size
}

function parseHash(): View {
  const [kind, id] = location.hash.slice(1).split('/')
  if (kind === 'chat') return { kind, id: id ? decodeURIComponent(id) : null }
  if ((kind === 'term' || kind === 'task') && id) return { kind, id: decodeURIComponent(id) }
  if (kind === 'ask' && id) return { kind: 'search', q: decodeURIComponent(id), agent: 'yes' }
  if (kind === 'search') return { kind, q: id ? decodeURIComponent(id) : '' }
  if (kind === 'folder' && id) return { kind, id: decodeURIComponent(id) }
  if (kind === 'compare' && id) return { kind, ids: decodeURIComponent(id).split(',') }
  if (kind === 'pr' && id) return { kind, id: decodeURIComponent(id) }
  if (kind === 'board') return { kind, id: id ? decodeURIComponent(id) : null }
  if (kind === 'doc' && id) return { kind, id: decodeURIComponent(id) }
  if (kind === 'explore') return { kind, id: id ? decodeURIComponent(id) : null }
  if (['settings', 'insights', 'library', 'automations', 'home', 'needs', 'evolve', 'paused', 'writing'].includes(kind)) return { kind } as View
  return { kind: 'home' }
}
const hashFor = (v: View) => '#' + v.kind + ('id' in v && v.id ? '/' + encodeURIComponent(v.id) : 'q' in v ? '/' + encodeURIComponent(v.q) : 'ids' in v ? '/' + encodeURIComponent(v.ids.join(',')) : '')

export function App() {
  const { w, h } = useSize()
  const [miniSize, setMiniSize] = useState<string>('none')
  useEffect(() => shell.onMiniSize?.(setMiniSize), [])
  const mode = modeFor(w, h, miniSize === 'panel')
  const [view, setViewState] = useState<View>(parseHash)
  // Compact: start on the page the link points at (Home after pairing), not the list.
  const [listOpen, setListOpen] = useState(() => !(innerWidth < 640 && location.hash.length > 1)) // compact: list vs view; medium: sidebar shown
  const [detailsOpen, setDetailsOpen] = useState(() => localStorage.getItem('perch.details') !== '0')
  const [routineDraft, setRoutineDraft] = useState<any>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [sideView, setSideView] = useState<'conversations' | 'prs'>(() => { try { return localStorage.getItem('perch.side') === 'prs' ? 'prs' : 'conversations' } catch { return 'conversations' } })
  const pickSide = (k: 'conversations' | 'prs') => { setSideView(k); try { localStorage.setItem('perch.side', k) } catch {} }
  const menu = useMenu()
  // Moving anywhere closes an open right-click menu.
  useEffect(() => { menu.close() }, [hashFor(view)]) // eslint-disable-line
  // Both side columns can be dragged wider or narrower; the main view always keeps 360px.
  const side = useColumnWidth('sidebar', 300, 220, Math.max(240, Math.min(560, w - 360)))
  const details = useColumnWidth('details', 320, 240, Math.max(260, Math.min(520, w - side.width - 380)))
  const { data: settings } = useLive<any>('/api/settings', ['settings'])
  const showDecisions = !!settings?.decisions?.askMe
  const { data: termData, reload: reloadTerms } = useLive<{ terms: Term[] }>('/api/terms', ['terms'])
  const terms = termData?.terms ?? []

  const setView = (v: View) => {
    setViewState(v)
    history.replaceState(null, '', hashFor(v))
    if (mode === 'compact') setListOpen(false)
  }
  useEffect(() => { const f = () => setViewState(parseHash()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f) }, [])
  // Phone: Simple mode by default (Advanced is everything else); every screen reports where it is for handoff.
  const [simple, setSimple, canSimple] = useSimple()
  usePresence(hashFor(view), '')
  const goHash = (hsh: string) => { location.hash = hsh; setViewState(parseHash()); if (mode === 'compact') setListOpen(false) }
  useEffect(() => { try { localStorage.setItem('perch.details', detailsOpen ? '1' : '0') } catch {} }, [detailsOpen])
  // The window's layout file (server/layout.ts): its tree, and a look that beats Settings.
  const layout = useLayout()
  useLayoutColors(layout?.layout.colors)
  useLayoutCss(layout?.css)
  useLayoutEscape()
  useLayoutCycle()
  // Theme: system, light or dark, on the page and on the window chrome.
  const zen = !!settings?.focus?.active
  const theme = layout?.layout.theme ?? settings?.ui?.theme ?? 'system'
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
    shell.theme?.(theme)
  }, [theme])
  useEffect(() => {
    const f = (e: Event) => openById((e as CustomEvent).detail)
    const r = (e: Event) => setView({ kind: 'search', q: (e as CustomEvent).detail, agent: 'deep' })
    const cmp = (e: Event) => setView({ kind: 'compare', ids: (e as CustomEvent).detail })
    const term = (e: Event) => setView({ kind: 'term', id: (e as CustomEvent).detail })
    addEventListener('perch-open-term', term)
    addEventListener('perch-compare', cmp)
    addEventListener('perch-open', f)
    addEventListener('perch-research', r)
    return () => { removeEventListener('perch-open-term', term); removeEventListener('perch-open', f); removeEventListener('perch-research', r); removeEventListener('perch-compare', cmp) }
  })
  // Traffic lights only where there is room for them.
  useEffect(() => { shell.buttons?.(mode === 'medium' || mode === 'wide') }, [mode])
  useEffect(() => { if (mode === 'compact' && view.kind === 'chat' && view.id) setListOpen(false) }, [mode]) // eslint-disable-line
  // Settings has its own tab panel, so the conversation sidebar folds away there (☰ or ⌘\ brings it back)
  // and comes back on its own when you leave, unless you had already hidden it.
  const settingsHid = useRef(false)
  useEffect(() => {
    if (mode === 'compact') return
    if (view.kind === 'settings') { if (listOpen) { settingsHid.current = true; setListOpen(false) } }
    else if (settingsHid.current) { settingsHid.current = false; setListOpen(true) }
  }, [view.kind]) // eslint-disable-line

  const openConversation = (c: Pick<Conversation, 'id' | 'source'>) => setView(c.source === 'posthog-task' ? { kind: 'task', id: c.id } : { kind: 'chat', id: c.id })
  const openById = (id: string) => openConversation({ id, source: id.startsWith('task:') ? 'posthog-task' : 'claude' })
  const newTerm = async (body: any = {}) => { const r = await post<{ id: string }>('/api/terms', body); reloadTerms(); setView({ kind: 'term', id: r.id }) }
  const openInClaude = (resume: string) => newTerm({ resume })
  useEffect(() => {
    const h = (e: Event) => { // sign in without a terminal; Settings shows progress and a paste-code box
      post('/api/claude/login', { conversationId: (e as CustomEvent).detail?.convId })
      toast('Finish signing in to Claude in your browser', { kind: 'info', action: 'The card in the chat shows progress and sends your message again' })
    }
    // From a blocker card (BlockerCard.tsx): a terminal for a CLI sign-in, or Settings → Connections.
    const term = (e: Event) => { const d = (e as CustomEvent).detail ?? {}; newTerm({ cmd: d.cmd, title: d.title }) }
    const sett = () => setView({ kind: 'settings' })
    addEventListener('perch:login', h); addEventListener('perch:terminal', term); addEventListener('perch:settings', sett)
    return () => { removeEventListener('perch:login', h); removeEventListener('perch:terminal', term); removeEventListener('perch:settings', sett) }
  })
  // Every new chat shares one draft slot, so an explicit "new chat" drops attachments left in an
  // abandoned one; otherwise they reappear in the next chat you start (and get sent with it).
  const newChat = () => { if (view.kind !== 'chat' || view.id !== null) forgetNewChatAttachments(); setView({ kind: 'chat', id: null }) }
  const startChat = (prompt?: string) => { if (prompt) try { sessionStorage.setItem('perch.draft', prompt) } catch {} newChat() }
  const askHistory = (q: string) => setView({ kind: 'search', q, agent: 'yes' })
  const searchEverywhere = (q: string) => setView({ kind: 'search', q })
  const chatInFolder = (f: Folder) => { try { sessionStorage.setItem('perch.folder', JSON.stringify({ id: f.id, cwd: f.cwd, name: f.name })) } catch {} newChat() }
  const focusFolder = (f: Folder) => api.send('PUT', '/api/settings', { focus: { active: true, areas: [{ name: f.name, query: f.query || `#${f.label}` }] } })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return
      const k = e.key.toLowerCase()
      if (k === 'm' && e.shiftKey && shell.mini) { e.preventDefault(); if (mode === 'mini') shell.mini(false).then(r => { if (r !== 'restored') shell.preset?.('compact') }); else shell.mini(true); return }
      if (k === 'k') { e.preventDefault(); setListOpen(true); setTimeout(() => searchRef.current?.focus(), 0) }
      else if (k === 'n') { e.preventDefault(); newChat() }
      else if (k === 't') { e.preventDefault(); newTerm() }
      else if (k === '\\') { e.preventDefault(); setListOpen(o => !o) }
      else if (k === ',') { e.preventDefault(); setView({ kind: 'settings' }) }
      else if (k === 'h' && e.shiftKey) { e.preventDefault(); setView({ kind: 'home' }) }
      else if (k === 'f' && e.shiftKey) {
        e.preventDefault()
        if (zen) api.send('PUT', '/api/settings', { focus: { ...settings.focus, active: false } }) // ⌘⇧F leaves zen
        else if (view.kind === 'doc') api.send('PUT', '/api/settings', { focus: { ...(settings?.focus ?? { areas: [] }), active: true } }) // writing: straight to just the page
        else { setListOpen(true); window.dispatchEvent(new Event('perch-focus')) }
      }
      else if (k === 'i') { e.preventDefault(); setDetailsOpen(o => !o) }
      else if (k === 'b' && e.shiftKey) { e.preventDefault(); document.querySelector<HTMLButtonElement>('[title^="Side question"]')?.click() }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  // Back from picture in picture: to where the window was, or the compact size if it was resized by hand.
  const expand = async () => { if ((await shell.mini?.(false)) !== 'restored') shell.preset?.('compact') }
  if (mode === 'tab') return <Tab />
  if (mode === 'mini') return <Mini pill={h < 100} panel={miniSize === 'panel'} id={view.kind === 'chat' ? view.id : null} onOpen={id => setView(id ? { kind: 'chat', id } : { kind: 'home' })} onExpand={expand} />
  if (mode === 'bar') return <Bar onExpand={() => shell.preset?.('compact')} onAsk={async prompt => { const r = await sendChat<{ id: string }>({ prompt }); setView({ kind: 'chat', id: r.id }); shell.preset?.('compact') }} />

  const selectedId = view.kind === 'chat' || view.kind === 'task' ? view.id : null
  const term = view.kind === 'term' ? terms.find(t => t.id === view.id) : undefined
  const main = (
    <Boundary where={view.kind}>
      <PauseBar onOpen={() => setView({ kind: 'paused' })} />
      {view.kind === 'chat' && <WithBoard conversationId={view.id} onOpen={id => openById(id)} chat={<Chat key={view.id ?? 'new'} id={view.id} onOpen={id => openById(id)} onTerminal={openInClaude} settings={settings}
        compact={mode === 'compact'} detailsOpen={detailsOpen} onToggleDetails={() => setDetailsOpen(!detailsOpen)} />} />}
      {view.kind === 'board' && (view.id
        ? <div className="scroll"><BoardPage key={view.id} id={view.id} onOpen={openById} onBoards={() => setView({ kind: 'explore', id: 'canvases' })} /></div>
        : <div className="scroll"><BoardsIndex onOpenBoard={id => setView({ kind: 'board', id })} onBack={() => setView({ kind: 'explore', id: 'canvases' })} /></div>)}
      {view.kind === 'term' && (term ? <TermView key={term.id} term={term} onClose={() => setView({ kind: 'chat', id: null })} /> : <div className="pad muted">Terminal closed.</div>)}
      {view.kind === 'task' && <div className="scroll"><Details id={view.id} onOpen={openById} onMakeRoutine={() => {}} /></div>}
      {view.kind === 'needs' && <div className="scroll"><div className="page"><NeedsMe onOpen={openById} /></div></div>}
      {view.kind === 'home' && <div className="scroll"><Home onOpen={openById} onStart={startChat} onBoard={id => setView({ kind: 'board', id })} settings={settings} onTerminal={(cmd, title) => newTerm({ cmd, title })} /></div>}
      {view.kind === 'ask' && <div className="scroll"><Ask question={view.q} onAsk={askHistory} /></div>}
      {view.kind === 'search' && <div className="scroll"><Search key={view.q + (view.agent ?? '')} initial={{ q: view.q, agent: view.agent }} onOpen={openById} /></div>}
      {view.kind === 'compare' && <div className="scroll"><Compare ids={view.ids} onOpen={openById} onDone={() => history.length > 1 ? history.back() : setView({ kind: 'home' })} /></div>}
      {view.kind === 'folder' && <div className="scroll"><FolderView id={view.id} onOpen={openConversation} onNewChat={chatInFolder} onFocus={focusFolder} /></div>}
      {view.kind === 'settings' && <div className="scroll"><Settings settings={settings} onTerminal={(cmd, title) => newTerm({ cmd, title })} /></div>}
      {view.kind === 'insights' && <div className="scroll"><Insights onOpen={openById} /></div>}
      {view.kind === 'paused' && <div className="scroll"><Paused onOpen={openById} /></div>}
      {view.kind === 'doc' && <Suspense fallback={<div className="pad muted">Opening the editor…</div>}><DocEditor key={view.id} id={view.id} onOpenChat={openById} settings={settings} zen={zen} /></Suspense>}
      {view.kind === 'writing' && <div className="scroll"><WritingHome onOpenDoc={id => setView({ kind: 'doc', id })} onStart={startChat} /></div>}
      {view.kind === 'explore' && <div className="scroll">{(() => {
        // Explore's landing picks a section; any other id is a repo for the code map (old links keep working).
        const nav = { onSection: (id: string | null) => setView({ kind: 'explore', id }), onOpenChat: openById, onOpenBoard: (id: string) => setView({ kind: 'board', id: id || null }), onStart: startChat }
        const id = view.id
        if (!id) return <ExploreHub {...nav} />
        if (id === 'canvases') return <CanvasGallery {...nav} />
        if (id === 'competitors') return <CompetitorGallery {...nav} />
        if (id === 'codebases') return <CodebaseGallery {...nav} />
        if (id === 'layouts') return <LayoutsPage {...nav} />
        if (id === 'writing') return <WritingHome onOpenDoc={id => setView({ kind: 'doc', id })} onStart={startChat} onBack={() => nav.onSection(null)} />
        if (id.startsWith('competitor:')) { const [, pid, t] = id.split(':'); return <CompetitorPage key={id} id={pid} tour={t === 'tour'} {...nav} /> }
        return <><button className="link small exh-back" style={{ margin: '6px 12px 0' }} onClick={() => nav.onSection(id === 'code' ? null : 'codebases')}>← {id === 'code' ? 'Explore' : 'Codebases'}</button><Explore key={id} initialRepo={id === 'code' ? undefined : id} onOpenChat={openById} /></>
      })()}</div>}
      {view.kind === 'pr' && <div className="scroll"><PrPage key={view.id} url={view.id} onOpen={openById} sideConversations={mode === 'wide' && detailsOpen && !zen} /></div>}
      {(view.kind === 'library' || view.kind === 'evolve') && <div className="scroll"><Library key={view.kind} initial={view.kind === 'evolve' ? 'learned' : undefined} onOpen={openById} /></div>}
      {view.kind === 'automations' && <div className="scroll"><Automations draft={routineDraft} onOpen={openById} settings={settings} /></div>}
    </Boundary>
  )
  // Any layout but the shipped default is drawn from its file; the default keeps the hand-built window below.
  const custom = !!layout && layout.name !== 'default'
  const makeRoutine = (c: Conversation) => { setRoutineDraft({ name: titleOf(c).slice(0, 60), prompt: '', cwd: c.cwd, cron: '0 9 * * 1-5', mode: 'resume', conversation_id: c.id, enabled: 1 }); setView({ kind: 'automations' }) }
  const sidebar = (
    <aside className="sidebar" style={mode === 'compact' ? undefined : custom ? { width: '100%' } : { width: side.width }}>
      {/* Two groups that wrap as units, so a narrow sidebar stacks them instead of spilling over. */}
      <div className="side-actions drag">
        <div className="side-group">
          <ProfileSwitch onSettings={() => setView({ kind: 'settings' })} />
          <button className="primary no-drag" onClick={newChat} title="New chat  ⌘N">+ Chat</button>
          <button className="no-drag" onClick={() => newTerm()} title="New terminal  ⌘T">⌘_</button>
          <button className="no-drag" onClick={() => newTerm({ cmd: 'claude', title: 'claude' })} title="Claude Code's own UI in a terminal">✳</button>
        </div>
        <div className="side-group">
          <FocusButton settings={settings} />
          <button className={`icon no-drag ${view.kind === 'search' ? 'on' : ''}`} onClick={() => setView({ kind: 'search', q: '' })} title="Search everywhere  ⌘⇧K">⌕</button>
          <button className={`icon no-drag ${view.kind === 'home' ? 'on' : ''}`} onClick={() => setView({ kind: 'home' })} title="Home: brief, PRs, notepad  ⌘⇧H">⌂</button>
          {shell.mini && <button className="icon no-drag" onClick={() => shell.mini?.(true)} title="Picture in picture: a small window of this that follows you  ⌘⇧M">⧉</button>}
          {shell.tuck && <button className="icon no-drag" onClick={() => shell.tuck?.(true)} title="Tuck into the edge of the screen; click the tab to bring it back  ⌘⇧.">⇥</button>}
        </div>
      </div>
      {/* What the sidebar is organised around: your conversations, or your PRs. */}
      <div className="side-switch tabs">{([['conversations', 'Conversations'], ['prs', 'PRs']] as const).map(([k, l]) => <button key={k} className={sideView === k ? 'on' : ''} onClick={() => pickSide(k)}>{l}</button>)}</div>
      {sideView === 'prs' ? <Boundary where="prs"><PrList selected={view.kind === 'pr' ? view.id : null} onOpen={url => setView({ kind: 'pr', id: url })} onOpenConversation={openById} /></Boundary> : <>
      <Boundary where="list"><List selectedId={selectedId} onOpen={openConversation} terms={terms} selectedTerm={view.kind === 'term' ? view.id : null} onOpenTerm={id => setView({ kind: 'term', id })} searchRef={searchRef}
        onMenu={(x, y, items) => menu.open({ x, y, items })} onAsk={askHistory} onSearchEverywhere={searchEverywhere} /></Boundary>
      {/* Folders still hold canvases and manual groupings; they stay out of the way until opened. */}
      <details className="side-folders"><summary>Folders</summary>
<Boundary where="folders"><FolderList zenAreas={zen ? settings.focus.areas : null} selected={view.kind === 'folder' ? view.id : null} onOpen={f => setView({ kind: 'folder', id: f.id })} recentOn={false}
        onRecent={() => { try { localStorage.setItem('perch.filter', 'all'); localStorage.setItem('perch.sort', 'updated') } catch {} window.dispatchEvent(new Event('perch-recent')) }} /></Boundary>
      </details></>}
      {!zen && <Nav view={view} setView={setView} />}
    </aside>
  )

  if (mode === 'compact' && simple) {
    const inChat = view.kind === 'chat' && !!view.id
    return (
      <div className={`app compact simple-app ${zen ? 'zen' : ''}`}>
        {inChat ? <>
          <header className="topbar s-chat-head">
            <button className="icon" onClick={() => setView({ kind: 'home' })} title="Back">‹</button>
            <div className="grow title" />
            {view.kind === 'chat' && view.id && <CloudBar id={view.id} />}
            <button className="s-mode" onClick={() => setSimple(false)}>Advanced</button>
          </header>
          <div className="body"><main className="main">{main}</main></div>
        </> : <SimpleHome onOpen={openById} onAdvanced={() => setSimple(false)} />}
        <Handoff current={hashFor(view)} onGo={goHash} />
        <Toasts zen={zen} /><AskCard /><FileViewer /><UiAsk /><UiCustomizeMenu /><UiDraftBar />
      </div>
    )
  }
  if (mode === 'compact') {
    return (
      <div className={`app compact ${shell.isElectron ? 'electron' : ''} ${zen ? 'zen' : ''}`}>
        <header className="topbar drag">
          <button className="icon no-drag" onClick={() => setListOpen(!listOpen)} title="Conversations  ⌘\">{listOpen ? '→' : '☰'}</button>
          <div className="grow title">{listOpen ? 'auto-m8' : ''}</div>
          <ProdAlert />
          <BrowserFlag onOpen={openById} />
          {showDecisions && <DecisionFlag onOpen={openById} />}
          <Resources />
          <UiButton />
          <PinButton />
          {canSimple && <button className="s-mode no-drag" onClick={() => { setSimple(true); setView({ kind: 'home' }) }}>Simple</button>}
        </header>
        <Handoff current={hashFor(view)} onGo={goHash} />
        <div className="body">{listOpen ? sidebar : <main className="main">{main}</main>}</div>
        {menu.target && <ContextMenu target={menu.target} onClose={menu.close} onOpenTerminal={openInClaude} />}
        <Toasts zen={zen} /><AskCard /><FileViewer /><UiAsk /><UiCustomizeMenu /><UiDraftBar /><CarryDialog />
      </div>
    )
  }

  const showDetails = mode === 'wide' && detailsOpen && !zen && view.kind === 'chat' && view.id
  // Zen while writing: just the page. No sidebar, no side panels, no chats.
  const zenWriting = zen && view.kind === 'doc'
  const showPrSide = mode === 'wide' && detailsOpen && !zen && view.kind === 'pr' && view.id
  if (custom) {
    // What a layout tile may ask for. Each one only navigates; none changes data.
    const PAGES = ['home', 'needs', 'settings', 'insights', 'library', 'automations', 'evolve', 'explore', 'paused']
    const run: Run = (c, a) => {
      if (c === 'open') { if (typeof a?.id !== 'string') return 'open needs {id}'; openById(a.id); return null }
      if (c === 'view') {
        if (a?.kind === 'board') setView({ kind: 'board', id: null })
        else if (a?.kind === 'search') setView({ kind: 'search', q: '' })
        else if (PAGES.includes(a?.kind)) setView({ kind: a.kind } as View)
        else return `view needs {kind}: ${[...PAGES, 'board', 'search'].join(', ')}`
        return null
      }
      if (c === 'chat.new') { startChat(typeof a?.prompt === 'string' ? a.prompt : undefined); return null }
      if (c === 'search') { setView({ kind: 'search', q: String(a?.q ?? '') }); return null }
      if (c === 'sidebar.toggle') { setListOpen(o => !o); return null }
      if (c === 'details.toggle') { setDetailsOpen(o => !o); return null }
      if (c === 'layout.switch') { api.send('PUT', '/api/layouts/active', { name: String(a?.name ?? '') }); return null }
      return `auto-m8 has no "${c}" command`
    }
    // The window's buttons sit over the top-left corner: whatever is drawn there makes room for them.
    const corner = shell.isElectron ? topLeftOf(layout.layout, { sidebar: listOpen, details: !!(showDetails || showPrSide) }) : null
    const slots = {
      sidebar: listOpen && !zenWriting ? sidebar : null,
      main: (
        <main className="main">
          <div className={`main-top drag ${corner === 'main' ? 'no-side' : ''}`}>
            {!listOpen && <button className="icon no-drag" onClick={() => setListOpen(true)} title="Show sidebar  ⌘\">☰</button>}
            <span className="grow" />
            <BrowserFlag onOpen={openById} />
            {showDecisions && <DecisionFlag onOpen={openById} />}
            <Resources />
            <UiButton />
            <PinButton />
          </div>
          {main}
        </main>
      ),
      details: showDetails ? <aside className="detail-col" style={{ width: '100%' }}><Boundary where="details"><Details id={view.id!} onOpen={openById} onMakeRoutine={makeRoutine} /></Boundary></aside>
        : showPrSide ? <aside className="detail-col" style={{ width: '100%' }}><PrSide url={view.id!} onOpen={openById} /></aside> : null,
    }
    return (
      <div className={`app ${mode} ${shell.isElectron ? 'electron' : ''} ${zen ? 'zen' : ''} layout-custom ${corner && corner !== 'main' && corner !== 'sidebar' ? 'corner-tile' : ''}`} data-corner={corner ?? ''}>
        <Handoff current={hashFor(view)} onGo={goHash} />
        <div className="body"><LayoutTree node={layout.layout} slots={slots} run={run} corner={corner} /></div>
        {menu.target && <ContextMenu target={menu.target} onClose={menu.close} onOpenTerminal={openInClaude} />}
        <Toasts zen={zen} /><AskCard /><FileViewer /><UiAsk /><UiCustomizeMenu /><UiDraftBar /><CarryDialog />
      </div>
    )
  }
  return (
    <div className={`app ${mode} ${shell.isElectron ? 'electron' : ''} ${zen ? 'zen' : ''}`}>
      <Handoff current={hashFor(view)} onGo={goHash} />
      <div className="body">
        {listOpen && !zenWriting && sidebar}
        {listOpen && !zenWriting && <Splitter side="left" width={side.width} onWidth={side.setWidth} onReset={side.reset} onCollapse={() => setListOpen(false)} />}
        {!listOpen && !zenWriting && <EdgeHandle side="left" onOpen={() => setListOpen(true)} onWidth={side.setWidth} onClose={() => setListOpen(false)} title="Show sidebar  ⌘\" />}
        <main className="main">
          <div className={`main-top drag ${listOpen && !zenWriting ? '' : 'no-side'}`}>
            {!listOpen && !zenWriting && <button className="icon no-drag" onClick={() => setListOpen(true)} title="Show sidebar  ⌘\">☰</button>}
            <span className="grow" />
            <BrowserFlag onOpen={openById} />
            {showDecisions && <DecisionFlag onOpen={openById} />}
            <Resources />
            <UiButton />
            <PinButton />
          </div>
          {main}
        </main>
        {showDetails && <Splitter side="right" width={details.width} onWidth={details.setWidth} onReset={details.reset} />}
        {showDetails && <aside className="detail-col" style={{ width: details.width }}><Boundary where="details"><Details id={view.id!} onOpen={openById} onMakeRoutine={makeRoutine} /></Boundary></aside>}
        {showPrSide && <Splitter side="right" width={details.width} onWidth={details.setWidth} onReset={details.reset} />}
        {showPrSide && <aside className="detail-col" style={{ width: details.width }}><PrSide url={view.id!} onOpen={openById} /></aside>}
      </div>
      {menu.target && <ContextMenu target={menu.target} onClose={menu.close} onOpenTerminal={openInClaude} />}
      <Toasts zen={zen} /><AskCard /><FileViewer /><UiAsk /><UiCustomizeMenu /><UiDraftBar /><CarryDialog />
    </div>
  )
}

function Toasts({ zen }: { zen?: boolean }) {
  // Zen keeps quiet about things perch is already fixing on its own.
  const list = useToasts().filter(t => !zen || !/retrying|reconnect/i.test(`${t.message} ${t.action ?? ''}`))
  if (!list.length) return null
  return <div className="toasts">{list.map(t => <div key={t.id} className={`toast ${t.kind}`}><b>{t.message}</b>{t.action && <span>{t.action}</span>}
    {t.authorize && <button className="small" style={{ alignSelf: 'flex-start', marginTop: 4 }} onClick={() => post('/api/mcp/login', { server: t.authorize })}>Open sign-in again</button>}</div>)}</div>
}

function Nav({ view, setView }: { view: View; setView: (v: View) => void }) {
  // Evolve lives under Skills & scouts (it writes the skills). Explore keeps its tab: Daniel asked for it back.
  const items: [View['kind'], string, string][] = [['insights', '▤', 'Insights'], ['explore', '⌬', 'Explore'], ['library', '◇', 'Skills & scouts'], ['automations', '↻', 'Automations'], ['settings', '⚙', 'Settings  ⌘,']]
  const on = (k: View['kind']) => view.kind === k || (k === 'library' && view.kind === 'evolve')
  return (
    <nav className="nav">
      {items.map(([k, icon, label]) => (
        <button key={k} className={on(k) ? 'on' : ''} title={label} onClick={() => setView({ kind: k } as View)}><i className="nav-glyph">{icon}</i><span>{label.split('  ')[0]}</span></button>
      ))}
      {/* One click pauses or resumes everything; the bar across the top shows what's held. */}
      <PauseButton />
    </nav>
  )
}

function PinButton() {
  const [pinned, setPinned] = useState<boolean | null>(null)
  useEffect(() => { shell.isPinned?.().then(setPinned) }, [])
  if (!shell.isElectron) return null
  return <button className={`icon no-drag ${pinned ? 'on' : ''}`} title={pinned ? 'Floating above other windows' : 'Float above other windows'}
    onClick={async () => { const next = !pinned; setPinned(next); await shell.pin?.(next); api.send('PUT', '/api/settings', { window: { alwaysOnTop: next } }) }}>📌</button>
}

// The shortest layout: what's running, what needs you, and one line to ask something.
function Bar({ onExpand, onAsk }: { onExpand: () => void; onAsk: (prompt: string) => void }) {
  const { data } = useLive<{ counts: Record<string, number> }>('/api/conversations?limit=1', ['conversations', 'chats'])
  const [q, setQ] = useState('')
  const c = data?.counts ?? {}
  return (
    <div className="cmdbar">
      <span className="no-drag counts" onClick={onExpand} title="Expand">
        <span className="dot s-running" />{c.running ?? 0}<span className="dot s-waiting" />{c.waiting ?? 0}
      </span>
      <input className="no-drag grow" value={q} placeholder="Ask Claude…" onChange={e => setQ(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && q.trim()) { onAsk(q.trim()); setQ('') } }} />
      <button className="icon no-drag" onClick={onExpand} title="Expand">⤢</button>
    </div>
  )
}
