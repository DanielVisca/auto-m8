// The model menu: Auto, your favourites, then Claude, OpenAI (Codex, ChatGPT plan) and local models.
// Every model carries a tier so equivalents line up across providers (Frontier ≈ Opus ≈ Astra,
// Workhorse ≈ Sonnet ≈ Sol, Fast ≈ Haiku ≈ Luna). Star a model to pin it to the top; type to filter.
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { Popover } from './Popover'

type UWin = { key: string; label: string; pct: number; resetsAt: number }
type UsageData = { claude: { windows: UWin[] } | null; codex: { windows: UWin[] } | null }
// Codex credits: null unless it matters (plan near its limit, on credits, or running low).
type OLine = { text: string; heat: 'ok' | 'warm' | 'hot'; title: string }
type OverageData = { codex: OLine | null }
const resetHint = (t: number) => {
  const date = new Date(t)
  if (!t || !Number.isFinite(date.getTime())) return 'Reset time unavailable'
  const when = date.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
  const m = Math.ceil((t - Date.now()) / 60000)
  if (m <= 0) return `Reset ${when}`
  const d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60), mins = m % 60
  const left = [d && `${d}d`, h && `${h}h`, mins && `${mins}m`].filter(Boolean).join(' ')
  return `Resets ${when} (in ${left})`
}
const usageHint = (w: UWin) => `${w.label}: ${Math.round(w.pct * 100)}% used\n${resetHint(w.resetsAt)}`
const heat = (p: number) => p >= 0.9 ? 'hot' : p >= 0.7 ? 'warm' : 'ok'
function useUsage(): UsageData | null {
  const [u, setU] = useState<UsageData | null>(null)
  useEffect(() => { const f = () => api.get<UsageData>('/api/provider-usage').then(setU).catch(() => {}); f(); const t = setInterval(f, 45_000); return () => clearInterval(t) }, [])
  return u
}
function useOverage(): OverageData | null {
  const [o, setO] = useState<OverageData | null>(null)
  useEffect(() => { const f = () => api.get<OverageData>('/api/overage').then(setO).catch(() => {}); f(); const t = setInterval(f, 45_000); return () => clearInterval(t) }, [])
  return o
}
const worst = (w?: UWin[]) => (w ?? []).reduce((m, x) => Math.max(m, x.pct), 0)
// Compact usage for a provider: the windows that matter, e.g. "5h 76% · week 57%".
function Usage({ w }: { w?: UWin[] }) {
  if (!w?.length) return null
  return <span className="usage-chips">{w.map(x => <span key={x.key} className={`usage-chip ${heat(x.pct)}`} title={usageHint(x)}>{x.label} {Math.round(x.pct * 100)}%</span>)}</span>
}

type Tier = 'frontier' | 'workhorse' | 'fast'
const TIER: Record<Tier, { label: string; bars: string; hint: string }> = {
  frontier: { label: 'Frontier', bars: '▰▰▰', hint: 'strongest, slowest' },
  workhorse: { label: 'Workhorse', bars: '▰▰▱', hint: 'everyday work, balanced' },
  fast: { label: 'Fast', bars: '▰▱▱', hint: 'quickest, cheapest' },
}
type Item = { value: string; name: string; tier: Tier; group: 'claude' | 'openai' | 'local'; note?: string; off?: string; blurb?: string; isDefault?: boolean }
const GROUPS: { id: Item['group']; label: string }[] = [{ id: 'claude', label: 'Claude' }, { id: 'openai', label: 'OpenAI · ChatGPT plan' }, { id: 'local', label: 'Local · this Mac' }]
const ORDER: Tier[] = ['frontier', 'workhorse', 'fast']
const FAVS = 'perch.engine.favs'
const readFavs = (): string[] => { try { return JSON.parse(localStorage.getItem(FAVS) ?? '[]') } catch { return [] } }

