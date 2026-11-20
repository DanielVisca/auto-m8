import { useState } from 'react'
import { ago, api, humanCron, post, titleOf, useLive, type Conversation } from './api'
import { DryRun } from './Autopilot'

type Routine = { id: string; name: string; prompt: string; cwd: string | null; cron: string | null; webhook_secret: string; conversation_id: string | null; mode: string; enabled: number; last_run_at: number | null; last_status: string | null }

const PRESETS = [['every hour', '0 * * * *'], ['weekdays 9:00', '0 9 * * 1-5'], ['every 15 min', '*/15 * * * *'], ['daily 18:00', '0 18 * * *']]

export function Automations({ draft, onOpen, settings }: { draft: Partial<Routine> | null; onOpen: (id: string) => void; settings: any }) {
  const { data, reload } = useLive<{ routines: Routine[]; webhookBase: string }>('/api/routines', ['conversations'])
  const [edit, setEdit] = useState<Partial<Routine> | null>(draft)
  return (
    <div className="page">
      <div className="row-flex"><h2 className="grow">Automations</h2><button className="primary" onClick={() => setEdit({ name: '', prompt: '', cwd: settings?.chat.cwd, cron: '0 9 * * 1-5', mode: 'fresh', enabled: 1 })}>New routine</button></div>
      <div className="muted small">A routine sends a prompt to Claude on a schedule or when its webhook is called. It runs on this machine with all your connectors, only while Mothership is running. For work that must run while the laptop sleeps, use a PostHog scout (Library → Scouts).</div>
      {edit && <Editor r={edit} onClose={() => { setEdit(null); reload() }} />}
      <Suggested onOpen={onOpen} />
      {(data?.routines ?? []).map(r => (
        <div key={r.id} className="card">
          <div className="row-flex">
            <span className={`dot ${r.enabled ? 'ok' : 'pending'}`} />
            <b className="grow">{r.name}</b>
            <span className="muted small">{r.cron ? humanCron(r.cron) : 'webhook only'}</span>
            <button onClick={async () => { const x = await post(`/api/routines/${r.id}/run`); reload(); if (x.conversationId) onOpen(x.conversationId) }}>Run now</button>
            <button onClick={() => setEdit(r)}>Edit</button>
          </div>
          <div className="muted small clamp">{r.prompt}</div>
          <div className="muted small">{r.mode === 'resume' ? 'continues one conversation' : 'new conversation each run'}{r.last_run_at ? ` · last run ${ago(r.last_run_at)} ago (${r.last_status})` : ' · never run'}
            {r.conversation_id && <> · <button className="link small" onClick={() => onOpen(r.conversation_id!)}>conversation</button></>}</div>
          <details><summary className="muted small">webhook</summary>
            <pre className="small">curl -X POST {data!.webhookBase}{r.id} -H 'X-Perch-Secret: {r.webhook_secret}' -H 'Content-Type: application/json' -d '{'{"any":"payload"}'}'</pre>
            <div className="muted small">The JSON body is appended to the prompt. Local only: to receive GitHub or PostHog webhooks, point a tunnel (cloudflared, ngrok) at it.</div>
          </details>
        </div>
      ))}
    </div>
  )
}

