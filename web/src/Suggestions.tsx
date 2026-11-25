// The unblocker on Home: one line per thing that would unblock you, one action each, × to drop it
// for good. Empty (and absent) unless the server has something; see server/suggestions.ts.
import { api, post, useLive } from './api'

type Suggestion = { kind: string; key: string; text: string; action: { label: string; chat?: string; href?: string; settings?: Record<string, unknown> } }

export function Suggestions({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, reload } = useLive<{ suggestions: Suggestion[] }>('/api/suggestions', ['suggestions', 'settings'])
  const items = data?.suggestions ?? []
  if (!items.length) return null
  const act = async (s: Suggestion) => {
    await post('/api/suggestions/act', { kind: s.kind, key: s.key, settings: s.action.settings })
    if (s.action.chat) { const r = await api.send<{ id: string }>('POST', '/api/chat', { prompt: s.action.chat, clientKey: crypto.randomUUID() }); if (r?.id) onOpen(r.id) }
    else if (s.action.href) location.hash = s.action.href
    reload()
  }
  const dismiss = async (s: Suggestion) => { await post('/api/suggestions/dismiss', { kind: s.kind, key: s.key }); reload() }
  return (
    <div className="suggestions">
      {items.map(s => (
        <div key={`${s.kind}:${s.key}`} className="line suggestion">
          <span className="grow">{s.text}</span>
          <button className="small" onClick={() => act(s)}>{s.action.label}</button>
          <button className="link small muted" title="Don't show this again" onClick={() => dismiss(s)}>×</button>
        </div>
      ))}
    </div>
  )
}
