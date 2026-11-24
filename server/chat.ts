// Runs Claude Code headless, one long-lived process per open chat, so every turn reuses the
// warm prompt cache instead of paying the 121-tool system prompt again. The process speaks
// stream-json both ways; the session is the same transcript file the terminal CLI writes, so
// anything started here also resumes in `claude --resume` and vice versa.
import { ATTACH_DIR } from './attachments.ts'
import './promises.ts' // creates perch_started
import { hold, shouldHold } from './pausehold.ts'
import { abandonTurns, contextTokens, isCorrection, engineFor, requeueTurns, setEngine, setTurbo, settleTurns, startTurn, turboFor, turnEvent } from './turns.ts'
import { agentEnv, localJob, localRoomSync, localUpSync } from './local.ts'
import { usageNow, noteClaude } from './usage.ts'
import { billing, claudeEnv, noteChatAccount, type Billing } from './account.ts'
import { chooseProvider } from './subscription-budget.ts'
import { runTextJobs } from './job-fallback.ts'
import { allCapped, available, capFrom, capScope, claudeFixed, isCodex, isLocal, markCapped, route, tierLabel, wantsCodex, type Tier } from './router.ts'
import { claudeFallbackTier, codexFallbackModel, codexDefaultModel, codexJob, codexReady, codexReadySync, codexThread, codexTurn, forgetCodexThread, codexMessageUuid, recordedCodexPrompt, recordCodexPrompt, recordCodexMessage, recordCodexTurn, transcriptPath, recoverableCodex, type CodexProcess } from './codex.ts'
import { condensed } from './mcp.ts'
import { toItems, itemsOf } from './transcript.ts'
import { GRACE_MS, strained, toStop } from './reaper.ts'
import { kindProtected, pendingWork, transcriptTail } from './protection.ts'
import { detail } from './conversations.ts'
import { lastSample } from './quiet.ts'
import { recordAvailability } from './uptime.ts'
import { indexTranscript } from './indexer.ts'
import { tmpdir } from 'node:os'
import type { RunRecord } from './durable-run.ts'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { close, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, write, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { blockerFor } from '../web/src/blockers.ts'
import { status as connStatus } from './status.ts'
import { all, get, run } from './db.ts'
import { askMe, DATA_DIR, HOME, settings } from './settings.ts'
import { agentsMdBytes, agentsMdKept, allMemoryLines } from './agentsync.ts'
import { CODEX_LIMIT, threadMemory } from './codexbudget.ts'
import { snapshot } from './branch.ts'
import { signature } from './signhook.ts'
import { originFor, originMarker, originPrompt, chatSubject, startChatOrigin } from './origin.ts'
import { machineLine, maxHelpers, ownerName, possessive } from './owner.ts'
import { posthogKey } from './keychain.ts'
import { runCorrectionFor } from './replycheck.ts'
import { agentSender, QUEUED, stampPrompt } from '../shared/messageOrigin.ts'
import { MCP_SERVER, mcpTool } from '../shared/brand.ts'
import { raceInstruction, selectRace } from './autorace.ts'
import { attentionFor } from './needsattention.ts'

export type ChatEvent = Record<string, any>
type Listener = (ev: ChatEvent) => void

export type Chat = {
  id: string
  cwd: string
  proc: Runner | null
  state: 'idle' | 'running' | 'exited'
  turn: ChatEvent[] // events of the turn in progress, replayed to late subscribers
  listeners: Set<Listener>
  lastUsed: number
  mode: string
  context: boolean
  stderr: string
  profile?: string[] // replaces the default arguments (search sessions use their own tools and prompt)
  turbo: boolean
  engine: string // 'auto' or '' (perch picks per message), 'claude:<model>', or a local Ollama model
  tier: Tier | null // the Claude model, or the tier Codex is covering (kept for follow-ups)
  lastPrompt?: string // resent on the next model when this one hits its usage cap
  lastImages?: any[] // and its images, so a fallback doesn't drop a screenshot
  pending: { prompt: string; images?: any[]; at: number }[] // sent but not answered yet: resent if the agent stalls
  lastOutput: number // when the agent last wrote anything
  capRetries?: number
  requestingAt?: number // an API request went out and nothing has come back yet
  restarts?: number[] // when the stall watchdog restarted it (capped, so a network outage can't loop)
  codex?: CodexProcess | null // a Codex turn in flight (codex.ts)
  codexQueue?: SendOpts[] // messages that arrived while it ran
  handoffQueue?: SendOpts[] // reserve message order while checking the next provider
  account?: Billing // how its claude process is billed (account.ts); unset on a local model
}

export const chats = new Map<string, Chat>()
const waiting = new Map<string, Set<Listener>>() // subscribers to a chat that hasn't started yet
const MCP_SCRIPT = join(import.meta.dirname, 'mcp.ts')

// Every GitHub comment an agent posts from your account carries a tiny signature naming the
// automation (see signhook.ts). A PreToolUse hook blocks unsigned ones and hands back the line to add.
const SIGN_HOOK = { PreToolUse: [{ matcher: 'Bash|mcp__.*github.*|mcp__.*GitHub.*', hooks: [{ type: 'command', command: `'${process.execPath}' '${join(import.meta.dirname, 'signhook.ts')}'`, timeout: 10 }] }] }
const agentLabel = (id: string) => {
  const by = get<{ by: string | null }>('select by from perch_started where id = ?', id)?.by
  return !by || by === 'you' || by === 'agent' ? 'auto-m8 chat' : `auto-m8 ${by}`
}

export function childEnv(configDir?: string, extra?: NodeJS.ProcessEnv) {
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
  Object.assign(env, extra)
  delete env.CLAUDECODE // set when perch itself was started from Claude Code
  delete env.CLAUDE_CODE_ENTRYPOINT
  if (configDir && configDir !== join(env.HOME!, '.claude')) env.CLAUDE_CONFIG_DIR = configDir
  return env
}

// PostHog Code sessions live under their own config dir; resuming needs it.
function configDirFor(id: string) {
  const c = get<{ source: string }>('select source from conversations where id = ?', id)
  return settings.sources.find(s => s.id === c?.source)?.configDir
}

// perch's own notes in a thread (a model change, a cap, a stall) are kept, so you see them even if
// you weren't watching when they happened.
run('create table if not exists chat_notices (conversation_id text not null, at integer not null, text text not null)')
export const noticesFor = (id: string) => all<{ at: number; text: string }>('select at, text from chat_notices where conversation_id = ? order by at', id)

function emit(c: Chat, ev: ChatEvent) {
  if (ev.type === 'perch_notice') run('insert into chat_notices (conversation_id, at, text) values (?, ?, ?)', c.id, Date.now(), String(ev.text))
  if (c.state === 'running' || ev.type === 'perch_user') c.turn.push(ev)
  for (const l of c.listeners) l(ev)
}

// A note in a conversation's thread, shown live to anyone watching it (open chat or not) and kept for reloads.
export function noticeLive(id: string, text: string) {
  const c = chats.get(id)
  if (c) return emit(c, { type: 'perch_notice', text })
  run('insert into chat_notices (conversation_id, at, text) values (?, ?, ?)', id, Date.now(), text)
  for (const l of waiting.get(id) ?? []) l({ type: 'perch_notice', text })
}

function setState(c: Chat, state: Chat['state']) {
  c.state = state
  emit(c, { type: 'perch_state', state })
  saveMeta(c)
  onChatsChange.forEach(f => f())
}

export const onChatsChange = new Set<() => void>()

// The conversation that is calling perch's tools rides along as env, so a tool that starts a new conversation can link it back.
export const PERCH_MCP = (conversationId?: string) => JSON.stringify({ mcpServers: { [MCP_SERVER]: { command: process.execPath, args: [MCP_SCRIPT], ...(conversationId ? { env: { PERCH_CONVERSATION_ID: conversationId } } : {}) } } })

// With context on, Claude gets the perch MCP and is told when to use it, so earlier work is
// pulled in behind the scenes. "No context" leaves both out: a clean session.
const contextPrompt = (id: string) => `You are running inside auto-m8, the user's hub for agent conversations. This conversation's id is ${id}.
The auto-m8 MCP tools search and read the user's earlier conversations (${[...settings.sources.map(x => x.label), ...(posthogKey() ? ['PostHog tasks'] : [])].join(', ')}).
Never promise to come back later ("I'll let you know when…", "I'll check back…"): when this turn ends nothing wakes you. If the result is minutes away, wait for it in this turn. Otherwise call the auto-m8 follow_up tool with conversation_id=${id} and a time or PR condition, and tell the user auto-m8 will bring you back.
When a request continues or depends on earlier work that isn't in this conversation (a PR, a branch, "the stack", "like last time", a project name), search before answering, read what is relevant, and say in one short line which earlier conversations you used. Then call link_conversations with from=${id} for each one you relied on.
Don't search for self-contained requests.
INTERRUPTIONS: the user can send messages while you work; they land between your tool calls. Keep your current plan written down (TodoWrite, or a short list in your reply) so an interruption never loses it. For each new message, decide: does it change or replace what you're doing (a correction, a new priority, "stop")? Switch now and say in one line what you parked. Is it separate (a side question, another task)? Answer it briefly if quick, otherwise add it to the plan, finish the current step, and come back to it. Before ending the turn, check the plan: finish or explicitly hand off every parked item, never silently drop one.
SLACK: you cannot post to Slack. When the user should ask or answer something there (a question for a team, an approval, a reply in a thread): find the channel or thread, read its recent messages to see how people there ask, write the message in the user's voice with the text-humanizer skill (use_skill), then call draft_slack_message with conversation_id=${id} and the messages you read as context. The user sends it.\nEVIDENCE: the data queries you run (Grafana, PostHog) are indexed with their numbers; get_evidence with conversation_id=${id} refinds a figure you used earlier, and gives the link to cite.\nCHARTS: the chat draws data inline. Grafana query_prometheus (and Loki metric queries) draw under the tool call: range queries as line charts the user can stack, histogram _bucket series grouped by le as a heatmap with p50/p95/p99, instant queries as stat tiles or bars; PostHog execute-sql as a table. Prefer range queries when a trend matters. For anything else write a fenced block with language chart holding JSON, one of: {"type":"line"|"area","title":"..","unit":"bytes"|"s"|"%"?,"stack":true?,"link":"<grafana url>"?,"series":[{"name":"..","points":[[unixSeconds,value]],"axis":"right"?}],"rightUnit":".."?}; {"type":"stat","stats":[{"label":"..","value":1,"baseline":1?,"spark":[1,2]?}]} (baseline shows the change vs pre-merge); {"type":"bar","bars":[{"label":"..","value":1}]}; {"type":"table","columns":[..],"rows":[[..]]}. For other chart kinds (scatter, boxplot, faceted, layered) write a fenced block with language vega-lite holding a Vega-Lite spec with inline data.values (URLs are blocked).\nTILES: for a visualization the kinds above can't draw (a gauge, a diagram, a custom layout, several panels together), write a fenced block with language tile: one HTML fragment with its CSS and JS, no build step. It runs inline in the chat, in a sandbox. The info string after the language is optional JSON: {"title":"..","height":320,"refresh":30,"vars":{"hours":24,"env":"prod"}}. Draw with SVG, canvas or DOM; a library may load from cdnjs.cloudflare.com at an exact version. Read data only through await perch.data({source:'posthog', hogql:'select …'}) (or source 'github' with path, or source 'perch' with path for auto-m8's own data, same as code tiles; the tile API keeps the name perch). Nothing else leaves the tile: no fetch to other URLs, no http source. perch.vars holds the variables, and the reader can change them. perch.onRefresh(fn) runs fn at the start, on the refresh timer, when auto-m8's data changes and when a variable changes. Colours: var(--fg), var(--muted), var(--accent), var(--line), var(--bg). Show a short loading state and any error in the tile.\nBOARDS: the user keeps a few live boards (canvases of tiles, e.g. the Railyard). The canvas tool lists, searches, reads, builds and updates them, and action=show displays one beside this chat (layout side) or instead of it (full). For a one-off visualization, create a temporary canvas (temporary=true, default 24h of inactivity; ttl_seconds customizes it) and show it here. For a lasting live view, adapt an existing board (list first). Opening or interacting renews a temporary canvas; background refreshes do not. Use lifetime temporary=false or pin to keep it.\nDECISIONS: Decide reversible work yourself, choosing what keeps it moving. If an action truly requires the user, record it using needs_me action=report with a stable key, title, source, context and conversation_id=${id}. A capable agent rechecks it automatically. Keep independent work moving; update the item with evidence when resolved. Never treat silence as permission for destructive production actions, spending money or sending messages. Don't end on a question or a menu.\nPROJECTS: for work that spans several PRs, call project (action=set) with conversation_id=${id}, the goal and a done_when check, so the plan survives restarts. After a restart or when picking work up, call project action=status first.\nDRIVING OTHER CONVERSATIONS: when the user asks you to keep their conversations going (be a monitor, or pair as them), find them with recent_activity or search_conversations, read each with get_conversation, then write the next step into it with send_to_conversation (from=${id}). Write like the user would: short, decisive, the next concrete step. Call board (owner=${id}) for one live view of every conversation and PR you drive (PRs read live from GitHub through gh; dig deeper with gh pr view/checks/diff). Call watch with the conversations and PR urls you drive: auto-m8 then wakes you with one EVENTS message per burst (turns ending, questions, idle chats, CI red/green, approvals, review threads, merges) instead of you polling. Replies to send_to_conversation arrive the same way; keep going until each is done or truly needs the user${askMe() ? ' (then ask_decision)' : ''}. The user sees every message you send marked as agent-sent.\nCOMMANDS: you run commands yourself (Bash). Never ask the user to run something you could run. When one needs a TTY (an interactive prompt, a device-code or browser login), use the terminal tool with run=true and drive it. Only when you have tried and real workarounds failed (non-interactive flags, existing tokens, a different tool) and it truly needs the user (sudo password, a browser approval, a hardware key) call terminal action=open with run=false and needs_user: auto-m8 opens it under the chat with the command typed in. You own that terminal: wait on it (action=read wait_seconds), answer its prompts (action=send), verify the result and carry on. Never write "run this in your terminal", "paste this into a terminal" or "you can run X yourself": if the user must type or approve it, it goes in the auto-m8 terminal (action=open, needs_user), never a code block for them to copy. auto-m8 checks every reply for this and sends you back to fix it.\nLINKS: write every PR as its full URL (https://github.com/<owner>/<repo>/pull/<n>), never a bare #1234 or repo#1234: full URLs are what auto-m8 draws as PR pills with live state. Same for issues, Slack threads, dashboards and runs: link the thing, don't just name it.\nWORKTREES: auto-m8 keeps agent checkouts in .perch-worktrees/ next to each repo (PR shepherds and audits, autoresearch, self-fixes, helpers). For parallel code changes in one repo, delegate with worktree=true: each helper gets its own checkout and branch made from your HEAD (your uncommitted changes aren't in it), and you merge its branch when it reports. This Mac has ${machineLine} and one Docker daemon shared by every agent: at most ${maxHelpers} helpers in worktrees at once, and never run full test suites, dev servers or docker compose stacks in several checkouts at once; run the tests for what changed. The worktrees tool lists every checkout (uncommitted changes, commits only there, last use, who is running in it); auto-m8 removes idle clean ones hourly without losing branches or commits, so leave yours clean when done. Never rm -rf a worktree folder: use worktrees action=remove.\nTOOL HYGIENE (from your own error log): never wait with 'sleep N' in Bash, it is blocked; use run_in_background, Monitor with an until-loop, or follow_up. Load a deferred tool's schema with ToolSearch before the first call (calling it blind fails on required args like Grafana query_prometheus endTime).${posthogKey() ? " PostHog exec runs tools as 'call <tool> <json>' (run 'info <tool>' when unsure); before HogQL on an unfamiliar table, read its schema." : ''} In an isolated worktree, stay inside it: relative paths, no 'cd' into the main checkout. Read a file before Edit/Write.\n${settings.browser.enabled ? `BROWSER: for anything on the web, use the auto-m8 browser tool (conversation_id=${id}): your own window in the Agent Chrome, where the user is signed in to their accounts. It's much faster and steadier than claude-in-chrome or screenshots: fetch for APIs, mode=text to read, snapshots with refs and batched steps to act, mode=visual only when pixels matter, goal=… so repeat tasks replay from cache.\n` : ''}OPTIMISING: when the user wants a measurable thing made faster, smaller or better (bundle size, latency, test time, a query's cost), offer to run it as autoresearch (start_autoresearch) instead of one-off edits.`

// Turbo: the same top model at high effort, told to spend wall-clock time, not quality: plan
// briefly, run independent work in parallel (tool calls in one message, subagents for separate
// subtasks), then consolidate and verify. Fast mode is requested too; it switches on wherever the
// account and org allow it (each turn records whether it did).
const TURBO = `TURBO MODE is on: the user wants this finished as fast as possible, at full quality.
- Plan in one short step, then act. Don't ask clarifying questions unless truly blocked: pick sensible defaults and say which.
- Parallelise everything independent: put independent reads, searches and commands in a single message, and split independent subtasks across subagents (Agent tool) launched together, each with a narrow, self-contained brief.
- Parallel code changes in one repo: give each subagent separate files, or its own git worktree (auto-m8 delegate with worktree=true), so they never collide.
- Consolidate yourself at the end: merge the results, resolve conflicts, and verify (run the relevant tests or typecheck) before you report.
- Keep the final answer short.`

// Always on, with or without context: the owner (Settings → owner, see owner.ts) is the driver, and the handbook's
// bar is that good ones never "wait for someone else to fix an adjacent problem".
const DRIVER = () => `YOU ARE THE DRIVER. Act like the founder of this work: ${ownerName()} owns the outcome, and you work for ${ownerName()} to get it done.
- Nobody else is going to do it unless they explicitly said they will. Don't recommend handing work to another team or person ("ask X in Slack to fix this", "file a ticket with team Y"). Do it, or work out how to.
- Other people and teams are sources of context, not capacity. Asking them what something does, why it was built that way, or where the code lives is fine. Asking them to do the work is not. If something is truly outside ${possessive(ownerName())} reach (no access, someone else's decision), say exactly what is blocked and propose the smallest thing ${ownerName()} can do to unblock it, but do everything else first.
- Fix adjacent problems that are in the way, in the repo and the tooling, instead of routing around them or flagging them for someone else. If you can open the PR, open the PR.
- If another person or team has explicitly said they will do something, that is theirs: track it, don't redo it.
- Descope and ship fast, check it is actually working afterwards, and follow up. Challenge the task if it looks wrong. Own the result.`

function baseArgs(mode: string, context: boolean, id?: string, turbo = false) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', mode, '--add-dir', ATTACH_DIR]
  args.push('--settings', JSON.stringify({ hooks: SIGN_HOOK, ...(turbo ? { fastMode: true } : {}) }))
  if (turbo) args.push('--model', 'opus', '--effort', 'high')
  else if (settings.chat.model) args.push('--model', settings.chat.model)
  if (settings.chat.chrome) args.push('--chrome')
  if (context) {
    args.push('--mcp-config', PERCH_MCP(id))
    // auto-m8's own tools never need a prompt: reads, linking, and scheduling a follow-up.
    args.push('--allowedTools', ...['mcp_access', 'search_conversations', 'get_conversation', 'recent_activity', 'search_notes', 'search_skills', 'use_skill', 'open_prs', 'link_conversations', 'follow_up', 'get_evidence', 'draft_slack_message', 'report_missing_capability', 'delegate', 'delegate_send', 'delegate_status', 'worktrees', 'send_to_conversation', 'board', 'watch', 'terminal', 'canvas', ...(settings.browser.enabled ? ['browser'] : [])].map(mcpTool))
  }
  // Agents never post to Slack: they draft, and you send (see draft_slack_message).
  args.push('--disallowedTools', 'mcp__claude_ai_Slack__slack_send_message', 'mcp__claude_ai_Slack__slack_schedule_message', 'mcp__claude_ai_Slack__slack_send_message_draft', 'mcp__plugin_slack_slack__slack_send_message', 'mcp__plugin_slack_slack__slack_schedule_message', 'mcp__plugin_slack_slack__slack_send_message_draft')
  const system = systemPrompt(context, id, turbo)
  if (system) args.push('--append-system-prompt', system)
  return args
}
function systemPrompt(context: boolean, id?: string, turbo = false) {
  const sign = id ? `GITHUB COMMENTS: you post from ${possessive(ownerName())} account, so end every comment, review or reply body you post on GitHub with this signature after a blank line (bare bot commands like "/trunk merge" are exempt):\n${signature({ PERCH_AGENT: agentLabel(id), PERCH_CONVERSATION_ID: id })}` : ''
  const PEERS = 'PEERS: Claude, Codex and local models are peers in auto-m8 with the same auto-m8 tools, MCP servers, instructions and memory. If an MCP server or tool fails for you, call mcp_access to see whether the other agents have it working, and if one does, delegate the job to it (delegate engine=claude or engine=codex) instead of giving up or asking the user.'
  return [DRIVER(), PEERS, context && id ? contextPrompt(id) : '', sign, id ? originPrompt(id) : '', turbo ? TURBO : ''].filter(Boolean).join('\n\n')
}

// ---------- durable chat processes ----------
// Chats outlive perch: each claude process runs detached, reading its input from a named pipe
// and writing its output to a file, with a small record of what it is. If perch restarts (a
// crash, an update), it reattaches to the processes still running, catches up on what they wrote
// meanwhile, and carries on. One that died mid-turn (a reboot) is resumed where it left off.
// ponytail: one file pair per live chat under run/; fine for tens of chats, not thousands.
const RUN = join(DATA_DIR, 'run')
mkdirSync(RUN, { recursive: true })
const files = (id: string) => ({ fifo: join(RUN, `${id}.in`), out: join(RUN, `${id}.out`), meta: join(RUN, `${id}.json`) })
type Meta = { id: string; pid: number; cwd: string; mode: string; context: boolean; turbo: boolean; engine?: string; tier?: Tier | null; profile?: string[]; offset: number; state: Chat['state']; at: number; account?: Billing }
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const saveMeta = (c: Chat) => { if (c.proc) try { writeFileSync(files(c.id).meta, JSON.stringify({ id: c.id, pid: c.proc.pid, cwd: c.cwd, mode: c.mode, context: c.context, turbo: c.turbo, engine: c.engine, tier: c.tier, profile: c.profile, offset: c.proc.offset, state: c.state, at: Date.now(), account: c.account } satisfies Meta)) } catch {} }
const forget = (id: string) => { for (const f of Object.values(files(id))) rmSync(f, { force: true }) }

export type Runner = { pid: number; offset: number; write: (line: string) => void; kill: (sig?: NodeJS.Signals) => void; stop: () => void }

// Follows a running process: its output file from where we last read, and whether it's alive.
function attach(c: Chat, pid: number, offset: number): Runner {
  const f = files(c.id)
  // Read+write (never gives the process an EOF) and non-blocking. A blocking write to a full pipe
  // whose reader died waits forever in a libuv worker, and macOS then blocks close() on that fd
  // until the write ends: the main thread froze in the kernel, unkillable, on 2026-11-10 (a 730 KB
  // image message to a claude that had exited). Non-blocking writes get EAGAIN and retry instead.
  const fdIn = openSync(f.fifo, constants.O_RDWR | constants.O_NONBLOCK)
  let fdOut = -1, buf = '', done = false, writing = false, queue: Buffer[] = []
  const closeIn = () => close(fdIn, () => {})
  // In order and off the event loop: a busy process must never stall the server.
  const pump = () => {
    if (writing || done || !queue.length) return
    writing = true
    write(fdIn, queue[0], 0, queue[0].length, null, (err, n) => {
      writing = false
      if (done) return closeIn() // stop() ran while this write was in flight
      if (err) {
        if (err.code === 'EAGAIN') { setTimeout(pump, 50).unref?.(); return } // pipe full: the process hasn't read it yet
        queue = []; return
      }
      queue[0] = queue[0].subarray(n)
      if (!queue[0].length) queue.shift()
      pump()
    })
  }
  const runner: Runner = {
    pid, offset,
    write: line => { queue.push(Buffer.from(line)); pump() },
    kill: (sig = 'SIGTERM') => { try { process.kill(-pid, sig) } catch { try { process.kill(pid, sig) } catch {} } },
    // Never closeSync here: it runs on the event loop.
    stop: () => {
      if (done) return
      done = true; queue = []; clearInterval(timer)
      if (!writing) closeIn()
      if (fdOut >= 0) close(fdOut, () => {})
    },
  }
  const read = () => {
    if (done) return
    try {
      if (fdOut < 0) fdOut = openSync(f.out, 'r')
      const st = fstatSync(fdOut), size = st.size
      while (runner.offset < size) {
        const chunk = Buffer.alloc(Math.min(1 << 20, size - runner.offset))
        const n = readSync(fdOut, chunk, 0, chunk.length, runner.offset)
        if (!n) break
        runner.offset += n
        c.lastOutput = Math.max(c.lastOutput, Math.min(Date.now(), st.mtimeMs)) // when it was written: a replay after a restart isn't new activity
        buf += chunk.subarray(0, n).toString('utf8')
      }
    } catch { return }
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let ev: ChatEvent
      try { ev = JSON.parse(line) } catch { c.stderr = (c.stderr + line + '\n').slice(-4000); continue }
      if (ev.type === 'rate_limit_event') noteClaude(ev, Date.now())
      turnEvent(c.id, ev) // first: it adds the turn's own cost (perch_cost) for the chat to show
      emit(c, ev)
      // Claude Code starts turns on its own too: a background task finishing, or a message that
      // arrived as the last turn ended. It's working, so it must not look idle (the idle reaper
      // would stop it mid-task).
      if (ev.type === 'system' && ev.subtype === 'init' && c.state === 'idle') setState(c, 'running')
      if (ev.type === 'system' && ev.subtype === 'status' && ev.status === 'requesting') c.requestingAt ??= Date.now()
      else if (ev.type !== 'system') c.requestingAt = undefined // the reply started (or the turn moved on)
      if (ev.type === 'result') {
        const unanswered = c.pending
        c.turn = []; c.pending = []; c.requestingAt = undefined; setState(c, 'idle'); saveMeta(c)
        // Still idle a little later: whatever messages were open were answered in this turn.
        setTimeout(() => { if (c.state === 'idle') settleTurns(c.id) }, 10_000).unref?.()
        // A usage cap: note when it resets, and carry on with the next model down.
        const until = ev.is_error ? capFrom(`${ev.result ?? ''} ${ev.error ?? ''} ${JSON.stringify(ev.errors ?? '')}`) : null
        if (until && c.tier) onCap(c, until, capScope(`${ev.result ?? ''} ${ev.error ?? ''}`), unanswered)
        else if (!ev.is_error) { c.capRetries = 0; if (c.tier) forgetCodexThread(c.id) } // back on Claude: a later hand-off to Codex starts fresh, with these turns in it
        // A lapsed Claude sign-in: say so in /api/status (the composer offers sign-in before the next
        // send) and stop this process, which keeps the dead session: the next message starts a fresh
        // claude that reads the new login. It's idle, so nothing is lost (same as the idle reaper).
        const blocked = ev.is_error ? blockerFor(`${ev.result ?? ''} ${ev.error ?? ''}`) : null
        if (blocked?.kind === 'claude-login') {
          connStatus.claudeAuthLapse = { at: Date.now(), text: String(ev.result ?? ev.error ?? '').slice(0, 300), conversationId: c.id }
          onAuthLapse.forEach(f => f())
          const old = c.proc
          if (old) setTimeout(() => { if (c.proc === old && c.state === 'idle') { old.kill(); setTimeout(() => { if (c.proc === old) exited(c, old) }, 3000) } }, 500).unref?.()
        } else if (!ev.is_error && connStatus.claudeAuthLapse && !isCodex(c.engine) && !isLocal(c.engine)) { connStatus.claudeAuthLapse = undefined; onAuthLapse.forEach(f => f()) }
        // The reply told the user to run a command in their terminal: send the agent one correction.
        const fix = !ev.is_error && typeof ev.result === 'string' ? runCorrectionFor(c.id, ev.result) : null
        if (fix) setTimeout(() => { if (c.state === 'idle') send({ id: c.id, prompt: fix, resume: true }) }, 1500).unref?.()
      }
    }
  }
  // Output is polled (cheap: one fstat) rather than watched, which also covers reattached processes.
  const timer = setInterval(() => {
    read()
    if (!alive(pid)) { read(); exited(c, runner) }
  }, 150)
  timer.unref?.()
  return runner
}

// Fired when a Claude sign-in lapse is seen or cleared (main.ts broadcasts 'status').
export const onAuthLapse = new Set<() => void>()

function exited(c: Chat, runner: Runner) {
  runner.stop()
  if (c.proc !== runner) return // an older process we already replaced
  c.proc = null
  if (c.state === 'running') {
    emit(c, { type: 'perch_error', message: c.stderr.trim().slice(-1500) || 'claude stopped unexpectedly' })
    console.error(`chat ${c.id} exited mid-turn: ${c.stderr.trim().slice(-300) || 'no stderr'}`)
    abandonTurns(c.id, 'exited')
  }
  c.turn = []
  setState(c, 'exited')
  forget(c.id)
}

function start(c: Chat, resume: boolean) {
  const local = isLocal(c.engine)
  let args = [...(c.profile ?? baseArgs(c.mode, c.context, c.id, c.turbo && !local)), '--input-format', 'stream-json', ...(resume ? ['--resume', c.id] : ['--session-id', c.id])]
  // The model it starts on: a local model (the same Claude Code, pointed at Ollama), or the Claude
  // model the router picked. Later switches happen in place (set_model), keeping the session warm.
  const model = local ? c.engine : !c.profile && c.tier ? c.tier : null
  if (model) {
    if (local) args = args.filter(a => a !== '--chrome')
    const i = args.indexOf('--model')
    if (i >= 0) args.splice(i, 2)
    args.push('--model', model)
  }
  // How it is billed (account.ts): your Claude Code login, or your API key when one is set.
  c.account = local ? undefined : billing()
  noteChatAccount(c.id, c.account ?? 'local')
  const f = files(c.id)
  forget(c.id)
  execFileSync('mkfifo', [f.fifo])
  const fdIn = openSync(f.fifo, 'r+'), fdOut = openSync(f.out, 'w')
  // Detached, in its own process group: it keeps running if perch stops.
  const proc = spawn('claude', args, { cwd: existsSync(c.cwd) ? c.cwd : settings.chat.cwd, env: childEnv(configDirFor(c.id), { PERCH_CONVERSATION_ID: c.id, PERCH_AGENT: agentLabel(c.id), PERCH_ORIGIN_MARKER: originFor(chatSubject(c.id)) ? originMarker(originFor(chatSubject(c.id))!) : '', ...(local ? agentEnv(c.engine) : claudeEnv()) }), stdio: [fdIn, fdOut, fdOut], detached: true })
  closeSync(fdIn); closeSync(fdOut)
  proc.unref()
  proc.on('error', () => {}) // reported through the exit check
  c.stderr = ''
  c.proc = attach(c, proc.pid!, 0)
  saveMeta(c)
}

// At startup: pick up every chat that kept running while perch was down.
export function reattachChats(resumeLost: (id: string) => void) {
  let found = 0
  for (const saved of recoverableCodex()) {
    const r = saved.data.recovery
    if (!r?.chat || !r?.opts || !r?.turnId || chats.has(saved.data.conversationId)) continue
    const c: Chat = { ...r.chat, id: saved.data.conversationId, proc: null, codex: null, state: 'running',
      turn: [], listeners: new Set(), pending: [], lastOutput: Date.now(), lastUsed: Date.now(), stderr: '', codexQueue: r.queue ?? [] }
    for (const l of waiting.get(c.id) ?? []) c.listeners.add(l)
    waiting.delete(c.id)
    chats.set(c.id, c)
    sendCodex(c, { ...r.opts, retry: true }, saved.data.model, saved)
    found++
  }
  for (const name of readdirSync(RUN).filter(n => n.endsWith('.json'))) {
    let m: Meta
    try { m = JSON.parse(readFileSync(join(RUN, name), 'utf8')) } catch { continue }
    if (chats.has(m.id)) continue
    if (!alive(m.pid)) {
      forget(m.id)
      // Died mid-turn while perch was down (a reboot): carry on where it left off.
      if (m.state === 'running' && !m.profile) { abandonTurns(m.id, 'died while auto-m8 was down'); resumeLost(m.id) }
      continue
    }
    // Keep the idle clock across restarts: perch restarts every 20-60 min on busy days, and resetting
    // it to now meant the idle reaper never fired, so 50+ idle agents (with their MCP servers) piled
    // up and pushed the Mac deep into swap (2026-11-17). Last output = the .out file's mtime.
    let wrote = m.at ?? Date.now()
    try { wrote = Math.max(wrote, statSync(files(m.id).out).mtimeMs) } catch {}
    const since = m.state === 'running' ? Date.now() : Math.min(Date.now(), wrote) // running: keep the stall watchdog's grace
    const c: Chat = { id: m.id, cwd: m.cwd, proc: null, state: m.state === 'exited' ? 'idle' : m.state, turn: [], listeners: new Set(), lastUsed: since, mode: m.mode, context: m.context, stderr: '', profile: m.profile, turbo: m.turbo, engine: m.engine ?? '', tier: m.tier ?? null, pending: [], lastOutput: since, account: m.account }
    for (const l of waiting.get(m.id) ?? []) c.listeners.add(l)
    waiting.delete(m.id)
    chats.set(m.id, c)
    if (c.state === 'running') {
      requeueTurns(m.id)
      // Messages it hadn't answered when perch went down: watched for a stall like any other.
      c.pending = all<any>('select sent_at from turns where conversation_id = ? and finished_at is null order by sent_at', m.id).map(t => ({ prompt: '(a message sent before auto-m8 restarted)', at: t.sent_at }))
    }
    c.proc = attach(c, m.pid, m.offset) // replays what it wrote while perch was down
    found++
  }
  if (found) onChatsChange.forEach(f => f())
  return found
}

export { QUEUED } from '../shared/messageOrigin.ts'

// retry: the same message again on another model after a cap (shown once, not echoed again).
// Something else may own a conversation's execution (cloud.ts: a PostHog cloud task while the Mac is
// away). An interceptor that returns true has taken the message; no local turn starts.
export const sendInterceptors = new Set<(opts: SendOpts) => boolean>()
// Set by main.ts: continues a message in a PostHog cloud task when every subscription is capped.
export let cloudFallback: ((opts: SendOpts, id: string) => void) | null = null
export function setCloudFallback(f: typeof cloudFallback) { cloudFallback = f }

export type SendOpts = { noCloud?: boolean; messageId?: string; retry?: boolean; resent?: boolean; engine?: string; engineOnce?: boolean; turbo?: boolean; images?: any[]; id?: string; cwd?: string; prompt: string; selectionText?: string; mode?: string; context?: boolean; resume?: boolean; profile?: string[]; by?: string; originParent?: string; manual?: boolean }

// Sends a prompt, starting or resuming the process as needed. Returns the session id.
export function send(opts: SendOpts): string {
  if (shouldHold(opts)) { hold(opts); return opts.id ?? randomUUID() } // paused: automations don't start or wake anything
  if (opts.id && !opts.retry) for (const f of sendInterceptors) if (f(opts)) return opts.id
  if (!opts.retry && !opts.resent) opts = { ...opts, prompt: stampPrompt(opts.prompt, opts.by) }
  const id = opts.id ?? randomUUID()
  startChatOrigin(id, opts.by, opts.originParent)
  let c = chats.get(id)
  if (!c) {
    const known = get<{ cwd: string }>('select cwd from conversations where id = ?', id)
    c = {
      id, cwd: opts.cwd ?? known?.cwd ?? settings.chat.cwd, proc: null, state: 'exited', turn: [], listeners: new Set(),
      lastUsed: Date.now(), mode: opts.mode ?? settings.chat.permissionMode, context: opts.context ?? true, stderr: '', profile: opts.profile, turbo: false, engine: '', tier: null, pending: [], lastOutput: Date.now(),
    }
    for (const l of waiting.get(id) ?? []) c.listeners.add(l)
    waiting.delete(id)
    chats.set(id, c)
  }
  const race = selectRace({ conversation: id, prompt: opts.selectionText ?? opts.prompt, by: opts.by,
    retry: opts.retry, resent: opts.resent, busy: c.state === 'running' || !!c.handoffQueue,
    profile: !!(opts.profile || c.profile), mode: opts.mode ?? c.mode })
  if (race) {
    opts = { ...opts, prompt: opts.prompt + raceInstruction(race) }
    emit(c, { type: 'perch_notice', text: `Automatic race candidate: ${race.reason}. Scoping before launch.` })
  }
  // At most one short note about something waiting on the user, for the agent they are talking to.
  if (opts.by === 'you' && !opts.retry && !opts.resent && !c.profile) {
    const note = (() => { try { return attentionFor(id) } catch (e) { console.error('attention', e); return '' } })()
    if (note) opts = { ...opts, prompt: opts.prompt + note }
  }
  if (c.handoffQueue) {
    c.handoffQueue.push({ ...opts, retry: true })
    if (!opts.retry && !opts.resent) emit(c, { type: 'perch_user', text: opts.prompt })
    return id
  }
  if (opts.mode && opts.mode !== c.mode && c.proc && !c.profile) { const old = c.proc; c.proc = null; old.kill(); old.stop() } // mode is fixed per process
  // Turbo is per chat and sticky: set when a message asks for it, remembered otherwise.
  if (opts.turbo !== undefined) setTurbo(id, opts.turbo)
  const turbo = !c.profile && (opts.turbo ?? turboFor(id))
  // Model and effort are fixed per process, so a switch restarts it (resuming the same session).
  // Mid-turn, the message queues into the running process and keeps its setting until the next one.
  if (turbo !== c.turbo && !(c.proc && c.state === 'running')) { if (c.proc) { const old = c.proc; c.proc = null; old.kill(); old.stop() } c.turbo = turbo }
  // The model is per chat and sticky too ('' = Claude). Switching restarts the process (resumes the session).
  if (opts.engine !== undefined && !opts.engineOnce) setEngine(id, opts.engine) // engineOnce: a cap fallback, not your choice
  const wanted = c.profile ? '' : (opts.engine ?? engineFor(id))
  // A chat pinned to Codex goes to Claude for this message when Codex is capped or signed out (the
  // pin stays); Claude and Codex cover for each other.
  const codexDown = isCodex(wanted) && !codexReadySync() && !allCapped()
  const codexPeerTier = codexDown ? claudeFallbackTier(wanted.slice(6)) : null
  // Local models are peers too: if Ollama isn't running, Claude (or Codex) takes the message.
  const localDown = isLocal(wanted) && !localUpSync() && (!allCapped() || codexReadySync())
  let engine = codexPeerTier ? `claude:${codexPeerTier}` : localDown ? '' : wanted
  if (codexPeerTier) emit(c, { type: 'perch_notice', text: `Codex is at its limit, near its plan limit or signed out: this message runs on ${tierLabel(available(codexPeerTier) ?? codexPeerTier)} with the same context.` })
  if (localDown) emit(c, { type: 'perch_notice', text: "The local model isn't running (Ollama is down): this message runs on Claude or Codex with the same context." })
  if (engine !== c.engine && !(c.proc && c.state === 'running')) { if (c.proc) { const old = c.proc; c.proc = null; old.kill(); old.stop() } c.engine = engine }
  if (opts.mode) c.mode = opts.mode
  let resume = opts.resume ?? !!get('select 1 from conversations where id = ?', id)
  // Remember the chats perch started: only those are ever resumed without asking (follow-ups).
  // by: 'you' when you typed it in perch; otherwise the automation that started it (it stays out of your lists).
  if (!resume && !opts.profile) run('insert or ignore into perch_started (id, at, by) values (?, ?, ?)', id, Date.now(), opts.by ?? 'agent')
  // Which model for this message: Codex (pinned, or covering for a capped Claude model) or a Claude
  // tier, fixed by the chat or picked by the router (auto).
  let pick: { tier: Tier; why: string } | null = null
  const activeEngine = c.proc && c.state === 'running' ? c.engine : engine
  if (!c.profile && !isLocal(activeEngine) && !isCodex(activeEngine)) {
    const fixed = claudeFixed(activeEngine)
    pick = fixed ? { tier: fixed, why: 'your choice' } : route(opts.prompt, { current: c.tier, corrected: isCorrection(opts.prompt), images: opts.images?.length ?? 0, turbo: c.turbo, context: contextTokens(id) })
  }
  // One engine per chat at a time: while a Codex turn runs, more messages queue for Codex; while
  // Claude is mid-turn, the message goes to Claude as a steer instead of starting Codex beside it.
  if (!c.profile && c.codex) { sendCodex(c, opts, isCodex(engine) && engine.includes(':') ? engine.slice(6) : undefined); return id }
  const claudeBusy = !!c.proc && c.state === 'running'
  let cover = claudeBusy ? { codex: false, why: '' } : pick && !claudeFixed(engine) ? wantsCodex(pick.tier, codexReadySync()) : pick && allCapped() && codexReadySync() ? { codex: true, why: 'every Claude model is at its cap' } : { codex: false, why: '' }
  const previousModel = get<{ model: string | null }>('select model from turns where conversation_id = ? order by sent_at desc, rowid desc limit 1', id)?.model ?? ''
  if (!c.profile && !claudeBusy && pick && !claudeFixed(engine)) {
    const budget = chooseProvider({ ...usageNow(), tier: pick.tier, claudeReady: !!available(pick.tier), codexReady: codexReadySync(), localReady: !!settings.local.model && localUpSync(), current: isCodex(previousModel) ? 'codex' : 'claude' })
    if (budget.provider === 'codex') cover = { codex: true, why: budget.why }
    else if (budget.provider === 'local') {
      // Before the local model: a PostHog cloud task keeps the same conversation running on a
      // different subscription pool. The hook takes the message; on failure it resends to local.
      if (cloudFallback && !opts.noCloud) { cloudFallback(opts, id); return id }
      if (c.proc) { const old = c.proc; c.proc = null; old.kill(); old.stop() }
      c.tier = pick.tier; pick = null
      engine = c.engine = settings.local.model
      cover = { codex: false, why: '' }
      if (previousModel !== engine) emit(c, { type: 'perch_notice', text: `Subscription allowances are unavailable. Continuing on ${engine} on this Mac with the same conversation and tools. It is a smaller model; auto-m8 retries the subscriptions on your next turn.` })
    }
  }
  if (!c.profile && !claudeBusy && (isCodex(engine) || cover.codex)) {
    // The engine preference stays on auto during a fallback. Announce the handoff, not every
    // message routed to Codex. Saved turns also remember the last provider across restarts.
    const model = pick ? codexFallbackModel(pick.tier) : engine.includes(':') ? engine.slice(6) : undefined
    if (pick) c.tier = pick.tier
    if (!isCodex(engine) && !isCodex(previousModel)) emit(c, { type: 'perch_notice', text: `Continuing on Codex · ${model ?? 'default model'}: ${cover.why}. Same context and tools; auto-m8 balances the subscriptions automatically.` })
    sendCodex(c, opts, model)
    return id
  }
  if (pick) {
    const tier = available(pick.tier) ?? pick.tier
    if (tier !== c.tier) {
      if (c.proc) c.proc.write(JSON.stringify({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'set_model', model: tier } }) + '\n')
      // Routine switches show as the reply's model divider; only a cap is worth a note.
      if (tier !== pick.tier) emit(c, { type: 'perch_notice', text: `${tierLabel(pick.tier)} is at its usage cap: using ${tierLabel(tier)}` })
      c.tier = tier
    }
  }
  c.lastPrompt = opts.prompt; c.lastImages = opts.images
  // Mid-turn, a message the user didn't type (another agent, EVENTS, a follow-up, a decision) lands
  // in the agent's input between tool calls and pulls it off what it's doing. It still goes in, told
  // to wait its turn. What the user types is a steer and goes in as-is.
  const queued = !opts.resent && !!agentSender(opts.prompt) && !!c.proc && c.state === 'running'
  if (!opts.resent) c.pending.push({ prompt: opts.prompt, images: opts.images, at: Date.now() })
  // You added or removed the API key: restart this idle process so it picks up the new billing.
  // Same session (--resume), same config dir, so the context carries over.
  const now = c.proc && c.account && c.state !== 'running' && !isLocal(c.engine) ? billing() : null
  if (now && now !== c.account) {
    const old = c.proc!; c.proc = null; old.kill(); old.stop()
    resume = true
  }
  if (!c.proc) start(c, resume)
  c.lastUsed = Date.now()
  if (!opts.retry && !opts.resent) emit(c, { type: 'perch_user', text: opts.prompt })
  startTurn(id, opts.prompt, { turbo: c.turbo && !isLocal(c.engine), model: isLocal(c.engine) ? c.engine : c.tier ?? (c.turbo ? 'opus' : settings.chat.model || undefined) })
  setState(c, 'running')
  // A restore point for the files at the start of every turn (git repos only; invisible).
  if (!c.profile) snapshot(id, c.cwd).catch(() => {})
  const text = queued ? QUEUED + opts.prompt : opts.prompt
  const content = opts.images?.length ? [...opts.images, { type: 'text', text }] : text
  c.proc!.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n')
  // Writing to a conversation means you're on it again: it leaves later/done/archived.
  run(`insert into user_state (id, state, state_auto, state_at) values (?, null, 1, ?)
       on conflict(id) do update set state = case when state = 'hidden' then state else null end, state_auto = 1, snooze_until = null, state_at = excluded.state_at`, id, Date.now())
  return id
}

// A model hit its usage cap mid-chat: mark it until the reset, tell you, and resend your message
// on the best model still available (a local one when every Claude model is capped).
function resumeHandoff(c: Chat, engine: string) {
  const queue = c.handoffQueue ?? []
  c.handoffQueue = undefined
  // Dispatch synchronously: a new message cannot overtake the failed one between timers.
  for (const o of queue) send({ ...o, id: c.id, engine: o.engine ?? engine, engineOnce: o.engine === undefined || o.engineOnce })
}

function onCap(c: Chat, until: number, scope: Tier | 'all' = 'all', unanswered: Chat['pending'] = []) {
  const was = c.tier!
  markCapped(scope === 'all' ? 'all' : was, until)
  const at = new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const next = available(was)
  c.capRetries = (c.capRetries ?? 0) + 1
  if (c.capRetries > 3 || !c.lastPrompt) return emit(c, { type: 'perch_notice', text: `${tierLabel(was)} hit its usage cap (resets ${at}).` })
  c.handoffQueue = (unanswered.length ? unanswered : [{ prompt: c.lastPrompt, images: c.lastImages }]).map(o => ({ id: c.id, prompt: o.prompt, images: o.images, retry: true }))
  const onClaude = (tier: Tier) => {
    emit(c, { type: 'perch_notice', text: `${tierLabel(was)} hit its usage cap (resets ${at}). Continuing on ${tierLabel(tier)}.` })
    resumeHandoff(c, `claude:${tier}`)
  }
  const viaCodex = !!next && wantsCodex(was, codexReadySync()).codex
  if (next && !viaCodex) return onClaude(next)
  codexReady().then(cx => {
    if (cx.ok) {
      const model = codexFallbackModel(was)
      emit(c, { type: 'perch_notice', text: `${viaCodex ? `${tierLabel(was)} hit its usage cap (resets ${at})` : `Every Claude model is at its cap (resets ${at})`}. Continuing on Codex · ${model ?? 'default model'} with the same context, MCP servers and instructions; back to Claude after the reset.` })
      resumeHandoff(c, model ? `codex:${model}` : 'codex')
    } else if (next) onClaude(next) // Codex looked ready a minute ago but isn't: a Claude model is still free
    else localFallback(c, at, cx.why)
  })
}
function localFallback(c: Chat, at: string, why: string, again: SendOpts[] = [{ id: c.id, prompt: c.lastPrompt!, images: c.lastImages, retry: true }]) {
  c.handoffQueue ??= again
  if (settings.local.model) {
    emit(c, { type: 'perch_notice', text: `Every Claude model is at its cap (next reset ${at}) and Codex can't take over (${why}). Continuing on ${settings.local.model} on this Mac.` })
    resumeHandoff(c, settings.local.model)
  } else {
    c.handoffQueue = undefined
    emit(c, { type: 'perch_notice', text: `Every Claude model is at its cap (next reset ${at}). Codex can't take over (${why}) and no local model is set up (Settings → Local models).` })
  }
}

