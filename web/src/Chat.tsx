import { BoardButton } from './Boards'
import { marked } from 'marked'
import { createContext, memo, startTransition, useContext, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { ConversationDecisions, DecisionStrip } from './Decisions'
import { SelfDriveButton } from './SelfDrive'
import { ago, api, cachedThread, loadThread, baseName, post, sendChat, toast, shortPath, useOutbox, titleOf, useLive, shell, type Conversation, type Item, type Term } from './api'
import { adopt, apply, dropReplayedPrompt, emptyLive, toolLabel, toolSummary, type Live } from './stream'
import { StateMenu } from './List'
import { OpenIn } from './OpenIn'
import { Popover } from './Popover'
import { EnginePicker } from './EnginePicker'
import { ClaudePressure } from './ClaudeAccounts'
import { Brand, brandFor } from './Brand'
import { takeRename } from './Menu'
import { SlackDraftCard, SlackLinkCard, isSlackLink } from './SlackDraft'
import { Viz, splitCharts, vizFromTool } from './Viz'
import { InlineTile } from './InlineTile'
import { TermView } from './Term'
import { WaitCard, turnWaits, type PromiseRow } from './Waits'
import { CloudBar } from './Mobile'
import { ApprovalBar, BrowserDock, SIDE_MIN_CHAT, useBrowser, useDockMode } from './BrowserView'
import { createRoot, type Root } from 'react-dom/client'
import { PR_URL, PrPill, PrRefs, bareRefs, knownPrs, linkPrRefs, type PrKnown } from './PrPill'
import { agentSender, userBody } from '../../shared/messageOrigin'
import { BlockerCard, knownBlocker } from './BlockerCard'
import { blockerFor, blockerInText } from './blockers.ts'
import { traceUi } from './tracing.ts'
import { groupMessages, NEEDS_LOGIN, shortDuration, workPhases, workPulse, workSummary, type Entry, type Phase, type QueuedMessage, type StepResult, type WorkTurn } from './chatActivity'
export { agentSender } from '../../shared/messageOrigin'
import { CONV_SCHEME_RE, convIdOf, convLink, isConvLink, ourMcpTool } from '../../shared/brand.ts'
export { NEEDS_LOGIN } from './chatActivity'

const SHELL_LANGS = new Set(['bash', 'sh', 'zsh', 'shell', 'console', 'terminal'])
// A block written as "$ cmd" lines (console style) runs just those lines, without the prompt and the output.
const commandOf = (text: string) => {
  const lines = text.replace(/\n+$/, '').split('\n')
  return lines.some(l => l.startsWith('$ ')) ? lines.filter(l => l.startsWith('$ ')).map(l => l.slice(2)).join('\n') : lines.join('\n')
}
// HTML in model output is shown as text, never rendered.
const esc = (t: string) => t.replace(/[&<>"]/g, (c: string) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
marked.use({ renderer: {
  html: t => esc((t as any).text),
  // A file path in a reply opens perch's file viewer (view, copy, Finder, download).
  // A video path also plays right there in the chat.
  codespan: t => {
    const v = String((t as any).text)
    // A folder path (no extension): click shows it in Finder; right-click for the path menu.
    if (/^(~|\/(Users|private|tmp|var\/folders|Volumes))(\/[^\s.][^\s]*)?\/?$/.test(v) && !/\.[A-Za-z0-9]{1,8}$/.test(v)) return `<code class="file-path dir" data-path="${esc(v)}" data-dir="1" title="Show in Finder (right-click for more)">${esc(v)}</code>`
    if (!/^(~|\/(Users|private|tmp|var\/folders|Volumes))\/\S+\.[A-Za-z0-9]{1,8}$/.test(v)) return `<code>${esc(v)}</code>`
    const link = `<code class="file-path" data-path="${esc(v)}" title="View this file (right-click for Finder)">${esc(v)}</code>`
    return /\.(mp4|m4v|mov|webm)$/i.test(v) ? `${link}<video class="inline-video" controls preload="metadata" playsinline src="/api/files/raw?path=${encodeURIComponent(v)}"></video>` : link
  },
  // Every code block gets its own copy button (shown on hover); shell blocks also get ▶ Run, which types it into a terminal under the chat.
  code: t => `<div class="codeblock">${SHELL_LANGS.has(String((t as any).lang ?? '').toLowerCase()) ? '<button class="code-run" title="Open a terminal with this typed in. Press Enter there to run it.">▶ Run</button>' : ''}<button class="code-copy" title="Copy code">⧉</button><pre><code${(t as any).lang ? ` class="language-${esc(String((t as any).lang))}"` : ''}>${esc((t as any).text)}</code></pre></div>`,
} })

// Copy text, with a fallback for when the clipboard API isn't allowed.
export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true } catch {}
  const ta = document.createElement('textarea')
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
  document.body.appendChild(ta); ta.select()
  const ok = document.execCommand('copy'); ta.remove(); return ok
}
const flash = (el: HTMLElement, label = '✓') => { const old = el.textContent; el.textContent = label; el.classList.add('copied'); setTimeout(() => { el.textContent = old; el.classList.remove('copied') }, 1200) }
// An inline video whose file is gone (or a placeholder path) hides instead of showing a broken player.
addEventListener('error', e => { const t = e.target as HTMLElement; if (t instanceof HTMLVideoElement && t.classList.contains('inline-video')) t.hidden = true }, true)
// auto-m8://<id> (or the older perch://<id>) links from Ask Claude and the brief open that conversation in place.
const onLinkClick = (e: React.MouseEvent) => {
  const a = (e.target as HTMLElement).closest('a')
  const fp = (e.target as HTMLElement).closest('code.file-path') as HTMLElement | null
  if (fp?.dataset.path && fp.dataset.dir) { e.preventDefault(); post('/api/files/action', { path: fp.dataset.path, action: 'reveal' }).then((r: any) => r?.error && toast(String(r.error)), () => {}); return }
  if (fp?.dataset.path) { e.preventDefault(); window.dispatchEvent(new CustomEvent('perch-file', { detail: fp.dataset.path })); return }
  const run = (e.target as HTMLElement).closest('.code-run') as HTMLElement | null
  if (run) {
    e.preventDefault()
    const code = run.parentElement?.querySelector('pre code')
    run.dispatchEvent(new CustomEvent('perch-run', { bubbles: true, detail: commandOf(code?.textContent ?? '') }))
    flash(run, '▶ Opened')
    return
  }
  const copy = (e.target as HTMLElement).closest('.code-copy') as HTMLElement | null
  if (copy) { e.preventDefault(); copyText(copy.parentElement?.querySelector('pre')?.textContent ?? '').then(ok => ok && flash(copy)); return }
  const href = a?.getAttribute('href') ?? ''
  if (isConvLink(href)) { e.preventDefault(); window.dispatchEvent(new CustomEvent('perch-open', { detail: convIdOf(href) })) }
  else if (/^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/)?#doc\/[\w-]+$/.test(href)) { e.preventDefault(); location.hash = href.slice(href.indexOf('#')) } // a doc in the editor
  else if (/^(file:\/\/)?(~\/|\/(Users|private|tmp|var\/folders|Volumes)\/)/.test(href)) {
    // A file on this Mac (a board's "Read draft" link, a path in a reply): markdown and text open in
    // the writing editor, anything else in the file viewer. Left alone, the link would load the app's start page.
    e.preventDefault()
    let path = href.replace(/^file:\/\//, '').replace(/[?#].*$/, '')
    try { path = decodeURI(path) } catch {}
    if (/\.(md|markdown|mdx|txt)$/i.test(path)) post<{ id?: string }>('/api/docs', { path }).then(d => { if (d?.id) location.hash = `#doc/${d.id}` })
    else window.dispatchEvent(new CustomEvent('perch-file', { detail: path }))
  }
  else if (a && /^https?:/.test(href)) { e.preventDefault(); window.open(href, '_blank') }
}
// PR links become PR pills: state, repo#n, title and the robots on it.
// "#135188" with no repo is looked up once in perch's PR table (one PR with that number, else left as text).
const resolved = new Map<string, Promise<string>>()
const resolveBare = (n: string) => {
  let p = resolved.get(n)
  if (!p) { p = fetch(`/api/pr/resolve?n=${n}`).then(r => r.ok ? r.json() : null).then(d => d?.url ?? '').catch(() => ''); resolved.set(n, p) }
  return p
}
// auto-m8://<id> (or perch://<id>) in a reply shows as that conversation's title, not the internal link.
const CONV_LINK = new RegExp(`${CONV_SCHEME_RE}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\/?`, 'g')
const convTitles = new Map<string, Promise<string>>()
const convTitle = (id: string) => {
  let p = convTitles.get(id)
  if (!p) { p = api.get<any>(`/api/conversations/${encodeURIComponent(id)}`).then(d => String(d?.title || d?.conversation?.title || d?.first_prompt || '').replace(/\s+/g, ' ').trim()).catch(() => ''); convTitles.set(id, p) }
  return p
}
const titleConvLinks = (root: HTMLElement) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const hits: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement
    if (!el || el.closest('pre, code, a')) continue
    CONV_LINK.lastIndex = 0
    if (CONV_LINK.test(n.nodeValue ?? '')) hits.push(n as Text)
  }
  for (const t of hits) {
    const frag = document.createDocumentFragment()
    let last = 0; const v = t.nodeValue ?? ''
    for (const m of v.matchAll(CONV_LINK)) {
      frag.append(v.slice(last, m.index))
      const a = document.createElement('a'); a.href = convLink(m[1]); a.textContent = 'chat'
      frag.append(a); last = m.index! + m[0].length
    }
    frag.append(v.slice(last)); t.replaceWith(frag)
  }
  for (const a of Array.from(root.querySelectorAll('a[href^="auto-m8://"], a[href^="perch://"]')) as HTMLAnchorElement[]) {
    const id = convIdOf(a.getAttribute('href') ?? '')
    const raw = (a.textContent ?? '').trim()
    if (a.closest('pre, code') || !(raw === 'chat' || isConvLink(raw) || raw === id)) continue
    a.classList.add('conv-link'); a.title = 'Open this chat'
    if (raw !== 'chat') a.textContent = 'chat'
    convTitle(id).then(title => { if (title && a.isConnected) a.textContent = title.length > 60 ? title.slice(0, 57).trimEnd() + '…' : title })
  }
}
export const Markdown = memo(({ text }: { text: string }) => {
  const ref = useRef<HTMLDivElement>(null)
  const conv = useContext(PrRefs)
  const [extra, setExtra] = useState<PrKnown | null>(null)
  const known = useMemo(() => { const m = new Map(conv ?? knownPrs([text])); for (const [k, v] of extra ?? []) if (!m.get(k)) m.set(k, v); return m }, [conv, text, extra])
  const missing = useMemo(() => [...new Set(bareRefs(text))].filter(n => known.get(n) === undefined).join(','), [text, known])
  useEffect(() => {
    if (!missing) return
    let live = true
    const ns = missing.split(',')
    Promise.all(ns.map(resolveBare)).then(us => { if (live && us.some(Boolean)) setExtra(prev => new Map([...(prev ?? []), ...ns.flatMap((n, i) => us[i] ? [[n, us[i]] as [string, string]] : [])])) })
    return () => { live = false }
  }, [missing])
  const html = useMemo(() => marked.parse(linkPrRefs(text, known), { async: false, gfm: true, breaks: false }) as string, [text, known])
  useEffect(() => {
    if (ref.current) titleConvLinks(ref.current)
    const roots: Root[] = []
    for (const a of Array.from(ref.current?.querySelectorAll('a[href*="/pull/"]') ?? []) as HTMLAnchorElement[]) {
      const href = a.getAttribute('href') ?? ''
      if (!PR_URL.test(href) || a.closest('pre, code, .pr-inline')) continue
      const host = document.createElement('span')
      a.replaceWith(host)
      const r = createRoot(host); r.render(<PrPill url={href} />); roots.push(r)
    }
    return () => { const rs = roots.splice(0); queueMicrotask(() => rs.forEach(r => r.unmount())) }
  }, [html])
  return <div ref={ref} className="md" onClick={onLinkClick} dangerouslySetInnerHTML={{ __html: html }} />
})

// The file or folder a tool call worked on, for the right-click path menu.
const toolPath = (input: any): string | undefined => {
  const p = input?.file_path ?? input?.notebook_path ?? input?.path
  return typeof p === 'string' && /^(~|\/)/.test(p) ? p : undefined
}

function ToolRow({ b }: { b: Extract<Item, { kind: 'assistant' }>['blocks'][number] & { type: 'tool' } }) {
  const focus = useContext(Focus)
  const [open, setOpen] = useState(false)
  useEffect(() => { if (focus.tool && focus.tool === b.id) setOpen(true) }, [focus.n]) // eslint-disable-line
  const pending = b.result === undefined
  return (
    <div className={`tool ${b.isError ? 'err' : ''}`} data-tool={b.id}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className={`dot ${pending ? 'pending' : b.isError ? 'bad' : 'ok'}`} />
        <span className="tool-name">{toolLabel(b.name)}</span>
        <span className="tool-sum" data-path={toolPath(b.input)}>{toolSummary(b.name, b.input)}</span>
      </button>
      {open && (
        <div className="tool-body">
          <pre>{JSON.stringify(b.input, null, 2)?.slice(0, 6000)}</pre>
          {b.result !== undefined && <pre className="tool-result">{b.result.slice(0, 8000)}{b.result.length > 8000 ? '\n…' : ''}</pre>}
        </div>
      )}
    </div>
  )
}

