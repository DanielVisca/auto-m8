// A small Chrome DevTools Protocol client: one browser-level websocket, page sessions multiplexed
// over it (Target.attachToTarget flatten), promise per command, and events by name and session.
import WebSocket from 'ws'

type Handler = (params: any, sessionId?: string) => void

export class CDPError extends Error {
  method: string; code: number
  constructor(method: string, code: number, message: string) { super(`${method}: ${message}`); this.method = method; this.code = code }
}

export class CDP {
  private ws!: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string; timer: ReturnType<typeof setTimeout> }>()
  private handlers = new Map<string, Set<Handler>>()
  closed = false
  onClose = new Set<() => void>()
  // Consecutive command timeouts with no reply in between: a socket can stay open while Chrome stops
  // answering (2026-11-18: every call timed out for over an hour), so browser.ts watches this.
  timeouts = 0
  onTimeout = new Set<(method: string, sessionId?: string) => void>()

  static async connect(url: string, timeoutMs = 10_000) {
    const c = new CDP()
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
      const t = setTimeout(() => { ws.terminate(); reject(new Error(`CDP connect timed out: ${url}`)) }, timeoutMs)
      ws.once('open', () => { clearTimeout(t); resolve() })
      ws.once('error', e => { clearTimeout(t); reject(e) })
      c.ws = ws
    })
    c.ws.on('message', raw => c.onMessage(raw.toString()))
    c.ws.on('close', () => c.shutdown('CDP connection closed'))
    c.ws.on('error', () => {})
    return c
  }

  private onMessage(text: string) {
    let m: any
    try { m = JSON.parse(text) } catch { return }
    if (m.id != null) {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id); clearTimeout(p.timer)
      this.timeouts = 0
      if (m.error) p.reject(new CDPError(p.method, m.error.code, m.error.message))
      else p.resolve(m.result ?? {})
      return
    }
    if (m.method) {
      for (const key of [m.method, '*']) this.handlers.get(key)?.forEach(h => { try { h(key === '*' ? m : m.params, m.sessionId) } catch (e) { console.error('cdp handler', m.method, e) } })
    }
  }

  private shutdown(reason: string) {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)) }
    this.pending.clear()
    this.onClose.forEach(f => { try { f() } catch {} })
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); this.timeouts++
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
        this.onTimeout.forEach(f => { try { f(method, sessionId) } catch {} })
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, method, timer })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  on(event: string, h: Handler) {
    let s = this.handlers.get(event)
    if (!s) this.handlers.set(event, s = new Set())
    s.add(h)
    return () => { s!.delete(h) }
  }

  // Resolves with the first matching event's params, or rejects after the timeout.
  waitFor(event: string, opts: { sessionId?: string; timeoutMs?: number; match?: (p: any) => boolean } = {}) {
    return new Promise<any>((resolve, reject) => {
      const off = this.on(event, (p, sid) => {
        if (opts.sessionId && sid !== opts.sessionId) return
        if (opts.match && !opts.match(p)) return
        off(); clearTimeout(t); resolve(p)
      })
      const t = setTimeout(() => { off(); reject(new Error(`waiting for ${event} timed out`)) }, opts.timeoutMs ?? 15_000)
    })
  }

  close() { try { this.ws.close() } catch {} this.shutdown('closed') }
}