// ---------- Codex turns ----------
// Codex's instructions are capped (project_doc_max_bytes, 32 KiB) across the shared AGENTS.md and this
// thread's own. The thread gets the memory index lines that match its task and that the shared file left
// out, within what TOTAL_BUDGET leaves (codexbudget.ts). On 2026-11-22 the uncapped total was 42 KB and
// every Codex turn failed, removing the Claude -> Codex -> cloud -> local fallback.
function codexSystem(c: Chat, prompt: string) {
  const base = `${CODEX_NOTE(c.id)}\n\n${systemPrompt(c.context, c.id)}`
  const row = get<{ t: string }>(`select coalesce(u.title, c.title, '') || ' ' || coalesce(c.first_prompt, '') t from conversations c left join user_state u on u.id = c.id where c.id = ?`, c.id)
  const shared = agentsMdBytes || (() => { try { return statSync(join(HOME, '.codex', 'AGENTS.md')).size } catch { return 0 } })()
  const m = threadMemory(`${row?.t ?? ''} ${prompt}`, allMemoryLines(), agentsMdKept, shared, Buffer.byteLength(base, 'utf8'))
  const total = shared + Buffer.byteLength(base + m.text, 'utf8')
  if (total > CODEX_LIMIT) console.warn(`[codex] ${c.id.slice(0, 8)}: instructions ${total} bytes, over Codex's ${CODEX_LIMIT}; the turn may be refused`)
  return base + m.text
}
const CODEX_NOTE = (id: string) => `You are Codex, working inside auto-m8 for the user. This chat may have started on Claude Code; you're continuing it with the same tools. Read ~/.codex/AGENTS.md (the user's standing instructions and memory index) and follow it. The ${MCP_SERVER} MCP server is connected with PERCH_CONVERSATION_ID=${id}; tool names in the instructions below like ${mcpTool('follow_up')} mean the ${MCP_SERVER} server's follow_up tool. Claude-only tools (ToolSearch, Agent, Skill, TodoWrite, Monitor) don't exist here: use the shell, the MCP servers you have, and skills under ~/.codex/skills instead.`
function handoff(c: Chat): string {
  const path = transcriptPath(c.id, c.cwd)
  if (!existsSync(path)) return ''
  const text = condensed(itemsOf(path), 40_000)
  return text.trim() ? `THE CONVERSATION SO FAR (condensed from the transcript; tool output omitted, so re-read files or re-run checks you depend on):\n\n${text}\n\n---\nTHE USER'S NEW MESSAGE:\n` : ''
}
function imageFiles(images?: any[]): string[] {
  const out: string[] = []
  for (const im of images ?? []) {
    if (im?.type !== 'image' || im.source?.type !== 'base64') continue
    const f = join(tmpdir(), `perch-codex-${randomUUID()}.${String(im.source.media_type ?? 'image/png').split('/')[1] ?? 'png'}`)
    writeFileSync(f, Buffer.from(im.source.data, 'base64')); out.push(f)
  }
  return out
}
function sendCodex(c: Chat, opts: SendOpts, model?: string, saved?: RunRecord) {
  model ??= codexDefaultModel() ?? undefined
  c.lastUsed = Date.now()
  const first = !codexThread(c.id)
  const previous = get<{ model: string | null }>('select model from turns where conversation_id = ? order by sent_at desc, rowid desc limit 1', c.id)?.model ?? ''
  // A resumed Codex thread has its own history. Bring over work Claude/local did since
  // Codex last ran too, rather than only passing context on the very first handoff.
  const context = !saved && !c.codex && (first || !isCodex(previous)) ? handoff(c) : ''
  opts = { ...opts, messageId: opts.messageId ?? (saved ? recordedCodexPrompt(c.id, c.cwd, opts.prompt, saved.started) : null) ?? randomUUID() }
  indexTranscript(recordCodexPrompt({ id: c.id, cwd: c.cwd, messageId: opts.messageId!, prompt: opts.prompt, images: opts.images }))
  if (c.codex) { (c.codexQueue ??= []).push(opts); c.codex.saveQueue(c.codexQueue); if (!opts.retry && !opts.resent) emit(c, { type: 'perch_user', uuid: opts.messageId, text: opts.prompt }); return }
  // A Claude process left idle on this chat would answer nothing now; stop it so the two never overlap.
  if (c.proc && c.state !== 'running') { const old = c.proc; c.proc = null; old.kill(); old.stop() }
  c.lastPrompt = opts.prompt; c.lastImages = opts.images
  const prompt = context + opts.prompt
  if (!opts.resent && !opts.retry) emit(c, { type: "perch_user", uuid: opts.messageId, text: opts.prompt })
  const turnId = saved?.data.recovery.turnId ?? startTurn(c.id, opts.prompt, { turbo: false, model: model ? `codex:${model}` : 'codex' })
  setState(c, 'running')
  const t = codexTurn({
    conversationId: c.id, cwd: c.cwd, mode: c.mode, model, prompt, images: saved ? [] : imageFiles(opts.images), mcpScript: MCP_SCRIPT, node: process.execPath,
    saved, recovery: { turnId, opts, queue: c.codexQueue ?? [], chat: { cwd: c.cwd, mode: c.mode, context: c.context, turbo: c.turbo, engine: c.engine, tier: c.tier } },
    system: codexSystem(c, opts.prompt),
    env: childEnv(undefined, { PERCH_CONVERSATION_ID: c.id, PERCH_AGENT: 'auto-m8 chat (codex)' }),
    message: r => { indexTranscript(recordCodexMessage({ id: c.id, cwd: c.cwd, turnId, ...r })); return codexMessageUuid(turnId, r.itemId) },
    before: r => indexTranscript(recordCodexTurn({ id: c.id, turnId, messageId: opts.messageId, cwd: c.cwd, prompt: opts.prompt, reply: r.text, tools: r.tools })),
  }, ev => { turnEvent(c.id, ev, turnId); emit(c, ev) })
  c.codex = t.proc
  t.done.then(r => {
    c.codex = null; c.pending = []; c.turn = []
    setState(c, 'idle')
    if (r.capped) {
      // Codex hit its own cap: this message and any queued behind it go to Claude (or a local model
      // when every Claude model is out), in order, with their images.
      const again: SendOpts[] = [opts, ...(c.codexQueue ?? [])].map(o => ({ ...o, id: c.id, engine: undefined, retry: true, resent: false }))
      c.codexQueue = []
      c.handoffQueue = again
      if (!allCapped()) {
        const tier = available(claudeFallbackTier(model))!
        emit(c, { type: 'perch_notice', text: `Codex hit its usage limit. Continuing on ${tierLabel(tier)} with the same context.` })
        resumeHandoff(c, `claude:${tier}`)
      } else localFallback(c, 'later', 'Codex is at its limit too', again)
      t.acknowledge()
      return
    }
    const queued = c.codexQueue?.splice(0) ?? []
    for (const next of queued) send({ ...next, id: c.id, retry: true })
    // Same check as Claude's replies: a reply that handed the user a command gets one correction.
    // Sent synchronously after the queued messages, so it lines up behind them and never overtakes one.
    const fix = r.ok && r.text ? runCorrectionFor(c.id, r.text) : null
    if (fix) send({ id: c.id, prompt: fix, resume: true, engine: opts.engine, engineOnce: opts.engineOnce })
    t.acknowledge()
  })
  run(`insert into user_state (id, state, state_auto, state_at) values (?, null, 1, ?)
       on conflict(id) do update set state = case when state = 'hidden' then state else null end, state_auto = 1, snooze_until = null, state_at = excluded.state_at`, c.id, Date.now())
}

