import { BoardButton } from './Boards'
import { marked } from 'marked'
import { memo, useContext, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { ConversationDecisions, DecisionStrip } from './Decisions'
import { ago, api, baseName, post, sendChat, shortPath, useOutbox, titleOf, useLive, type Conversation, type Item, type Term } from './api'
import { adopt, apply, emptyLive, toolLabel, toolSummary, type Live } from './stream'
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
import { ApprovalBar, BrowserDock, useBrowser } from './BrowserView'
import { createRoot, type Root } from 'react-dom/client'
import { PR_URL, PrPill, PrRefs, bareRefs, knownPrs, linkPrRefs, type PrKnown } from './PrPill'
import { agentSender, userBody } from '../../shared/messageOrigin'
import { groupMessages, NEEDS_LOGIN, shortDuration, workPhases, workPulse, workSummary, type Entry, type Phase, type WorkTurn } from './chatActivity'
export { agentSender } from '../../shared/messageOrigin'
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
    if (!/^(~|\/(Users|private|tmp|var\/folders|Volumes))\/\S+\.[A-Za-z0-9]{1,8}$/.test(v)) return `<code>${esc(v)}</code>`
    const link = `<code class="file-path" data-path="${esc(v)}" title="View this file">${esc(v)}</code>`
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
// perch://<id> links (from Ask Claude and the brief) open that conversation in place.
const onLinkClick = (e: React.MouseEvent) => {
  const a = (e.target as HTMLElement).closest('a')
  const fp = (e.target as HTMLElement).closest('code.file-path') as HTMLElement | null
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
  if (href.startsWith('perch://')) { e.preventDefault(); window.dispatchEvent(new CustomEvent('perch-open', { detail: href.slice(8).replace(/\/$/, '') })) }
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

function ToolRow({ b }: { b: Extract<Item, { kind: 'assistant' }>['blocks'][number] & { type: 'tool' } }) {
  const [open, setOpen] = useState(false)
  const pending = b.result === undefined
  return (
    <div className={`tool ${b.isError ? 'err' : ''}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className={`dot ${pending ? 'pending' : b.isError ? 'bad' : 'ok'}`} />
        <span className="tool-name">{toolLabel(b.name)}</span>
        <span className="tool-sum">{toolSummary(b.name, b.input)}</span>
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

// Claude says "Please run /login" when its sign-in lapsed (or the OAuth token expired).
function LoginFix({ convId }: { convId?: string | null }) {
  return <div className="msg note bad small">Claude is signed out. <button onClick={() => dispatchEvent(new CustomEvent('perch:login', { detail: { convId } }))}>Sign in (/login)</button> then send your message again.</div>
}


// Links you shared in from the browser arrive as a <shared-from-browser> block (live) or "🔗 url" lines (history).
// Slack links become cards; everything else stays as text.
// Prompts perch itself injects (follow-ups, event batches, helper reports). The agent sees the
// whole text; the chat shows one line you can expand.
export function perchSummary(text: string): string | null {
  const f = text.match(/^⏰ Follow-up from perch\. Earlier you told the user: “([\s\S]*?)”\n([^\n]*)/)
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
  const imgs: string[] = [], files: string[] = []
  rest = rest.replace(/<attached-images>([\s\S]*?)<\/attached-images>\s*/g, (_m, inner: string) => { imgs.push(...(inner.match(/^- (.+)$/gm) ?? []).map(l => l.slice(2).trim())); return '' })
  rest = rest.replace(/<attached-files>([\s\S]*?)<\/attached-files>\s*/g, (_m, inner: string) => { files.push(...(inner.match(/^- (\/\S+)/gm) ?? []).map(l => l.slice(2).trim())); return '' })
  if (imgs.length) rest = rest.replace(/\n*🖼 \d+ images? attached\s*$/, '')
  if (imgs.length || files.length) rest = rest.replace(/^\(see the attached (?:image|file|\d+ attachments)\)$/, '')
  const prs: string[] = []
  rest = rest.replace(/^(?:🔗 )?(https?:\/\/\S+)\s*$/gm, (m, u: string) => { if (isSlackLink(u)) { urls.push(u); return '' } if (PR_URL.test(u)) { prs.push(u); return '' } return m }).trim()
  return <>
    {urls.map((u, i) => <SlackLinkCard key={i} url={u} />)}
    {prs.length > 0 && <div className="pr-inline-row">{prs.map((u, i) => <PrPill key={i} url={u} />)}</div>}
    {(imgs.length > 0 || files.length > 0) && <div className="attach-row">
      {imgs.map(p => <button key={p} className="attach-thumb" onClick={() => window.dispatchEvent(new CustomEvent('perch-file', { detail: p }))} title={`${baseName(p)}\nClick to view`}>
        <img src={`/api/files/raw?path=${encodeURIComponent(p)}`} alt={baseName(p)} loading="lazy" /></button>)}
      {files.map(p => <button key={p} className="chip attach-file" onClick={() => window.dispatchEvent(new CustomEvent('perch-file', { detail: p }))} title={p}>📄 {baseName(p).replace(/^[0-9a-f]{8}-/, '')}</button>)}
    </div>}
    {rest && <div className="bubble">{rest}</div>}
  </>
}

const PULSE_TITLE = { active: 'Working', waiting: 'Working', quiet: 'Quiet', stalled: 'Possibly stalled' } as const
const MOOD_LABEL = { smooth: 'Going smoothly', friction: 'Some friction', struggling: 'Struggling' } as const
const MARK_TITLE = { ok: 'Step succeeded', err: 'Step failed', pending: 'Running now', repeat: 'Repeated an earlier step' } as const

function WorkingCard({ turn, renderEntry, startedAt }: { turn: WorkTurn; renderEntry: (entry: Entry) => React.ReactNode; startedAt?: number }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const { preview, latestTool, steps, errors } = workSummary(turn.work)
  const intents = useMemo(() => workPhases(turn.work, turn.running).length, [turn.work, turn.running])
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
          {' · '}{idle < 5000 ? 'active now' : pulse.state === 'waiting' ? `step running ${shortDuration(idle)}` : `last activity ${shortDuration(idle)} ago`}</span>}
      </span>
      <span className={`work-chevron${open ? ' open' : ''}`} aria-hidden="true">›</span>
    </button>
    {turn.running && pulse && <div className="work-preview">
      <div className="work-update">{preview || 'Getting started…'}</div>
      {tool && <div className="work-current">{latestTool?.result === undefined ? 'Using' : 'Latest'} · {tool}</div>}
      {(pulse.plan || pulse.marks.length > 0) && <div className="work-pulse">
        {pulse.plan && <span className="work-plan" title={pulse.plan.current ? `Now: ${pulse.plan.current}` : 'From the agent\'s own task list'}>
          <span className="work-bar"><span style={{ width: `${Math.round(100 * pulse.plan.done / pulse.plan.total)}%` }} /></span>
          {pulse.plan.done}/{pulse.plan.total} tasks
        </span>}
        {pulse.marks.length > 0 && <span className="work-marks" title={pulse.why ?? 'Recent steps: green went through, red failed, amber repeated an earlier step'}>
          {pulse.marks.map((m, i) => <i key={i} className={`mark-${m}`} title={MARK_TITLE[m]} />)}
        </span>}
        <span className={`work-mood mood-${pulse.mood}`} title={pulse.why}>{MOOD_LABEL[pulse.mood]}{pulse.why ? ` · ${pulse.why}` : ''}</span>
      </div>}
    </div>}
    <div id={id} className="work-body" hidden={!open}>
      {open && (turn.work.length ? <WorkPhases turn={turn} renderEntry={renderEntry} /> : <div className="muted small">Waiting for the first update…</div>)}
    </div>
  </div>
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
  if (!p.results.length && !p.outcome) return <>{p.entries.map(renderEntry)}</>
  return <div className="phase-results">
    {p.outcome && <div className="phase-outcome"><Markdown text={p.outcome} /></div>}
    {p.results.length > 0 && <ul className="step-results">{p.results.map((r, i) =>
      <li key={i} className={r.isError ? 'bad' : ''}>
        <span className="step-mark" aria-label={r.isError ? 'failed' : 'done'}>{r.isError ? '✕' : '✓'}</span>
        <span className="step-label">{r.label}</span>
        <span className="step-excerpt" title={r.excerpt}>{r.excerpt}</span>
      </li>)}</ul>}
    <button className="link small muted phase-raw-toggle" onClick={() => setRaw(v => !v)}>{raw ? 'Hide' : 'Show'} {p.steps} tool call{p.steps === 1 ? '' : 's'}</button>
    {raw && <div className="phase-raw">{p.entries.map(renderEntry)}</div>}
  </div>
}

export function Messages({ items, running, onBranch, onRewind, convId }: { items: Item[]; running?: boolean; onBranch?: (u: string) => void; onRewind?: (u: string) => void; convId?: string | null }) {
  const [menu, setMenu] = useState<{ x: number; y: number; uuid?: string; text: string } | null>(null)
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
  const hasTimers = items.some(it => it.kind === 'assistant' && it.blocks.some(b => b.type === 'tool' && b.name === 'mcp__perch__follow_up'))
  const promises = useLive<{ promises: PromiseRow[] }>(convId && hasTimers ? `/api/conversations/${encodeURIComponent(convId)}/promises` : null, ['conversations'], undefined, 60_000).data?.promises ?? []
  const renderEntry = ({ item: it, index: i }: Entry) => {
    if (it.kind === 'user') return <div key={i} className="msg user" onContextMenu={e => msgMenu(e, it.uuid, it.text)}><MsgActions uuid={it.uuid} onBranch={onBranch} onRewind={onRewind} text={it.text} ts={it.ts} /><UserBubble text={it.text} /></div>
    if (it.kind === 'error') return <div key={i} className="msg note bad">{it.text}{NEEDS_LOGIN.test(it.text) && <LoginFix convId={convId} />}</div>
    if (it.kind === 'notice') return <div key={i} className="msg notice small muted">↳ {it.text}</div>
    if (it.kind === 'result') return (
      <div key={i} className={`msg result ${it.ok ? '' : 'bad'}`}>
        {it.ok ? 'done' : it.text} {!it.ok && NEEDS_LOGIN.test(it.text) && <LoginFix convId={convId} />} {it.ms ? `· ${(it.ms / 1000).toFixed(1)}s` : ''} {it.cost ? `· $${it.cost.toFixed(2)}` : ''}
        {it.denials ? <span className="warn"> · {it.denials} tool call{it.denials > 1 ? 's' : ''} denied by permission mode</span> : null}
        {it.switched ? <span className="warn" title="The new model had no cache of this conversation, so the whole context was loaded again"> · model switch reloaded {Math.round(it.switched.tokens / 1000)}k tokens (~${it.switched.cost.toFixed(2)})</span> : null}
      </div>
    )
    // Where the model changes between replies, say which (Auto routing, a cap, or your pick).
    const prevModel = (items.slice(0, i).reverse().find(x => x.kind === 'assistant' && (x as any).model) as any)?.model
    const changed = it.model && prevModel && modelName(it.model) !== modelName(prevModel)
    return (
      <div key={i} className="msg assistant" onContextMenu={e => msgMenu(e, it.uuid, textOf(it))}>
        {changed && <div className="model-switch small muted">↳ {modelName(it.model!)}</div>}
        <MsgActions uuid={it.uuid} onBranch={onBranch} onRewind={onRewind} text={textOf(it)} ts={it.ts} />
        {it.blocks.map((b, j) => b.type === 'text' && NEEDS_LOGIN.test(b.text) && b.text.length < 400 ? <div key={j}><Markdown text={b.text} /><LoginFix convId={convId} /></div>
          : b.type === 'text' ? <RichText key={j} text={b.text} />
          : b.type === 'tool' && b.name === 'mcp__perch__draft_slack_message' && /draft:([\w-]+)/.test(b.result ?? '') ? <SlackDraftCard key={j} id={(b.result ?? '').match(/draft:([\w-]+)/)![1]} />
          : b.type === 'tool' ? <ToolViz key={j} b={b} />
          : b.text ? <details key={j} className="thinking"><summary>thinking</summary><div>{b.text}</div></details> : null)}
        {it.activity && <Activity activity={it.activity} />}
        {it.model && <span className="model-chip" aria-label={`Model: ${modelName(it.model)}`}><Brand id={modelBrand(it.model)} size={12} title={`Answered by ${modelName(it.model)} (${it.model})`} /></span>}
      </div>
    )
  }
  return (
    <PrRefs.Provider value={known}>
      {menu && (
        <div className="ctx" style={{ left: Math.min(menu.x, innerWidth - 230), top: Math.min(menu.y, innerHeight - 110) }}>
          <button onClick={() => copyText(menu.text)}>⧉ Copy message</button>
          {menu.uuid && onBranch && <>
            <button onClick={() => onBranch?.(menu.uuid!)}>⑂ Branch from here</button>
            <button onClick={() => onRewind?.(menu.uuid!)}>↺ Rewind to here</button>
          </>}
        </div>
      )}
      {groupMessages(items, running).map(row => row.kind === 'item' ? renderEntry(row.entry) : <div key={`${convId ?? ''}:turn:${row.index}`} className="chat-turn">
        {(row.running || row.work.length > 0) && <WorkingCard turn={row} renderEntry={renderEntry} startedAt={(items[row.index - 1] as { ts?: number } | undefined)?.ts} />}
        {row.attention.map(renderEntry)}
        {row.answer.map(renderEntry)}
        {!row.running && <WaitCard waits={turnWaits([...row.work, ...row.answer])} promises={promises} />}
      </div>)}
      {convId && !running && items.some(x => x.kind === 'assistant') && <div className="msg rate-row"><Rate convId={convId} /></div>}
    </PrRefs.Provider>
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
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useLayoutEffect(() => { if (stuck.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight })
  void dep
  return ref
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
    setHistory([])
    setLoading(id ? 0 : null)
    bump()
    if (!id) return
    let ws: WebSocket | null = null
    let closed = false
    let frame = 0
    const render = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; bump() }) }
    // Load the transcript and attach to the live stream. If either fails (perch restarting, busy, the
    // connection dropping), try again with a growing wait, keeping what's on screen, instead of
    // leaving the chat blank or silently no longer updating.
    let retry: any = null, attempt = 0
    const again = () => { if (closed || retry) return; setLoading(l => l === null ? l : attempt + 1); retry = setTimeout(() => { retry = null; connect() }, Math.min(10_000, 500 * 2 ** attempt++)) }
    const connect = () => api.get<{ items: Item[] }>(`/api/conversations/${id}/messages`).then(({ items }) => {
      if (closed) return
      if (!Array.isArray(items)) return again()
      live.current = emptyLive()
      setLoading(null)
      setHistory(items)
      adopt(live.current, items)
      render()
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/chat/${id}`)
      ws.onopen = () => { attempt = 0 }
      ws.onclose = () => { if (!closed) again() }
      ws.onmessage = e => {
        const ev = JSON.parse(e.data)
        // A replayed in-flight turn may already be partly in the transcript: drop that tail.
        if (ev.type === 'perch_user' && !ev.uuid && live.current.items.length === 0) {
          setHistory(h => { const k = h.map(x => x.kind === 'user' ? x.text : null).lastIndexOf(ev.text); return k >= 0 && k >= h.length - 30 ? h.slice(0, k) : h })
        }
        apply(live.current, ev)
        if (ev.type === 'result') {
          post(`/api/conversations/${encodeURIComponent(id)}/seen`)
          // Swap the streamed turn for the saved transcript: same content, plus message ids.
          setTimeout(() => api.get<{ items: Item[] }>(`/api/conversations/${id}/messages`).then(({ items }) => {
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
    return () => { closed = true; clearTimeout(retry); ws?.close(); cancelAnimationFrame(frame); post(`/api/conversations/${encodeURIComponent(id)}/seen`).catch(() => {}) }
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
  const dock = id ? (termData?.terms ?? []).filter(t => t.owner === id && !t.exited).sort((a, b) => b.createdAt - a.createdAt)[0] : undefined
  // Its agent browser window (server/browser.ts) docks there too, with any action waiting on your approval.
  const { data: browserData } = useBrowser()
  const browserOwned = !!id && !!browserData?.sessions.some(s => s.owner === id)
  const browserApprovals = id ? (browserData?.approvals ?? []).filter(a => a.owner === id && a.state === 'pending') : []
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
        <div className="view-head">
          <Title conv={conv} />
          <Family id={id} onOpen={onOpen} />
          {conv && <StateMenu c={conv} />}
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
        {id && !items.length && (loading !== null || conv?.source === 'posthog-code') && <div className="msg note">{loading ? `Loading… perch is busy, retrying (try ${loading + 1})` : 'Loading…'}</div>}
        <Messages items={items} running={running} onBranch={id ? branch : undefined} onRewind={id ? setRewinding : undefined} convId={id} />
      </div>
      {id && rewinding && <RewindDialog id={id} uuid={rewinding} onDone={nid => { setRewinding(null); if (nid) onOpen(nid) }} />}
      {id && <OptimizeStrip id={id} />}
      {showDecisions && id && <DecisionStrip id={id} />}
      {id && btwOpen && <Btw id={id} onClose={() => setBtwOpen(false)} />}
      {id && browserOwned && <BrowserDock owner={id} approvals={browserApprovals} />}
      {id && !browserOwned && browserApprovals.length > 0 && <div className="browser-dock collapsed"><ApprovalBar approvals={browserApprovals} /></div>}
      {dock && <div className="term-dock"><TermView key={dock.id} term={dock} compact onClose={reloadTerms} /></div>}
      <Composer id={id} running={running} settings={settings} onStarted={onOpen} onBtw={() => setBtwOpen(true)} compact={compact} conv={conv} />
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

function Composer({ id, running, settings, onStarted, onBtw, compact, conv }: {
  id: string | null; running: boolean; settings: any; onStarted: (id: string) => void; onBtw: () => void; compact: boolean; conv?: Conversation
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
  const [shared, setShared] = useState<Shared[]>([])
  // Files, images and long pastes: uploaded at once, sent as attachments with the message.
  const attach = async (f: Blob, name: string, kind: 'image' | 'file', label: string, text?: string) => {
    const key = Math.random().toString(36).slice(2)
    const thumb = kind === 'image' ? URL.createObjectURL(f) : undefined
    setShared(s => [...s, { key, title: name, summary: label, context: '', loading: true, thumb, file: { path: '', name, kind, media_type: f.type } }])
    try {
      const r = await post<any>('/api/attachments', text != null ? { name, text } : { name, base64: await toBase64(f) })
      if (r.error) throw new Error(r.error)
      setShared(s => s.map(x => x.key === key ? { ...x, loading: false, summary: r.lines ? `${r.lines} lines` : label, file: { ...x.file!, path: r.path, bytes: r.bytes, lines: r.lines } } : x))
    } catch (e: any) { setShared(s => s.map(x => x.key === key ? { ...x, loading: false, failed: true, summary: e.message ?? 'couldn’t attach it' } : x)) }
  }
  const takeFiles = (files: File[]) => {
    for (const f of files.slice(0, 20)) {
      if (/^image\//.test(f.type)) shrink(f).then(b => attach(b, f.name || `image-${Date.now()}.png`, 'image', `${Math.round(b.size / 1024)} KB image`))
      else attach(f, f.name, 'file', `${f.size > 1e6 ? `${(f.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(f.size / 1024))} KB`}`)
    }
  }
  const takeLongText = (t: string) => attach(new Blob([t], { type: 'text/plain' }), `pasted-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.${sniff(t)}`, 'file', `${t.split('\n').length} lines`, t)
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
    const prompt = text.trim() || (files.length ? `(see the attached ${files.length === 1 ? (files[0].file!.kind === 'image' ? 'image' : 'file') : `${files.length} attachments`})` : '')
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
      if (!id) onStarted(r.id)
      return
    }
    if (/^\/(autoresearch|optimi[sz]e)\b/.test(prompt)) { setOpt({ brief: prompt.replace(/^\/\S+\s*/, ''), direction: 'minimize', iterations: 10, target: '' }); setText(''); return }
    setText('')
    const r = await sendChat<{ id: string }>({ id: id ?? undefined, prompt, cwd: id ? undefined : cwd, mode, context, contextIds: pulled.map(p => p.id), folderId: folder?.id, shared: shared.filter(x => !x.loading && !x.file), attachments: files.map(x => x.file), turbo, engine })
    setPulled([])
    setShared([])
    setRelated([])
    if (!id || r.id !== id) onStarted(r.id) // a carried-over conversation continues in a new chat
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
          {queued.map(q => <span key={q.key} className="chip" title={q.body.prompt}>⏳ Queued, sends when perch reconnects: “{String(q.body.prompt ?? '').slice(0, 60)}”</span>)}
        </div>
      )}
      {dragOver && <div className="drop-hint">Drop images, files, links, PRs or text to share them with the agent</div>}
      {shared.length > 0 && (
        <div className="chips">
          {shared.map((x, i) => <span key={x.key ?? i} className={`chip shared${x.thumb ? ' has-thumb' : ''}${x.failed ? ' failed' : ''}`} title={x.file?.path || x.summary}>
            {x.thumb ? <img src={x.thumb} alt="" /> : x.loading ? '…' : x.file ? '📄' : x.url?.includes('/pull/') ? '⇅' : '🔗'} {x.title.slice(0, 56)}<span className="muted"> {x.loading && x.file ? 'attaching…' : x.summary}</span>
            <button onClick={() => { if (x.thumb) URL.revokeObjectURL(x.thumb); setShared(shared.filter((_, j) => j !== i)) }} title="Remove">×</button></span>)}
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
            if (isLong(t)) { e.preventDefault(); takeLongText(t); return }
            if (/^\s*https?:\/\/\S+\s*$/.test(t) && take(e.clipboardData)) e.preventDefault()
          }}
          onKeyDown={e => {
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
      </div>
      <div className="composer-opts">
        {!id && folder && <span className="chip">📁 {folder.name}</span>}
        {!id && <input className="cwd" value={cwd} onChange={e => setCwd(e.target.value)} title="Working directory" list="cwds" />}
        {id && conv?.cwd && <span className="muted small" title={conv.cwd}>{baseName(conv.cwd)}{conv.branch ? ` · ${conv.branch}` : ''}</span>}
        {/* Which model: Auto picks per message from what you already pay for; or pin one. */}
        <EnginePicker value={engine || 'auto'} onChange={pickEngine} local={local} className={isLocalEngine(engine) ? 'local' : ''}
          title={engine === 'auto' || !engine ? 'Auto: Haiku for quick asks, Sonnet for everyday work, Opus for heavy thinking; Claude and Codex cover for each other: when one hits its cap or is signed out, the other takes over with the same context, tools and memory' : engine.startsWith('codex') ? 'Codex on your ChatGPT plan: same conversation, perch tools, MCP servers, instructions, memory and skills. Switch back to Claude any time.' : isLocalEngine(engine) ? (engine.endsWith(':cloud') ? `Runs on ${engine} through Ollama's cloud (your Ollama account), with all of Claude Code's tools` : `Runs on ${engine} on this Mac: private and free, slower and less capable than Claude`) : 'A fixed Claude model on your plan'} />
        <ClaudePressure />
        <select value={mode} onChange={e => setMode(e.target.value)} title="Permission mode (fixed per process; changing it restarts the session)">
          {['auto', 'acceptEdits', 'plan', 'manual', 'dontAsk', 'bypassPermissions'].map(m => <option key={m}>{m}</option>)}
        </select>
        {!id && (
          <label className="toggle" title="Off: no related-conversation suggestions and no access to your other conversations">
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
          <span className="chip">{c.kind === 'perch' ? 'perch' : c.kind === 'skill' ? (c.where ?? 'installed') : 'store'}</span>
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

type Shared = { key?: string; url?: string; title: string; summary: string; context: string; loading?: boolean; failed?: boolean; thumb?: string
  file?: { path: string; name: string; kind: 'image' | 'file'; media_type?: string; bytes?: number; lines?: number | null } }
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
    : <div className="grow title" title={`${titleOf(conv)}\n(double-click to rename)`} onDoubleClick={() => setEdit(titleOf(conv))}>{titleOf(conv)}</div>
}

const isLocalEngine = (e: string) => !!e && e !== 'auto' && !e.startsWith('claude:') && !e.startsWith('codex')

// Which logo goes with a model: Claude, OpenAI (Codex/GPT) or Ollama (any local model).
const modelBrand = (m: string) => /^claude/i.test(m) ? 'claude-mark' : /^(codex|gpt|o\d)|openai/i.test(m) ? 'openai' : 'ollama'

// claude-opus-5-5 → Opus; local and other models keep their own names.
const modelName = (m: string) => { const c = m.match(/^claude-(opus|sonnet|haiku|fable)/)?.[1]; return c ? c[0].toUpperCase() + c.slice(1) : m.replace(/:latest$/, '') }
