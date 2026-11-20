// A PR link drawn as a pill: state dot, title, repo#number, and the robots on it. Used for PR links
// in chat messages instead of the raw URL. Click opens the PR on GitHub.
import { createContext, useEffect, useRef, useState } from 'react'
import type { PrKnown } from './prrefs'
export { bareRefs, knownPrs, linkPrRefs, type PrKnown } from './prrefs'
import { PrAgents } from './Agents'
import { Popover } from './Popover'
import { PrPreviewCard } from './PrPreview'

export const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+(?:[/?#]\S*)?$/
const prBase = (u: string) => u.match(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0] ?? u

export const PrRefs = createContext<PrKnown | null>(null) // the conversation's known PRs, for bare #numbers

// In the desktop app the server opens it (macOS open), since window.open from Electron can go nowhere.
export function openPr(url: string) {
  if (!(window as any).perch?.isElectron) { window.open(url, '_blank'); return }
  fetch('/api/open-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
    .then(r => r.json()).then(d => { if (d?.error) window.open(url, '_blank') }).catch(() => window.open(url, '_blank'))
}

export type Brief = { url: string; title: string; state: 'open' | 'draft' | 'merged' | 'closed'; repo: string; number: number; author?: string }
const briefs = new Map<string, Promise<Brief | null>>()
function brief(url: string) {
  let p = briefs.get(url)
  if (!p) { p = fetch(`/api/pr/brief?url=${encodeURIComponent(url)}`).then(r => r.ok ? r.json() : null).then(d => d?.title ? d : null).catch(() => null); briefs.set(url, p) }
  return p
}

export function PrPill({ url }: { url: string }) {
  const base = prBase(url)
  const [b, setB] = useState<Brief | null | undefined>(undefined)
  useEffect(() => { let live = true; brief(base).then(d => live && setB(d)); return () => { live = false } }, [base])
  const m = base.match(/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/)
  const ref = `${m?.[1] ?? ''}#${m?.[2] ?? ''}`
  const anchor = url !== base ? ' · comment' : ''
  // Hovering for a moment shows the same preview card as the sidebar's PR badges; moving into the card keeps it open.
  const aRef = useRef<HTMLAnchorElement>(null)
  const [hover, setHover] = useState(false)
  const timer = useRef<any>(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const enter = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setHover(true), 450) }
  const leave = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setHover(false), 250) }
  return (
    <>
    <a ref={aRef} className={`pr-inline st-${b?.state ?? 'unknown'}`} href={url} onMouseEnter={enter} onMouseLeave={leave}
      onClick={e => { e.preventDefault(); e.stopPropagation(); openPr(url) }}>
      <span className="pr-inline-dot" />
      <span className="pr-inline-title">{b === undefined ? '…' : b ? b.title : 'pull request'}{anchor}</span>
      <span className="pr-inline-ref">{ref}</span>
      <PrAgents url={base} size={14} />
    </a>
    {hover && (
      <Popover anchor={aRef} open={hover} onClose={() => setHover(false)} width={440}>
        <div onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={leave}><PrPreviewCard url={base} brief={b ?? undefined} /></div>
      </Popover>
    )}
    </>
  )
}
