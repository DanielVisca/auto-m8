// Writing: a markdown editor for the long documents you sometimes open (blog drafts, ideas lists),
// with what a doc editor gives you around the text: comments (yours and agents', always labelled),
// research and evidence agents gather, versions, draft/final, export, on-device grammar and spelling
// (Harper), an "AI tells" check, an optional Pangram AI-text check, an agent chat beside it, and a
// "no agent text" mode where agents may only comment and research. Zen hides everything but the page.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Marked } from 'marked'
import { Annotation, ChangeSet, Compartment, EditorSelection, EditorState, StateEffect, StateField, Transaction, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, drawSelection, placeholder, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { linter, forceLinting, forEachDiagnostic, setDiagnostics, type Diagnostic } from '@codemirror/lint'
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
const previewMode = new Compartment()
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

// Live preview: the page reads like a document. Markdown's marks (# for headings, ** for bold, list
// dashes, link brackets and addresses, <!-- --> around notes) are hidden, except on the lines your
// cursor or selection is on, where they show so you can edit them. Notes in <!-- --> show dimmed.
class Bullet extends WidgetType {
  toDOM() { const s = document.createElement('span'); s.className = 'cm-md-bullet'; s.textContent = '•'; return s }
  eq() { return true }
}
const hide = Decoration.replace({}), bullet = Decoration.replace({ widget: new Bullet() })
const noteMark = Decoration.mark({ class: 'cm-md-note' }), quoteLine = Decoration.line({ class: 'cm-md-quote' })
function previewDecos(view: EditorView): DecorationSet {
  const { state } = view, doc = state.doc
  const active = new Set<number>()
  if (view.hasFocus) for (const r of state.selection.ranges) for (let l = doc.lineAt(r.from).number; l <= doc.lineAt(r.to).number; l++) active.add(l)
  const on = (pos: number) => active.has(doc.lineAt(pos).number)
  const out: Range<Decoration>[] = []
  const hideRange = (from: number, to: number) => { if (to > from && doc.lineAt(from).number === doc.lineAt(to).number && !on(from)) out.push(hide.range(from, to)) }
  for (const { from, to } of view.visibleRanges) syntaxTree(state).iterate({ from, to, enter: n => {
    const name = n.name
    if (name === 'HeaderMark') { const after = doc.sliceString(n.to, n.to + 1) === ' ' ? 1 : 0; hideRange(n.from, n.to + after) }
    else if (name === 'EmphasisMark' || name === 'CodeMark' || name === 'StrikethroughMark') hideRange(n.from, n.to)
    else if (name === 'ListMark') { const t = doc.sliceString(n.from, n.to); if (/^[-*+]$/.test(t) && !on(n.from)) out.push(bullet.range(n.from, n.to)) }
    else if (name === 'QuoteMark') { if (!on(n.from)) { out.push(quoteLine.range(doc.lineAt(n.from).from)); hideRange(n.from, n.to + (doc.sliceString(n.to, n.to + 1) === ' ' ? 1 : 0)) } }
    else if (name === 'Link') {
      // [text](url): keep the text, hide the brackets and the address.
      const c = n.node.cursor(); const marks: [number, number][] = []
      if (c.firstChild()) do { if (c.name === 'LinkMark' || c.name === 'URL' || c.name === 'LinkTitle') marks.push([c.from, c.to]) } while (c.nextSibling())
      if (marks.length >= 2) { hideRange(marks[0][0], marks[0][1]); hideRange(marks[1][0], n.to) }
      return false
    }
    else if (name === 'CommentBlock' || name === 'Comment' || (name === 'HTMLBlock' && /^\s*<!--/.test(doc.sliceString(n.from, n.from + 8)))) {
      for (let pos = n.from; pos <= n.to;) {
        const line = doc.lineAt(pos)
        const a = Math.max(line.from, n.from), b = Math.min(line.to, n.to)
        if (b > a) out.push(noteMark.range(a, b))
        pos = line.to + 1
      }
      const text = doc.sliceString(n.from, n.to)
      if (text.startsWith('<!--')) hideRange(n.from, n.from + 4 + (text[4] === ' ' ? 1 : 0))
      if (text.trimEnd().endsWith('-->')) { const end = n.from + text.trimEnd().length; hideRange(end - 3 - (text[text.trimEnd().length - 4] === ' ' ? 1 : 0), end) }
      return false
    }
  } })
  return Decoration.set(out, true)
}
const livePreview = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(v: EditorView) { this.decorations = previewDecos(v) }
  update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = previewDecos(u.view) }
}, { decorations: v => v.decorations })

