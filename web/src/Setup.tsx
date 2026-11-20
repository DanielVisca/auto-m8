// The setup checklist on Home. It shows on a fresh install until dismissed, and whenever Claude or
// GitHub stops being ready. Required items first, each with a one-click fix; optional ones
// below. Once everything required is green and it has been dismissed, it disappears.
import { useState } from 'react'
import { api, post, useLive } from './api'
import { ClaudeLogin } from './Settings'

export function Setup({ settings, onTerminal }: { settings: any; onTerminal: (cmd: string, title: string) => void }) {
  const { data: st } = useLive<any>('/api/status', ['status', 'settings'])
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')
  if (!st || !settings) return null
  const save = (patch: any) => api.send('PUT', '/api/settings', patch)
  const claudeOk = !!st.claude?.loggedIn, ghOk = !!st.gh?.ok
  // Still checking: say nothing yet rather than flash a red checklist.
  if (st.claude === undefined || st.gh === undefined) return null
  if (claudeOk && ghOk && !settings.welcome) return null
  const claudeMissing = /not found/i.test(st.claude?.error ?? '')
  return (
    <section className="card setup">
      <h3>{settings.welcome ? 'Set up Mothership' : 'Mothership needs a login'}</h3>
      <Row ok={claudeOk} label="Claude Code" value={claudeOk ? st.claude.email : claudeMissing ? 'Not installed. Chats run your own claude CLI.' : 'Not logged in'}
        action={claudeMissing
          ? <a href="https://docs.anthropic.com/en/docs/claude-code/setup" target="_blank" rel="noreferrer">Install ↗</a>
          : !claudeOk && st.claudeLogin?.state !== 'waiting' && <button onClick={() => post('/api/claude/login')}>Log in</button>} />
      {!claudeMissing && <ClaudeLogin login={st.claudeLogin} />}
      <Row ok={ghOk} label="GitHub" value={ghOk ? st.gh.account : 'Not logged in. PR status and checks come from the gh CLI.'}
        action={!ghOk && <button onClick={() => onTerminal('gh auth login', 'gh login')}>Log in</button>} />
      {settings.welcome && <>
        <Row ok label="Your name" value={`Agents work for ${st.setup?.owner ?? 'you'} and sign GitHub comments "${st.setup?.owner ?? 'you'}'s agent".`}
          action={<form onSubmit={e => { e.preventDefault(); if (name.trim()) { save({ owner: { name: name.trim() } }); setName('') } }}>
            <input placeholder="change…" value={name} onChange={e => setName(e.target.value)} size={10} />
          </form>} />
        <Row ok={!!st.setup?.cwdExists && !st.setup?.cwdIsHome} optional={!!st.setup?.cwdIsHome} label="Your code" value={!st.setup?.cwdExists ? `${settings.chat.cwd} doesn't exist. Where do your repos live?` : st.setup?.cwdIsHome ? 'New chats start in your home folder. Where do your repos live?' : `New chats start in ${settings.chat.cwd}`}
          action={<form onSubmit={e => { e.preventDefault(); if (cwd.trim()) { save({ chat: { ...settings.chat, cwd: cwd.trim() } }); setCwd('') } }}>
            <input placeholder="/Users/you/code" value={cwd} onChange={e => setCwd(e.target.value)} size={16} />
          </form>} />
        <Row ok={!!st.setup?.chrome} optional label="Chrome" value={st.setup?.chrome ? 'Agents get their own Chrome window to browse in' : 'Not found. Agents can still use the web through Claude Code.'} />
        <Row ok={!!st.posthog?.ok} optional label="PostHog" value={st.posthog?.ok ? st.posthog.user?.email : 'Optional: a personal API key adds PostHog tasks, skills and scouts (Settings → Connections)'} />
        <label className="line setup-autonomy">
          <input type="checkbox" checked={settings.autonomy?.enabled !== false} onChange={e => save({ autonomy: { enabled: e.target.checked } })} />
          <span><b>Let agents act on their own</b> <span className="muted small">PR shepherds answer reviews and red CI on PRs your agents open, autopilot suggests automations, and quiet chats save what they learned. These run Claude in the background, which uses your subscription. You can change this any time in Settings.</span></span>
        </label>
        <div className="row-flex setup-done">
          <span className="muted small grow">{claudeOk && ghOk ? 'Ready.' : 'Claude and GitHub are needed for chats and PRs.'}</span>
          <button className="primary" onClick={() => save({ welcome: false })}>{claudeOk && ghOk ? 'Done' : 'Hide for now'}</button>
        </div>
      </>}
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
