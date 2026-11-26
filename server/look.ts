// look: let agents see what auto-m8 draws without opening the Agent Chrome. The desktop shell renders
// the page in a hidden offscreen window and returns a picture (shell/main.cjs, startLookServer). It
// finds the shell through look.json in the data folder (port + per-launch token).
// Two things can be looked at: a board (?thumb=<id>, the same view as Explore's previews) or a piece of
// message text with ```tile / ```chart / ```vega-lite blocks, drawn exactly as the chat draws it (?look=<key>).
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './settings.ts'
import { PAGE_SCRIPT } from './browserpage.ts'
import { isIrreversible } from './browser.ts'

type Handler = (m: RegExpMatchArray, req: IncomingMessage, res: ServerResponse, q: URLSearchParams) => any
type Route = (method: string, path: string, h: Handler) => void
type Body = (req: IncomingMessage) => Promise<any>

// Text waiting to be drawn, by one-off key. Kept briefly: the shell loads it within seconds.
const pending = new Map<string, { text: string; at: number }>()
const sweep = () => { const cut = Date.now() - 120_000; for (const [k, v] of pending) if (v.at < cut) pending.delete(k) }

export const LOOK_LIMITS = 'Static picture only (for clicking through auto-m8, use look action=open/act). Needs the auto-m8 desktop app running.'

function shell(): { port: number; token: string } | null {
  try { const j = JSON.parse(readFileSync(join(DATA_DIR, 'look.json'), 'utf8')); return j.port && j.token ? j : null } catch { return null }
}

async function picture(args: any, port: number): Promise<{ text: string; image?: string; error?: boolean }> {
  const s = shell()
  if (!s) return { error: true, text: "Can't look: the auto-m8 desktop app isn't running (look renders inside it). Use the browser tool on this page instead." }
  const theme = args.theme === 'light' || args.theme === 'dark' ? `&theme=${args.theme}` : '&theme=dark'
  let url: string, what: string
  if (args.board_id) { url = `http://127.0.0.1:${port}/?thumb=${encodeURIComponent(String(args.board_id))}${theme}`; what = `board ${args.board_id}` }
  else if (typeof args.text === 'string' && args.text.trim()) {
    sweep()
    const key = randomBytes(12).toString('hex')
    pending.set(key, { text: args.text, at: Date.now() })
    url = `http://127.0.0.1:${port}/?look=${key}${theme}`; what = 'the text'
  } else return { error: true, text: 'Give board_id (a board) or text (message text with ```tile / ```chart blocks, drawn as the chat draws it).' }
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/look`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-look-token': s.token },
      body: JSON.stringify({ url, width: args.width, height: args.height, wait_ms: args.wait_ms, fit: args.fit }),
      signal: AbortSignal.timeout(45_000),
    })
    const j: any = await r.json()
    if (!r.ok || !j.image) return { error: true, text: `Can't look: ${j.error ?? r.status}. Fall back to the browser tool if you must see it.` }
    return { text: `Rendered ${what} offscreen in auto-m8 at ${j.width}×${j.height} after ${Number(args.wait_ms) || 4000}ms. ${LOOK_LIMITS} If a tile still shows "loading", look again with a longer wait_ms.`, image: j.image }
  } catch (e: any) {
    return { error: true, text: `Can't look: the auto-m8 app didn't answer (${e.message}). It may have been restarted; use the browser tool if you must see it now.` }
  }
}

export function lookRoutes(route: Route, body: Body, port: number) {
  route('POST', '/api/look', async (_m, req) => look(await body(req), port))
  route('GET', '/api/look/:key', m => { const p = pending.get(m[1]); return p ? { text: p.text } : { error: 'expired' } })
}