// A data query's result drawn under its tool row (Grafana range query → chart, SQL → table).
function ToolViz({ b }: { b: Extract<Item, { kind: 'assistant' }>['blocks'][number] & { type: 'tool' } }) {
  const spec = useMemo(() => b.isError ? null : vizFromTool(b.name, b.input, b.result), [b.name, b.input, b.result, b.isError])
  return <><ToolRow b={b} />{spec && <Viz spec={spec} />}</>
}

function Activity({ activity }: { activity: NonNullable<Extract<Item, { kind: 'assistant' }>['activity']> }) {
  // Combine consecutive repeats, keeping the order and each distinct command intact.
  const rows: { text: string; count: number }[] = []
  for (const text of activity.tools) {
    const last = rows.at(-1)
    if (last?.text === text) last.count++
    else rows.push({ text, count: 1 })
  }
  const total = activity.tools.length + (activity.omitted ?? 0)
  if (!total) return null
  return <details className="activity">
    <summary>Activity · {total} step{total === 1 ? '' : 's'}</summary>
    <div className="activity-body">
      <ol>{rows.map((row, i) => <li key={i}><code>{row.text}</code>{row.count > 1 && <span className="activity-count"> × {row.count}</span>}</li>)}</ol>
      {!!activity.omitted && <p className="muted">{activity.omitted} more steps weren’t saved in this older conversation.</p>}
    </div>
  </details>
}
// Markdown, with ```chart blocks drawn as charts and ```tile blocks run as inline HTML.
const RichText = memo(({ text }: { text: string }) => {
  const parts = useMemo(() => splitCharts(text), [text])
  if (parts.length === 1 && parts[0].kind === 'md') return <Markdown text={text} />
  return <>{parts.map((p, i) => p.kind === 'md' ? (p.text.trim() ? <Markdown key={i} text={p.text} /> : null)
    : p.kind === 'tile' ? <InlineTile key={i} info={p.info} body={p.body} />
    : <Viz key={i} spec={p.spec} raw={p.raw} />)}</>
})