// Harper counts characters as code points; the editor counts UTF-16 units. Only differs around emoji.
function codePointMap(text: string) {
  if (!/[\uD800-\uDBFF]/.test(text)) return (i: number) => i
  const map: number[] = []
  let u = 0
  for (const ch of text) { map.push(u); u += ch.length }
  map.push(u)
  return (i: number) => map[Math.min(i, map.length - 1)]
}

// Your dictionary: kept by auto-m8 so every window shares it. Words in it never show as misspelled.
const dictionary = new Set<string>()
// Marks changes that came from elsewhere (an agent, another window, the file on disk), not your typing.
const remote = Annotation.define<boolean>()

// On-device grammar and spelling: Harper in a web worker, loaded the first time a doc opens.
let harper: Promise<any> | null = null
function harperLinter(dialect: number) {
  harper ??= (async () => {
    const [{ WorkerLinter }, { binary }] = await Promise.all([import('harper.js'), import('harper.js/binary')])
    const l = new WorkerLinter({ binary, dialect })
    await l.setup()
    if (dictionary.size) await l.importWords([...dictionary])
    return l
  })().catch(e => { harper = null; throw e })
  return harper
}
// Called from the docs list: start Harper (a 20 MB wasm compiled in a worker) before you pick a doc,
// so its first marks don't wait on the download and compile.
export function warmWriting() { harperLinter(local('perch.writing.dialect', 0)).catch(() => {}) }