export function interrupt(id: string) {
  const c = chats.get(id)
  if (c?.codex) { c.codexQueue = []; c.codex.saveQueue([]); c.codex.kill('SIGINT'); return }
  if (!c?.proc) return
  c.proc.write(JSON.stringify({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } }) + '\n')
  const proc = c.proc
  setTimeout(() => { if (c.proc === proc && c.state === 'running') proc.kill('SIGINT') }, 3000)
}

// Background followers (delegate, orchestra, needs, seek, autoresearch) read a chat's events but
// aren't someone looking at it: they must not keep an idle agent alive. Only other listeners
// (an open chat page or socket) count as watching for the reaper.
const followers = new WeakSet<Listener>()
const watchedBy = (c: Chat) => { for (const l of c.listeners) if (!followers.has(l)) return true; return false }
export function subscribe(id: string, l: Listener, opts: { background?: boolean } = {}) {
  if (opts.background) followers.add(l)
  const c = chats.get(id)
  if (!c) {
    const set = waiting.get(id) ?? new Set()
    set.add(l)
    waiting.set(id, set)
    return () => { set.delete(l); chats.get(id)?.listeners.delete(l) }
  }
  for (const ev of c.turn) l(ev)
  l({ type: 'perch_state', state: c.state })
  c.listeners.add(l)
  return () => c.listeners.delete(l)
}

