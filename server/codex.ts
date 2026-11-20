// Codex (OpenAI's coding agent, on the ChatGPT plan) as the fallback when every Claude model is at
// its cap. A chat keeps going on Codex with the same context:
// - the conversation so far (condensed from the Claude transcript) and perch's own instructions go
//   in as the hand-off, and Codex's turns are written back into the same transcript, so the chat
//   reads as one thread and Claude, once it's back, sees what Codex did;
// - the same MCP servers: perch's (with this conversation's id) plus everything in Codex's config,
//   which agentsync.ts keeps in step with Claude Code's;
// - the same instructions and memory: agentsync.ts writes ~/.codex/AGENTS.md from CLAUDE.md and the
//   memory index, and links Claude's skills into ~/.codex/skills.
// Codex runs one process per turn (`codex exec --json`, then `exec resume <thread>`), and its
// events are translated into the stream-json events the chat already reads.
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { get, run } from './db.ts'
import { DATA_DIR, HOME } from './settings.ts'
import { durableRun, savedRuns, type RunRecord } from './durable-run.ts'
import { codexExhausted } from './usage.ts'
import { claudePeer, codexPeer, modelTier, type ModelTier } from './model-tiers.ts'

const exec = promisify(execFile)
const CANDIDATES = [
  process.env.CODEX_CLI_PATH ?? '',
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  '/Applications/Codex.app/Contents/Resources/codex',
  '/opt/homebrew/bin/codex', '/usr/local/bin/codex', join(HOME, '.local/bin/codex'),
]
// The models this ChatGPT plan offers (Codex's own cache, refreshed by the Codex app), and the one
// set as default in ~/.codex/config.toml. Picked per chat as `codex:<slug>`.
export function codexModels(): { slug: string; name: string; tier: ModelTier; blurb: string }[] {
  try {
    const d = JSON.parse(readFileSync(join(HOME, '.codex/models_cache.json'), 'utf8'))
    return (d.models ?? []).filter((m: any) => m.visibility === 'list' && m.slug).sort((a: any, b: any) => (a.priority ?? Infinity) - (b.priority ?? Infinity)).map((m: any) => ({ slug: String(m.slug), name: String(m.display_name ?? m.slug), tier: modelTier(String(m.slug)), blurb: String(m.description ?? '') }))
  } catch { return [] }
}
export const codexDefaultModel = () => { try { return readFileSync(join(HOME, '.codex/config.toml'), 'utf8').match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? null } catch { return null } }
export const codexFallbackModel = (model: string) => codexPeer(model, codexModels(), codexDefaultModel())
export const claudeFallbackTier = (model?: string) => claudePeer(model || codexDefaultModel() || '')
export const codexBin = () => CANDIDATES.find(p => p && existsSync(p)) ?? null

// Signed in (ChatGPT plan) and not itself at a limit. Checked at most once a minute.
let status: { ok: boolean; at: number; why: string } = { ok: false, at: 0, why: 'not checked yet' }
let cappedUntil = 0
export async function codexReady(): Promise<{ ok: boolean; why: string }> {
  if (cappedUntil > Date.now()) return { ok: false, why: `Codex is at its limit until ${new Date(cappedUntil).toLocaleTimeString()}` }
  if (codexExhausted()) return { ok: false, why: 'Codex reports an exhausted allowance or a spend control, with no usable credit continuation' }
  if (Date.now() - status.at < 60_000) return status
  const bin = codexBin()
  if (!bin) status = { ok: false, at: Date.now(), why: 'Codex CLI not found (install the ChatGPT or Codex app)' }
  else {
    const out = await exec(bin, ['login', 'status'], { timeout: 15_000 }).then(r => `${r.stdout}${r.stderr}`, e => String(e?.stdout ?? '') + String(e?.stderr ?? e?.message ?? ''))
    status = /logged in/i.test(out) && !/not logged in/i.test(out) ? { ok: true, at: Date.now(), why: 'signed in' } : { ok: false, at: Date.now(), why: 'Codex is signed out (codex login)' }
  }
  return status
}
// The last answer, refreshed in the background when it's over a minute old (sign-outs are rare).
export const codexReadySync = () => { if (Date.now() - status.at > 60_000) codexReady().catch(() => {}); return cappedUntil <= Date.now() && status.ok && !codexExhausted() }
codexReady().catch(() => {})

