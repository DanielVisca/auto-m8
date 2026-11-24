// Blockers: failures only a settings change clears (a lapsed sign-in, an MCP server needing OAuth, a
// missing key). One classifier, plain regexes, no model: the chat shows a card that does the fix, and
// the server uses it to restart a chat after a sign-in lapse and to flag the lapse in /api/status.
// Shared by web (Chat, Composer) and server (chat.ts, errors.ts).

export type BlockerKind = 'claude-login' | 'claude-missing' | 'codex-login' | 'mcp-auth' | 'gh-login' | 'posthog-key'
export type Blocker = { kind: BlockerKind; title: string; detail: string; server?: string }

// Claude's own wordings for a lapsed sign-in. "Failed to authenticate: OAuth session expired and could
// not be refreshed" was the common one (302 chat failures in two days) and matched nothing before.
export const NEEDS_LOGIN = /\/login\b|invalid api key|oauth (token|session) (has )?(expired|revoked)|could not be refreshed|failed to authenticate|authentication_(error|failed)|not logged in|invalid authentication credentials|api error: 401/i

// Server name from a text like "The Slack MCP server (plugin:slack:slack) needs authorization".
export function serverNeedingAuth(text: string): string | null {
  if (!/needs?[ -](authori[sz]ation|authenticat|auth\b)|needs-auth|not authenticated/i.test(text)) return null
  return text.match(/\bplugin:[\w-]+:[\w-]+/)?.[0]
    ?? text.match(/needs ([\w:.-]+) authorized/)?.[1]
    ?? text.match(/\bclaude\.ai [\w ]+?(?= (?:MCP|connector|server|needs)\b)/)?.[0]
    ?? null
}

// "plugin:slack:slack" → "Slack", "plugin:design:figma" → "Figma", "claude.ai Slack" → "Slack".
export const serverLabel = (s: string) => {
  // "plugin:design:figma" → "Figma": a plugin with several servers is named by the server.
  const base = s.replace(/^claude\.ai /, '').replace(/^plugin:([^:]+):(.*)$/, (_, p, srv) => srv || p)
  return base.charAt(0).toUpperCase() + base.slice(1)
}

// The first match wins; null when the text isn't a settings blocker (network blips, caps and plain
// failures retry on their own and get no card).
export function blockerFor(text: string | undefined | null): Blocker | null {
  const t = String(text ?? '')
  if (!t) return null
  const mcp = serverNeedingAuth(t)
  if (mcp) return { kind: 'mcp-auth', server: mcp, title: `${serverLabel(mcp)} needs authorizing`, detail: `Approve ${serverLabel(mcp)} in your browser; the chat can use it right after.` }
  if (/codex/i.test(t) && /signed out|not logged in|codex login|401 unauthorized|unauthori[sz]ed|refresh token/i.test(t))
    return { kind: 'codex-login', title: 'Codex is signed out', detail: 'Sign in with your ChatGPT account. The chat carries on once it finishes.' }
  if (/gh auth login|not logged in(to)? (to )?(any )?github|To get started with GitHub CLI|gh: not logged/i.test(t))
    return { kind: 'gh-login', title: 'GitHub CLI is signed out', detail: 'PR status, shepherds and gh commands need it.' }
  if (/No PostHog personal API key|PostHog rejected your key|PostHog 401/i.test(t))
    return { kind: 'posthog-key', title: 'PostHog needs your personal API key', detail: 'Paste a personal API key; auto-m8 keeps it in your keychain.' }
  if (/spawn claude ENOENT|claude not found|claude: command not found/i.test(t))
    return { kind: 'claude-missing', title: 'Claude Code isn’t installed', detail: 'Install it, then sign in.' }
  if (NEEDS_LOGIN.test(t)) return { kind: 'claude-login', title: 'Claude is signed out', detail: 'Your Claude sign-in lapsed. Sign in again and your message is sent again.' }
  return null
}

// For agent prose: only a short message that is itself the failure (Claude prints "Not logged in ·
// Please run /login" as an assistant message), never a long reply that merely talks about signing in.
// It has to start like an error ("Not logged in · Please run /login", "Failed to authenticate: …"):
// a reply quoting one ("Claude prints 'Please run /login'…") is not a failure.
const ERROR_START = /^(not logged in|invalid api key|failed to authenticate|api error|oauth|error\b|please run \/login|authentication|the [\w .]+ mcp server \([^)]*\) needs)/i
export const blockerInText = (text: string) => { const t = text.trim(); return t.length < 300 && ERROR_START.test(t) ? blockerFor(t) : null }
