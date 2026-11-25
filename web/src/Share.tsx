// Share a board somewhere other people can open it (server/share.ts). auto-m8 stays the source:
// sharing publishes a translated copy, and sharing again updates it. Who can see it, its version
// history and viewers' state belong to the platform it goes to.
import { useEffect, useRef, useState } from 'react'
import { ago, api, post, toast } from './api'
import { Popover } from './Popover'

type Target = { id: string; label: string; about: string; ok: boolean; why?: string }
type Audience = { id: string; label: string; kind?: 'private' | 'project' | 'members'; hint?: string; private?: boolean }
type Share = { target: string; url: string | null; audience: string | null; audience_label: string | null; shared_at: number; notes: string[]; conflict?: boolean }

export function ShareButton({ boardId }: { boardId: string }) {
  const btn = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [targets, setTargets] = useState<Target[] | null>(null)
  const [target, setTarget] = useState('posthog')
  const [audiences, setAudiences] = useState<Audience[] | null>(null)
  const [audience, setAudience] = useState('')
  const [shares, setShares] = useState<Share[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Share | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const loadShares = () => api.get<{ shares: Share[] }>(`/api/boards/${encodeURIComponent(boardId)}/shares`).then(r => setShares(r.shares)).catch(() => {})
  useEffect(() => {
    if (!open) return
    setResult(null); setErr(null)
    loadShares()
    if (!targets) api.get<{ targets: Target[] }>('/api/share/targets').then(r => setTargets(r.targets)).catch(e => setErr(String(e.message ?? e)))
  }, [open]) // eslint-disable-line
  const t = targets?.find(x => x.id === target)
  const prev = shares.find(s => s.target === target)
  useEffect(() => {
    if (!open || !t?.ok) return
    setAudiences(null)
    api.get<{ audiences?: Audience[]; error?: string }>(`/api/share/${target}/audiences`).then(r => {
      if (r.error) return setErr(r.error)
      setAudiences(r.audiences ?? [])
      setAudience(a => a || prev?.audience || r.audiences?.find(x => x.private)?.id || r.audiences?.[0]?.id || '')
    })
  }, [open, target, t?.ok, prev?.audience]) // eslint-disable-line
  const share = async (overwrite = false) => {
    setBusy(true); setErr(null); setResult(null)
    const r = await post<Share & { error?: string }>(`/api/boards/${encodeURIComponent(boardId)}/share`, { target, audience, overwrite }).catch(e => ({ error: String(e.message ?? e) } as any))
    setBusy(false)
    if (r.error) return setErr(r.error)
    setResult(r); loadShares()
    if (!r.conflict && r.url) { navigator.clipboard?.writeText(r.url).catch(() => {}); toast('Shared. Link copied.', { kind: 'ok' }) }
  }
  const chosen = audiences?.find(a => a.id === audience)
  return (
    <>
      <button ref={btn} onClick={() => setOpen(o => !o)} title="Share this board so others can open it">{shares.length ? '⇪ Shared' : '⇪ Share'}</button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} width={380}>
        <div className="pad share-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <b>Share this board</b>
          {!targets && !err && <span className="muted small">Loading…</span>}
          {targets && targets.length > 1 && (
            <select value={target} onChange={e => { setTarget(e.target.value); setAudience('') }}>
              {targets.map(x => <option key={x.id} value={x.id} disabled={!x.ok}>{x.label}{x.ok ? '' : ' (unavailable)'}</option>)}
            </select>
          )}
          {t && <span className="muted small">{t.about}</span>}
          {t && !t.ok && <span className="small" style={{ color: 'var(--bad)' }}>{t.why}</span>}
          {t?.ok && (
            <label className="small" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              Who can see it
              <select value={audience} onChange={e => setAudience(e.target.value)} disabled={!audiences}>
                {!audiences && <option>Loading channels…</option>}
                {(['private', 'project', 'members'] as const).map(k => {
                  const list = audiences?.filter(a => (a.kind ?? 'project') === k) ?? []
                  return list.length ? <optgroup key={k} label={k === 'private' ? 'Private' : k === 'project' ? 'Public: everyone in the project' : 'Shared: members only'}>{list.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}</optgroup> : null
                })}
              </select>
              {chosen?.hint && <span className="muted">{chosen.hint}</span>}
            </label>
          )}
          {prev && <span className="muted small">Last shared {ago(prev.shared_at)}{prev.audience_label ? ` to ${prev.audience_label}` : ''}. Sharing again updates it to a new version{t?.id === 'posthog' ? ' (PostHog keeps the old ones)' : ''}. {prev.url && <a href={prev.url} target="_blank" rel="noreferrer">Open</a>}</span>}
          {t?.ok && <button className="primary" disabled={busy || !audience} onClick={() => share(false)}>{busy ? 'Sharing… (about 10s)' : prev ? 'Update shared copy' : 'Share'}</button>}
          {err && <span className="small" style={{ color: 'var(--bad)' }}>{err}</span>}
          {result && (
            <div className="small" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {result.conflict
                ? <><span style={{ color: 'var(--warn)' }}>Someone changed it on the other side since you last shared it.</span><button disabled={busy} onClick={() => share(true)}>Replace their version</button></>
                : result.url && <span>Shared: <a href={result.url} target="_blank" rel="noreferrer">open it</a> · <button className="link small" onClick={() => navigator.clipboard?.writeText(result.url!)}>copy link</button></span>}
              {result.notes.filter(n => !/changed in PostHog/.test(n)).map((n, i) => <span key={i} className="muted">• {n}</span>)}
            </div>
          )}
        </div>
      </Popover>
    </>
  )
}