// /btw: a side question that sees the whole conversation but is never saved into it.
// It runs as a throwaway fork, so it works mid-turn and on chats that aren't open.
export function btw(id: string, question: string, l: Listener) {
  const conv = get<{ cwd: string }>('select cwd from conversations where id = ?', id)
  const args = ['-p', question, ...baseArgs('plan', false).slice(1), '--resume', id, '--fork-session', '--no-session-persistence',
    '--append-system-prompt', 'This is a quick side question (/btw). Answer briefly from what the conversation already contains. Do not change files.']
  return ephemeral(args, conv?.cwd && existsSync(conv.cwd) ? conv.cwd : settings.chat.cwd, l, configDirFor(id))
}

// A one-off Claude run that streams events to l and saves nothing: /btw, "ask my history",
// the daily brief, skill search.
type EphemeralJob = (l: Listener) => () => void

// A cap discovered during this run must not reach JSON consumers as an answer. Wait for
// Claude to finish, then try the fallback once; cancellation still stops the active job.
export function withCapFallback(job: EphemeralJob, fallback: () => EphemeralJob | null, l: Listener) {
  let cappedResult: ChatEvent | undefined, finished = false, cancelled = false
  let stop: (() => void) | undefined
  const initialStop = job(ev => {
    if (finished) return
    if (ev.type === 'result' && ev.is_error) {
      const text = `${ev.result ?? ''} ${ev.error ?? ''} ${JSON.stringify(ev.errors ?? '')}`
      const until = capFrom(text)
      if (until) { markCapped(capScope(text), until); cappedResult = ev; return }
    }
    if (ev.type === 'perch_done') {
      finished = true
      // Some CLI failures only reach stderr, with no result event.
      const until = ev.error ? capFrom(String(ev.error)) : null
      if (until) markCapped(capScope(String(ev.error)), until)
      const next = !cancelled && (cappedResult || until) ? fallback() : null
      if (next) { stop = next(l); return }
      if (cappedResult) l(cappedResult)
    }
    l(ev)
  })
  stop ??= initialStop
  return () => { cancelled = true; stop!() }
}