run('create table if not exists codex_threads (conversation_id text primary key, thread_id text not null, at integer not null)')
export const codexThread = (id: string) => get<{ thread_id: string }>('select thread_id from codex_threads where conversation_id = ?', id)?.thread_id ?? null
export const forgetCodexThread = (id: string) => run('delete from codex_threads where conversation_id = ?', id)

const toml = (s: string) => JSON.stringify(s) // a TOML basic string is a JSON string
function argsFor(o: { model?: string; conversationId?: string; mcpScript?: string; node?: string; mode: string; system?: string; thread?: string | null; prompt: string; images?: string[]; textOnly?: boolean }) {
  const a = ['exec', ...(o.thread ? ['resume', o.thread] : []), '--json', '--skip-git-repo-check']
  // Same reach as the Claude chat: in auto or bypass mode it runs commands unsandboxed (gh and git
  // need the keychain and network); in plan or ask mode it can only read.
  if (o.textOnly || o.mode === 'plan' || o.mode === 'default') a.push('-c', 'sandbox_mode="read-only"')
  else a.push('--dangerously-bypass-approvals-and-sandbox')
  if (o.textOnly) a.push('--ephemeral', '-c', 'mcp_servers={}')
  else if (o.mcpScript && o.node) {
    // perch's own tools are pre-approved: in a read-only (plan/default) chat Codex otherwise refuses every MCP call.
    a.push('-c', `mcp_servers.perch.command=${toml(o.node)}`, '-c', `mcp_servers.perch.args=[${toml(o.mcpScript)}]`, '-c', 'mcp_servers.perch.default_tools_approval_mode="approve"')
    if (o.conversationId) a.push('-c', `mcp_servers.perch.env={PERCH_CONVERSATION_ID=${toml(o.conversationId)},PERCH_AGENT="Mothership chat (codex)"}`)
  }
  if (o.model) a.push('-m', o.model)
  if (o.system) a.push('-c', `developer_instructions=${toml(o.system)}`)
  for (const img of o.images ?? []) a.push('-i', img)
  a.push('--', o.prompt)
  return a
}

// "You hit your spend cap set by the owner of your workspace" is a cap too: without it the chat got an
// empty "(no reply)" instead of moving to Claude, and Codex kept being picked.
const CODEX_CAP = /usage limit|rate limit|quota|too many requests|limit reached|try again (in|at)|spend(?:ing)? (?:cap|limit)/i
// How long to stop routing to Codex after a cap. A workspace spend cap set by an owner doesn't lift on
// its own within the hour, so retrying hourly cost a failed turn each time; usage and rate limits do.
export const codexCapMs = (problem: string) => /spend(?:ing)? (?:cap|limit)|set by the owner|workspace/i.test(problem) ? 12 * 3_600_000 : 3_600_000

// One Codex turn, its events translated to Claude Code's stream-json shape: assistant messages
// with text and tool_use blocks, user messages with tool_results, then a result.
const CODEX_RUNS = join(DATA_DIR, 'codex-runs')
export const recoverableCodex = () => savedRuns<any>(CODEX_RUNS)
export type CodexProcess = { kill: (signal?: NodeJS.Signals) => void; saveQueue: (queue: any[]) => void }