// Copy, branch and rewind live on each message, visible only on hover: no extra chrome otherwise.
// Copy gives the message as written (Markdown), so it pastes cleanly into Slack, a PR or a doc.
// When it was sent, in local time: just the time today, the date too otherwise. Full date on hover.
function msgTime(ts: number) {
  const d = new Date(ts), now = new Date()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return time
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) })}, ${time}`
}
function MsgActions({ uuid, onBranch, onRewind, text, ts }: { uuid?: string; onBranch?: (u: string) => void; onRewind?: (u: string) => void; text?: string; ts?: number }) {
  if (!text && !ts && (!uuid || !onBranch)) return null
  return (
    <span className="msg-actions">
      {ts && <span className="msg-time" title={new Date(ts).toLocaleString([], { dateStyle: 'full', timeStyle: 'medium' })}>{msgTime(ts)}</span>}
      {text && <button title="Copy this message" onClick={e => { const b = e.currentTarget; copyText(text).then(ok => ok && flash(b, '✓ Copied')) }}>⧉ Copy</button>}
      {uuid && onBranch && <>
      <button title="A copy of the conversation up to this point, in a new chat" onClick={() => onBranch(uuid)}>⑂ Branch</button>
      <button title="Continue from this point; the rest stays in the original" onClick={() => onRewind?.(uuid)}>↺ Rewind</button>
      </>}
    </span>
  )
}

// The thread's last reply is itself a blocker (its card is already showing): don't repeat it by the composer.
function lastFailureBlocked(items: Item[]): boolean {
  const last = items.findLast(x => x.kind !== 'user' && x.kind !== 'notice') as any
  if (!last) return false
  if (last.kind === 'assistant') return last.blocks.some((b: any) => b.type === 'text' && blockerInText(b.text))
  return !!blockerFor(last.text)
}

// A failure a settings change clears (lapsed sign-in, MCP auth, a key): a card that does the fix, and
// resends the message before it after a Claude sign-in.
function Fix({ text, items, at, convId }: { text: string; items: Item[]; at: number; convId?: string | null }) {
  const b = blockerFor(text)
  if (!b) return null
  const prev = items.slice(0, at).findLast(x => x.kind === 'user') as any
  return <BlockerCard blocker={b} convId={convId} resend={prev?.text} />
}


// Links you shared in from the browser arrive as a <shared-from-browser> block (live) or "🔗 url" lines (history).
// Slack links become cards; everything else stays as text.
// Prompts perch itself injects (follow-ups, event batches, helper reports). The agent sees the
// whole text; the chat shows one line you can expand.
export function perchSummary(text: string): string | null {
  const f = text.match(/^⏰ Follow-up from (?:auto-m8|perch)\. Earlier you told the user: “([\s\S]*?)”\n([^\n]*)/)
  if (f) {
    const pr = f[2].match(/#(\d+)/)?.[1] ?? f[1].match(/#(\d+)/)?.[1]
    const what = f[1].replace(/\s+/g, ' ').trim()
    return `⏰ Follow-up${pr ? ` on #${pr}` : ''}: ${what.length > 90 ? what.slice(0, 90) + '…' : what}`
  }
  if (/^⏰ /.test(text)) return text.split('\n')[0].slice(0, 120)
  return null
}

function Collapsed({ summary, body, className }: { summary: React.ReactNode; body: string; className: string }) {
  return <details className={`bubble collapsible ${className}`}>
    <summary>{summary}</summary>
    <div className="collapsible-body">{body}</div>
  </details>
}

function AgentBubble({ text }: { text: string }) {
  const a = agentSender(text)!
  const open = () => a.id && window.dispatchEvent(new CustomEvent('perch-open', { detail: a.id }))
  const from = <span className="agent-from" title="An agent sent this, not you">🤖 {a.id ? <a href="#" onClick={e => { e.preventDefault(); e.stopPropagation(); open() }}>{a.label}</a> : a.label}</span>
  const body = a.body.trim()
  // Long agent-sent prompts (event batches, helper reports, delegations) fold to one line.
  if (body.length > 160 || body.includes('\n')) {
    const first = body.split('\n').find(l => l.trim()) ?? ''
    return <Collapsed className="agent" body={body} summary={<>{from} · <span className="muted">{first.length > 90 ? first.slice(0, 90) + '…' : first}</span></>} />
  }
  return <div className="bubble agent"><div>{from}</div>{body}</div>
}

// "[Image 1]" / "[File 2]" tell the agent where an attachment was added; you never see them.
export const hideAttachMarks = (t: string) => t.replace(/ ?\[(?:Image|File) \d{1,2}\]/g, '')
function UserBubble({ text }: { text: string }) {
  if (agentSender(text)) return <AgentBubble text={text} />
  const body = userBody(text)
  const sum = body === text ? perchSummary(text) : null
  if (sum) return <Collapsed className="perch" summary={sum} body={text} />
  const urls: string[] = []
  let rest = body.replace(/<shared-from-browser>([\s\S]*?)<\/shared-from-browser>\s*/g, (_m, inner: string) => {
    for (const u of inner.match(/https?:\/\/\S+/g) ?? []) if (isSlackLink(u)) urls.push(u)
    return (inner.match(/https?:\/\/\S+/g) ?? []).filter(u => !isSlackLink(u)).map(u => `🔗 ${u}`).join('\n') + '\n'
  })
  // Pasted images and files: a small preview / chip instead of the raw path list.
  const imgs: string[] = [], files: string[] = [], labels: Record<string, string> = {}
  rest = rest.replace(/<attached-images>([\s\S]*?)<\/attached-images>\s*/g, (_m, inner: string) => { for (const x of attachedItems(inner)) { imgs.push(x.path); if (x.label) labels[x.path] = x.label } return '' })
  rest = rest.replace(/<attached-files>([\s\S]*?)<\/attached-files>\s*/g, (_m, inner: string) => { for (const x of attachedItems(inner)) { files.push(x.path); if (x.label) labels[x.path] = x.label } return '' })
  if (imgs.length) rest = rest.replace(/\n*🖼 \d+ images? attached\s*$/, '')
  if (imgs.length || files.length) rest = rest.replace(/^\(see the attached (?:image|file|\d+ attachments)\)$/, '')
  rest = hideAttachMarks(rest)
  const prs: string[] = []
  rest = rest.replace(/^(?:🔗 )?(https?:\/\/\S+)\s*$/gm, (m, u: string) => { if (isSlackLink(u)) { urls.push(u); return '' } if (PR_URL.test(u)) { prs.push(u); return '' } return m }).trim()
  return <>
    {urls.map((u, i) => <SlackLinkCard key={i} url={u} />)}
    {prs.length > 0 && <div className="pr-inline-row">{prs.map((u, i) => <PrPill key={i} url={u} />)}</div>}
    {(imgs.length > 0 || files.length > 0) && <div className="attach-row">
      {imgs.map(p => <button key={p} className="attach-thumb" onClick={() => window.dispatchEvent(new CustomEvent('perch-file', { detail: p }))} title={`${labels[p] ? `[${labels[p]}] ` : ''}${baseName(p)}\nClick to view`}>
<img src={`/api/files/raw?path=${encodeURIComponent(p)}`} alt={baseName(p)} loading="lazy" /></button>)}
      {files.map(p => <button key={p} className="chip attach-file" onClick={() => window.dispatchEvent(new CustomEvent('perch-file', { detail: p }))} title={p}>📄 {baseName(p).replace(/^[0-9a-f]{8}-/, '')}</button>)}
    </div>}
    {rest && <div className="bubble">{rest}</div>}
  </>
}

const PULSE_TITLE = { active: 'Working', waiting: 'Working', quiet: 'Quiet', stalled: 'Possibly stalled' } as const
const MOOD_LABEL = { smooth: 'Smooth', friction: 'Friction', struggling: 'Struggling' } as const

function WorkingCard({ turn, renderEntry, startedAt }: { turn: WorkTurn; renderEntry: (entry: Entry) => React.ReactNode; startedAt?: number }) {
  const [open, setOpen] = useState(false)
  const focus = useContext(Focus)
  useEffect(() => { if (focus.index != null && turn.work.some(e => e.index === focus.index)) setOpen(true) }, [focus.n]) // eslint-disable-line
  const id = useId()
  const { preview, latestTool, steps, errors } = workSummary(turn.work)
  const phases = useMemo(() => workPhases(turn.work, turn.running), [turn.work, turn.running])
  const intents = phases.length
  const tool = latestTool && (typeof latestTool.input?.description === 'string' ? latestTool.input.description : toolLabel(latestTool.name))
  // Tick once a second while running, and note when anything in the turn last changed (streamed
  // text or a tool result doesn't always come with a new message timestamp).
  const [now, setNow] = useState(Date.now)
  useEffect(() => { if (!turn.running) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [turn.running])
  const sig = `${turn.work.length}:${steps}:${errors}:${preview.length}:${latestTool?.result === undefined}`
  const seen = useRef<{ sig: string; at?: number }>({ sig })
  if (seen.current.sig !== sig) seen.current = { sig, at: Date.now() }
  const pulse = turn.running ? workPulse(turn.work, now, startedAt, seen.current.at) : null
  const idle = pulse?.lastAt ? now - pulse.lastAt : 0
  const title = pulse ? PULSE_TITLE[pulse.state] : 'Work details'
  return <div className={`msg work-card${turn.running ? ' is-running' : ''}${pulse ? ` pulse-${pulse.state}` : ''}`}>
    <button className="work-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(v => !v)}>
      <span className={`dot ${pulse ? (pulse.state === 'stalled' ? 'bad' : pulse.state === 'quiet' ? 'warn' : 's-running') : errors ? 'bad' : ''}`} aria-hidden="true" />
      <span className="work-title">{title}</span>
      <span className="work-meta">
        {pulse?.startedAt && <span title={`Started ${new Date(pulse.startedAt).toLocaleTimeString()}`}>{shortDuration(now - pulse.startedAt)} · </span>}
        {intents > 1 && `${intents} intents · `}{steps > 0 && `${steps} step${steps === 1 ? '' : 's'}`}{errors > 0 && <span className="bad"> · {errors} failed</span>}
        {pulse && pulse.lastAt && <span className={pulse.state === 'stalled' ? 'bad' : pulse.state === 'quiet' ? 'warn' : ''} title="Time since the agent last did anything">
          {' · '}{idle < 5000 ? 'active now' : pulse.state === 'waiting' ? `step running ${shortDuration(idle)}` : `${shortDuration(idle)} ago`}</span>}
      </span>
      {pulse && phases.length > 0 && <span className="work-health">
        <IntentBar phases={phases} plan={pulse.plan} />
        <span className={`work-mood mood-${pulse.mood}`} title={pulse.why}>{MOOD_LABEL[pulse.mood]}</span>
      </span>}
      <span className={`work-chevron${open ? ' open' : ''}`} aria-hidden="true">›</span>
    </button>
    {turn.running && pulse && <div className="work-preview">
      <div className="work-update">{preview || 'Getting started…'}</div>
      {tool && <div className="work-current" title={latestTool?.result === undefined ? 'Running now' : 'Latest step'}>↳ {tool}</div>}
    </div>}
    {turn.running && turn.queued.map(q => <QueuedLine key={q.index} q={q} renderEntry={renderEntry} />)}
    <div id={id} className="work-body" hidden={!open}>
      {open && (turn.work.length ? <WorkPhases turn={turn} renderEntry={renderEntry} /> : <div className="muted small">Waiting for the first update…</div>)}
    </div>
  </div>
}

// A message another agent sent while this one works: it doesn't stop the work. Claude Code hands it
// over when the running step ends, inside this same turn. Shown as one line in the card.
function QueuedLine({ q, renderEntry }: { q: QueuedMessage; renderEntry: (entry: Entry) => React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const a = agentSender((q.item as { text: string }).text)
  return <div className="work-queued">
    <button className="link-btn" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      🤖 {a?.label ?? 'An agent'} sent a message · <span className="muted">{q.pickedUp ? 'picked up, the agent is on it' : 'queued, the agent picks it up after this step'}</span>
      <span className={`work-chevron${open ? ' open' : ''}`} aria-hidden="true">›</span>
    </button>
    {open && renderEntry(q)}
  </div>
}

// One segment per intent: done ones coloured by how they went, the current one pulsing, then what's
// left. The agent's own task list says how many tasks remain; without one there's no honest estimate,
// so a single dashed segment says "more, unknown".
const INTENT_MARK = { running: 'pending', done: 'ok', recovered: 'repeat', failed: 'err' } as const
function IntentBar({ phases, plan }: { phases: Phase[]; plan?: { done: number; total: number; current?: string } }) {
  const left = plan ? Math.max(0, plan.total - plan.done - (plan.current ? 1 : 0)) : undefined
  const shown = phases.slice(-16)
  const why = plan ? `${phases.length} intents so far · ${plan.done}/${plan.total} tasks done${plan.current ? ` · now: ${plan.current}` : ''}` : `${phases.length} intents so far · no task list, so how much is left is unknown`
  return <span className="work-marks" title={why}>
    {shown.map(p => <i key={p.key} className={`mark-${INTENT_MARK[p.state]}`} title={`${p.title} · ${p.steps} step${p.steps === 1 ? '' : 's'}${p.errors ? ` · ${p.errors} failed` : ''}`} />)}
    {left === undefined ? <i className="mark-unknown" title="More may follow: the agent has no task list" />
      : Array.from({ length: Math.min(left, 12) }, (_, i) => <i key={`l${i}`} className="mark-todo" title="Task not started yet" />)}
  </span>
}


const PHASE_MARK = { running: '◌', done: '✓', recovered: '↻', failed: '✕' } as const
const PHASE_TITLE = { running: 'Working on this now', done: 'Done, moved on', recovered: 'Hit failures, then moved on', failed: 'Stopped on a failure' } as const

// The work grouped by what the agent was trying to do; open an intent to see its steps.
function WorkPhases({ turn, renderEntry }: { turn: WorkTurn; renderEntry: (entry: Entry) => React.ReactNode }) {
  const phases = useMemo(() => workPhases(turn.work, turn.running), [turn.work, turn.running])
  if (phases.length < 2) return turn.running || !phases[0] ? <>{turn.work.map(renderEntry)}</> : <PhaseResults p={phases[0]} renderEntry={renderEntry} />
  return <ol className="phases">{phases.map((p, i) => <PhaseRow key={p.key} p={p} n={i + 1} renderEntry={renderEntry} />)}</ol>
}
function PhaseRow({ p, n, renderEntry }: { p: Phase; n: number; renderEntry: (entry: Entry) => React.ReactNode }) {
  const [open, setOpen] = useState(p.state === 'running')
  const focus = useContext(Focus)
  useEffect(() => { if (focus.index != null && p.entries.some(e => e.index === focus.index)) setOpen(true) }, [focus.n]) // eslint-disable-line
  const took = p.startedAt && p.endedAt && p.endedAt > p.startedAt ? shortDuration(p.endedAt - p.startedAt) : ''
  return <li className={`phase phase-${p.state}`}>
    <button className="phase-head" aria-expanded={open} onClick={() => setOpen(v => !v)} title={PHASE_TITLE[p.state]}>
      <span className="phase-mark" aria-label={PHASE_TITLE[p.state]}>{PHASE_MARK[p.state]}</span>
      <span className="phase-n">{n}</span>
      <span className="phase-title">{p.title}</span>
      <span className="phase-meta">
        {p.steps > 0 && `${p.steps} step${p.steps === 1 ? '' : 's'}`}
        {p.errors > 0 && <span className="bad"> · {p.errors} failed</span>}
        {p.repeats > 1 && <span className="warn"> · {p.repeats} repeats</span>}
        {took && ` · ${took}`}
      </span>
      <span className={`work-chevron${open ? ' open' : ''}`} aria-hidden="true">›</span>
    </button>
    {open && <div className="phase-body">{p.state === 'running' ? p.entries.map(renderEntry) : <PhaseResults p={p} renderEntry={renderEntry} />}</div>}
  </li>
}
// A finished intent opens to what came of it: what the agent made of the results, then one line
// per step with the start of its output. The exact tool calls stay one click away.
function PhaseResults({ p, renderEntry }: { p: Phase; renderEntry: (entry: Entry) => React.ReactNode }) {
  const [raw, setRaw] = useState(false)
  const focus = useContext(Focus)
  useEffect(() => { if (focus.index != null && p.entries.some(e => e.index === focus.index)) setRaw(true) }, [focus.n]) // eslint-disable-line
  if (!p.results.length && !p.outcome) return <>{p.entries.map(renderEntry)}</>
  return <div className="phase-results">
    {p.outcome && <div className="phase-outcome"><Markdown text={p.outcome} /></div>}
    {p.results.length > 0 && <ul className="step-results">{p.results.map((r, i) => <StepRow key={i} r={r} />)}</ul>}
    <button className="link small muted phase-raw-toggle" onClick={() => setRaw(v => !v)} title="Everything the agent wrote and ran for this intent, in order">{raw ? 'Hide' : 'Show'} full transcript</button>
    {raw && <div className="phase-raw">{p.entries.map(renderEntry)}</div>}
  </div>
}

// One step of a finished intent; open it to see the call itself (command, input, full output).
function StepRow({ r }: { r: StepResult }) {
  const [open, setOpen] = useState(false)
  return <li className={`${r.isError ? 'bad' : ''}${open ? ' open' : ''}`}>
    <button className="step-row" aria-expanded={open} disabled={!r.tool} onClick={() => setOpen(v => !v)} title={open ? 'Hide the call' : 'Show the call'}>
      <span className="step-mark" aria-label={r.isError ? 'failed' : 'done'}>{r.isError ? '✕' : '✓'}</span>
      <span className="step-label">{r.label}</span>
      <span className="step-excerpt" title={r.excerpt}>{r.excerpt}</span>
      {r.tool && <span className={`work-chevron step-chevron${open ? ' open' : ''}`} aria-hidden="true">›</span>}
    </button>
    {open && r.tool && <div className="step-call"><ToolViz b={r.tool} /></div>}
  </li>
}

// Jump to a point in a thread (e.g. where a file was made): opens the folds that hide it, scrolls
// there and flashes it. Works across views: the request waits until that chat's thread is drawn.
export type FocusAt = { uuid?: string; ts?: number; tool?: string }
const Focus = createContext<{ index: number | null; tool?: string; n: number }>({ index: null, n: 0 })
let pendingFocus: { convId: string; at: FocusAt; t: number } | null = null
export function focusInChat(convId: string, at: FocusAt) {
  pendingFocus = { convId, at, t: Date.now() }
  dispatchEvent(new CustomEvent('perch-chat-jump', { detail: pendingFocus }))
}
const indexOf = (items: Item[], at: FocusAt) => {
  if (at.tool) { const i = items.findIndex(it => it.kind === 'assistant' && it.blocks.some(b => b.type === 'tool' && b.id === at.tool)); if (i >= 0) return i }
  if (at.uuid) { const i = items.findIndex(it => (it as any).uuid === at.uuid); if (i >= 0) return i }
  if (at.ts) { const i = items.findIndex(it => ((it as any).ts ?? 0) >= at.ts!); if (i >= 0) return i }
  return -1
}

const TAIL_ROWS = 8 // rows (turns) drawn on the first paint of a thread
export function Messages({ items, running, onBranch, onRewind, convId }: { items: Item[]; running?: boolean; onBranch?: (u: string) => void; onRewind?: (u: string) => void; convId?: string | null }) {
  const [menu, setMenu] = useState<{ x: number; y: number; uuid?: string; text: string } | null>(null)
  // Opening a long thread drew every message before showing anything (0.3-0.5s for ~1,000). The
  // latest turns paint first; the rest follow in a transition that never blocks typing or scrolling.
  const threadKey = convId ?? ''
  const [fullFor, setFullFor] = useState<string | null>(null)
  const has = items.length > 0
  const [focus, setFocus] = useState<{ index: number | null; tool?: string; n: number }>({ index: null, n: 0 })
  const itemsRef = useRef(items); itemsRef.current = items
  useEffect(() => {
    if (!convId || !has) return
    const take = () => {
      const f = pendingFocus
      if (!f || f.convId !== convId || Date.now() - f.t > 15_000) return
      const i = indexOf(itemsRef.current, f.at)
      if (i < 0) return
      pendingFocus = null
      setFullFor(threadKey)
      setFocus(x => ({ index: i, tool: f.at.tool, n: x.n + 1 }))
    }
    take()
    addEventListener('perch-chat-jump', take)
    return () => removeEventListener('perch-chat-jump', take)
  }, [convId, has]) // eslint-disable-line
  useEffect(() => {
    if (focus.index == null) return
    let tries = 0, raf = 0
    // The folds open over a frame or two (and the rest of a long thread may still be drawing).
    const find = () => {
      const item = document.querySelector<HTMLElement>(`[data-item="${CSS.escape(`${convId}:${focus.index}`)}"]`)
      const el = (focus.tool && item?.querySelector<HTMLElement>(`[data-tool="${CSS.escape(focus.tool)}"]`)) || item
      if (!el) { if (++tries < 40) raf = requestAnimationFrame(find); return }
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.classList.remove('focus-flash'); void el.offsetWidth; el.classList.add('focus-flash')
      setTimeout(() => el.classList.remove('focus-flash'), 2400)
    }
    raf = requestAnimationFrame(find)
    return () => cancelAnimationFrame(raf)
  }, [focus.n]) // eslint-disable-line
  useEffect(() => {
    if (!has) return
    const f = requestAnimationFrame(() => startTransition(() => setFullFor(threadKey)))
    // A chat that is streaming updates every frame, which keeps restarting the transition (the rest
    // of a running chat's thread took 5s+ to appear). Past 700ms, draw it in one go.
    const t = setTimeout(() => setFullFor(threadKey), 700)
    return () => { cancelAnimationFrame(f); clearTimeout(t) }
  }, [threadKey, has])
  // Right-click a message for the same actions (only when no text is selected, so copy still works).
  const msgMenu = (e: React.MouseEvent, uuid: string | undefined, text: string) => {
    if (String(getSelection() ?? '').trim()) return
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, uuid, text })
  }
  useEffect(() => { if (!menu) return; const c = () => setMenu(null); addEventListener('click', c); addEventListener('scroll', c, true); return () => { removeEventListener('click', c); removeEventListener('scroll', c, true) } }, [menu])
  // Every PR url in the conversation (messages and tool output), so a later bare "#135188" draws as its pill.
  const last = items.at(-1)
  const prKey = `${items.length}:${last?.kind === 'assistant' ? last.blocks.map((b: any) => b.result === undefined ? 0 : 1).join('') : ''}`
  const known = useMemo(() => knownPrs(items.flatMap(it => it.kind === 'assistant' ? it.blocks.map((b: any) => b.type === 'tool' ? `${JSON.stringify(b.input ?? '')} ${b.result ?? ''}` : b.text ?? '') : 'text' in it ? [it.text] : [])), [prKey])
  // Follow-up timers this chat set, so the Waiting card can say whether each is still live.
  const hasTimers = items.some(it => it.kind === 'assistant' && it.blocks.some(b => b.type === 'tool' && ourMcpTool(b.name) === 'follow_up'))
  const promises = useLive<{ promises: PromiseRow[] }>(convId && hasTimers ? `/api/conversations/${encodeURIComponent(convId)}/promises` : null, ['conversations'], undefined, 60_000).data?.promises ?? []
  const renderEntry = ({ item: it, index: i }: Entry) => {
    const at = `${convId ?? ''}:${i}`
    if (it.kind === 'user') return <div key={i} data-item={at} className="msg user" onContextMenu={e => msgMenu(e, it.uuid, it.text)}><MsgActions uuid={it.uuid} onBranch={onBranch} onRewind={onRewind} text={it.text} ts={it.ts} /><UserBubble text={it.text} /></div>
    if (it.kind === 'error') return <div key={i} data-item={at} className="msg note bad">{it.text}<Fix text={it.text} items={items} at={i} convId={convId} /></div>
    if (it.kind === 'notice') return <div key={i} className="msg notice small muted">↳ {it.text}</div>
    if (it.kind === 'result') return (
      <div key={i} className={`msg result ${it.ok ? '' : 'bad'}`}>
        {it.ok ? 'done' : it.text} {!it.ok && <Fix text={it.text} items={items} at={i} convId={convId} />} {it.ms ? `· ${(it.ms / 1000).toFixed(1)}s` : ''} {it.cost ? `· $${it.cost.toFixed(2)}` : ''}
        {it.denials ? <span className="warn"> · {it.denials} tool call{it.denials > 1 ? 's' : ''} denied by permission mode</span> : null}
        {it.switched ? <span className="warn" title="The new model had no cache of this conversation, so the whole context was loaded again"> · model switch reloaded {Math.round(it.switched.tokens / 1000)}k tokens (~${it.switched.cost.toFixed(2)})</span> : null}
      </div>
    )
    // Where the model changes between replies, say which (Auto routing, a cap, or your pick).
    const prevModel = (items.slice(0, i).reverse().find(x => x.kind === 'assistant' && (x as any).model) as any)?.model
    const changed = it.model && prevModel && modelName(it.model) !== modelName(prevModel)
    return (
      <div key={i} data-item={at} className="msg assistant" onContextMenu={e => msgMenu(e, it.uuid, textOf(it))}>
        {changed && <div className="model-switch small muted">↳ {modelName(it.model!)}</div>}
        <MsgActions uuid={it.uuid} onBranch={onBranch} onRewind={onRewind} text={textOf(it)} ts={it.ts} />
        {it.blocks.map((b, j) => b.type === 'text' && blockerInText(b.text) ? <div key={j}><Markdown text={b.text} /><Fix text={b.text} items={items} at={i} convId={convId} /></div>
          : b.type === 'text' ? <RichText key={j} text={b.text} />
          : b.type === 'tool' && ourMcpTool(b.name) === 'draft_slack_message' && /draft:([\w-]+)/.test(b.result ?? '') ? <SlackDraftCard key={j} id={(b.result ?? '').match(/draft:([\w-]+)/)![1]} />
          : b.type === 'tool' ? <ToolViz key={j} b={b} />
          : b.text ? <details key={j} className="thinking"><summary>thinking</summary><div>{b.text}</div></details> : null)}
        {it.activity && <Activity activity={it.activity} />}
        {it.model && <span className="model-chip" aria-label={`Model: ${modelName(it.model)}`}><Brand id={modelBrand(it.model)} size={12} title={`Answered by ${modelName(it.model)} (${it.model})`} /></span>}
      </div>
    )
  }
  return (
    <PrRefs.Provider value={known}><Focus.Provider value={focus}>
      {menu && (
        <div className="ctx" style={{ left: Math.min(menu.x, innerWidth - 230), top: Math.min(menu.y, innerHeight - 110) }}>
          <button onClick={() => copyText(menu.text)}>⧉ Copy message</button>
          {menu.uuid && onBranch && <>
            <button onClick={() => onBranch?.(menu.uuid!)}>⑂ Branch from here</button>
            <button onClick={() => onRewind?.(menu.uuid!)}>↺ Rewind to here</button>
          </>}
        </div>
      )}
      {(fullFor === threadKey ? groupMessages(items, running) : groupMessages(items, running).slice(-TAIL_ROWS)).map(row => row.kind === 'item' ? renderEntry(row.entry) : <div key={`${convId ?? ''}:turn:${row.index}`} className="chat-turn">
        {(row.running || row.work.length > 0) && <WorkingCard turn={row} renderEntry={renderEntry} startedAt={(items[row.index - 1] as { ts?: number } | undefined)?.ts} />}
        {row.attention.map(renderEntry)}
        {!row.running && row.queued.map(renderEntry)}
        {row.answer.map(renderEntry)}
        {!row.running && <WaitCard waits={turnWaits([...row.work, ...row.answer])} promises={promises} />}
      </div>)}
      {convId && !running && items.some(x => x.kind === 'assistant') && <div className="msg rate-row"><Rate convId={convId} /></div>}
    </Focus.Provider></PrRefs.Provider>
  )
}

// Keeps the view pinned to the bottom while output streams, unless you scrolled up to read.
function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  useEffect(() => {
    const el = ref.current!
    const onScroll = () => { stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60 }
    el.addEventListener('scroll', onScroll)
    // Content also changes without this component rendering (the rest of a long thread filling in,
    // markdown and images settling): stay pinned through those too.
    const mo = new MutationObserver(() => { if (stuck.current) el.scrollTop = el.scrollHeight })
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    return () => { el.removeEventListener('scroll', onScroll); mo.disconnect() }
  }, [])
  useLayoutEffect(() => { if (stuck.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight })
  void dep
  return ref
}

// Long agent-driven chats bury your own last message under event batches and follow-ups. When it has
// scrolled off the top, a small pill on the line above the chat box takes you back to it; otherwise nothing shows.
const isHumanMsg = (it: Item) => it.kind === 'user' && !agentSender(it.text) && !(userBody(it.text) === it.text && perchSummary(it.text))
function JumpToMine({ items, convId, scroller }: { items: Item[]; convId: string | null; scroller: React.RefObject<HTMLDivElement | null> }) {
  const idx = items.findLastIndex(isHumanMsg)
  const [above, setAbove] = useState(false)
  useEffect(() => {
    const el = scroller.current
    if (!el || idx < 0 || !convId) { setAbove(false); return }
    let raf = 0
    const check = () => {
      raf = 0
      const m = el.querySelector<HTMLElement>(`[data-item="${CSS.escape(`${convId}:${idx}`)}"]`)
      // Not drawn yet (only the latest turns paint first) means it is above the view.
      setAbove(m ? m.getBoundingClientRect().bottom < el.getBoundingClientRect().top + 4 : el.scrollHeight > el.clientHeight)
    }
    const on = () => { if (!raf) raf = requestAnimationFrame(check) }
    check()
    el.addEventListener('scroll', on, { passive: true })
    const ro = new ResizeObserver(on); ro.observe(el)
    return () => { el.removeEventListener('scroll', on); ro.disconnect(); if (raf) cancelAnimationFrame(raf) }
  }, [idx, convId, items.length]) // eslint-disable-line
  if (!above || idx < 0 || !convId) return null
  const it = items[idx] as Extract<Item, { kind: 'user' }>
  const preview = userBody(it.text).replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  return <div className="jump-mine-wrap"><button className="jump-mine" title={`Jump to your last message${preview ? `:\n${preview.slice(0, 160)}` : ''}`}
    onClick={() => focusInChat(convId, { uuid: (it as any).uuid, ts: (it as any).ts })}>↑ your last message</button></div>
}

type Related = { id: string; title: string; snippet: string; updated_at: number; cwd: string | null; source: string }

export function Chat({ id, onOpen, onTerminal, settings, compact, panel, detailsOpen, onToggleDetails }: {
  id: string | null; onOpen: (id: string) => void; onTerminal: (resumeId: string) => void
  settings: any; compact: boolean; panel?: boolean; detailsOpen: boolean; onToggleDetails: () => void
}) {
  const showDecisions = !!settings?.decisions?.askMe
  const live = useRef<Live>(emptyLive())
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const [history, setHistory] = useState<Item[]>([])
  // null while the transcript is loading; how many tries it has taken, so a busy server reads as
  // "loading" instead of an empty chat (2026-11-17: chats opened blank while perch was swapping).
  const [loading, setLoading] = useState<number | null>(0)
  const { data: conv } = useLive<Conversation>(id ? `/api/conversations/${id}` : null, ['conversations'])
  const [btwOpen, setBtwOpen] = useState(false)

  // Load the transcript, then attach to the live stream.
  useEffect(() => {
    live.current = emptyLive()
    // A chat opened before shows what it had at once; the load below then brings it up to date.
    const had = id ? cachedThread<Item>(id) : undefined
    if (had) adopt(live.current, had)
    setHistory(had ?? [])
    setLoading(id && !had ? 0 : null)
    bump()
    if (!id) return
    // chat.open trace: click to first messages painted (tracing.ts); abandoned if you leave first.
    const t0 = performance.now()
    let opened = false
    const markOpen = (via: string, n: number) => { if (opened) return; opened = true; requestAnimationFrame(() => traceUi('chat.open', performance.now() - t0, { via, cached: !!had, tries: attempt + 1, items: n })) }
    let ws: WebSocket | null = null
    let closed = false
    let frame = 0
    const render = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; bump() }) }
    // Load the transcript and attach to the live stream. If either fails (perch restarting, busy, the
    // connection dropping), try again with a growing wait, keeping what's on screen, instead of
    // leaving the chat blank or silently no longer updating.
    let retry: any = null, attempt = 0
    if (had) markOpen('cache', had.length)
    const again = () => { if (closed || retry) return; setLoading(l => l === null ? l : attempt + 1); retry = setTimeout(() => { retry = null; connect() }, Math.min(10_000, 500 * 2 ** attempt++)) }
    // A thread not opened before: its last messages come first (a few KB, not the whole thread).
    let whole = !!had
    if (!had) api.get<{ items: Item[] }>(`/api/conversations/${id}/messages?tail=30`).then(({ items }) => {
      if (closed || whole || !Array.isArray(items) || !items.length) return
      setLoading(null); setHistory(items); render(); markOpen('tail', items.length)
    }).catch(() => {})
    const connect = () => loadThread<Item>(id).then(({ items }) => {
      if (closed) return
      if (!Array.isArray(items)) return again()
      whole = true
      live.current = emptyLive()
      setLoading(null)
      setHistory(items)
      adopt(live.current, items)
      render(); markOpen('full', items.length)
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/chat/${id}`)
      ws.onopen = () => { attempt = 0 }
      ws.onclose = () => { if (!closed) again() }
      ws.onmessage = e => {
        const ev = JSON.parse(e.data)
        // A replayed in-flight turn may already be partly in the transcript: drop that tail.
        if (ev.type === 'perch_user' && !ev.uuid && live.current.items.length === 0) {
          setHistory(h => dropReplayedPrompt(h, String(ev.text ?? '')))
        }
        apply(live.current, ev)
        if (ev.type === 'result') {
          post(`/api/conversations/${encodeURIComponent(id)}/seen`)
          // Swap the streamed turn for the saved transcript: same content, plus message ids.
          setTimeout(() => loadThread<Item>(id).then(({ items }) => {
            if (closed || live.current.running) return
            live.current = emptyLive()
            adopt(live.current, items)
            setHistory(items)
          }), 900)
        }
        render()
      }
    }).catch(again)
    connect()
    // Leaving a thread you watched update counts as having read it.
    return () => { if (!opened) traceUi('chat.open', performance.now() - t0, { abandoned: true, cached: false, tries: attempt + 1 }); closed = true; clearTimeout(retry); ws?.close(); cancelAnimationFrame(frame); post(`/api/conversations/${encodeURIComponent(id)}/seen`).catch(() => {}) }
  }, [id])

  // A turn replayed to a late subscriber repeats messages the transcript already has: keep the
  // streamed copy (it carries the rest of the turn) and drop the saved one, by API message id.
  const liveMids = new Set(live.current.items.flatMap(i => i.kind === 'assistant' && i.mid ? [i.mid] : []))
  const items = [...(liveMids.size ? history.filter(i => !(i.kind === 'assistant' && i.mid && liveMids.has(i.mid))) : history), ...live.current.items]
  const [rewinding, setRewinding] = useState<string | null>(null)
  const branch = async (uuid: string) => { const r = await post<any>(`/api/conversations/${id}/branch`, { uuid }); if (r.id) onOpen(r.id) }
  const scroller = useStickToBottom(items)
  const running = live.current.running

  // This conversation's terminal (an agent's terminal tool, or ▶ Run on a shell block) docks under the chat.
  // The conversation owns it: perch wakes the agent when the command finishes or waits for input.
  const root = useRef<HTMLDivElement>(null)
  const { data: termData, reload: reloadTerms } = useLive<{ terms: Term[] }>('/api/terms', ['terms'])
  // This chat's live terminals sit in the thread itself, after the latest message, so you watch the agent drive them.
  const ownTerms = id ? (termData?.terms ?? []).filter(t => t.owner === id && !t.exited).sort((a, b) => a.createdAt - b.createdAt) : []
  // Its agent browser window (server/browser.ts) docks there too, with any action waiting on your approval.
  const { data: browserData } = useBrowser()
  const browserOwned = !!id && !!browserData?.sessions.some(s => s.owner === id)
  const browserApprovals = id ? (browserData?.approvals ?? []).filter(a => a.owner === id && a.state === 'pending') : []
  // Where the live view sits: your last choice; with none, at the side when the chat is wide. A side
  // panel in a narrow chat drops to the strip below until the chat is wide again.
  const [dockChoice, setDockChoice] = useDockMode()
  const [chatW, setChatW] = useState(0)
  useEffect(() => {
    const el = root.current
    if (!el || !browserOwned) return
    const ro = new ResizeObserver(() => setChatW(el.clientWidth))
    ro.observe(el); setChatW(el.clientWidth)
    return () => ro.disconnect()
  }, [browserOwned])
  const wide = chatW === 0 || chatW >= SIDE_MIN_CHAT // not measured yet: don't flash the strip (it resets a fitted window)
  const dockMode = (dockChoice ?? (wide ? 'side' : 'bottom')) === 'side' && !wide ? 'bottom' : (dockChoice ?? (wide ? 'side' : 'bottom'))
  useEffect(() => {
    const el = root.current
    if (!el) return
    const f = async (e: Event) => {
      const cmd = String((e as CustomEvent).detail ?? '').trim()
      if (!cmd || !id) return
      await post('/api/terms', { prefill: cmd, conversationId: id })
      reloadTerms()
    }
    el.addEventListener('perch-run', f)
    return () => el.removeEventListener('perch-run', f)
  }, [id]) // eslint-disable-line

  return (
    <div className="chat" ref={root}>
      {id && !panel && (
        <div className="view-head" onDoubleClick={headDoubleClick}>
          <Title conv={conv} />
          <Family id={id} onOpen={onOpen} />
          {conv && <StateMenu c={conv} />}
          <SelfDriveButton id={id} />
          <button className="icon" title="Side question that isn't saved (/btw)  ⌘⇧B" onClick={() => setBtwOpen(!btwOpen)}>btw</button>
          <button className="icon" title="Open in Claude Code (terminal)" onClick={() => onTerminal(id)}>⌘_</button>
          {conv?.source === 'claude' && <CloudBar id={id} desktop running={running} />}
          <BoardButton conversationId={id} />
          <OpenIn id={id} />
          <MoreMenu id={id} items={items} onBranch={branch} onRewind={setRewinding} />
          {!compact && <button className={`icon ${detailsOpen ? 'on' : ''}`} title="Details: PRs, links, tools" onClick={onToggleDetails}>ⓘ</button>}
        </div>
      )}
      <div className="scroll" ref={scroller}>
        {id && <ConversationDecisions id={id} />}
        {!id && <NewChatHint />}
        {id && !items.length && (loading !== null || conv?.source === 'posthog-code') && <div className="msg note">{loading ? `Loading… auto-m8 is busy, retrying (try ${loading + 1})` : 'Loading…'}</div>}
        <Messages items={items} running={running} onBranch={id ? branch : undefined} onRewind={id ? setRewinding : undefined} convId={id} />
        {ownTerms.map(t => <div key={t.id} className="msg term-inline"><TermView term={t} compact onClose={reloadTerms} /></div>)}
      </div>
      {id && rewinding && <RewindDialog id={id} uuid={rewinding} onDone={nid => { setRewinding(null); if (nid) onOpen(nid) }} />}
      {id && <OptimizeStrip id={id} />}
      {showDecisions && id && <DecisionStrip id={id} />}
      {id && btwOpen && <Btw id={id} onClose={() => setBtwOpen(false)} />}
      {id && browserOwned && <BrowserDock owner={id} approvals={browserApprovals} mode={dockMode} onMode={setDockChoice} />}
      {id && !browserOwned && browserApprovals.length > 0 && <div className="browser-dock collapsed"><ApprovalBar approvals={browserApprovals} /></div>}
      <JumpToMine items={items} convId={id} scroller={scroller} />
      <Composer id={id} running={running} settings={settings} onStarted={onOpen} onBtw={() => setBtwOpen(true)} compact={compact} conv={conv} shownInThread={lastFailureBlocked(items)} />
    </div>
  )
}

