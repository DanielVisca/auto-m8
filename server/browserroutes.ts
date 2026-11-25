// HTTP and websocket endpoints for the agent browser: the tool (forwarded from the MCP process),
// approvals, takeover, and the live view stream.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebSocket } from 'ws'
import { createReadStream, statSync } from 'node:fs'
import * as B from './browser.ts'
import * as R from './browserrec.ts' // importing it installs the recorder hooks
import { browserTool } from './browsertool.ts'
import * as O from './overlay.ts'

type Handler = (m: RegExpMatchArray, req: IncomingMessage, res: ServerResponse, q: URLSearchParams) => any
type Route = (method: string, path: string, h: Handler) => void
type Body = (req: IncomingMessage) => Promise<any>

export function browserRoutes(route: Route, body: Body) {
  route('GET', '/api/browser', () => B.browserStatus())
  route('POST', '/api/browser/tool', async (_m, req) => {
    const b = await body(req)
    try { return await browserTool(String(b.owner ?? ''), b.args ?? {}) } catch (e: any) { return { text: `Browser error: ${e.message}`, error: true } }
  })
  route('POST', '/api/browser/start', async () => { await B.ensureBrowser(); return B.browserStatus() })
  route('POST', '/api/browser/approvals/:id', async (m, req) => { const b = await body(req); return B.answerApproval(m[1], !!b.ok, !!b.always) })
  route('POST', '/api/browser/:owner/pause', async (m, req) => B.setPaused(decodeURIComponent(m[1]), !!(await body(req)).paused))
  route('POST', '/api/browser/:owner/fit', async (m, req) => { const b = await body(req); return B.fitViewport(decodeURIComponent(m[1]), typeof b.ratio === 'number' && isFinite(b.ratio) ? b.ratio : null, typeof b.width === 'number' && isFinite(b.width) ? b.width : undefined) })
  route('POST', '/api/browser/:owner/show',async m => { await B.showWindow(decodeURIComponent(m[1])); return { ok: true } })
  route('POST', '/api/browser/:owner/open', async (m, req) => { const b = await body(req); const s = (await B.session(decodeURIComponent(m[1])))!; if (b.url) await B.navigate(s, String(b.url)); return { ok: true, url: s.url } })
  route('DELETE', '/api/browser/:owner', async m => { await B.closeSession(decodeURIComponent(m[1])); return { ok: true } })
  // The product overlay: PostHog usage, errors and latency drawn on the page (overlay.ts).
  route('GET', '/api/browser/:owner/overlay', m => O.overlayState(decodeURIComponent(m[1])))
  route('POST', '/api/browser/:owner/overlay', async (m, req) => {
    const b = await body(req), owner = decodeURIComponent(m[1])
    try { return b.on === false ? await O.stop(owner) : await O.start(owner, { mode: b.mode, host: b.host, project: b.project ? Number(b.project) : undefined, cohort: b.cohort === 'new' || b.cohort === 'all' ? b.cohort : undefined }) } catch (e: any) { return { ...O.overlayState(owner), error: e.message } }
  })
  route('GET', '/api/browser/paths', (_m, _r, _s, q) => ({ paths: q.get('host') ? B.pathsFor(q.get('host')!) : [], notes: q.get('host') ? B.notesFor(q.get('host')!) : '' }))
  recordingRoutes(route)
}

// ---------- recordings (browserrec.ts) ----------
// GET /api/browser/recordings                    list, newest first
// GET /api/browser/recordings/:id/replay         self-contained rrweb-player page with the action log beside it
// GET /api/browser/recordings/:id/:file          actions.jsonl, network.jsonl, meta.json, path.json, video*.webm,
//                                                rrweb.jsonl.gz (sent decompressed, as one JSON array)
function recordingRoutes(route: Route) {
  route('GET', '/api/browser/recordings', () => ({ recordings: R.listRecordings() }))
  route('GET', '/api/browser/recordings/:id/replay', (m, _req, res) => {
    const html = R.replayHtml(decodeURIComponent(m[1]))
    if (!html) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no such recording'); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(html)
  })
  route('GET', '/api/browser/recordings/:id/:file', (m, req, res) => {
    const f = R.recordingFile(decodeURIComponent(m[1]), decodeURIComponent(m[2]))
    if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return }
    if (f.body != null) { res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'no-store' }); res.end(f.body); return }
    // video: honour Range so <video> can seek
    const size = statSync(f.path!).size
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
      const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1
      if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return }
      res.writeHead(206, { 'Content-Type': f.type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
      createReadStream(f.path!, { start, end }).pipe(res)
      return
    }
    res.writeHead(200, { 'Content-Type': f.type, 'Accept-Ranges': 'bytes', 'Content-Length': size })
    createReadStream(f.path!).pipe(res)
  })
}

// /ws/browser/:owner — server sends {t:'frame', d:<jpeg b64>, m:<metadata>} and {t:'state', ...};
// client sends input events {t:'input', ev:{type, x, y, ...}} in CSS px, and {t:'pause', paused}.
export async function browserSocket(owner: string, ws: WebSocket) {
  const state = () => { const s = B.sessions.get(owner); ws.send(JSON.stringify({ t: 'state', url: s?.url ?? '', title: s?.title ?? '', paused: s?.paused ?? false, approvals: [...B.approvals.values()].filter(a => a.owner === owner && a.state === 'pending') })) }
  let stop: (() => Promise<void>) | null = null
  try {
    stop = await B.watchFrames(owner, (d, m) => { if (ws.readyState === 1 && ws.bufferedAmount < 2_000_000) ws.send(JSON.stringify({ t: 'frame', d, m })) })
  } catch (e: any) { ws.send(JSON.stringify({ t: 'error', error: e.message })); ws.close(4404, 'no browser window'); return }
  state()
  ws.send(JSON.stringify({ t: 'feed', items: B.feedFor(owner) }))
  const onFeed = (o: string, item: B.FeedItem) => { if (o === owner && ws.readyState === 1) ws.send(JSON.stringify({ t: 'feed', items: [item] })) }
  B.feedListeners.add(onFeed)
  const onChange = () => { if (ws.readyState === 1) state() }
  B.onBrowserChange.add(onChange)
  ws.on('message', async raw => {
    try {
      const m = JSON.parse(raw.toString())
      if (m.t === 'input') await B.userInput(owner, m.ev)
      else if (m.t === 'pause') B.setPaused(owner, !!m.paused)
    } catch (e: any) { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'error', error: e.message })) }
  })
  ws.on('close', () => { B.onBrowserChange.delete(onChange); B.feedListeners.delete(onFeed); stop?.() })
}
