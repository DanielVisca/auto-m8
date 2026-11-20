// A tile in a chat message: a ```tile block of HTML, CSS and JS (an artifact that draws itself).
// It runs in the sandbox code tiles use (tileBridge.ts), with no network of its own. Its data comes
// through perch's bridge. The block's info string is optional JSON:
//   {"title":"..","height":320,"refresh":30,"vars":{"hours":24,"env":"prod"}}
// Each var becomes an input the reader can change; the tile reruns when one changes, on its refresh
// timer, and when perch's data changes (the same topics canvas code tiles listen to).
import { useEffect, useMemo, useRef, useState } from 'react'
import { onTopic, post } from './api'
import { inlineDoc, tileTheme } from './tileBridge'

export type TileVar = string | number | boolean
export type TileInfo = { title?: string; height: number; refresh: number; vars: Record<string, TileVar> }

export function parseTileInfo(info: string): TileInfo {
  let s: any = {}
  try { s = info.trim() ? JSON.parse(info) : {} } catch { s = {} }
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = {}
  const vars: Record<string, TileVar> = {}
  if (s.vars && typeof s.vars === 'object' && !Array.isArray(s.vars)) {
    for (const [k, v] of Object.entries(s.vars)) if (['string', 'number', 'boolean'].includes(typeof v)) vars[k] = v as TileVar
  }
  const h = Number(s.height)
  return {
    title: typeof s.title === 'string' ? s.title.slice(0, 120) : undefined,
    height: Number.isFinite(h) && h > 0 ? Math.min(900, Math.max(120, h)) : 320,
    refresh: Math.max(0, Number(s.refresh) || 0),
    vars,
  }
}

// Sources a chat tile may read. "http" is left out: perch would fetch whatever URL the tile names,
// which is a way to send data out.
const SOURCES = new Set(['posthog', 'github', 'perch'])

export function InlineTile({ info, body }: { info: string; body: string }) {
  const meta = useMemo(() => parseTileInfo(info), [info])
  const [vars, setVars] = useState<Record<string, TileVar>>(meta.vars)
  const [updated, setUpdated] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  // Built once per body: changing a variable sends a message instead of reloading the tile.
  const doc = useMemo(() => inlineDoc(tileTheme(), meta.vars, body), [body]) // eslint-disable-line

  useEffect(() => {
    const on = async (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return
      const m = e.data ?? {}
      const reply = (data: any, err?: string) => frame.current?.contentWindow?.postMessage({ perch: 'reply', id: m.id, data, error: err }, '*')
      if (m.perch === 'data') {
        if (!SOURCES.has(m.payload?.source)) return reply(null, `A chat tile can read posthog, github or Mothership data, not ${m.payload?.source ?? 'nothing'}.`)
        const r = await post<any>('/api/canvas/data', m.payload).catch((err: any) => ({ error: String(err?.message ?? err) }))
        if (r?.error) { reply(null, r.error); setError(r.error) } else { reply(r.data); setUpdated(r.at); setError(null) }
      }
      // A chat tile keeps no saved state: its page can use perch.save, which only answers.
      if (m.perch === 'save') reply(true)
      if (m.perch === 'error') setError(String(m.payload))
    }
    addEventListener('message', on)
    const kick = () => { if (document.visibilityState === 'visible') frame.current?.contentWindow?.postMessage({ perch: 'refresh' }, '*') }
    let soon: any
    const debounced = () => { clearTimeout(soon); soon = setTimeout(kick, 600) }
    const offs = (['canvasdata', 'prs', 'prflow', 'home'] as const).map(tp => onTopic(tp, debounced))
    const timer = meta.refresh ? setInterval(kick, Math.max(5, meta.refresh) * 1000) : null
    document.addEventListener('visibilitychange', kick)
    return () => {
      removeEventListener('message', on)
      if (timer) clearInterval(timer)
      offs.forEach(o => o())
      clearTimeout(soon)
      document.removeEventListener('visibilitychange', kick)
    }
  }, [meta.refresh])

  const setVar = (k: string, v: TileVar) => {
    const next = { ...vars, [k]: v }
    setVars(next)
    frame.current?.contentWindow?.postMessage({ perch: 'vars', payload: next }, '*')
  }
  const hasBar = !!meta.title || Object.keys(vars).length > 0 || !!updated
  return (
    <div className="inline-tile">
      {hasBar && <div className="inline-tile-bar">
        {meta.title && <span className="viz-title" title={meta.title}>{meta.title}</span>}
        {Object.entries(vars).map(([k, v]) => (
          <label key={k} className="small inline-tile-var">
            <span className="muted">{k}</span>
            {typeof v === 'boolean'
              ? <input type="checkbox" checked={v} onChange={e => setVar(k, e.target.checked)} />
              : <input type={typeof v === 'number' ? 'number' : 'text'} value={String(v)}
                  onChange={e => setVar(k, typeof v === 'number' ? (e.target.value === '' ? 0 : Number(e.target.value)) : e.target.value)} />}
          </label>
        ))}
        {updated && <span className="small muted tile-fresh" title="When Mothership last served this tile's data">updated {new Date(updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
      </div>}
      <iframe ref={frame} sandbox="allow-scripts" srcDoc={doc} title={meta.title ?? 'tile'} style={{ height: meta.height }} onLoad={() => frame.current?.contentWindow?.postMessage({ perch: 'refresh' }, '*')} />
      {error && <div className="bad small inline-tile-err">{error}</div>}
    </div>
  )
}
