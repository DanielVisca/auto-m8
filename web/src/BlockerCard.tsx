// A card that clears a blocker from inside the chat: sign in to Claude or Codex, authorize an MCP
// server, sign in to GitHub, or paste a PostHog key, without hunting through Settings. After a Claude
// sign-in it sends your message again. Once the connection works the card turns green and offers the
// other connections still missing ("while you're at it"), none of which block anything.
// Works with no model available (blockers.ts is plain regexes).
import { useEffect, useRef, useState } from 'react'
import { post, sendChat, useLive } from './api'
import { serverLabel, type Blocker, type BlockerKind } from './blockers.ts'

type Props = { blocker: Blocker; convId?: string | null; resend?: string; compact?: boolean }

const openSettings = () => { location.hash = '#settings/connections'; dispatchEvent(new CustomEvent('perch:settings', { detail: 'connections' })) }

// A command that needs your keyboard or browser (codex login, gh auth login): a terminal docked under
// this chat, already running. Without a chat yet, a terminal view.
async function runInTerminal(cmd: string, title: string, convId?: string | null) {
  if (convId) await post('/api/terms', { prefill: cmd, conversationId: convId, run: true, title, needsUser: title })
  else dispatchEvent(new CustomEvent('perch:terminal', { detail: { cmd, title } }))
}

const NAMES: Record<BlockerKind, string> = { 'claude-login': 'Claude', 'claude-missing': 'Claude Code', 'codex-login': 'Codex', 'mcp-auth': '', 'gh-login': 'GitHub', 'posthog-key': 'PostHog' }

// Is this connection working now? undefined while perch hasn't checked yet.
function connectedNow(b: Blocker, st: any, local: any, mcp?: any): boolean | undefined {
  switch (b.kind) {
    case 'claude-login': return st?.claude ? !!st.claude.loggedIn && !st.claudeAuthLapse : undefined
    case 'claude-missing': return st?.claude ? !/not found/i.test(st.claude.error ?? '') : undefined
    case 'codex-login': return local?.codex ? !!local.codex.ok || !/signed out/i.test(local.codex.why ?? '') : undefined
    case 'gh-login': return st?.gh ? !!st.gh.ok : undefined
    case 'posthog-key': return st?.posthog ? !!st.posthog.hasKey && st.posthog.ok !== false : undefined
    case 'mcp-auth': return mcp?.state === 'done' || st?.mcp?.servers?.some((s: any) => s.name === b.server && s.status === 'connected') || undefined
  }
}

// Other connections that are missing but block nothing right now: offered once the blocker is cleared.
function optional(st: any, local: any, except: BlockerKind): Blocker[] {
  const out: Blocker[] = []
  if (except !== 'codex-login' && local?.codex && /signed out/i.test(local.codex.why ?? '')) out.push({ kind: 'codex-login', title: 'Codex', detail: 'covers for Claude when it hits a limit' })
  if (except !== 'gh-login' && st?.gh && !st.gh.ok) out.push({ kind: 'gh-login', title: 'GitHub', detail: 'PR status and shepherds' })
  if (except !== 'posthog-key' && st?.posthog && !st.posthog.hasKey) out.push({ kind: 'posthog-key', title: 'PostHog key', detail: 'tasks and scouts' })
  // Plugin and local MCP servers waiting on OAuth (claude.ai connectors are managed on claude.ai).
  const seen = new Set<string>()
  for (const s of (st?.mcp?.servers ?? []).filter((s: any) => s.status === 'needs-auth' && s.kind !== 'claude.ai')) {
    const title = serverLabel(s.name)
    if (seen.has(title) || seen.size >= 2) continue
    seen.add(title); out.push({ kind: 'mcp-auth', server: s.name, title, detail: 'MCP server' })
  }
  return out
}

function startFix(b: Blocker, convId?: string | null) {
  if (b.kind === 'claude-login') return post<any>('/api/claude/login', { conversationId: convId })
  if (b.kind === 'codex-login') return runInTerminal('codex login', 'Sign in to Codex', convId)
  if (b.kind === 'gh-login') return runInTerminal('gh auth login --web', 'Sign in to GitHub', convId)
  if (b.kind === 'claude-missing') return runInTerminal('curl -fsSL https://claude.ai/install.sh | bash', 'Install Claude Code', convId)
  openSettings() // PostHog key and MCP servers
}