export function codexTurn(o: { conversationId: string; cwd: string; mode: string; model?: string; system?: string; prompt: string; images?: string[]; mcpScript: string; node: string; env: NodeJS.ProcessEnv; message?: (r: { itemId: string; text: string; model: string }) => string; before?: (r: { ok: boolean; text: string; tools: string[] }) => void; recovery?: any; saved?: RunRecord }, l: (ev: any) => void) {
  const bin = codexBin()!
  const thread = codexThread(o.conversationId)
  const started = o.saved?.started ?? Date.now()
  const texts: string[] = [], tools: string[] = []
  let usage: any = null, failed = '', replaying = false, completed = false
  const publish = (ev: any) => { if (!replaying) l(ev) }
  const model = o.model ? `codex:${o.model}` : 'codex'
  const assistant = (content: any[], uuid?: string) => publish({ type: 'assistant', uuid, message: { id: randomUUID(), role: 'assistant', model, content } })
  const result = (r: any) => publish({ type: 'user', message: { role: 'user', content: [r] } })
  const out = (s: unknown) => typeof s === 'string' ? s : JSON.stringify(s ?? '')
  const onItem = (kind: string, it: any) => {
    if (it.type === 'agent_message' && kind === 'item.completed' && it.text) {
      const uuid = o.message?.({ itemId: it.id, text: it.text, model })
      texts.push(it.text)
      assistant([{ type: 'text', text: it.text }], uuid)
    } else if (it.type === 'command_execution') {
      if (kind === 'item.started') assistant([{ type: 'tool_use', id: it.id, name: 'Bash', input: { command: it.command } }])
      else { tools.push(`$ ${String(it.command).replace(/^\/bin\/zsh -lc /, '').slice(0, 160)}${it.exit_code ? ` (exit ${it.exit_code})` : ''}`); result({ type: 'tool_result', tool_use_id: it.id, content: String(it.aggregated_output ?? '').slice(-20_000), is_error: !!it.exit_code }) }
    } else if (it.type === 'mcp_tool_call') {
      if (kind === 'item.started') assistant([{ type: 'tool_use', id: it.id, name: `mcp__${it.server}__${it.tool}`, input: it.arguments ?? {} }])
      else {
        tools.push(`${it.server}.${it.tool}${it.error ? ' (failed)' : ''}`)
        const content = it.error ? out(it.error) : (it.result?.content ?? []).map((b: any) => b.text ?? '').join('\n') || out(it.result)
        result({ type: 'tool_result', tool_use_id: it.id, content: content.slice(0, 20_000), is_error: !!it.error })
      }
    } else if (it.type === 'file_change' && kind === 'item.completed') {
      const files = (it.changes ?? []).map((c: any) => `${c.kind ?? 'edit'} ${c.path}`)
      tools.push(...files.map((f: string) => `edited ${f}`))
      assistant([{ type: 'tool_use', id: it.id, name: 'Edit', input: { files } }])
      result({ type: 'tool_result', tool_use_id: it.id, content: files.join('\n') })
    } else if (it.type === 'web_search' && kind === 'item.completed') {
      tools.push(`web search: ${it.query}`)
      assistant([{ type: 'tool_use', id: it.id, name: 'WebSearch', input: { query: it.query } }])
      result({ type: 'tool_result', tool_use_id: it.id, content: '' })
    } else if (it.type === 'error') failed = it.message ?? 'error'
  }
  l({ type: 'system', subtype: 'init', model, session_id: o.conversationId })
  const job = durableRun({
    root: CODEX_RUNS, id: o.saved?.id ?? o.recovery?.turnId ?? randomUUID(),
    command: bin, args: argsFor({ ...o, thread }), cwd: existsSync(o.cwd) ? o.cwd : HOME, env: o.env,
    data: { conversationId: o.conversationId, cwd: o.cwd, mode: o.mode, model: o.model, recovery: o.recovery }, resume: o.saved,
  }, (line, replay) => {
    let ev: any
    try { ev = JSON.parse(line) } catch { return }
    replaying = replay
    try {
      if (ev.type === 'thread.started' && ev.thread_id) run('insert into codex_threads (conversation_id, thread_id, at) values (?, ?, ?) on conflict(conversation_id) do update set thread_id = excluded.thread_id, at = excluded.at', o.conversationId, ev.thread_id, Date.now())
      else if (ev.type === 'item.started' || ev.type === 'item.completed') onItem(ev.type, ev.item ?? {})
      else if (ev.type === 'turn.completed') { usage = ev.usage; completed = true }
      else if (ev.type === 'turn.failed') failed = ev.error?.message ?? 'turn failed'
      else if (ev.type === 'error') failed = ev.message ?? 'error'
    } finally { replaying = false }
  })
  // Upgrading an older saved run assigns message IDs; retain them for the next restart too.
  if (o.saved && o.recovery) { job.record.data.recovery = o.recovery; job.update(job.record.data) }
  const done = job.done.then(exit => {
      const { code, signal, error, stderr: err } = exit
      const text = texts.join('\n\n')
      const problem = failed || error || (signal ? `codex interrupted by ${signal}` : '') || (!completed ? err.trim().split('\n').filter(x => !/^\d{4}-\d\d-\d\dT.*(WARN|ERROR) rmcp/.test(x)).slice(-3).join('\n') || `codex exited without completing the turn (code ${code})` : '')
      const capped = !!problem && CODEX_CAP.test(problem)
      if (capped) cappedUntil = Date.now() + codexCapMs(problem!)
      const u = usage ?? {}
      try { o.before?.({ ok: !problem, text, tools }) } catch (e) { console.error('codex: recording the turn failed', e) }
      l({ type: 'result', subtype: problem ? 'error' : 'success', is_error: !!problem, result: problem ? `Codex: ${problem}` : text, duration_ms: Date.now() - started, total_cost_usd: 0, model,
        usage: { input_tokens: Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)), output_tokens: u.output_tokens ?? 0, cache_read_input_tokens: u.cached_input_tokens ?? 0 }, modelUsage: {} })
      return { ok: !problem, text, capped, tools }
  })
  const proc: CodexProcess = {
    kill: signal => job.kill(signal),
    saveQueue: queue => { job.record.data.recovery.queue = queue; job.update(job.record.data) },
  }
  return { proc, done, acknowledge: job.acknowledge }
}