// Take the underline off at once (every copy of the word for the dictionary), without waiting for the next check.
function dropMarks(v: EditorView, word: string, everywhere: boolean, message?: string) {
  const keepIt: Diagnostic[] = []
  forEachDiagnostic(v.state, (d, from, to) => {
    const text = v.state.sliceDoc(from, to)
    const same = everywhere ? d.markClass === 'cm-spell' && text.toLowerCase() === word.toLowerCase() : text === word && d.message === message
    if (!same) keepIt.push({ ...d, from, to })
  })
  v.dispatch(setDiagnostics(v.state, keepIt))
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
// Side by side: your draft on the left, a second page on the right (a blank one to write it out
// yourself, or any other doc). The pair is remembered per doc, so reopening the draft brings it back.
export function DocSplit({ id, onOpenChat, settings, zen }: { id: string; onOpenChat: (id: string) => void; settings: any; zen: boolean }) {
  const [other, setOther] = useState<string | null>(() => local(`perch.writing.pair.${id}`, null))
  const [busy, setBusy] = useState(false)
  const { data: list } = useLive<{ docs: Doc[] }>(other ? '/api/docs' : null, ['docs'])
  const pair = (next: string | null) => { setOther(next); keep(`perch.writing.pair.${id}`, next) }
  const blank = async (title: string) => {
    setBusy(true)
    try { const d = await post<{ id?: string; error?: string }>('/api/docs', { title }); if (d?.id) pair(d.id); else toast(d?.error || 'Could not make a new page', { kind: 'error' }) } finally { setBusy(false) }
  }
  const split = async (title: string) => { if (other) pair(null); else await blank(title) }
  const picker = other && (
    <select className="small writing-pick" value={other} title="The page on the right" onChange={e => e.target.value === '+' ? blank(`${(list?.docs.find(d => d.id === id)?.title || 'Untitled')} (my version)`) : pair(e.target.value)}>
      {!list?.docs.some(d => d.id === other) && <option value={other}>This page</option>}
      {(list?.docs ?? []).filter(d => d.id !== id).map(d => <option key={d.id} value={d.id}>{d.title || 'Untitled'}</option>)}
      <option value="+">+ New blank page</option>
    </select>
  )
  return (
    <div className={`writing-split ${other ? 'two' : ''}`}>
      <DocEditor key={id} id={id} onOpenChat={onOpenChat} settings={settings} zen={zen} paired={!!other} split={!!other} splitBusy={busy} onSplit={split} />
      {other && <DocEditor key={other} id={other} onOpenChat={onOpenChat} settings={settings} zen={zen} paired extra={picker} onClose={() => pair(null)} />}
    </div>
  )
}

export function DocEditor({ id, onOpenChat, settings, zen, paired, split, splitBusy, onSplit, onClose, extra }: {
  id: string; onOpenChat: (id: string) => void; settings: any; zen: boolean
  paired?: boolean; split?: boolean; splitBusy?: boolean; onSplit?: (title: string) => void; onClose?: () => void; extra?: ReactNode
}) {
  const { data, reload } = useLive<Full>(`/api/docs/${id}`, ['docs'])
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const rev = useRef<number>(-1)
  const base = useRef('') // the server's text your unsaved edits sit on top of
  const pending = useRef<ChangeSet | null>(null) // your edits since then: base → what's on screen
  const sent = useRef<ChangeSet | null>(null) // edits made while a save is on its way
  const latest = useRef<Full | undefined>(undefined)
  latest.current = data
  const dirty = useRef(false)
  const saving = useRef<Promise<void> | null>(null)
  const timer = useRef<any>(null)
  const [state, setState] = useState<'saved' | 'saving' | 'unsaved'>('saved')
  const { data: words } = useLive<{ words: string[] }>('/api/writing/words', ['docs'])
  useEffect(() => {
    // Words added before the dictionary was shared lived in this window only: move them over once.
    const old = local<string[]>('perch.writing.words', [])
    if (old.length) { old.forEach(w => post('/api/writing/words', { add: w })); try { localStorage.removeItem('perch.writing.words') } catch {} }
  }, [])
  useEffect(() => {
    if (!words) return
    const before = dictionary.size
    for (const w of words.words) dictionary.add(w.toLowerCase())
    if (dictionary.size !== before && view.current) { forceLinting(view.current); harperLinter(opts.current.dialect).then(l => l.importWords(words.words)).catch(() => {}) }
  }, [words])
  const [tab, setTab] = useState<'comments' | 'research' | 'versions' | 'agent' | 'check'>(() => local('perch.writing.tab', 'comments'))
  const [panel, setPanel] = useState(() => !paired && local('perch.writing.panel', true))
  const [selection, setSelection] = useState<{ from: number; to: number; text: string } | null>(null)
  const [activeComment, setActiveComment] = useState<string | null>(null)
  const [grammar, setGrammar] = useState(() => local('perch.writing.grammar', true))
  const [tells, setTells] = useState(() => local('perch.writing.tells', true))
  const [dialect, setDialect] = useState<number>(() => local('perch.writing.dialect', 0))
  const [ai, setAi] = useState<AiResult | null>(() => local(`perch.writing.ai.${id}`, null))
  const [wordCount, setWordCount] = useState(0)
  const [raw, setRaw] = useState(() => local('perch.writing.raw', false))
  const [menu, setMenu] = useState<{ x: number; y: number; pos: number } | null>(null)
  const opts = useRef({ grammar, tells, dialect })
  opts.current = { grammar, tells, dialect }
  useEffect(() => keep('perch.writing.tab', tab), [tab])
  useEffect(() => { if (!paired) keep('perch.writing.panel', panel) }, [panel]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPanel(paired ? false : local('perch.writing.panel', true)) }, [paired])
  useEffect(() => { keep('perch.writing.grammar', grammar); keep('perch.writing.tells', tells); keep('perch.writing.dialect', dialect); if (view.current) forceLinting(view.current) }, [grammar, tells, dialect])

  // A change from elsewhere lands under your cursor: what changed between the base and their text is
  // mapped over your unsaved edits, so both stay and nothing you're typing moves or is lost.
  const merge = (theirs: string, newRev: number) => {
    const v = view.current
    if (!v) return
    if (theirs !== base.current) {
      const t = diffChanges(base.current, theirs)
      const mine = pending.current
      const changes = mine && !mine.empty ? t.map(mine) : t
      if (mine && !mine.empty) pending.current = mine.map(t, true)
      v.dispatch({ changes, annotations: [remote.of(true), Transaction.addToHistory.of(false)] })
      base.current = theirs
      // Belt and braces: if the bookkeeping ever drifts, rebuild it from the two texts.
      const now = v.state.doc.toString()
      if (pending.current && pending.current.length !== theirs.length) pending.current = diffChanges(theirs, now)
      if (!pending.current && now !== theirs) pending.current = diffChanges(theirs, now)
    }
    rev.current = newRev
  }

  const save = async () => {
    const v = view.current
    if (!v || !dirty.current) return
    if (saving.current) { await saving.current; return save() }
    saving.current = (async () => {
      setState('saving')
      const text = v.state.doc.toString()
      dirty.current = false
      sent.current = ChangeSet.empty(text.length)
      const r: any = await post(`/api/docs/${id}/save`, { text, rev: rev.current, anchors: anchorsOf(v.state) }).catch(() => ({ error: 'offline' }))
      const after = sent.current
      sent.current = null
      if (r?.ok) {
        base.current = text; rev.current = r.rev
        pending.current = after && !after.empty ? after : null
        dirty.current = !!pending.current
        setState(dirty.current ? 'unsaved' : 'saved')
      } else if (r?.conflict) {
        // Changed elsewhere since our last look: merge theirs in, then save the result.
        merge(r.text, r.rev)
        dirty.current = true; setState('unsaved'); setTimeout(save, 50)
      } else { dirty.current = true; setState('unsaved'); clearTimeout(timer.current); timer.current = setTimeout(save, 3000) }
    })()
    try { await saving.current } finally { saving.current = null }
    // Anything that arrived while saving.
    const d = latest.current
    if (d?.doc && d.doc.rev > rev.current) merge(d.text, d.doc.rev)
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
            if (kind === 'Spelling' && dictionary.has(problem.toLowerCase())) continue
            if (kind === 'Capitalization' && /^#{1,6}\s/.test(v.state.doc.lineAt(from).text)) continue // headings are yours to case
            const spelling = kind === 'Spelling', message = lint.message()
            out.push({
              from, to, severity: spelling ? 'error' : 'warning', source: lint.lint_kind_pretty(), message, markClass: spelling ? 'cm-spell' : 'cm-grammar',
              actions: [
                ...lint.suggestions().slice(0, 4).map((s: any) => {
                  const rep = s.get_replacement_text(), k = s.kind()
                  const name = k === 1 ? 'Remove' : rep ? `→ ${rep}` : 'Fix'
                  return { name, apply: (ev: EditorView, f: number, t: number) => ev.dispatch({ changes: k === 2 ? { from: t, insert: rep } : { from: f, to: t, insert: k === 1 ? '' : rep } }) }
                }),
                ...(spelling ? [{ name: 'Add to dictionary', apply: (ev: EditorView) => { dictionary.add(problem.toLowerCase()); dropMarks(ev, problem, true); post('/api/writing/words', { add: problem }); harperLinter(opts.current.dialect).then(l => l.importWords([problem])).catch(() => {}) } }] : []),
                { name: 'Ignore', apply: (ev: EditorView) => { keep('perch.writing.ignored', [...ignored, `${kind}|${problem}`]); dropMarks(ev, problem, false, message) } },
              ],
            })
          }
        } catch (e) { console.warn('grammar check unavailable', e) }
      }
      return out
    }, { delay: 900 })
    const extensions: Extension[] = [
      history(), drawSelection(), markdown({ base: markdownLanguage }), syntaxHighlighting(mdStyle), EditorView.lineWrapping, previewMode.of(local('perch.writing.raw', false) ? [] : livePreview),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab,
        { key: 'Mod-s', run: () => { save(); return true } },
        { key: 'Mod-Alt-m', run: v => { const s = v.state.selection.main; if (!s.empty) { setPanel(true); setTab('comments'); window.dispatchEvent(new CustomEvent('perch-doc-comment', { detail: id })) } return true } },
        { key: 'Mod-b', run: v => wrap(v, '**') }, { key: 'Mod-i', run: v => wrap(v, '_') }, { key: 'Mod-e', run: v => wrap(v, '`') },
        { key: 'Mod-Shift-x', run: v => wrap(v, '~~') }, { key: 'Mod-k', run: v => link(v) },
        { key: 'Mod-Alt-1', run: v => linePrefix(v, '# ') }, { key: 'Mod-Alt-2', run: v => linePrefix(v, '## ') }, { key: 'Mod-Alt-3', run: v => linePrefix(v, '### ') }, { key: 'Mod-Alt-0', run: v => linePrefix(v, '') }]),
      placeholder('Start writing…'), commentField, aiField, lint,
      EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', 'aria-label': 'Document text' }),
      EditorView.updateListener.of(u => {
        for (const tr of u.transactions) if (tr.docChanged && !tr.annotation(remote)) {
          pending.current = pending.current ? pending.current.compose(tr.changes) : tr.changes
          if (sent.current) sent.current = sent.current.compose(tr.changes)
          dirty.current = true; setState('unsaved'); clearTimeout(timer.current); timer.current = setTimeout(save, 1200)
        }
        if (u.docChanged) setWordCount(countWords(u.state.doc.toString()))
        if (u.selectionSet || u.docChanged) {
          const s = u.state.selection.main
          setSelection(s.empty ? null : { from: s.from, to: s.to, text: u.state.sliceDoc(s.from, s.to) })
        }
      }),
      EditorView.domEventHandlers({
        contextmenu: (e, v) => {
          // Right-click on the text: the editor's own menu (suggestions, comment, agent, formatting, clipboard).
          const pos = v.posAtCoords({ x: e.clientX, y: e.clientY })
          if (pos == null) return false
          const sel = v.state.selection.main
          if (sel.empty || pos < sel.from || pos > sel.to) v.dispatch({ selection: { anchor: pos } })
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, pos })
          return true
        },
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

  // Text from the server: the first load, then every change made elsewhere, merged in live.
  useEffect(() => {
    const v = view.current
    if (!v || !data?.doc) return
    if (rev.current < 0) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: data.text }, annotations: [remote.of(true), Transaction.addToHistory.of(false)] })
      base.current = data.text; pending.current = null; rev.current = data.doc.rev; dirty.current = false
      setState('saved'); setWordCount(countWords(data.text))
    } else if (data.doc.rev > rev.current && !saving.current) merge(data.text, data.doc.rev)
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
          {extra ?? <b className="ellipsis" title={doc.path}>{doc.title || 'Untitled'}</b>}
          <button className={`chip-btn ${doc.status}`} title="Draft or final. Final saves a named version." onClick={async () => { await save(); if (doc.status === 'draft') await post(`/api/docs/${id}/versions`, { label: 'Final' }); setDoc({ status: doc.status === 'draft' ? 'final' : 'draft' }) }}>{doc.status === 'draft' ? '✎ Draft' : '✓ Final'}</button>
          <button className={`chip-btn ${locked ? 'on locked' : ''}`} title={locked ? 'No agent text: agents can comment and research, but every word of the text is yours. Click to let agents edit.' : 'Agents may edit the text. Click for no agent text mode.'}
            onClick={() => setDoc({ agent_text: locked ? 'allowed' : 'blocked' })}>{locked ? '✍ No agent text' : '🤖 Agents may edit'}</button>
          <span className="grow" />
          <span className={`muted small save-${state}`} title="Live: changes from agents, other windows and the file itself merge in as they happen">{state === 'saved' ? '● Live · saved' : state === 'saving' ? 'Saving…' : 'Unsaved'} · {wordCount.toLocaleString()} words</span>
          <button className="icon" title="Comment on the selection  ⌘⌥M" disabled={!selection} onClick={() => { setPanel(true); setTab('comments'); setTimeout(() => window.dispatchEvent(new CustomEvent('perch-doc-comment', { detail: id })), 0) }}>💬</button>
          <button className={`icon ${raw ? 'on' : ''}`} title={raw ? 'Showing markdown marks. Click for the clean page.' : 'Show markdown marks (#, **, links) everywhere'} onClick={() => { const next = !raw; setRaw(next); keep('perch.writing.raw', next); view.current?.dispatch({ effects: previewMode.reconfigure(next ? [] : livePreview) }) }}>{'</>'}</button>
          <ExportMenu id={id} title={doc.title} path={doc.path} text={textNow} />
          <button className={`icon ${zen ? 'on' : ''}`} title={zen ? 'Leave zen  ⌘⇧F' : 'Zen: just the page'} onClick={() => api.send('PUT', '/api/settings', { focus: { ...(settings?.focus ?? { areas: [] }), active: !zen } })}>◎</button>
          {!zen && <button className={`icon ${panel ? 'on' : ''}`} title="Comments, research, versions, agent" onClick={() => setPanel(!panel)}>▤</button>}
          {onSplit && <button className={`icon ${split ? 'on' : ''}`} disabled={splitBusy} title={split ? 'Close the page beside this one' : 'Side by side: a blank page beside this one, to write it out yourself'} onClick={() => onSplit(`${doc.title || 'Untitled'} (my version)`)}>◫</button>}
          {onClose && <button className="icon" title="Close this side" onClick={() => { save(); onClose() }}>✕</button>}
        </div>
        {!doc.exists && <div className="writing-conflict">The file at {doc.path} is missing; typing will create it again.</div>}
        <div className="writing-scroll"><div className="writing-page" ref={host} /></div>
        {menu && view.current && <EditorMenu at={menu} view={view.current} onClose={() => { setMenu(null); view.current?.focus() }}
          onComment={() => { setPanel(true); setTab('comments'); setTimeout(() => window.dispatchEvent(new CustomEvent('perch-doc-comment', { detail: id })), 0) }}
          onAgent={() => { setPanel(true); setTab('agent') }} onCheck={() => { setPanel(true); setTab('check') }} />}
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
              ai={ai} setAi={r => { setAi(r); keep(`perch.writing.ai.${id}`, r) }} text={textNow} selection={selection} onJump={jump} />}
          </div>
        </aside>
      )}
    </div>
  )
}

