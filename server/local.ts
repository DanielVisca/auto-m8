// Local models through Ollama. Two ways perch uses them:
// - Agent chats: Claude Code itself, pointed at Ollama (it speaks Anthropic's API), so a local
//   model gets all the same tools, MCP and transcripts. Chosen per chat.
// - Background jobs (briefs, sorting, judging, summaries): text in, text out, sent straight to
//   Ollama's chat API. Skipping Claude Code's tool prompt makes them many times faster locally.
// Nothing leaves the machine on this path, and it costs nothing against the subscription.
import { execFile, spawn } from 'node:child_process'
import { totalmem } from 'node:os'
import { promisify } from 'node:util'
import { settings } from './settings.ts'
import { lastSample } from './quiet.ts'

const exec = promisify(execFile)
const base = () => settings.local.baseUrl.replace(/\/$/, '')

export type LocalModel = { name: string; size: number; family: string | null; params: string | null; fits: boolean }
// Models that run well in this much memory, for the "get one" list. Sizes are Ollama's downloads.
const RECOMMENDED = [
  { name: 'qwen3-coder:30b', size: 19e9, why: 'Coding agent: mixture-of-experts, only ~3B active per step, so it is quick.' },
  { name: 'gpt-oss:20b', size: 14e9, why: 'General agent with good tool use; fast.' },
  { name: 'qwen3:8b', size: 5.2e9, why: 'Small and very fast: good for background jobs.' },
]

export async function localStatus() {
  const ram = totalmem()
  // A model needs its weights plus room for context; past ~70% of memory it swaps and crawls.
  const fits = (bytes: number) => bytes < ram * 0.7
  try {
    const [v, t]: any[] = await Promise.all([fetch(`${base()}/api/version`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()), fetch(`${base()}/api/tags`, { signal: AbortSignal.timeout(3000) }).then(r => r.json())])
    const models: LocalModel[] = (t.models ?? []).map((m: any) => ({ name: m.name, size: m.size, family: m.details?.family ?? null, params: m.details?.parameter_size ?? null, fits: fits(m.size) }))
    return { running: true, version: v.version, ram, models, recommended: RECOMMENDED.filter(r => !models.some(m => m.name === r.name)).map(r => ({ ...r, fits: fits(r.size) })), pulling: [...pulls.entries()].map(([name, p]) => ({ name, ...p })) }
  } catch {
    return { running: false, version: null, ram, models: [] as LocalModel[], recommended: RECOMMENDED.map(r => ({ ...r, fits: fits(r.size) })), pulling: [] }
  }
}

// Models Ollama has in memory right now, by name.
export async function loadedModels(): Promise<string[]> {
  try { const r: any = await fetch(`${base()}/api/ps`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()); return (r.models ?? []).map((m: any) => m.name) } catch { return [] }
}
// Free a model's memory now instead of after Ollama's keep-alive (it's tens of GB for a big one).
export async function unloadModel(name: string) {
  await fetch(`${base()}/api/generate`, { method: 'POST', body: JSON.stringify({ model: name, keep_alive: 0 }), signal: AbortSignal.timeout(10_000) }).catch(() => {})
}

// Downloading a model is your call (they're gigabytes); this only runs when you press the button.
const pulls = new Map<string, { status: string; pct: number | null; error?: string }>()
export function pull(name: string) {
  if (!/^[\w.:/-]+$/.test(name)) throw new Error('That isn’t a model name.')
  if (pulls.has(name) && !pulls.get(name)!.error) return { started: false }
  pulls.set(name, { status: 'starting', pct: null })
  const p = spawn('ollama', ['pull', name], { stdio: ['ignore', 'pipe', 'pipe'] })
  const on = (d: Buffer) => { const s = d.toString(); const pct = s.match(/(\d+)%/g)?.pop(); pulls.set(name, { status: s.trim().split(/\r|\n/).pop()!.slice(0, 80), pct: pct ? Number(pct.slice(0, -1)) : null }) }
  p.stdout.on('data', on); p.stderr.on('data', on)
  p.on('exit', code => { if (code) pulls.set(name, { status: 'failed', pct: null, error: `ollama pull exited with ${code}` }); else pulls.delete(name) })
  return { started: true }
}

// Claude Code pointed at Ollama: its own background calls use the same local model.
export const agentEnv = (model: string): NodeJS.ProcessEnv => ({
  ANTHROPIC_BASE_URL: base(), ANTHROPIC_AUTH_TOKEN: 'ollama', ANTHROPIC_API_KEY: '',
  ANTHROPIC_MODEL: model, ANTHROPIC_SMALL_FAST_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
})

