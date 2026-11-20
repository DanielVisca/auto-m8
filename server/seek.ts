// The search agent: Claude with read-only tools over everything you can reach (this Mac, all
// your repos, conversations, notes, Slack, meetings, GitHub, and upstream source it clones to
// ground itself). It checks scope first and widens only when it has to, fans out to parallel
// subagents when the question splits, and can be steered while it runs.
//
// It also gets better with use: a playbook of short search tactics is injected into every run,
// each tactic is scored by how the runs that used it went (your 👍/👎, whether you opened what
// it cited), and tactics that don't help are retired. New tactics are proposed from the logs.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chats, ephemeral, interrupt, PERCH_MCP, send, subscribe } from './chat.ts'
import { editLabels, setTitle } from './conversations.ts'
import { prContext } from './prflow.ts'
import { all, db, get, run } from './db.ts'
import { localRepos } from './search.ts'
import { HOME, settings } from './settings.ts'

db.exec(`
create table if not exists search_runs (
  id text primary key, conversation_id text, q text, mode text, auto integer, started_at integer, finished_at integer,
  cost real, tools integer default 0, agents integer default 0, meta text, feedback integer, opened integer default 0, turns integer default 0
);
create table if not exists playbook (
  id text primary key, text text not null, status text default 'trial', -- trial | active | retired
  uses integer default 0, wins integer default 0, losses integer default 0, origin text, reason text, created_at integer, last_used integer
);
`)

export const SRC_CACHE = join(HOME, 'Library/Caches/perch/src')
mkdirSync(SRC_CACHE, { recursive: true })

export type Mode = 'fast' | 'balanced' | 'deep'

