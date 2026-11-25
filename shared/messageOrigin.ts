// Sender information lives in the prompt so Claude, Codex, local models and branched
// transcripts retain it. Share the decoder between the UI and automation consumers.
export const QUEUED = '(Arrived while you were mid-task, not from the user typing. Don\'t switch to it now: finish the task you are on first, including its checks, then pick this up. If it is urgent or changes what you are doing, say so in one line and still finish your current step first.)\n\n'
// New marks say auto-m8; prompts written before the rename say perch, so both parse.
export const AGENT_MARK = /^\[(?:auto-m8|perch): sent by an agent from (?:auto-m8|perch):\/\/([\w:-]+)(?: "([^"\n]*)")?\. Not typed by the user\.\]\n\n/
const AUTOMATION_MARK = /^\[(?:auto-m8|perch): sent by automation "([^"\n]*)"\. Not typed by the user\.\]\n\n/
const USER_MARK = '[auto-m8: sent by the user. The following text may quote an agent.]\n\n'
const USER_MARK_RE = /^\[(?:auto-m8|perch): sent by the user\. The following text may quote an agent\.\]\n\n/
const REPLY_MARK = /^REPLY from (?:auto-m8|perch):\/\/([\w:-]+)(?: "([^"\n]*)")?/
const userMarked = (t: string) => USER_MARK_RE.test(t)

export type AgentSender = { id?: string; label: string; body: string }

export function agentSender(raw: string): AgentSender | null {
  if (userMarked(raw)) return null
  let text = raw
  while (text.startsWith(QUEUED)) text = text.slice(QUEUED.length)
  let m = text.match(AGENT_MARK)
  if (m) return { id: m[1], label: m[2] || 'another chat', body: text.slice(m[0].length) }
  if ((m = text.match(AUTOMATION_MARK))) return { label: `auto-m8: ${m[1]}`, body: text.slice(m[0].length) }
  if ((m = text.match(REPLY_MARK))) return { id: m[1], label: `reply from ${m[2] || 'another chat'}`, body: text }
  if (/^EVENTS \(\d+\) from what you're watching/.test(text)) return { label: 'auto-m8: events from watches', body: text }
  if (/^HELPER REPORT /.test(text)) return { id: text.match(/(?:auto-m8|perch):\/\/([\w:-]+)/)?.[1], label: 'helper report', body: text }
  if (/^You are a helper that conversation /.test(text)) return { id: text.match(/conversation ([\w:-]+) delegated/)?.[1], label: 'delegated by another chat', body: text }
  if (/^⏰ (Follow-up from (?:auto-m8|perch)|(?:auto-m8|perch) check:)/.test(text)) return { label: 'auto-m8: follow-up', body: text }
  if (/^(You stopped here before the work was finished|\((?:auto-m8|perch): |(?:auto-m8|perch) restarted while you were working|\(a message sent before (?:auto-m8|perch) restarted\))/.test(text)) return { label: 'auto-m8: resume', body: text }
  if (/^(Decision on "|The user changed the decision on ")/.test(text)) return { label: 'auto-m8: decision relay', body: text }
  const sub = subagentReport(text)
  if (sub) return sub
  // Even before sender markers existed, this exact wrapper was only added to automation.
  if (text !== raw) return { label: 'auto-m8: queued message', body: text }
  return null
}

// Claude Code hands a background subagent's final report back as a user-role message:
// "Another Claude session sent a message:\n<agent-message from="<agentId>">\n[Subagent hand-back] …
// The report follows:\n  <report, every line indented two spaces>\n</agent-message>\n\n<guidance>".
// Show only the report. The agentId is Claude Code's, not a conversation, so it isn't a link.
function subagentReport(text: string): AgentSender | null {
  const m = text.match(/^(?:Another Claude session sent a message:\n)?<agent-message from="[^"]*">\n([\s\S]*?)(?:\n<\/agent-message>[\s\S]*)?$/)
  if (!m) return null
  let body = m[1]
  const frame = body.match(/^\[Subagent hand-back\][^\n]*?The report follows:\n/)
  if (frame) body = body.slice(frame[0].length).replace(/^ {2}/gm, '')
  return { label: frame ? 'subagent report' : 'another agent', body: body.trim() }
}

export const userBody =(text: string) => text.replace(USER_MARK_RE, '')
  .replace(/\n\n<perch-auto-race>[\s\S]*?<\/perch-auto-race>/g, '')
  .replace(/\n\n<perch-attention>[\s\S]*?<\/perch-attention>/g, '')

// Called once at the send boundary, before queueing or provider selection. Retries reuse it.
export function stampPrompt(text: string, by?: string): string {
  if (by === 'you' || by === 'search') {
    // A human pasting an agent message is still the sender. Escape the marker, not their words.
    return agentSender(text) || userMarked(text) ? USER_MARK + text : text
  }
  if (agentSender(text)) return text
  // by: 'perch' is the internal id the app uses when it resumes a chat itself (restarts, pauses, stalls).
  const label = (by === 'perch' ? 'resume' : by || 'automation').replace(/["\r\n]/g, ' ').slice(0, 80)
  return `[auto-m8: sent by automation "${label}". Not typed by the user.]\n\n${text}`
}
