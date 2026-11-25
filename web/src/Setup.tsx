// First run and logins on Home.
// Fresh install (settings.welcome): one screen that says what auto-m8 found on this Mac, asks only
// for what's missing and required (Claude, GitHub), and ends by opening a chat that is already
// briefing you on your recent work. Later, if Claude or GitHub stops being ready, a small card says so.
import { useEffect, useRef, useState } from 'react'
import { api, post, useLive } from './api'
import { ClaudeLogin } from './Settings'

type Detected = {
  claude: { installed: boolean; loggedIn: boolean; email?: string }
  codex: { installed: boolean; loggedIn: boolean }
  gh: { installed: boolean; loggedIn: boolean; login?: string; name?: string; orgs: string[] }
  chats: { claude: number; cursor: number }
  repos: { count: number; suggested: string | null }
  mcp: { claude: string[]; codex: string[] }
  chrome: boolean
  ms: number
}

export function Setup({ settings, onTerminal, onOpen }: { settings: any; onTerminal: (cmd: string, title: string) => void; onOpen?: (id: string) => void }) {
  const { data: st } = useLive<any>('/api/status', ['status', 'settings'])
  if (!st || !settings) return null
  if (settings.welcome) return <FirstRun st={st} settings={settings} onTerminal={onTerminal} onOpen={onOpen} />
  const claudeOk = !!st.claude?.loggedIn, ghOk = !!st.gh?.ok
  // Still checking: say nothing yet rather than flash a red checklist.
  if (st.claude === undefined || st.gh === undefined) return null
  if (claudeOk && ghOk) return null
  return (
    <section className="card setup">
      <h3>auto-m8 needs a login</h3>
      <ClaudeRow st={st} />
      <GitHubRow ok={ghOk} account={st.gh?.account} onTerminal={onTerminal} />
    </section>
  )
}

const claudeMissing = (st: any) => /not found/i.test(st.claude?.error ?? '')
function ClaudeRow({ st }: { st: any }) {
  const ok = !!st.claude?.loggedIn, missing = claudeMissing(st)
  return <>
    <Row ok={ok} label="Claude Code" value={ok ? st.claude.email : missing ? 'Not installed. Chats run your own claude CLI.' : 'Not logged in'}
      action={missing
        ? <a href="https://docs.anthropic.com/en/docs/claude-code/setup" target="_blank" rel="noreferrer">Install ↗</a>
        : !ok && st.claudeLogin?.state !== 'waiting' && <button onClick={() => post('/api/claude/login')}>Log in</button>} />
    {!missing && <ClaudeLogin login={st.claudeLogin} />}
  </>
}
function GitHubRow({ ok, account, onTerminal }: { ok: boolean; account?: string; onTerminal: (cmd: string, title: string) => void }) {
  return <Row ok={ok} label="GitHub" value={ok ? account : 'Not logged in. PR status and checks come from the gh CLI.'}
    action={!ok && <button onClick={() => onTerminal('gh auth login', 'gh login')}>Log in</button>} />
}

const step = (s: string, ok = true, reason_code?: string) => post('/api/onboarding/step', { step: s, ok, reason_code }).catch(() => {})
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