// ---------- interactive: click through auto-m8's own UI, to test it ----------
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function drive(op: string, owner: string, extra: any = {}) {
  const s = shell()
  if (!s) throw new Error("the auto-m8 desktop app isn't running (look drives a hidden window inside it)")
  const r = await fetch(`http://127.0.0.1:${s.port}/drive`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-look-token': s.token }, body: JSON.stringify({ op, owner, ...extra }), signal: AbortSignal.timeout(45_000) })
  const j: any = await r.json().catch(() => ({ error: `shell answered ${r.status}` }))
  if (!r.ok || j.error) throw new Error(j.error ?? `shell answered ${r.status}`)
  return j
}
const cdp = (owner: string, method: string, params: any) => drive('cdp', owner, { method, params }).then(j => j.result)
async function page(owner: string, fn: string, ...args: any[]) {
  const r = await cdp(owner, 'Runtime.evaluate', { expression: `${PAGE_SCRIPT}; __perch.${fn}(${args.map(a => JSON.stringify(a)).join(',')})`, returnByValue: true })
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split('\n')[0])
  return r.result.value
}
async function find(owner: string, st: any) {
  if (st.ref) return st.ref
  if (!st.name) throw new Error('give ref (from the snapshot) or name')
  for (const role of st.role ? [st.role] : ['button', 'link', 'textbox', 'tab', 'menuitem', 'option', 'checkbox', 'combobox', 'searchbox', 'clickable']) {
    const r = await page(owner, 'locate', { role, name: st.name }, { exactOnly: !st.role })
    if (r?.ref) return r.ref
  }
  throw new Error(`couldn't find "${st.name}"`)
}
const KEYS: Record<string, [string, number, string?]> = { Enter: ['Enter', 13, '\r'], Escape: ['Escape', 27], Tab: ['Tab', 9], Backspace: ['Backspace', 8], ArrowDown: ['ArrowDown', 40], ArrowUp: ['ArrowUp', 38], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39] }
async function press(owner: string, name: string) {
  // Enter in a textarea or rich editor sends a chat message or a note for real; that's not a test click.
  if (/(^|\+)Enter$/.test(name) && await cdp(owner, 'Runtime.evaluate', { expression: `(() => { const e = document.activeElement; return !!e && (e.tagName === 'TEXTAREA' || e.isContentEditable) })()`, returnByValue: true }).then(r => r.result?.value))
    throw new Error('refused: Enter in a message box sends it for real on live auto-m8 data. Type to test the box; send messages with send_to_conversation.')
  const parts = name.split('+'), base = parts.pop()!
  const mods = parts.reduce((m, p) => m | (({ Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 } as any)[p] ?? 0), 0)
  const [key, code, text] = (KEYS[base] as [string, number, string?] | undefined) ?? (base.length === 1 ? [base, base.toUpperCase().charCodeAt(0), base] : [])
  if (!key) throw new Error(`unknown key ${name}`)
  const t = mods & ~8 ? undefined : text
  await cdp(owner, 'Input.dispatchKeyEvent', { type: t ? 'keyDown' : 'rawKeyDown', modifiers: mods, key, windowsVirtualKeyCode: code, text: t })
  await cdp(owner, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mods, key, windowsVirtualKeyCode: code })
}
async function step(owner: string, st: any): Promise<string> {
  const settle = () => sleep(Math.min(10_000, Number(st.ms) || 600))
  if (st.do === 'press') { await press(owner, String(st.key ?? 'Enter')); await settle(); return `pressed ${st.key ?? 'Enter'}` }
  if (st.do === 'wait') {
    if (st.text) { const until = Date.now() + Math.min(Number(st.ms) || 10_000, 30_000); while (Date.now() < until) { if (await page(owner, 'hasText', st.text)) return `saw "${st.text}"`; await sleep(200) } throw new Error(`"${st.text}" didn't appear`) }
    await sleep(Math.min(Number(st.ms) || 1000, 15_000)); return 'waited'
  }
  if (st.do === 'scroll') {
    const by = Number(st.value) || 600
    if (st.ref || st.name) { const ref = await find(owner, st); await cdp(owner, 'Runtime.evaluate', { expression: `${PAGE_SCRIPT}; __perch.el(${JSON.stringify(ref)})?.scrollBy(0, ${by})` }) }
    else await cdp(owner, 'Runtime.evaluate', { expression: `(document.scrollingElement||document.body).scrollBy(0, ${by})` })
    await sleep(300); return `scrolled ${by}px`
  }
  const ref = await find(owner, st)
  const info = await page(owner, 'info', ref)
  if (!info) throw new Error(`${ref} is gone (the page changed); take a new snapshot`)
  // Testing only: this window is the real app on live data. Sending, deleting, merging and the like
  // belong to the tools built for them (canvas, send_to_conversation, shepherd…), not a test click.
  if ((st.do === 'click' || st.submit) && isIrreversible(info)) throw new Error(`refused: ${info.role} "${info.name}" looks irreversible, and look acts on live auto-m8 data. Do that with the tool built for it, not a UI click.`)
  if (st.do === 'click' || st.do === 'hover') {
    const p = await page(owner, 'point', ref)
    if (p.error) throw new Error(`${ref} is gone; take a new snapshot`)
    if (p.covered && !st.force && st.do === 'click') throw new Error(`${info.role} "${info.name}" is covered by ${p.covered} (close it first, or force:true)`)
    await cdp(owner, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
    if (st.do === 'click') {
      await cdp(owner, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
      await cdp(owner, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 })
    }
    await settle(); return `${st.do} ${info.role} "${info.name}"`
  }
  if (st.do === 'type' || st.do === 'fill') {
    const f = await page(owner, 'focusForTyping', ref, st.do === 'fill')
    if (f.error) throw new Error(`${ref} is gone; take a new snapshot`)
    if (st.do === 'fill') { await cdp(owner, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', windowsVirtualKeyCode: 8 }); await cdp(owner, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', windowsVirtualKeyCode: 8 }) }
    if (st.value) await cdp(owner, 'Input.insertText', { text: String(st.value) })
    if (st.submit) await press(owner, 'Enter')
    await settle(); return `${st.do} ${info.role} "${info.name}" = "${String(st.value ?? '').slice(0, 60)}"`
  }
  if (st.do === 'select') { const r = await page(owner, 'selectOption', ref, st.value ?? ''); if (r.error) throw new Error(r.error); await settle(); return `selected ${r.selected}` }
  throw new Error(`unknown step ${st.do} (click, hover, type, fill, select, press, scroll, wait)`)
}
async function view(owner: string, args: any) {
  const snap = await page(owner, 'snapshot', { mode: args.mode === 'full' ? 'full' : 'interactive', find: args.find, max: 5000 })
  const out: { text: string; image?: string } = { text: `${snap.title} · ${snap.url}\n${snap.text}` }
  if (args.screenshot) out.image = (await drive('shot', owner)).image
  return out
}

