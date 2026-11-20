// Right-click on any conversation (or a selection of them): state, snooze, labels, and spreading
// a label to the conversations that look like the same workstream.
import { carry } from './Profile'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SHOW_LABELS, openIn, post, useLive, type Conversation, type OpenTarget } from './api'
import { Brand } from './Brand'

export type MenuTarget = { x: number; y: number; items: Conversation[] }

const DAY = 86400_000
function snoozeOptions() {
  const at = (days: number, hour = 9) => { const d = new Date(Date.now() + days * DAY); d.setHours(hour, 0, 0, 0); return d.getTime() }
  const monday = (() => { const d = new Date(); const add = ((8 - d.getDay()) % 7) || 7; return at(add) })()
  return [
    ['Tomorrow morning', at(1)], ['In 3 days', at(3)], ['Next Monday', monday], ['In 2 weeks', at(14)], ['Next month', at(30)],
  ] as [string, number][]
}

export function ContextMenu({ target, onClose, onOpenTerminal }: { target: MenuTarget; onClose: () => void; onOpenTerminal: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: target.x, top: target.y })
  const [sub, setSub] = useState<'snooze' | 'labels' | null>(null)
  const [newLabel, setNewLabel] = useState('')
  const { data: labelData } = useLive<{ labels: { label: string; n: number }[] }>('/api/labels', ['conversations'])
  const one = target.items.length === 1 ? target.items[0] : null
  const { data: sib } = useLive<{ siblings: { id: string; title: string }[] }>(one ? `/api/conversations/${encodeURIComponent(one.id)}/siblings` : null)
  const { data: openData } = useLive<{ targets: OpenTarget[] }>(one ? `/api/conversations/${encodeURIComponent(one.id)}/open` : null)
  const ids = target.items.map(c => c.id)

  // Keep the menu on screen at any window size.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const place = () => {
      const r = el.getBoundingClientRect()
      setPos({ left: Math.max(8, Math.min(target.x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(target.y, innerHeight - Math.min(r.height, innerHeight - 16) - 8)) })
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(el)
    return () => ro.disconnect()
  }, [target])
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    setTimeout(() => window.addEventListener('mousedown', close), 0)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc) }
  }, [onClose])

  const state = (s: string | null, extra: object = {}) => { post('/api/conversations/state', { ids, state: s, ...extra }); onClose() }
  const has = (l: string) => target.items.every(c => c.labels?.includes(l))
  const toggle = (l: string) => post('/api/labels', has(l) ? { ids, remove: [l] } : { ids, add: [l] })
  const addNew = (spread = false) => {
    const l = newLabel.trim()
    if (!l) return
    post('/api/labels', { ids: spread && sib ? [...ids, ...sib.siblings.map(s => s.id)] : ids, add: [l] })
    setNewLabel('')
  }
  const labels = labelData?.labels ?? []
  const pinned = target.items.every(c => c.pinned)

  return (
    <div className="ctx" ref={ref} style={pos} onContextMenu={e => e.preventDefault()}>
      {target.items.length > 1 && <div className="ctx-head">{target.items.length} conversations</div>}
      {target.items.length > 1 && <button onClick={() => { window.dispatchEvent(new CustomEvent('perch-compare', { detail: ids })); onClose() }}>⇆ Compare {target.items.length} side by side</button>}
      <button onClick={() => state('active')}><span className="dot s-active" />Active</button>
      <button onClick={() => setSub(sub === 'snooze' ? null : 'snooze')}><span className="dot s-later" />Later…<span className="grow" />›</button>
      {sub === 'snooze' && (
        <div className="ctx-sub">
          {snoozeOptions().map(([label, until]) => <button key={label} onClick={() => state('later', { snoozeUntil: until })}>{label}<span className="grow" /><span className="muted small">{new Date(until).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span></button>)}
          <button onClick={() => state('later')}>Someday <span className="grow" /><span className="muted small">no date</span></button>
        </div>
      )}
      <button onClick={() => state('done')}><span className="dot s-done" />Done</button>
      <button onClick={() => state('archived')} title="Out of the lists, still found by search"><span className="dot s-archived" />Archive</button>
      <button onClick={() => state('hidden')} title="Gone from lists, search and suggestions. Find it again with state:hidden"><span className="dot" />Hide for good</button>
      <button onClick={() => state(null)} title="Let Mothership decide from activity and PRs">↺ Automatic</button>
      <hr />
      {SHOW_LABELS && <button onClick={() => setSub(sub === 'labels' ? null : 'labels')}>🏷 Labels…<span className="grow" />›</button>}
      {sub === 'labels' && (
        <div className="ctx-sub">
          <input autoFocus value={newLabel} placeholder="New label, Enter to add" onChange={e => setNewLabel(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addNew(e.metaKey) }} />
          {one && sib && sib.siblings.length > 0 && newLabel && (
            <button className="small" onClick={() => addNew(true)} title={sib.siblings.map(s => s.title).join('\n')}>+ also the {sib.siblings.length} related (same branch, PRs or links)  ⌘↵</button>
          )}
          <div className="ctx-labels">
            {labels.slice(0, 14).map(l => (
              <label key={l.label}><input type="checkbox" checked={has(l.label)} onChange={() => toggle(l.label)} />#{l.label}<span className="muted small">{l.n}</span></label>
            ))}
          </div>
        </div>
      )}
      {one && <button onClick={() => { carry(one.id); onClose() }} title="Copy it to your other profile (you see exactly what goes first)">↪ Copy to another profile…</button>}
      {one && <button onClick={() => { renameNext = one.id; window.dispatchEvent(new CustomEvent('perch-open', { detail: one.id })); onClose() }}>✎ Rename</button>}
      <button onClick={() => { post('/api/conversations/state', { ids, pinned: !pinned }); onClose() }}>{pinned ? 'Unpin' : '📌 Pin'}</button>
      {one && one.source !== 'posthog-task' && <button onClick={() => { onOpenTerminal(one.id); onClose() }}><Brand id="claude" size={15} /> Open in Claude Code here</button>}
      {one && openData?.targets.map(t => <button key={t.target} onClick={() => { openIn(one.id, t); onClose() }}><Brand id={t.target === 'posthog-code' ? 'posthog' : t.target} size={15} /> Open in {t.label}</button>)}
      {one && <button onClick={() => { navigator.clipboard.writeText(one.source === 'posthog-task' ? one.url ?? one.id : `claude --resume ${one.id}`); onClose() }}>Copy {one.source === 'posthog-task' ? 'link' : 'resume command'}</button>}
    </div>
  )
}

export function useMenu() {
  const [target, setTarget] = useState<MenuTarget | null>(null)
  return { target, open: setTarget, close: () => setTarget(null) }
}


// "Rename" opens the conversation with its title ready to edit (Electron has no prompt()).
export let renameNext: string | null = null
export const takeRename = (id: string) => { if (renameNext !== id) return false; renameNext = null; return true }
