// Settings → Kits (docs/kits.md): import someone's skills, routines and CLAUDE.md snippet, or start clean.
// Preview first: every item shows what importing does. Routines arrive switched off.
import { useState } from 'react'
import { ago, api, post, useLive } from './api'

type Item = { kind: string; name: string; action: 'add' | 'update' | 'keep-yours' | 'unchanged'; note?: string; preview?: string }
type Preview = { manifest: { name: string; version: string; description: string; author?: string }; items: Item[] }
const VERB: Record<Item['action'], string> = { add: 'adds', update: 'updates', 'keep-yours': 'keeps yours', unchanged: 'already here' }

export function Kits() {
  const { data, reload } = useLive<{ kits: { kit: string; version: string; items: number; installed_at: number }[] }>('/api/kits', ['autopilot'])
  const [src, setSrc] = useState('')
  const [pv, setPv] = useState<Preview | null>(null)
  const [skip, setSkip] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState('')
  const [done, setDone] = useState('')
  const key = (i: Item) => `${i.kind}:${i.name}`

  const preview = async () => {
    setBusy('preview'); setDone(''); setPv(null); setSkip(new Set())
    try { const r = await post<Preview & { error?: string }>('/api/kits/preview', { src: src.trim() }); if (!r.error) setPv(r) } finally { setBusy('') }
  }
  const doImport = async () => {
    if (!pv) return
    setBusy('import')
    try {
      const only = pv.items.filter(i => (i.action === 'add' || i.action === 'update') && !skip.has(key(i))).map(key)
      const r = await post<Preview & { error?: string }>('/api/kits/import', { src: src.trim(), only })
      if (!r.error) { setDone(`Imported ${only.length} item(s) from ${pv.manifest.name}. Routines are switched off: turn them on in Automations.`); setPv(null); reload() }
    } finally { setBusy('') }
  }
  const remove = async (kit: string) => {
    const r = await api.send<{ removed: string[]; kept: string[] }>('DELETE', `/api/kits/${encodeURIComponent(kit)}`)
    setDone(`Removed ${r.removed?.length ?? 0} item(s) from ${kit}.${r.kept?.length ? ` Kept ${r.kept.join(', ')} (you edited them).` : ''}`); reload()
  }
  const changes = pv?.items.filter(i => i.action === 'add' || i.action === 'update') ?? []

  return (
    <section className="card">
      <h3>Kits</h3>
      <div className="muted small">Start clean, or import someone's skills, routines and Claude instructions. Their name and folders are swapped for yours, routines arrive switched off, and nothing you've changed is overwritten.</div>
      {data?.kits.map(k => (
        <div key={k.kit} className="line">
          <span className="line-label">{k.kit}</span>
          <span className="grow muted small">{k.version} · {k.items} items · imported {ago(k.installed_at)} ago</span>
          <button onClick={() => remove(k.kit)}>Remove</button>
        </div>
      ))}
      <div className="line">
        <input className="grow" value={src} placeholder="Git URL or folder of a kit" onChange={e => setSrc(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && src.trim()) preview() }} />
        <button disabled={!src.trim() || !!busy} onClick={preview}>{busy === 'preview' ? 'Reading…' : 'Preview'}</button>
      </div>
      {done && <div className="small ok-text">{done}</div>}
      {pv && <>
        <div><b>{pv.manifest.name}</b> <span className="muted small">{pv.manifest.version}{pv.manifest.author ? ` · by ${pv.manifest.author}` : ''}</span></div>
        {pv.manifest.description && <div className="muted small">{pv.manifest.description}</div>}
        {pv.items.map(i => {
          const changing = i.action === 'add' || i.action === 'update'
          return (
            <details key={key(i)} className="health-row">
              <summary className="row-flex">
                <input type="checkbox" disabled={!changing} checked={changing && !skip.has(key(i))} onClick={e => e.stopPropagation()}
                  onChange={e => { const s = new Set(skip); e.target.checked ? s.delete(key(i)) : s.add(key(i)); setSkip(s) }} />
                <span className="badge">{i.kind}</span>
                <span className="grow">{i.name}</span>
                <span className="muted small">{VERB[i.action]}{i.note ? ` · ${i.note}` : ''}</span>
              </summary>
              {i.preview && <pre className="small clamp" style={{ whiteSpace: 'pre-wrap' }}>{i.preview}</pre>}
            </details>
          )
        })}
        <div className="row-flex">
          <button className="primary" disabled={!changes.length || !!busy} onClick={doImport}>
            {busy === 'import' ? 'Importing…' : `Import ${changes.filter(i => !skip.has(key(i))).length} item(s)`}
          </button>
          <button onClick={() => setPv(null)}>Cancel</button>
        </div>
      </>}
    </section>
  )
}