export function enginesFrom(local: any): Item[] {
  const claude: Item[] = [
    { value: 'claude:fable', name: 'Fable', tier: 'frontier', group: 'claude' },
    { value: 'claude:opus', name: 'Opus', tier: 'frontier', group: 'claude' },
    { value: 'claude:sonnet', name: 'Sonnet', tier: 'workhorse', group: 'claude' },
    { value: 'claude:haiku', name: 'Haiku', tier: 'fast', group: 'claude' },
  ]
  const cx = local?.codex
  const off = cx && !cx.ok ? String(cx.why) : undefined
  const models: any[] = cx?.models ?? []
  const openai: Item[] = [
    ...(cx?.default ? [] : [{ value: 'codex', name: 'Codex', tier: 'workhorse' as Tier, group: 'openai' as const, off }]),
    ...models.map(m => ({ value: m.slug === cx.default ? 'codex' : `codex:${m.slug}`, name: m.name, tier: m.tier as Tier, group: 'openai' as const, off, blurb: m.blurb, isDefault: m.slug === cx.default })),
  ]
  const loc: Item[] = (local?.running ? local.models ?? [] : []).map((m: any) => {
    const b = (m.params ?? '').match(/([\d.]+)\s*B/i)
    return { value: m.name, name: String(m.name).replace(/:latest$/, '').replace(/:cloud$/, ''), tier: (b && Number(b[1]) >= 30 ? 'workhorse' : 'fast') as Tier, group: 'local' as const, note: m.name.endsWith(':cloud') ? 'Ollama cloud' : m.fits ? undefined : 'too big for this Mac' }
  })
  return [...claude, ...openai, ...loc]
}