// A background job (prompt in, text out) on Codex, for when Claude is capped: same events the
// callers read from `claude -p` (text, result, perch_done).
export function codexJob(args: string[], cwd: string, l: (ev: any) => void) {
  const prompt = args[args.indexOf('-p') + 1] ?? ''
  const system = args.includes('--append-system-prompt') ? args[args.indexOf('--append-system-prompt') + 1] : undefined
  const modelFlag = args.findIndex(a => a === '--model' || a === '-m')
  const model = codexFallbackModel(modelFlag >= 0 ? args[modelFlag + 1] ?? '' : '')
  const proc = spawn(codexBin()!, argsFor({ mode: 'plan', model, system, prompt, textOnly: true }), { cwd: existsSync(cwd) ? cwd : HOME, stdio: ['ignore', 'pipe', 'pipe'] })
  const started = Date.now()
  let buf = '', text = '', failed = ''
  proc.stdout!.on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      try {
        const ev = JSON.parse(line)
        if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') { text += (text ? '\n\n' : '') + ev.item.text; l({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ev.item.text } } }) }
        else if (ev.type === 'turn.failed' || ev.type === 'error') failed = ev.error?.message ?? ev.message ?? 'failed'
      } catch {}
    }
  })
  let finished = false
  proc.on('exit', code => {
    if (finished) return; finished = true
    if (failed || (code && !text)) { if (CODEX_CAP.test(failed)) cappedUntil = Date.now() + codexCapMs(failed); l({ type: 'result', subtype: 'error', is_error: true, result: '', duration_ms: Date.now() - started }); return l({ type: 'perch_done', code: code || 1, error: `Codex: ${failed || `exited with ${code}`}` }) }
    l({ type: 'result', subtype: 'success', is_error: false, result: text, duration_ms: Date.now() - started, total_cost_usd: 0, model: model ? `codex:${model}` : 'codex' })
    l({ type: 'perch_done', code: 0 })
  })
  proc.on('error', e => { if (!finished) { finished = true; l({ type: 'perch_done', code: 1, error: String(e.message) }) } })
  return () => proc.kill('SIGINT')
}

export { codexMessageUuid, recordedCodexPrompt, transcriptPath, recordCodexPrompt, recordCodexMessage, recordCodexTurn } from './codex-history.ts'