function NewChatHint() {
  return (
    <div className="empty">
      <div className="empty-title">New conversation</div>
      <div className="muted">Runs Claude Code with all your connectors. Earlier conversations that look related show up as you type, and you choose whether to pull them in.</div>
    </div>
  )
}

// What you've typed but not sent survives the box being rebuilt: resizing or moving the window
// switches layouts (compact, wide, picture in picture), which remounts the composer. Kept per
// conversation in sessionStorage, cleared once it's sent (empty).
export function useDraft(id: string | null, fresh?: () => string) {
  const key = `perch.compose.${id ?? 'new'}`
  const [text, setText] = useState(() => {
    const given = !id && fresh ? fresh() : '' // a prompt handed to a new chat wins over an old draft
    if (given) return given
    try { return sessionStorage.getItem(key) ?? '' } catch { return '' }
  })
  useEffect(() => { try { text ? sessionStorage.setItem(key, text) : sessionStorage.removeItem(key) } catch {} }, [key, text])
  // The draft follows you between devices: start typing on the Mac, finish on the phone.
  const synced = useRef(false)
  useEffect(() => {
    synced.current = false
    if (!id) return
    api.get<{ draft: { text: string } | null }>(`/api/drafts/${encodeURIComponent(id)}`)
      .then(r => { if (r.draft?.text) setText(t => t || r.draft!.text) }).catch(() => {}).finally(() => { synced.current = true })
  }, [id]) // eslint-disable-line
  useEffect(() => {
    if (!id || !synced.current) return
    const t = setTimeout(() => { fetch(`/api/drafts/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }).catch(() => {}) }, 600)
    return () => clearTimeout(t)
  }, [id, text])
  return [text, setText] as const
}

function Composer({ id, running, settings, onStarted, onBtw, compact, conv, shownInThread }: {
  id: string | null; running: boolean; settings: any; onStarted: (id: string) => void; onBtw: () => void; compact: boolean; conv?: Conversation; shownInThread?: boolean
}) {
  const outbox = useOutbox()
  const queued = outbox.filter(q => (q.body.id ?? null) === (id ?? null))
  const [text, setText] = useDraft(id, () => { const d = sessionStorage.getItem('perch.draft') ?? ''; sessionStorage.removeItem('perch.draft'); return d })
  const [folder] = useState<{ id: string; cwd: string | null; name: string } | null>(() => { if (id) return null; try { const f = JSON.parse(sessionStorage.getItem('perch.folder') ?? 'null'); sessionStorage.removeItem('perch.folder'); return f } catch { return null } })
  const [cwd, setCwd] = useState<string>(folder?.cwd ?? settings?.chat?.cwd ?? '')
  const [mode, setMode] = useState<string>(settings?.chat?.permissionMode ?? 'auto')
  // Turbo: per chat and sticky (perch remembers it); for a new chat, your last choice.
  const [turbo, setTurbo] = useState(() => { try { return !id && localStorage.getItem('perch.turbo.next') === '1' } catch { return false } })
  useEffect(() => { if (id) api.get<{ turbo: boolean }>(`/api/chat/${encodeURIComponent(id)}/turbo`).then(r => setTurbo(!!r.turbo)).catch(() => {}) }, [id])
  // Which model this chat runs on: Claude (your plan), Codex (ChatGPT plan) or a local Ollama model. Sticky per chat.
  const { data: local } = useLive<any>('/api/local', ['settings'])
  const [engine, setEngineS] = useState<string>(() => { try { return id ? '' : localStorage.getItem('perch.engine.next') ?? '' } catch { return '' } })
  // A sign-in perch already knows has lapsed: offer the fix before you send, not after it fails.
  const { data: connSt } = useLive<any>('/api/status', ['status'])
  const preBlock = knownBlocker(connSt, local, engine)
  useEffect(() => { if (id) api.get<{ engine: string }>(`/api/chat/${encodeURIComponent(id)}/engine`).then(r => setEngineS(r.engine ?? '')).catch(() => {}) }, [id])
  const pickEngine = (v: string) => {
    setEngineS(v)
    if (id) post(`/api/chat/${encodeURIComponent(id)}/engine`, { engine: v })
    else try { localStorage.setItem('perch.engine.next', v) } catch {}
  }
  const toggleTurbo = () => {
    const on = !turbo
    setTurbo(on)
    if (id) post(`/api/chat/${encodeURIComponent(id)}/turbo`, { on })
    else try { localStorage.setItem('perch.turbo.next', on ? '1' : '0') } catch {}
  }
  // Self drive for a chat that hasn't started yet (existing chats have the 🚗 in the header): it
  // switches on as soon as the chat starts.
  const [driving, setDriveNext] = useState(false)
  const toggleDrive = () => setDriveNext(v => !v)
  const started = (newId: string) => {
    if (!id && driving) { post(`/api/chat/${encodeURIComponent(newId)}/self-drive`, { on: true }); setDriveNext(false) }
    onStarted(newId)
  }
  const [context, setContext] = useState(true)
  const [pulled, setPulled] = useState<Related[]>([])
  const [related, setRelated] = useState<Related[]>([])
  const [dismissed, setDismissed] = useState(false)
  const { data: cmdData } = useLive<{ commands: Cmd[] }>('/api/commands')
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashClosed, setSlashClosed] = useState(false)
  // The skill list opens while the text before the cursor is a /word at the very start: so it works on
  // an empty message and in front of one you've already written, without touching the rest.
  const [caret, setCaret] = useState(0)
  const slashQ = /^\/(\S*)$/.exec(text.slice(0, caret))?.[1]
  const slashItems = slashQ !== undefined && !slashClosed ? matchCommands(cmdData?.commands ?? [], slashQ) : []
  useEffect(() => { setSlashIndex(0); if (!text.startsWith('/')) setSlashClosed(false) }, [slashQ]) // eslint-disable-line
  // Picking a skill replaces only the /word, and keeps whatever you'd written after it.
  const completeSlash = (c: Cmd) => {
    const rest = text.slice(text.search(/\s|$/)).trimStart()
    const next = `/${c.name} ${rest}`
    setText(next); setSlashClosed(true)
    requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(next.length, next.length); setCaret(next.length) })
  }
  // "+ → Use a skill": a / in front of your message, cursor right after it, list open.
  const openSkills = () => {
    const next = text.trim() ? `/ ${text}` : '/'
    setText(next); setSlashClosed(false)
    requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(1, 1); setCaret(1) })
  }
  const research = (q: string) => window.dispatchEvent(new CustomEvent('perch-research', { detail: q }))
  const [opt, setOpt] = useState<{ brief: string; direction: string; iterations: number; target: string } | null>(null)
  const [shared, setShared] = useSharedDraft(id)
  // Attached images: click a thumbnail to see it large above the box, keep typing, step through them.
  const [viewKey, setViewKey] = useState<string | null>(null)
  const [viewBig, setViewBig] = useState(false)
  const images = shared.filter(x => x.thumb)
  const viewAt = images.findIndex(x => x.key === viewKey)
  const viewing = viewAt >= 0 ? images[viewAt] : null
  const step = (d: number) => images.length && setViewKey(images[(viewAt + d + images.length) % images.length].key!)
  // Files, images and long pastes: uploaded at once, sent as attachments with the message.
  // Each attachment drops an invisible mark at the cursor (one Unicode tag character, unique per
  // attachment). On send it becomes "[Image 1]" / "[File 2]", so the agent knows where in the writing
  // it was added, without the marker cluttering the box. Numbers continue from what's already attached.
  const nextNum = (k: 'image' | 'file', taken: string[]) => {
    const used = shared.map(x => x.file?.label).concat(taken).filter((l): l is string => !!l && l.startsWith(k === 'image' ? 'Image ' : 'File ')).map(l => +l.split(' ')[1])
    return `${k === 'image' ? 'Image' : 'File'} ${Math.max(0, ...used) + 1}`
  }
  const markAt = (kinds: ('image' | 'file')[]) => {
    const out: { label: string; mark: string }[] = [], inUse = new Set([...text].filter(isMark).concat(shared.map(x => x.file?.mark ?? '')))
    for (const k of kinds) {
      const label = nextNum(k, out.map(o => o.label))
      let c = 0; while (c < MARKS && inUse.has(markChar(c))) c++
      const mark = c < MARKS ? markChar(c) : ''
      inUse.add(mark); out.push({ label, mark })
    }
    // At the cursor while typing; dropped on an unfocused box or handed over from Home: where the cursor
    // last was, or the end of the text when it never had one.
    const el = ta.current, focused = !!el && document.activeElement === el
    const at = Math.min(focused ? el!.selectionEnd : (caret || text.length), text.length), ins = out.map(o => o.mark).join('')
    if (ins) {
      setText(text.slice(0, at) + ins + text.slice(at)); setCaret(at + ins.length)
      requestAnimationFrame(() => { if (el) el.selectionStart = el.selectionEnd = at + ins.length })
    }
    return out
  }
  const markAtNone = (kinds: ('image' | 'file')[]) => {
    const out: { label: string; mark: string }[] = [], inUse = new Set([...text].filter(isMark).concat(shared.map(x => x.file?.mark ?? '')))
    for (const k of kinds) { let c = 0; while (c < MARKS && inUse.has(markChar(c))) c++; const mark = c < MARKS ? markChar(c) : ''; inUse.add(mark); out.push({ label: nextNum(k, out.map(o => o.label)), mark }) }
    return out
  }
  const attach = async (f: Blob, name: string, kind: 'image' | 'file', label: string, text?: string, mark?: { label: string; mark: string }) => {
    const key = Math.random().toString(36).slice(2)
    const thumb = kind === 'image' ? URL.createObjectURL(f) : undefined
    setShared(s => [...s, { key, title: name, summary: label, context: '', loading: true, thumb, file: { path: '', name, kind, media_type: f.type, label: mark?.label, mark: mark?.mark } }])
    if (thumb) setViewKey(k => k ?? key)
    try {
      const r = await post<any>('/api/attachments', text != null ? { name, text } : { name, base64: await toBase64(f) })
      if (r.error) throw new Error(r.error)
      setShared(s => s.map(x => x.key === key ? { ...x, loading: false, summary: r.lines ? `${r.lines} lines` : label, file: { ...x.file!, path: r.path, bytes: r.bytes, lines: r.lines } } : x))
      if (thumb) setShared(s => s.map(x => x.key === key ? { ...x, thumb: rawUrl(r.path) } : x)) // a blob: URL wouldn't survive the box being rebuilt
    } catch (e: any) { setShared(s => s.map(x => x.key === key ? { ...x, loading: false, failed: true, summary: e.message ?? 'couldn’t attach it' } : x)) }
  }
  const takeFiles = (files: File[]) => {
    const list = files.slice(0, 20), isImg = (f: File) => /^image\//.test(f.type)
    const labels = markAt(list.map(f => isImg(f) ? 'image' : 'file'))
    list.forEach((f, i) => {
      if (isImg(f)) shrink(f).then(b => attach(b, f.name || `image-${Date.now()}.png`, 'image', `${Math.round(b.size / 1024)} KB image`, undefined, labels[i]))
      else attach(f, f.name, 'file', `${f.size > 1e6 ? `${(f.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(f.size / 1024))} KB`}`, undefined, labels[i])
    })
  }
  // Images pasted or dropped on Home's box arrive here once the new chat opens.
  useEffect(() => { if (!id && handedFiles.length) takeFiles(handedFiles.splice(0)) }, []) // eslint-disable-line
  const takeLongText = (t: string) => attach(new Blob([t], { type: 'text/plain' }), `pasted-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.${sniff(t)}`, 'file', `${t.split('\n').length} lines`, t, markAt(['file'])[0])
  const [dragOver, setDragOver] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)

  // Drop or paste from the browser: links become chips with their live context; text a quote.
  const take = (dt: DataTransfer) => {
    const files = [...(dt.files ?? [])]
    if (files.length) { takeFiles(files); return true }
    const uris = (dt.getData('text/uri-list') || '').split(/\r?\n/).filter(u => /^https?:/.test(u))
    const text = dt.getData('text/plain') || ''
    const urls = uris.length ? uris : (text.match(/https?:\/\/\S+/g) ?? [])
    if (urls.length && (uris.length || text.trim().split(/\s+/).length <= urls.length)) {
      for (const url of [...new Set(urls)].slice(0, 6)) {
        setShared(s => [...s, { url, title: url, summary: 'reading…', context: url, loading: true }])
        post<any>('/api/enrich', { url }).then(r => setShared(s => s.map(x => x.url === url ? (r.error ? { ...x, summary: 'couldn’t read it; sent as a link', loading: false } : { ...r, loading: false }) : x)))
      }
      return true
    }
    if (isLong(text)) { takeLongText(text); return true }
    if (text.trim()) {
      setShared(s => [...s, { title: `“${text.trim().slice(0, 60)}${text.length > 60 ? '…' : ''}”`, summary: `${text.trim().split(/\s+/).length} words of selected text`, context: `Selected text the user shared:\n> ${text.trim().slice(0, 4000).replace(/\n/g, '\n> ')}` }])
      return true
    }
    return false
  }

  useEffect(() => { if (settings && !id) { setCwd(folder?.cwd || settings.chat.cwd); setMode(settings.chat.permissionMode) } }, [settings, id]) // eslint-disable-line
  useEffect(() => { setPulled([]); setRelated([]); setDismissed(false) }, [id])
  useEffect(() => { ta.current?.focus() }, [id])

  // Related conversations for the first message of a new chat (or on demand in an old one).
  useEffect(() => {
    if (id || !context || dismissed || text.trim().length < 16 || text.startsWith('/')) { if (!id) setRelated([]); return }
    const t = setTimeout(() => api.get<{ related: Related[] }>(`/api/related?q=${encodeURIComponent(text)}`).then(r => setRelated(r.related.slice(0, 3))), 500)
    return () => clearTimeout(t)
  }, [text, id, context, dismissed])

  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    const max = compact ? 120 : 240
    el.style.height = Math.min(el.scrollHeight, max) + 'px'
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [text, compact])

  async function submit() {
    const files = shared.filter(x => x.file?.path)
    const byMark = new Map(files.filter(x => x.file!.mark && x.file!.label).map(x => [x.file!.mark!, `[${x.file!.label}]`]))
    const typed = [...text].map(c => isMark(c) ? (byMark.get(c) ?? '') : c).join('')
    const prompt = typed.trim() || (files.length ? `(see the attached ${files.length === 1 ? (files[0].file!.kind === 'image' ? 'image' : 'file') : `${files.length} attachments`})` : '')
    if (!prompt || shared.some(x => x.loading)) return
    if (prompt.startsWith('/btw ') && id) { window.dispatchEvent(new CustomEvent('perch-btw', { detail: prompt.slice(5) })); onBtw(); setText(''); return }
    if (/^\/research\b/.test(prompt)) { research(prompt.replace(/^\/research\s*/, '')); setText(''); return }
    // A skill picked from the list: installed ones run as they are; store ones are loaded on demand.
    const sm = /^\/([\w.-]+)(?:\s+([\s\S]*))?$/.exec(prompt)
    const cmd = sm && (cmdData?.commands ?? []).find(c => c.name === sm[1] && c.kind !== 'perch')
    if (cmd) {
      const rest = (sm![2] ?? '').trim()
      setText('')
      const p2 = cmd.kind === 'store'
        ? `Use the "${cmd.name}" skill from the PostHog skill store: load it with use_skill, then follow it.${rest ? `\n\nTask: ${rest}` : ''}`
        : `Use the ${cmd.name} skill.${rest ? `\n\n${rest}` : ''}`
      const r = await sendChat<{ id: string }>({ id: id ?? undefined, prompt: p2, cwd: id ? undefined : cwd, mode, context: true, folderId: folder?.id })
      if (!id) started(r.id)
      return
    }
    if (/^\/(autoresearch|optimi[sz]e)\b/.test(prompt)) { setOpt({ brief: prompt.replace(/^\/\S+\s*/, ''), direction: 'minimize', iterations: 10, target: '' }); setText(''); return }
    setText('')
    const r = await sendChat<{ id: string }>({ id: id ?? undefined, prompt, cwd: id ? undefined : cwd, mode, context, contextIds: pulled.map(p => p.id), folderId: folder?.id, shared: shared.filter(x => !x.loading && !x.file), attachments: files.map(x => x.file), turbo, engine })
    setPulled([])
    setShared([])
    // Starting a new chat switches this composer's id in the same render as the clear above, so the
    // save effect only ever sees the new id: drop the "new" draft's attachments here, or they come
    // back in the next new chat.
    try { sessionStorage.removeItem(`perch.compose.shared.${id ?? 'new'}`) } catch {}
    setRelated([])
    if (!id || r.id !== id) started(r.id) // a carried-over conversation continues in a new chat
  }

  const findRelated = () => {
    const q = text.trim() || (conv ? titleOf(conv) : '')
    api.get<{ related: Related[] }>(`/api/related?q=${encodeURIComponent(q)}&exclude=${id ?? ''}`).then(r => { setRelated(r.related.slice(0, 4)); setDismissed(false) })
  }

  const suggestions = related.filter(r => !pulled.some(p => p.id === r.id))
  return (
    <div className={`composer ${dragOver ? 'drag-over' : ''}`}
      onDragOver={e => { e.preventDefault(); setDragOver(true) }} onDragLeave={() => setDragOver(false)}
      onDrop={e => { e.preventDefault(); setDragOver(false); take(e.dataTransfer) }}>
      {opt && (
        <div className="opt-setup">
          <b>Autoresearch</b><span className="muted small">An agent improves one metric step by step in its own git worktree, committing every improvement.</span>
          <textarea rows={3} value={opt.brief} placeholder="What to optimise, the exact command that prints the number, and constraints" onChange={e => setOpt({ ...opt, brief: e.target.value })} />
          <div className="row-flex">
            <select value={opt.direction} onChange={e => setOpt({ ...opt, direction: e.target.value })}><option value="minimize">lower is better</option><option value="maximize">higher is better</option></select>
            <label className="small">iterations <input type="number" min={1} max={50} style={{ width: 56 }} value={opt.iterations} onChange={e => setOpt({ ...opt, iterations: Number(e.target.value) })} /></label>
            <label className="small">stop at <input style={{ width: 70 }} placeholder="target" value={opt.target} onChange={e => setOpt({ ...opt, target: e.target.value })} /></label>
            <span className="grow" />
            <button className="primary" disabled={!opt.brief.trim()} onClick={async () => {
              const r = await post<any>('/api/autoresearch', { brief: opt.brief, direction: opt.direction, max_iterations: opt.iterations, target: opt.target === '' ? null : Number(opt.target), cwd: id ? conv?.cwd : cwd })
              setOpt(null)
              if (r.conversationId) onStarted(r.conversationId)
            }}>Start</button>
            <button onClick={() => setOpt(null)}>Cancel</button>
          </div>
        </div>
      )}
      {queued.length > 0 && (
        <div className="chips">
          {queued.map(q => <span key={q.key} className="chip" title={q.body.prompt}>⏳ Queued, sends when auto-m8 reconnects: “{hideAttachMarks(String(q.body.prompt ?? '')).slice(0, 60)}”</span>)}
        </div>
      )}
      {preBlock && !shownInThread && <BlockerCard blocker={preBlock} convId={id} compact={compact} />}
      {dragOver && <div className="drop-hint">Drop images, files, links, PRs or text to share them with the agent</div>}
      {viewing && (
        <div className={`attach-viewer${viewBig ? ' big' : ''}`} tabIndex={-1}
          onKeyDown={e => { if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1) } else if (e.key === 'ArrowRight') { e.preventDefault(); step(1) } else if (e.key === 'Escape') { e.preventDefault(); setViewKey(null); ta.current?.focus() } }}>
          <div className="attach-viewer-bar">
            <span className="muted">{images.length > 1 ? `${viewAt + 1} of ${images.length} · ` : ''}{viewing.title}</span>
            <span className="attach-viewer-tools">
              {images.length > 1 && <><button onClick={() => step(-1)} title="Previous image (Alt+←)">‹</button><button onClick={() => step(1)} title="Next image (Alt+→)">›</button></>}
              <button onClick={() => setViewBig(b => !b)} title={viewBig ? 'Smaller' : 'Larger'}>{viewBig ? '⤡' : '⤢'}</button>
              <button onClick={() => { setViewKey(null); ta.current?.focus() }} title="Close preview (Esc)">×</button>
            </span>
          </div>
          <div className="attach-viewer-img">
            {images.length > 1 && <button className="attach-viewer-nav prev" onClick={() => step(-1)} aria-label="Previous image">‹</button>}
            <img src={viewing.thumb} alt={viewing.title} onClick={() => setViewBig(b => !b)} />
            {images.length > 1 && <button className="attach-viewer-nav next" onClick={() => step(1)} aria-label="Next image">›</button>}
          </div>
        </div>
      )}
      {shared.length > 0 && (
        <div className="chips">
          {shared.map((x, i) => <span key={x.key ?? i} className={`chip shared${x.thumb ? ' has-thumb' : ''}${x.failed ? ' failed' : ''}${x.thumb && x.key === viewKey ? ' viewing' : ''}`} title={x.thumb ? 'Click to preview' : x.file?.path || x.summary}
            onClick={x.thumb ? () => setViewKey(k => k === x.key ? null : x.key!) : undefined}>
            {x.thumb ? <img src={x.thumb} alt="" /> : x.loading ? '…' : x.file ? '📄' : x.url?.includes('/pull/') ? '⇅' : '🔗'} {x.title.slice(0, 56)}<span className="muted"> {x.loading && x.file ? 'attaching…' : x.summary}</span>
            <button onClick={e => { e.stopPropagation(); if (x.key === viewKey) setViewKey(null); if (x.thumb) URL.revokeObjectURL(x.thumb); setShared(shared.filter((_, j) => j !== i)); const m = x.file?.mark; if (m) setText(t => t.split(m).join('')) }} title="Remove">×</button></span>)}
        </div>
      )}
      {!dismissed && suggestions.length > 0 && (
        <div className="related">
          <div className="related-head"><span>Looks related</span><button className="link" onClick={() => setDismissed(true)}>dismiss</button></div>
          {suggestions.map(r => (
            <div key={r.id} className="related-row">
              <div className="grow">
                <div className="related-title">{r.title}</div>
                <div className="muted small" dangerouslySetInnerHTML={{ __html: escapeSnippet(r.snippet) }} />
              </div>
              <span className="muted small">{ago(r.updated_at)}</span>
              <button onClick={() => setPulled([...pulled, r])} title="Add a brief of it to this message">Pull in</button>
              <button onClick={() => onStarted(r.id)} title="Open it and continue there instead">Continue there</button>
            </div>
          ))}
        </div>
      )}
      {pulled.length > 0 && (
        <div className="chips">
          {pulled.map(p => <span key={p.id} className="chip">↳ {p.title.slice(0, 40)} <button onClick={() => setPulled(pulled.filter(x => x.id !== p.id))}>×</button></span>)}
        </div>
      )}
      <SlashList items={slashItems} index={slashIndex} onPick={completeSlash} />
      <div className="input-row">
        <PlusMenu onAutoresearch={() => setOpt({ brief: text, direction: 'minimize', iterations: 10, target: '' })} onResearch={() => { if (text.trim()) { research(text.trim()); setText('') } else ta.current?.focus() }}
          onSkill={openSkills} onLink={url => { const dt = new DataTransfer(); dt.setData('text/uri-list', url); take(dt) }} />
        <textarea
          ref={ta} rows={1} value={text} placeholder={id ? (running ? 'Queue a follow-up…  (/btw for a side question)' : 'Reply…  (/btw for a side question)') : 'Ask anything…'}
          onChange={e => { setText(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length) }}
          onSelect={e => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onPaste={e => {
            // Screenshots and copied files attach; a lone link gets read; a long paste becomes a file chip.
            const files = [...e.clipboardData.items].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean) as File[]
            if (files.length) { e.preventDefault(); takeFiles(files); return }
            const t = e.clipboardData.getData('text/plain')
            // A copied chat message carries its attachments as markup: turn them back into chips.
            const copied = copiedMessage(t)
            if (copied) {
              e.preventDefault()
              const fresh = copied.files.filter(f => !shared.some(x => x.file?.path === f.path))
              const marks = markAtNone(fresh.map(f => f.kind))
              fresh.forEach((f, i) => { if (f.label) copied.text = copied.text.split(`[${f.label}]`).join(marks[i].mark); f.label = marks[i].label; f.mark = marks[i].mark })
              copied.text = copied.text.replace(/\[(?:Image|File) \d+\]/g, '')
              setShared(s => [...s, ...fresh.map(f => f.kind === 'image'
                ? { key: f.path, title: f.name, summary: 'image', context: '', thumb: rawUrl(f.path), file: f }
                : { key: f.path, title: f.name, summary: 'file', context: '', file: f })])
              if (copied.text) {
                const el = e.currentTarget, a = el.selectionStart ?? text.length, b = el.selectionEnd ?? a
                const next = text.slice(0, a) + copied.text + text.slice(b)
                if (isLong(next)) { takeLongText(copied.text); return }
                setText(next); setCaret(a + copied.text.length)
                requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = a + copied.text.length })
              }
              return
            }
            if (isLong(t)) { e.preventDefault(); takeLongText(t); return }
            if (/^\s*https?:\/\/\S+\s*$/.test(t) && take(e.clipboardData)) e.preventDefault()
          }}
          onKeyDown={e => {
            if (viewing && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); step(e.key === 'ArrowLeft' ? -1 : 1); return }
            if (slashItems.length) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex(i => (i + 1) % slashItems.length); return }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex(i => (i - 1 + slashItems.length) % slashItems.length); return }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); completeSlash(slashItems[slashIndex]); return }
              if (e.key === 'Escape') { e.preventDefault(); setSlashClosed(true); if (slashQ === '') setText(t => t.replace(/^\/ ?/, '')); return }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
          }}
        />
        <button className={`turbo-btn${turbo ? ' on' : ''}`} onClick={toggleTurbo} aria-pressed={turbo} disabled={isLocalEngine(engine)}
          title={turbo ? 'Turbo is on for this chat: top model, high effort, parallel subagents, then a verify pass. Click to turn off.' : 'Turbo: finish faster with the top model working in parallel'}>⚡</button>
        {running && id
          ? <button className="stop" onClick={() => post(`/api/chat/${id}/interrupt`)} title="Stop">■</button>
          : <button className="primary" onClick={submit} disabled={!text.trim()}>↵</button>}
        {!id && <button className={`turbo-btn${driving ? ' on' : ''}`} onClick={toggleDrive} aria-pressed={driving}
          title={driving ? 'Self drive turns on when this chat starts: an agent takes control and keeps it going. Click to cancel.' : 'Self drive: let an agent take control of this chat once it starts'}>🚗</button>}
      </div>
      <div className="composer-opts">
        {!id && folder && <span className="chip">📁 {folder.name}</span>}
        {driving && !id && <span className="chip">🚗 Self drive on start</span>}
        {!id && <input className="cwd" value={cwd} onChange={e => setCwd(e.target.value)} title="Working directory" list="cwds" />}
        {id && conv?.cwd && <span className="muted small" title={`${conv.cwd}\nRight-click to show in Finder`} data-path={conv.cwd} data-dir="1">{baseName(conv.cwd)}{conv.branch ? ` · ${conv.branch}` : ''}</span>}
        {/* Which model: Auto picks per message from what you already pay for; or pin one. */}
        <EnginePicker value={engine || 'auto'} onChange={pickEngine} local={local} className={isLocalEngine(engine) ? 'local' : ''}
          title={engine === 'auto' || !engine ? 'Auto: Haiku for quick asks, Sonnet for everyday work, Opus for heavy thinking; Claude and Codex cover for each other: when one hits its cap or is signed out, the other takes over with the same context, tools and memory' : engine.startsWith('codex') ? 'Codex on your ChatGPT plan: same conversation, auto-m8 tools, MCP servers, instructions, memory and skills. Switch back to Claude any time.' : isLocalEngine(engine) ? (engine.endsWith(':cloud') ? `Runs on ${engine} through Ollama's cloud (your Ollama account), with all of Claude Code's tools` : `Runs on ${engine} on this Mac: private and free, slower and less capable than Claude`) : 'A fixed Claude model on your plan'} />
        <ClaudePressure />
        <select value={mode} onChange={e => setMode(e.target.value)} title="Permission mode (fixed per process; changing it restarts the session)">
          {['auto', 'acceptEdits', 'plan', 'manual', 'dontAsk', 'bypassPermissions'].map(m => <option key={m}>{m}</option>)}
        </select>
        {!id && (
          <label className="toggle" title="Off: a clean chat with no memory of you. No CLAUDE.md, memory, settings, MCP servers, skills, auto-m8 instructions or other conversations; runs in an empty folder and stays clean on every reply.">
            <input type="checkbox" checked={context} onChange={e => setContext(e.target.checked)} /> context
          </label>
        )}
        {id && <button className="link small" onClick={findRelated}>find related</button>}
      </div>
      <CwdList />
    </div>
  )
}

function CwdList() {
  const { data } = useLive<{ conversations: Conversation[] }>('/api/conversations?limit=200', [])
  const cwds = useMemo(() => [...new Set((data?.conversations ?? []).map(c => c.cwd).filter(Boolean))].slice(0, 30), [data])
  return <datalist id="cwds">{cwds.map(c => <option key={c!} value={c!}>{shortPath(c)}</option>)}</datalist>
}

export const escapeSnippet = (s: string) =>
  (s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!).replace(/«/g, '<mark>').replace(/»/g, '</mark>')

// /btw: ask about the conversation without adding to it. Answers live only in this panel.
function Btw({ id, onClose }: { id: string; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [log, setLog] = useState<{ q: string; a: string; done: boolean }[]>([])
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => {
    const f = (e: Event) => ask((e as CustomEvent).detail)
    window.addEventListener('perch-btw', f)
    return () => window.removeEventListener('perch-btw', f)
  })

  async function ask(question: string) {
    if (!question.trim()) return
    setQ('')
    const idx = log.length
    setLog(l => [...l, { q: question, a: '', done: false }])
    const res = await fetch(`/api/chat/${id}/btw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) })
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i).replace(/^data: /, '')
        buf = buf.slice(i + 2)
        let ev: any
        try { ev = JSON.parse(chunk) } catch { continue }
        const delta = ev.type === 'stream_event' && ev.event?.delta?.type === 'text_delta' ? ev.event.delta.text : ''
        const err = ev.type === 'perch_done' && ev.error ? `\n\n_${ev.error}_` : ''
        setLog(l => l.map((x, k) => k === idx ? { ...x, a: x.a + delta + err, done: ev.type === 'perch_done' || x.done } : x))
      }
    }
    setLog(l => l.map((x, k) => k === idx ? { ...x, done: true } : x))
  }

  return (
    <div className="btw">
      <div className="btw-head"><b>btw</b><span className="muted small grow">side questions see the whole conversation and are never saved into it</span><button className="icon" onClick={onClose}>×</button></div>
      <div className="btw-log">
        {log.map((x, i) => (
          <div key={i}><div className="btw-q">{x.q}</div>{x.a ? <Markdown text={x.a} /> : !x.done && <div className="muted small">thinking…</div>}</div>
        ))}
      </div>
      <input ref={input} value={q} placeholder="Quick question about this conversation…" onChange={e => setQ(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') ask(q); if (e.key === 'Escape') onClose() }} />
    </div>
  )
}

// Rewinding asks one thing: should the files go back too? (Only when a restore point exists.)
function RewindDialog({ id, uuid, onDone }: { id: string; uuid: string; onDone: (newId?: string) => void }) {
  const { data } = useLive<{ snapshots: any[] }>(`/api/conversations/${id}/snapshots`)
  const [files, setFiles] = useState(false)
  const [busy, setBusy] = useState(false)
  const has = (data?.snapshots.length ?? 0) > 0
  return (
    <div className="rewind">
      <b>Rewind to this point?</b>
      <span className="muted small">You continue in a new branch from here. The original stays, moved to Later.</span>
      {has && <label className="toggle"><input type="checkbox" checked={files} onChange={e => setFiles(e.target.checked)} /> also put the files back as they were then (your current files are saved first)</label>}
      <div className="row-flex">
        <button className="primary" disabled={busy} onClick={async () => { setBusy(true); const r = await post<any>(`/api/conversations/${id}/rewind`, { uuid, files }); onDone(r.id) }}>{busy ? 'Rewinding…' : 'Rewind'}</button>
        <button onClick={() => onDone()}>Cancel</button>
      </div>
    </div>
  )
}

// Autoresearch progress, only on conversations that are a run: the metric over iterations.
function OptimizeStrip({ id }: { id: string }) {
  const { data: r } = useLive<any>(`/api/autoresearch/for/${id}`, ['autoresearch' as any])
  if (!r || r.none || r.error) return null
  const its: any[] = r.iterations ?? []
  const vals = its.map(i => i.value)
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1
  const pts = vals.map((v, i) => `${(i / Math.max(1, vals.length - 1)) * 100},${28 - ((v - min) / span) * 26}`).join(' ')
  const unit = r.metric_unit ? ` ${r.metric_unit}` : ''
  const act = (a: string) => post(`/api/autoresearch/${r.id}/${a}`)
  return (
    <div className="opt-strip">
      <span className={`dot ${r.status === 'running' ? 's-running' : r.status === 'stalled' ? 'bad' : 'ok'}`} />
      <b className="small">{r.metric_name ?? 'metric'}</b>
      <span className="small">{r.best ? `best ${r.best.value}${unit}` : 'measuring baseline…'}{vals.length > 1 ? ` · from ${vals[0]}${unit}` : ''}</span>
      {vals.length > 1 && <svg className="spark-line" viewBox="0 0 100 30" preserveAspectRatio="none"><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>}
      <span className="muted small grow">{its.length}/{r.config.maxIterations} · {r.config.direction}{r.status !== 'running' ? ` · ${r.end_reason ?? r.status}` : ''}</span>
      {r.branch && <span className="muted small" title={r.worktree}>⑂ {r.branch}</span>}
      {r.status === 'running' && <button className="link small" onClick={() => act('pause')}>pause</button>}
      {r.status === 'paused' && <button className="link small" onClick={() => act('resume')}>resume</button>}
      {['running', 'paused'].includes(r.status) && <button className="link small" onClick={() => act('stop')}>stop</button>}
    </div>
  )
}

// ⋯ in the chat header: the conversation-level actions, out of the way until wanted.
function MoreMenu({ id, items, onBranch, onRewind }: { id: string; items: Item[]; onBranch: (u: string) => void; onRewind: (u: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const last = [...items].reverse().find(i => (i.kind === 'assistant' || i.kind === 'user') && (i as any).uuid) as any
  const lastUser = [...items].reverse().find(i => i.kind === 'user' && (i as any).uuid) as any
  return (
    <>
      <button ref={ref} className="icon" title="Branch, rewind, copy" onClick={() => setOpen(!open)}>⋯</button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)}>
        <div className="menu">
          <button disabled={!last} onClick={() => { onBranch(last.uuid); setOpen(false) }}>⑂ Branch from the latest message</button>
          <button disabled={!lastUser} onClick={() => { onRewind(lastUser.uuid); setOpen(false) }}>↺ Rewind before my last message</button>
          <button onClick={() => { navigator.clipboard?.writeText(`claude --resume ${id}`); setOpen(false) }}>Copy resume command</button>
          <div className="muted small pad-s">Tip: hover or right-click any message to branch or rewind from there.</div>
        </div>
      </Popover>
    </>
  )
}

type Cmd = { name: string; description: string; kind: 'perch' | 'skill' | 'store'; where?: string; mine?: boolean }

// The "/" list: perch commands first, then installed skills, then the store. Prefix matches rank first.
export function matchCommands(all: Cmd[], q: string): Cmd[] {
  const t = q.toLowerCase()
  const rank = (c: Cmd) => (c.name.startsWith(t) ? 0 : c.name.includes(t) ? 1 : c.description.toLowerCase().includes(t) ? 2 : 9) * 10 + ({ perch: 0, skill: 1, store: 2 }[c.kind])
  return all.map(c => ({ c, r: rank(c) })).filter(x => x.r < 90).sort((a, b) => a.r - b.r || a.c.name.length - b.c.name.length).slice(0, 8).map(x => x.c)
}

function SlashList({ items, index, onPick }: { items: Cmd[]; index: number; onPick: (c: Cmd) => void }) {
  if (!items.length) return null
  return (
    <div className="slash">
      {items.map((c, i) => (
        <button key={c.kind + c.name} className={`slash-row ${i === index ? 'on' : ''}`} onMouseDown={e => { e.preventDefault(); onPick(c) }}>
          <span className="slash-name">/{c.name}</span>
          <span className="muted small ellipsis grow">{c.description}</span>
          <span className="chip">{c.kind === 'perch' ? 'auto-m8' : c.kind === 'skill' ? (c.where ?? 'installed') : 'store'}</span>
        </button>
      ))}
      <div className="muted small slash-hint">↑↓ choose · Tab complete · Esc close</div>
    </div>
  )
}

function PlusMenu({ onAutoresearch, onResearch, onSkill, onLink }: { onAutoresearch: () => void; onResearch: () => void; onSkill: () => void; onLink: (url: string) => void }) {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const ref = useRef<HTMLButtonElement>(null)
  const { data: st } = useLive<any>(open ? '/api/status' : null)
  const connected = (st?.mcp?.servers ?? []).filter((s: any) => s.status === 'connected')
  const pick = (f: () => void) => { f(); setOpen(false) }
  return (
    <>
      <button ref={ref} className="plus" title="Modes, skills, links and connectors" onClick={() => setOpen(!open)}>+</button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} align="start" width={300}>
        <div className="menu plus-menu">
          <button onClick={() => pick(onResearch)}>🔬 Deep research <span className="muted small">parallel agents, all sources</span></button>
          <button onClick={() => pick(onAutoresearch)}>📈 Autoresearch <span className="muted small">improve one metric</span></button>
          <button onClick={() => pick(onSkill)}>⚡ Use a skill <span className="muted small">or type /</span></button>
          <div className="plus-link">
            <input value={url} placeholder="Add a link or PR…" onChange={e => setUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && /^https?:/.test(url.trim())) { onLink(url.trim()); setUrl(''); setOpen(false) } }} />
          </div>
          <hr />
          <div className="section-head">Connectors · {connected.length}</div>
          <div className="plus-connectors">{connected.slice(0, 14).map((s: any) => <span key={s.name} className="chip" title={s.name}><Brand id={brandFor(s.name)} size={12} /> {s.name.replace(/^claude\.ai |^plugin:[^:]+:/, '')}</span>)}</div>
          <button className="link small" onClick={() => pick(() => { location.hash = '#settings' })}>Manage connectors and plugins →</button>
        </div>
      </Popover>
    </>
  )
}

