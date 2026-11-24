import { useEffect, useRef, useState } from 'react'
import type { Pressure, ResourceSnapshot } from '../../shared/resources.ts'
import { Popover } from './Popover'
import { ResourcePressureGate } from './resourceStatus'
import './resources.css'

const GiB = 1024 ** 3, MiB = 1024 ** 2
const gb = (bytes: number | null | undefined) => bytes == null ? '—' : `${(bytes / GiB).toFixed(1)} GB`
const memorySize = (bytes: number) => bytes < GiB ? `${Math.round(bytes / MiB)} MB` : gb(bytes)
const pct = (value: number | null) => value === null ? '—' : `${Math.round(value)}%`

export function Resources() {
  const [data, setData] = useState<ResourceSnapshot | null>(null)
  const [level, setLevel] = useState<Pressure>('normal')
  const [delayed, setDelayed] = useState(false)
  const [open, setOpen] = useState(false)
  const [sort, setSort] = useState<'cpu' | 'memory'>('cpu')
  const anchor = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    let stopped = false, busy = false, badSince: number | null = null
    let controller: AbortController | null = null
    const gate = new ResourcePressureGate()
    const poll = async () => {
      if (busy || document.visibilityState === 'hidden') return
      busy = true
      controller = new AbortController()
      const started = performance.now(), timeout = setTimeout(() => controller?.abort(), 4000)
      const slow = () => { badSince ??= Date.now(); if (!stopped) setDelayed(Date.now() - badSince >= 20_000) }
      try {
        const res = await fetch('/api/resources', { signal: controller.signal, cache: 'no-store' })
        if (!res.ok) throw new Error('resources unavailable')
        const sample: ResourceSnapshot = await res.json()
        if (stopped) return
        if (!Number.isFinite(sample?.sampledAt) || !sample.memory || !sample.perch || !Array.isArray(sample.processes) || !Array.isArray(sample.reasons) || Date.now() - sample.sampledAt > 20_000) throw new Error('resource sample unavailable')
        setData(sample)
        setLevel(gate.update(sample.severity, Date.now()))
        if (performance.now() - started >= 3000) slow()
        else { badSince = null; setDelayed(false) }
      } catch { if (!stopped) slow() }
      finally { clearTimeout(timeout); busy = false }
    }
    const visible = () => { if (document.visibilityState === 'visible') { badSince = null; void poll() } }
    void poll()
    const timer = setInterval(() => { void poll() }, 5000)
    document.addEventListener('visibilitychange', visible)
    return () => { stopped = true; clearInterval(timer); controller?.abort(); document.removeEventListener('visibilitychange', visible) }
  }, [])
  const severity = delayed && level === 'normal' ? 'warning' : level
  const strained = severity !== 'normal'
  const label = delayed ? 'auto-m8 responding slowly' : strained ? data?.reasons[0]?.label ?? 'Pressure easing' : ''
  const title = delayed ? 'auto-m8 is slow or reconnecting. Click for the last Mac resource sample.' : data ? `${data.reasons.map(r => r.label).join(' · ') || 'Mac resources look comfortable'} · CPU ${pct(data.cpuPercent)} · ${gb(data.memory.usedBytes)} of ${gb(data.memory.totalBytes)} memory` : 'Mac resources · waiting for a sample'
  const processes = [...data?.processes ?? []].sort((a, b) => sort === 'cpu' ? b.cpuPercent - a.cpuPercent : b.memoryBytes - a.memoryBytes).slice(0, 5)
  return <>
    <button ref={anchor} className={`resource-indicator no-drag ${severity}`} onClick={() => setOpen(!open)} title={title}
      aria-label={strained ? `Mac resources: ${label}` : 'Mac resources'} aria-expanded={open} aria-haspopup="dialog">
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M2 11h3l2-6 4 11 2-7 2 2h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      {strained && <span>{label}</span>}
    </button>
    <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={360}>
      <section className="resource-panel" role="dialog" aria-label="Mac resources">
        <div className="resource-heading"><b>Mac resources</b><span className="grow" /><button className="icon" aria-label="Close resource monitor" onClick={() => setOpen(false)}>×</button></div>
        {delayed && <p className="warn">auto-m8 is slow or reconnecting. {data ? 'Showing the last sample until it responds.' : 'Waiting for a resource sample.'}</p>}
        {data ? <>
          <div className={`resource-summary ${strained ? severity : ''}`}>{delayed ? 'Current Mac pressure is unknown.' : data.reasons.length ? data.reasons.map(r => r.detail).join(' ') : level !== 'normal' ? 'Pressure is easing. The indicator will settle shortly.' : 'No sustained resource pressure detected.'}</div>
          <div className="resource-metrics">
            <div><span>CPU</span><b>{pct(data.cpuPercent)}</b><small>{data.cores} cores · load {data.load.toFixed(1)}</small></div>
            <div><span>Memory</span><b>{gb(data.memory.usedBytes)}</b><small>of {gb(data.memory.totalBytes)} · {data.memory.pressure ?? 'unknown'} pressure</small></div>
            <div><span>Swap</span><b>{gb(data.memory.swapBytes)}</b><small>{data.memory.swapBytesPerSecond === null ? 'measuring activity…' : `${(data.memory.swapBytesPerSecond / MiB).toFixed(1)} MB/s moving`}</small></div>
            <div><span>Disk free</span><b>{gb(data.disk?.availableBytes)}</b><small>{gb(data.memory.compressedBytes)} memory compressed</small></div>
          </div>
          <div className="resource-perch"><b>auto-m8 server</b><span>{memorySize(data.perch.memoryBytes)} · {data.perch.eventLoopDelayMs} ms delay</span></div>
          <div className="resource-heading"><b>Busiest processes</b><span className="grow" /><button className={sort === 'cpu' ? 'on' : ''} onClick={() => setSort('cpu')}>CPU</button><button className={sort === 'memory' ? 'on' : ''} onClick={() => setSort('memory')}>Memory</button></div>
          <table className="resource-processes"><thead><tr><th>Process</th><th>CPU</th><th>Memory</th></tr></thead><tbody>
            {processes.map(p => <tr key={p.pid}><td title={`${p.name} · PID ${p.pid}${p.perch ? ' · auto-m8 or its agents' : ''}`}><span>{p.name}</span>{p.perch && <small>auto-m8</small>}</td><td>{pct(p.cpuPercent)}</td><td>{memorySize(p.memoryBytes)}</td></tr>)}
          </tbody></table>
          {!processes.length && <p className="muted small">Gathering process usage…</p>}
          <p className="muted small">Processes refresh every 15s. CPU is the OS average; 100% is one core. Memory shows resident RAM; local models can also use wired GPU memory.</p>
          {data.unavailable.length > 0 && <p className="muted small">Unavailable: {data.unavailable.join(', ')}.</p>}
          <div className="muted small">Sampled {new Date(data.sampledAt).toLocaleTimeString()} · refreshes every 5s while visible</div>
        </> : !delayed && <p className="muted">Waiting for the Mac’s first sample…</p>}
      </section>
    </Popover>
  </>
}
