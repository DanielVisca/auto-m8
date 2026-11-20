import * as B from './browser.ts'
import * as R from './productresearch.ts'

const busy = new Set<string>()
const starts = new Map<string, { item: string; at: number }>()
const scrub = (s: string) => s.replace(/\b(?:ph[cp]_|sk-|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_-]{8,}/g, '[redacted]').replace(/((?:api[_ -]?key|password|secret|access[_ -]?token)\s*[:=]\s*)\S+/gi, '$1[redacted]')
const safeUrl = (s: string) => { try { return R.cleanUrl(s) } catch { return '[URL omitted: sensitive parameters]' } }
const sourceFor = (p: R.ResearchProduct, url: string) => R.within(url, p.docs_url) ? 'docs' as const : p.sandbox ? 'sandbox' as const : 'product' as const
function checkPage(p: R.ResearchProduct, s: B.Session) {
  if (s.paused) throw new Error('The browser is under manual control. Resume it before research capture.')
  if (B.policyFor(s.url) === 'deny') throw new Error('This site is on the browser deny list.')
  R.cleanUrl(s.url)
  if (!R.within(s.url, p.url) && !R.within(s.url, p.docs_url)) throw new Error('Current browser URL is outside this product. A login redirect may need attention.')
  if (/\/(login|signin|sign-in|signup|auth|sso)(\/|\?|$)/i.test(s.url)) throw new Error('Login page: sign in through the browser before capturing product evidence.')
}

async function capture(owner: string, a: any) {
  const it = R.item(R.required(a.item_id, 'item_id')), p = R.product(it.product_id)
  const s = await B.session(owner, false)
  if (!s) throw new Error('Open this product with the browser first.')
  checkPage(p, s)
  if (await B.evalIn(s, `!!document.querySelector('input[type="password"]')`)) throw new Error('Credential form: evidence capture is disabled here.')
  const url = s.url
  const source = sourceFor(p, url)
  if (a.expect_text && source === 'docs') throw new Error('A documentation page cannot verify a product workflow.')
  const text = await B.evalIn(s, `document.body?.innerText?.slice(0, 80000) || ''`) as string
  if (a.expect_text && !text.includes(R.required(a.expect_text, 'expect_text', 2000))) throw new Error(`Outcome not found: ${a.expect_text}. No passing evidence was recorded.`)
  const start = starts.get(owner)
  const steps = start?.item === it.id ? s.log.filter(x => x.at >= start.at).map(x => ({ do: x.do, locator: x.locator, key: x.key, value: x.value == null ? undefined : '[input omitted]', url: x.url ? safeUrl(x.url) : undefined, urlAfter: safeUrl(x.urlAfter), at: x.at })) : []
  if (a.expect_text && !steps.length) throw new Error('Visit this item, exercise it with the browser, then capture its checked outcome. No steps were recorded for this item.')
  const snap = await B.snapshot(s, { mode: 'full', max: 40000 })
  const env = await B.evalIn(s, `({viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},userAgent:navigator.userAgent,language:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone})`)
  // Hide editable values in images, and restore styles even when screenshot capture fails.
  // Inputs themselves remain untouched; product states and screenshots can still be compared.
  let jpeg: string
  await B.evalIn(s, `globalThis.__researchMask=document.createElement('style');__researchMask.textContent='input,textarea,[contenteditable=true]{color:transparent!important;text-shadow:none!important;caret-color:transparent!important}';document.documentElement.append(__researchMask)`)
  try { jpeg = await B.screenshot(s, { full: false, resolution: 'high' }) }
  finally { await B.evalIn(s, `globalThis.__researchMask?.remove();delete globalThis.__researchMask`).catch(() => {}) }
  if (s.url !== url) throw new Error('Page changed during capture. Capture again when stable.')
  const evidence = R.addEvidence(it.id, { source, url, summary: scrub(R.required(a.summary, 'summary')), jpeg,
    data: { snapshot: scrub(snap.text), text: scrub(text), environment: env, context: p.context, steps,
      assertion: a.expect_text ? { expected: a.expect_text, passed: true } : null,
      friction: String(a.friction ?? '').slice(0, 8000), measurement: a.measurement ?? null,
      screenshot_scope: 'viewport; editable field values masked', recording: s.runDir.split('/').pop(), conversation_id: owner } })
  return { item: R.item(it.id), evidence, snapshot: snap.text }
}

// Installed before navigation: timing uses the browser clock and a double animation frame after
// the expected text appears. Browser settling, MCP round-trips and model thinking are excluded.
export function readinessScript(expected: string) {
  return `(() => {
    globalThis.__researchTiming = null;
    let done = false, scheduled = false;
    const observer = new MutationObserver(check);
    function check() {
      if (done || scheduled || !document.body?.innerText.includes(${JSON.stringify(expected)})) return;
      scheduled = true;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (done) return;
        if (!document.body?.innerText.includes(${JSON.stringify(expected)})) { scheduled = false; return; }
        done = true; observer.disconnect(); clearTimeout(timer);
        const n = performance.getEntriesByType('navigation')[0];
        globalThis.__researchTiming = { ready_ms: performance.now(), dom_content_loaded_ms: n?.domContentLoadedEventEnd || null, response_ms:n?.responseStart || null, fcp_ms:performance.getEntriesByName('first-contentful-paint')[0]?.startTime || null, url:location.href, userAgent:navigator.userAgent, timezone:Intl.DateTimeFormat().resolvedOptions().timeZone, viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio} };
      }));
    }
    observer.observe(document, {subtree:true,childList:true,characterData:true});
    const timer = setTimeout(() => { if (!done) { done=true;observer.disconnect();globalThis.__researchTiming={error:'Expected content did not appear within 20 seconds'}; } }, 20000);
    check();
  })()`
}

