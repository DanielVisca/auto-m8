import { useEffect, useState } from 'react'
import { ago, api, post, shell, useLive } from './api'
import { Brand, brandFor } from './Brand'
import { ProfilesCard } from './Profile'
import { ClaudeBillingCard, SubscriptionsCard } from './ClaudeAccounts'
import { PrSpendCard, SpendCard } from './Spend'
import { useBrowser } from './BrowserView'
import { Kits } from './Kits'

// The agent browser (server/browser.ts): a dedicated Chrome profile perch drives, one window per chat.
const POLICIES = [['trusted', 'trusted: no confirmations'], ['allow', 'allow: confirm irreversible actions'], ['read', 'read only'], ['deny', 'deny']] as const
function AgentBrowser({ settings, save }: { settings: any; save: (p: any) => any }) {
  const B = settings.browser ?? {}
  const { data: st } = useBrowser()
  const [starting, setStarting] = useState(false)
  const [started, setStarted] = useState(false)
  const [host, setHost] = useState('')
  const [policy, setPolicy] = useState('trusted')
  const sites: Record<string, string> = B.sites ?? {}
  const set = (patch: any) => save({ browser: { ...B, ...patch } })
  const setSites = (next: Record<string, string>) => set({ sites: next })
  const add = () => {
    const h = host.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()
    if (!h) return
    setSites({ ...sites, [h]: policy }); setHost('')
  }
  return (
    <section className="card">
      <div className="card-head"><h3 className="grow">Agent browser</h3>
        <span className="muted small">{st?.connected ? `Agent Chrome running · ${st.sessions.length} window${st.sessions.length === 1 ? '' : 's'}` : 'Agent Chrome not running'}</span></div>
      <div className="muted small">Chats drive their own window in a separate Chrome profile, signed in as you. Watch, take over, and approve risky clicks from the chat.</div>
      <label className="field"><input type="checkbox" checked={B.enabled !== false} onChange={e => set({ enabled: e.target.checked })} /> Let chats use the agent browser</label>
      <div className="field">
        <button disabled={starting} onClick={async () => { setStarting(true); try { await post('/api/browser/start'); setStarted(true) } finally { setStarting(false) } }}>{starting ? 'Opening…' : 'Open Agent Chrome to sign in'}</button>
        {started && <span className="small">Sign in there to Google, GitHub, Slack and anything else agents should use. Logins stay in that profile only.</span>}
      </div>
      <label className="field"><input type="checkbox" checked={B.confirmIrreversible !== false} onChange={e => set({ confirmIrreversible: e.target.checked })} /> Ask me before irreversible actions <span className="muted small">send, pay, delete, merge, post…</span></label>
      <label className="field">Sites not listed below
        <select value={B.defaultPolicy ?? 'allow'} onChange={e => set({ defaultPolicy: e.target.value })}>{POLICIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      </label>
      {Object.entries(sites).sort(([a], [b]) => a.localeCompare(b)).map(([h, p]) => (
        <div key={h} className="field">
          <code className="grow">{h}</code>
          <select value={p} onChange={e => setSites({ ...sites, [h]: e.target.value })}>{POLICIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <button className="icon" title="Remove" onClick={() => { const n = { ...sites }; delete n[h]; setSites(n) }}>×</button>
        </div>
      ))}
      <div className="field">
        <input className="wide" placeholder="site, e.g. mail.google.com" value={host} onChange={e => setHost(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} />
        <select value={policy} onChange={e => setPolicy(e.target.value)}>{POLICIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <button onClick={add} disabled={!host.trim()}>Add site</button>
      </div>
      {(B.allowedActions ?? []).length > 0 && <div className="muted small">Always allowed (no confirmation):</div>}
      {(B.allowedActions ?? []).map((k: string) => (
        <div key={k} className="field">
          <code className="grow">{k.replace('|', ' → ')}</code>
          <button className="icon" title="Ask again next time" onClick={() => set({ allowedActions: (B.allowedActions ?? []).filter((x: string) => x !== k) })}>×</button>
        </div>
      ))}
      <label className="field"><input type="checkbox" checked={!!B.recordVisual} onChange={e => set({ recordVisual: e.target.checked })} /> Keep screenshots of each step <span className="muted small">to replay what an agent did; kept {B.recordingDays ?? 14} days</span></label>
    </section>
  )
}

// Settings is split into tabs, listed in a side panel. The tab rides in the hash (#settings/spend), so links can open one.
const TABS: [string, string, string][] = [['general', 'General', 'Your name, autonomy, decisions, look and window'], ['connections', 'Connections', 'Claude, GitHub, PostHog, MCP servers, phone'], ['chats', 'Chats & browser', 'Defaults for new chats and the agent browser'], ['accounts', 'Accounts', 'Claude profiles Mothership runs as'], ['models', 'Models', 'Routing and local models'], ['spend', 'Spend', 'AI spend, per PR, and subscription usage'], ['health', 'Health', 'Availability, search learning, missing capabilities']]
const tabFromHash = () => { const t = location.hash.split('/')[1]; return TABS.some(x => x[0] === t) ? t : null }

type Mcp = { name: string; target: string; status: string; kind: string }

export function Settings({ settings, onTerminal }: { settings: any; onTerminal: (cmd: string, title: string) => void }) {
  const { data: st, reload } = useLive<any>('/api/status', ['status', 'chats', 'terms'])
  const [refreshing, setRefreshing] = useState(false)
  const save = (patch: any) => api.send('PUT', '/api/settings', patch)
  const [tab, setTab] = useState(() => tabFromHash() ?? localStorage.getItem('perch.settingsTab') ?? 'general')
  const pick = (k: string) => { setTab(k); localStorage.setItem('perch.settingsTab', k); history.replaceState(null, '', `#settings/${k}`) }
  useEffect(() => { const f = () => { const t = tabFromHash(); if (t) setTab(t) }; addEventListener('hashchange', f); return () => removeEventListener('hashchange', f) }, [])
  if (!settings || !st) return <div className="pad muted">…</div>
  const servers: Mcp[] = st.mcp?.servers ?? []
  const groups = {
    connected: servers.filter(s => s.status === 'connected'),
    attention: servers.filter(s => s.status === 'failed'),
    auth: servers.filter(s => s.status === 'needs-auth' || s.status === 'not-configured'),
  }

  return (
    <div className="settings-layout">
      <nav className="settings-nav">
        <h2>Settings</h2>
        {TABS.map(([k, label, desc]) => <button key={k} className={tab === k ? 'on' : ''} title={desc} onClick={() => pick(k)}>{label}</button>)}
      </nav>
      <div className="page settings-page">
        <h2>{TABS.find(t => t[0] === tab)?.[1]}</h2>
      {tab === 'general' && <>
      <section className="card">
        <h3>You and your agents</h3>
        <div className="line">
          <span className="line-label">Your name</span>
          <span className="grow muted small">Agents work for {st.setup?.owner ?? 'you'} and sign GitHub comments with it. Blank uses the first name in git config.</span>
          <input defaultValue={settings.owner?.name ?? ''} placeholder={st.setup?.owner ?? ''} size={12}
            onBlur={e => { if (e.target.value.trim() !== (settings.owner?.name ?? '')) save({ owner: { name: e.target.value.trim() } }) }} />
        </div>
        <label className="line">
          <input type="checkbox" checked={settings.autonomy?.enabled !== false} onChange={e => save({ autonomy: { enabled: e.target.checked } })} />
          <span className="grow">Let agents act on their own <span className="muted small">PR shepherds, autopilot, evolve, closing passes on quiet chats. They run Claude in the background on your subscription.</span></span>
        </label>
      </section>
      <Kits />
      <section className="card">
        <h3>Organising</h3>
        <label className="field">Archive done conversations after <input type="number" min={0} style={{ width: 60 }} defaultValue={settings.organize.archiveDoneAfterDays} onBlur={e => save({ organize: { archiveDoneAfterDays: Number(e.target.value) } })} /> days <span className="muted small">0 = never</span></label>
        <label className="field"><input type="checkbox" checked={!!settings.decisions?.askMe} onChange={e => save({ decisions: { ...(settings.decisions ?? { autoAfterHours: 4, autoFixesPerDay: 3 }), askMe: e.target.checked } })} /> Ask me about big decisions <span className="muted small">Off: agents decide and Mothership takes their recommendation at once.</span></label>
        {settings.decisions?.askMe && <label className="field">If you don't answer a big decision, Mothership takes its recommendation after <input type="number" min={0} step={0.5} style={{ width: 60 }} defaultValue={settings.decisions?.autoAfterHours ?? 4} onBlur={e => save({ decisions: { ...settings.decisions, autoAfterHours: Number(e.target.value) } })} /> hours <span className="muted small">0 = always wait for you. Small decisions Mothership makes itself and logs under ⚑.</span></label>}
        <label className="field"><input type="checkbox" checked={settings.needs?.enabled !== false} onChange={e => save({ needs: { enabled: e.target.checked } })} /> Agents recheck Needs me and move safe work forward</label>
        <label className="field"><input type="checkbox" checked={settings.ai.dailyBrief} onChange={e => save({ ai: { dailyBrief: e.target.checked } })} /> Write a brief every morning</label>
        <label className="field">Model for briefs, Ask and skill search <input defaultValue={settings.ai.model} onBlur={e => save({ ai: { model: e.target.value } })} /> <span className="muted small">sonnet is quick and cheap; opus is more thorough</span></label>
        <Rules />
      </section>
      <section className="card">
        <h3>Appearance</h3>
        <div className="field">Theme
          <div className="seg">{(['system', 'light', 'dark'] as const).map(t => <button key={t} className={settings.ui.theme === t ? 'on' : ''} onClick={() => save({ ui: { theme: t } })}>{t}</button>)}</div>
        </div>
      </section>
      <section className="card">
        <h3>Window</h3>
        {shell.isElectron ? (
          <>
            <label className="field"><input type="checkbox" checked={settings.window.alwaysOnTop} onChange={e => { save({ window: { alwaysOnTop: e.target.checked } }); shell.pin?.(e.target.checked) }} /> Stay above other windows</label>
            <label className="field"><input type="checkbox" checked={settings.window.autoMini !== false} onChange={e => save({ window: { autoMini: e.target.checked } })} /> Picture in picture when you click away <span className="muted small">shrinks to a small window that stays visible, and comes back when you return</span></label>
            <label className="field"><input type="checkbox" checked={settings.window.autoTuck !== false} onChange={e => save({ window: { autoTuck: e.target.checked } })} /> Tuck into the edge when covered <span className="muted small">if other windows hide Mothership completely, it slides into a tab on the side of the screen that stays on top; click it to bring Mothership back</span></label>
            <label className="field">Show / hide shortcut <input value={settings.window.hotkey} onChange={e => save({ window: { hotkey: e.target.value } })} /> <span className="muted small">applies on restart</span></label>
            <label className="field">Collapse / expand shortcut <input value={settings.window.collapseHotkey ?? 'Control+Alt+M'} onChange={e => save({ window: { collapseHotkey: e.target.value } })} /> <span className="muted small">works from any app; applies on restart</span></label>
            <div className="field">Size
              {['bar', 'compact', 'side', 'full'].map(p => <button key={p} onClick={() => shell.preset?.(p)}>{p}</button>)}
            </div>
          </>
        ) : (
          <div className="muted small">You're in a browser tab. Run <code>npm run app</code> for the floating window.</div>
        )}
        <div className="field">Browser <a href={st.server.url} target="_blank" rel="noreferrer">{st.server.url}</a> <span className="muted small">the same app, in any browser</span></div>
      </section>
      </>}
      {tab === 'connections' && <>
      <section className="card">
        <h3>Connections</h3>
        <Line ok={st.claude?.loggedIn} label="Claude" value={st.claude?.loggedIn ? `${st.claude.email} · ${st.claude.subscriptionType ?? ''} · ${st.claudeVersion ?? ''}` : st.claude?.error ?? 'checking…'}
          action={!st.claude?.loggedIn && st.claudeLogin?.state !== 'waiting' && <button onClick={() => post('/api/claude/login')}>Log in</button>}
          hint={st.claude?.loginExpiresAt ? `login renews by ${new Date(st.claude.loginExpiresAt).toLocaleDateString()}` : ''} />
        <ClaudeLogin login={st.claudeLogin} />
        <Line ok={st.gh?.ok} label="GitHub" value={st.gh?.ok ? st.gh.account : st.gh?.error ?? 'checking…'} hint="PR status comes from the gh CLI"
          action={!st.gh?.ok && <button onClick={() => onTerminal('gh auth login', 'gh login')}>Log in</button>} />
        <PosthogKey status={st.posthog} settings={settings} save={save} />
        <Line ok={st.appleNotes?.access === 'granted'} label="Apple Notes"
          value={st.appleNotes?.access === 'granted' ? `${st.appleNotes.count} notes, searchable` : st.appleNotes?.access === 'missing' ? 'Notes isn’t set up on this Mac' : 'Needs Full Disk Access to read your notes (read-only)'}
          action={st.appleNotes?.access === 'needs-access' && <button onClick={() => post('/api/applenotes/grant')} title="Opens Privacy → Full Disk Access. Add node (/opt/homebrew/Cellar/node/…/bin/node), then restart Mothership.">Grant access</button>} />
      </section>
      <section className="card">
        <div className="card-head">
          <h3>MCP servers</h3>
          <span className="muted small">{st.mcp ? `checked ${ago(st.mcp.checkedAt)} ago` : st.mcpChecking ? 'checking…' : ''}</span>
          <button disabled={refreshing || st.mcpChecking} onClick={async () => { setRefreshing(true); await post('/api/status/refresh'); setRefreshing(false); reload() }}>
            {refreshing || st.mcpChecking ? 'Checking… (~20s)' : 'Re-check'}
          </button>
        </div>
        <div className="muted small">Every chat here gets all of these, the same as Claude Code in your terminal. claude.ai connectors are managed on claude.ai; local and plugin servers authenticate through Claude Code's <code>/mcp</code>.</div>
        {groups.attention.length > 0 && <McpGroup title="Failing" items={groups.attention} onTerminal={onTerminal} />}
        <McpGroup title="Connected" items={groups.connected} onTerminal={onTerminal} />
        {groups.auth.length > 0 && (
          <details>
            <summary className="muted">{groups.auth.length} not connected</summary>
            <McpGroup title="" items={groups.auth} onTerminal={onTerminal} />
          </details>
        )}
      </section>
      {!shell.isElectron && location.hostname !== '127.0.0.1' && location.hostname !== 'localhost' ? null : <PhoneAccess />}
      <section className="card">
        <div className="card-head"><h3>Sources</h3><button onClick={() => post('/api/reindex')}>Reindex</button></div>
        {settings.sources.map((s: any) => (
          <Line key={s.id} ok={!st.index[s.id]?.error && st.index[s.id]?.files > 0} label={s.label}
            value={st.index[s.id] ? `${st.index[s.id].files} transcripts` : '—'} hint={s.dir.replace(/^\/Users\/[^/]+/, '~')} />
        ))}
        <Line ok={st.posthog?.ok} label="PostHog tasks" value={st.posthog?.ok ? `${st.posthog.tasks} tasks (Slack, desktop, scouts, ReviewHog)` : st.posthog?.error ?? '—'}
          hint={st.posthog?.lastSync ? `synced ${ago(st.posthog.lastSync)} ago` : ''} />
        <div className="muted small">Claude Code deletes transcripts after <code>cleanupPeriodDays</code> (30 by default). Raise it in <code>~/.claude/settings.json</code> so old conversations stay searchable here.</div>
      </section>
      </>}
      {tab === 'chats' && <>
      <section className="card">
        <h3>Chats</h3>
        <label className="field">Default folder <input className="wide" defaultValue={settings.chat.cwd} onBlur={e => save({ chat: { cwd: e.target.value } })} /></label>
        <label className="field">Permission mode
          <select value={settings.chat.permissionMode} onChange={e => save({ chat: { permissionMode: e.target.value } })}>
            {['auto', 'acceptEdits', 'plan', 'manual', 'dontAsk', 'bypassPermissions'].map(m => <option key={m}>{m}</option>)}
          </select>
          <span className="muted small">auto is what you use in the terminal; manual denies anything that would prompt</span>
        </label>
        <label className="field">Model <input placeholder="default" defaultValue={settings.chat.model} onBlur={e => save({ chat: { model: e.target.value } })} /></label>
        <label className="field"><input type="checkbox" checked={settings.chat.chrome} onChange={e => save({ chat: { chrome: e.target.checked } })} /> Claude in Chrome (lets chats drive your browser)</label>
        <label className="field">Stop idle chat processes after <input type="number" min={1} style={{ width: 60 }} defaultValue={settings.chat.idleMinutes} onBlur={e => save({ chat: { idleMinutes: Number(e.target.value) } })} /> min</label>
        <div className="muted small">Running now: {st.chats.filter((c: any) => c.live).length} chat processes, {st.terms} terminals.</div>
      </section>
      <AgentBrowser settings={settings} save={save} />
      </>}
      {tab === 'accounts' && <>
      <SubscriptionsCard />
      <ProfilesCard onTerminal={onTerminal} />
      <ClaudeBillingCard />
      </>}
      {tab === 'models' && <>
      <SubscriptionsCard />
      <ClaudeBillingCard />
      <Routing />
      <LocalModels settings={settings} save={save} />
      </>}
      {tab === 'spend' && <>
      <SpendCard />
      <PrSpendCard />
      <UsageCard />
      </>}
      {tab === 'health' && <>
      <Health />
      <SearchLearning />
      <Wishes />
      </>}
      </div>
    </div>
  )
}

// Phone access: a listener on the wifi address, and devices you pair by scanning a QR code.
function PhoneAccess() {
  const { data, reload } = useLive<{ enabled: boolean; hosts: string[]; devices: { id: string; name: string; created_at: number; last_seen: number; last_ip: string }[]; listening: string[] }>('/api/remote', ['settings', 'status'])
  const [pair, setPair] = useState<{ url: string; qr: string } | null>(null)
  const { data: mob, reload: reloadMob } = useLive<any>('/api/mobile', ['settings', 'status'])
  const [tsBusy, setTsBusy] = useState(false)
  if (!data) return null
  const ts = mob?.tailscale
  const anywhere = !!mob?.settings?.tailscale
  const setAnywhere = async (on: boolean) => { setTsBusy(true); try { await api.send('PUT', '/api/mobile/tailscale', { on }); setPair(null) } finally { setTsBusy(false); reloadMob(); reload() } }
  const setMobile = async (patch: any) => { await api.send('PUT', '/api/settings', { mobile: { ...mob?.settings, ...patch } }); reloadMob() }
  const toggle = async (on: boolean) => { await api.send('PUT', '/api/settings', { remote: { enabled: on } }); setPair(null); setTimeout(reload, 300) }
  return (
    <section className="card">
      <div className="card-head">
        <h3>Phone access</h3>
        <label className="toggle"><input type="checkbox" checked={anywhere} disabled={tsBusy} onChange={e => setAnywhere(e.target.checked)} /> anywhere (Tailscale)</label>
        <label className="toggle"><input type="checkbox" checked={data.enabled} onChange={e => toggle(e.target.checked)} /> on this wifi</label>
      </div>
      <div className="muted small">On a phone, Mothership opens in Simple mode: what needs you, what's running, and one box to continue or start work. The same conversations as here, so you can step away and pick up on either. Advanced is the full app.</div>
      {anywhere && <div className="small">{ts?.url ? <>Reachable on your tailnet at <code>{ts.url}</code> (https, any network). The phone needs the Tailscale app, signed in.</> : <span className="bad">{ts?.error ?? 'tailscale serve is not set up yet.'}</span>}</div>}
      {mob && <div className="row-flex small">
        <label className="toggle"><input type="checkbox" checked={mob.settings?.push !== false} onChange={e => setMobile({ push: e.target.checked })} /> Notify my phone when something needs me and I'm away from the Mac</label>
        {mob.push.devices.length > 0 && <button onClick={() => post('/api/push/test')}>Send a test</button>}
        <span className="muted">{mob.push.devices.length ? `${mob.push.devices.length} phone${mob.push.devices.length > 1 ? 's' : ''} subscribed` : 'No phone subscribed yet: tap the bell in Simple mode (needs the Tailscale https address).'}</span>
      </div>}
      {mob && <div className="row-flex small">
        <label className="toggle"><input type="checkbox" checked={mob.settings?.stayAwake !== false} onChange={e => setMobile({ stayAwake: e.target.checked })} /> Keep the Mac awake while agents are running</label>
        <span className="muted">{mob.awake ? 'awake now' : 'not holding'} · on battery a closed lid still sleeps</span>
      </div>}
      <div className="muted small">Lets a paired phone on the same network use Mothership: browse, search, chat, terminals. Nothing on the network gets in without pairing. Traffic is plain HTTP, so only turn this on for networks you trust (home, not a café). For anywhere, Tailscale works too: pair over its address the same way.</div>
      {(data.enabled || anywhere) && (
        <>
          {data.enabled && <div className="small">Listening on {data.listening.length ? data.listening.map(ip => <code key={ip}>{ip}</code>) : <span className="bad">no network address yet</span>}. macOS may ask once whether node can accept incoming connections: allow it.</div>}
          <div className="row-flex">
            <button className="primary" onClick={async () => setPair(await post('/api/remote/pair'))}>Pair a phone</button>
            {pair && <span className="muted small">Scan with the phone's camera within 10 minutes. The code works once.</span>}
          </div>
          {pair && (
            <div className="pair">
              <div className="qr" dangerouslySetInnerHTML={{ __html: pair.qr }} />
              <code className="small">{pair.url}</code>
            </div>
          )}
          {data.devices.length > 0 && <div className="section-head">Paired devices</div>}
          {data.devices.map(d => (
            <div key={d.id} className="line">
              <span className={`dot ${Date.now() - d.last_seen < 300_000 ? 'ok' : 'pending'}`} />
              <span className="line-label">{d.name}</span>
              <span className="grow muted small">paired {ago(d.created_at)} ago · last seen {ago(d.last_seen)} ago from {d.last_ip?.replace('::ffff:', '')}</span>
              <button className="bad" onClick={async () => { await api.send('DELETE', `/api/remote/devices/${d.id}`); reload() }}>Revoke</button>
            </div>
          ))}
          <div className="muted small">On the phone, use Share → Add to Home Screen to get Mothership as an app.</div>
        </>
      )}
    </section>
  )
}

// What agents said they were missing, and what the PostHog MCP registry would connect for it.
function Wishes() {
  const { data } = useLive<{ wishes: any[] }>('/api/mcp/wishes')
  if (!data?.wishes.length) return null
  return (
    <section className="card">
      <h3>Agents wished they had…</h3>
      <div className="muted small">When an agent couldn't answer confidently for lack of a data source, it logged what was missing. Recommendations come from the PostHog MCP registry, ranked by liveness and real usage. Over time this is the list of what to connect, or build.</div>
      {data.wishes.map((w, i) => (
        <div key={i} className="health-row">
          <span className="badge">{w.n}</span>
          <div className="grow">
            <div><b>{w.suggested || String(w.needs).split(' | ')[0]}</b> <span className="muted small">{w.convs} conversations · {ago(w.last)} ago</span></div>
            <div className="muted small clamp">{String(w.needs).split(' | ').slice(0, 3).join(' · ')}</div>
            {w.candidates?.length > 0 && <div className="small">Connect: {w.candidates.map((c: any) => <span key={c.name} className="chip" title={`${c.liveness ?? 'unprobed'} · score ${c.score ?? '?'}`}><Brand id={brandFor(c.name ?? '')} size={12} /> {c.name}</span>)}</div>}
          </div>
        </div>
      ))}
    </section>
  )
}

// Search learning: how each mode performs, and the playbook of tactics with their scores.
function SearchLearning() {
  const { data, reload } = useLive<{ rules: any[]; stats: any[] }>('/api/search/playbook', ['conversations'])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  if (!data) return null
  return (
    <section className="card">
      <div className="card-head"><h3>Search learning</h3>
        <button disabled={busy} onClick={async () => { setBusy(true); await post('/api/search/learn'); setBusy(false); reload() }}>{busy ? 'Learning…' : 'Learn from recent searches'}</button></div>
      <div className="muted small">Every search uses this playbook. Each tactic is scored by how the searches that used it went (👍/👎, and whether you opened what it cited). Tactics earn “active” after 3 good runs; ones that don’t help are retired automatically.</div>
      {data.stats.length > 0 && <div className="stats">{data.stats.map(s => (
        <div key={s.mode} className="stat"><b>{s.n}</b><span>{s.mode} · {Math.round((s.ms ?? 0) / 1000)}s avg · ${(s.cost ?? 0).toFixed(2)} · {s.up ?? 0}👍 {s.down ?? 0}👎</span></div>
      ))}</div>}
      {data.rules.map(r => (
        <div key={r.id} className={`line ${r.status === 'retired' ? 'dim-line' : ''}`}>
          <span className={`chip ${r.status === 'active' ? 'ok' : ''}`}>{r.status}</span>
          <span className="grow small">{r.text}</span>
          <span className="muted small">{r.uses} uses · {r.wins}👍 {r.losses}👎</span>
          <button className="link small" onClick={async () => { await post(`/api/search/playbook/${r.id}`, { status: r.status === 'retired' ? 'trial' : 'retired' }); reload() }}>{r.status === 'retired' ? 'restore' : 'retire'}</button>
        </div>
      ))}
      <div className="row-flex">
        <input className="grow" value={text} placeholder="Add a tactic, e.g. “For infra questions, read PostHog/charts on origin/main first”" onChange={e => setText(e.target.value)} />
        <button disabled={!text.trim()} onClick={async () => { await post('/api/search/playbook', { text }); setText(''); reload() }}>Add</button>
      </div>
    </section>
  )
}

// Availability: each time the app couldn't reach perch, and why (server/uptime.ts).
const dur = (ms: number) => ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
function Availability() {
  const { data } = useLive<any>('/api/availability?hours=24', ['errors' as any], undefined, 60_000)
  if (!data) return null
  const causes = Object.entries(data.byCause ?? {}).sort((a: any, b: any) => b[1] - a[1])
  return (
    <div className="availability">
      <div><b>Availability, last 24h:</b> <span className={data.outages ? 'bad' : 'ok-text'}>{data.outages ? `${data.outages} gap${data.outages > 1 ? 's' : ''} you could have seen, ${dur(data.downMs)} in total` : 'no gaps'}</span>
        <span className="muted small"> · {data.restarts} restart{data.restarts === 1 ? '' : 's'}{data.bootMs != null ? `, ${dur(data.bootMs)} to start` : ''} · {data.stalls} freeze{data.stalls === 1 ? '' : 's'} over 2s</span></div>
      {!!causes.length && <div className="muted small">Restarts by cause: {causes.map(([k, n]) => `${k} ×${n}`).join(' · ')}</div>}
      {!!data.recent?.length && <details><summary className="muted small">recent</summary>
        {data.recent.map((r: any, i: number) => <div key={i} className="small"><span className="muted">{new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span> {r.kind === 'outage' ? `unreachable ${dur(r.ms)}: ${r.cause}` : `restarted (ready in ${dur(r.ms)})`}{r.detail || (r.kind === 'boot' && r.cause) ? <span className="muted"> · {r.kind === 'boot' ? r.cause : r.detail}</span> : null}</div>)}
      </details>}
    </div>
  )
}

// Health: what broke recently, in plain words, and what perch did about it.
function Health() {
  const { data, reload } = useLive<{ errors: any[] }>('/api/errors', ['errors' as any])
  const list = data?.errors ?? []
  const open = list.filter(e => e.status !== 'resolved')
  return (
    <section className="card">
      <div className="card-head"><h3>Health</h3><span className={`small ${open.length ? 'bad' : 'ok-text'}`}>{open.length ? `${open.length} open` : 'all good'}</span></div>
      <Availability />
      {!list.length && <div className="muted small">Nothing has gone wrong this week. When something does, it shows here in plain words with what Mothership did about it.</div>}
      {list.slice(0, 12).map(e => (
        <div key={e.key} className="health-row">
          <span className={`dot ${e.status === 'resolved' ? 'ok' : e.status === 'retrying' ? 'pending' : 'bad'}`} />
          <div className="grow">
            <div><b>{e.message}</b> <span className="muted small">{e.count > 1 ? `${e.count}× · ` : ''}{ago(e.last_at)} ago · {e.source}</span></div>
            <div className="muted small">{e.status === 'resolved' ? 'Resolved: it worked again afterwards.' : e.action}</div>
            <details><summary className="muted small">details</summary><pre className="small">{e.detail}</pre></details>
          </div>
          {e.status !== 'resolved' && <button className="link small" onClick={async () => { await post(`/api/errors/${encodeURIComponent(e.key)}/resolve`); reload() }}>dismiss</button>}
        </div>
      ))}
    </section>
  )
}

type Rule = { id: string; name: string; query: string; action: string; value: string | null; enabled: number; last_matched: number | null }
const EXAMPLES = [
  ['Label the intent clustering work', 'intent clustering', 'label', 'intent-clustering'],
  ['Archive old PostHog Code chats', 'in:code older:14d', 'archive', ''],
  ['Snooze idle review requests', 'review state:idle', 'snooze', '7'],
]

// Rules are saved searches that act on what they match, every minute. They never undo a state you set by hand.
function Rules() {
  const { data, reload } = useLive<{ rules: Rule[] }>('/api/rules', ['conversations'])
  const [draft, setDraft] = useState<Partial<Rule> | null>(null)
  const [preview, setPreview] = useState<{ n: number; sample: string[] } | null>(null)
  const check = async (query: string) => setPreview(query.trim() ? await post('/api/rules/preview', { query }) : null)
  return (
    <div className="rules">
      <div className="card-head"><h4>Rules</h4><button onClick={() => { setDraft({ name: '', query: '', action: 'label', value: '', enabled: 1 }); setPreview(null) }}>+ Rule</button></div>
      <div className="muted small">A rule is a search that acts on whatever it matches: add a label, archive, or snooze. It runs every minute and never overrides a state you set by hand.</div>
      {(data?.rules ?? []).map(r => (
        <div key={r.id} className="line">
          <input type="checkbox" checked={!!r.enabled} onChange={async e => { await post('/api/rules', { ...r, enabled: e.target.checked ? 1 : 0 }); reload() }} />
          <span className="line-label ellipsis">{r.name}</span>
          <code className="grow ellipsis">{r.query}</code>
          <span className="muted small">{r.action}{r.value ? ` ${r.action === 'snooze' ? r.value + 'd' : '#' + r.value}` : ''}</span>
          <button className="link small" onClick={() => { setDraft(r); check(r.query) }}>edit</button>
        </div>
      ))}
      {!data?.rules.length && !draft && (
        <div className="muted small">Try: {EXAMPLES.map(([n, q, a, v]) => <button key={n} className="link small" onClick={() => { setDraft({ name: n, query: q, action: a, value: v, enabled: 1 }); check(q) }}>{n}</button>)}</div>
      )}
      {draft && (
        <div className="card editor">
          <label className="field">Name <input className="wide" value={draft.name ?? ''} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
          <label className="field">When a conversation matches <input className="wide" value={draft.query ?? ''} placeholder='e.g. "intent clustering" repo:posthog' onChange={e => { setDraft({ ...draft, query: e.target.value }); check(e.target.value) }} /></label>
          <div className="field">then
            <select value={draft.action} onChange={e => setDraft({ ...draft, action: e.target.value })}>
              <option value="label">add label</option><option value="archive">archive it</option><option value="snooze">snooze it for</option>
            </select>
            {draft.action === 'label' && <input value={draft.value ?? ''} placeholder="label" onChange={e => setDraft({ ...draft, value: e.target.value })} />}
            {draft.action === 'snooze' && <><input type="number" style={{ width: 60 }} value={draft.value ?? '7'} onChange={e => setDraft({ ...draft, value: e.target.value })} /> days</>}
          </div>
          {preview && <div className="muted small">Matches {preview.n >= 50 ? '50+' : preview.n} now{preview.sample.length ? `: ${preview.sample.slice(0, 4).map(t => `“${String(t).slice(0, 40)}”`).join(', ')}` : ''}</div>}
          <div className="row-flex">
            <button className="primary" disabled={!draft.query} onClick={async () => { await post('/api/rules', draft); setDraft(null); reload() }}>Save</button>
            <button onClick={() => setDraft(null)}>Cancel</button>
            <span className="grow" />
            {draft.id && <button className="bad" onClick={async () => { await api.send('DELETE', `/api/rules/${draft.id}`); setDraft(null); reload() }}>Delete</button>}
          </div>
        </div>
      )}
    </div>
  )
}

// Sign-in runs inside perch (claude auth login in the background): the browser opens, and it
// finishes by itself when you approve. If the page shows a code instead, paste it here.
export function ClaudeLogin({ login }: { login?: { state: string; url?: string; error?: string } }) {
  const [code, setCode] = useState('')
  if (!login || login.state === 'idle' || login.state === 'done') return null
  if (login.state === 'failed') return <div className="muted small bad">Claude sign-in didn’t finish: {login.error} <button className="small" onClick={() => post('/api/claude/login')}>Try again</button></div>
  return (
    <div className="small row-flex" style={{ flexWrap: 'wrap', gap: 6 }}>
      <span>Finish signing in to Claude in your browser.</span>
      {login.url && <a href={login.url} target="_blank" rel="noreferrer">Open the sign-in page</a>}
      <span className="muted">Got a code instead?</span>
      <input value={code} onChange={e => setCode(e.target.value)} placeholder="paste code" style={{ width: 160 }}
        onKeyDown={e => { if (e.key === 'Enter' && code.trim()) { post('/api/claude/login/code', { code }); setCode('') } }} />
      <button className="small" disabled={!code.trim()} onClick={() => { post('/api/claude/login/code', { code }); setCode('') }}>Submit</button>
      <button className="small" onClick={() => api.send('DELETE', '/api/claude/login')}>Cancel</button>
    </div>
  )
}

function Line({ ok, label, value, hint, action }: { ok?: boolean; label: string; value?: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="line">
      <span className={`dot ${ok ? 'ok' : ok === false ? 'bad' : 'pending'}`} />
      <span className="line-label">{label}</span>
      <span className="grow ellipsis" title={value}>{value}</span>
      {hint && <span className="muted small ellipsis">{hint}</span>}
      {action}
    </div>
  )
}

function McpGroup({ title, items, onTerminal }: { title: string; items: Mcp[]; onTerminal: (cmd: string, title: string) => void }) {
  return (
    <div className="mcp-group">
      {title && <div className="section-head">{title} · {items.length}</div>}
      {items.map(s => (
        <div key={s.name} className="line">
          <span className={`dot ${s.status === 'connected' ? 'ok' : s.status === 'failed' ? 'bad' : 'pending'}`} />
          <span className="mcp-brand"><Brand id={brandFor(s.name) ?? s.name.replace(/^claude\.ai |^plugin:[^:]+:/, '')} size={15} /></span>
          <span className="line-label ellipsis" title={s.name}>{s.name.replace(/^claude\.ai /, '')}</span>
          <span className="muted small">{s.kind}</span>
          <span className="grow" />
          {s.status !== 'connected' && (s.kind === 'claude.ai'
            ? <a href="https://claude.ai/settings/connectors" target="_blank" rel="noreferrer">Connect on claude.ai ↗</a>
            : <button onClick={() => onTerminal('claude /mcp', 'claude /mcp')} title="Opens Claude Code's /mcp, where you pick the server and log in">Authenticate</button>)}
        </div>
      ))}
    </div>
  )
}

function PosthogKey({ status, settings, save }: { status: any; settings: any; save: (p: any) => any }) {
  const [key, setKey] = useState('')
  const [msg, setMsg] = useState('')
  return (
    <div className="line wrap">
      <span className={`dot ${status?.ok ? 'ok' : status?.hasKey ? 'bad' : 'pending'}`} />
      <span className="line-label">PostHog</span>
      <span className="grow ellipsis">{status?.ok ? status.user?.email : status?.hasKey ? status.error : 'Personal API key needed for tasks, skills and scouts'}</span>
      <input type="password" placeholder={status?.hasKey ? 'replace key…' : 'phx_…'} value={key} onChange={e => setKey(e.target.value)} />
      <button disabled={!key} onClick={async () => { const r = await post('/api/posthog/key', { key }); setKey(''); setMsg(r.ok ? 'Saved to keychain' : r.error) }}>Save</button>
      {status?.hasKey && <button className="link small" onClick={() => post('/api/posthog/key', { key: '' })}>remove</button>}
      {msg && <span className="muted small">{msg}</span>}
      <div className="row-flex small full">
        <select value={settings.posthog.host} onChange={e => save({ posthog: { ...settings.posthog, host: e.target.value, projectId: 0 } })}>
          {[...new Set(["https://us.posthog.com", "https://eu.posthog.com", settings.posthog.host])].map(h => <option key={h} value={h}>{h.replace("https://", "")}</option>)}
        </select>
        <span className="muted">project</span>
        <input size={6} defaultValue={settings.posthog.projectId || ""} placeholder="from key" onBlur={e => { const n = Number(e.target.value) || 0; if (n !== settings.posthog.projectId) save({ posthog: { ...settings.posthog, projectId: n } }) }} />
      </div>
      <div className="muted small full">Create one at <a href={`${settings.posthog.host}/settings/user-api-keys`} target="_blank" rel="noreferrer">PostHog → Personal API keys</a> with read access to tasks, users and LLM skills (and scouts to run them). Stored in the macOS keychain, never in a file.</div>
    </div>
  )
}

// Ollama: which local models you have, whether they fit this Mac, and what runs on them.
const gb = (n: number) => `${(n / 1e9).toFixed(n < 10e9 ? 1 : 0)} GB`
function LocalModels({ settings, save }: { settings: any; save: (p: any) => any }) {
  const { data, reload } = useLive<any>('/api/local', ['settings'])
  const pulling = (data?.pulling ?? []).length > 0
  useEffect(() => { if (!pulling) return; const t = setInterval(reload, 2000); return () => clearInterval(t) }, [pulling]) // eslint-disable-line
  if (!data) return null
  const L = settings.local
  return (
    <section className="card">
      <h3>Models</h3>
      <div className="muted small">Claude (your plan) and Codex (your ChatGPT plan) are peers: Auto uses either, each covers for the other when it hits a limit or is signed out, and they share the conversation, Mothership tools, MCP servers, instructions, memory and skills. Either can hand a job to the other with <code>delegate</code> (engine: codex or claude).</div>
      <div className="small">Codex: {data.codex?.ok ? <span>signed in{data.codex.default ? ` · default ${data.codex.default}` : ''}{data.codex.models?.length ? ` · ${data.codex.models.length} models in the model menu` : ''}</span> : <span className="bad">{data.codex?.why ?? 'unknown'}</span>}</div>
      <h3>Local models</h3>
      {!data.running ? (
        <div className="muted small">Ollama isn’t running. Start the Ollama app (it’s installed) and local models show up here.</div>
      ) : (
        <>
          <div className="muted small">Ollama {data.version} · {Math.round(data.ram / 2 ** 30)} GB of memory. A chat can run on a local model (the model menu next to send); nothing leaves this Mac and it doesn’t use your Claude plan.</div>
          {data.models.map((m: any) => (
            <label key={m.name} className="local-model">
              <input type="radio" name="local-model" checked={L.model === m.name} onChange={() => save({ local: { model: m.name } })} />
              <b>{m.name}</b> <span className="muted small">{gb(m.size)}{m.params ? ` · ${m.params}` : ''}</span>
              {!m.fits && <span className="bad small"> · too big for this Mac’s memory: it will be very slow, or crash</span>}
            </label>
          ))}
          <label className="field"><input type="checkbox" checked={L.background} disabled={!L.model} onChange={e => save({ local: { background: e.target.checked } })} />
            Run background jobs on {L.model || 'the local model'} <span className="muted small">(briefs, sorting, duplicate checks, summaries: free and offline; the search agent and chats stay on Claude)</span></label>
          {data.recommended.filter((r: any) => r.fits).length > 0 && (
            <div className="local-get">
              <div className="muted small">Models that fit this Mac well:</div>
              {data.recommended.filter((r: any) => r.fits).map((r: any) => {
                const p = data.pulling.find((x: any) => x.name === r.name)
                return (
                  <div key={r.name} className="row-flex small">
                    <b>{r.name}</b> <span className="muted">{gb(r.size)} · {r.why}</span>
                    <span className="grow" />
                    {p ? <span className={p.error ? 'bad' : 'muted'}>{p.error ?? (p.pct != null ? `${p.pct}%` : p.status)}</span>
                      : <button onClick={async () => { await post('/api/local/pull', { model: r.name }); reload() }} title={`Downloads ${gb(r.size)}`}>Get</button>}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </section>
  )
}

// How Auto picks models, and any usage caps it's working around right now.
function Routing() {
  const { data } = useLive<{ caps: { tier: string; until: number }[]; fallback: string | null }>('/api/routing', ['chats'])
  const name = (t: string) => ({ fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' } as any)[t] ?? t
  return (
    <section className="card">
      <h3>Model routing</h3>
      <div className="muted small">Chats default to <b>Auto</b>: Haiku for quick asks, Sonnet for everyday work, Opus for heavy thinking (design, debugging, audits, big changes, images). A correction steps up a model. When a model hits its usage cap, the chat continues on the next one down and comes back after the reset. Only what you already pay for: your Claude plan and local models. The model menu under the message box pins one per chat.</div>
      <div className="small" style={{ marginTop: 6 }}>
        {data?.caps.length ? data.caps.map(c => <div key={c.tier}>⏸ <b>{name(c.tier)}</b> is at its usage cap until {new Date(c.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>) : <span className="ok-text">No usage caps right now.</span>}
        <div className="muted">When every Claude model is capped: {data?.fallback ? <>continue on <b>{data.fallback}</b> on this Mac</> : 'nothing set (pick a local model below)'}.</div>
      </div>
    </section>
  )
}

// Usage across your chats in perch: by model, the costliest chats, and what model switches cost.
function UsageCard() {
  const [days, setDays] = useState(30)
  const { data: u } = useLive<any>(`/api/usage?days=${days}`, ['chats'])
  const money = (n: number) => n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`
  const name = (m: string) => { const c = m.match(/^claude-(opus|sonnet|haiku|fable)/)?.[1]; return c ? c[0].toUpperCase() + c.slice(1) : m.replace(/:latest$/, '') }
  return (
    <section className="card">
      <div className="row-flex"><h3 className="grow">Usage</h3>
        <select value={days} onChange={e => setDays(Number(e.target.value))}>{[1, 7, 30, 90].map(d => <option key={d} value={d}>{d === 1 ? 'today' : `${d} days`}</option>)}</select></div>
      {!u ? <div className="muted small">…</div> : !u.turns ? <div className="muted small">No measured turns yet in this window. Chats run in Mothership report their usage from now on.</div> : (
        <>
          <div className="stats">
            <div className="stat"><b>{money(u.cost)}</b><span>API-equivalent, {u.turns} turns</span></div>
            <div className="stat"><b>{u.switches.n}</b><span>costly model switches{u.switches.n ? `: ${money(u.switches.cost)}` : ''}</span></div>
          </div>
          <div className="usage-cols">
            <div><h4>By model</h4>{u.byModel.map((m: any) => <div key={m.model} className="usage-row small"><span className="grow">{name(m.model)}</span><span className="muted">{m.turns} turns</span><b>{money(m.cost)}</b></div>)}</div>
            <div><h4>Costliest chats</h4>{u.topChats.map((c: any) => <a key={c.id} className="usage-row small" href={`#chat/${encodeURIComponent(c.id)}`}><span className="grow ellipsis">{c.title}</span><span className="muted">{c.turns}</span><b>{money(c.cost)}</b></a>)}</div>
          </div>
          <div className="muted small">On a subscription none of this is billed: it’s what the same work would cost on the API, which is how your plan’s usage limits are measured. A model switch makes the new model load the whole conversation again; Auto avoids stepping down when the conversation is large.</div>
        </>
      )}
    </section>
  )
}
