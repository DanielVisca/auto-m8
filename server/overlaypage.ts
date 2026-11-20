// @ts-nocheck
// The product overlay, run inside the page in perch's isolated world (the page can't see or break it).
// It draws PostHog usage onto the live DOM in a closed shadow root: a health halo and badge per element
// (clicks, rage/dead), a page panel (people, errors, latency), and an inspect card per element.
// It never calls out itself: the perch server polls take() for requests and pushes data back in.
//
// Modes: ambient (only unhealthy + most used elements), inspect (every matched element, hover to see,
// click to open its card; the click does not reach the page), hidden. Alt+P hides/shows, Alt+I inspects.
function perchOverlay() {
  if (globalThis.__perchOverlay) return
  const H = 'perch-product-overlay'
  let host, root, layer, panel, card, pill, chip
  let mode = 'ambient' // ambient | inspect | hidden
  let data = null // { items, summary, live, project, path, at }
  let matches = new Map() // element -> agg
  let byId = new Map() // key id -> { el, agg }
  let hover = null, selected = null, pendingSummary = null
  const adhoc = new Map() // key -> { el, agg }: controls you inspected that weren't in the top stats
  const queue = []
  const clip = (s, n) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
  const fmt = n => n == null ? '–' : n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n))
  const ms = n => n == null ? '–' : n >= 1000 ? (n / 1000).toFixed(1) + 's' : Math.round(n) + 'ms'
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

  // ---------- matching PostHog element chains to the live DOM ----------
  // The same avenue the toolbar uses: a stable key per clicked element (data-attr > id > href > text),
  // scoped by the nearest ancestor data-attr when the leaf has none. Ambiguous matches are dropped.
  const textOf = el => clip(el.innerText ?? el.textContent ?? '', 400)
  function candidates(it) {
    const q = (sel, scope = document) => { try { return [...scope.querySelectorAll(sel)] } catch { return [] } }
    if (it.attr) return q(`[data-attr="${CSS.escape(it.attr)}"]`)
    if (it.id) return q('#' + CSS.escape(it.id))
    const fits = el => el.tagName.toLowerCase() === it.tag && (it.text ? textOf(el) === it.text : true) && (!it.aria || el.getAttribute('aria-label') === it.aria) && (!it.href || el.getAttribute('href') === it.href)
    if (it.bem) {
      const sel = `${it.tag}.${CSS.escape(it.bem)}`
      const inParent = el => !it.pbem || [...(el.parentElement?.classList ?? [])].some(c => c === it.pbem || c.startsWith(it.pbem + '--'))
      return (it.scope ? q(`[data-attr="${CSS.escape(it.scope)}"]`).flatMap(r => q(sel, r)) : q(sel)).filter(fits).filter(inParent)
    }
    if (it.scope) return q(`[data-attr="${CSS.escape(it.scope)}"]`).flatMap(r => q(it.tag, r).filter(fits))
    if (it.href) return q(`${it.tag}[href="${CSS.escape(it.href)}"]`).filter(fits)
    if (it.text || it.aria) return q(it.tag).filter(fits)
    return []
  }
  function match() {
    matches = new Map(); byId = new Map()
    for (const [k, v] of adhoc) if (v.el.isConnected) { matches.set(v.el, v.agg); byId.set(k, v) } else adhoc.delete(k)
    if (!data) return
    for (const it of data.items) {
      const c = candidates(it)
      if (c.length !== 1) continue
      const el = c[0]
      if ([...adhoc.values()].some(v => v.el === el)) continue
      let a = matches.get(el)
      if (!a) { a = { id: it.key, keys: [], clicks: 0, rage: 0, dead: 0, people: 0, orgs: 0, label: it.label, key: it.match }; matches.set(el, a); byId.set(it.key, { el, agg: a }) }
      a.keys.push(it.key)
      if (it.type === 'norm') {
        a.clicks += it.clicks; a.rage += it.rage; a.dead += it.dead; a.people = Math.max(a.people, it.people); a.orgs = Math.max(a.orgs, it.orgs)
        // precomputed with the badges: the card draws these at once
        if (it.hours) { a.hours = a.hours ?? new Map(); for (const [h, n] of it.hours) a.hours.set(h, (a.hours.get(h) ?? 0) + n) }
        if (!a.topOrgs?.length && it.topOrgs?.length) a.topOrgs = it.topOrgs
        if (!a.topPeople?.length && it.topPeople?.length) a.topPeople = it.topPeople
      }
      else if (it.type === '$rageclick') a.rage += it.count; else if (it.type === '$dead_click') a.dead += it.count; else a.clicks += it.count
    }
  }
  // New-teams view: how many of the new teams reach this element. Few means they stop before it.
  const reach = a => { const tot = data?.summary?.orgs; if (!tot) return 'ok'; const r = (a.orgs || a.clicks) / tot; return r >= 0.3 ? 'ok' : r >= 0.05 ? 'warn' : 'low' }
  const health = a => {
    if (cohort() === 'new' && !a.id.startsWith('adhoc:')) return reach(a)
    const bad = a.rage + a.dead, share = bad / Math.max(1, a.clicks + bad); return bad >= 2 && share > 0.2 ? 'bad' : bad >= 1 && share > 0.03 ? 'warn' : 'ok' }
  const COL = { ok: '#16a34a', warn: '#f59e0b', bad: '#dc2626', low: '#71717a' }

  // ---------- drawing ----------
  function mount() {
    host = document.createElement('div'); host.id = H
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;'
    document.documentElement.appendChild(host)
    root = host.attachShadow({ mode: 'closed' })
    root.innerHTML = `<style>
      :host{all:initial} *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Inter",sans-serif}
      .h{position:fixed;border:2px solid;border-radius:6px;transition:opacity .15s}
      .h.dim{opacity:.35}
      .b{position:fixed;font-size:10.5px;font-weight:600;padding:1px 6px;border-radius:9px;color:#fff;white-space:nowrap;box-shadow:0 1px 3px #0004;line-height:15px;pointer-events:auto;cursor:pointer}
      .b:hover{filter:brightness(1.15);outline:2px solid #fff}
      .pill{position:fixed;left:50%;top:8px;white-space:nowrap;transform:translateX(-50%);pointer-events:auto;display:flex;gap:2px;align-items:center;background:#111d;color:#fff;font-size:11.5px;padding:3px 4px 3px 10px;border-radius:14px;backdrop-filter:blur(6px);box-shadow:0 2px 10px #0003}
      .pill b{font-weight:600;margin-right:6px} .pill button{all:unset;cursor:pointer;padding:2px 8px;border-radius:10px;color:#ddd} .pill button.on{background:#fff;color:#111} .pill button:hover{color:#fff}
      .panel{position:fixed;right:14px;bottom:14px;width:320px;max-height:calc(100vh - 70px);overflow:auto;pointer-events:auto;background:#111e;color:#eee;font-size:12px;padding:11px 13px;border-radius:11px;backdrop-filter:blur(8px);box-shadow:0 4px 18px #0004}
      .panel h4,.card h4{margin:0 0 6px;font-size:12.5px;color:#fff} .row{display:flex;justify-content:space-between;gap:8px;margin:3px 0} .mute{color:#999} .sec{margin-top:8px;padding-top:6px;border-top:1px solid #ffffff1a}
      .err{color:#fca5a5} .warn{color:#fcd34d} .ok{color:#86efac} .mono{font-family:ui-monospace,Menlo,monospace;font-size:11px}
      .card{position:fixed;right:14px;top:44px;width:340px;max-height:calc(100vh - 60px);overflow:auto;pointer-events:auto;background:#fff;color:#18181b;font-size:12px;padding:12px 14px;border-radius:12px;box-shadow:0 10px 30px #0004;border:1px solid #e4e4e7}
      .card h4{color:#18181b} .card .mute{color:#71717a} .card .sec{border-top:1px solid #f0f0f2} .card .err{color:#dc2626} .card .warn{color:#b45309} .card .ok{color:#15803d}
      .card a{color:#2563eb;text-decoration:none} .x{float:right;cursor:pointer;color:#a1a1aa;font-size:14px;line-height:12px}
      .go{all:unset;display:block;text-align:center;margin-top:10px;background:#18181b;color:#fff;border-radius:8px;padding:7px;cursor:pointer;font-weight:600}
      .go:disabled{opacity:.5;cursor:default}
      .att{cursor:pointer;border-radius:6px;padding:3px 5px;margin:2px -5px} .att:hover{background:#ffffff14} .att .t{display:block} .att .d{display:block;color:#a1a1aa;font-size:11px}
      .tag{display:inline-block;font-size:9.5px;font-weight:700;padding:0 5px;border-radius:6px;margin-right:4px;vertical-align:1px} .tag.new{background:#dc2626;color:#fff} .tag.up{background:#f59e0b;color:#111} .tag.k{background:#ffffff22;color:#ddd}
      .card .tag.k{background:#f4f4f5;color:#52525b}
      .dim{opacity:.55} .panel a{color:#93c5fd;text-decoration:none} .seg{display:inline-flex;margin-left:6px;background:#ffffff1a;border-radius:10px;padding:1px}
      .pin{position:fixed;pointer-events:auto;cursor:pointer;display:flex;align-items:center;gap:4px;transform:translate(-11px,-50%);z-index:2}
      .pin.flip{flex-direction:row-reverse;transform:translate(calc(-100% + 11px),-50%)}
      .ring.alt{border-width:1.5px;border-style:dashed;opacity:.8}
      .pin .n{width:22px;height:22px;border-radius:50%;color:#fff;font:700 12px/22px -apple-system,sans-serif;text-align:center;box-shadow:0 0 0 3px #fff,0 2px 8px #0006}
      .pin .l{background:#111e;color:#fff;font-size:11px;padding:2px 7px;border-radius:9px;white-space:nowrap;box-shadow:0 2px 8px #0004}
      .pin .p{white-space:nowrap;background:#fff;color:#111;font-size:10px;font-weight:700;padding:2px 6px;border-radius:9px;box-shadow:0 2px 8px #0004;text-decoration:none}
      .pin.error .n{background:#dc2626} .pin.friction .n{background:#f59e0b;color:#111} .pin.latency .n{background:#7c3aed}
      .pin .n{animation:pulse 1.8s ease-out infinite} .pin.edge .n{animation:none}
      .pin.mid .n{width:14px;height:14px;font-size:0;line-height:14px;animation:none;opacity:.85}
      .pin.mid .l,.pin.mid .p{display:none} .pin.mid:hover .l,.pin.mid:hover .p{display:inline-block} .pin.mid:hover .n{font-size:9px}
      .ring.quiet{border-width:1.5px;opacity:.55}
      @keyframes pulse{0%{box-shadow:0 0 0 3px #fff,0 0 0 3px #dc262699}100%{box-shadow:0 0 0 3px #fff,0 0 0 16px #dc262600}}
      .ring{position:fixed;border:3px solid;border-radius:8px;pointer-events:none}
      .tm{position:fixed;font-size:10.5px;font-weight:700;padding:1px 6px;border-radius:9px;color:#fff;background:#7c3aed;white-space:nowrap;box-shadow:0 1px 3px #0004}
      .tm.bad{background:#dc2626}
      .panel.compact{width:auto;max-width:380px;padding:7px 11px;cursor:pointer}
      .tip{position:fixed;max-width:300px;background:#111e;color:#eee;font-size:11.5px;line-height:1.45;padding:6px 9px;border-radius:7px;box-shadow:0 4px 14px #0005;pointer-events:none;z-index:3}
      .tip b{color:#fff}
      .dots::after{content:'';display:inline-block;width:1.2em;text-align:left;animation:dots 1.2s steps(4,end) infinite}
      @keyframes dots{0%{content:''}25%{content:'.'}50%{content:'..'}75%{content:'...'}}
      .chip{position:fixed;left:50%;transform:translateX(-50%);bottom:10px;pointer-events:auto;cursor:pointer;background:#111d;color:#fff;font:600 11px -apple-system,sans-serif;padding:4px 10px;border-radius:12px;box-shadow:0 2px 8px #0004;display:none}
      .drag{cursor:grab} .dragging{cursor:grabbing;opacity:.92}
      .spark{display:flex;align-items:flex-end;gap:1px;height:26px;margin-top:4px} .spark i{flex:1;background:#2563eb;min-height:1px;border-radius:1px 1px 0 0;opacity:.8}
    </style>`
    layer = document.createElement('div'); root.appendChild(layer)
    pill = document.createElement('div'); pill.className = 'pill'; root.appendChild(pill)
    panel = document.createElement('div'); panel.className = 'panel'; root.appendChild(panel)
    card = document.createElement('div'); card.className = 'card'; card.style.display = 'none'; root.appendChild(card)
    chip = document.createElement('div'); chip.className = 'chip'; chip.textContent = 'PostHog ▸'; chip.title = 'Show the PostHog overlay again (Alt+P)'; root.appendChild(chip)
    chip.addEventListener('click', () => setMode('ambient'))
    for (const [el, k] of [[pill, 'pill'], [panel, 'panel'], [card, 'card']]) draggable(el, k)
    pill.addEventListener('click', e => { const b = e.target.closest('button'); if (b?.dataset.all) { showAll = !showAll; drawPill(); draw() } if (b?.dataset.m) setMode(b.dataset.m); if (b?.dataset.c && b.dataset.c !== cohort()) { queue.push({ type: 'cohort', value: b.dataset.c }); data = null; matches = new Map(); byId = new Map(); drawPill(); drawPanel(); draw() } })
    panel.addEventListener('click', e => { const a = e.target.closest('.att'); if (a) return jump(Number(a.dataset.i)); if (e.target.closest('a')) return; if (!panelOpen || e.target.closest('.fold')) { panelOpen = !panelOpen; drawPanel() } })
    layer.addEventListener('click', e => {
      if (e.target.closest('a')) return
      const p = e.target.closest('.pin'); if (p) return jump(Number(p.dataset.i))
      const b = e.target.closest('.b'); if (b?.dataset.k) { e.stopPropagation(); select(b.dataset.k) }
    })
    card.addEventListener('click', e => {
      if (e.target.closest('.x')) { selected = null; card.style.display = 'none'; draw() }
      const go = e.target.closest('.go'); if (go && selected) { go.disabled = true; go.textContent = 'Starting an investigation…'; queue.push({ type: 'investigate', key: selected, keys: byId.get(selected)?.agg?.keys }) }
    })
  }
  // Drag by any empty part of it; a drag of more than a few pixels doesn't count as a click.
  const POS = 'perch-overlay-pos'
  const savedPos = () => { try { return JSON.parse(localStorage.getItem(POS) || '{}') } catch { return {} } }
  function place(el, p) { if (!p) return; Object.assign(el.style, { left: p.x + 'px', top: p.y + 'px', right: 'auto', bottom: 'auto', transform: 'none' }) }
  function draggable(el, k) {
    el.classList.add('drag')
    place(el, savedPos()[k])
    let start = null, moved = false
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button,a,input,select,textarea,summary,details,pre,.att,.x')) return
      const r = el.getBoundingClientRect()
      start = { x: e.clientX, y: e.clientY, ox: r.left, oy: r.top }; moved = false
      el.setPointerCapture?.(e.pointerId)
    })
    el.addEventListener('pointermove', e => {
      if (!start) return
      const dx = e.clientX - start.x, dy = e.clientY - start.y
      if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return
      moved = true; el.classList.add('dragging')
      place(el, { x: Math.max(0, Math.min(innerWidth - 40, start.ox + dx)), y: Math.max(0, Math.min(innerHeight - 24, start.oy + dy)) })
    })
    el.addEventListener('pointerup', () => {
      if (moved) { const r = el.getBoundingClientRect(); const all = savedPos(); all[k] = { x: Math.round(r.left), y: Math.round(r.top) }; try { localStorage.setItem(POS, JSON.stringify(all)) } catch {} }
      el.classList.remove('dragging'); start = null
    })
    // swallow the click that ends a drag, so dragging the panel doesn't also open it
    el.addEventListener('click', e => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false } }, true)
  }
  function setMode(m) {
    mode = m
    // hidden: everything goes except a small chip in the corner that brings it back (or Alt+P)
    for (const el of [pill, panel, card]) if (el) el.style.visibility = m === 'hidden' ? 'hidden' : ''
    if (chip) chip.style.display = m === 'hidden' ? 'block' : 'none'
    if (m !== 'inspect') { hover = null; hoverEl = null }
    drawPill(); draw()
  }
  let showAll = false, hoverEl = null, hoverAt = null
  let wantCohort = 'all', panelOpen = false, fresh = { at: null, refreshing: false }
  const ago = t => { if (!t) return ''; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago` }
  const cohort = () => data?.cohort ?? wantCohort
  const unit = () => data?.unit ?? data?.summary?.unit ?? 'teams'
  function drawPill() {
    const n = matches.size
    const age = fresh.refreshing ? `<span title="Showing the last numbers while fresh ones load">${fresh.at ? ago(fresh.at) + ' · ' : ''}↻</span>` : fresh.at ? `<span title="Numbers as of then; refreshed every 2 minutes while the overlay is on">${ago(fresh.at)}</span>` : ''
    pill.innerHTML = `<b>PostHog</b><span class="mute" style="margin-right:6px" title="${n} elements matched on this screen">${data ? `last 24h${age ? ' · ' + age : ''}` : 'loading…'}</span>` +
      [['ambient', 'Ambient', 'Quiet: only something new or growing gets a pin'], ['highlights', 'Highlights', 'The standout concerns on this page (Alt+H)'], ['inspect', 'Inspect', 'Hover anything for its numbers, click for the full picture (Alt+I)']]
        .map(([m, l, t]) => `<button data-m="${m}" class="${mode === m ? 'on' : ''}" title="${t}">${l}</button>`).join('') +
      (mode === 'inspect' ? `<button data-all="1" class="${showAll ? 'on' : ''}" title="Badge every element at once">All</button>` : '') +
      `<span class="seg">${[['all', 'Everyone'], ['new', 'New 7d']].map(([c, l]) => `<button data-c="${c}" class="${cohort() === c ? 'on' : ''}" title="${c === 'new' ? `Only ${unit()} whose first visit to this page was in the last 7 days: the rollout view` : `Every ${unit()}`}">${l}</button>`).join('')}</span>` +
      `<button data-m="hidden" title="Alt+P brings it back">Hide</button>`
  }
  function shown() {
    if (mode === 'inspect' && showAll) return [...matches]
    if (mode === 'inspect') return [...matches].filter(([el, a]) => el === hover || selected === a.id)
    // ambient is calm: no badges or halos, only the problem pins (drawPins) and what you selected
    return [...matches].filter(([, a]) => selected === a.id)
  }
  function draw() {
    if (!layer) return
    layer.textContent = ''
    if (mode === 'hidden') return
    const vh = innerHeight, vw = innerWidth
    const boxes = [] // label boxes drawn so far
    drawPins(vw, vh, boxes)
    if (mode === 'inspect' && !showAll) drawTip(vw, vh)
    for (const [el, a] of shown()) {
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue
      if (r.width * r.height > 0.2 * vw * vh || r.height > 0.6 * vh) continue // a container, not a control
      const col = COL[health(a)], hot = hover === el || selected === a.id
      const h = document.createElement('div'); h.className = 'h' + (mode === 'ambient' && !hot && health(a) === 'ok' ? ' dim' : '')
      Object.assign(h.style, { left: r.left - 2 + 'px', top: r.top - 2 + 'px', width: r.width + 4 + 'px', height: r.height + 4 + 'px', borderColor: col, background: hot ? col + '22' : 'transparent' })
      layer.appendChild(h)
      if (mode === 'inspect' || health(a) !== 'ok' || hot) {
        const bad = a.rage + a.dead
        const text = cohort() === 'new' && !a.id.startsWith('adhoc:') ? `${fmt(a.orgs || a.clicks)}${data?.summary?.orgs ? `/${fmt(data.summary.orgs)}` : ''} new ${unit()}`
          : [a.clicks ? `${fmt(a.clicks)} clicks` : '', a.rage ? `${fmt(a.rage)} rage` : '', a.dead ? `${fmt(a.dead)} dead${a.clicks || a.rage ? '' : ' clicks'}` : '', a.people ? `${fmt(a.people)} ppl${reachShort(a.people)}` : ''].filter(Boolean).join(' · ') || (a.clicks == null ? 'counting…' : '0 clicks')
        // Labels never cover each other: try above, then below, else leave it to hover (the halo stays).
        const w = text.length * 6.1 + 14, x = Math.max(0, Math.min(vw - w, r.left))
        const y = [Math.max(0, r.top - 16), r.bottom + 1].find(y => !boxes.some(b => x < b.x + b.w && b.x < x + w && y < b.y + 16 && b.y < y + 16))
        if (y == null && !hot) continue
        const top = y ?? Math.max(0, r.top - 16)
        boxes.push({ x, y: top, w })
        const b = document.createElement('div'); b.className = 'b'; b.style.background = col; b.dataset.k = a.id
        b.title = 'Click: how this is counted, and open it in PostHog'
        Object.assign(b.style, { left: x + 'px', top: top + 'px' })
        b.textContent = text
        layer.appendChild(b)
      }
    }
  }
  // Like the browser's element inspector, but for product data: whatever is under the pointer gets an
  // outline and a small tooltip; click it for the full card.
  function drawTip(vw, vh) {
    const el = hoverEl
    if (!el?.isConnected) return
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return
    const a = matches.get(hover ?? null)
    const box = document.createElement('div'); box.className = 'h'
    Object.assign(box.style, { left: r.left - 1 + 'px', top: r.top - 1 + 'px', width: r.width + 2 + 'px', height: r.height + 2 + 'px', borderColor: '#2563eb', background: '#2563eb14', borderWidth: '1.5px' })
    layer.appendChild(box)
    const name = el.getAttribute('aria-label') || el.getAttribute('placeholder') || clip(textOf(el), 40) || a?.label || el.tagName.toLowerCase()
    const nums = a ? [a.clicks ? `${fmt(a.clicks)} clicks` : '', a.people ? `${fmt(a.people)} people${reachOf(a.people)}` : '', a.orgs ? `${fmt(a.orgs)} ${unit()}` : '', a.rage ? `${fmt(a.rage)} rage` : '', a.dead ? `${fmt(a.dead)} dead` : ''].filter(Boolean).join(' · ') : ''
    const tip = document.createElement('div'); tip.className = 'tip'
    const counting = a && a.clicks == null
    const what = counting ? '<span class="mute">counting<span class="dots"></span></span>' : nums ? esc(nums) : el.matches?.(CONTROL) ? '<span class="mute">counting<span class="dots"></span></span>' : '<span class="mute">no clicks recorded on this page</span>'
    tip.innerHTML = `<b>${esc(clip(name, 40))}</b><span class="mute"> ${esc(el.tagName.toLowerCase())}${el.getAttribute('data-attr') ? `[data-attr=${esc(el.getAttribute('data-attr'))}]` : ''}</span><br>${what}<br><span class="mute">click for usage, errors, backend, replays, users</span>`
    const below = r.bottom + 70 < vh
    Object.assign(tip.style, { left: Math.max(4, Math.min(vw - 300, r.left)) + 'px', top: (below ? r.bottom + 6 : Math.max(4, r.top - 64)) + 'px' })
    layer.appendChild(tip)
  }
  // what share of the page's visitors used it: a click count means more next to how many saw the page
  // short form for badges: '2 ppl · 0.2%' reads against how many people saw the page
  const reachShort = n => { const t = data?.summary?.people; return t && n ? ` · ${n / t >= 0.1 ? Math.round(n / t * 100) : (n / t * 100).toFixed(1).replace(/\.0$/, '')}%` : '' }
  const reachOf = n => { const t = data?.summary?.people; return t && n ? ` (${n / t >= 0.1 ? Math.round(n / t * 100) : (n / t * 100).toFixed(1).replace(/\.0$/, '')}% of ${fmt(t)} visitors)` : '' }
  // which page these numbers are for: its title as the page shows it, and the path pattern counted
  const pageName = () => { const t = (document.title || '').split(/ [•|·–-] /)[0].trim(); return t || location.pathname }
  const prettyPath = () => (data?.path || '').replace(/^\^/, '').replace(/\/\?\$$/, '').replace(/\[\^\/\]\+/g, '*').replace(/\\/g, '')
  const delta = (now, prev) => !prev && now ? '<span class="tag new">NEW</span>' : prev && now > prev * 1.25 ? `<span class="tag up">▲ ${Math.round((now / prev - 1) * 100)}%</span>` : ''
  const vsWeek = (now, prev) => prev ? `<span class="mute"> (${fmt(prev)} last wk)</span>` : ''
  // SHOW, don't list: each needs-attention item is a numbered pin on its element, with a one-line label
  // and the replay to watch. Off screen, the pin waits at the edge pointing the way.
  function drawPins(vw, vh, boxes = []) {
    const att = data?.summary?.attention ?? []
    const edges = { top: 0, bottom: 0 }
    const placed = [] // pin boxes so far: nudge new pins down instead of stacking them
    // pins never overlap: each takes its label's real horizontal span, and moves down a row until it's clear
    const free = (x0, x1, y) => { while (placed.some(p => x0 < p.x1 && p.x0 < x1 && Math.abs(p.y - y) < 24)) y += 26; placed.push({ x0, x1, y }); return y }
    const span = (label, extras) => label.replace(/<[^>]+>|&[a-z]+;/g, ' ').length * 6.6 + 40 + extras * 70
    // How big a problem is decides how loud it is: the worst (and anything close to it) is a labelled,
    // pulsing pin; mid-sized ones are a quiet dot with the label on hover; small ones only show in Inspect.
    const top = Math.max(1e-9, ...att.filter((_, i) => !siteWide.has(i)).map(a => a.score || 0))
    // Ambient labels only the single worst problem it can point at; the rest are numbered dots (label on hover).
    // Inspect: pins only with "All badges". Highlights: the standout few, labelled. Ambient: only what is
    // new or growing fast, the proactive nudge.
    if (mode === 'inspect' && !showAll) return
    const growing = a => a.isNew || (a.prevOrgs && a.orgs >= a.prevOrgs * 1.5)
    const tier = (a, i) => mode === 'inspect' ? 'high' : mode === 'ambient' ? (growing(a) && (a.score || 0) >= top * 0.15 ? 'mid' : 'low') : (a.score || 0) >= top * 0.15 ? 'mid' : 'low'
    let loud = mode === 'inspect' ? Infinity : mode === 'highlights' ? 5 : 1
    att.forEach((a, i) => {
      let t = tier(a, i)
      if (t === 'low' || (a.noise && mode !== 'inspect') || (siteWide.has(i) && mode !== 'inspect')) return
      const el = spots[i]
      if (!el?.isConnected) return
      const r = el.getBoundingClientRect()
      if (!r.width && !r.height) return
      const many = (spotSets[i] ?? []).filter(x => x.isConnected)
      // a pattern across dozens of identical elements isn't a place to point at: it stays in the list
      if (mode === 'ambient' && many.length > 8) return
      if (t === 'mid' && loud > 0) { t = 'high'; loud-- }
      const pin = document.createElement('div'); pin.className = `pin ${a.kind} ${t}`; pin.dataset.i = i
      pin.title = `${a.title}\n${a.detail}${(spotSets[i] ?? []).length > 1 ? `\nThis count covers ${(spotSets[i] ?? []).length} identical-looking elements; clicking opens just this one.` : ''}\nClick to inspect it`
      const trend = a.isNew ? ' · NEW' : a.prevOrgs && a.orgs > a.prevOrgs * 1.25 ? ` · ▲${Math.round((a.orgs / a.prevOrgs - 1) * 100)}%` : ''
      const label = esc(a.short || clip(a.title, 40)) + trend + (many.length > 1 ? ` · across ${many.length} places` : '')
      if (r.bottom < 0 || r.top > vh) {
        const up = r.bottom < 0, k = up ? 'top' : 'bottom'
        pin.classList.add('edge')
        const x = Math.min(vw - 260, Math.max(20, r.left + r.width / 2))
        Object.assign(pin.style, { left: x + 'px', top: free(x - 11, x - 11 + span(label, 0), up ? 62 : vh - 24 - edges[k] * 26) + 'px' })
        pin.innerHTML = `<span class="n">${i + 1}</span><span class="l">${up ? '↑' : '↓'} ${label}</span>`
        edges[k]++
      } else {
        const col = a.kind === 'error' ? '#dc2626' : a.kind === 'latency' ? '#7c3aed' : '#f59e0b'
        // a handful of identical spots: outline them all; dozens: just the one, and say how many
        for (const [j, m] of (many.length > 8 || t === 'mid' || mode !== 'inspect' ? [el] : many.length ? many : [el]).entries()) {
          const q = m.getBoundingClientRect()
          if (q.bottom < 0 || q.top > vh) continue
          const ring = document.createElement('div'); ring.className = 'ring' + (j ? ' alt' : '') + (t === 'mid' ? ' quiet' : '')
          Object.assign(ring.style, { left: q.left - 4 + 'px', top: q.top - 4 + 'px', width: q.width + 8 + 'px', height: q.height + 8 + 'px', borderColor: col })
          layer.appendChild(ring)
        }
        const x = Math.min(vw - 14, r.right)
        const w = span(label, (a.replay ? 1 : 0) + (a.source ? 1 : 0))
        const flip = x + w > vw - 8
        if (flip) pin.classList.add('flip')
        const py = free(flip ? x - w + 11 : x - 11, flip ? x + 11 : x - 11 + w, Math.max(14, r.top))
        Object.assign(pin.style, { left: x + 'px', top: py + 'px' })
        boxes.push({ x: pin.classList.contains('flip') ? x - 300 : x - 11, y: py - 11, w: 300 })
        pin.innerHTML = `<span class="n">${i + 1}</span><span class="l">${label}</span>${a.replay ? `<a class="p" href="${esc(a.replay)}" target="_blank" title="Watch the latest session with this">▶ replay</a>` : ''}${a.source ? `<a class="p" href="${esc(a.source)}" target="_blank" title="Open the query behind this number in PostHog">ⓘ query</a>` : ''}`
      }
      layer.appendChild(pin)
    })
    // Live latency where it happened: the slowest request after your last click on each element.
    const by = data?.live?.byKey ?? {}
    for (const [k, t] of Object.entries(by)) {
      const el = byId.get(k)?.el
      if (!el?.isConnected || (t.ms < 300 && !t.failed)) continue
      const r = el.getBoundingClientRect()
      if (!r.width || r.bottom < 0 || r.top > vh) continue
      const c = document.createElement('div'); c.className = 'tm' + (t.failed || t.ms > 1000 ? ' bad' : '')
      Object.assign(c.style, { left: Math.max(0, r.left) + 'px', top: Math.min(vh - 16, r.bottom + 2) + 'px' })
      c.textContent = `⏱ ${ms(t.ms)}${t.failed ? ' · failed' : ''}`
      layer.appendChild(c)
    }
  }
  function drawPanel() {
    if (!data) { panel.innerHTML = `<h4>PostHog · loading${wantCohort === 'new' ? ' new ' + unit() : ''}…</h4>`; return }
    const s = data.summary ?? {}, l = data.live ?? {}, U = unit()
    const head = !data.summary ? '<div class="mute">Loading teams, errors, latency and power users…</div>' : data.summary.failed ? `<div class="err">${esc(clip(data.summary.failed, 140))}</div>` : ''
    if (data.summary?.failed) { panel.innerHTML = `<h4>PostHog data</h4>${head}<div class="mute" style="margin-top:6px">Alt+P hide</div>`; return }
    const order = (s.attention ?? []).map((a, i) => i).sort((x, y) => (siteWide.has(x) ? 1 : 0) - (siteWide.has(y) ? 1 : 0))
    const att = order.map(i => [s.attention[i], i]).map(([a, i]) => `<div class="att" data-i="${i}" title="${a.locate ? 'Show it on the page' : ''}"><span class="t"><b>${i + 1}.</b> ${siteWide.has(i) ? '<span class="tag k">site-wide</span>' : ''}${a.isNew ? '<span class="tag new">NEW</span>' : delta(a.orgs, a.prevOrgs)}<span class="${a.kind === 'error' ? 'err' : a.kind === 'latency' ? 'warn' : 'warn'}${a.noise ? ' dim' : ''}">${esc(clip(a.title, 70))}</span></span><span class="d">${esc(clip(a.detail, 90))}${a.locate ? ' · ⌖' : ''}${a.source ? ` · <a href="${esc(a.source)}" target="_blank">query ↗</a>` : ''}${a.replay ? ` · <a href="${esc(a.replay)}" target="_blank">replay ↗</a>` : ''}</span></div>`).join('')
    const errs = (s.errors ?? []).map(e => `<div class="row${e.noise ? ' dim' : ''}" title="${e.noise ? 'Likely noise: aborts, cancels, network drops' : ''}"><span class="err">${delta(e.orgs, e.prevOrgs)}${esc(clip(e.type + (e.value ? ': ' + e.value : ''), 40))}</span><span style="white-space:nowrap">${fmt(e.count)}× · ${fmt(e.orgs)} ${U}</span></div>`).join('')
    const po = s.power?.orgs ?? [], pp = s.power?.people ?? []
    const nAtt = (s.attention ?? []).filter((_, i) => !siteWide.has(i)).length
    panel.classList.toggle('compact', !panelOpen)
    if (!panelOpen) {
      panel.innerHTML = `<b>${esc(clip(pageName(), 22))}</b> · <b>${fmt(s.orgs)}</b> ${U} ${delta(s.orgs, s.prevOrgs)}· ${fmt(s.pageviews)} views · <span class="err">${fmt(s.errorTotal ?? 0)} errors</span> · ${data.summary ? `<span class="${nAtt ? 'warn' : 'ok'}">${nAtt ? `⚠ ${nAtt} to look at` : 'nothing stands out'}</span>` : '<span class="mute">loading…</span>'} <span class="mute">· details ▸</span>`
      return
    }
    panel.innerHTML = `<span class="x fold" title="Collapse">▾</span>${s.source ? `<a href="${esc(s.source)}" target="_blank" style="float:right;margin-right:10px;font-size:11px" title="Open the query behind these numbers in PostHog">query ↗</a>` : ''}<h4>${esc(clip(pageName(), 28))} · last 24h <span class="mute" style="font-weight:400">${esc(prettyPath())} · · ${cohort() === 'new' ? `new ${U} (7d)` : `all ${U}`} · project ${esc(data.project)}</span></h4>
      ${head}<div class="row"><span>${U[0]?.toUpperCase() + U.slice(1)} · people</span><span>${delta(s.orgs, s.prevOrgs)}${fmt(s.orgs)}${vsWeek(s.orgs, s.prevOrgs)} · ${fmt(s.people)}</span></div>
      <div class="row"><span>Page views</span><span>${fmt(s.pageviews)}</span></div>
      ${s.vitals?.lcp != null ? `<div class="row"><span>LCP p75 · INP p75</span><span>${ms(s.vitals.lcp)} · ${ms(s.vitals.inp)}</span></div>` : ''}
      ${s.queries?.count ? `<div class="row"><span>API queries p50 · p95</span><span>${ms(s.queries.p50)} · <span class="${s.queries.p95 > 1000 ? 'warn' : ''}">${ms(s.queries.p95)}</span>${s.queries.prev95 ? `<span class="mute"> (${ms(s.queries.prev95)})</span>` : ''}</span></div>` : ''}
      ${s.loading && Object.values(s.loading).some(Boolean) ? `<div class="mute" style="margin-top:4px">loading ${Object.entries(s.loading).filter(([, v]) => v).map(([k]) => k).join(', ')}…</div>` : ''}
      ${att ? `<div class="sec"><div class="row"><b>Needs attention</b><span class="mute">${U} × severity × new</span></div>${att}</div>` : data.summary ? '<div class="sec"><b>Needs attention</b><div class="mute">nothing stands out</div></div>' : ''}
      <div class="sec"><div class="row"><b>Errors</b><span>${fmt(s.errorTotal ?? 0)} · ${fmt(s.errorOrgs ?? 0)} ${U}</span></div>${errs || '<div class="mute">none</div>'}</div>
      ${po.length || pp.length ? `<div class="sec"><b>Power users</b>
        ${po.map(o => `<div class="row"><a href="${esc(o.url)}" target="_blank">${esc(clip(o.name, 30))}</a><span>${o.mrr > 0 ? `<span class="tag k">$${fmt(o.mrr)} MRR</span>` : ''}${fmt(o.events)} ev · ${fmt(o.people)} ppl</span></div>`).join('')}
        ${pp.map(p => `<div class="row"><a href="${esc(p.url)}" target="_blank">${esc(clip(p.email, 34))}</a><span>${fmt(p.events)} ev</span></div>`).join('')}</div>` : ''}
      <div class="sec"><div class="row"><b>Live (this window)</b><span>${fmt(l.count ?? 0)} requests</span></div>
      ${l.count ? `<div class="row"><span>p50 · p95</span><span>${ms(l.p50)} · ${ms(l.p95)}</span></div>` : ''}
      ${(l.failed ?? 0) ? `<div class="row err"><span>failed</span><span>${l.failed}</span></div>` : ''}</div>
      ${(s.missing ?? []).length ? `<div class="sec warn" title="${esc(s.missing.join('\n'))}">${s.missing.length} section(s) didn't load (PostHog busy); reopen to retry</div>` : ''}
      <div class="mute" style="margin-top:6px">${matches.size} of ${data.items.length} ${cohort() === 'new' ? 'elements new ' + U + ' clicked' : 'click patterns'} on screen · Alt+P hide · Alt+I inspect</div>`
  }
  // Click a needs-attention item: find that spot on the page, scroll to it and open its card.
  // Where a needs-attention item lives on this page (null when it isn't rendered: a closed drawer, a menu).
  function findSpot(L) {
    if (!L) return null
    const scopes = L.scope ? [...document.querySelectorAll(`[data-attr="${CSS.escape(L.scope)}"]`)] : [document]
    const cands = scopes.flatMap(r => [...r.querySelectorAll(L.tag || '*')]).filter(el =>
      (L.cls ?? []).every(c => el.classList.contains(c)) && (!L.text || textOf(el) === L.text))
    // prefer one that also carries the state classes, and is laid out
    const score = el => (L.mods ?? []).filter(c => el.classList.contains(c)).length * 2 + (el.getBoundingClientRect().width ? 1 : 0)
    return cands.sort((x, y) => score(y) - score(x))[0] ?? null
  }
  // Every element the item could be: a spot like "the icon button in the logs table" is often many
  // identical buttons, and the data can't say which one. Show them all rather than guess.
  // A spot we can't tell apart from the page's scaffolding (a bare div, no scope, class or text) gets
  // no pin: pinning every div would be noise, not information. It stays in the list.
  const vague = L => !L || (!L.scope && !(L.cls ?? []).length && !L.text)
  const control = el => { const r = el.getBoundingClientRect(); return r.width && r.width * r.height < 0.08 * innerWidth * innerHeight && r.height < 0.4 * innerHeight }
  function findAll(L) {
    if (vague(L)) return []
    const scopes = L.scope ? [...document.querySelectorAll(`[data-attr="${CSS.escape(L.scope)}"]`)] : [document]
    const all = scopes.flatMap(r => [...r.querySelectorAll(L.tag || '*')]).filter(el =>
      (L.cls ?? []).every(c => el.classList.contains(c)) && (!L.text || textOf(el) === L.text) && control(el))
    const best = Math.max(0, ...all.map(el => (L.mods ?? []).filter(c => el.classList.contains(c)).length))
    return all.filter(el => (L.mods ?? []).filter(c => el.classList.contains(c)).length === best)
  }
  let spots = [], spotSets = [] // attention index -> best element, and all candidates
  // App chrome (navigation, header, sidebars) is on every page, so its problems would top every page's
  // list. They're site-wide: no pin in ambient, listed last with a tag.
  const chrome = el => { if (!el) return false; if (el.closest('nav,header,aside,[role=navigation],[role=banner],[role=complementary]')) return true; const main = document.querySelector('main,[role=main]'); return !!main && !main.contains(el) }
  let siteWide = new Set()
  const findSpots = () => {
    const att = data?.summary?.attention ?? []
    spotSets = att.map(a => findAll(a.locate))
    spots = att.map((a, i) => spotSets[i][0] ?? null)
    siteWide = new Set(att.map((a, i) => chrome(spots[i]) ? i : -1).filter(i => i >= 0))
    // warm the cards of the problems pinned on this page
    att.forEach((a, i) => { const el = spots[i]; if (el && !siteWide.has(i) && matches.has(el)) prefetch(matches.get(el).id) })
  }
  function jump(i) {
    const a = data?.summary?.attention?.[i]
    if (!a?.locate) { if (a?.replay) open(a.replay, '_blank'); return }
    const el = spots[i]?.isConnected ? spots[i] : findAll(a.locate)[0]
    if (!el) { flash(`Couldn't find “${clip(a.title, 50)}” on this screen (it may be in a row, menu or drawer that isn't open).`); return }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setTimeout(() => { const o = matches.has(el) ? el : null; if (o) select(matches.get(o).id); else inspectControl(el) }, 350)
  }
  const nudged = new Set()
  function nudge() {
    if (mode !== 'ambient' || !data?.summary?.attention || data.summary.partial) return
    const i = data.summary.attention.findIndex((a, j) => !siteWide.has(j) && !a.noise && (a.isNew || (a.prevOrgs && a.orgs >= a.prevOrgs * 1.5)))
    const a = data.summary.attention[i], key = location.pathname + '|' + (a?.title ?? '')
    if (!a || nudged.has(key)) return
    nudged.add(key)
    const n = document.createElement('div'); n.className = 'pill'; n.style.top = '44px'; n.style.cursor = 'pointer'
    n.innerHTML = `<span class="tag ${a.isNew ? 'new' : 'up'}">${a.isNew ? 'NEW' : '▲ ' + Math.round((a.orgs / a.prevOrgs - 1) * 100) + '%'}</span>${esc(clip(a.title, 70))} <span class="mute">· ${fmt(a.orgs)} ${esc(unit())} · look ▸</span>`
    n.addEventListener('click', () => { n.remove(); jump(i) })
    root.appendChild(n); setTimeout(() => n.remove(), 9000)
  }
  function flash(msg) { const n = document.createElement('div'); n.className = 'pill'; n.style.top = '44px'; n.textContent = msg; root.appendChild(n); setTimeout(() => n.remove(), 4000) }
  function drawSeed(a) {
    const hs = a.hours ? [...a.hours.keys()] : []
    const from = hs.length ? Math.min(...hs) : 0, to = Math.floor(Date.now() / 3600000) * 3600
    return {
      trend: hs.length ? Array.from({ length: Math.max(1, Math.round((to - from) / 3600) + 1) }, (_, i) => a.hours.get(from + i * 3600) ?? 0) : null,
      power: { orgs: (a.topOrgs ?? []).map(o => ({ ...o, clicks: null })), people: (a.topPeople ?? []).map(p => ({ email: p.id, url: p.url, clicks: null })) },
    }
  }
  function drawCard(d) {
    const a = byId.get(selected)?.agg
    if (a && d && !d.error && d.cohort === cohort() && d.clicks != null) { a.clicks = d.clicks; a.rage = d.rage; a.dead = d.dead; a.people = d.people }
    if (!a) { card.style.display = 'none'; return }
    card.style.display = ''
    const head = `<span class="x">✕</span><h4>${esc(clip(a.label, 50))}</h4><div class="mute mono">${esc(clip(a.key, 80))}</div>`
    // What the badge already knows draws at once; the card's own queries replace it as they land.
    if (!d) {
      const hs = a.hours ? [...a.hours.keys()] : []
      const from = hs.length ? Math.min(...hs) : 0, to = Math.floor(Date.now() / 3600000) * 3600
      const trend = hs.length ? Array.from({ length: Math.max(1, Math.round((to - from) / 3600) + 1) }, (_, i) => a.hours.get(from + i * 3600) ?? 0) : null
      const power = a.topOrgs || a.topPeople ? { orgs: (a.topOrgs ?? []).map(o => ({ ...o, clicks: null })), people: (a.topPeople ?? []).map(p => ({ email: p.id, url: p.url, clicks: null })) } : null
      d = { partial: true, seed: true, loading: { usage: true, errors: true, backend: true, replays: true, power: !power, allPages: true }, unit: unit(), cohort: cohort(),
        clicks: a.clicks, people: a.people, orgs: a.orgs, rage: a.rage, dead: a.dead, trend, power }
    }
    if (d.error) { card.innerHTML = head + `<div class="sec err">${esc(d.error)}</div>`; return }
    const L = d.loading ?? {}, wait = '<div class="mute">loading<span class="dots"></span></div>'
    if (d.partial && !d.seed && a) {
      if (!d.trend && a.hours) d = { ...d, trend: drawSeed(a).trend }
      if (!d.power && (a.topOrgs || a.topPeople)) d = { ...d, power: drawSeed(a).power, loading: { ...d.loading, power: false } }
      if (d.clicks == null) d = { ...d, clicks: a.clicks, people: a.people, orgs: a.orgs, rage: a.rage, dead: a.dead }
    }
    const max = Math.max(1, ...(d.trend ?? [])), U = d.unit ?? unit()
    const po = d.power?.orgs ?? [], pp = d.power?.people ?? []
    card.innerHTML = head + `
      <div class="sec"><div class="row"><b>Usage · last 24h${d.cohort === 'new' ? ` · new ${U}` : ''}</b><span>${fmt(d.clicks)} clicks</span></div>
        <div class="row"><span>${L.usage ? '' : delta(d.orgs, d.prevOrgs)}${L.usage && !d.people ? `<span class="mute">counting ${U} and people<span class="dots"></span></span>` : `${fmt(d.orgs)} ${U} · ${fmt(d.people)} people${reachOf(d.people)}`}</span><span class="mute">${L.usage ? 'updating<span class="dots"></span>' : `${fmt(d.prevOrgs)} ${U} last wk`}</span></div>
        <div class="spark">${(d.trend ?? []).map(v => `<i style="height:${Math.round(v / max * 100)}%" title="${v}"></i>`).join('')}</div>
        <div class="row"><span class="${d.rage ? 'err' : 'mute'}">rage ${fmt(d.rage)}</span><span class="${d.dead ? 'warn' : 'mute'}">dead ${fmt(d.dead)}</span></div>
        ${!d.clicks && (d.dead || d.rage) ? `<div class="mute" style="margin-top:3px">Not clickable: PostHog records normal clicks only on buttons, links and inputs. These ${fmt((d.dead || 0) + (d.rage || 0))} clicks did nothing, so people expected something here.</div>` : ''}</div>
      ${d.allPages ? `<div class="row"><span class="mute">across all pages</span><span>${fmt(d.allPages.clicks)} clicks · ${fmt(d.allPages.people)} people</span></div>` : ''}
      <div class="sec"><div class="row"><b>Errors within 10s of a click</b><span>${L.errors ? '' : fmt(d.errorTotal)}</span></div>
        ${L.errors ? wait : (d.errors ?? []).map(e => `<div class="row${e.noise ? ' dim' : ''}"><span class="err">${esc(clip(e.type + (e.value ? ': ' + e.value : ''), 40))}</span><span style="white-space:nowrap">${fmt(e.count)}× · ${fmt(e.orgs)} ${U}</span></div>`).join('') || '<div class="mute">none</div>'}</div>
      <div class="sec"><b>Replays worth watching</b>
        ${L.replays ? wait : (d.sessions ?? []).map((s, i) => `<div class="row"><a href="${esc(s.url)}" target="_blank">▶ replay ${i + 1}</a><span>${(s.why ?? []).map(w => `<span class="tag k">${esc(w)}</span>`).join('') || '<span class="mute">recent</span>'}</span></div>`).join('') || '<div class="mute">no recorded sessions</div>'}</div>
      ${L.power ? `<div class="sec"><b>Uses it most</b>${wait}</div>` : ''}
      ${po.length || pp.length ? `<div class="sec"><b>Uses it most</b>
        ${pp.map(p => `<div class="row"><a href="${esc(p.url)}" target="_blank" title="Open their PostHog person profile">${esc(clip(p.email, 34))}</a><span>${p.clicks == null ? '' : fmt(p.clicks) + ' clicks'}</span></div>`).join('')}
        ${po.length ? `<div class="mute" style="margin-top:4px">${esc(U)}: ${po.map(o => `<a href="${esc(o.url)}" target="_blank">${esc(clip(o.name, 24))}</a>`).join(' · ')}</div>` : ''}</div>` : ''}
      ${L.backend ? `<div class="sec"><b>Backend · requests after a click</b>${wait}</div>` : ''}
      ${d.backend?.requests?.length ? `<div class="sec"><div class="row"><b>Backend · requests after a click</b><span class="${d.backend.failures ? 'err' : 'mute'}">${fmt(d.backend.failures)} failed</span></div>
        ${d.backend.requests.map(r => `<div class="row"><span>${esc(clip(r.type, 22))} <span class="mute">×${fmt(r.count)}</span></span><span>p50 ${ms(r.p50)} · <span class="${r.p95 > 1000 ? 'warn' : ''}">p95 ${ms(r.p95)}</span>${r.logs ? ` · <a href="${esc(r.logs)}" target="_blank" title="The backend log lines for these requests">logs ↗</a>` : ''}</span></div>`).join('')}</div>` : ''}
      <div class="sec"><div class="row"><b>Live requests after your clicks</b><span>${fmt(d.live?.length ?? 0)}</span></div>
        ${(d.live ?? []).slice(0, 6).map(r => `<div class="row mono"><span class="${r.failed || r.status >= 400 ? 'err' : ''}">${esc(r.method)} ${esc(clip(r.path, 34))}</span><span class="${r.ms > 1000 ? 'warn' : ''}">${r.status ?? r.failed ?? '…'} · ${ms(r.ms)}${r.logs ? ` · <a href="${esc(r.logs)}" target="_blank" title="This request's backend log lines">logs ↗</a>` : ''}</span></div>`).join('') || '<div class="mute">click it to time its requests</div>'}</div>
      ${d.howto ? `<div class="sec"><b>How this is counted</b><div class="mute" style="margin:3px 0 5px">${esc(d.howto.rule)}</div>
        <div class="row"><a href="${esc(d.howto.sqlUrl)}" target="_blank">Open the query in PostHog ↗</a>${d.howto.insightUrl ? `<a href="${esc(d.howto.insightUrl)}" target="_blank" title="Filters laid out as a trends insight (approximate: insights can't merge a button's icon and label clicks)">As an insight ↗</a>` : ''}</div>
        <details><summary class="mute" style="cursor:pointer;font-size:11px">show SQL</summary><pre class="mono" style="white-space:pre-wrap;font-size:10px;max-height:160px;overflow:auto;background:#f4f4f5;padding:6px;border-radius:6px">${esc(d.howto.sql)}</pre></details></div>` : ''}
      <button class="go">Investigate with an agent</button>`
  }

  // ---------- interaction ----------
  const owner = el => { for (let n = el; n && n !== document.documentElement; n = n.parentElement) if (matches.has(n)) return n; return null }
  // Events on the overlay itself (top bar, card, panel, pins) arrive retargeted to its host element;
  // they belong to the overlay's own buttons, never to the page inspector.
  const ours = e => e.target === host || e.composedPath?.().includes(host)
  function onMove(e) {
    if (mode !== 'inspect') return
    if (ours(e)) { if (hoverEl) { hoverEl = null; hover = null; draw() } return }
    // the element under the pointer: a counted element, else the control, else whatever it is
    const o = owner(e.target)
    const el = o ?? e.target.closest?.(CONTROL) ?? e.target
    if (el === hoverEl) return
    hoverEl = el instanceof Element && el !== document.body && el !== document.documentElement ? el : null
    hover = o; draw()
    clearTimeout(dwell)
    if (o) dwell = setTimeout(() => { if (hover === o) prefetch(matches.get(o)?.id) }, 400)
    else if (hoverEl && hoverEl.matches?.(CONTROL)) dwell = setTimeout(() => { if (hoverEl === el) { peek(el); hover = matches.has(el) ? el : null; draw() } }, 300)
  }
  function onClick(e) {
    if (ours(e)) return
    const o = owner(e.target)
    if (mode === 'inspect') {
      // The control you clicked, even when only its container is in the top stats.
      const ctl = e.target.closest?.(CONTROL)
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation()
      if (!o && !ctl) return e.target instanceof Element ? inspectControl(e.target) : undefined
      if (ctl && ctl !== o && (!o || o.contains(ctl))) return inspectControl(ctl)
      select(matches.get(o).id)
    } else if (o) queue.push({ type: 'click', key: matches.get(o).id, at: Date.now() })
  }
  const CONTROL = 'input,textarea,select,button,a[href],[role=button],[role=tab],[role=menuitem],[role=combobox],[role=searchbox],[role=checkbox],[role=switch]'
  function inspectControl(el) {
    const { key, agg } = makeAdhoc(el)
    selected = key; drawCard(null); draw()
  }
  // Count an element nobody has a badge for yet: unknown is shown as "counting…", never as 0.
  function peek(el) {
    if (matches.has(el)) return
    makeAdhoc(el, true)
    draw()
  }
  function makeAdhoc(el, silent = false) {
    const tag = el.tagName.toLowerCase()
    const isField = /^(input|textarea|select)$/.test(tag)
    // posthog-js drops a form field's own attributes (data-attr, placeholder, ...), keeping its classes:
    // find fields by class, a distinctive parent class, and the nearest data-attr above them.
    const attr = isField ? undefined : el.getAttribute('data-attr') || undefined
    const scope = attr ? undefined : el.parentElement?.closest('[data-attr]')?.getAttribute('data-attr') || undefined
    const stable = c => c && !c.includes('--') && !/[:\[\]@\/]/.test(c)
    const cls = isField ? [...el.classList].filter(stable).sort()[0] : undefined
    const pc = isField ? [...(el.parentElement?.classList ?? [])].filter(stable) : []
    const parentCls = pc.find(c => c.includes('__')) ?? pc.find(c => /^[A-Z]/.test(c)) ?? undefined
    const t = isField ? '' : textOf(el)
    const it = { tag, attr, scope, text: t && t.length <= 80 ? t : undefined, aria: el.getAttribute('aria-label') || undefined,
      placeholder: undefined, cls, parentCls, href: tag === 'a' ? el.getAttribute('href') || undefined : undefined, id: isField ? undefined : el.id || undefined }
    if (isField) it.aria = undefined
    const shown = el.getAttribute('placeholder') || el.getAttribute('aria-label') || undefined
    const label = it.text || it.aria || shown || attr || tag
    const key = 'adhoc:' + [tag, attr, scope, it.text, it.aria, cls, parentCls, it.href, it.id].map(x => x ?? '').join('|')
    const known = byId.get(key)?.agg
    if (known) { if (!silent) queue.push({ type: 'detail', key, adhoc: { ...it, key, label, match: known.key } }); return { key, agg: known } }
    const agg = { id: key, clicks: null, rage: 0, dead: 0, people: 0, label, key: `${scope ? `[data-attr="${scope}"] ` : ''}${parentCls ? `.${parentCls} > ` : ''}${attr ? `[data-attr="${attr}"]` : tag + (cls ? '.' + cls : '')}${it.aria ? ` [aria-label="${it.aria}"]` : ''}${it.text ? ` "${clip(it.text, 40)}"` : ''}` }
    adhoc.set(key, { el, agg }); matches.set(el, agg); byId.set(key, { el, agg })
    queue.push({ type: 'detail', key, adhoc: { ...it, key, label, match: agg.key } })
    return { key, agg }
  }
  function select(id) { selected = id; drawCard(null); draw(); queue.push({ type: 'detail', key: id, keys: byId.get(id)?.agg?.keys }) }
  const prefetched = new Set()
  function prefetch(id) { if (!id || prefetched.has(id)) return; prefetched.add(id); queue.push({ type: 'prefetch', key: id, keys: byId.get(id)?.agg?.keys }) }
  let dwell = 0
  function onKey(e) {
    if (!e.altKey) return
    if (e.code === 'KeyP') { setMode(mode === 'hidden' ? 'ambient' : 'hidden'); e.preventDefault() }
    if (e.code === 'KeyI') { setMode(mode === 'inspect' ? 'ambient' : 'inspect'); e.preventDefault() }
    if (e.code === 'KeyH') { setMode(mode === 'highlights' ? 'ambient' : 'highlights'); e.preventDefault() }
  }
  let raf = 0
  const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw() }) }
  addEventListener('scroll', redraw, true); addEventListener('resize', redraw)
  addEventListener('mousemove', onMove, true); addEventListener('click', onClick, true); addEventListener('keydown', onKey, true)
  // SPA re-renders swap elements under us: re-match now and then.
  const tick = setInterval(() => { if (data && document.visibilityState === 'visible') { match(); findSpots(); drawPill(); draw() } }, 1500)

  globalThis.__perchOverlay = {
    path: () => location.pathname,
    // The server's poll: pending requests, and what's on screen.
    take: () => ({ version: '__OVERLAY_VERSION__', path: location.pathname, href: location.href, mode, selected, loaded: !!data, requests: queue.splice(0) }),
    load(d) { data = d; wantCohort = d.cohort ?? wantCohort; fresh = { at: d.summaryAt ?? null, refreshing: !d.summary || (d.summaryAt && Date.now() - d.summaryAt > 120000) }; if (d.summary) setTimeout(findSpots, 0); if (!d.summary && pendingSummary && pendingSummary.path === d.path) { d.summary = pendingSummary.sum }; pendingSummary = null; match(); drawPill(); drawPanel(); draw(); if (selected && !byId.has(selected)) { selected = null; card.style.display = 'none' } },
    live(l) { if (data) { data.live = l; drawPanel(); draw() } },
    // sum null = only a freshness update (a refresh started behind the numbers on screen)
    summary(sum, meta) {
      if (meta) fresh = { at: meta.at ?? fresh.at, refreshing: !!meta.refreshing }
      // numbers for another page (one the overlay already left) are dropped, never shown under this page's name
      if (sum && meta?.path && data && meta.path !== data.path) return
      if (sum) { if (data) { data.summary = sum; findSpots(); nudge() } else pendingSummary = { sum, path: meta?.path } }
      if (data) { drawPill(); drawPanel(); draw() }
    },
    // fresh badges behind the ones on screen: swap without touching the panel
    items(list) { if (!data) return; data.items = list; match(); drawPill(); drawPanel(); draw() },
    detail(id, d) {
      const a = byId.get(id)?.agg
      if (a && d && !d.error && d.clicks != null && (d.cohort ?? cohort()) === cohort()) { a.clicks = d.clicks; a.rage = d.rage; a.dead = d.dead; a.people = d.people ?? a.people; a.orgs = d.orgs ?? a.orgs }
      if (id === selected) drawCard(d); else draw()
    },
    investigated(id, ok, text) { if (id !== selected) return; const go = root.querySelector('.go'); if (go) { go.textContent = ok ? 'Investigation started in Mothership ✓' : 'Could not start: ' + text } },
    setMode,
    remove() { clearInterval(tick); removeEventListener('scroll', redraw, true); removeEventListener('resize', redraw); removeEventListener('mousemove', onMove, true); removeEventListener('click', onClick, true); removeEventListener('keydown', onKey, true); host?.remove(); delete globalThis.__perchOverlay },
  }
  mount(); drawPill(); drawPanel()
}

// A page keeps the overlay it was given until it reloads; the version lets perch swap in a newer one.
const SRC = perchOverlay.toString()
let h = 0
for (let i = 0; i < SRC.length; i++) h = (h * 31 + SRC.charCodeAt(i)) | 0
export const OVERLAY_VERSION = (h >>> 0).toString(36)
export const OVERLAY_SCRIPT = `(${SRC.replace('__OVERLAY_VERSION__', OVERLAY_VERSION)})()`
