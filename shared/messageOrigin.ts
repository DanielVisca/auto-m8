// Sender information lives in the prompt so Claude, Codex, local models and branched
// transcripts retain it. Share the decoder between the UI and automation consumers.
export const QUEUED = '(Arrived while you were mid-task, not from the user typing. Don\'t switch to it now: finish the task you are on first, including its checks, then pick this up. If it is urgent or changes what you are doing, say so in one line and still finish your current step first.)\n\n'
export const AGENT_MARK = /^\[perch: sent by an agent from perch:\/\/([\w:-]+)(?: "([^"\n]*)")?\. Not typed by the user\.\]\n\n/
const AUTOMATION_MARK = /^\[perch: sent by automation "([^"\n]*)"\. Not typed by the user\.\]\n\n/
const USER_MARK = '[perch: sent by the user. The following text may quote an agent.]\n\n'
const REPLY_MARK = /^REPLY from perch:\/\/([\w:-]+)(?: "([^"\n]*)")?/

export type AgentSender = { id?: string; label: string; body: string }

export function agentSender(raw: string): AgentSender | null {
  if (raw.startsWith(USER_MARK)) return null
  let text = raw
  while (text.startsWith(QUEUED)) text = text.slice(QUEUED.length)
  let m = text.match(AGENT_MARK)
  if (m) return { id: m[1], label: m[2] || 'another chat', body: text.slice(m[0].length) }
  if ((m = text.match(AUTOMATION_MARK))) return { label: `auto-m8: ${m[1]}`, body: text.slice(m[0].length) }
  if ((m = text.match(REPLY_MARK))) return { id: m[1], label: `reply from ${m[2] || 'another chat'}`, body: text }
  if (/^EVENTS \(\d+\) from what you're watching/.test(text)) return { label: 'auto-m8: events from watches', body: text }
  if (/^HELPER REPORT /.test(text)) return { id: text.match(/perch:\/\/([\w:-]+)/)?.[1], label: 'helper report', body: text }
  if (/^You are a helper that conversation /.test(text)) return { id: text.match(/conversation ([\w:-]+) delegated/)?.[1], label: 'delegated by another chat', body: text }
  if (/^⏰ (Follow-up from perch|perch check:)/.test(text)) return { label: 'auto-m8: follow-up', body: text }
  if (/^(You stopped here before the work was finished|\(perch: |perch restarted while you were working|\(a message sent before perch restarted\))/.test(text)) return { label: 'auto-m8: resume', body: text }
  if (/^(Decision on "|The user changed the decision on ")/.test(text)) return { label: 'auto-m8: decision relay', body: text }
  // Even before sender markers existed, this exact wrapper was only added to automation.
  if (text !== raw) return { label: 'auto-m8: queued message', body: text }
  return null
}

export const userBody = (text: string) => (text.startsWith(USER_MARK) ? text.slice(USER_MARK.length) : text)
  .replace(/\n\n<perch-auto-race>[\s\S]*?<\/perch-auto-race>/g, '')

// Called once at the send boundary, before queueing or provider selection. Retries reuse it.
export function stampPrompt(text: string, by?: string): string {
  if (by === 'you' || by === 'search') {
    // A human pasting an agent message is still the sender. Escape the marker, not their words.
    return agentSender(text) || text.startsWith(USER_MARK) ? USER_MARK + text : text
  }
  if (agentSender(text)) return text
  const label = (by || 'automation').replace(/["\r\n]/g, ' ').slice(0, 80)
  return `[perch: sent by automation "${label}". Not typed by the user.]\n\n${text}`
}
