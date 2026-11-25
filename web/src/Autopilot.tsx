// Autopilot on the home page: automations it proposes (one click to turn on), and the ones it
// owns, with every run's outcome. Failing, stalled or idle automations get paused and flagged.
import { useEffect, useState } from 'react'
import { ago, humanCron, post, streamSSE, useLive } from './api'
import { Markdown } from './Chat'

type Overlap = { kind: string; id: string; title: string }
type Suggestion = { id: string; kind: 'routine' | 'rule' | 'attention' | 'consolidate'; title: string; why: string; evidence: string[]; payload: any }
type Run = { outcome: string; started_at: number; conversation_id: string; detail: string | null; cost: number | null }
type Automation = { id: string; name: string; cron: string | null; enabled: number; phase: string; paused_reason: string | null; runs: Run[]; week: { n: number; cost: number | null; bad: number }; watch_until: number | null }
type Overview = { status: { scanning: boolean; lastScan: number; error: string }; suggestions: Suggestion[]; automations: Automation[] }

const OUTCOME: Record<string, string> = { ok: 'ok', noop: 'pending', error: 'bad', stalled: 'bad', running: 's-running' }

export function Autopilot({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, reload } = useLive<Overview>('/api/autopilot', ['autopilot' as any])
  const [open, setOpen] = useState<string | null>(null)
  if (!data) return null
  const scan = async () => { await post('/api/autopilot/scan'); reload() }
  return (
    <section className="card autopilot">
      <div className="card-head">
        <h3>Autopilot</h3>
        <span className="muted small">{data.status.scanning ? 'looking at how you work…' : data.status.lastScan ? `looked ${ago(data.status.lastScan)} ago` : 'watches your usage every few hours'}</span>
        <button disabled={data.status.scanning} onClick={scan}>{data.status.scanning ? 'Looking…' : 'Look now'}</button>
      </div>
      {data.status.error && <div className="bad small">{data.status.error}</div>}
      {!data.suggestions.length && !data.automations.length && !data.status.scanning && (
        <div className="muted small">Autopilot reads what you repeat (prompts, Slack asks, skills, times of day) and proposes automations you can turn on in one click. It keeps watching each one afterwards, and pauses anything that fails, stalls or runs without doing anything.</div>
      )}
      {data.suggestions.map(s => {
        const overlaps: Overlap[] = s.payload?.overlaps ?? []
        const extend = s.payload?.verdict === 'extend'
        const accept = async () => { await post(`/api/autopilot/${s.id}/accept`); reload() }
        return (
        <div key={s.id} className="sugg">
          <div className="sugg-head">
            <span className={`chip ${s.kind === 'consolidate' ? 'ok' : ''}`}>{{ routine: 'automation', rule: 'organising rule', attention: 'heads up', consolidate: 'consolidate', ship: 'ship setup' }[s.kind]}</span>
            <b className="sugg-title">{s.title}</b>
          </div>
          <div className="muted small">{s.why}</div>
          {s.kind === 'consolidate' && s.payload?.verdict && (
            <div className={`small verdict-line v-${s.payload.verdict}`}>{s.payload.verdict === 'same' ? 'Same work' : s.payload.verdict === 'related' ? 'Related' : 'Different'} ({Math.round((s.payload.confidence ?? 0) * 100)}%): {s.payload.why}{s.payload.auto ? ` · ${s.payload.auto}` : ''}</div>
          )}
          {overlaps.length > 0 && (
            <div className={`overlap ${extend ? 'warn-box' : ''}`}>
              <span className="small">{extend ? '⚠ Overlaps with work you already have' : 'Checked against'}{s.payload?.note ? `: ${s.payload.note}` : ''}</span>
              <div className="overlap-list">{overlaps.map(o => (
                <button key={o.id} className="link small ellipsis" onClick={() => o.kind.includes('scout') ? (location.hash = '#library') : o.kind === 'routine' ? (location.hash = '#automations') : onOpen(o.id)}>{o.kind}: {o.title}</button>
              ))}</div>
            </div>
          )}
          <div className="sugg-actions">
            {s.kind === 'consolidate' && s.evidence?.length > 1 && <button className="primary" onClick={() => window.dispatchEvent(new CustomEvent('perch-compare', { detail: s.evidence }))} title="See them side by side before deciding">Compare</button>}
            {s.kind === 'consolidate' && <button onClick={accept} title="Keep the newest, link the rest to it and archive them; pause duplicate routines">Consolidate</button>}
            {(s.kind === 'routine' || s.kind === 'rule') && (extend
              ? <><button onClick={() => setOpen(s.id)}>Review overlap</button><button className="link small" onClick={accept}>automate anyway</button></>
              : <button className="primary" onClick={accept}>Automate this</button>)}
            {s.kind === 'routine' && <DryRunButton id={s.id} />}
            {s.payload?.risk && <span className={`chip ${s.payload.risk === 'low' ? 'ok' : ''}`} title={s.payload.blast}>{s.payload.risk === 'low' ? 'read-only' : 'writes'}</span>}
            {s.kind === 'attention' && s.payload?.link && <a href={s.payload.link} target="_blank" rel="noreferrer">Open ↗</a>}
            <button className="link small" onClick={async () => { await post(`/api/autopilot/${s.id}/dismiss`); reload() }}>dismiss</button>
          </div>
          {(s.kind === 'routine' || s.kind === 'rule') && (
            <button className="link small" onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? 'hide' : 'what it will do'}</button>
          )}
          {open === s.id && (
            <pre className="small">{s.kind === 'routine' ? `Runs ${humanCron(s.payload.cron)} (${s.payload.cron}) in ${s.payload.cwd}\n\n${s.payload.prompt}` : `${s.payload.query} → ${s.payload.action} ${s.payload.value ?? ''}`}</pre>
          )}
          {s.evidence?.length > 0 && <div className="row-flex">{s.evidence.slice(0, 4).map((id, i) => <button key={id} className="link small" onClick={() => onOpen(id)}>{s.kind === 'consolidate' ? (i === 0 ? 'keep: open' : `duplicate ${i}`) : `evidence ${i + 1}`}</button>)}</div>}
        </div>
      )})}
      {data.automations.length > 0 && <h4>Owned automations</h4>}
      {data.automations.map(a => (
        <div key={a.id} className="auto-row">
          <span className={`chip ${a.phase === 'trusted' ? 'ok' : a.phase.startsWith('paused') ? 'bad' : ''}`}>{a.phase}</span>
          <span className="grow ellipsis" title={a.paused_reason ?? ''}>{a.name}{a.paused_reason ? <span className="bad small"> · {a.paused_reason}</span> : null}</span>
          <span className="runs">{[...a.runs].reverse().map((r, i) => <span key={i} className={`dot ${OUTCOME[r.outcome] ?? ''}`} title={`${r.outcome} ${ago(r.started_at)} ago${r.detail ? `\n${r.detail}` : ''}`} onClick={() => r.conversation_id && onOpen(r.conversation_id)} />)}</span>
          <span className="muted small">{a.week.n ? `${a.week.n} runs/7d${a.week.cost ? ` · $${a.week.cost.toFixed(2)}` : ''}` : humanCron(a.cron)}</span>
          {!a.enabled && <button className="small" onClick={async () => { await post(`/api/routines/${a.id}/resume`); reload() }}>Resume</button>}
        </div>
      ))}
    </section>
  )
}

