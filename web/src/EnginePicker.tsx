// The model menu: Auto, your favourites, then one group per connected subscription (Claude Personal,
// Claude Team, OpenAI · ChatGPT Team, ...: server/subscriptions.ts) with its models, then local models.
// Picking a model under a subscription runs the chat on that login. Connect more at the bottom.
// Every model carries a tier so equivalents line up across providers (Frontier ≈ Opus ≈ Astra,
// Workhorse ≈ Sonnet ≈ Sol, Fast ≈ Haiku ≈ Luna). Star a model to pin it to the top; type to filter.
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, post, useLive } from './api'
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
type Item = { value: string; name: string; tier: Tier; group: 'claude' | 'openai' | 'local'; note?: string; off?: string; blurb?: string; isDefault?: boolean; sub?: string }
export type PickedSubs = { claude?: string; openai?: string }
export type SubView = { id: string; provider: 'claude' | 'openai'; label: string; isDefault: boolean; builtin: boolean; status: { ok: boolean; email?: string | null; org?: string | null; plan?: string | null; why?: string } | null; login: { state: string; url?: string; error?: string } | null }
const PROVIDER = { claude: 'Claude', openai: 'OpenAI' }
const planName = (p?: string | null) => !p ? '' : /^(pro|max|team|enterprise|free)$/i.test(p) ? p[0].toUpperCase() + p.slice(1) : p
// One line about who a subscription is: "Pro · you@example.com", or why it can't be used.
export const subDetail = (s: SubView) => s.login?.state === 'waiting' ? 'signing in… finish in your browser' : s.status?.ok ? [planName(s.status.plan), s.status.email, s.status.org && !s.status.email?.length ? s.status.org : ''].filter(Boolean).join(' · ') : s.status ? (s.status.why ?? 'signed out') : 'checking…'
const itemKey = (i: Item) => i.sub ? `${i.value}@${i.sub}` : i.value
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
// The same models once per subscription of their provider: each row runs on that login.
function perSub(items: Item[], subs: SubView[] | undefined): Item[] {
  if (!subs?.length) return items
  return items.flatMap(i => {
    if (i.group === 'local') return [i]
    const mine = subs.filter(s => s.provider === (i.group === 'claude' ? 'claude' : 'openai'))
    return mine.length ? mine.map(s => ({ ...i, sub: s.id, off: i.off ?? (s.status && !s.status.ok ? (s.status.why ?? 'Signed out') : undefined) })) : [i]
  })
}

