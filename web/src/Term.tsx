import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import { api, isDarkTheme, type Term as TermInfo } from './api'

const theme = () => isDarkTheme()
  ? { background: '#16171a', foreground: '#e6e6e6', cursor: '#f5a524', selectionBackground: '#3a3d45' }
  : { background: '#fbfbfa', foreground: '#1f2328', cursor: '#d97706', selectionBackground: '#cfd6e0' }

export function TermView({ term, onClose, compact }: { term: TermInfo; onClose: () => void; compact?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const t = new Terminal({ fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontSize: 12.5, lineHeight: 1.15, cursorBlink: true, theme: theme(), allowProposedApi: true, scrollback: 5000 })
    const fit = new FitAddon()
    t.loadAddon(fit)
    t.open(host.current!)
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/term/${term.id}`)
    const sendSize = () => { try { fit.fit() } catch {} if (ws.readyState === 1) ws.send(JSON.stringify({ r: [t.cols, t.rows] })) }
    ws.onopen = sendSize
    ws.onmessage = e => t.write(e.data)
    t.onData(d => ws.readyState === 1 && ws.send(JSON.stringify({ d })))
    // Links in output open in the browser (or the default browser from the window shell).
    t.attachCustomKeyEventHandler(e => !(e.metaKey && ['k', 'n', 't', 'j', ','].includes(e.key)))
    const ro = new ResizeObserver(() => requestAnimationFrame(sendSize))
    ro.observe(host.current!)
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const onTheme = () => { t.options.theme = theme() }
    mq.addEventListener('change', onTheme)
    const themeObs = new MutationObserver(onTheme)
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    t.focus()
    // Keep a prefilled command visible as the shell draws it.
    if (compact) host.current!.scrollIntoView({ block: 'nearest' })
    return () => { ro.disconnect(); themeObs.disconnect(); ws.close(); t.dispose(); mq.removeEventListener('change', onTheme) }
  }, [term.id])

  return (
    <div className={compact ? 'termview compact' : 'termview'}>
      <div className="view-head">
        <div className="grow title">⌘_ {term.title}{compact && (term.needsUser ? <span className="term-ask"> · {term.needsUser}</span> : term.state === 'at prompt' ? <span className="muted small"> · press Enter to run</span> : null)}{term.owner && <span className="muted small" title="The agent in this chat owns this terminal: it reads the output and carries on when the command finishes."> · agent watching</span>} <span className="muted small">{term.cwd.replace(/^\/Users\/[^/]+/, '~')}</span></div>
        <button className="icon" title={term.owner ? 'Close terminal (the agent is told it exited)' : 'Close terminal'} onClick={() => { api.send('DELETE', `/api/terms/${term.id}`); onClose() }}>×</button>
      </div>
      <div className="xterm-host" ref={host} />
    </div>
  )
}