export function ephemeral(args: string[], cwd: string, l: Listener, configDir?: string) {
  // Text-only background jobs (no tools: a strict, empty MCP config) can run on the local model.
  const textOnly = args.includes('--strict-mcp-config') && args.includes('{"mcpServers":{}}')
  // A cap is noted (router.ts) and never reaches JSON consumers as an answer.
  const claudeJob: EphemeralJob = emit => withCapFallback(emit => {
    // No stdin: with a pipe left open, claude -p waits 3s for input, warns on stderr, and the brief
    // and autopilot scans read that warning as a failure.
    const proc = spawn('claude', args, { cwd, env: childEnv(configDir, claudeEnv()), stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    proc.stdout.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        try { const ev = JSON.parse(line); if (ev.type === 'rate_limit_event') noteClaude(ev, Date.now()); emit(ev) } catch {}
      }
    })
    let err = ''
    proc.stderr.on('data', d => { err += d })
    let done = false
    const finish = (code: number | null, error?: string) => { if (!done) { done = true; emit({ type: 'perch_done', code, error }) } }
    proc.on('error', e => finish(1, String(e.message))) // claude not found: report it, don't crash perch
    proc.on('exit', code => finish(code, code ? err.slice(-1000) : undefined))
    return () => proc.kill()
  }, () => null, emit)
  if (!textOnly) return claudeJob(l)
  const modelFlag = args.findIndex(a => a === '--model' || a === '-m')
  const tier = modelFlag >= 0 ? args[modelFlag + 1] : 'sonnet'
  // Housekeeping only loads the local model when the Mac has room for it (local.ts localRoomSync).
  const localReady = !!settings.local.model && localUpSync() && localRoomSync(), codexReady = codexReadySync()
  const budget = chooseProvider({ ...usageNow(), tier, claudeReady: !allCapped(), codexReady, localReady })
  const local: EphemeralJob = emit => localJob(args, emit)
  const codex: EphemeralJob = emit => codexJob(args, cwd, emit)
  // Under budget pressure, text-only housekeeping uses the free local model first. A failed
  // provider retries once on each remaining provider; failed answers never reach JSON parsers.
  const localFirst = localReady && (settings.local.background || budget.conserve)
  const clouds = budget.provider === 'codex' ? [...(codexReady ? [codex] : []), ...(!allCapped() ? [claudeJob] : [])] : [...(!allCapped() ? [claudeJob] : []), ...(codexReady ? [codex] : [])]
  const jobs = [...(localFirst ? [local] : []), ...clouds, ...(localReady && !localFirst ? [local] : [])]
  return runTextJobs(jobs.length ? jobs : [claudeJob], l)
}