// Picks a mode from the question itself, instantly and for free. You can always override it.
export function autoMode(q: string): { mode: Mode; why: string } {
  const t = q.toLowerCase()
  if (/\b(deep ?dive|thorough(ly)?|everything|everywhere|all (the )?(places|repos|sources)|investigate|compare|audit|across)\b/.test(t)) return { mode: 'deep', why: 'asks for breadth' }
  if (/\bhow (does|do|did|is)\b.+\b(work|implement|handle|do it|done)\b|\bwhy (does|do|is|did)\b/.test(t)) return { mode: 'deep', why: 'a how-or-why question: worth reading the source' }
  if (/\b(quick(ly)?|just|where('s| is)|which (file|repo|pr|channel)|find (the|my)|link to|path)\b/.test(t) || t.split(/\s+/).length <= 5) return { mode: 'fast', why: 'a lookup' }
  return { mode: 'balanced', why: 'a normal question' }
}

const MODES: Record<Mode, { model: string; guide: string }> = {
  fast: { model: 'sonnet', guide: 'FAST: answer in under a minute. One or two sources, no subagents, stop at the first solid answer.' },
  balanced: { model: 'sonnet', guide: 'BALANCED: check the likely sources, widen once if needed. Up to 3 parallel subagents when the question clearly splits.' },
  deep: { model: '', guide: 'DEEP: be thorough. Split independent sub-questions across parallel subagents (Agent tool, 3-6, each with a crisp self-contained brief and the sources it should use). Read primary source code, cloning upstream repos when the question is about how another project works. Cross-check claims before answering.' },
}

export function playbookRules() {
  return all<any>(`select * from playbook where status != 'retired' order by status = 'active' desc, wins - losses desc limit 25`)
}

function systemPrompt(mode: Mode, cwd: string, conversationId: string) {
  const repos = localRepos().slice(0, 40).map(r => `- ${r.name}: ${r.path}${r.remote ? ` (${r.remote.replace(/^git@github.com:|^https:\/\/github.com\//, '').replace(/\.git$/, '')})` : ''}`).join('\n')
  const rules = playbookRules().map(r => `[${r.id}] ${r.text}`).join('\n')
  return `You are Mothership's search agent. Find what the user means, reliably, wherever it is, and answer briefly with citations. You are read-only: never edit, commit, post or send anything.

Mode: ${MODES[mode].guide}
The user is working in: ${cwd}

SCOPE FIRST. Before searching, decide where this most likely lives and write ONE line that starts with "Scope:" (e.g. "Scope: this repo, then my other repos" or "Scope: upstream grafana/grafana source"). Search the narrowest scope that could answer. Widen only if it doesn't, and write a new "Scope:" line each time you widen. Levels:
1. The current project (${cwd}).
2. Everything local: all repos below, the user's past conversations, notes and open PRs (perch tools: search_conversations, get_conversation, search_notes, open_prs, search_skills), and files anywhere in ${HOME} (rg, mdfind for documents).
3. People and talk: Slack (slack search tools), meetings (Granola tools).
4. Outside: GitHub (gh search code / prs / issues, gh api), the web, and upstream source. When the question is how another project does something, go to the source: git clone --depth 1 --filter=blob:none https://github.com/<owner>/<repo> ${SRC_CACHE}/<owner>/<repo> (if it is already there: git -C <dir> fetch --depth 1 origin, then git -C <dir> grep … origin/HEAD), then rg in it.

Local repos:
${repos}

Use rg (fast, respects .gitignore) for code: rg -n -i --max-count 5 '<pattern>' <dirs>. Search several repos in one call. Prefer exact identifiers when the user gives them.
NEVER cd into another folder (it is denied). Pass paths instead: rg <pattern> <dir>, and git -C <repo> <command>.
STALE CHECKOUTS: a local repo may be on an old branch. If what you need isn't there, check \`git -C <repo> log -1 --format=%cd\` and \`git -C <repo> branch --show-current\`; if it is old or not on main, run \`git -C <repo> fetch origin main --quiet\` and read the latest with \`git -C <repo> grep -n '<pattern>' origin/main\` and \`git -C <repo> show origin/main:<path>\`. This never touches the user's working tree.
If a command is denied, switch to an allowed one (rg, Grep, Read, git grep/show, gh). Never ask the user to change permissions.
${rules ? `\nPlaybook (tactics learned from earlier searches; use them when they fit):\n${rules}\n` : ''}
ANSWER FORMAT. Lead with the answer in 1-3 sentences, then at most ~10 short bullets (deep mode may use more). Cite everything:
- files as [path/file.ts:42](perch-file://<absolute path>#L42)
- past conversations as [title](perch://<id>)
- Slack, GitHub and web as their https links.
Say plainly what you could not find or verify. No preamble, no restating the question.
End with this line exactly (machine-read, hidden from the user):
<!--perch {"scopes": ["levels you searched, e.g. current, local, slack, upstream"], "playbook": ["ids of playbook tactics you used"], "confidence": "high|medium|low", "found": true}-->
This search's conversation id is ${conversationId}.`
}

// Read-only: only these tools are allowed; everything else is denied without asking.
export const ALLOWED = [
  'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'ToolSearch', 'TodoWrite',
  'Bash(rg:*)', 'Bash(mdfind:*)', 'Bash(ls:*)', 'Bash(find:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(cd:*)', 'Bash(mkdir -p:*)',
  'Bash(gh search:*)', 'Bash(gh api:*)', 'Bash(gh repo view:*)', 'Bash(gh pr view:*)', 'Bash(gh pr list:*)', 'Bash(gh pr diff:*)', 'Bash(gh issue view:*)',
  'Bash(sed -n:*)', 'Bash(sort:*)', 'Bash(uniq:*)', 'Bash(jq:*)',
  // git that only reads, or only updates remote-tracking refs: never the working tree or your branches.
  'Bash(git clone:*)', 'Bash(git fetch:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git grep:*)', 'Bash(git ls-files:*)',
  'Bash(git branch:*)', 'Bash(git status:*)', 'Bash(git rev-parse:*)', 'Bash(git ls-remote:*)', 'Bash(git diff:*)', 'Bash(git remote -v:*)',
  // The same reads against another repo by path (this mode won't cd across folders).
  ...['log', 'show', 'grep', 'fetch', 'branch', 'rev-parse', 'ls-files', 'ls-remote', 'diff', 'status'].map(c => `Bash(git -C * ${c} *)`),
  // perch reads only (search never starts work): history, notes, PRs, skills, registry, and logging gaps.
  ...['search_conversations', 'get_conversation', 'recent_activity', 'search_notes', 'search_skills', 'use_skill', 'open_prs', 'discover_mcp', 'report_missing_capability'].map(t => `mcp__perch__${t}`),
  // GitHub reads only (no writes): file contents, code search, PRs, commits, issues.
  'mcp__claude_ai_GitHub_Copilot_MCP__get_file_contents', 'mcp__claude_ai_GitHub_Copilot_MCP__search_code', 'mcp__claude_ai_GitHub_Copilot_MCP__pull_request_read',
  'mcp__claude_ai_GitHub_Copilot_MCP__search_pull_requests', 'mcp__claude_ai_GitHub_Copilot_MCP__list_pull_requests', 'mcp__claude_ai_GitHub_Copilot_MCP__list_commits',
  'mcp__claude_ai_GitHub_Copilot_MCP__get_commit', 'mcp__claude_ai_GitHub_Copilot_MCP__issue_read', 'mcp__claude_ai_GitHub_Copilot_MCP__search_issues', 'mcp__claude_ai_GitHub_Copilot_MCP__search_repositories',
  'mcp__plugin_slack_slack__slack_search_public_and_private', 'mcp__plugin_slack_slack__slack_search_public', 'mcp__plugin_slack_slack__slack_read_thread',
  'mcp__plugin_slack_slack__slack_read_channel', 'mcp__plugin_slack_slack__slack_search_channels',
  'mcp__claude_ai_Granola__search_meetings', 'mcp__claude_ai_Granola__search_transcripts', 'mcp__claude_ai_Granola__get_meetings', 'mcp__claude_ai_Granola__query_granola_meetings',
  'mcp__claude_ai_Google_Drive__search_files', 'mcp__claude_ai_Google_Drive__read_file_content',
]

function profile(mode: Mode, cwd: string, id: string) {
  const model = MODES[mode].model || settings.chat.model
  return ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'dontAsk',
    ...(model ? ['--model', model] : []), '--add-dir', HOME, '--mcp-config', PERCH_MCP(),
    '--append-system-prompt', systemPrompt(mode, cwd, id), '--allowedTools', ...ALLOWED]
}

export function startSearch(input: { q: string; mode?: Mode | 'auto'; cwd?: string }) {
  const auto = !input.mode || input.mode === 'auto'
  const pick = auto ? autoMode(input.q) : { mode: input.mode as Mode, why: 'chosen' }
  const cwd = input.cwd || settings.chat.cwd
  const id = randomUUID()
  send({ by: 'search', id, cwd, prompt: input.q, profile: profile(pick.mode, cwd, id), context: true, resume: false })
  editLabels([id], ['search'])
  const runId = randomUUID()
  run('insert into search_runs (id, conversation_id, q, mode, auto, started_at) values (?, ?, ?, ?, ?, ?)', runId, id, input.q, pick.mode, auto ? 1 : 0, Date.now())
  track(runId, id)
  return { id, runId, mode: pick.mode, why: pick.why }
}

// Follows the run: tool and subagent counts, cost, and the hidden meta line at the end.
function track(runId: string, conversationId: string) {
  let text = ''
  subscribe(conversationId, ev => {
    if (ev.type === 'stream_event' && !ev.parent_tool_use_id && ev.event?.delta?.type === 'text_delta') text += ev.event.delta.text
    if (ev.type === 'stream_event' && ev.event?.type === 'content_block_start' && ev.event.content_block?.type === 'tool_use') {
      run('update search_runs set tools = tools + 1, agents = agents + ? where id = ?', ['Agent', 'Task'].includes(ev.event.content_block.name) ? 1 : 0, runId)
    }
    if (ev.type === 'perch_user') text = ''
    if (ev.type === 'result' && !ev.parent_tool_use_id) {
      const m = text.match(/<!--perch\s*(\{[\s\S]*?\})\s*-->/)
      let meta: any = null
      try { meta = m ? JSON.parse(m[1]) : null } catch {}
      run('update search_runs set finished_at = ?, cost = coalesce(cost, 0) + ?, meta = coalesce(?, meta), turns = turns + 1 where id = ?', Date.now(), ev.total_cost_usd ?? 0, meta ? JSON.stringify(meta) : null, runId)
      for (const pid of meta?.playbook ?? []) run('update playbook set uses = uses + 1, last_used = ? where id = ?', Date.now(), String(pid))
    }
  }, { background: true })
}

const STEER: Record<string, string> = {
  faster: 'Steer: wrap up quickly. Use what you already have, skip anything slow, and answer now.',
  deeper: 'Steer: go deeper. Widen the scope, use parallel subagents for the open sub-questions, and read primary sources.',
  stop: 'Stop searching and answer now with what you have, saying what is unverified.',
}

export function steer(conversationId: string, text: string) {
  const c = chats.get(conversationId)
  const msg = STEER[text] ?? `Steer: ${text}`
  if (text === 'stop' && c?.state === 'running') interrupt(conversationId)
  send({ by: 'you', id: conversationId, prompt: msg, profile: c?.profile })
}

// Your reaction scores the tactics the run used. Opening a citation counts as a quiet 👍.
export function feedback(conversationId: string, value: 1 | -1 | 'opened') {
  const r = get<any>('select * from search_runs where conversation_id = ? order by started_at desc limit 1', conversationId)
  if (!r) return
  const used: string[] = (r.meta ? JSON.parse(r.meta).playbook : null) ?? []
  if (value === 'opened') {
    if (r.opened || r.feedback != null) return
    run('update search_runs set opened = 1 where id = ?', r.id)
    for (const p of used) run('update playbook set wins = wins + 1 where id = ?', p)
  } else {
    const prev = r.feedback
    run('update search_runs set feedback = ? where id = ?', value, r.id)
    for (const p of used) {
      if (prev === 1 || (prev == null && r.opened)) run('update playbook set wins = wins - 1 where id = ?', p)
      if (prev === -1) run('update playbook set losses = losses - 1 where id = ?', p)
      run(`update playbook set ${value === 1 ? 'wins' : 'losses'} = ${value === 1 ? 'wins' : 'losses'} + 1 where id = ?`, p)
    }
  }
  evaluatePlaybook()
}

// Tactics earn their place: trial → active after 3 wins at 60%+; retired below 40% after 6
// scored uses, or when a trial goes unused for 30 days.
export function evaluatePlaybook() {
  for (const p of all<any>(`select * from playbook where status != 'retired'`)) {
    const scored = p.wins + p.losses
    const rate = scored ? p.wins / scored : 0
    if (p.status === 'trial' && p.wins >= 3 && rate >= 0.6) run(`update playbook set status = 'active', reason = ? where id = ?`, `${p.wins}/${scored} good runs`, p.id)
    else if (scored >= 6 && rate < 0.4) run(`update playbook set status = 'retired', reason = ? where id = ?`, `only ${p.wins}/${scored} good runs`, p.id)
    else if (p.status === 'trial' && Date.now() - (p.last_used ?? p.created_at) > 30 * 86400_000) run(`update playbook set status = 'retired', reason = 'unused for 30 days' where id = ?`, p.id)
  }
}

export function addTactic(text: string, origin = 'manual') {
  const n = Number(get<any>(`select count(*) n from playbook`)?.n ?? 0) + 1
  const id = `P${n}`
  run('insert into playbook (id, text, origin, created_at) values (?, ?, ?, ?)', id, text.trim(), origin, Date.now())
  return id
}

// Learning: Claude reads recent searches (what was asked, how it went, what it cost, your
// reactions) and the playbook's scores, then proposes new tactics (they start on trial) and
// names tactics to retire. Runs after every 5 new searches.
let learning = false
export function learn(): Promise<{ added: string[]; retired: string[] }> {
  if (learning) return Promise.resolve({ added: [], retired: [] })
  const runs = all<any>(`select q, mode, auto, finished_at - started_at ms, cost, tools, agents, meta, feedback, opened, turns from search_runs where finished_at is not null order by started_at desc limit 40`)
  if (runs.length < 3) return Promise.resolve({ added: [], retired: [] })
  learning = true
  const book = all<any>('select * from playbook').map(p => `- [${p.id}] (${p.status}, used ${p.uses}, ${p.wins}👍 ${p.losses}👎) ${p.text}`).join('\n') || 'empty'
  const log = runs.map(r => `- "${String(r.q).slice(0, 120)}" mode=${r.mode}${r.auto ? '(auto)' : ''} ${Math.round(r.ms / 1000)}s $${(r.cost ?? 0).toFixed(2)} tools=${r.tools} agents=${r.agents} turns=${r.turns} feedback=${r.feedback ?? (r.opened ? 'opened a citation' : 'none')} meta=${r.meta ?? 'none'}`).join('\n')
  const prompt = `You tune a search agent. Below are its recent runs and its current playbook of tactics. Steering turns > 1 usually mean the first answer missed; 👎 means it failed; long, expensive runs for simple lookups mean it over-searched.
Propose at most 3 NEW short tactics (one sentence each, concrete: which source or command for which kind of question) that would have made these runs faster or more reliable, and list playbook ids that are hurting or redundant. Don't repeat existing tactics.
Reply with ONLY JSON: {"add": ["..."], "retire": [{"id": "P3", "why": "..."}]}

## Runs
${log}

## Playbook
${book}`
  return new Promise(resolve => {
    let out = ''
    ephemeral(['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', settings.ai.model, '--no-session-persistence',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk'], settings.chat.cwd, ev => {
      if (ev.type === 'result') out = String(ev.result ?? '')
      if (ev.type !== 'perch_done') return
      learning = false
      let r: any = {}
      try { r = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) } catch {}
      const added = (r.add ?? []).slice(0, 3).map((t: string) => addTactic(t, 'learned'))
      const retired: string[] = []
      for (const x of r.retire ?? []) {
        if (get('select 1 from playbook where id = ? and status != ?', x.id, 'retired')) { run(`update playbook set status = 'retired', reason = ? where id = ?`, `learner: ${x.why}`, x.id); retired.push(x.id) }
      }
      run(`insert into briefs (day, created_at, data) values ('search-learn', ?, ?) on conflict(day) do update set created_at = excluded.created_at, data = excluded.data`, Date.now(), JSON.stringify({ added, retired }))
      resolve({ added, retired })
    })
  })
}

export function maybeLearn() {
  const last = Number(get<any>(`select created_at from briefs where day = 'search-learn'`)?.created_at ?? 0)
  const fresh = Number(get<any>('select count(*) n from search_runs where finished_at > ?', last)?.n ?? 0)
  if (fresh >= 5) learn()
}

export function history() {
  return all<any>(`select r.*, c.title from search_runs r left join conversations c on c.id = r.conversation_id order by r.started_at desc limit 30`)
}

export function searchStats() {
  return all<any>(`select mode, count(*) n, avg(finished_at - started_at) ms, avg(cost) cost, sum(feedback = 1) up, sum(feedback = -1) down, sum(opened) opened from search_runs where finished_at is not null group by mode`)
}

// "Summarize these PRs" from Insights: the search agent (read-only, same tools), seeded with the
// selected PRs and, for contrast, the ones that shipped in the same areas. It can open PR threads
// and the conversations behind them to understand why work stalled or was dropped.
export async function summarizePrs(input: { label: string; question?: string; prs: any[]; contrast?: any[] }) {
  const context = await prContext(input.prs.map(p => p.url))
  const day = (t: number | null) => t ? new Date(t).toISOString().slice(0, 10) : '–'
  const line = (p: any) => `- ${p.url} | ${p.area} | ${p.outcome} | review ${p.review} | opened ${day(p.created)} | ${p.merged ? `merged ${day(p.merged)}` : p.closed ? `closed ${day(p.closed)}` : `last activity ${day(p.last)}`}${p.why ? ` | ${p.why}` : ''} | ${p.title}${p.conversation ? ` | conversation ${p.conversation}` : ''}`
  const question = input.question?.trim() || (/abandon/i.test(input.label)
    ? 'What kind of work tends to get abandoned, and what sets it apart from the work that ships? Look for trends: area, size, scope, how long it lived, review history, whether it was superseded by another PR.'
    : /stale|stalled/i.test(input.label) ? 'Why is this work stuck? Group it by cause, and say which are worth reviving, closing, or handing to a shepherd.'
    : 'Summarize this work along a timeline: what got done, what was dropped or is stuck, and the themes that connect it.')
  const prompt = `${question}

Selection: ${input.label} (${input.prs.length} PRs)
${input.prs.slice(0, 120).map(line).join('\n')}
${input.contrast?.length ? `\nFor contrast, PRs that merged in the same areas (${input.contrast.length}):\n${input.contrast.slice(0, 60).map(line).join('\n')}` : ''}

${context ? `\nWhat each PR said, for up to 30 of them (size, description, last comments and reviews, PRs that referenced it):\n${context}\n` : ''}
How to work: the list is the ground truth for states and dates, and the excerpts above usually say why. Answer from them first. Only if something is unclear, look further: one \`gh pr view <url> --comments\` per call (shell loops and pipes are blocked here), or get_conversation for a linked conversation. Stay brief. Answer with: one line overall, then 3–6 bullets of patterns, each with a count and 2–3 example PR links, then one line on what to do about it. No preamble.`
  const id = randomUUID()
  const cwd = settings.chat.cwd
  send({ by: 'pr-summary', id, cwd, prompt, profile: profile('balanced', cwd, id), context: true, resume: false })
  editLabels([id], ['search'])
  setTitle(id, `PR summary: ${input.label}`)
  return { id }
}
