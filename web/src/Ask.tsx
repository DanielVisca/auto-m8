// "Ask Claude" over your own history: Claude searches and reads your conversations with the
// perch tools and answers with links back to them. Nothing is saved.
import { useEffect, useState } from 'react'
import { streamSSE } from './api'
import { Markdown } from './Chat'
import { toolSummary } from './stream'

export function Ask({ question, onAsk }: { question: string; onAsk: (q: string) => void }) {
  const [answer, setAnswer] = useState('')
  const [steps, setSteps] = useState<string[]>([])
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [q, setQ] = useState(question)
  useEffect(() => {
    setAnswer(''); setSteps([]); setDone(false); setError(''); setQ(question)
    const tools = new Map<number, { name: string; json: string }>()
    return streamSSE('/api/ask', { question }, ev => {
      const e = ev.event
      // Text before a tool call is narration ("let me search"); the answer is what comes after the last one.
      if (ev.type === 'stream_event' && e?.type === 'content_block_start' && e.content_block?.type === 'tool_use') { tools.set(e.index, { name: e.content_block.name, json: '' }); setAnswer('') }
      if (ev.type === 'stream_event' && e?.delta?.type === 'input_json_delta') { const t = tools.get(e.index); if (t) t.json += e.delta.partial_json }
      if (ev.type === 'stream_event' && e?.type === 'content_block_stop' && tools.has(e.index)) {
        const t = tools.get(e.index)!
        let input: any = {}
        try { input = JSON.parse(t.json) } catch {}
        setSteps(s => [...s, `${t.name.includes('search') ? 'searched' : 'read'} ${toolSummary(t.name, input) || input.id || ''}`])
        tools.delete(e.index)
      }
      if (ev.type === 'stream_event' && e?.delta?.type === 'text_delta') setAnswer(a => a + e.delta.text)
      if (ev.type === 'result' && ev.is_error) setError(String(ev.result ?? 'failed'))
      if (ev.type === 'perch_done') { setDone(true); if (ev.error) setError(ev.error) }
    })
  }, [question])
  return (
    <div className="page ask">
      <div className="row-flex">
        <input className="grow" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && q.trim()) onAsk(q.trim()) }} />
        <button onClick={() => onAsk(q.trim())}>Ask</button>
      </div>
      <div className="steps">{steps.map((s, i) => <span key={i} className="chip">{s}</span>)}{!done && <span className="muted small">{steps.length ? 'reading…' : 'searching your conversations…'}</span>}</div>
      {error && <div className="bad small">{error}</div>}
      {answer && <div className="card"><Markdown text={answer.trim()} /></div>}
    </div>
  )
}
