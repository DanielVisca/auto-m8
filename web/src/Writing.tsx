// Writing: a markdown editor for the long documents you sometimes open (blog drafts, ideas lists),
// with what a doc editor gives you around the text: comments (yours and agents', always labelled),
// research and evidence agents gather, versions, draft/final, export, on-device grammar and spelling
// (Harper), an "AI tells" check, an optional Pangram AI-text check, an agent chat beside it, and a
// "no agent text" mode where agents may only comment and research. Zen hides everything but the page.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Marked } from 'marked'
import { EditorState, StateEffect, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, keymap, drawSelection, placeholder, type DecorationSet } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { linter, forceLinting, type Diagnostic } from '@codemirror/lint'
import { api, post, sendChat, toast, useLive } from './api'
import { Chat, copyText } from './Chat'
import './writing.css'

type Comment = { id: string; parent_id: string | null; author_kind: 'person' | 'agent'; author_name: string | null; conversation_id: string | null; quote: string | null; start: number | null; end: number | null; body: string; resolved: number; created_at: number; detached?: boolean }
type Research = { id: string; title: string; url: string | null; quote: string | null; note: string | null; author_kind: string; author_name: string | null; conversation_id: string | null; created_at: number }
type Version = { id: string; rev: number; label: string | null; author_kind: string; author_name: string | null; created_at: number; size: number }
type Doc = { id: string; path: string; title: string; status: 'draft' | 'final'; agent_text: 'allowed' | 'blocked'; conversation_id: string | null; rev: number; exists: boolean; updated_at: number; open_comments?: number; research?: number }
type Full = { doc: Doc; text: string; comments: Comment[]; research: Research[]; versions: Version[] }
type AiWindow = { label: string; score: number; confidence: string; start: number | null; end: number | null }
type AiResult = { verdict: string; headline: string; prediction: string; fraction_ai: number; fraction_ai_assisted: number; fraction_human: number; windows: AiWindow[]; at: number }

const ago = (t: number) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(t).toLocaleDateString() }
const local = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } }
const keep = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

// ---------- editor plumbing ----------
type Mark = { id: string; from: number; to: number; cls: string }
const setMarks = StateEffect.define<{ kind: string; marks: Mark[] }>()
// Highlights that follow the text as you type: comment anchors and AI-check passages.
function markField(kind: string) {
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
      deco = deco.map(tr.changes)
      for (const e of tr.effects) if (e.is(setMarks) && e.value.kind === kind) {
        const ranges: Range<Decoration>[] = e.value.marks.filter(m => m.to > m.from && m.to <= tr.state.doc.length)
          .sort((a, b) => a.from - b.from).map(m => Decoration.mark({ class: m.cls, attributes: { 'data-mark': m.id } }).range(m.from, m.to))
        deco = Decoration.set(ranges, true)
      }
      return deco
    },
    provide: f => EditorView.decorations.from(f),
  })
}
const commentField = markField('comments'), aiField = markField('ai')
// Where each comment's highlight is now (after edits), to save its anchor with the text.
function anchorsOf(state: EditorState) {
  const out: { id: string; start: number; end: number; quote: string }[] = []
  state.field(commentField).between(0, state.doc.length, (from, to, v) => { const id = (v.spec.attributes as any)?.['data-mark']; if (id) out.push({ id, start: from, end: to, quote: state.doc.sliceString(from, to) }) })
  return out
}

const mdStyle = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.7em', fontWeight: '700' },
  { tag: tags.heading2, fontSize: '1.35em', fontWeight: '700' },
  { tag: tags.heading3, fontSize: '1.15em', fontWeight: '650' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: '650' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: 'var(--accent)' },
  { tag: tags.url, color: 'var(--muted)' },
  { tag: tags.monospace, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '0.92em' },
  { tag: tags.quote, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [tags.processingInstruction, tags.meta], color: 'var(--muted)' },
])

// Harper counts characters as code points; the editor counts UTF-16 units. Only differs around emoji.
function codePointMap(text: string) {
  if (!/[\uD800-\uDBFF]/.test(text)) return (i: number) => i
  const map: number[] = []
  let u = 0
  for (const ch of text) { map.push(u); u += ch.length }
  map.push(u)
  return (i: number) => map[Math.min(i, map.length - 1)]
}

// On-device grammar and spelling: Harper in a web worker, loaded the first time a doc opens.
let harper: Promise<any> | null = null
function harperLinter(dialect: number) {
  harper ??= (async () => {
    const [{ WorkerLinter }, { binary }] = await Promise.all([import('harper.js'), import('harper.js/binary')])
    const l = new WorkerLinter({ binary, dialect })
    await l.setup()
    const words = local<string[]>('perch.writing.words', [])
    if (words.length) await l.importWords(words)
    return l
  })().catch(e => { harper = null; throw e })
  return harper
}

