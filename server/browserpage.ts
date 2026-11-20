// @ts-nocheck
// The script perch runs inside each page, in an isolated world (page scripts can't see or break it,
// and it survives strict CSP). It builds compact snapshots with stable refs, reads text, and turns
// any element into a robust locator (test id, role+name, label) that cached paths can find again.
function perchPage() {
  if (globalThis.__perch) return
  const refs = new Map() // ref -> WeakRef(element)
  const ids = new WeakMap() // element -> ref
  let next = 1
  const refOf = el => {
    let r = ids.get(el)
    if (!r) { r = 'e' + next++; ids.set(el, r); refs.set(r, new WeakRef(el)) }
    return r
  }
  const clip = (s, n) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
  const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem', 'clickable'])

  function roleOf(el) {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit.split(' ')[0]
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : ''
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'option') return 'option'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'img') return 'img'
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase()
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      if (t === 'range') return 'slider'
      if (t === 'number') return 'spinbutton'
      if (t === 'search') return 'searchbox'
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button'
      if (t === 'hidden') return ''
      return 'textbox'
    }
    if (el.isContentEditable && el.getAttribute('contenteditable') !== null) return 'textbox'
    if (el.hasAttribute('onclick') || el.getAttribute('tabindex') === '0') return 'clickable'
    return ''
  }

  function textOf(el) { return clip(el.innerText ?? el.textContent ?? '', 100) }
  // A label's own words, without the text of controls inside it (a <select>'s options, say).
  function ownLabel(l) {
    if (!l.querySelector('input,select,textarea,button')) return l.innerText || l.textContent || ''
    const c = l.cloneNode(true)
    c.querySelectorAll('input,select,textarea,button').forEach(x => x.remove())
    return c.textContent || ''
  }
  function labelText(el) {
    if (el.labels && el.labels.length) return [...el.labels].map(ownLabel).join(' ')
    const wrap = el.closest && el.closest('label')
    return wrap ? ownLabel(wrap) : ''
  }
  function nameOf(el) {
    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const t = by.split(/\s+/).map(id => el.ownerDocument.getElementById(id)?.innerText || '').join(' ').trim()
      if (t) return clip(t, 100)
    }
    const aria = el.getAttribute('aria-label')
    if (aria && aria.trim()) return clip(aria, 100)
    const tag = el.tagName.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const t = (el.getAttribute('type') || '').toLowerCase()
      if (['submit', 'button', 'reset'].includes(t)) return clip(el.value || t, 100)
      const l = labelText(el)
      if (l.trim()) return clip(l, 100)
      return clip(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '', 100)
    }
    if (tag === 'img') return clip(el.getAttribute('alt') || el.getAttribute('title') || '', 100)
    const t = textOf(el)
    if (t) return t
    const img = el.querySelector && el.querySelector('img[alt],svg[aria-label],[aria-label]')
    if (img) return clip(img.getAttribute('alt') || img.getAttribute('aria-label') || '', 100)
    return clip(el.getAttribute('title') || '', 100)
  }

  function visible(el) {
    if (!el.isConnected) return false
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || Number(s.opacity) === 0) return false
    if (el.closest('[aria-hidden="true"],[inert]')) return false
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) {
      // radios/checkboxes are often visually hidden behind a styled label; keep them if the label shows
      const l = el.labels && el.labels[0]
      return !!(l && l.getBoundingClientRect().width > 0)
    }
    return true
  }

  const isInteractive = (el, role) => INTERACTIVE_ROLES.has(role) || role === 'listbox'

  // Walk the DOM and open shadow roots, in document order.
  function* walk(root) {
    const stack = [root]
    while (stack.length) {
      const node = stack.pop()
      const kids = []
      if (node.shadowRoot) kids.push(...node.shadowRoot.children)
      kids.push(...(node.children || []))
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
      if (node.nodeType === 1) yield node
    }
  }

  function states(el, role) {
    const out = []
    const tag = el.tagName.toLowerCase()
    if (role === 'checkbox' || role === 'radio' || role === 'switch') out.push(`checked=${el.checked ?? el.getAttribute('aria-checked') === 'true'}`)
    else if ((tag === 'input' || tag === 'textarea') && role !== 'button') out.push(`value="${clip(el.type === 'password' ? (el.value ? '••••' : '') : el.value, 60)}"`)
    else if (el.isContentEditable && role === 'textbox') out.push(`value="${clip(el.innerText, 60)}"`)
    if (tag === 'select') {
      const opts = [...el.options].slice(0, 12).map(o => (o.selected ? '*' : '') + clip(o.label, 30))
      out.push(`options=[${opts.join(' | ')}${el.options.length > 12 ? ` | …${el.options.length - 12} more` : ''}]`)
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled')
    const exp = el.getAttribute('aria-expanded'); if (exp) out.push(`expanded=${exp}`)
    if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current')) out.push('current')
    if (el.required) out.push('required')
    if (role === 'link') {
      const href = el.getAttribute('href') || ''
      if (href && !href.startsWith('javascript:')) {
        let h = href
        try { const u = new URL(href, location.href); h = u.origin === location.origin ? u.pathname + u.search : u.host + u.pathname } catch {}
        out.push(`→ ${clip(h, 60)}`)
      }
    }
    return out
  }

  function inViewport(r) { return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth }

  // opts: { mode: 'interactive' | 'full', find, max, viewport }
  function snapshot(opts = {}) {
    const max = opts.max || 6000
    const find = (opts.find || '').toLowerCase()
    const lines = []
    let used = 0, skipped = 0, total = 0
    const seenText = new Set()
    for (const el of walk(document.documentElement)) {
      const tag = el.tagName.toLowerCase()
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template' || tag === 'head') continue
      const role = roleOf(el)
      let line = ''
      if (role === 'heading') {
        if (!visible(el)) continue
        const lvl = el.getAttribute('aria-level') || tag.slice(1) || '2'
        line = `${'#'.repeat(Number(lvl) || 2)} ${clip(el.innerText, 120)}`
        if (el.querySelector('a,button')) line += ` [${refOf(el)}]`
      } else if (isInteractive(el, role) && role) {
        // a focusable container wrapping real controls is noise; its controls are listed
        if (role === 'clickable' && el.querySelector('a[href],button,input,select,textarea,[role=button],[role=link]')) continue
        if (!visible(el)) continue
        // a link/button wrapping only another control: the inner one is listed
        const name = nameOf(el)
        const st = states(el, role)
        line = `[${refOf(el)}] ${role}${name ? ` "${name}"` : ''}${st.length ? ' ' + st.join(' ') : ''}`
      } else if (opts.mode === 'full' && !el.children.length && (tag === 'p' || tag === 'li' || tag === 'td' || tag === 'span' || tag === 'div' || tag === 'dd' || tag === 'dt' || tag === 'pre' || tag === 'code' || tag === 'label' || tag === 'th')) {
        const t = clip(el.innerText, 200)
        if (!t || seenText.has(t) || !visible(el)) continue
        seenText.add(t)
        line = `  ${t}`
      } else continue
      total++
      if (find && !line.toLowerCase().includes(find)) continue
      if (opts.viewport && !inViewport(el.getBoundingClientRect())) continue
      if (used + line.length + 1 > max) { skipped++; continue }
      lines.push(line); used += line.length + 1
    }
    const head = `${clip(document.title, 90)} — ${location.href}`
    const scroll = `scroll ${Math.round(scrollY)}/${Math.max(0, document.documentElement.scrollHeight - innerHeight)}`
    return { text: [head, ...lines].join('\n') + (skipped ? `\n… ${skipped} more not shown (pass find:"…" to filter, or viewport:true)` : ''), count: total, skipped, scroll, url: location.href, title: document.title }
  }

  function el(ref) { const w = refs.get(ref); const e = w && w.deref(); return e && e.isConnected ? e : null }

  // Main readable text: article/main if there is one, else the body.
  function text(max = 8000) {
    const root = document.querySelector('article, main, [role=main]') || document.body
    let t = (root?.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    if (!t && document.body) t = document.body.innerText.trim()
    if (!t) t = document.documentElement.textContent?.trim() || ''
    return { text: t.length > max ? t.slice(0, max) + `\n… (${t.length - max} more chars)` : t, url: location.href, title: document.title }
  }

  // ---- robust locators for cached paths ----
  const norm = s => (s || '').toLowerCase().replace(/[ \s]+/g, ' ').trim()
  // Names that carry data ("Star (40.8k)", "3 unread") are cached as a pattern so they still match tomorrow.
  function namePattern(name) {
    if (!/\d/.test(name)) return null
    return '^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\d+(?:[.,]\d+)*[kKmMbB]?/g, '[\\d.,]+[kKmMbB]?') + '$'
  }
  function describe(e) {
    if (typeof e === 'string') e = el(e)
    if (!e) return null
    const role = roleOf(e)
    const name = nameOf(e)
    const testid = e.getAttribute('data-testid') || e.getAttribute('data-test-id') || e.getAttribute('data-test') || e.getAttribute('data-qa') || ''
    const id = e.id && !/\d{3,}|[:]|^ember|^react/.test(e.id) ? e.id : ''
    const sameRole = candidates(role)
    const sameName = sameRole.filter(c => norm(nameOf(c)) === norm(name))
    const loc = { role, name, pattern: namePattern(name), testid, id, tag: e.tagName.toLowerCase(), nth: Math.max(0, sameName.indexOf(e)),
      label: clip(labelText(e), 80), placeholder: e.getAttribute('placeholder') || '', inputName: e.getAttribute('name') || '', css: cssPath(e) }
    return loc
  }
  function cssPath(e) {
    const parts = []
    while (e && e.nodeType === 1 && parts.length < 6) {
      let p = e.tagName.toLowerCase()
      if (e.id && !/\d{3,}/.test(e.id)) { parts.unshift(`#${CSS.escape(e.id)}`); break }
      const sib = e.parentElement ? [...e.parentElement.children].filter(c => c.tagName === e.tagName) : []
      if (sib.length > 1) p += `:nth-of-type(${sib.indexOf(e) + 1})`
      parts.unshift(p)
      e = e.parentElement
    }
    return parts.join(' > ')
  }
  function candidates(role) {
    const out = []
    for (const e of walk(document.documentElement)) if (roleOf(e) === role && visible(e)) out.push(e)
    return out
  }
  function sim(a, b) {
    a = norm(a); b = norm(b)
    if (!a || !b) return 0
    if (a === b) return 1
    if (a.includes(b) || b.includes(a)) return 0.8 * Math.min(a.length, b.length) / Math.max(a.length, b.length) + 0.2
    const ta = new Set(a.split(/\W+/).filter(Boolean)), tb = new Set(b.split(/\W+/).filter(Boolean))
    let n = 0; for (const t of ta) if (tb.has(t)) n++
    return n / Math.max(ta.size, tb.size, 1)
  }
  // Exact first (test id, id, role+name or pattern, label, input name), then fuzzy by name among the same role.
  // Returns { ref, how, score, ambiguous }.
  function locate(loc, opts = {}) {
    const pick = (e, how, score = 1, ambiguous = false) => ({ ref: refOf(e), how, score, ambiguous })
    if (loc.testid) {
      const m = [...document.querySelectorAll(`[data-testid="${CSS.escape(loc.testid)}"],[data-test-id="${CSS.escape(loc.testid)}"],[data-test="${CSS.escape(loc.testid)}"],[data-qa="${CSS.escape(loc.testid)}"]`)].filter(visible)
      if (m.length === 1) return pick(m[0], 'testid')
    }
    if (loc.id) { const e = document.getElementById(loc.id); if (e && visible(e) && roleOf(e) === loc.role) return pick(e, 'id') }
    const cands = candidates(loc.role)
    const exact = cands.filter(c => norm(nameOf(c)) === norm(loc.name))
    if (exact.length) return pick(exact[Math.min(loc.nth || 0, exact.length - 1)], 'role+name', 1, exact.length > 1 && !loc.nth)
    if (loc.pattern) {
      const re = new RegExp(loc.pattern, 'i')
      const m = cands.filter(c => re.test(nameOf(c).replace(/ /g, ' ')))
      if (m.length) return pick(m[Math.min(loc.nth || 0, m.length - 1)], 'pattern', 0.95, m.length > 1)
    }
    if (loc.label) { const m = cands.filter(c => norm(labelText(c)) === norm(loc.label)); if (m.length === 1) return pick(m[0], 'label', 0.95) }
    if (loc.inputName) { const m = cands.filter(c => c.getAttribute('name') === loc.inputName); if (m.length === 1) return pick(m[0], 'input name', 0.9) }
    if (loc.placeholder) { const m = cands.filter(c => c.getAttribute('placeholder') === loc.placeholder); if (m.length === 1) return pick(m[0], 'placeholder', 0.9) }
    if (opts.exactOnly) return null
    const scored = cands.map(c => ({ c, s: sim(nameOf(c), loc.name) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s)
    if (scored.length) {
      const [best, second] = scored
      const margin = second ? best.s - second.s : best.s
      return pick(best.c, 'fuzzy name', best.s, !!second && margin < 0.25)
    }
    if (loc.css) { try { const e = document.querySelector(loc.css); if (e && visible(e)) return pick(e, 'css', 0.5) } catch {} }
    return null
  }

  // Scroll into view, then the point a real click should land on, and what is actually on top there.
  function point(ref) {
    const e = el(ref)
    if (!e) return { error: 'gone' }
    let target = e
    const r0 = e.getBoundingClientRect()
    if (r0.width === 0 && r0.height === 0 && e.labels && e.labels[0]) target = e.labels[0]
    target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    const r = target.getBoundingClientRect()
    const x = r.left + Math.min(r.width / 2, Math.max(1, r.width - 2)), y = r.top + Math.min(r.height / 2, Math.max(1, r.height - 2))
    const top = document.elementFromPoint(x, y)
    const covered = top && !(target === top || target.contains(top) || top.contains(target) || (e.labels && [...e.labels].some(l => l.contains(top))))
    return { x, y, covered: covered ? `${top.tagName.toLowerCase()}${top.id ? '#' + top.id : ''} "${clip(top.innerText || '', 40)}"` : '' }
  }

  function focusForTyping(ref, clear) {
    const e = el(ref)
    if (!e) return { error: 'gone' }
    e.scrollIntoView({ block: 'center', behavior: 'instant' })
    e.focus()
    if (clear) {
      if (typeof e.select === 'function' && ('value' in e)) e.select()
      else if (e.isContentEditable) { const s = getSelection(); const rg = document.createRange(); rg.selectNodeContents(e); s.removeAllRanges(); s.addRange(rg) }
    }
    return { ok: document.activeElement === e || e.contains(document.activeElement) }
  }

  function selectOption(ref, value) {
    const e = el(ref)
    if (!e) return { error: 'gone' }
    if (e.tagName.toLowerCase() !== 'select') return { error: 'not a <select>; click it and pick the option instead' }
    const want = norm(String(value))
    const opt = [...e.options].find(o => norm(o.label) === want || norm(o.value) === want) || [...e.options].find(o => norm(o.label).includes(want))
    if (!opt) return { error: `no option "${value}"; options: ${[...e.options].map(o => o.label).join(', ')}` }
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(e, opt.value)
    e.dispatchEvent(new Event('input', { bubbles: true }))
    e.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, selected: opt.label }
  }

  function info(ref) {
    const e = el(ref)
    if (!e) return null
    return { role: roleOf(e), name: nameOf(e), tag: e.tagName.toLowerCase(), type: e.getAttribute('type') || '',
      form: e.form ? (e.form.getAttribute('action') || location.pathname) : '', href: e.getAttribute('href') || '' }
  }

  function hasText(s) { return (document.body?.innerText || '').toLowerCase().includes(String(s).toLowerCase()) }

  globalThis.__perch = { snapshot, el, text, describe, locate, point, focusForTyping, selectOption, info, hasText, refOf }
}

export const PAGE_SCRIPT = `(${perchPage.toString()})()`