// Files from Home's start box, handed to the new chat it opens.
export const handedFiles: File[] = []
type Shared = { key?: string; url?: string; title: string; summary: string; context: string; loading?: boolean; failed?: boolean; thumb?: string
  file?: { path: string; name: string; kind: 'image' | 'file'; media_type?: string; bytes?: number; lines?: number | null; label?: string; mark?: string } }
// Invisible per-attachment marks in the composer text: Unicode tag characters, which render as nothing.
const MARK_BASE = 0xE0021, MARKS = 94
const markChar = (i: number) => String.fromCodePoint(MARK_BASE + i)
const isMark = (c: string) => { const n = c.codePointAt(0) ?? 0; return n >= MARK_BASE && n < MARK_BASE + MARKS }
const rawUrl = (p: string) => `/api/files/raw?path=${encodeURIComponent(p)}`
// Attachments (and shared links) survive the composer being rebuilt on resize, like the typed draft.
function useSharedDraft(id: string | null) {
  const key = `perch.compose.shared.${id ?? 'new'}`
  const [shared, setShared] = useState<Shared[]>(() => { try { return JSON.parse(sessionStorage.getItem(key) ?? '[]') } catch { return [] } })
  useEffect(() => {
    const keep = shared.filter(x => !x.loading && !x.failed).map(x => x.thumb?.startsWith('blob:') ? (x.file?.path ? { ...x, thumb: rawUrl(x.file.path) } : null) : x).filter(Boolean)
    try { keep.length ? sessionStorage.setItem(key, JSON.stringify(keep)) : sessionStorage.removeItem(key) } catch {}
  }, [key, shared])
  return [shared, setShared] as const
}
// A message copied out of a chat: its <attached-images>/<attached-files> blocks, the "🖼 1 image
// attached" footer and "[Image: source: …]" markers become attachments again instead of raw markup.
// "- [Image 1] /path/a.png" or "- /path/b.log (b.log, 3 lines)": the path, label and size note dropped.
export const attachedItems = (inner: string) => (inner.match(/^- .+$/gm) ?? []).map(l => {
  const label = /^- \[((?:Image|File) \d+)\] /.exec(l)?.[1]
  return { label, path: l.slice(2).replace(/^\[(?:Image|File) \d+\] /, '').replace(/ \([^()]*\)$/, '').trim() }
}).filter(x => x.path.startsWith('/'))
export const attachedPaths = (inner: string) => attachedItems(inner).map(x => x.path)
const IMG_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
export function copiedMessage(t: string): { text: string; files: NonNullable<Shared['file']>[] } | null {
  if (!/<attached-(images|files)>/.test(t)) return null
  const files: NonNullable<Shared['file']>[] = []
  const name = (p: string) => (p.split('/').pop() ?? p).replace(/^[0-9a-f]{8}-/, '')
  let rest = t.replace(/<attached-images>([\s\S]*?)<\/attached-images>\s*/g, (_m, inner: string) => {
    for (const { path, label } of attachedItems(inner)) {
      const ext = path.split('.').pop()?.toLowerCase() ?? ''
      files.push({ path, name: name(path), kind: 'image', media_type: IMG_TYPES[ext] ?? 'image/png', label })
    }
    return ''
  })
  rest = rest.replace(/<attached-files>([\s\S]*?)<\/attached-files>\s*/g, (_m, inner: string) => {
    for (const { path, label } of attachedItems(inner)) files.push({ path, name: name(path), kind: 'file', label })
    return ''
  })
  rest = rest.replace(/^\s*🖼\uFE0F? ?\d+ images? attached\s*$/gmu, '').replace(/^\s*\[Image: source: [^\]]*\]\s*$/gm, '')
    .replace(/^\(see the attached (?:image|file|\d+ attachments)\)$/m, '')
  return { text: rest.replace(/\n{3,}/g, '\n\n').trim(), files }
}
// Long enough that it would bury the message: becomes an attached file instead.
export const isLong = (t: string) => t.length > 2000 || t.split('\n').length > 40
export const sniff = (t: string) => /^\s*[[{]/.test(t) && (() => { try { JSON.parse(t); return true } catch { return false } })() ? 'json' : /^(diff --git|--- a\/)/m.test(t) ? 'diff' : /^#{1,3} |\n```/.test(t) ? 'md' : 'txt'
export const toBase64 = (b: Blob) => new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => bad(r.error); r.readAsDataURL(b) })
// Big screenshots and photos are scaled to what Claude reads anyway (~2000px), keeping uploads small.
export async function shrink(f: File): Promise<Blob> {
  if (!/^image\/(png|jpeg|webp)$/.test(f.type) || f.size < 1.5e6) return f
  try {
    const img = await createImageBitmap(f)
    const k = Math.min(1, 2000 / Math.max(img.width, img.height))
    if (k === 1 && f.size < 4e6) return f
    const c = new OffscreenCanvas(Math.round(img.width * k), Math.round(img.height * k))
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
    return await c.convertToBlob({ type: f.type === 'image/png' && f.size < 8e6 ? 'image/png' : 'image/jpeg', quality: 0.88 })
  } catch { return f }
}