// A stalled agent: it was sent a message but has written nothing at all for 90 seconds (an agent
// always starts streaming within seconds). Seen in the wild: Claude Code finished a turn, stayed
// alive, and stopped reading its input, so later messages sat unread in the pipe. perch stops it
// (it's idle, nothing is lost), starts a fresh one on the same conversation, and resends what never
// arrived. Messages older than 10 minutes aren't resent blind: the chat says which didn't arrive.
// A hung request: Claude Code sent an API request and nothing came back for 3 minutes. Seen in the
// wild: a stream that stalls, which Claude Code itself only gives up on after ~15 minutes. Other
// output (background task progress, hooks) keeps flowing meanwhile, so silence alone misses it.
const STALL = 90_000, HUNG_REQUEST = 180_000, LOCAL_QUIET = 5 * 60_000
// On the local model because Auto fell back to it (not your pick), and a subscription would take
// this chat's next turn now.
export function localFallbackCanReturn(c: { id: string; engine?: string; tier?: string | null }, deps = { engineFor, usageNow, available, codexReadySync, localUpSync }) {
  if (!isLocal(c.engine ?? '') || isLocal(deps.engineFor(c.id))) return false
  const tier = (c.tier ?? 'sonnet') as Tier
  return chooseProvider({ ...deps.usageNow(), tier, claudeReady: !!deps.available(tier), codexReady: deps.codexReadySync(), localReady: deps.localUpSync() }).provider !== 'local'
}
// Worded as an instruction, not a notice: in parentheses agents read it as a system note and
// answered "No response requested." (74 times in 2 days) instead of resuming.
const HUNG_PROMPT = 'Your previous API request got no reply, so auto-m8 restarted this session. This is an instruction, not a notification: resume the task you were working on. Re-check where things stand, finish the remaining steps, and reply with the result.'
// The Mac sleeping freezes every clock below: on wake each chat looks minutes silent. A tick that
// comes late means it slept (or was suspended), so the silence is the machine's, not the agent's.
let lastTick = Date.now()
const hungLogged = new WeakMap<Chat, number>()
setInterval(() => {
  const now = Date.now(), slept = now - lastTick > 60_000
  lastTick = now
  if (slept) {
    // Only running chats: hang detection needs the reset. Idle ones keep their clock, or swap stalls
    // (which also look like a gap) would keep every idle agent "fresh" and the reaper could never stop
    // one, the loop seen 2026-11-18 (144 gaps, 73 agents, swap full).
    for (const c of chats.values()) { if (c.state === 'running') c.lastOutput = now; if (c.requestingAt) c.requestingAt = now }
    console.error("watchdog: timer gap (sleep), not restarting anything")
    return
  }
  for (const c of chats.values()) {
    if (c.state !== 'running' || !c.proc || c.profile) continue
    // A chat on the local model only because the subscriptions were out: when it goes quiet mid-turn
    // and a subscription is usable again, move it back instead of leaving it parked on local.
    const backFromLocal = localFallbackCanReturn(c)
    // Waiting on the API isn't a stall: 1 in 100 requests takes over 165s to start answering, and
    // 108 of 208 stall restarts killed exactly that. Claude Code retries its own requests; silence
    // only counts when it never picked the message up (no request in flight).
    const silent = (c.pending.length > 0 && !c.requestingAt && Date.now() - Math.max(c.lastOutput, c.pending[0].at) >= STALL) || (backFromLocal && Date.now() - c.lastOutput >= LOCAL_QUIET)
    // Restarting a hung request made things worse: the restart nudge was answered "No response
    // requested." (50 times in a day) and Claude Code's own retries recover most of these. So a
    // hung request is logged once and left alone; only a silent agent is restarted.
    if (c.requestingAt && Date.now() - c.requestingAt >= HUNG_REQUEST && hungLogged.get(c) !== c.requestingAt) {
      hungLogged.set(c, c.requestingAt)
      console.error(`chat ${c.id}: API request hung >3 min, leaving it to Claude Code's retries`)
    }
    const hung = false
    if (!silent) continue
    c.restarts = (c.restarts ?? []).filter(t => Date.now() - t < 3600_000)
    if (c.restarts.length >= 3 && !backFromLocal) continue // the network or API is down: restarting won't help, its own retries will
    if (backFromLocal) { c.engine = ''; emit(c, { type: 'perch_notice', text: 'The local model stopped responding and a subscription is available again: auto-m8 moved this chat back to it with the same context.' }) }
    c.restarts.push(Date.now())
    console.error(`chat ${c.id}: ${hung ? 'API request hung' : 'stalled'}, restarting it`)
    c.requestingAt = undefined
    const old = c.proc
    // A stuck process may ignore a polite stop: follow up with a hard one.
    c.proc = null; old.kill(); setTimeout(() => old.kill('SIGKILL'), 3000); old.stop(); forget(c.id)
    // Coming back from a dead local fallback, nothing queued there ever ran: resend all of it.
    const fresh = c.pending.filter(p => backFromLocal || Date.now() - p.at < 10 * 60_000), stale = c.pending.filter(p => !fresh.includes(p))
    c.pending = []
    abandonTurns(c.id, hung ? 'request hung' : 'stall')
    c.turn = []
    setState(c, 'exited')
    // A hung request means the agent did get its messages: don't resend them, just get it going.
    // A local fallback that went quiet with nothing queued is resumed the same way.
    if (hung || (backFromLocal && !fresh.length && !stale.length)) {
      emit(c, { type: 'perch_notice', text: 'The agent\'s API request got no reply for 3 minutes, so auto-m8 restarted it to carry on.' })
      send({ id: c.id, prompt: HUNG_PROMPT, by: 'perch', resume: true })
      continue
    }
    const named = stale.filter(p => !p.prompt.startsWith('(')).map(p => `“${p.prompt.slice(0, 60)}${p.prompt.length > 60 ? '…' : ''}”`)
    if (stale.length) emit(c, { type: 'perch_notice', text: `The agent stopped taking messages, so auto-m8 restarted it. ${stale.length === 1 ? 'Your last message' : `Your last ${stale.length} messages`} (from ${new Date(stale[0].at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}) never reached it${named.length ? `: ${named.join(', ')}` : ''}. Send again if you still need ${stale.length === 1 ? 'it' : 'them'}.` })
    if (fresh.length) {
      emit(c, { type: 'perch_notice', text: `The agent stopped taking messages, so auto-m8 restarted it and is resending ${fresh.length === 1 ? 'your message' : `your ${fresh.length} messages`}.` })
      for (const p of fresh) send({ id: c.id, prompt: p.prompt, images: p.images, resent: true })
    }
  }
}, 15_000).unref()

