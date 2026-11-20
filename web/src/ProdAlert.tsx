// Prod alert: a tiny red dot, only while a merged PR has a high-confidence health or blast-radius
// concern open. Nothing open means nothing drawn, so it never becomes background noise. It clears
// by itself when the scorecard stops saying concerns.
import { useRef, useState } from 'react'
import { ago, useLive } from './api'
import { Popover } from './Popover'

type Alert = { url: string; comment_url: string | null; since: number | null; reason: string }
export function ProdAlert() {
  const { data } = useLive<{ alerts: Alert[] }>('/api/prod-alerts', ['home'])
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const alerts = data?.alerts ?? []
  if (!alerts.length) return null
  return <>
    <button ref={ref} className="icon no-drag prod-alert" onClick={() => setOpen(!open)} title={`${alerts.length} production concern${alerts.length > 1 ? 's' : ''}`}>●</button>
    <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={380}>
      <div className="prod-alert-pop">
        {alerts.map(a => <div key={a.url} className="prod-alert-row">
          <a href={a.comment_url ?? a.url} target="_blank" rel="noreferrer">{a.url.replace('https://github.com/', '').replace('/pull/', '#')}</a>
          <span className="muted small"> {a.reason}{a.since ? ` · ${ago(a.since)}` : ''}</span>
        </div>)}
      </div>
    </Popover>
  </>
}
