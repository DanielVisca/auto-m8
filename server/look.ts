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

type Handler = (m: RegExpMatchArray, req: IncomingMessage, res: ServerResponse, q: URLSearchParams) => any
type Route = (method: string, path: string, h: Handler) => void
type Body = (req: IncomingMessage) => Promise<any>

// Text waiting to be drawn, by one-off key. Kept briefly: the shell loads it within seconds.
const pending = new Map<string, { text: string; at: number }>()
const sweep = () => { const cut = Date.now() - 120_000; for (const [k, v] of pending) if (v.at < cut) pending.delete(k) }

export const LOOK_LIMITS = 'Static picture only: no clicking, hovering, typing or scrolling, and no app pages other than boards and message text. Needs the auto-m8 desktop app running.'

function shell(): { port: number; token: string } | null {
  try { const j = JSON.parse(readFileSync(join(DATA_DIR, 'look.json'), 'utf8')); return j.port && j.token ? j : null } catch { return null }
}

export async function look(args: any, port: number): Promise<{ text: string; image?: string; error?: boolean }> {
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