export function EnginePicker({ value, onChange, local, title, className, subs: picked = {} }: { value: string; onChange: (v: string, sub?: { provider: 'claude' | 'openai'; id: string }) => void; local: any; title?: string; className?: string; subs?: PickedSubs }) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const [favs, setFavs] = useState<string[]>(readFavs)
  const usage = useUsage()
  const overage = useOverage()
  const groupOverage = (g: string) => g === 'openai' ? overage?.codex : null
  const groupUsage = (g: string, sub?: SubView) => sub && !sub.isDefault ? undefined : g === 'claude' ? usage?.claude?.windows : g === 'openai' ? usage?.codex?.windows : undefined
  const { data: subData, reload: reloadSubs } = useLive<{ subs: SubView[] }>('/api/subscriptions', ['subscriptions'], undefined, 120_000)
  const subList = subData?.subs
  const subOf = (id?: string) => subList?.find(s => s.id === id)
  // The subscription a chat uses per provider: its pick, else this profile's own login.
  const activeSub = (p: 'claude' | 'openai') => subOf(picked[p]) ?? subList?.find(s => s.provider === p && s.isDefault) ?? subList?.find(s => s.provider === p)
  const items = useMemo(() => perSub(enginesFrom(local), subList), [local, subList])
  const provOf = (i: Item) => i.group === 'openai' ? 'openai' as const : 'claude' as const
  const byKey = (k: string) => items.find(i => itemKey(i) === k) ?? items.find(i => i.value === k && (!i.sub || i.sub === activeSub(provOf(i))?.id))
  const byValue = (v: string) => items.find(i => i.value === v && (!i.sub || i.sub === activeSub(provOf(i))?.id)) ?? items.find(i => i.value === v)
  const isOn = (i: Item) => value === i.value && (!i.sub || i.sub === activeSub(provOf(i))?.id)
  const multi = (p: 'claude' | 'openai') => (subList ?? []).filter(s => s.provider === p).length > 1
  const toggle = (v: string) => setFavs(f => { const n = f.includes(v) ? f.filter(x => x !== v) : [...f, v]; try { localStorage.setItem(FAVS, JSON.stringify(n)) } catch {} return n })
  const match = (i: Item) => !q || `${i.name} ${TIER[i.tier].label} ${i.group} ${i.note ?? ''} ${subOf(i.sub)?.label ?? ''}`.toLowerCase().includes(q.toLowerCase())
  // Rows in display order: Auto, favourites, then each provider with its models strongest first.
  const rows = useMemo(() => {
    const r: ({ kind: 'head'; label: string; group?: string; sub?: SubView } | { kind: 'auto' } | { kind: 'item'; item: Item; fav: boolean })[] = []
    if (!q || 'auto'.includes(q.toLowerCase())) r.push({ kind: 'auto' })
    const fav = favs.map(byKey).filter((i): i is Item => !!i && match(i))
    if (fav.length) { r.push({ kind: 'head', label: '★ Favourites' }); fav.forEach(item => r.push({ kind: 'item', item, fav: true })) }
    // One group per subscription (signed-in ones first), then local models.
    const groups: { group: Item['group']; sub?: SubView; label: string }[] = []
    for (const g of ['claude', 'openai'] as const) {
      const ss = (subList ?? []).filter(s => s.provider === g).sort((a, b) => Number(!!b.status?.ok) - Number(!!a.status?.ok) || Number(b.isDefault) - Number(a.isDefault))
      if (!ss.length) groups.push({ group: g, label: g === 'claude' ? 'Claude' : 'OpenAI · ChatGPT plan' })
      else for (const s of ss) groups.push({ group: g, sub: s, label: `${PROVIDER[g]} · ${s.label}` })
    }
    groups.push({ group: 'local', label: 'Local · this Mac' })
    for (const g of groups) {
      const list = items.filter(i => i.group === g.group && i.sub === g.sub?.id && match(i)).sort((a, b) => ORDER.indexOf(a.tier) - ORDER.indexOf(b.tier))
      if (list.length || (g.sub && !q)) { r.push({ kind: 'head', label: g.label, group: g.group, sub: g.sub }); list.forEach(item => r.push({ kind: 'item', item, fav: favs.includes(itemKey(item)) })) }
    }
    return r
  }, [items, favs, q, subList]) // eslint-disable-line
  const pickable = rows.flatMap((r, i) => r.kind === 'auto' || (r.kind === 'item' && !r.item.off) ? [i] : [])
  const choose = (v: string, it?: Item) => { onChange(v, it?.sub ? { provider: provOf(it), id: it.sub } : undefined); setOpen(false); setQ('') }
  const pickRow = (i: number) => { const r = rows[i]; if (r?.kind === 'auto') choose('auto'); else if (r?.kind === 'item' && !r.item.off) choose(r.item.value, r.item) }
  useEffect(() => { setAt(pickable[0] ?? 0) }, [q, open]) // eslint-disable-line
  const cur = value === 'auto' || !value ? null : byValue(value)
  const curSub = cur?.sub && multi(provOf(cur)) ? subOf(cur.sub) : undefined
  const label = cur ? `${cur.name}${curSub ? ` · ${curSub.label}` : ''}` : value === 'auto' || !value ? 'Auto' : value.replace(/^codex:?/, 'Codex ').trim() || 'Codex'
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
          {rows.map((r, i) => r.kind === 'head' ? <div key={`h${i}`}><div className="engine-head"><span>{r.label}</span>{r.group && <Usage w={groupUsage(r.group, r.sub)} />}</div>
              {r.sub && <div className={`engine-sub muted small${r.sub.status?.ok ? '' : ' off'}`} title={r.sub.status?.org ? `Organization: ${r.sub.status.org}` : undefined}>
                <span className="grow">{subDetail(r.sub)}</span>
                {!r.sub.status?.ok && r.sub.login?.state !== 'waiting' && r.sub.status && <button type="button" className="link" onClick={async e => { e.stopPropagation(); await post(`/api/subscriptions/${encodeURIComponent(r.sub!.id)}/login`); reloadSubs() }}>Sign in</button>}
              </div>}
              {r.group && (!r.sub || r.sub.isDefault) && (o => o && <div className={`engine-overage ${o.heat}`} title={o.title}>{o.text}</div>)(groupOverage(r.group))}</div>
            : r.kind === 'auto' ? (
              <div key="auto" className={`engine-row${at === i ? ' hot' : ''}${!value || value === 'auto' ? ' on' : ''}`} onMouseEnter={() => setAt(i)} onClick={() => pickRow(i)}>
                <span className="engine-name">Auto</span><span className="muted small">picks per message · Claude and Codex cover for each other</span>
              </div>
            ) : (
              <div key={`item-${i}-${itemKey(r.item)}`} className={`engine-row${at === i ? ' hot' : ''}${isOn(r.item) ? ' on' : ''}${r.item.off ? ' off' : ''}`} title={r.item.off ?? `${TIER[r.item.tier].label}: ${r.item.blurb || TIER[r.item.tier].hint}${r.item.isDefault ? ' (your Codex default)' : ''}`}
                onMouseEnter={() => setAt(i)} onClick={() => pickRow(i)}>
                <span className={`tier-bars t-${r.item.tier}`} title={TIER[r.item.tier].label}>{TIER[r.item.tier].bars}</span>
                <span className="engine-name">{r.item.name}</span>
                <span className="muted small engine-note">{r.item.off ?? r.item.note ?? TIER[r.item.tier].label}</span>
                {r.item.isDefault && <span className="engine-default" title="Your default in the Codex app">default</span>}
                <button type="button" className={`engine-star${r.fav ? ' on' : ''}`} title={r.fav ? 'Unpin' : 'Pin to favourites'} onClick={e => { e.stopPropagation(); toggle(itemKey(r.item)) }}>{r.fav ? '★' : '☆'}</button>
              </div>
            ))}
          {rows.length === 0 && <div className="muted small" style={{ padding: 8 }}>No model matches.</div>}
          <ConnectSub onDone={reloadSubs} />
          <div className="engine-legend muted small">▰▰▰ Frontier ≈ Opus ≈ Astra · ▰▰▱ Workhorse ≈ Sonnet ≈ Sol · ▰▱▱ Fast ≈ Haiku ≈ Luna</div>
        </div>
      </Popover>
    </>
  )
}