const countWords = (t: string) => (t.match(/[\p{L}\p{N}'’-]+/gu) ?? []).length
// The changes that turn text a into text b, as small separate edits (line by line inside the part that
// differs), so merging someone else's edit never rewrites the paragraph you're typing in.
export function diffChanges(a: string, b: string): ChangeSet {
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let q = 0
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++
  const A = a.slice(p, a.length - q), B = b.slice(p, b.length - q)
  if (!A && !B) return ChangeSet.empty(a.length)
  const la = A.match(/[^\n]*\n|[^\n]+$/g) ?? [], lb = B.match(/[^\n]*\n|[^\n]+$/g) ?? []
  if (la.length * lb.length > 4_000_000 || la.length < 2 || lb.length < 2) return ChangeSet.of([{ from: p, to: a.length - q, insert: B }], a.length)
  const n = la.length, m = lb.length, L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = la[i] === lb[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const specs: { from: number; to: number; insert: string }[] = []
  let i = 0, j = 0, at = p, hunk: { from: number; to: number; insert: string } | null = null
  const flush = () => { if (hunk) { specs.push(hunk); hunk = null } }
  while (i < n || j < m) {
    if (i < n && j < m && la[i] === lb[j]) { flush(); at += la[i].length; i++; j++ }
    else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { hunk ??= { from: at, to: at, insert: '' }; hunk.insert += lb[j]; j++ }
    else { hunk ??= { from: at, to: at, insert: '' }; at += la[i].length; hunk.to = at; i++ }
  }
  flush()
  return ChangeSet.of(specs, a.length)
}

// ---------- formatting ----------
// Toggle a markdown wrapper (** for bold, _ italic, ` code, ~~ strikethrough) around each selection.
function wrap(v: EditorView, mark: string) {
  const { state } = v
  v.dispatch(state.changeByRange(r => {
    const text = state.sliceDoc(r.from, r.to)
    const before = state.sliceDoc(r.from - mark.length, r.from), after = state.sliceDoc(r.to, r.to + mark.length)
    if (before === mark && after === mark) // already wrapped just outside: unwrap
      return { changes: [{ from: r.from - mark.length, to: r.from }, { from: r.to, to: r.to + mark.length }], range: EditorSelection.range(r.from - mark.length, r.to - mark.length) }
    if (text.length >= mark.length * 2 && text.startsWith(mark) && text.endsWith(mark)) // the selection includes the marks
      return { changes: { from: r.from, to: r.to, insert: text.slice(mark.length, -mark.length) }, range: EditorSelection.range(r.from, r.to - mark.length * 2) }
    return { changes: [{ from: r.from, insert: mark }, { from: r.to, insert: mark }], range: EditorSelection.range(r.from + mark.length, r.to + mark.length) }
  }))
  v.focus()
  return true
}
function link(v: EditorView) {
  const { state } = v
  v.dispatch(state.changeByRange(r => {
    const text = state.sliceDoc(r.from, r.to) || 'link'
    const insert = `[${text}](url)`
    const urlAt = r.from + text.length + 3
    return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.range(urlAt, urlAt + 3) }
  }))
  v.focus()
  return true
}
// Set what each selected line is: a heading, quote, list item, or plain text ('' clears it).
function linePrefix(v: EditorView, prefix: string, numbered = false) {
  const { state } = v, changes: { from: number; to: number; insert: string }[] = []
  const seen = new Set<number>()
  let n = 1
  for (const r of state.selection.ranges) for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l++) {
    if (seen.has(l)) continue
    seen.add(l)
    const line = state.doc.line(l), m = line.text.match(/^(#{1,6} |> |[-*+] |\d+\. )/)
    const want = numbered ? `${n++}. ` : prefix
    const has = m?.[0] ?? ''
    changes.push({ from: line.from, to: line.from + has.length, insert: has === want ? '' : want })
  }
  v.dispatch({ changes })
  v.focus()
  return true
}

function EditorMenu({ at, view, onClose, onComment, onAgent, onCheck }: { at: { x: number; y: number; pos: number }; view: EditorView; onClose: () => void; onComment: () => void; onAgent: () => void; onCheck: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: at.x, top: at.y })
  useEffect(() => {
    const el = ref.current
    if (el) setPos({ left: Math.min(at.x, innerWidth - el.offsetWidth - 8), top: Math.min(at.y, innerHeight - el.offsetHeight - 8) })
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('mousedown', away, true); addEventListener('keydown', esc, true); addEventListener('scroll', onClose, true)
    return () => { removeEventListener('mousedown', away, true); removeEventListener('keydown', esc, true); removeEventListener('scroll', onClose, true) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const sel = view.state.selection.main, has = !sel.empty
  // The spelling or grammar note under the cursor, with its fixes.
  let diag: { d: Diagnostic; from: number; to: number } | null = null
  forEachDiagnostic(view.state, (d, from, to) => { if (!diag && at.pos >= from && at.pos <= to && d.actions?.length) diag = { d, from, to } })
  const go = (f: () => unknown) => () => { f(); onClose() }
  const item = (label: string, f: () => unknown, key?: string, disabled = false) => <button key={label} disabled={disabled} onClick={go(f)}><span>{label}</span>{key && <kbd>{key}</kbd>}</button>
  const clip = {
    cut: async () => { const t = view.state.sliceDoc(sel.from, sel.to); try { await navigator.clipboard.writeText(t) } catch { await copyText(t) } view.dispatch({ changes: { from: sel.from, to: sel.to } }) },
    copy: async () => { const t = view.state.sliceDoc(sel.from, sel.to); try { await navigator.clipboard.writeText(t) } catch { await copyText(t) } },
    paste: async () => { try { const t = await navigator.clipboard.readText(); view.dispatch(view.state.replaceSelection(t)) } catch { toast('Use ⌘V to paste here', { kind: 'info' }) } },
  }
  const d = diag as { d: Diagnostic; from: number; to: number } | null
  return (
    <div ref={ref} className="doc-menu" style={pos} onContextMenu={e => e.preventDefault()}>
      {d && <>
        <div className="doc-menu-note">{d.d.message}</div>
        {d.d.actions!.map(a => <button key={a.name} className={a.name.startsWith('→') ? 'doc-menu-fix' : ''} onClick={go(() => a.apply(view, d.from, d.to))}>{a.name.replace(/^→ /, '')}</button>)}
        <hr />
      </>}
      {item('Comment', onComment, '⌘⌥M', !has)}
      {item('Ask the agent about this', onAgent)}
      {item('Check for AI writing…', onCheck, undefined, !has)}
      <hr />
      <div className="doc-menu-row">
        <button title="Bold  ⌘B" onClick={go(() => wrap(view, '**'))}><b>B</b></button>
        <button title="Italic  ⌘I" onClick={go(() => wrap(view, '_'))}><i>I</i></button>
        <button title="Strikethrough  ⌘⇧X" onClick={go(() => wrap(view, '~~'))}><s>S</s></button>
        <button title="Code  ⌘E" onClick={go(() => wrap(view, '`'))}><code>{'<>'}</code></button>
        <button title="Link  ⌘K" onClick={go(() => link(view))}>🔗</button>
      </div>
      {item('Heading 1', () => linePrefix(view, '# '), '⌘⌥1')}
      {item('Heading 2', () => linePrefix(view, '## '), '⌘⌥2')}
      {item('Heading 3', () => linePrefix(view, '### '), '⌘⌥3')}
      {item('Normal text', () => linePrefix(view, ''), '⌘⌥0')}
      {item('Quote', () => linePrefix(view, '> '))}
      {item('Bulleted list', () => linePrefix(view, '- '))}
      {item('Numbered list', () => linePrefix(view, '', true))}
      <hr />
      {item('Cut', clip.cut, '⌘X', !has)}
      {item('Copy', clip.copy, '⌘C', !has)}
      {item('Paste', clip.paste, '⌘V')}
      {item('Select all', () => view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }), '⌘A')}
    </div>
  )
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
  useEffect(() => { const f = (e: Event) => { if ((e as CustomEvent).detail == null || (e as CustomEvent).detail === id) box.current?.focus() }; addEventListener('perch-doc-comment', f); return () => removeEventListener('perch-doc-comment', f) }, [id])
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

function CheckPanel({ id, grammar, setGrammar, tells, setTells, dialect, setDialect, ai, setAi, text, selection, onJump }: {
  id: string; grammar: boolean; setGrammar: (b: boolean) => void; tells: boolean; setTells: (b: boolean) => void; dialect: number; setDialect: (n: number) => void
  ai: AiResult | null; setAi: (r: AiResult | null) => void; text: () => string; selection: { from: number; text: string } | null; onJump: (from: number | null, to?: number | null) => void
}) {
  const { data: pg, reload } = useLive<{ configured: boolean; balance: number | null }>('/api/writing/pangram')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // The whole doc, or just the selected passage (cheaper: Pangram charges per word).
  const run = async (part?: { from: number; text: string }) => {
    setBusy(true); setErr(null)
    const r: any = await post(`/api/docs/${id}/ai-check`, { text: part ? part.text : text() }).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (r?.error) setErr(r.error)
    else setAi(part ? { ...r, windows: r.windows.map((w: AiWindow) => ({ ...w, start: w.start == null ? null : w.start + part.from, end: w.end == null ? null : w.end + part.from })) } : r)
    reload()
  }
  const words = countWords(text()), selWords = selection ? countWords(selection.text) : 0
  const price = (n: number) => `$${(Math.ceil(n / 100) * 0.05).toFixed(2)}` // Pangram text: $0.05 per 100 words
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
        <button className="small" disabled={!key.trim()} onClick={async () => { const r = await post('/api/writing/pangram', { key }); setKey(''); setErr(r?.error ?? null); reload() }}>Save</button></div>}
      {pg?.configured && <div className="row-flex wrap"><button className="primary small" disabled={busy || !words} onClick={() => run()}>{busy ? 'Checking…' : `Check the doc · ~${price(words)}`}</button>
        {selection && selWords > 0 && <button className="small" disabled={busy} onClick={() => run({ from: selection.from, text: selection.text })}>Check selection · ~{price(selWords)}</button>}
        <button className="link small" onClick={async () => { await post('/api/writing/pangram', { clear: true }); reload() }}>Remove key</button></div>}
      {pg?.configured && pg.balance != null && <div className={`small ${pg.balance < 0.05 ? 'error' : 'muted'}`}>Pangram credit: ${pg.balance.toFixed(2)}{pg.balance < 0.05 ? ': none left. Add credits in the Pangram API dashboard to check.' : ` (about ${Math.floor(pg.balance / 0.05 * 100).toLocaleString()} words)`}</div>}
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