function FirstRun({ st, settings, onTerminal, onOpen }: { st: any; settings: any; onTerminal: (cmd: string, title: string) => void; onOpen?: (id: string) => void }) {
  const [d, setD] = useState<Detected | null>(null)
  const [name, setName] = useState<string | null>(null)
  const [cwd, setCwd] = useState<string | null>(null)
  const [stats, setStats] = useState(settings.telemetry?.enabled !== false)
  const [busy, setBusy] = useState(false)
  const claudeOk = !!st.claude?.loggedIn, ghOk = !!st.gh?.ok
  // Detect once, then again whenever a login lands (to pick up the GitHub name and orgs).
  useEffect(() => { api.get<Detected>(`/api/onboarding/detect${d ? '?fresh=1' : ''}`).then(v => { setD(v); if (!d) step('detect') }).catch(() => step('detect', false, 'detect_failed')) }, [claudeOk, ghOk])
  // Report each required login as it turns green (or fails), for setup timings.
  const seen = useRef({ claude: claudeOk, github: ghOk })
  useEffect(() => { if (claudeOk && !seen.current.claude) step('claude'); seen.current.claude = claudeOk }, [claudeOk])
  useEffect(() => { if (ghOk && !seen.current.github) step('github'); seen.current.github = ghOk }, [ghOk])
  useEffect(() => { if (st.claudeLogin?.state === 'error') step('claude', false, 'login_error') }, [st.claudeLogin?.state])
  if (!d) return <section className="card setup"><h3>Setting up auto-m8</h3><p className="muted small">Looking at what's on this Mac…</p></section>

  const owner = name ?? (d.gh.name?.split(/\s+/)[0] || st.setup?.owner || '')
  const folder = cwd ?? (d.repos.suggested || settings.chat.cwd)
  const mcps = [...new Set([...d.mcp.claude, ...d.mcp.codex])]
  const finish = async (brief = true) => {
    setBusy(true)
    try {
      const r = await post<{ chatId?: string }>('/api/onboarding/finish', { name: owner, cwd: folder, telemetry: stats, brief })
      if (r?.chatId) onOpen?.(r.chatId)
    } finally { setBusy(false) }
  }
  return (
    <section className="card setup first-run">
      <h3>Welcome to auto-m8</h3>
      <p className="muted small">Found on this Mac in {(d.ms / 1000).toFixed(1)}s:</p>
      <ClaudeRow st={st} />
      <GitHubRow ok={ghOk} account={[st.gh?.account ?? d.gh.login, d.gh.orgs.length ? `(${d.gh.orgs.slice(0, 3).join(', ')})` : ''].filter(Boolean).join(' ')} onTerminal={onTerminal} />
      {d.codex.installed && <Row ok={d.codex.loggedIn} optional label="Codex" value={d.codex.loggedIn ? 'Logged in. Chats can hand work to it when Claude is capped.' : 'Installed, not logged in'} />}
      <Row ok={d.chats.claude + d.chats.cursor > 0} optional label="Your chats" value={d.chats.claude + d.chats.cursor
        ? [d.chats.claude && plural(d.chats.claude, 'Claude Code chat'), d.chats.cursor && plural(d.chats.cursor, 'Cursor chat')].filter(Boolean).join(', ') + ', searchable from every new chat'
        : 'None yet. New chats show up here.'} />
      <div className="line">
        <span className={`dot ${d.repos.count ? 'ok' : 'pending'}`} />
        <span className="line-label">Your code</span>
        <span className="grow muted small">{d.repos.count ? `${plural(d.repos.count, 'repo')}. New chats start in` : 'New chats start in'}</span>
        <input value={folder} onChange={e => setCwd(e.target.value)} size={22} />
      </div>
      {mcps.length > 0 && <Row ok optional label="MCP servers" value={`${mcps.length}: ${mcps.slice(0, 5).join(', ')}${mcps.length > 5 ? '…' : ''}. Every agent here gets them.`} />}
      <Row ok={d.chrome} optional label="Chrome" value={d.chrome ? 'Agents get their own window to browse in' : 'Not found. Agents can still read the web.'} />
      <div className="line">
        <span className="dot ok" />
        <span className="line-label">Your name</span>
        <span className="grow muted small">Agents work for you and sign GitHub comments with it</span>
        <input value={owner} onChange={e => setName(e.target.value)} size={12} />
      </div>
      <label className="line">
        <input type="checkbox" checked={stats} onChange={e => setStats(e.target.checked)} />
        <span className="grow small">Send anonymous usage stats <span className="muted">(no code, prompts, repo names or file paths)</span></span>
      </label>
      <p className="muted small">You can connect later, from Settings: agents acting on their own, PostHog, Slack, Grafana, phone.</p>
      <div className="row-flex setup-done">
        <span className="muted small grow">{claudeOk ? (ghOk ? 'Ready. Your first chat briefs you on your recent work.' : 'GitHub adds PR status and checks; you can log in later.') : 'Log in to Claude to start chatting.'}</span>
        {!claudeOk && <button className="link small" onClick={() => finish(false)}>Skip for now</button>}
        <button className="primary" disabled={!claudeOk || busy} onClick={() => finish(true)}>{busy ? 'Starting…' : 'Start'}</button>
      </div>
    </section>
  )
}

function Row({ ok, optional, label, value, action }: { ok: boolean; optional?: boolean; label: string; value?: string; action?: React.ReactNode }) {
  return (
    <div className="line">
      <span className={`dot ${ok ? 'ok' : optional ? 'pending' : 'bad'}`} />
      <span className="line-label">{label}</span>
      <span className="grow ellipsis" title={value}>{value}</span>
      {action}
    </div>
  )
}