// Context sized to the prompt (~3.5 characters a token, plus room to answer), in two fixed sizes:
// Ollama reloads the whole model whenever num_ctx changes, so a size per prompt meant a 19 GB
// reload (~35s, all disk and memory) for nearly every housekeeping job (seen 2026-11-18).
export const ctxFor = (prompt: string, system?: string) => ((prompt.length + (system?.length ?? 0)) / 3.5 + 2048) <= 16384 ? 16384 : 32768

// A background job (prompt in, text out) answered by the local model, speaking the same events the
// callers already read: text deltas, then a result, then perch_done.
export function localJob(args: string[], l: (ev: any) => void) {
  const prompt = args[args.indexOf('-p') + 1] ?? ''
  const system = args.includes('--append-system-prompt') ? args[args.indexOf('--append-system-prompt') + 1] : undefined
  const ctrl = new AbortController()
  const started = Date.now()
  let timedOut = false
  // Ollama queues behind other local requests. A stuck queue must not strand housekeeping.
  const timeout = setTimeout(() => { timedOut = true; ctrl.abort() }, 60_000)
  ;(async () => {
    let text = ''
    try {
      const r = await fetch(`${base()}/api/chat`, { method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: settings.local.model, stream: true, keep_alive: '2m', messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }], options: { num_ctx: ctxFor(prompt, system) } }) })
      if (!r.ok || !r.body) throw new Error(`Ollama answered ${r.status}: ${(await r.text()).slice(0, 200)}`)
      let buf = ''
      for await (const chunk of r.body as any) {
        buf += Buffer.from(chunk).toString('utf8')
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1)
          if (!line.trim()) continue
          const m = JSON.parse(line)
          const t = m.message?.content ?? ''
          if (t) { text += t; l({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } }) }
        }
      }
      // Reasoning models wrap their thinking in <think>…</think>: callers want only the answer.
      const answer = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim()
      l({ type: 'result', subtype: 'success', is_error: false, result: answer, duration_ms: Date.now() - started, total_cost_usd: 0, model: settings.local.model })
      l({ type: 'perch_done', code: 0 })
    } catch (e: any) {
      if (ctrl.signal.aborted && !timedOut) return l({ type: 'perch_done', code: 130 })
      l({ type: 'result', subtype: 'error', is_error: true, result: '', duration_ms: Date.now() - started })
      l({ type: 'perch_done', code: 1, error: timedOut ? 'Local model did not finish within a minute' : `Local model: ${String(e?.message ?? e).slice(0, 300)}` })
    } finally {
      clearTimeout(timeout)
    }
  })()
  return () => ctrl.abort()
}

export const ollamaInstalled = () => exec('ollama', ['--version']).then(() => true, () => false)

// Is Ollama answering? Checked every 30s so a pinned local chat can hand over to Claude or Codex
// the moment it's down, without waiting on a request.
let up = false
// What Ollama has in memory and how big each installed model is, so background jobs can tell
// whether running one would push the Mac into swap.
let resident = new Set<string>()
const sizes = new Map<string, number>()
const ping = () => fetch(`${base()}/api/version`, { signal: AbortSignal.timeout(2500) }).then(async r => {
  up = r.ok
  if (!up) return
  const [ps, tags]: any[] = await Promise.all([fetch(`${base()}/api/ps`, { signal: AbortSignal.timeout(2500) }).then(r => r.json()), fetch(`${base()}/api/tags`, { signal: AbortSignal.timeout(2500) }).then(r => r.json())])
  resident = new Set((ps.models ?? []).map((m: any) => m.name))
  for (const m of tags.models ?? []) sizes.set(m.name, m.size)
}).catch(() => { up = false })
ping(); setInterval(ping, 30_000).unref()
export const localUpSync = () => up

// Room for the local model right now? Seen 2026-11-18: under subscription pressure every
// housekeeping job went to a 19 GB model on a Mac with Chrome, Docker and 40 agents open; swap hit
// 23.7 of 26.6 GB and the perch server stalled 1,010 times in a day (6.5 hours blocked), so chats
// wouldn't load. A model that isn't loaded needs its weights plus headroom free; one that is
// loaded is only used while the machine isn't strained. Unknown memory means no.
const GB = 1024 ** 3
export function localRoom(o: { availBytes?: number; load1?: number; cores?: number; modelBytes?: number; loaded: boolean }) {
  if (o.availBytes == null) return false
  if (o.availBytes < 3 * GB || (o.load1 != null && o.cores != null && o.load1 > o.cores * 2)) return false
  return o.loaded || o.availBytes >= (o.modelBytes ?? 20 * GB) + 6 * GB
}
export function localRoomSync(model = settings.local.model) {
  const s = lastSample()
  return localRoom({ availBytes: s?.availBytes, load1: s?.load1, cores: s?.cores, modelBytes: sizes.get(model), loaded: resident.has(model) })
}
