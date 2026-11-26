// Share a board somewhere other people can open it (server/share.ts). auto-m8 stays the source:
// sharing publishes a translated copy, and sharing again updates it. Who can see it, its version
// history and viewers' state belong to the platform it goes to.
import { useEffect, useRef, useState } from 'react'
import { ago, api, post, toast } from './api'
import { Popover } from './Popover'

type Target = { id: string; label: string; about: string; ok: boolean; why?: string }
type Audience = { id: string; label: string; kind?: 'private' | 'project' | 'members'; hint?: string; group?: string; private?: boolean }
type Share = { target: string; url: string | null; audience: string | null; audience_label: string | null; shared_at: number; notes: string[]; conflict?: boolean }

export function ShareButton({ boardId, compact }: { boardId: string; compact?: boolean }) {
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
    setResult(r); loadShares(); window.dispatchEvent(new Event('board-shared'))
    if (!r.conflict && r.url) { navigator.clipboard?.writeText(r.url).catch(() => {}); toast('Shared. Link copied.', { kind: 'ok' }) }
  }
  const chosen = audiences?.find(a => a.id === audience)
  return (
    <>
      {compact
        ? <button ref={btn} className={`icon ${shares.length ? 'on' : ''}`} onClick={() => setOpen(o => !o)} title={shares.length ? 'Shared' : 'Share'} aria-label="Share">⇪</button>
        : <button ref={btn} onClick={() => setOpen(o => !o)} title="Share this board so others can open it">{shares.length ? '⇪ Shared' : '⇪ Share'}</button>}
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
                  return list.length ? <optgroup key={k} label={list[0].group ?? k}>{list.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}</optgroup> : null
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

// Where this board is shared, in the board's header: a link to each shared copy, a note when the
// local board has changes the copy doesn't, and (like Drive's viewer avatars) little bubbles of
// who opened it in the last 30 days, with a green ring for anyone on it in the last 5 minutes.
type Viewer = { name: string; email: string | null; last: number; views: number; now: boolean }
type Status = Share & { board_id: string; label: string; local_changes: boolean; remote_changed: boolean; viewers: Viewer[] | null; views: number | null }

const shortAudience = (label: string | null) => !label ? '' : /filed in (#[\w-]+)/.exec(label)?.[1] ?? (label.startsWith('Only me') ? 'only me' : label.replace(/^Members of /, ''))
const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
const initials = (n: string) => n.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?'

export function ShareStatus({ boardId }: { boardId: string }) {
  const [list, setList] = useState<Status[]>([])
  const [busy, setBusy] = useState(false)
  const load = (fresh = false) => api.get<{ shares: Status[] }>(`/api/boards/${encodeURIComponent(boardId)}/share-status${fresh ? '?fresh=1' : ''}`).then(r => setList(r.shares ?? [])).catch(() => {})
  useEffect(() => {
    load()
    const t = setInterval(() => { if (document.visibilityState === 'visible') load() }, 60_000)
    const shared = () => load(true)
    window.addEventListener('board-shared', shared)
    return () => { clearInterval(t); window.removeEventListener('board-shared', shared) }
  }, [boardId]) // eslint-disable-line
  if (!list.length) return null
  const update = async (s: Status, overwrite = false) => {
    setBusy(true)
    const r = await post<any>(`/api/boards/${encodeURIComponent(boardId)}/share`, { target: s.target, audience: s.audience, overwrite }).catch(e => ({ error: String(e.message ?? e) }))
    setBusy(false)
    if (r.error) toast(r.error)
    else if (r.conflict) toast('It was edited in PostHog since you shared it. Use Replace to overwrite (PostHog keeps that version).')
    else toast('Shared copy updated.', { kind: 'ok' })
    load(true)
  }
  return (
    <>
      {list.map(s => (
        <span key={s.target} className="row-flex small share-status" style={{ gap: 6, alignItems: 'center' }}>
          <a href={s.url ?? undefined} target="_blank" rel="noreferrer" title={`${s.label}: ${s.audience_label ?? ''}. Shared ${ago(s.shared_at)}.`} className="muted">⇪ {s.target === 'posthog' ? 'PostHog' : s.label} · {shortAudience(s.audience_label)}</a>
          {s.local_changes && <button className="link small" disabled={busy} onClick={() => update(s)} title="This board has changed since you shared it. Publish the changes as a new version.">● local changes · {busy ? 'updating…' : 'update'}</button>}
          {s.remote_changed && <button className="link small" disabled={busy} style={{ color: 'var(--warn)' }} onClick={() => confirm('Replace the version edited in PostHog with this board? PostHog keeps the old version in its history.') && update(s, true)} title="Someone changed the shared copy in PostHog since you last shared it">edited in PostHog · replace</button>}
          {!!s.viewers?.length && (
            <span className="row-flex" style={{ gap: 0, alignItems: 'center' }} title={`${s.viewers.length} ${s.viewers.length === 1 ? 'person' : 'people'} opened it in the last 30 days`}>
              {s.viewers.slice(0, 4).map((v, i) => (
                <span key={v.email ?? v.name} title={`${v.name}${v.now ? ' · viewing now' : ` · viewed ${ago(v.last)}`}${v.views > 1 ? ` · ${v.views} visits` : ''}`}
                  style={{ width: 20, height: 20, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 600, color: '#fff', background: `hsl(${hue(v.email ?? v.name)} 45% 45%)`, marginLeft: i ? -5 : 0, boxShadow: v.now ? '0 0 0 2px var(--ok)' : '0 0 0 2px var(--bg)' }}>{initials(v.name)}</span>
              ))}
              {s.viewers.length > 4 && <span className="muted" style={{ marginLeft: 4 }}>+{s.viewers.length - 4}</span>}
            </span>
          )}
        </span>
      ))}
    </>
  )
}