// Connect another subscription without leaving the menu: name it (Personal, PostHog Team, ...), and
// the CLI's own sign-in opens in the browser. It shows up as its own group once you approve there.
export function ConnectSub({ onDone }: { onDone?: () => void }) {
  const [provider, setProvider] = useState<'claude' | 'openai' | null>(null)
  const [label, setLabel] = useState('')
  const [err, setErr] = useState('')
  const connect = async () => {
    setErr('')
    const r: any = await post('/api/subscriptions', { provider, label })
    if (r?.error || r?.login?.error) { setErr(r.error ?? r.login.error); return }
    setProvider(null); setLabel(''); onDone?.()
  }
  if (!provider) return (
    <div className="engine-connect small" onClick={e => e.stopPropagation()}>
      <span className="muted">Connect a subscription:</span>
      <button type="button" className="link" onClick={() => setProvider('claude')}>+ Claude</button>
      <button type="button" className="link" onClick={() => setProvider('openai')}>+ OpenAI</button>
    </div>
  )
  return (
    <div className="engine-connect small" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
      <input autoFocus className="grow" placeholder={provider === 'claude' ? 'Name it, e.g. PostHog Team' : 'Name it, e.g. ChatGPT Team'} value={label} onChange={e => setLabel(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && label.trim()) connect(); if (e.key === 'Escape') setProvider(null) }} />
      <button type="button" disabled={!label.trim()} onClick={connect}>Sign in to {PROVIDER[provider]}</button>
      <button type="button" className="link" onClick={() => setProvider(null)}>cancel</button>
      {err && <div className="bad small" style={{ width: '100%' }}>{err}</div>}
    </div>
  )
}