function Editor({ r, onClose }: { r: Partial<Routine>; onClose: () => void }) {
  const [v, setV] = useState<Partial<Routine>>(r)
  const { data: conv } = useLive<Conversation>(v.conversation_id ? `/api/conversations/${encodeURIComponent(v.conversation_id)}` : null)
  const set = (patch: Partial<Routine>) => setV({ ...v, ...patch })
  return (
    <div className="card editor">
      <label className="field">Name <input className="wide" value={v.name ?? ''} onChange={e => set({ name: e.target.value })} placeholder="Morning PR sweep" /></label>
      <label className="field col">Prompt <textarea rows={4} value={v.prompt ?? ''} onChange={e => set({ prompt: e.target.value })} placeholder="Check my open PRs, fix failing CI, and tell me which need me." /></label>
      <label className="field">Folder <input className="wide" value={v.cwd ?? ''} onChange={e => set({ cwd: e.target.value })} /></label>
      <label className="field">Schedule <input value={v.cron ?? ''} onChange={e => set({ cron: e.target.value })} placeholder="cron, or empty for webhook only" />
        {v.cron && <span className="muted small">{humanCron(v.cron) === v.cron ? 'Custom schedule' : `Runs ${humanCron(v.cron)}`}</span>}
        {PRESETS.map(([l, c]) => <button key={c} className="link small" onClick={() => set({ cron: c })}>{l}</button>)}</label>
      <label className="field">Each run
        <select value={v.mode} onChange={e => set({ mode: e.target.value })}>
          <option value="fresh">starts a new conversation</option>
          <option value="resume">continues {conv ? `“${titleOf(conv).slice(0, 40)}”` : 'one conversation'}</option>
        </select></label>
      <label className="field"><input type="checkbox" checked={!!v.enabled} onChange={e => set({ enabled: e.target.checked ? 1 : 0 })} /> Enabled</label>
      <div className="row-flex">
        <button className="primary" disabled={!v.prompt} onClick={async () => { await post('/api/routines', v); onClose() }}>Save</button>
        <button onClick={onClose}>Cancel</button>
        <span className="grow" />
        {v.id && <button className="bad" onClick={async () => { await api.send('DELETE', `/api/routines/${v.id}`); onClose() }}>Delete</button>}
      </div>
    </div>
  )
}

// What autopilot proposes and what it already set up for you (read-only ones it creates itself).
function Suggested({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, reload } = useLive<any>('/api/autopilot', ['autopilot' as any])
  const [dry, setDry] = useState<string | null>(null)
  if (!data) return null
  const sugg = (data.suggestions ?? []).filter((s: any) => s.kind === 'routine' || s.kind === 'rule')
  const auto = data.autoCreated ?? []
  return (
    <>
      {sugg.length > 0 && (
        <section className="card">
          <h3>Suggested for you</h3>
          <div className="muted small">From what you keep doing. Read-only ones are set up automatically; anything that writes asks first.</div>
          {sugg.map((s: any) => (
            <div key={s.id} className="sugg">
              <div className="row-flex"><b className="grow">{s.payload.ask || s.title}</b><span className={`chip ${s.payload.risk === 'low' ? 'ok' : ''}`} title={s.payload.blast}>{s.payload.risk === 'low' ? 'read-only' : 'writes'}</span></div>
              <div className="muted small">{s.why}</div>
              {s.payload.cron && <div className="muted small">Runs {humanCron(s.payload.cron)}{s.payload.blast ? ` · ${s.payload.blast}` : ''}</div>}
              {dry === s.id && <DryRun id={s.id} />}
              <div className="row-flex">
                <button className="primary" onClick={async () => { await post(`/api/autopilot/${s.id}/accept`); reload() }}>Set it up</button>
                {dry !== s.id && s.kind === 'routine' && <button onClick={() => setDry(s.id)}>Dry run</button>}
                <button className="link small" onClick={async () => { await post(`/api/autopilot/${s.id}/dismiss`); reload() }}>no thanks</button>
                {s.evidence?.[0] && <button className="link small" onClick={() => onOpen(s.evidence[0])}>evidence</button>}
              </div>
            </div>
          ))}
        </section>
      )}
      {auto.length > 0 && (
        <section className="card">
          <h3>Set up for you</h3>
          <div className="muted small">Read-only automations autopilot created on its own. They are watched like any other, and paused if they fail or do nothing.</div>
          {auto.map((s: any) => (
            <div key={s.id} className="line">
              <span className="dot ok" />
              <span className="grow ellipsis">{s.payload.name ?? s.title}</span>
              <span className="muted small">{humanCron(s.payload.cron)} · {ago(s.created_at)} ago</span>
              <button className="link small" onClick={async () => { await post(`/api/autopilot/${s.id}/undo`); reload() }}>undo</button>
            </div>
          ))}
        </section>
      )}
      {!sugg.length && !auto.length && (
        <div className="card muted small">Nothing to automate yet. Autopilot looks at what you repeat every few hours: read-only automations it sets up itself (with undo), and for anything that writes it asks you first, with a dry run.</div>
      )}
    </>
  )
}
