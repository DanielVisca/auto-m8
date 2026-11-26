// ?look=<key>: one piece of message text drawn exactly as the chat draws it (markdown, ```tile, ```chart,
// ```vega-lite), for the picture the desktop app captures offscreen when an agent calls look (server/look.ts).
import { useEffect, useState } from 'react'
import { RichText } from './Chat'

export function Look({ lookKey }: { lookKey: string }) {
  const [text, setText] = useState<string | null>(null), [err, setErr] = useState('')
  useEffect(() => {
    fetch(`/api/look/${encodeURIComponent(lookKey)}`).then(r => r.json()).then(j => j.text != null ? setText(j.text) : setErr(j.error ?? 'nothing to draw'), e => setErr(String(e)))
  }, [lookKey])
  if (err) return <div className="look-root muted">look: {err}</div>
  if (text == null) return null
  return <div className="look-root"><div className="msg assistant"><RichText text={text} /></div></div>
}