// A rehearsal of an automation before it exists: what a real run would do right now.
export function DryRun({ id }: { id: string }) {
  const [text, setText] = useState('')
  const [done, setDone] = useState(false)
  const [steps, setSteps] = useState(0)
  useEffect(() => streamSSE(`/api/autopilot/${id}/dryrun`, {}, ev => {
    if (ev.type === 'stream_event' && ev.event?.type === 'content_block_start' && ev.event.content_block?.type === 'tool_use') { setText(''); setSteps(n => n + 1) }
    if (ev.type === 'stream_event' && !ev.parent_tool_use_id && ev.event?.delta?.type === 'text_delta') setText(t => t + ev.event.delta.text)
    if (ev.type === 'perch_done') setDone(true)
  }), [id])
  return (
    <div className="dryrun">
      <div className="muted small">{done ? 'Preview: one real run, with nothing changed. Anything it would have changed is listed at the end.' : `Running it once for real, read-only… ${steps} checks so far`}</div>
      {text && <Markdown text={text} />}
    </div>
  )
}

function DryRunButton({ id }: { id: string }) {
  const [on, setOn] = useState(false)
  return <>{on ? <div className="full-row"><DryRun id={id} /></div> : <button onClick={() => setOn(true)} title="Run it once for real, changing nothing, and show the result">Preview</button>}</>
}

// The one question autopilot interrupts for: a higher-risk automation it would like to set up.
export function AskCard() {
  const { data, reload } = useLive<any>('/api/autopilot', ['autopilot' as any])
  const [dry, setDry] = useState(false)
  const [gone, setGone] = useState<string[]>(() => { try { return JSON.parse(sessionStorage.getItem('perch.asked') ?? '[]') } catch { return [] } })
  const s = data?.ask
  if (!s || gone.includes(s.id) || document.querySelector('.app.zen')) return null
  const hide = () => { const g = [...gone, s.id]; setGone(g); try { sessionStorage.setItem('perch.asked', JSON.stringify(g)) } catch {} }
  const p = s.payload ?? {}
  return (
    <div className="ask-card">
      <div className="row-flex"><b className="grow">🤖 {p.ask || s.title}</b><button className="icon" onClick={hide} title="Close">×</button></div>
      <div className="small">{p.what || `A routine, “${p.name ?? s.title}”, that runs ${p.cron ? humanCron(p.cron) : 'when you trigger it'}. Each run is a new conversation in auto-m8, listed under Automations.`}</div>
      <div className="muted small">{p.cron ? `Runs ${humanCron(p.cron)}` : ''}{p.blast ? ` · ${p.blast}` : ''}</div>
      <details className="small"><summary className="muted">Exact instructions</summary><pre className="small">{p.prompt}</pre></details>
      {dry && <DryRun id={s.id} />}
      <div className="row-flex">
        <button className="primary" onClick={async () => { await post(`/api/autopilot/${s.id}/accept`); hide(); reload() }}>Turn it on</button>
        {!dry && <button onClick={() => setDry(true)}>Preview a run</button>}
        <button className="link small" onClick={async () => { await post(`/api/autopilot/${s.id}/later`); hide(); reload() }}>not now</button>
      </div>
    </div>
  )
}
