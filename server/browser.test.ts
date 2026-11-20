// The agent browser end to end against a local fixture site and a real (headless) Chrome:
// launch, windows per conversation, snapshots, steps, confirm gates, cached paths, replay and
// healing, fetch with cookies, the network log, screencast, and re-attaching after a restart.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const skip = !existsSync(CHROME) ? 'Chrome not installed' : false
const profile = mkdtempSync(join(tmpdir(), 'perch-agent-chrome-'))
process.env.PERCH_AGENT_CHROME_DIR = profile
process.env.PERCH_BROWSER_HEADLESS = '1'
process.env.PERCH_BROWSER_REC_DIR = join(profile, '..', `${profile.split('/').pop()}-rec`)

const B = await import('./browser.ts')
const S = await import('./settings.ts') // live binding: updateSettings swaps the object

const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`
const FORM = page('Order', `
  <h1>Pizza order</h1>
  <form method="post" action="/post">
    <label>Customer name <input name="custname"></label>
    <label>Telephone <input name="custtel" type="tel"></label>
    <label>Password <input name="pw" type="password"></label>
    <fieldset><legend>Size</legend>
      <label><input type="radio" name="size" value="small"> Small</label>
      <label><input type="radio" name="size" value="medium"> Medium</label>
    </fieldset>
    <label><input type="checkbox" name="topping" value="bacon"> Bacon</label>
    <label>Delivery <select name="when"><option>Now</option><option>Later</option></select></label>
    <button>Submit order</button>
  </form>`)
const SPA = (v: string) => page('Items', `
  <h1>Items</h1>
  <button onclick="load()">${v === '2' ? 'Show all details' : 'Show details'}</button>
  <button>Delete everything</button>
  <ul id="list"></ul>
  <div id="stars"><a href="#" aria-label="Star (40.8k)">★</a></div>
  <script>async function load(){ const r = await fetch('/api/items'); const j = await r.json(); document.getElementById('list').innerHTML = j.items.map(i => '<li>'+i+'</li>').join('') }</script>`)

let server: Server, base = ''
before(async () => {
  if (skip) return
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x')
    if (url.pathname === '/form') return res.end(FORM)
    if (url.pathname === '/spa') return res.end(SPA(url.searchParams.get('v') ?? '1'))
    if (url.pathname === '/api/items') { await new Promise(r => setTimeout(r, 120)); res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ items: ['alpha', 'beta', 'gamma'] })) }
    if (url.pathname === '/setcookie') { res.setHeader('set-cookie', 'who=ana; Path=/'); return res.end(page('ok', 'cookie set')) }
    if (url.pathname === '/whoami') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ cookie: req.headers.cookie ?? '' })) }
    if (url.pathname === '/post' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ form: Object.fromEntries(new URLSearchParams(body)) }))
    }
    res.end(page('Home', '<h1>Home</h1><a href="/form">Order a pizza</a> <a href="/spa">Items</a>'))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as any).port}`
  S.settings.browser.sites = {}
  S.settings.browser.defaultPolicy = 'allow'
  S.settings.browser.maxSessions = 30
})
after(async () => {
  if (skip) return
  await B.quitBrowser()
  server.close()
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  rmSync(process.env.PERCH_BROWSER_REC_DIR!, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('policy and irreversible classification', () => {
  S.settings.browser.sites = { 'bank.com': 'read', '*.evil.com': 'deny', 'github.com': 'trusted' }
  assert.equal(B.policyFor('https://www.bank.com/x'), 'read')
  assert.equal(B.policyFor('https://a.b.evil.com/'), 'deny')
  assert.equal(B.policyFor('https://github.com/PostHog'), 'trusted')
  assert.equal(B.policyFor('https://example.org/'), 'allow')
  assert.equal(B.policyFor('about:blank'), 'allow')
  S.settings.browser.sites = {}
  assert.ok(B.isIrreversible({ role: 'button', name: 'Send' }))
  assert.ok(B.isIrreversible({ role: 'button', name: 'Submit order' }))
  assert.ok(B.isIrreversible({ role: 'button', name: 'Delete everything' }))
  assert.ok(B.isIrreversible({ role: 'button', name: 'Merge pull request' }))
  assert.ok(!B.isIrreversible({ role: 'button', name: 'Show details' }))
  assert.ok(!B.isIrreversible({ role: 'textbox', name: 'Send to' }))
  assert.ok(!B.isIrreversible({ role: 'link', name: 'Sender settings' }))
})

test('launch, open a window, snapshot with refs', { skip }, async () => {
  const s = (await B.session('conv-a'))!
  await B.navigate(s, base + '/form')
  const snap = await B.snapshot(s)
  assert.match(snap.text, /^Order — http/)
  assert.match(snap.text, /\[e\d+\] textbox "Customer name"/)
  assert.match(snap.text, /\[e\d+\] radio "Medium" checked=false/)
  assert.match(snap.text, /\[e\d+\] combobox "Delivery" .*options=\[\*Now \| Later\]/)
  assert.match(snap.text, /\[e\d+\] button "Submit order"/)
  assert.match(snap.text, /# Pizza order/)
  // refs are stable across snapshots of the same document
  const again = await B.snapshot(s)
  assert.equal(snap.text, again.text)
  const found = await B.snapshot(s, { find: 'medium' })
  assert.equal(found.text.split('\n').length, 2)
})

test('steps by name: fill, check, select; irreversible submit is held until approved', { skip }, async () => {
  const s = (await B.session('conv-a'))!
  await B.navigate(s, base + '/form')
  const r = await B.runSteps(s, [
    { do: 'fill', role: 'textbox', name: 'Customer name', value: 'Perch Test' },
    { do: 'fill', name: 'Telephone', value: '555-0100' },
    { do: 'click', role: 'radio', name: 'Medium' },
    { do: 'check', role: 'checkbox', name: 'Bacon' },
    { do: 'select', role: 'combobox', name: 'Delivery', value: 'Later' },
    { do: 'click', role: 'button', name: 'Submit order' },
  ])
  assert.equal(r.error, true, r.lines.join('\n'))
  assert.match(r.lines.at(-1)!, /HELD: .*approval (\w+)/)
  const id = r.lines.at(-1)!.match(/approval (\w+)\)/)![1]
  assert.equal(B.approvals.get(id)?.state, 'pending')
  // asking again while pending doesn't make a second approval
  const again = await B.runSteps(s, [{ do: 'click', role: 'button', name: 'Submit order' }])
  assert.match(again.lines[0], /Still waiting/)
  B.answerApproval(id, true)
  const done = await B.runSteps(s, [{ do: 'click', role: 'button', name: 'Submit order' }])
  assert.equal(done.error, false, done.lines.join('\n'))
  const t = await B.pageText(s)
  const form = JSON.parse(t.text).form
  assert.deepEqual(form, { custname: 'Perch Test', custtel: '555-0100', pw: '', size: 'medium', topping: 'bacon', when: 'Later' })
})

test('trusted sites skip the gate; declined approvals are not retried', { skip }, async () => {
  const s = (await B.session('conv-a'))!
  await B.navigate(s, base + '/spa')
  const r = await B.runSteps(s, [{ do: 'click', name: 'Delete everything' }])
  const id = r.lines[0].match(/approval (\w+)\)/)![1]
  B.answerApproval(id, false)
  const r2 = await B.runSteps(s, [{ do: 'click', name: 'Delete everything' }])
  assert.match(r2.lines[0], /declined/)
  S.settings.browser.sites = { '127.0.0.1': 'trusted' }
  const r3 = await B.runSteps(s, [{ do: 'click', name: 'Delete everything' }])
  assert.equal(r3.error, false, r3.lines.join('\n'))
  S.settings.browser.sites = {}
})

test('always allow remembers that exact action on that site', { skip }, async () => {
  const s = (await B.session('conv-a'))!
  await B.navigate(s, base + '/spa')
  const r = await B.runSteps(s, [{ do: 'click', name: 'Delete everything' }])
  const id = r.lines[0].match(/approval (\w+)\)/)![1]
  const saved = S.settings.browser.allowedActions
  B.answerApproval(id, true, true)
  assert.equal((await B.runSteps(s, [{ do: 'click', name: 'Delete everything' }])).error, false)
  assert.equal((await B.runSteps(s, [{ do: 'click', name: 'Delete everything' }])).error, false, 'no second ask')
  S.settings.browser.allowedActions = saved
})

test('cookie header matching', () => {
  const ck = [
    { name: 'a', value: '1', domain: '.github.com', path: '/', secure: true },
    { name: 'b', value: '2', domain: 'api.github.com', path: '/', secure: false },
    { name: 'c', value: '3', domain: 'github.com', path: '/settings', secure: false },
    { name: 'old', value: 'x', domain: '.github.com', path: '/', secure: false, expires: 1 },
  ]
  assert.equal(B.cookieHeader(ck, 'https://api.github.com/repos'), 'a=1; b=2')
  assert.equal(B.cookieHeader(ck, 'https://github.com/settings/profile'), 'c=3; a=1')
  assert.equal(B.cookieHeader(ck, 'http://github.com/'), '')
})

test('read-only and denied sites', { skip }, async () => {
  const s = (await B.session('conv-a'))!
  S.settings.browser.sites = { '127.0.0.1': 'read' }
  await B.navigate(s, base + '/form')
  const r = await B.runSteps(s, [{ do: 'fill', name: 'Customer name', value: 'x' }])
  assert.match(r.lines[0], /read-only/)
  S.settings.browser.sites = { '127.0.0.1': 'deny' }
  await assert.rejects(B.navigate(s, base + '/spa'), /deny list/)
  S.settings.browser.sites = {}
})

test('settle waits for the fetch a click starts; the network log shows the API', { skip }, async () => {
  const s = (await B.session('conv-a'))!
  await B.navigate(s, base + '/spa')
  const r = await B.runSteps(s, [{ do: 'click', role: 'button', name: 'Show details' }])
  assert.equal(r.error, false, r.lines.join('\n'))
  const snap = await B.snapshot(s, { mode: 'full' })
  assert.match(snap.text, /gamma/)
  assert.ok(B.networkLog(s).some(l => l.includes('/api/items')))
  assert.match(await B.responseBody(s, '/api/items'), /"alpha"/)
})

test('two conversations get separate windows and run at the same time', { skip }, async () => {
  const [a, b] = await Promise.all([B.session('conv-par-1'), B.session('conv-par-2')])
  assert.notEqual(a!.targetId, b!.targetId)
  await Promise.all([B.navigate(a!, base + '/form'), B.navigate(b!, base + '/spa')])
  const [sa, sb] = await Promise.all([B.snapshot(a!), B.snapshot(b!)])
  assert.match(sa.text, /^Order/)
  assert.match(sb.text, /^Items/)
  await Promise.all([
    B.runSteps(a!, [{ do: 'fill', name: 'Customer name', value: 'A' }]),
    B.runSteps(b!, [{ do: 'click', name: 'Show details' }]),
  ])
  assert.match((await B.snapshot(a!)).text, /value="A"/)
  assert.match((await B.snapshot(b!, { mode: 'full' })).text, /beta/)
  await B.closeSession('conv-par-1'); await B.closeSession('conv-par-2')
})

test('a finished goal is cached only after its check passes, then replays without the model', { skip }, async () => {
  S.settings.browser.sites = { '127.0.0.1': 'trusted' }
  const s = (await B.session('conv-learn'))!
  await B.navigate(s, base + '/')
  B.beginGoal(s, 'order a medium pizza with bacon')
  const r = await B.runSteps(s, [
    { do: 'click', role: 'link', name: 'Order a pizza' },
    { do: 'fill', name: 'Customer name', value: 'Perch Test' },
    { do: 'click', role: 'radio', name: 'Medium' },
    { do: 'check', role: 'checkbox', name: 'Bacon' },
    { do: 'click', role: 'button', name: 'Submit order' },
  ])
  assert.equal(r.error, false, r.lines.join('\n'))
  const bad = await B.finishGoal(s, { ok: true, expect: { text: 'this text is not there' } })
  assert.match(bad, /Not cached/)
  B.beginGoal(s, 'x'); s.goal = undefined
  assert.equal(B.pathsFor('127.0.0.1').length, 0)

  // again, with a check that holds
  await B.navigate(s, base + '/')
  B.beginGoal(s, 'order a medium pizza with bacon')
  await B.runSteps(s, [
    { do: 'click', role: 'link', name: 'Order a pizza' },
    { do: 'fill', name: 'Customer name', value: 'Perch Test' },
    { do: 'click', role: 'radio', name: 'Medium' },
    { do: 'check', role: 'checkbox', name: 'Bacon' },
    { do: 'click', role: 'button', name: 'Submit order' },
  ])
  const ok = await B.finishGoal(s, { ok: true, expect: { text: '"custname": "Perch Test"'.replace(': ', ':') } })
  assert.match(ok, /Cached/, ok)
  const p = B.findPath('127.0.0.1', 'order medium pizza bacon')!
  assert.ok(p, 'path found by goal words')
  assert.equal(p.steps[0].do, 'navigate')

  await B.navigate(s, 'about:blank')
  const rep = await B.replay(s, p)
  assert.equal(rep.ok, true, rep.lines.join('\n'))
  console.log(`replay ${rep.ms}ms`)
  assert.ok(rep.ms < 2000, `replay took ${rep.ms}ms`)
  assert.equal(JSON.parse((await B.pageText(s)).text).form.custname, 'Perch Test')
  // values can be swapped in at replay
  const rep2 = await B.replay(s, B.getPath(p.id)!, { 'Perch Test': 'Someone Else' })
  assert.equal(rep2.ok, true, rep2.lines.join('\n'))
  assert.equal(JSON.parse((await B.pageText(s)).text).form.custname, 'Someone Else')
  assert.equal(B.getPath(p.id)!.ok_count, 3)
  S.settings.browser.sites = {}
})

test('replay heals a renamed button when unambiguous and rewrites the path; refuses for irreversible steps', { skip }, async () => {
  S.settings.browser.sites = { '127.0.0.1': 'trusted' }
  const s = (await B.session('conv-learn'))!
  await B.navigate(s, base + '/spa')
  B.beginGoal(s, 'load the item list')
  await B.runSteps(s, [{ do: 'click', role: 'button', name: 'Show details' }])
  assert.match(await B.finishGoal(s, { ok: true, expect: { text: 'gamma' } }), /Cached/)
  const p = B.findPath('127.0.0.1', 'load the item list')!
  // the site renames the button
  p.steps[0].url = base + '/spa?v=2'
  const rep = await B.replay(s, p)
  assert.equal(rep.ok, true, rep.lines.join('\n'))
  assert.match(rep.lines.join('\n'), /healed/)
  const healed = B.getPath(p.id)!
  assert.equal(healed.steps[1].locator!.name, 'Show all details')
  assert.equal(healed.heal_count, 1)
  // an irreversible step that moved is never fuzzy-healed
  const risky = { ...healed, steps: [{ ...healed.steps[0] }, { ...healed.steps[1], irreversible: true, locator: { ...healed.steps[1].locator!, name: 'Remove all', testid: '', id: '' } }] }
  const rep2 = await B.replay(s, risky as any)
  assert.equal(rep2.ok, false)
  assert.match(rep2.lines.join('\n'), /diverged/)
  S.settings.browser.sites = {}
})

test('data-bearing names are cached as patterns', { skip }, async () => {
  const s = (await B.session('conv-learn'))!
  await B.navigate(s, base + '/spa')
  const snap = await B.snapshot(s, { find: 'star' })
  const ref = snap.text.match(/\[(e\d+)\] link "Star/)![1]
  const loc = await B.evalIn(s, `__perch.describe(__perch.el(${JSON.stringify(ref)}))`)
  assert.ok(loc.pattern)
  assert.ok(new RegExp(loc.pattern).test('Star (41.2k)'))
})

test('fetch with the profile cookies', { skip }, async () => {
  const s = (await B.session('conv-fetch'))!
  await B.navigate(s, base + '/setcookie')
  const r = await B.fetchWithCookies('conv-fetch', base + '/whoami')
  assert.match(r, /^200 application\/json/)
  assert.match(r, /who=ana/)
})

test('screencast frames arrive for the live view', { skip }, async () => {
  const s = (await B.session('conv-a'))!
  await B.navigate(s, base + '/spa')
  let frames = 0
  const stop = await B.watchFrames('conv-a', d => { if (d.length > 100) frames++ })
  await B.runSteps(s, [{ do: 'scroll', dy: 200 }])
  const until = Date.now() + 3000
  while (!frames && Date.now() < until) await new Promise(r => setTimeout(r, 50))
  await stop()
  assert.ok(frames > 0)
  const shot = await B.screenshot(s)
  assert.ok(Buffer.from(shot, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'jpeg')
  const low = await B.screenshot(s, { resolution: 'low' })
  assert.ok(Buffer.from(low, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'low is jpeg')
  assert.ok(low.length < shot.length, `low (${low.length}) smaller than high (${shot.length})`)
})

test('takeover pauses agent steps', { skip }, async () => {
  const s = (await B.session('conv-a'))!
  B.setPaused('conv-a', true)
  const r = await B.runSteps(s, [{ do: 'scroll', dy: 100 }])
  assert.match(r.lines[0], /taken over/)
  B.setPaused('conv-a', false)
  assert.equal((await B.runSteps(s, [{ do: 'scroll', dy: 100 }])).error, false)
})

test('re-attaches to the same window after perch restarts', { skip }, async () => {
  const s = (await B.session('conv-keep'))!
  await B.navigate(s, base + '/form')
  const target = s.targetId
  // simulate perch going away: drop the connection, keep Chrome
  const c = await B.ensureBrowser()
  c.close()
  assert.equal(B.sessions.size, 0)
  assert.ok((await B.resumeBrowser()) >= 1, 'startup re-adopts windows')
  assert.ok(B.sessions.has('conv-keep'))
  const s2 = (await B.session('conv-keep', false))!
  assert.ok(s2, 'session found again')
  assert.equal(s2.targetId, target)
  assert.match((await B.snapshot(s2)).text, /^Order/)
})

test('action log is written per run', { skip }, async () => {
  const s = (await B.session('conv-a'))!
  const lines = readFileSync(join(s.runDir, 'actions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.ok(lines.length > 3)
  assert.ok(lines.every(l => l.do && l.at))
  assert.ok(!readFileSync(join(s.runDir, 'actions.jsonl'), 'utf8').includes('"type":"password"'))
})

test('the browser tool: open with a goal, act in one call, finish, then open again replays', { skip }, async () => {
  const { browserTool } = await import('./browsertool.ts')
  S.settings.browser.sites = { '127.0.0.1': 'trusted' }
  const o = await browserTool('conv-tool', { action: 'open', url: base + '/form', goal: 'send a pizza order for Tool Test' })
  assert.match(o.text, /Goal started/)
  assert.match(o.text, /\[e\d+\] button "Submit order"/)
  const a = await browserTool('conv-tool', { action: 'act', steps: [
    { do: 'fill', name: 'Customer name', value: 'Tool Test' }, { do: 'click', role: 'radio', name: 'Small' }, { do: 'click', role: 'button', name: 'Submit order' }] })
  assert.match(a.text, /3\. click button "Submit order"/)
  assert.match(a.text, /→ now at .*\/post/)
  const f = await browserTool('conv-tool', { action: 'finish', ok: true, expect_text: 'Tool Test' })
  assert.match(f.text, /Cached/)
  const t0 = Date.now()
  const again = await browserTool('conv-tool', { action: 'open', url: base + '/form', goal: 'send a pizza order for Tool Test' })
  assert.match(again.text, /REPLAYED cached path/)
  assert.ok(Date.now() - t0 < 2500, `open+replay took ${Date.now() - t0}ms`)
  assert.match((await browserTool('conv-tool', { action: 'read' })).text, /"custname":\s?"Tool Test"/)
  const shot = await browserTool('conv-tool', { action: 'screenshot' })
  assert.ok(shot.image && shot.image.length > 1000)
  const txt = await browserTool('conv-tool', { action: 'open', url: base + '/', mode: 'text' })
  assert.match(txt.text, /Home — http/)
  assert.match((await browserTool('conv-tool', { action: 'eval', expression: 'document.title' })).text, /Home/)
  B.remember('127.0.0.1', 'Orders post to /post and echo JSON')
  assert.match((await browserTool('conv-tool', { action: 'open', url: base + '/spa' })).text, /SITE NOTES[\s\S]*echo JSON[\s\S]*CACHED PATHS/)
  S.settings.browser.sites = {}
})

test('open in Chrome adds the back pill; clicking it brings perch to that chat', { skip }, async () => {
  const s = (await B.session('conv-show'))!
  await B.navigate(s, base + '/form')
  await B.showWindow('conv-show')
  assert.equal(await B.evalIn(s, `!!document.getElementById('__perch_pill')`, { page: true }), true)
  // the pill lives in a closed shadow root: snapshots don't list it
  assert.doesNotMatch((await B.snapshot(s)).text, /perch/)
  // it follows navigations while shown
  await B.navigate(s, base + '/spa')
  await new Promise(r => setTimeout(r, 700))
  assert.equal(await B.evalIn(s, `!!document.getElementById('__perch_pill')`, { page: true }), true)
  // a real (trusted) click on the pill, like Ana's
  const box = await B.evalIn(s, `(() => { const r = document.getElementById('__perch_pill').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width } })()`, { page: true })
  assert.ok(box.w > 20, 'pill has a size')
  await B.userInput('conv-show', { type: 'click', x: box.x, y: box.y })
  const until = Date.now() + 3000
  while (B.lastBack?.owner !== 'conv-show' && Date.now() < until) await new Promise(r => setTimeout(r, 50))
  assert.equal(B.lastBack?.owner, 'conv-show')
  assert.equal(s.shown, false)
  await B.closeSession('conv-show')
})

test('a takeover survives a restart', { skip }, async () => {
  const s = (await B.session('conv-pause'))!
  await B.navigate(s, base + '/form')
  B.setPaused('conv-pause', true)
  ;(await B.ensureBrowser()).close()
  await B.resumeBrowser()
  assert.equal(B.sessions.get('conv-pause')?.paused, true)
  B.setPaused('conv-pause', false)
  await B.closeSession('conv-pause')
})

test('the window cap skips windows re-adopted at start and evicts the idle ones first', { skip }, async () => {
  for (const o of [...B.sessions.keys()]) await B.closeSession(o)
  const before = S.settings.browser.maxSessions
  S.settings.browser.maxSessions = 2
  try {
    await B.session('cap-old1'); await B.session('cap-old2')
    ;(await B.ensureBrowser()).close() // perch restarts, Chrome keeps the windows
    // only chats mid-turn get their window back at start; taken-over windows always do
    assert.equal(await B.resumeBrowser(o => o === 'cap-old1'), 1)
    assert.ok(B.sessions.get('cap-old1')?.adopted, 're-adopted and unused')
    assert.ok(!B.sessions.has('cap-old2'), 'idle chat left in Chrome')
    // two new windows fit: the re-adopted one doesn't count
    await B.session('cap-new1'); await B.session('cap-new2')
    assert.ok(B.sessions.has('cap-old1'))
    // a third is over the cap: the re-adopted one goes first
    await B.session('cap-new3')
    assert.ok(!B.sessions.has('cap-old1'), 're-adopted unused window evicted first')
    // next, the least recently used whose chat isn't mid-turn; a busy owner's window stays
    B.setOwnerBusy(o => o === 'cap-new1')
    await B.session('cap-new4')
    assert.ok(B.sessions.has('cap-new1'), 'busy chat keeps its window')
    assert.ok(!B.sessions.has('cap-new2'), 'LRU idle window evicted')
    // shown and taken-over windows are never evicted; with nothing evictable it says so
    B.setOwnerBusy(() => true)
    await assert.rejects(B.session('cap-new5'), /in use by running chats/)
  } finally {
    B.setOwnerBusy(() => false)
    S.settings.browser.maxSessions = before
    for (const o of [...B.sessions.keys()].filter(o => o.startsWith('cap-'))) await B.closeSession(o)
    await B.closeSession('cap-old2')
  }
})