// Phrases that read as machine-written. Not a detector: a nudge toward plainer writing.
const AI_TELLS: [RegExp, string][] = [
  [/\s—\s|—/g, 'Em dash: a common tell in AI-written text. A comma, colon or full stop usually reads more naturally.'],
  [/\b(delve|delving|tapestry|testament to|realm of|navigat(e|ing) the (complexities|landscape)|ever-evolving|fast-paced world|game[- ]changer|unlock(ing)? the (power|potential)|seamless(ly)?|robust|leverag(e|ing)|elevate|embark|meticulous(ly)?|pivotal|paramount|underscore[sd]?|showcas(e|ing)|bustling|vibrant|intricate|nuanced|holistic|synergy)\b/gi, 'Word that AI writing overuses. Say the plain thing.'],
  [/\b(it'?s (not|isn'?t) (just|only|merely) [^.,;]{1,60}[,;—-]\s*it'?s|not only [^.]{1,80} but also)\b/gi, '"It\'s not X, it\'s Y": a pattern AI writing leans on.'],
  [/^(Moreover|Furthermore|Additionally|In conclusion|In summary|Ultimately|Overall|Importantly|Notably),/gim, 'Signpost opener that AI writing overuses. Usually you can just drop it.'],
  [/\b(In today'?s [a-z -]+ (world|landscape|age)|Let'?s dive in|Here'?s the thing|At the end of the day|When it comes to)\b/gi, 'Stock phrase that reads as generated.'],
  [/\b(I hope this helps|Great question|Certainly!|Absolutely!)/gi, 'Assistant-speak.'],
]
function aiTells(text: string): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const [re, message] of AI_TELLS) for (const m of text.matchAll(re)) {
    const from = m.index!, to = from + m[0].length
    out.push({ from, to, severity: 'info', source: 'Sounds like AI', message, markClass: 'cm-ai-tell' })
    if (out.length > 400) return out
  }
  return out
}

// ---------- the editor page ----------
export function DocEditor({ id, onOpenChat, settings, zen }: { id: string; onOpenChat: (id: string) => void; settings: any; zen: boolean }) {
  const { data, reload } = useLive<Full>(`/api/docs/${id}`, ['docs'])
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const rev = useRef<number>(-1)
  const dirty = useRef(false)
  const saving = useRef<Promise<void> | null>(null)
  const timer = useRef<any>(null)
  const [state, setState] = useState<'saved' | 'saving' | 'unsaved' | 'conflict'>('saved')
  const [conflict, setConflict] = useState<{ text: string; rev: number } | null>(null)
  const [tab, setTab] = useState<'comments' | 'research' | 'versions' | 'agent' | 'check'>(() => local('perch.writing.tab', 'comments'))
  const [panel, setPanel] = useState(() => local('perch.writing.panel', true))
  const [selection, setSelection] = useState<{ from: number; to: number; text: string } | null>(null)
  const [activeComment, setActiveComment] = useState<string | null>(null)
  const [grammar, setGrammar] = useState(() => local('perch.writing.grammar', true))
  const [tells, setTells] = useState(() => local('perch.writing.tells', true))
  const [dialect, setDialect] = useState<number>(() => local('perch.writing.dialect', 0))
  const [ai, setAi] = useState<AiResult | null>(() => local(`perch.writing.ai.${id}`, null))
  const [wordCount, setWordCount] = useState(0)
  const opts = useRef({ grammar, tells, dialect })
  opts.current = { grammar, tells, dialect }
  useEffect(() => keep('perch.writing.tab', tab), [tab])
  useEffect(() => keep('perch.writing.panel', panel), [panel])
  useEffect(() => { keep('perch.writing.grammar', grammar); keep('perch.writing.tells', tells); keep('perch.writing.dialect', dialect); if (view.current) forceLinting(view.current) }, [grammar, tells, dialect])

  const save = async () => {
    const v = view.current
    if (!v || !dirty.current) return
    if (saving.current) { await saving.current; return save() }
    saving.current = (async () => {
      setState('saving')
      const text = v.state.doc.toString()
      dirty.current = false
      const r: any = await post(`/api/docs/${id}/save`, { text, rev: rev.current, anchors: anchorsOf(v.state) }).catch(() => ({ error: 'offline' }))
      if (r?.ok) { rev.current = r.rev; setState(dirty.current ? 'unsaved' : 'saved'); return }
      dirty.current = true
      if (r?.conflict) {
        // An agent edited while you typed: replay its find/replace steps on your text, then save again.
        let mine = v.state.doc.toString(), clean = true
        for (const op of r.ops ?? []) {
          if (op.old && mine.split(op.old).length === 2) mine = mine.replace(op.old, () => op.new)
          else if (!op.old) mine = mine + (mine.endsWith('\n') ? '' : '\n') + op.new
          else { clean = false; break }
        }
        if (clean && r.ops?.length) { replaceText(v, mine); rev.current = r.rev; setState('unsaved'); setTimeout(save, 50); return }
        setConflict({ text: r.text, rev: r.rev }); setState('conflict'); return
      }
      setState('unsaved')
    })()
    try { await saving.current } finally { saving.current = null }
  }

  // Build the editor once per doc, as soon as its page is on screen.
  const ready = !!data?.doc
  useEffect(() => {
    if (!host.current || view.current) return
    const lint = linter(async v => {
      const text = v.state.doc.toString()
      const out: Diagnostic[] = []
      if (opts.current.tells) out.push(...aiTells(text))
      if (opts.current.grammar && text.length < 400_000) {
        try {
          const l = await harperLinter(opts.current.dialect)
          if (opts.current.dialect !== (await l.getDialect())) await l.setDialect(opts.current.dialect)
          const ignored = new Set(local<string[]>('perch.writing.ignored', []))
          const at = codePointMap(text)
          for (const lint of await l.lint(text, { language: 'markdown' })) {
            const sp = lint.span(), from = at(sp.start), to = at(sp.end)
            const problem = text.slice(from, to), kind = lint.lint_kind()
            if (ignored.has(`${kind}|${problem}`) || to > v.state.doc.length) continue
            if (kind === 'Capitalization' && /^#{1,6}\s/.test(v.state.doc.lineAt(from).text)) continue // headings are yours to case
            const spelling = kind === 'Spelling'
            out.push({
              from, to, severity: spelling ? 'error' : 'warning', source: lint.lint_kind_pretty(), message: lint.message(), markClass: spelling ? 'cm-spell' : 'cm-grammar',
              actions: [
                ...lint.suggestions().slice(0, 4).map((s: any) => {
                  const rep = s.get_replacement_text(), k = s.kind()
                  const name = k === 1 ? 'Remove' : rep ? `→ ${rep}` : 'Fix'
                  return { name, apply: (ev: EditorView, f: number, t: number) => ev.dispatch({ changes: k === 2 ? { from: t, insert: rep } : { from: f, to: t, insert: k === 1 ? '' : rep } }) }
                }),
                ...(spelling ? [{ name: 'Add to dictionary', apply: async (ev: EditorView) => { const w = [...local<string[]>('perch.writing.words', []), problem]; keep('perch.writing.words', w); (await harperLinter(opts.current.dialect)).importWords([problem]); forceLinting(ev) } }] : []),
                { name: 'Ignore', apply: (ev: EditorView) => { keep('perch.writing.ignored', [...ignored, `${kind}|${problem}`]); forceLinting(ev) } },
              ],
            })
          }
        } catch (e) { console.warn('grammar check unavailable', e) }
      }
      return out
    }, { delay: 900 })
    const extensions: Extension[] = [
      history(), drawSelection(), markdown(), syntaxHighlighting(mdStyle), EditorView.lineWrapping,
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab,
        { key: 'Mod-s', run: () => { save(); return true } },
        { key: 'Mod-Alt-m', run: v => { const s = v.state.selection.main; if (!s.empty) { setPanel(true); setTab('comments'); window.dispatchEvent(new Event('perch-doc-comment')) } return true } }]),
      placeholder('Start writing…'), commentField, aiField, lint,
      EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', 'aria-label': 'Document text' }),
      EditorView.updateListener.of(u => {
        if (u.docChanged) {
          dirty.current = true; setState('unsaved'); clearTimeout(timer.current); timer.current = setTimeout(save, 1200)
          setWordCount(countWords(u.state.doc.toString()))
        }
        if (u.selectionSet || u.docChanged) {
          const s = u.state.selection.main
          setSelection(s.empty ? null : { from: s.from, to: s.to, text: u.state.sliceDoc(s.from, s.to) })
        }
      }),
      EditorView.domEventHandlers({
        click: e => { const m = (e.target as HTMLElement).closest('[data-mark]') as HTMLElement | null; if (m?.closest('.cm-comment')) { setActiveComment(m.dataset.mark!); setPanel(true); setTab('comments') } return false },
      }),
    ]
    const v = new EditorView({ parent: host.current, state: EditorState.create({ doc: '', extensions }) })
    view.current = v
    rev.current = -1
    const flush = () => { if (dirty.current) save() }
    addEventListener('beforeunload', flush)
    return () => { removeEventListener('beforeunload', flush); clearTimeout(timer.current); if (dirty.current) save(); v.destroy(); view.current = null }
  }, [id, ready]) // eslint-disable-line react-hooks/exhaustive-deps

  // Text from the server: the first load, and changes made elsewhere (an agent's edit, a restore).
  useEffect(() => {
    const v = view.current
    if (!v || !data?.doc) return
    if (rev.current < 0 || (data.doc.rev > rev.current && !dirty.current && !saving.current)) {
      if (v.state.doc.toString() !== data.text) replaceText(v, data.text, rev.current >= 0)
      rev.current = data.doc.rev
      dirty.current = false
      setState('saved'); setConflict(null)
      setWordCount(countWords(data.text))
    }
  }, [data?.doc?.rev, data?.text]) // eslint-disable-line react-hooks/exhaustive-deps

  // Comment highlights follow the comments.
  const comments = data?.comments ?? []
  useEffect(() => {
    const v = view.current
    if (!v || rev.current < 0) return
    const marks = comments.filter(c => !c.parent_id && !c.resolved && c.start != null && c.end != null)
      .map(c => ({ id: c.id, from: c.start!, to: c.end!, cls: `cm-comment ${c.author_kind === 'agent' ? 'by-agent' : 'by-person'} ${activeComment === c.id ? 'active' : ''}` }))
    v.dispatch({ effects: setMarks.of({ kind: 'comments', marks }) })
  }, [JSON.stringify(comments.map(c => [c.id, c.start, c.end, c.resolved])), activeComment, data?.doc?.rev]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const v = view.current
    if (!v) return
    const marks = (ai?.windows ?? []).filter(w => w.start != null && w.label !== 'Human Written').map((w, i) => ({ id: `ai${i}`, from: w.start!, to: w.end!, cls: w.label === 'AI-Generated' ? 'cm-ai-gen' : 'cm-ai-assist' }))
    v.dispatch({ effects: setMarks.of({ kind: 'ai', marks }) })
  }, [ai, data?.doc?.rev])

  const jump = (from: number | null, to?: number | null) => {
    const v = view.current
    if (!v || from == null) return
    v.dispatch({ selection: { anchor: from, head: to ?? from }, effects: EditorView.scrollIntoView(from, { y: 'center' }) })
    v.focus()
  }

  if (!data) return <div className="pad muted">Opening…</div>
  if ((data as any).error) return <div className="pad">{(data as any).error}</div>
  const doc = data.doc
  const locked = doc.agent_text === 'blocked'
  const setDoc = (patch: Partial<Doc>) => post(`/api/docs/${id}`, patch)
  const textNow = () => view.current?.state.doc.toString() ?? data.text
  const showPanel = panel && !zen

  return (
    <div className={`writing ${zen ? 'writing-zen' : ''}`}>
      <div className="writing-main">
        <div className="writing-bar">
          <b className="ellipsis" title={doc.path}>{doc.title || 'Untitled'}</b>
          <button className={`chip-btn ${doc.status}`} title="Draft or final. Final saves a named version." onClick={async () => { await save(); if (doc.status === 'draft') await post(`/api/docs/${id}/versions`, { label: 'Final' }); setDoc({ status: doc.status === 'draft' ? 'final' : 'draft' }) }}>{doc.status === 'draft' ? '✎ Draft' : '✓ Final'}</button>
          <button className={`chip-btn ${locked ? 'on locked' : ''}`} title={locked ? 'No agent text: agents can comment and research, but every word of the text is yours. Click to let agents edit.' : 'Agents may edit the text. Click for no agent text mode.'}
            onClick={() => setDoc({ agent_text: locked ? 'allowed' : 'blocked' })}>{locked ? '✍ No agent text' : '🤖 Agents may edit'}</button>
          <span className="grow" />
          <span className={`muted small save-${state}`}>{state === 'saved' ? 'Saved' : state === 'saving' ? 'Saving…' : state === 'conflict' ? 'Changed elsewhere' : 'Unsaved'} · {wordCount.toLocaleString()} words</span>
          <button className="icon" title="Comment on the selection  ⌘⌥M" disabled={!selection} onClick={() => { setPanel(true); setTab('comments'); setTimeout(() => window.dispatchEvent(new Event('perch-doc-comment')), 0) }}>💬</button>
          <ExportMenu id={id} title={doc.title} path={doc.path} text={textNow} />
          <button className={`icon ${zen ? 'on' : ''}`} title={zen ? 'Leave zen  ⌘⇧F' : 'Zen: just the page'} onClick={() => api.send('PUT', '/api/settings', { focus: { ...(settings?.focus ?? { areas: [] }), active: !zen } })}>◎</button>
          {!zen && <button className={`icon ${panel ? 'on' : ''}`} title="Comments, research, versions, agent" onClick={() => setPanel(!panel)}>▤</button>}
        </div>
        {conflict && <div className="writing-conflict">This doc changed outside the editor while you had unsaved typing.
          <button onClick={() => { if (view.current) replaceText(view.current, conflict.text); rev.current = conflict.rev; dirty.current = false; setConflict(null); setState('saved') }}>Load the other version</button>
          <button className="primary" onClick={() => { rev.current = conflict.rev; dirty.current = true; setConflict(null); save() }}>Keep mine</button></div>}
        {!doc.exists && <div className="writing-conflict">The file at {doc.path} is missing; typing will create it again.</div>}
        <div className="writing-scroll"><div className="writing-page" ref={host} /></div>
      </div>
      {showPanel && (
        <aside className="writing-side">
          <div className="tabs">
            {([['comments', `Comments${comments.filter(c => !c.parent_id && !c.resolved).length ? ` ${comments.filter(c => !c.parent_id && !c.resolved).length}` : ''}`], ['research', `Research${data.research.length ? ` ${data.research.length}` : ''}`], ['agent', 'Agent'], ['check', 'Check'], ['versions', 'Versions']] as const)
              .map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
          </div>
          <div className="writing-side-body">
            {tab === 'comments' && <Comments id={id} comments={comments} selection={selection} active={activeComment} onActive={c => { setActiveComment(c.id); jump(c.start, c.end) }} onOpenChat={onOpenChat} />}
            {tab === 'research' && <ResearchPanel id={id} items={data.research} onOpenChat={onOpenChat} onAsk={() => setTab('agent')} />}
            {tab === 'versions' && <Versions id={id} versions={data.versions} current={textNow} onRestored={reload} before={save} />}
            {tab === 'agent' && <AgentPanel doc={doc} selection={selection} settings={settings} onOpenChat={onOpenChat} />}
            {tab === 'check' && <CheckPanel id={id} grammar={grammar} setGrammar={setGrammar} tells={tells} setTells={setTells} dialect={dialect} setDialect={setDialect}
              ai={ai} setAi={r => { setAi(r); keep(`perch.writing.ai.${id}`, r) }} text={textNow} onJump={jump} />}
          </div>
        </aside>
      )}
    </div>
  )
}