export async function look(args: any, port: number): Promise<{ text: string; image?: string; error?: boolean }> {
  const a = String(args.action ?? 'picture'), owner = String(args.owner || 'default')
  if (a === 'picture') return picture(args, port)
  try {
    if (a === 'close') { await drive('close', owner); return { text: 'Closed the hidden window.' } }
    if (a === 'open') {
      const path = String(args.path ?? '/').replace(/^(?!\/)/, '/')
      if (/^\/\//.test(path)) return { error: true, text: 'path is a path inside auto-m8, like /#chat/<id> or /#explore. For other sites use the browser tool.' }
      await drive('open', owner, { url: `http://127.0.0.1:${port}${path}`, width: args.width, height: args.height })
      await sleep(Math.min(20_000, Number(args.wait_ms) || 2500))
      const v = await view(owner, args)
      return { ...v, text: `Opened ${path} in a hidden auto-m8 window. Act on refs with action=act steps=[...].\n${v.text}` }
    }
    if (a === 'snapshot') return await view(owner, args)
    if (a === 'act') {
      const lines: string[] = []
      for (const [i, st] of (Array.isArray(args.steps) ? args.steps : []).entries()) {
        try { lines.push(`${i + 1}. ${await step(owner, st)}`) } catch (e: any) { lines.push(`${i + 1}. FAILED ${st.do} ${st.ref ?? st.name ?? ''}: ${e.message}`); break }
      }
      if (!lines.length) return { error: true, text: 'Give steps: [{do:"click", ref:"e12"}, {do:"type", ref:"e3", value:"…"}, {do:"press", key:"Escape"}, {do:"wait", text:"…"}]' }
      const v = await view(owner, args)
      return { ...v, text: `${lines.join('\n')}\n---\n${v.text}`, error: lines.some(l => / FAILED /.test(l)) || undefined }
    }
    return { error: true, text: 'action must be picture (default), open, snapshot, act or close.' }
  } catch (e: any) {
    return { error: true, text: `look ${a} failed: ${e.message}${/isn't running|ECONNREFUSED|fetch failed/.test(e.message) ? ' Use the browser tool on http://127.0.0.1:' + port + '/ instead.' : ''}` }
  }
}
