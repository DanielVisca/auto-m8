// Self drive (🚗) in the chat header: click to let an agent take control of the chat, hover to see
// what it is and what it's doing, right-click for its settings and its recent decisions.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ago, post, useLive } from './api'

type Settings = { mode: 'full' | 'careful'; perHour: number; recheckMin: number; model: string | null; instructions: string; budgetHour: number | null }
type State = { on: boolean; replies: number; status: string | null; note: string | null; settings: Settings; spentHour: number; log: { at: number; action: string; message: string | null; reason: string | null }[] }

const STATUS: Record<string, string> = { thinking: 'deciding…', needs_you: 'needs you', paused: 'paused', backoff: 'cooling off', resumed: 'picked up a stall', waiting: 'waiting', budget: 'over budget', replied: 'driving', error: 'retrying', done: 'done' }
const statusText = (d: State) => d.on ? (d.status && STATUS[d.status]) || 'driving' : 'off'
const ACTION: Record<string, string> = { reply: '↩ replied', resume: '⟳ resumed a stall', wait: '⏸ waiting', done: '✓ done', needs_you: '✋ handed back', error: '⚠ driver failed', backoff: '❄ cooled off', budget: '$ paused for budget', on: '🚗 on', off: 'off' }

export function SelfDriveButton({ id }: { id: string }) {
  const url = `/api/chat/${encodeURIComponent(id)}/self-drive`
  const { data, reload } = useLive<State>(url, ['chats'])
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const on = !!data?.on
  const toggle = async () => { await post(url, { on: !on }); reload() }
  return (
    <span className="drive-wrap">
      <button className={`icon drive-btn${on ? ' on' : ''}${data?.status === 'needs_you' && on ? ' warn' : ''}`} aria-pressed={on}
        onClick={toggle} onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }) }}>
        🚗{on && data && <span className="drive-status">{statusText(data)}{data.replies ? ` · ${data.replies}` : ''}</span>}
      </button>
      {!menu && (
        <span className="drive-tip" role="tooltip">
          <span><b>Self drive</b>: let an agent take control of this chat.</span>
          <span>It answers questions, picks up stalls and keeps going until the work is done. Only what only you can do comes back to you.</span>
          <span className="muted">{on ? `On · ${data ? statusText(data) : ''}${data?.note ? `: ${data.note}` : ''}` : 'Click to turn on.'} Right-click for settings.</span>
        </span>
      )}
      {menu && data && <DriveMenu at={menu} url={url} data={data} onChange={reload} onClose={() => setMenu(null)} />}
    </span>
  )
}

function DriveMenu({ at, url, data, onChange, onClose }: { at: { x: number; y: number }; url: string; data: State; onChange: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: at.x, top: at.y })
  const [instructions, setInstructions] = useState(data.settings.instructions)
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (r) setPos({ left: Math.max(8, Math.min(at.x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(at.y, innerHeight - r.height - 8)) })
  }, [at.x, at.y])
  useEffect(() => {
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('mousedown', away); addEventListener('keydown', esc)
    return () => { removeEventListener('mousedown', away); removeEventListener('keydown', esc) }
  }, [onClose])
  const s = data.settings
  const save = async (patch: Partial<Settings>) => { await post(url, { settings: patch }); onChange() }
  const pick = <K extends keyof Settings>(key: K, value: Settings[K], label: string) =>
    <button key={String(value)} className={`drive-opt${s[key] === value ? ' on' : ''}`} onClick={() => save({ [key]: value } as Partial<Settings>)}>{label}</button>
  // After the presets: type any number. Shows the current value when it isn't one of the presets.
  const custom = (key: 'perHour' | 'recheckMin' | 'budgetHour', presets: (number | null)[], placeholder: string) =>
    <CustomNumber key={`${key}-${s[key]}`} value={presets.includes(s[key]) ? null : s[key]} placeholder={placeholder} decimals={key === 'budgetHour'}
      onSave={v => save({ [key]: v } as Partial<Settings>)} />
  return (
    <div className="ctx drive-menu" ref={ref} style={pos} onContextMenu={e => e.preventDefault()}>
      <button onClick={async () => { await post(url, { on: !data.on }); onChange() }}>{data.on ? '■ Turn self drive off' : '🚗 Let an agent take control'}</button>
      <div className="ctx-head">How independent</div>
      <div className="drive-row">{pick('mode', 'full', 'Full')}{pick('mode', 'careful', 'Careful')}</div>
      <div className="drive-hint">{s.mode === 'full' ? 'Only irreversible or outward-facing things, and real loops, come back to you.' : 'Also checks with you on big, lasting choices (architecture, APIs, data models).'}</div>
      <div className="ctx-head">Messages per hour before it cools off</div>
      <div className="drive-row">{[10, 20, 40].map(n => pick('perHour', n, String(n)))}{custom('perHour', [10, 20, 40], 'custom')}</div>
      <div className="ctx-head">When waiting on CI or a deploy, look again after</div>
      <div className="drive-row">{[10, 20, 60].map(n => pick('recheckMin', n, `${n} min`))}{custom('recheckMin', [10, 20, 60], 'min')}</div>
      <div className="ctx-head">Budget per hour</div>
      <div className="drive-row">{pick('budgetHour', null, 'None')}{[1, 5, 20].map(n => pick('budgetHour', n, `$${n}`))}{custom('budgetHour', [null, 1, 5, 20], '$')}</div>
      <div className="drive-hint">{s.budgetHour ? `$${data.spentHour.toFixed(2)} of $${s.budgetHour} used in the last hour. Over it, self drive pauses until the hour rolls over, then carries on.` : `$${data.spentHour.toFixed(2)} in the last hour (this chat and its driver, at API prices; on your plan it counts toward limits, not billed).`}</div>
      <div className="ctx-head">Driver model</div>
      <div className="drive-row">{pick('model', null, 'Default')}{pick('model', 'opus', 'Opus')}{pick('model', 'sonnet', 'Sonnet')}</div>
      <div className="ctx-head">Your instructions for the driver</div>
      <textarea className="drive-instr" rows={3} value={instructions} placeholder="e.g. Merge when CI is green. Prefer the smallest change. Never touch the billing code."
        onChange={e => setInstructions(e.target.value)} onBlur={() => { if (instructions !== s.instructions) save({ instructions }) }} />
      {data.log.some(l => l.action !== 'on' && l.action !== 'off') && <>
        <div className="ctx-head">Recent decisions</div>
        <div className="drive-log">
          {data.log.filter(l => l.action !== 'on' && l.action !== 'off').slice(0, 6).map((l, i) => (
            <div key={i} title={l.message ?? ''}><span>{ACTION[l.action] ?? l.action}</span> <span className="muted">{ago(l.at)}{l.reason ? ` · ${l.reason}` : ''}</span></div>
          ))}
        </div>
      </>}
    </div>
  )
}

function CustomNumber({ value, placeholder, decimals, onSave }: { value: number | null; placeholder: string; decimals?: boolean; onSave: (v: number | null) => void }) {
  const [text, setText] = useState(value === null ? '' : String(value))
  const commit = () => {
    const n = Number(text)
    if (text.trim() && n > 0 && n !== value) onSave(decimals ? n : Math.round(n))
  }
  return <input className={`drive-num${value !== null ? ' on' : ''}`} type="number" min={decimals ? 0.1 : 1} step={decimals ? 0.5 : 1} value={text} placeholder={placeholder}
    onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur() } }} />
}