export function BlockerCard({ blocker, convId, resend, compact }: Props) {
  const [started, setStarted] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const [extraStarted, setExtraStarted] = useState<string[]>([])
  // While a fix this card started is open, poll: the server says nothing when a sign-in starts.
  const polling = (started && !sent) || extraStarted.length > 0
  const { data: st, reload } = useLive<any>('/api/status', ['status'], undefined, polling ? 2000 : undefined)
  const { data: local } = useLive<any>('/api/local', ['settings'], undefined, polling ? 3000 : undefined)
  const [code, setCode] = useState('')
  const [key, setKey] = useState('')
  const [msg, setMsg] = useState('')
  const resentOnce = useRef(false)
  const login = st?.claudeLogin
  const codexOk = !!local?.codex?.ok
  const mcp: any = undefined // no in-app MCP sign-in here: MCP servers authorize from Connection settings

  // A Claude sign-in started from this card finished: send the message again, once. The last sign-in's
  // 'done' lingers in status, so only a 'done' after this card's sign-in was seen waiting counts.
  const sawWaiting = useRef(false)
  if (started && login?.state === 'waiting') sawWaiting.current = true
  useEffect(() => {
    if (blocker.kind !== 'claude-login' || !started || !sawWaiting.current || login?.state !== 'done' || resentOnce.current) return
    resentOnce.current = true
    if (convId && resend) sendChat({ id: convId, prompt: resend }).then(() => setSent('Your message was sent again.'), () => setSent('Send your message again.'))
    else setSent('You can send now.')
  }, [login?.state, started]) // eslint-disable-line

  // Mid sign-in, status can still read "logged in" (an expired session does): don't go green until it finishes.
  const midSignIn = blocker.kind === 'claude-login' && started && !sent
  const connected = !midSignIn && (!!(blocker.kind === 'claude-login' && sent && !/Codex/.test(sent)) || connectedNow(blocker, st, local, mcp) === true)
  const name = blocker.kind === 'mcp-auth' ? serverLabel(blocker.server!) : NAMES[blocker.kind]

  if (connected) {
    const extras = optional(st, local, blocker.kind).filter(x => !(x.kind === 'mcp-auth' && x.server === blocker.server))
    return (
      <div className={`blocker-card ok${compact ? ' compact' : ''}`} role="status">
        <div className="blocker-head"><b>✓ {name} connected</b>{sent ? <span className="muted small"> {sent}</span>
          : blocker.kind === 'claude-login' && convId && resend ? <> <button className="small" onClick={() => { setSent('Your message was sent again.'); sendChat({ id: convId, prompt: resend }) }}>Send that message again</button></> : null}</div>
        {extras.length > 0 && <div className="blocker-extras small">
          <span className="muted">While you’re at it (optional):</span>
          {extras.map(x => {
            const k = `${x.kind}:${x.server ?? ''}`, on = extraStarted.includes(k)
            return <button key={k} className="small" title={x.detail} disabled={on} onClick={() => { setExtraStarted([...extraStarted, k]); startFix(x, convId) }}>
              {on ? `${x.title}: finish in ${x.kind === 'mcp-auth' || x.kind === 'posthog-key' ? 'Settings' : 'the terminal'}` : `Connect ${x.title}`}</button>
          })}
        </div>}
      </div>
    )
  }

  let body: React.ReactNode = null, primary: React.ReactNode = null
  switch (blocker.kind) {
    case 'claude-login': {
      const waiting = login?.state === 'waiting'
      primary = sent ? <span className="muted small">{sent}</span> : waiting && started ? null
        : <button className="primary small" onClick={() => { setStarted(true); post<any>('/api/claude/login', { conversationId: convId }).then(r => { if (r?.state === 'waiting') sawWaiting.current = true; reload() }) }}>Sign in to Claude</button>
      if (waiting && started && !sent) body = <div className="row-flex small" style={{ flexWrap: 'wrap', gap: 6 }}>
        <span>Approve it in your browser.</span>
        {login.url && <a href={login.url} target="_blank" rel="noreferrer">Open the sign-in page</a>}
        <span className="muted">Got a code?</span>
        <input value={code} onChange={e => setCode(e.target.value)} placeholder="paste code" style={{ width: 150 }}
          onKeyDown={e => { if (e.key === 'Enter' && code.trim()) { post('/api/claude/login/code', { code }); setCode('') } }} />
        <button className="small" disabled={!code.trim()} onClick={() => { post('/api/claude/login/code', { code }); setCode('') }}>Submit</button>
      </div>
      else if (login?.state === 'failed' && started) body = <div className="small bad">Sign-in didn’t finish: {login.error}</div>
      if (!sent && codexOk && convId && resend) primary = <>{primary}<button className="small" title="Codex on your ChatGPT plan: same conversation, tools and memory" onClick={() => {
        sendChat({ id: convId, prompt: resend, engine: 'codex' }).then(() => setSent('Sent on Codex. Sign in to Claude any time to switch back.'))
      }}>Run on Codex instead</button></>
      break
    }
    case 'codex-login':
    case 'gh-login':
    case 'claude-missing':
      primary = started ? <span className="muted small">Finish in the terminal below; this card turns green when it’s connected.</span>
        : <button className="primary small" onClick={() => { setStarted(true); startFix(blocker, convId) }}>{blocker.kind === 'claude-missing' ? 'Install Claude Code' : `Sign in to ${name}`}</button>
      break
    case 'mcp-auth':
      primary = <button className="primary small" onClick={() => { setStarted(true); startFix(blocker, convId) }}>Authorize in Connection settings</button>
      if (started && mcp?.state === 'waiting' && mcp.url) body = <div className="small">Approve it in your browser · <a href={mcp.url} target="_blank" rel="noreferrer">open the sign-in page</a></div>
      else if (started && mcp?.state === 'failed') body = <div className="small bad">Didn’t finish: {mcp.error}</div>
      break
    case 'posthog-key':
      primary = <span className="row-flex" style={{ gap: 6 }}>
        <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder="phx_…" style={{ width: 180 }} />
        <button className="primary small" disabled={!key.trim()} onClick={async () => { const r = await post<any>('/api/posthog/key', { key }); setKey(''); setMsg(r.ok ? '' : r.error ?? 'PostHog rejected it'); reload() }}>Save key</button>
        {msg && <span className="small bad">{msg}</span>}
      </span>
      break
  }
  return (
    <div className={`blocker-card${compact ? ' compact' : ''}`} role="alert">
      <div className="blocker-head"><b>{blocker.title}</b>{!compact && <span className="muted small"> {blocker.detail}</span>}</div>
      <div className="blocker-actions">{primary}<button className="link small" onClick={openSettings}>Connection settings</button></div>
      {body}
    </div>
  )
}

// Before you send: blockers perch already knows about for the engine this chat runs on.
export function knownBlocker(st: any, local: any, engine: string): Blocker | null {
  const onCodex = engine.startsWith('codex')
  const onLocal = !!engine && engine !== 'auto' && !engine.startsWith('claude:') && !onCodex
  if (onLocal || !st) return null
  if (onCodex) return local?.codex && !local.codex.ok && /signed out/i.test(local.codex.why ?? '') ? { kind: 'codex-login', title: 'Codex is signed out', detail: 'Sign in with your ChatGPT account before you send.' } : null
  if (st.claude?.loggedIn === false && /not found/i.test(st.claude.error ?? '')) return { kind: 'claude-missing', title: 'Claude Code isn’t installed', detail: 'Install it, then sign in.' }
  const claudeOut = st.claude && st.claude.loggedIn === false
  const lapse = st.claudeAuthLapse && Date.now() - st.claudeAuthLapse.at < 6 * 3600_000
  if (claudeOut || lapse) return { kind: 'claude-login', title: 'Claude is signed out', detail: lapse ? 'A chat just reported the sign-in expired. Sign in now, before you send.' : 'Sign in now, before you send.' }
  return null
}