// Idle processes hold a few hundred MB each (with their MCP servers). Stop them; the next message
// resumes. reaper.ts decides: past the idle limit, beyond a cap on idle processes, or sooner when the
// Mac is short of memory.
let protectedNow = ''
setInterval(() => {
  const now = Date.now()
  const idle = [...chats.values()].filter(c => c.proc && c.state === 'idle')
  // Scouts, routines, shepherds and agents with a wakeup, cron or background job pending are left alone
  // (protection.ts); only chats past the grace period are looked up, so most minutes this reads nothing.
  const tight = strained(lastSample())
  const guarded = (c: Chat, idleMs: number) => {
    if (idleMs <= GRACE_MS || watchedBy(c)) return null
    try {
      const d: any = detail(c.id)
      if (kindProtected(d?.agent_kind, idleMs, tight)) return `${d.agent_kind} chat`
      return pendingWork(transcriptTail(d?.path, 200_000))
    } catch { return null }
  }
  const procs = idle.map(c => { const idleMs = now - Math.max(c.lastUsed, c.lastOutput); return { id: c.id, idleMs, watched: watchedBy(c), protectedWhy: guarded(c, idleMs) } })
  const kept = procs.filter(p => p.protectedWhy)
  const stop = toStop(procs, { limitMs: settings.chat.idleMinutes * 60_000, machine: lastSample() })
  if (kept.length) { const n = new Map<string, number>(); for (const p of kept) n.set(p.protectedWhy!, (n.get(p.protectedWhy!) ?? 0) + 1); protectedNow = [...n].map(([why, count]) => `${count} ${why}`).join(', ') } else protectedNow = ''
  for (const { id, why } of stop) {
    const c = chats.get(id)
    if (!c?.proc || c.state !== 'idle') continue
    const old = c.proc; old.kill(); setTimeout(() => { if (c.proc === old) exited(c, old) }, 3000)
  }
  if (stop.length) {
    const why = [...new Set(stop.map(s => s.why))].join(', ')
    const watched = procs.filter(p => p.watched).length, fresh = procs.filter(p => !p.watched && !p.protectedWhy && p.idleMs <= GRACE_MS).length
    console.log(`[reaper] stopped ${stop.length} idle agent${stop.length > 1 ? 's' : ''} (${why}); ${idle.length - stop.length} idle left: ${watched} open in perch, ${fresh} idle under ${GRACE_MS / 60_000} min, ${kept.length} protected${protectedNow ? ` (${protectedNow})` : ''}`)
    if (stop.some(s => s.why !== 'idle limit')) recordAvailability('pressure', 0, `stopped ${stop.length} idle agents`, `${why}; ${idle.length} were idle`)
  }
}, 60_000).unref()

export function runningChats() {
  return [...chats.values()].map(c => ({ id: c.id, state: c.state, cwd: c.cwd, live: !!c.proc, mode: c.mode }))
}