// Did that answer hold up? Feeds the speed-vs-accuracy comparison in Insights.
function Rate({ convId }: { convId: string }) {
  const [v, setV] = useState<number>(0)
  useEffect(() => setV(0), [convId])
  const rate = (r: number) => { const n = v === r ? 0 : r; setV(n); post(`/api/chat/${encodeURIComponent(convId)}/rate`, { rating: n }) }
  return <span className="rate">
    <button className={`icon${v === 1 ? ' on' : ''}`} onClick={() => rate(1)} title="Good answer">👍</button>
    <button className={`icon${v === -1 ? ' on' : ''}`} onClick={() => rate(-1)} title="Missed">👎</button>
  </span>
}

// A reply as you'd paste it: its words, in Markdown (tool calls left out).
const textOf = (it: Item) => it.kind === 'assistant' ? it.blocks.filter(b => b.type === 'text').map((b: any) => b.text).join('\n\n').trim() : ''

// Double-click the title to rename the conversation; Enter saves, Esc cancels, empty restores the automatic title.
type FamilyMember = { id: string; title: string; parent: string | null; depth: number; kind: string | null; updated_at: number | null }
const FAMILY_KIND: Record<string, string> = { branch: 'branch', rewound: 'rewind', context: 'pulled in' }

// The chat this one branched from and every branch off it, as one small tree. Hidden when a
// chat has no family, so it adds nothing to the header most of the time.
function Family({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const { data } = useLive<{ root: string; members: FamilyMember[] }>(`/api/conversations/${encodeURIComponent(id)}/family`, ['conversations'])
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const m = data?.members ?? []
  if (m.length < 2) return null
  const self = m.find(x => x.id === id)
  const parent = self?.parent ? m.find(x => x.id === self.parent) : null
  return (
    <>
      <button ref={ref} className="icon family-btn" title={`${parent ? `Branched from: ${parent.title}\n` : ''}${m.length} chats in this family`} onClick={() => setOpen(!open)}>⑂ {m.length}</button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)}>
        <div className="menu family">
          <div className="muted small pad-s">This chat's family: where it branched from and every branch off it</div>
          {m.map(x => (
            <button key={x.id} className={`family-row ${x.id === id ? 'on' : ''}`} style={{ paddingLeft: 8 + x.depth * 14 }} disabled={x.id === id}
              onClick={() => { setOpen(false); onOpen(x.id) }} title={x.title}>
              <span className="muted">{x.depth ? '└' : '●'}</span>
              <span className="ellipsis grow">{x.title}</span>
              {x.kind && <span className="chip">{FAMILY_KIND[x.kind] ?? x.kind}</span>}
              {x.id === id && <span className="chip">you are here</span>}
            </button>
          ))}
        </div>
      </Popover>
    </>
  )
}