const countWords = (t: string) => (t.match(/[\p{L}\p{N}'’-]+/gu) ?? []).length
// Swap the editor's text for another, changing only the part that differs so the cursor stays put.
function replaceText(v: EditorView, next: string, keepHistory = true) {
  const cur = v.state.doc.toString()
  if (cur === next) return
  let a = 0
  while (a < cur.length && a < next.length && cur[a] === next[a]) a++
  let b = 0
  while (b < cur.length - a && b < next.length - a && cur[cur.length - 1 - b] === next[next.length - 1 - b]) b++
  v.dispatch({ changes: { from: a, to: cur.length - b, insert: next.slice(a, next.length - b) }, ...(keepHistory ? {} : { annotations: [] }) })
}

function Who({ kind, name, conversation, onOpenChat }: { kind: string; name: string | null; conversation: string | null; onOpenChat: (id: string) => void }) {
  return kind === 'agent'
    ? <span className="who agent" title="Written by an agent">🤖 {conversation ? <a href="#" onClick={e => { e.preventDefault(); onOpenChat(conversation) }}>{name || 'Agent'}</a> : name || 'Agent'}</span>
    : <span className="who person" title="Written by you">● You</span>
}

function Comments({ id, comments, selection, active, onActive, onOpenChat }: { id: string; comments: Comment[]; selection: { from: number; to: number; text: string } | null; active: string | null; onActive: (c: Comment) => void; onOpenChat: (id: string) => void }) {
  const [draft, setDraft] = useState('')
  const [reply, setReply] = useState<Record<string, string>>({})
  const [showResolved, setShowResolved] = useState(false)
  const [filter, setFilter] = useState<'all' | 'agent' | 'person'>('all')
  const box = useRef<HTMLTextAreaElement>(null)
  const pinned = useRef(selection)
  if (selection) pinned.current = selection
  useEffect(() => { const f = () => box.current?.focus(); addEventListener('perch-doc-comment', f); return () => removeEventListener('perch-doc-comment', f) }, [])
  const add = async () => {
    const s = pinned.current
    if (!draft.trim()) return
    await post(`/api/docs/${id}/comments`, { body: draft, ...(s ? { quote: s.text, start: s.from } : {}) })
    setDraft(''); pinned.current = null
  }
  const roots = comments.filter(c => !c.parent_id && (showResolved || !c.resolved) && (filter === 'all' || c.author_kind === filter))
    .sort((a, b) => (a.start ?? 1e12) - (b.start ?? 1e12) || a.created_at - b.created_at)
  return (
    <div className="doc-comments">
      <div className="doc-new-comment">
        {pinned.current ? <div className="quote small">“{pinned.current.text.slice(0, 160)}{pinned.current.text.length > 160 ? '…' : ''}”</div> : <div className="muted small">Select text to comment on it, or leave a general comment.</div>}
        <textarea ref={box} value={draft} rows={2} placeholder="Add a comment…" onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add() }} />
        <div className="row-flex"><button className="primary small" disabled={!draft.trim()} onClick={add}>Comment</button>{pinned.current && <button className="small" onClick={() => { pinned.current = null; setDraft(d => d + '') }}>General instead</button>}</div>
      </div>
      <div className="row-flex small">
        {(['all', 'person', 'agent'] as const).map(f => <button key={f} className={`chip-btn ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : f === 'person' ? '● You' : '🤖 Agents'}</button>)}
        <span className="grow" /><label className="muted"><input type="checkbox" checked={showResolved} onChange={e => setShowResolved(e.target.checked)} /> resolved</label>
      </div>
      {roots.length === 0 && <div className="muted small pad">No comments{filter !== 'all' ? ' from ' + (filter === 'agent' ? 'agents' : 'you') : ''} yet. Agents add theirs with the doc tool.</div>}
      {roots.map(c => (
        <div key={c.id} className={`doc-comment ${c.author_kind} ${active === c.id ? 'active' : ''} ${c.resolved ? 'resolved' : ''}`} onClick={() => onActive(c)}>
          <div className="row-flex small"><Who kind={c.author_kind} name={c.author_name} conversation={c.conversation_id} onOpenChat={onOpenChat} /><span className="grow" /><span className="muted">{ago(c.created_at)}</span></div>
          {c.quote && <div className={`quote small ${c.detached ? 'detached' : ''}`} title={c.detached ? 'That text is no longer in the doc' : ''}>“{c.quote.slice(0, 200)}”{c.detached && ' (removed)'}</div>}
          <div className="doc-comment-body">{c.body}</div>
          {comments.filter(r => r.parent_id === c.id).map(r => <div key={r.id} className={`doc-reply ${r.author_kind}`}><Who kind={r.author_kind} name={r.author_name} conversation={r.conversation_id} onOpenChat={onOpenChat} /> {r.body}</div>)}
          {active === c.id && <div className="row-flex" onClick={e => e.stopPropagation()}>
            <input className="grow small" value={reply[c.id] ?? ''} placeholder="Reply…" onChange={e => setReply({ ...reply, [c.id]: e.target.value })}
              onKeyDown={async e => { if (e.key === 'Enter' && reply[c.id]?.trim()) { await post(`/api/docs/${id}/comments`, { body: reply[c.id], parent_id: c.id }); setReply({ ...reply, [c.id]: '' }) } }} />
            <button className="small" onClick={() => post(`/api/doc-comments/${c.id}`, { resolved: !c.resolved })}>{c.resolved ? 'Reopen' : '✓ Resolve'}</button>
            <button className="small" title="Delete" onClick={() => post(`/api/doc-comments/${c.id}`, { delete: true })}>🗑</button>
          </div>}
        </div>
      ))}
    </div>
  )
}

function ResearchPanel({ id, items, onOpenChat, onAsk }: { id: string; items: Research[]; onOpenChat: (id: string) => void; onAsk: () => void }) {
  const [adding, setAdding] = useState(false)
  const [f, setF] = useState({ title: '', url: '', quote: '', note: '' })
  return (
    <div className="doc-research">
      <div className="row-flex"><button className="small" onClick={onAsk} title="Ask the doc's agent to find sources and evidence">🤖 Ask an agent to find evidence</button><button className="small" onClick={() => setAdding(!adding)}>+ Add</button></div>
      {adding && <div className="doc-research-form">
        <input placeholder="Title" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} />
        <input placeholder="Link" value={f.url} onChange={e => setF({ ...f, url: e.target.value })} />
        <textarea placeholder="Quote or data" rows={2} value={f.quote} onChange={e => setF({ ...f, quote: e.target.value })} />
        <input placeholder="How it helps" value={f.note} onChange={e => setF({ ...f, note: e.target.value })} />
        <button className="primary small" disabled={!f.title.trim()} onClick={async () => { await post(`/api/docs/${id}/research`, f); setF({ title: '', url: '', quote: '', note: '' }); setAdding(false) }}>Save</button>
      </div>}
      {items.length === 0 && <div className="muted small pad">Sources, quotes and data for this piece land here. Agents add them with the doc tool (action=research).</div>}
      {items.map(r => (
        <div key={r.id} className={`doc-research-item ${r.author_kind}`}>
          <div className="row-flex small"><Who kind={r.author_kind} name={r.author_name} conversation={r.conversation_id} onOpenChat={onOpenChat} /><span className="grow" /><span className="muted">{ago(r.created_at)}</span>
            <button className="icon small" title="Remove" onClick={() => post(`/api/doc-research/${r.id}/delete`)}>×</button></div>
          <b>{r.url ? <a href={r.url} onClick={e => { e.preventDefault(); window.open(r.url!, '_blank') }}>{r.title}</a> : r.title}</b>
          {r.quote && <div className="quote small">“{r.quote}”</div>}
          {r.note && <div className="small">{r.note}</div>}
          <button className="link small" title="Copy as a markdown citation" onClick={() => copyText(r.url ? `[${r.title}](${r.url})` : r.title).then(() => toast('Copied citation', { kind: 'ok' }))}>Copy citation</button>
        </div>
      ))}
    </div>
  )
}

function Versions({ id, versions, current, onRestored, before }: { id: string; versions: Version[]; current: () => string; onRestored: () => void; before: () => Promise<void> }) {
  const [label, setLabel] = useState('')
  const [open, setOpen] = useState<{ id: string; text: string } | null>(null)
  const peek = async (v: Version) => { if (open?.id === v.id) return setOpen(null); const r = await api.get(`/api/doc-versions/${v.id}`); setOpen({ id: v.id, text: r.text }) }
  return (
    <div className="doc-versions">
      <div className="row-flex"><input className="grow small" value={label} placeholder="Name this version…" onChange={e => setLabel(e.target.value)} />
        <button className="small primary" onClick={async () => { await before(); await post(`/api/docs/${id}/versions`, { label: label || 'Saved version' }); setLabel('') }}>Save version</button></div>
      <div className="muted small">A version is kept on its own every 10 minutes while you write, and before any agent edit or restore.</div>
      {versions.map(v => (
        <div key={v.id} className={`doc-version ${v.author_kind}`}>
          <div className="row-flex small" onClick={() => peek(v)} style={{ cursor: 'pointer' }}>
            <span>{v.author_kind === 'agent' ? '🤖' : '●'}</span><b className="grow ellipsis">{v.label || v.author_name || 'Autosave'}</b><span className="muted">{ago(v.created_at)} · {Math.round(v.size / 100) / 10}k</span>
          </div>
          {open?.id === v.id && <>
            <Diff a={open.text} b={current()} />
            <div className="row-flex"><button className="small" onClick={async () => { await before(); if (confirm('Replace the text with this version? The current text is saved as a version first.')) { await post(`/api/doc-versions/${v.id}/restore`); onRestored() } }}>Restore this version</button>
              <button className="small" onClick={() => copyText(open.text)}>Copy its text</button></div>
          </>}
        </div>
      ))}
    </div>
  )
}

// A line diff: what changed between that version (a) and now (b).
function Diff({ a, b }: { a: string; b: string }) {
  const rows = useMemo(() => {
    const x = a.split('\n'), y = b.split('\n')
    if (x.length * y.length > 4_000_000) return [{ k: '=', t: 'Too long to compare line by line.' }]
    const n = x.length, m = y.length, L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
    const out: { k: string; t: string }[] = []
    let i = 0, j = 0
    while (i < n || j < m) {
      if (i < n && j < m && x[i] === y[j]) { out.push({ k: '=', t: x[i] }); i++; j++ }
      else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { out.push({ k: '+', t: y[j] }); j++ }
      else { out.push({ k: '-', t: x[i] }); i++ }
    }
    // Only changes, with a line of context.
    return out.filter((r, idx) => r.k !== '=' || (out[idx - 1] && out[idx - 1].k !== '=') || (out[idx + 1] && out[idx + 1].k !== '='))
  }, [a, b])
  if (!rows.some(r => r.k !== '=')) return <div className="muted small">Same as now.</div>
  return <div className="doc-diff">{rows.slice(0, 400).map((r, i) => <div key={i} className={`d${r.k === '+' ? 'add' : r.k === '-' ? 'del' : 'ctx'}`}>{r.k === '=' ? ' ' : r.k} {r.t || ' '}</div>)}<div className="muted small">− in that version · + now</div></div>
}

function AgentPanel({ doc, selection, settings, onOpenChat }: { doc: Doc; selection: { text: string } | null; settings: any; onOpenChat: (id: string) => void }) {
  const [ask, setAsk] = useState('')
  const [busy, setBusy] = useState(false)
  const locked = doc.agent_text === 'blocked'
  const start = async (q: string) => {
    setBusy(true)
    const brief = `You're helping me with a document I'm writing in the auto-m8 editor: "${doc.title}" (doc_id ${doc.id}, file ${doc.path}). Read it with the auto-m8 doc tool (action=read doc_id=${doc.id}). ` +
      (locked ? 'It is in NO AGENT TEXT mode: I write every word. Do not change the text in any way; give feedback as comments (doc action=comment with the exact quote) and put sources and evidence in research (doc action=research). ' : 'You may edit it with doc action=edit when I ask you to write; otherwise prefer comments (doc action=comment) and research (doc action=research). ') +
      'Comments and research you add show up beside the text, marked as yours. Keep replies here short.' +
      (selection ? `\n\nI have this passage selected:\n> ${selection.text.slice(0, 2000).replace(/\n/g, '\n> ')}` : '') + `\n\n${q}`
    try {
      const r = await sendChat<{ id: string }>({ prompt: brief, cwd: doc.path.replace(/\/[^/]+$/, '') })
      if (r?.id) await post(`/api/docs/${doc.id}`, { conversation_id: r.id })
      setAsk('')
    } finally { setBusy(false) }
  }
  const quick = locked
    ? ['Review this draft: leave comments on what is unclear or weak', 'Find evidence and sources for the main claims and add them as research', 'Point out anything that sounds AI-written, as comments']
    : ['Review this draft: leave comments on what is unclear or weak', 'Find evidence and sources for the main claims and add them as research', 'Tighten the intro']
  if (doc.conversation_id) return (
    <div className="doc-agent">
      <div className="row-flex small"><span className="muted grow">The chat working on this doc.</span>
        <button className="link small" onClick={() => onOpenChat(doc.conversation_id!)}>Open full ↗</button>
        <button className="link small" onClick={() => post(`/api/docs/${doc.id}`, { conversation_id: null })}>New chat</button></div>
      <div className="doc-agent-chat"><Chat key={doc.conversation_id} id={doc.conversation_id} onOpen={onOpenChat} onTerminal={() => {}} settings={settings} compact panel detailsOpen={false} onToggleDetails={() => {}} /></div>
    </div>
  )
  return (
    <div className="doc-agent">
      <div className="muted small">{locked ? 'No agent text is on: the agent can comment and research, but cannot write the text.' : 'The agent can comment, research and, when you ask, edit.'}</div>
      {selection && <div className="quote small">Selected: “{selection.text.slice(0, 140)}{selection.text.length > 140 ? '…' : ''}”</div>}
      <textarea rows={3} value={ask} placeholder="Ask an agent about this doc…" onChange={e => setAsk(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ask.trim()) start(ask.trim()) }} />
      <button className="primary small" disabled={!ask.trim() || busy} onClick={() => start(ask.trim())}>{busy ? 'Starting…' : 'Start'}</button>
      <div className="section-head">Or</div>
      {quick.map(q => <button key={q} className="small doc-quick" disabled={busy} onClick={() => start(q)}>{q}</button>)}
    </div>
  )
}

function CheckPanel({ id, grammar, setGrammar, tells, setTells, dialect, setDialect, ai, setAi, text, onJump }: {
  id: string; grammar: boolean; setGrammar: (b: boolean) => void; tells: boolean; setTells: (b: boolean) => void; dialect: number; setDialect: (n: number) => void
  ai: AiResult | null; setAi: (r: AiResult | null) => void; text: () => string; onJump: (from: number | null, to?: number | null) => void
}) {
  const { data: pg, reload } = useLive<{ configured: boolean }>('/api/writing/pangram')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const run = async () => {
    setBusy(true); setErr(null)
    const r: any = await post(`/api/docs/${id}/ai-check`, { text: text() }).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (r?.error) setErr(r.error); else setAi(r)
  }
  const pct = (x: number) => `${Math.round((x ?? 0) * 100)}%`
  return (
    <div className="doc-check">
      <div className="section-head">While you write</div>
      <label><input type="checkbox" checked={grammar} onChange={e => setGrammar(e.target.checked)} /> Spelling and grammar <span className="muted small">(Harper, on this Mac; nothing leaves it)</span></label>
      {grammar && <label className="small">English: <select value={dialect} onChange={e => setDialect(Number(e.target.value))}>{['American', 'British', 'Australian', 'Canadian', 'Indian'].map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>}
      <label><input type="checkbox" checked={tells} onChange={e => setTells(e.target.checked)} /> Sounds-like-AI phrases <span className="muted small">(em dashes, “delve”, “not X, it’s Y”…)</span></label>
      <div className="muted small">Underlines: <span className="cm-spell">spelling</span> · <span className="cm-grammar">grammar</span> · <span className="cm-ai-tell">sounds like AI</span>. Hover for suggestions; click one to apply.</div>

      <div className="section-head">AI-text check</div>
      <div className="muted small">Pangram is the detector with the lowest false-positive rates in independent tests. Nothing is perfect: treat its verdict as a signal, not proof. Checking sends this doc's text to Pangram with your key.</div>
      {pg && !pg.configured && <div className="row-flex"><input className="grow small" type="password" value={key} placeholder="Pangram API key" onChange={e => setKey(e.target.value)} />
        <button className="small" disabled={!key.trim()} onClick={async () => { await post('/api/writing/pangram', { key }); setKey(''); reload() }}>Save</button></div>}
      {pg?.configured && <div className="row-flex"><button className="primary small" disabled={busy} onClick={run}>{busy ? 'Checking…' : ai ? 'Check again' : 'Check with Pangram'}</button>
        <button className="link small" onClick={async () => { await post('/api/writing/pangram', { clear: true }); reload() }}>Remove key</button></div>}
      {err && <div className="small error">{err}</div>}
      {ai && <div className="doc-ai">
        <div><b>{ai.verdict}</b> <span className="muted small">{ai.headline} · {ago(ai.at)}</span></div>
        <div className="doc-ai-bar"><span className="h" style={{ width: pct(ai.fraction_human) }} /><span className="as" style={{ width: pct(ai.fraction_ai_assisted) }} /><span className="ai" style={{ width: pct(ai.fraction_ai) }} /></div>
        <div className="small muted">Human {pct(ai.fraction_human)} · AI-assisted {pct(ai.fraction_ai_assisted)} · AI {pct(ai.fraction_ai)}</div>
        {ai.windows.filter(w => w.label !== 'Human Written').map((w, i) => (
          <button key={i} className="doc-ai-win small" disabled={w.start == null} onClick={() => onJump(w.start, w.end)}>
            <span className={w.label === 'AI-Generated' ? 'cm-ai-gen' : 'cm-ai-assist'}>{w.label}</span> {pct(w.score)} · {w.confidence}{w.start == null ? ' (changed since)' : ''}
          </button>))}
        <button className="link small" onClick={() => setAi(null)}>Clear highlights</button>
      </div>}
    </div>
  )
}

// ---------- export ----------
const exportMd = new Marked({ gfm: true, renderer: { html: () => '' } }) // raw HTML in the doc is dropped, never run
function ExportMenu({ id, title, path, text }: { id: string; title: string; path: string; text: () => string }) {
  const [open, setOpen] = useState(false)
  const html = () => exportMd.parse(text()) as string
  const richCopy = async () => {
    const h = html()
    try { await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([h], { type: 'text/html' }), 'text/plain': new Blob([text()], { type: 'text/plain' }) })]); return true }
    catch { return copyText(text()) }
  }
  const download = (name: string, body: string, type: string) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([body], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000) }
  const slug = (title || 'doc').replace(/[^\w-]+/g, '-').slice(0, 60)
  const pdf = () => {
    // Print just the document; the system dialog has "Save as PDF".
    const el = document.createElement('div')
    el.className = 'doc-print'
    el.innerHTML = html()
    document.body.appendChild(el)
    document.body.classList.add('printing-doc')
    const done = () => { el.remove(); document.body.classList.remove('printing-doc'); removeEventListener('afterprint', done) }
    addEventListener('afterprint', done)
    setTimeout(() => { window.print(); setTimeout(done, 1000) }, 50)
  }
  const items: [string, () => unknown][] = [
    ['PDF (print → Save as PDF)', pdf],
    ['Copy for Google Docs, then open a new one', async () => { if (await richCopy()) { toast('Copied with formatting', { kind: 'ok', action: 'Paste it into the new Google Doc (⌘V)' }); window.open('https://docs.new', '_blank') } }],
    ['Copy as rich text', async () => { if (await richCopy()) toast('Copied with formatting', { kind: 'ok' }) }],
    ['Copy for Slack', async () => { const r = await post(`/api/docs/${id}/slack`, { text: text() }); if (r?.text && await copyText(r.text)) toast('Copied in Slack formatting', { kind: 'ok' }) }],
    ['Copy markdown', async () => { if (await copyText(text())) toast('Copied markdown', { kind: 'ok' }) }],
    ['Download .md', () => download(`${slug}.md`, text(), 'text/markdown')],
    ['Download .html', () => download(`${slug}.html`, `<!doctype html><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title><body style="max-width:720px;margin:40px auto;font:17px/1.6 Georgia,serif">${html()}</body>`, 'text/html')],
    ['Copy file path', async () => { if (await copyText(path)) toast('Copied path', { kind: 'ok' }) }],
  ]
  return (
    <div className="doc-export">
      <button className="icon" title="Export" onClick={() => setOpen(!open)}>⇪</button>
      {open && <div className="doc-export-menu" onMouseLeave={() => setOpen(false)}>{items.map(([l, f]) => <button key={l} onClick={() => { setOpen(false); f() }}>{l}</button>)}</div>}
    </div>
  )
}
