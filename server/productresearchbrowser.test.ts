import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResearchProduct, ResearchItem } from './productresearch.ts'

const skip = !existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
const profile = mkdtempSync(join(tmpdir(), 'perch-research-chrome-'))
process.env.PERCH_AGENT_CHROME_DIR = profile
process.env.PERCH_BROWSER_HEADLESS = '1'
process.env.PERCH_BROWSER_REC_DIR = join(profile, 'recordings')
const B = await import('./browser.ts')
const R = await import('./productresearch.ts')
const { researchTool } = await import('./productresearchbrowser.ts')
const S = await import('./settings.ts')
let server: Server, url: string, p: ResearchProduct, it: ResearchItem
const owner = 'research-test'
before(async () => {
  if (skip) return
  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end(req.url === '/login' ? '<input type="password">' : `<!doctype html><title>Research fixture</title><main><h1>Alerts</h1><label>Alert name<input id="name"></label><button id="save">Save alert</button><p id="result"></p><p id="ready"></p><a href="/details">Details</a><script>
    const result=document.getElementById('result');result.textContent=localStorage.getItem('alert')||'';
    document.getElementById('save').onclick=()=>{const name=document.getElementById('name').value;result.textContent='Saved: '+name;localStorage.setItem('alert',result.textContent)};
    setTimeout(()=>document.getElementById('ready').textContent='Telemetry ready',250);
    </script></main>`)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as any).port}/`
  S.settings.browser.sites = {}; S.settings.browser.defaultPolicy = 'allow'
  p = R.saveProduct({ name: 'Lab', url, sandbox: true, scope: 'Browser integration', context: 'Local fixture' })
  it = R.saveItem({ product_id: p.id, key: 'alert', title: 'Persist alert', url, kind: 'workflow' })
})
after(async () => {
  if (!skip) { await B.quitBrowser(); server.close() }
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('visit, exercise, reload, assert and capture persist a real screenshot and reproducible steps', { skip }, async () => {
  await researchTool({ action: 'visit', conversation_id: owner, item_id: it.id })
  const s = (await B.session(owner))!
  const result = await B.runSteps(s, [{ do: 'fill', name: 'Alert name', role: 'textbox', value: 'Slow checkout' }, { do: 'click', name: 'Save alert', role: 'button' }, { do: 'reload' }])
  assert.equal(result.error, false, result.lines.join('\n'))
  await researchTool({ action: 'capture', conversation_id: owner, item_id: it.id, summary: 'Created an alert and verified it survived reload', expect_text: 'Saved: Slow checkout' })
  assert.equal(R.item(it.id).status, 'tested')
  const e = R.evidenceFor(it.id)[0]
  assert.equal(e.source, 'sandbox')
  assert.equal(e.data.steps.length, 3)
  assert.equal(e.data.steps[0].value, '[input omitted]')
  assert.equal(readFileSync(R.screenshotFile(e.id)!).subarray(0, 2).toString('hex'), 'ffd8')
  assert.equal(await B.evalIn(s, '!!globalThis.__researchMask'), false)
  assert.ok(e.data.snapshot.includes('Slow checkout'))
})

test('failed outcomes, wrong products and login walls cannot generate passing evidence', { skip }, async () => {
  const count = R.evidenceFor(it.id).length
  await assert.rejects(researchTool({ action: 'capture', conversation_id: owner, item_id: it.id, summary: 'Should fail', expect_text: 'Missing outcome' }), /Outcome not found/)
  assert.equal(R.evidenceFor(it.id).length, count)
  const s = (await B.session(owner))!
  await B.navigate(s, url + 'login')
  await assert.rejects(researchTool({ action: 'capture', conversation_id: owner, item_id: it.id, summary: 'Login' }), /Login page/)
  await B.navigate(s, 'about:blank')
  await assert.rejects(researchTool({ action: 'capture', conversation_id: owner, item_id: it.id, summary: 'Wrong page' }))
  assert.equal(R.evidenceFor(it.id).length, count)
})

test('controlled page readiness uses native browser timing and stores raw repetitions', { skip }, async () => {
  const e: any = await researchTool({ action: 'measure', conversation_id: owner, item_id: it.id, expect_text: 'Telemetry ready', repetitions: 3, conditions: 'Headless Chrome, local 250ms delayed content, existing cache' })
  assert.equal(e.data.measurement.successes, 3, JSON.stringify(e.data.measurement.samples))
  assert.ok(e.data.measurement.median_ms >= 200)
  assert.ok(e.data.measurement.median_ms < 3000)
  assert.equal(e.data.measurement.samples.length, 3)
  assert.equal(R.item(it.id).status, 'tested')
})
