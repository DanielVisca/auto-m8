// Checks on a finished reply for habits the system prompt forbids but agents still slip into.
// Today: telling the user to run or paste a command in their own terminal, instead of running it
// (Bash) or opening it for them with the perch terminal tool. When a reply does that, perch sends the
// agent one correction so it fixes it in the same chat, rather than leaving the user to copy commands.

const ASKS_USER_TO_RUN = [
  /(?:^|[.:!?*\-]\s*|\b(?:you|please|then|just|simply|to|can|could|and|or)\s+)(?:paste|run|type|enter)\b[^.\n]{0,60}\b(?:in|into|from|on)\s+(?:your|a|the)\s+(?:own\s+)?(?:terminal|shell|command line|iterm)\b/i,
  /\byou(?:'ll| will)?\s+(?:need to|have to|can|could|should|may want to|must)\s+run\b/i,
  /\b(?:run|paste)\b[^.\n]{0,40}\byourself\b/i,
  /\bopen (?:a|your) (?:terminal|shell)\b/i,
  /\bcontinue in your terminal\b/i,
]
// It already did the right thing (opened the command for the user in perch), or it's narrating its own run.
const ALREADY_OPEN = /\b(?:opened|open(?:ed)? it|typed in|is waiting|waiting for you) (?:it |the command )?(?:in|under|below)?\s*(?:the |this )?(?:perch |auto-m8 )?(?:terminal|chat)\b|needs_user|terminal (?:below|under the chat)/i

export function asksUserToRun(text: string): string | null {
  if (!text || ALREADY_OPEN.test(text)) return null
  // Commands inside code are what it would run, not the request; look at the prose around them.
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/"[^"\n]{0,120}"|“[^”\n]{0,120}”/g, ' ')
  for (const re of ASKS_USER_TO_RUN) {
    const m = prose.match(re)
    if (!m) continue
    const i = m.index ?? 0
    // The sentence it sits in, for the correction message.
    const start = Math.max(prose.lastIndexOf('.', i), prose.lastIndexOf('\n', i)) + 1
    const end = [prose.indexOf('.', i + m[0].length), prose.indexOf('\n', i + m[0].length)].filter(x => x >= 0).reduce((a, b) => Math.min(a, b), prose.length)
    return prose.slice(start, end + 1).trim().slice(0, 240)
  }
  return null
}

export const RUN_CORRECTION = (said: string) => `⏰ auto-m8 check: your last reply asked the user to run a command themselves (“${said}”).
Don't hand commands to the user. Run it yourself with Bash. If it needs a TTY, use the terminal tool with run=true and drive it. If it really needs the user (a password, a browser approval, a hardware key, or a permission only they can grant, like editing your own settings), call terminal action=open with the command, run=false and needs_user, so it opens under the chat with the command typed in, then wait on it (action=read wait_seconds) and carry on. Do that now, and reply in one or two lines with the result. If nothing is actually needed from the user, just say so in one line.`

// One correction per chat per half hour, so a reply that legitimately mentions a terminal can't loop.
const lastCorrected = new Map<string, number>()
export function runCorrectionFor(chatId: string, replyText: string, now = Date.now()): string | null {
  const last = lastCorrected.get(chatId)
  if (last !== undefined && now - last < 30 * 60_000) return null
  const said = asksUserToRun(replyText)
  if (!said) return null
  lastCorrected.set(chatId, now)
  return RUN_CORRECTION(said)
}