export function EnginePicker({ value, onChange, local, title, className }: { value: string; onChange: (v: string) => void; local: any; title?: string; className?: string }) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const [favs, setFavs] = useState<string[]>(readFavs)
  const usage = useUsage()
  const overage = useOverage()
  const groupOverage = (g: string) => g === 'openai' ? overage?.codex : null
  const groupUsage = (g: string) => g === 'claude' ? usage?.claude?.windows : g === 'openai' ? usage?.codex?.windows : undefined
  const items = useMemo(() => enginesFrom(local), [local])
  const byValue = (v: string) => items.find(i => i.value === v)
  const toggle = (v: string) => setFavs(f => { const n = f.includes(v) ? f.filter(x => x !== v) : [...f, v]; try { localStorage.setItem(FAVS, JSON.stringify(n)) } catch {} return n })
  const match = (i: Item) => !q || `${i.name} ${TIER[i.tier].label} ${i.group} ${i.note ?? ''}`.toLowerCase().includes(q.toLowerCase())
  // Rows in display order: Auto, favourites, then each provider with its models strongest first.
  const rows = useMemo(() => {
    const r: ({ kind: 'head'; label: string; group?: string } | { kind: 'auto' } | { kind: 'item'; item: Item; fav: boolean })[] = []
    if (!q || 'auto'.includes(q.toLowerCase())) r.push({ kind: 'auto' })
    const fav = favs.map(byValue).filter((i): i is Item => !!i && match(i))
    if (fav.length) { r.push({ kind: 'head', label: '★ Favourites' }); fav.forEach(item => r.push({ kind: 'item', item, fav: true })) }
    for (const g of GROUPS) {
      const list = items.filter(i => i.group === g.id && match(i)).sort((a, b) => ORDER.indexOf(a.tier) - ORDER.indexOf(b.tier))
      if (list.length) { r.push({ kind: 'head', label: g.label, group: g.id }); list.forEach(item => r.push({ kind: 'item', item, fav: favs.includes(item.value) })) }
    }
    return r
  }, [items, favs, q]) // eslint-disable-line
  const pickable = rows.flatMap((r, i) => r.kind === 'auto' || (r.kind === 'item' && !r.item.off) ? [i] : [])
  const choose = (v: string) => { onChange(v); setOpen(false); setQ('') }
  const pickRow = (i: number) => { const r = rows[i]; if (r?.kind === 'auto') choose('auto'); else if (r?.kind === 'item' && !r.item.off) choose(r.item.value) }
  useEffect(() => { setAt(pickable[0] ?? 0) }, [q, open]) // eslint-disable-line
  const cur = value === 'auto' || !value ? null : byValue(value)
  const label = cur ? cur.name : value === 'auto' || !value ? 'Auto' : value.replace(/^codex:?/, 'Codex ').trim() || 'Codex'
  // A dot on the button only when the provider(s) this chat uses is getting close: amber from 70%, red from 90%.
  const near = (name: string, w?: UWin[]) => { const top = (w ?? []).slice().sort((a, b) => b.pct - a.pct)[0]; return top && top.pct >= 0.7 ? { p: top.pct, t: `${name} ${usageHint(top)}` } : null }
  const provs = cur ? (cur.group === 'claude' ? [near('Claude', usage?.claude?.windows)] : cur.group === 'openai' ? [near('Codex', usage?.codex?.windows)] : []) : value === 'codex' || value.startsWith('codex:') ? [near('Codex', usage?.codex?.windows)] : [near('Claude', usage?.claude?.windows), near('Codex', usage?.codex?.windows)]
  const hotOne = provs.filter(Boolean).sort((a, b) => b!.p - a!.p)[0]
  const dot = hotOne ? { p: hotOne.p, t: provs.filter(Boolean).map(x => x!.t).join('\n\n') } : null
  const onKey = (e: React.KeyboardEvent) => {
    const k = pickable.indexOf(at)
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt(pickable[Math.min(pickable.length - 1, k + 1)] ?? at) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt(pickable[Math.max(0, k - 1)] ?? at) }
    else if (e.key === 'Enter') { e.preventDefault(); pickRow(at) }
  }
  return (
    <>
      <button ref={ref} type="button" className={`engine-pick ${className ?? ''}`} title={title} onClick={() => setOpen(o => !o)}>
        {cur && <span className={`tier-bars t-${cur.tier}`}>{TIER[cur.tier].bars}</span>}{label}{dot && <span className={`usage-dot ${heat(dot.p)}`} title={dot.t} />} ▾
      </button>
      <Popover anchor={ref} open={open} onClose={() => { setOpen(false); setQ('') }} align="start" width={290}>
        <div className="engine-menu" onKeyDown={onKey}>
          <input autoFocus className="engine-q" placeholder="Type to filter…" value={q} onChange={e => setQ(e.target.value)} />
          {rows.map((r, i) => r.kind === 'head' ? <div key={`h${i}`}><div className="engine-head"><span>{r.label}</span>{r.group && <Usage w={groupUsage(r.group)} />}</div>{r.group && (o => o && <div className={`engine-overage ${o.heat}`} title={o.title}>{o.text}</div>)(groupOverage(r.group))}</div>
            : r.kind === 'auto' ? (
              <div key="auto" className={`engine-row${at === i ? ' hot' : ''}${!value || value === 'auto' ? ' on' : ''}`} onMouseEnter={() => setAt(i)} onClick={() => pickRow(i)}>
                <span className="engine-name">Auto</span><span className="muted small">picks per message · Claude and Codex cover for each other</span>
              </div>
            ) : (
              <div key={`item-${i}-${r.item.value}`} className={`engine-row${at === i ? ' hot' : ''}${value === r.item.value ? ' on' : ''}${r.item.off ? ' off' : ''}`} title={r.item.off ?? `${TIER[r.item.tier].label}: ${r.item.blurb || TIER[r.item.tier].hint}${r.item.isDefault ? ' (your Codex default)' : ''}`}
                onMouseEnter={() => setAt(i)} onClick={() => pickRow(i)}>
                <span className={`tier-bars t-${r.item.tier}`} title={TIER[r.item.tier].label}>{TIER[r.item.tier].bars}</span>
                <span className="engine-name">{r.item.name}</span>
                <span className="muted small engine-note">{r.item.off ?? r.item.note ?? TIER[r.item.tier].label}</span>
                {r.item.isDefault && <span className="engine-default" title="Your default in the Codex app">default</span>}
                <button type="button" className={`engine-star${r.fav ? ' on' : ''}`} title={r.fav ? 'Unpin' : 'Pin to favourites'} onClick={e => { e.stopPropagation(); toggle(r.item.value) }}>{r.fav ? '★' : '☆'}</button>
              </div>
            ))}
          {rows.length === 0 && <div className="muted small" style={{ padding: 8 }}>No model matches.</div>}
          <div className="engine-legend muted small">▰▰▰ Frontier ≈ Opus ≈ Astra · ▰▰▱ Workhorse ≈ Sonnet ≈ Sol · ▰▱▱ Fast ≈ Haiku ≈ Luna</div>
        </div>
      </Popover>
    </>
  )
}
