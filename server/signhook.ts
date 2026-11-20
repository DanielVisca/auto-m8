// Agents post GitHub comments from your account, so readers can't tell them from yours. This
// PreToolUse hook (perch passes it to every claude it starts) blocks a comment that isn't signed
// and tells the agent the exact signature to append: a tiny visible line naming the automation,
// plus a hidden marker with the perch conversation id to trace it back.
//   <sub>🤖 <owner>'s agent · perch shepherd</sub>
//   <!-- perch-agent: shepherd, conversation <id> -->
// Bare commands (`/trunk merge`, `@posthog review`) stay unsigned: their bots reject extra text.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { ownerName, possessive } from './owner.ts'

const MARK = 'perch-agent:'

export function signature(env: NodeJS.ProcessEnv = process.env) {
  const by = env.PERCH_AGENT || 'claude code'
  const id = env.PERCH_CONVERSATION_ID
  return `<sub>🤖 ${possessive(ownerName(env))} agent · ${by}</sub>\n<!-- ${MARK} ${by}${id ? `, conversation ${id}` : ''} -->`
}

// One line that is only a command for a bot: "/trunk merge", "@posthog review".
const isCommand = (body: string) => /^\s*[/@][\w-]+(\s+[\w-]+)?\s*$/.test(body)

const MCP_POSTS = /__(add_issue_comment|add_reply_to_pull_request_comment|add_comment_to_pending_review|pull_request_review_write|update_issue_comment)$/

// gh in command position (start of a line, after ; & | ( or $( , optionally after VAR=x), not gh
// mentioned inside text such as a heredoc prompt or an echo.
const ghRun = (sub: string) => new RegExp(String.raw`(?:^|[;&|(\n]|\$\()\s*(?:\w+=\S*\s+)*gh\s+` + sub)

// gh commands that post or edit a comment or review body.
function postsComment(cmd: string) {
  if (ghRun(String.raw`(pr|issue)\s+comment\b`).test(cmd)) return true
  if (ghRun(String.raw`pr\s+review\b`).test(cmd) && /(--body|\s-b\s|--body-file)/.test(cmd)) return true
  if (ghRun(String.raw`api\b`).test(cmd)) {
    if (/\b(addComment|addPullRequestReview|addPullRequestReviewThreadReply|addPullRequestReviewComment|updateIssueComment)\b/.test(cmd)) return true
    if (/\/(comments|reviews|replies)\b/.test(cmd) && /\bbody=/.test(cmd) && !/-X\s*(GET|DELETE)\b/.test(cmd)) return true
  }
  return false
}

// The inline body, when the command gives one in quotes (enough to spot a bare bot command).
function inlineBody(cmd: string) {
  const m = cmd.match(/(?:--body|-b|body=)[\s=]*(["'])([\s\S]*?)\1/)
  return m?.[2]
}

// Body files the command reads: --body-file f, -F f (gh pr comment), body=@f (gh api).
function bodyFiles(cmd: string) {
  const out: string[] = []
  for (const m of cmd.matchAll(/(?:--body-file|(?:^|\s)-F)[\s=]+(?!body=)(["']?)([^\s"']+)\1/g)) out.push(m[2])
  for (const m of cmd.matchAll(/body=@(["']?)([^\s"']+)\1/g)) out.push(m[2])
  return out.map(f => f.replace(/^~(?=\/)/, homedir()))
}

const signedFile = (f: string, cwd: string) => {
  const p = f.startsWith('/') ? f : `${cwd}/${f}`
  try { return existsSync(p) && readFileSync(p, 'utf8').includes(MARK) } catch { return false }
}

// null: let it through. A string: why it's blocked, with the signature to add.
export function check(input: { tool_name?: string; tool_input?: any; cwd?: string }, env: NodeJS.ProcessEnv = process.env): string | null {
  const tool = input.tool_name ?? '', args = input.tool_input ?? {}
  const origin = env.PERCH_ORIGIN_MARKER
  if (origin) {
    const cmd = String(args.command ?? '')
    const creates = tool === 'Bash' ? ghRun(String.raw`(pr|issue)\s+create\b`).test(cmd) : /__(create_pull_request|pull_request_create|create_issue)$/.test(tool)
    if (creates) {
      const bodies = tool === 'Bash' ? [inlineBody(cmd), ...bodyFiles(cmd).map(f => {
        try { return readFileSync(f.startsWith('/') ? f : `${input.cwd ?? process.cwd()}/${f}`, 'utf8') } catch { return '' }
      })] : [args.body]
      if (!bodies.some(body => typeof body === 'string' && body.includes(origin))) return `This creates new work with a recorded origin. Include this exact hidden marker in its description, then retry:\n\n${origin}`
    }
  }
  let body: string | undefined
  if (tool === 'Bash') {
    const cmd = String(args.command ?? '')
    if (!postsComment(cmd) || cmd.includes(MARK)) return null
    if (bodyFiles(cmd).some(f => signedFile(f, input.cwd ?? process.cwd()))) return null
    body = inlineBody(cmd)
    if (body !== undefined && isCommand(body)) return null
  } else if (MCP_POSTS.test(tool)) {
    body = typeof args.body === 'string' ? args.body : undefined
    if (!body || body.includes(MARK) || isCommand(body)) return null
  } else return null
  return `This posts a GitHub comment from ${possessive(ownerName(env))} account, so it must say an agent wrote it. End the comment body with this signature, exactly, on its own lines after a blank line, then retry:\n\n${signature(env)}\n\n(Bare bot commands like "/trunk merge" or "@posthog review" are exempt.)`
}

if (import.meta.main) {
  let raw = ''
  process.stdin.on('data', d => { raw += d })
  process.stdin.on('end', () => {
    let reason: string | null = null
    try { reason = check(JSON.parse(raw)) } catch {}
    if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
  })
}
