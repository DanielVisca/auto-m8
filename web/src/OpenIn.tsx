// "Open in…": Slack thread, PostHog, PostHog Code, Terminal, Cursor, Finder. Links work on any
// device; apps open on the Mac.
import { useEffect, useRef, useState } from 'react'
import { openIn, openTargets, type OpenTarget } from './api'
import { Popover } from './Popover'
import { Brand } from './Brand'

const ICON: Record<string, string> = { slack: 'slack', posthog: 'posthog', 'posthog-code': 'posthog', terminal: 'terminal', cursor: 'cursor', finder: 'finder' }

export function OpenIn({ id }: { id: string }) {
  const [open, setOpen] = useState(false)
  const [targets, setTargets] = useState<OpenTarget[]>([])
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (open) openTargets(id).then(setTargets) }, [open, id])
  return (
    <>
      <button ref={ref} className="icon" title="Open in Slack, PostHog, Terminal, Cursor…" onClick={() => setOpen(!open)}>↗</button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)}>
        <div className="menu">
          {targets.map(t => <button key={t.target} onClick={() => { openIn(id, t); setOpen(false) }}><span className="open-icon"><Brand id={ICON[t.target]} size={16} /></span>{t.label}</button>)}
          {!targets.length && <span className="muted small pad-s">Loading…</span>}
        </div>
      </Popover>
    </>
  )
}