async function measure(owner: string, a: any) {
  const it = R.item(R.required(a.item_id, 'item_id')), p = R.product(it.product_id)
  const expected = R.required(a.expect_text, 'expect_text', 2000)
  const repetitions = a.repetitions ?? 5
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error('repetitions must be 1–10.')
  const s = (await B.session(owner))!, c = await B.ensureBrowser()
  if (s.paused) throw new Error('The browser is under manual control.')
  const { identifier } = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: readinessScript(expected), worldName: 'perch-research-timing' }, s.sid)
  const samples: any[] = []
  const deadline = Date.now() + 210_000
  try {
    for (let i = 0; i < repetitions; i++) {
      if (s.paused) { samples.push({ attempt: i + 1, error: 'Browser taken over manually; remaining samples stopped' }); break }
      if (Date.now() > deadline) { samples.push({ attempt: i + 1, error: 'Run time budget reached' }); break }
      try {
        // about:blank ensures a document navigation even when the previous sample ended at this URL.
        await B.navigate(s, 'about:blank'); await B.navigate(s, it.url)
        checkPage(p, s)
        const { executionContextId } = await c.send('Page.createIsolatedWorld', { frameId: s.mainFrame, worldName: 'perch-research-timing' }, s.sid)
        const result = await c.send('Runtime.evaluate', { contextId: executionContextId, returnByValue: true, awaitPromise: true,
          expression: `new Promise(resolve=>{const until=Date.now()+22000;const poll=()=>{if(globalThis.__researchTiming)resolve(globalThis.__researchTiming);else if(Date.now()>until)resolve({error:'Timing instrumentation was unavailable'});else setTimeout(poll,50)};poll()})` }, s.sid, 25000)
        const sample = result.result?.value ?? { error: 'No timing result' }
        if (sample.url) sample.url = R.cleanUrl(sample.url)
        samples.push({ attempt: i + 1, ...sample })
      } catch (e: any) { samples.push({ attempt: i + 1, error: e.message }) }
    }
  } finally { await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, s.sid).catch(() => {}) }
  const measurement = { metric: 'Navigation to expected text painted', expected, cache: 'Existing browser cache; first visit and repeats listed separately. No cold-cache claim.', conditions: R.required(a.conditions, 'conditions'), samples, ...R.summarizeSamples(samples) }
  // Keep failures too. A benchmark does not assert a workflow or update a feature to tested.
  const url = it.url
  return R.addEvidence(it.id, { source: sourceFor(p, url), url, summary: `Page readiness: ${measurement.successes}/${samples.length} successful samples (${repetitions} requested).`, data: { measurement, context: p.context, conversation_id: owner } })
}

export async function researchTool(a: any) {
  switch (a.action) {
    case 'list': return R.overview()
    case 'seed': return R.seed()
    case 'product': return R.saveProduct(a)
    case 'item': return R.saveItem(a)
    case 'detail': return R.detail(R.required(a.item_id, 'item_id'))
    case 'next': return R.next(R.required(a.product_id, 'product_id'))
  }
  const owner = R.required(a.conversation_id, 'conversation_id', 200)
  if (busy.has(owner)) throw new Error('Research already uses this browser. Wait for the current action.')
  busy.add(owner)
  try {
    const it = R.item(R.required(a.item_id, 'item_id')), p = R.product(it.product_id)
    if (a.action === 'visit') {
      const s = (await B.session(owner))!
      if (s.paused) throw new Error('The browser is under manual control.')
      await B.navigate(s, it.url)
      starts.set(owner, { item: it.id, at: Date.now() })
      // No automatic evidence: let the agent assess readiness and meaning before capture.
      return { item: it, snapshot: (await B.snapshot(s, { mode: 'full', max: 15000 })).text, instructions: 'Exercise with the browser tool, then capture summary + optional expect_text. Use discover to queue in-scope links. If blocked, update item with status=blocked and notes; resume with status=queued.' }
    }
    if (a.action === 'capture') return await capture(owner, a)
    if (a.action === 'measure') return await measure(owner, a)
    if (a.action === 'discover') {
      const s = await B.session(owner, false)
      if (!s) throw new Error('Visit the item first.')
      checkPage(p, s)
      const links = await B.evalIn(s, `Array.from(document.querySelectorAll('a[href]')).slice(0,1000).map(a=>({url:a.href,title:a.innerText||a.getAttribute('aria-label')||''}))`)
      return { added: R.discoverLinks(p.id, it.id, links, a.limit ?? 30) }
    }
    throw new Error('Unknown product research action.')
  } finally { busy.delete(owner) }
}