function Title({ conv }: { conv?: Conversation }) {
  const [edit, setEdit] = useState<string | null>(null)
  useEffect(() => { if (conv && takeRename(conv.id)) setEdit(titleOf(conv)) }, [conv?.id]) // eslint-disable-line
  if (!conv) return <div className="grow title">…</div>
  const save = () => { if (edit != null && edit.trim() !== titleOf(conv)) post(`/api/conversations/${encodeURIComponent(conv.id)}/title`, { title: edit.trim() }); setEdit(null) }
  return edit != null
    ? <input className="grow title-edit" autoFocus value={edit} onChange={e => setEdit(e.target.value)} onBlur={save} onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEdit(null) }} />
    : <div className="grow title"><span title={`${titleOf(conv)}\n(double-click to rename)`} onDoubleClick={e => { e.stopPropagation(); setEdit(titleOf(conv)) }}>{titleOf(conv)}</span></div>
}

// Double-clicking the empty part of a chat's header acts like a Mac title bar: fill the screen, or shrink
// back from it (the shell follows the macOS "double-click a window's title bar" setting).
function headDoubleClick(e: React.MouseEvent) {
  const t = e.target as HTMLElement
  if (t === e.currentTarget || t.classList.contains('title')) shell.titlebarDoubleClick?.()
}

const isLocalEngine = (e: string) => !!e && e !== 'auto' && !e.startsWith('claude:') && !e.startsWith('codex')

// Which logo goes with a model: Claude, OpenAI (Codex/GPT) or Ollama (any local model).
const modelBrand = (m: string) => /^claude/i.test(m) ? 'claude-mark' : /^(codex|gpt|o\d)|openai/i.test(m) ? 'openai' : 'ollama'

// claude-opus-5-5 → Opus; local and other models keep their own names.
const modelName = (m: string) => { const c = m.match(/^claude-(opus|sonnet|haiku|fable)/)?.[1]; return c ? c[0].toUpperCase() + c.slice(1) : m.replace(/:latest$/, '') }
