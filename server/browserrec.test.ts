// Recordings for the agent browser against a local fixture and headless Chrome: rrweb DOM events with
// masked inputs, the stitched video, network.jsonl and meta.json; nothing visual when recording is off;
// the API helpers; size-capped pruning; and the per-step cost of recording.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const skip = !existsSync(CHROME) ? 'Chrome not installed' : false
const profile = mkdtempSync(join(tmpdir(), 'perch-rec-chrome-'))
process.env.PERCH_AGENT_CHROME_DIR = profile
process.env.PERCH_BROWSER_HEADLESS = '1'
process.env.PERCH_BROWSER_REC_DIR = join(profile, '..', `${profile.split('/').pop()}-rec`)

const B = await import('./browser.ts')
const R = await import('./browserrec.ts')
const { settings } = await import('./settings.ts')

const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`
const FORM = page('Order', `
  <h1>Pizza order</h1>
  <form method="post" action="/post">
    <label>Customer name <input name="custname"></label>
    <label>Password <input name="pw" type="password"></label>
    <label>Card number <input name="cardnumber" autocomplete="cc-number"></label>
    <label><input type="radio" name="size" value="small"> Small</label>
    <label><input type="radio" name="size" value="medium"> Medium</label>
    <button type="button" onclick="fetch('/api/ping').then(r => r.json()).then(j => document.getElementById('out').textContent = j.pong)">Ping</button>
    <div id="out"></div>
  </form>`)

let server: Server, base = ''
before(async () => {
  if (skip) return
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x')
    if (url.pathname === '/form') return res.end(FORM)
    if (url.pathname === '/api/ping') { res.setHeader('content-type', 'application/json'); res.setHeader('set-cookie', 'secret=abc'); return res.end(JSON.stringify({ pong: 'pong!' })) }
    res.end(page('Home', '<h1>Home</h1><a href="/form">Order a pizza</a>'))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as any).port}`
  settings.browser.sites = { '127.0.0.1': 'trusted' }
  settings.browser.defaultPolicy = 'allow'
})
after(async () => {
  if (skip) return
  await B.quitBrowser()
  server.close()
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  rmSync(process.env.PERCH_BROWSER_REC_DIR!, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const lines = (f: string) => existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const FILL = [
  { do: 'fill' as const, name: 'Customer name', value: 'Visible Secretname' },
  { do: 'fill' as const, name: 'Password', value: 'hunter2hunter2' },
  { do: 'fill' as const, name: 'Card number', value: '4242424242424242' },
  { do: 'click' as const, role: 'radio', name: 'Medium' },
  { do: 'click' as const, role: 'button', name: 'Ping' },
]

test('recording on: rrweb events with masked inputs, video, network and meta', { skip }, async () => {
  settings.browser.recordVisual = true
  const s = (await B.session('rec-on'))!
  await B.navigate(s, base + '/form')
  B.beginGoal(s, 'fill the pizza form')
  const r = await B.runSteps(s, FILL)
  assert.equal(r.error, false, r.lines.join('\n'))
  assert.ok(R.isRecordingVisual(s))
  await B.finishGoal(s, { ok: true, expect: { text: 'pong!' } })
  await R.flushRecording(s)
  const dir = s.runDir
  await B.closeSession('rec-on')
  await R.recorderIdle()
  settings.browser.recordVisual = false

  const events = R.readEvents(dir)
  assert.ok(events.length > 3, `rrweb events: ${events.length}`)
  assert.ok(events.some(e => e.type === 2), 'a full snapshot')
  assert.ok(events.some(e => e.type === 3 && e.data?.source === 5), 'input events')
  const raw = JSON.stringify(events)
  for (const secret of ['Visible Secretname', 'hunter2hunter2', '4242424242424242']) assert.ok(!raw.includes(secret), `${secret} leaked into rrweb`)
  assert.match(raw, /\*{4,}/, 'masked values')
  assert.match(raw, /pong!/, 'DOM changes after the click are recorded')

  if (R.FFMPEG) {
    assert.ok(existsSync(join(dir, 'video.webm')), 'video.webm')
    assert.ok(readFileSync(join(dir, 'video.webm')).length > 1000)
    assert.ok(!existsSync(join(dir, 'frames')), 'frames removed after stitching')
  }

  const net = lines(join(dir, 'network.jsonl'))
  assert.ok(net.some(n => n.type === 'Document' && n.url.endsWith('/form') && n.status === 200), JSON.stringify(net))
  assert.ok(net.some(n => n.type === 'Fetch' && n.url.endsWith('/api/ping') && n.mime === 'application/json'))
  const netRaw = readFileSync(join(dir, 'network.jsonl'), 'utf8')
  assert.ok(!/secret=abc|cookie|header/i.test(netRaw), 'no headers or cookies')

  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  assert.equal(meta.owner, 'rec-on')
  assert.equal(meta.goal, 'fill the pizza form')
  assert.equal(meta.outcome, 'ok')
  assert.equal(meta.steps, FILL.length)
  assert.ok(meta.end >= meta.start)
  assert.ok(meta.urls.some((u: string) => u.endsWith('/form')))
  assert.ok(!readFileSync(join(dir, 'actions.jsonl'), 'utf8').includes('hunter2'))

  // API helpers
  const id = dir.split('/').pop()!
  const list = R.listRecordings()
  const item = list.find(x => x.id === id)!
  assert.ok(item, 'listed')
  assert.equal(item.hasRrweb, true)
  assert.equal(item.steps, FILL.length)
  assert.ok(item.size > 0)
  const arr = R.recordingFile(id, 'rrweb.jsonl.gz')!
  assert.equal(arr.type, 'application/json')
  assert.equal(JSON.parse(String(arr.body)).length, events.length)
  assert.ok(R.recordingFile(id, 'meta.json'))
  assert.equal(R.recordingFile('..', 'meta.json'), null)
  assert.equal(R.recordingFile(id, '../../etc/passwd'), null)
  assert.equal(R.recordingFile(id, 'frames'), null)
  assert.equal(R.recordingDir('../' + id), null)
  const html = R.replayHtml(id)!
  assert.match(html, /rrwebPlayer/)
  assert.match(html, /fill the pizza form/)
  assert.ok(!html.includes('hunter2'))
})

test('recording off: meta and network only, no rrweb or video', { skip }, async () => {
  settings.browser.recordVisual = false
  const s = (await B.session('rec-off'))!
  await B.navigate(s, base + '/form')
  await B.runSteps(s, FILL)
  assert.ok(!R.isRecordingVisual(s))
  const dir = s.runDir
  await B.closeSession('rec-off')
  await R.recorderIdle()
  assert.ok(!existsSync(join(dir, 'rrweb.jsonl.gz')))
  assert.ok(!existsSync(join(dir, 'video.webm')))
  assert.ok(!existsSync(join(dir, 'frames')))
  assert.ok(existsSync(join(dir, 'meta.json')))
  assert.ok(lines(join(dir, 'network.jsonl')).some(n => n.url.endsWith('/api/ping')))
})

test('mode=visual on open turns recording on for that window only', { skip }, async () => {
  const { browserTool } = await import('./browsertool.ts')
  settings.browser.recordVisual = false
  const o = await browserTool('rec-tool', { action: 'open', url: base + '/form', mode: 'visual' })
  assert.ok(o.image)
  const s = B.sessions.get('rec-tool')!
  await browserTool('rec-tool', { action: 'act', steps: [{ do: 'fill', name: 'Customer name', value: 'Tool Person' }], snapshot: false })
  await R.flushRecording(s)
  assert.ok(R.isRecordingVisual(s))
  const dir = s.runDir
  await browserTool('rec-tool', { action: 'close' })
  await R.recorderIdle()
  const events = R.readEvents(dir)
  assert.ok(events.length > 1)
  assert.ok(!JSON.stringify(events).includes('Tool Person'))
})

test('denied hosts are never recorded', { skip }, async () => {
  settings.browser.recordVisual = true
  const s = (await B.session('rec-deny'))!
  await B.navigate(s, base + '/form')
  settings.browser.sites = { '127.0.0.1': 'deny' }
  await B.runSteps(s, [{ do: 'scroll', dy: 100 }]).catch(() => {})
  await R.flushRecording(s)
  const dir = s.runDir
  const before = R.readEvents(dir).length
  // the page keeps changing, but nothing more is written while the host is denied
  await B.evalIn(s, `document.body.insertAdjacentHTML('beforeend', '<p>denied content</p>')`, { page: true })
  await R.flushRecording(s)
  assert.equal(R.readEvents(dir).length, before)
  assert.ok(!JSON.stringify(R.readEvents(dir)).includes('denied content'))
  settings.browser.sites = { '127.0.0.1': 'trusted' }
  await B.closeSession('rec-deny')
  await R.recorderIdle()
  settings.browser.recordVisual = false
})

test('per-step overhead of recording (on vs off)', { skip }, async () => {
  const N = 8
  const measure = async (on: boolean) => {
    settings.browser.recordVisual = on
    const owner = on ? 'rec-perf-on' : 'rec-perf-off'
    const s = (await B.session(owner))!
    await B.navigate(s, base + '/form')
    await B.runSteps(s, [{ do: 'fill', name: 'Customer name', value: 'warmup' }])
    const t0 = performance.now()
    for (let i = 0; i < N; i++) {
      const r = await B.runSteps(s, [{ do: 'fill', name: 'Customer name', value: `n${i}` }, { do: 'click', role: 'radio', name: i % 2 ? 'Small' : 'Medium' }])
      assert.equal(r.error, false, r.lines.join('\n'))
    }
    const per = (performance.now() - t0) / (N * 2)
    const tc = performance.now()
    await B.closeSession(owner)
    await R.recorderIdle()
    return { per, close: performance.now() - tc }
  }
  const off = await measure(false)
  const on = await measure(true)
  console.log(`recording overhead: ${off.per.toFixed(1)}ms/step off, ${on.per.toFixed(1)}ms/step on (+${(on.per - off.per).toFixed(1)}ms); close+stitch ${off.close.toFixed(0)}ms off, ${on.close.toFixed(0)}ms on`)
  assert.ok(on.per < off.per * 3 + 100, `recording made steps too slow: ${on.per}ms vs ${off.per}ms`)
  settings.browser.recordVisual = false
})

test('pruning caps total size, oldest first, and keeps live windows', () => {
  const root = B.REC_DIR
  mkdirSync(root, { recursive: true })
  const mk = (name: string, bytes: number, ageMs: number) => {
    const d = join(root, name); mkdirSync(d, { recursive: true })
    const f = join(d, 'actions.jsonl'); writeFileSync(f, 'x'.repeat(bytes))
    const t = (Date.now() - ageMs) / 1000
    utimesSync(f, t, t); utimesSync(d, t, t)
    return d
  }
  const old = mk('zz-prune-old', 4000, 3 * 3600_000)
  const mid = mk('zz-prune-mid', 4000, 2 * 3600_000)
  const fresh = mk('zz-prune-new', 4000, 3600_000)
  const ancient = mk('zz-prune-ancient', 10, (settings.browser.recordingDays + 1) * 86_400_000)
  const others = R.listRecordings().filter(r => !r.id.startsWith('zz-prune')).reduce((t, r) => t + r.size, 0)
  B.pruneRecordings(others + 9000)
  assert.ok(!existsSync(ancient), 'past recordingDays')
  assert.ok(!existsSync(old), 'oldest goes first past the cap')
  assert.ok(existsSync(mid) && existsSync(fresh))
})

test('long recordings are thinned to MAX_FRAMES, keeping the first and last frame', async () => {
  const { thinFrames, MAX_FRAMES } = await import('./browserrec.ts')
  const frames = Array.from({ length: 15_830 }, (_, i) => ({ file: `${i}.jpg`, t: i * 100 }))
  const out = thinFrames(frames)
  assert.equal(out.length, MAX_FRAMES)
  assert.equal(out[0], frames[0])
  assert.equal(out.at(-1), frames.at(-1))
  assert.equal(thinFrames(frames.slice(0, 10)).length, 10)
})
