// Focus: narrow everything to one or two areas. An area is a saved search, so a label, a
// project, a repo or plain words all work. Shared with every device through the server.
import { useEffect, useRef, useState } from 'react'
import { api, useLive } from './api'
import { Popover } from './Popover'

type Area = { name: string; query: string }
type Suggestions = { labels: (Area & { n: number })[]; projects: (Area & { n: number })[]; repos: (Area & { n: number })[]; current: { active: boolean; areas: Area[] } }

const save = (focus: { active: boolean; areas: Area[] }) => api.send('PUT', '/api/settings', { focus })

export function FocusButton({ settings }: { settings: any }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const focus = settings?.focus ?? { active: false, areas: [] }
  useEffect(() => {
    const f = () => setOpen(o => !o)
    window.addEventListener('perch-focus', f)
    return () => window.removeEventListener('perch-focus', f)
  }, [])
  return (
    <div className="focus-wrap no-drag">
      <button ref={ref} className={`icon ${focus.active ? 'on focus-on' : ''}`} onClick={() => setOpen(!open)} title="Focus on one or two areas  ⌘⇧F">◎</button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} align="start" width={340}>
        <FocusPicker focus={focus} onDone={() => setOpen(false)} />
      </Popover>
    </div>
  )
}

function FocusPicker({ focus, onDone }: { focus: { active: boolean; areas: Area[] }; onDone: () => void }) {
  const { data } = useLive<Suggestions>('/api/focus/suggestions')
  const [areas, setAreas] = useState<Area[]>(focus.areas)
  const [custom, setCustom] = useState('')
  const has = (a: Area) => areas.some(x => x.query === a.query)
  // Two areas at most: picking a third replaces the oldest.
  const toggle = (a: Area) => setAreas(has(a) ? areas.filter(x => x.query !== a.query) : [...areas, a].slice(-2))
  const apply = (active: boolean) => { save({ active, areas: active ? areas : focus.areas }); onDone() }
  const group = (title: string, items?: (Area & { n: number })[]) => items && items.length > 0 && (
    <div className="focus-group">
      <div className="section-head">{title}</div>
      <div className="focus-chips">
        {items.map(a => <button key={a.query} className={`chip-btn ${has(a) ? 'on' : ''}`} onClick={() => toggle(a)}>{a.name}<span className="count">{a.n}</span></button>)}
      </div>
    </div>
  )
  return (
    <div className="focus-pop">
      <div className="focus-title"><b>Zen</b><span className="muted small">A calmer perch with only one or two areas in it. Pinned conversations stay. ⌘⇧F to leave.</span></div>
      {areas.length > 0 && (
        <div className="chips">{areas.map(a => <span key={a.query} className="chip">◎ {a.name} <button onClick={() => toggle(a)}>×</button></span>)}</div>
      )}
      {group('Labels', data?.labels)}
      {group('Projects', data?.projects)}
      {group('Repos with open PRs', data?.repos)}
      <input value={custom} placeholder='Any search: words, "phrase", #label, repo:x…' onChange={e => setCustom(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && custom.trim()) { toggle({ name: custom.trim(), query: custom.trim() }); setCustom('') } }} />
      {!data?.labels.length && <div className="muted small">Tip: label a workstream (right-click → Labels) and it shows up here.</div>}
      <div className="row-flex">
        <button className="primary" disabled={!areas.length} onClick={() => apply(true)}>Enter zen</button>
        {!areas.length && !focus.active && <button onClick={() => { save({ active: true, areas: [] }); onDone() }} title="Same calm UI, nothing filtered">Just calm the UI</button>}
        {focus.active && <button onClick={() => apply(false)}>Leave zen</button>}
        <span className="grow" />
        <span className="muted small">⌘⇧F</span>
      </div>
    </div>
  )
}

export function FocusBanner({ focus, hidden }: { focus: { areas: Area[] } | null | undefined; hidden?: number }) {
  if (!focus) return null
  return (
    <div className="focus-banner">
      <span>◎ Zen{focus.areas.length ? ` · ${focus.areas.map(a => a.name).join(' + ')}` : ''}</span>
      {hidden ? <span className="muted small">{hidden} hidden</span> : null}
      <span className="grow" />
      <button className="link small" onClick={() => window.dispatchEvent(new Event('perch-focus'))}>change</button>
      <button className="link small" onClick={() => api.get('/api/settings').then(s => save({ ...s.focus, active: false }))}>leave</button>
    </div>
  )
}
