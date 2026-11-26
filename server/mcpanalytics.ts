// MCP analytics for auto-m8's own MCP server: one mcp_tool_call event per tool call, in the shape the
// @posthog/mcp SDK sends ($mcp_tool_name, $mcp_duration_ms, $mcp_is_error…), so PostHog's MCP analytics
// reads it like any instrumented server. Our server is hand-rolled JSON-RPC, so the SDK's track(server)
// can't wrap it; this sends the same event instead.
//
// Off unless settings.mcpAnalytics.enabled. It goes to the PostHog project auto-m8 is connected to
// (settings.posthog), using that project's public capture token, read once with the stored key.
// No argument values and no results leave the Mac: only the tool name, timing, error flag, the argument
// names, and for look a few structural fields (action, step kinds, refused or not).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, settings } from './settings.ts'
import { posthogKey } from './keychain.ts'
import { installId } from './telemetry.ts'

const CACHE = join(DATA_DIR, 'mcp-analytics.json')
const VERSION = (() => { try { return JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')).version as string } catch { return '0.0.0' } })()
let client: { name?: string; version?: string } = {}
export const setClient = (c: any) => { client = { name: c?.name, version: c?.version } }

export const enabled = () => !!settings.mcpAnalytics?.enabled && !!settings.posthog.projectId

// The project's public capture token (phc_…), cached for a day so each chat's MCP process doesn't ask.
async function token(): Promise<string | null> {
  try {
    if (existsSync(CACHE)) {
      const c = JSON.parse(readFileSync(CACHE, 'utf8'))
      if (c.project === settings.posthog.projectId && c.host === settings.posthog.host && Date.now() - c.at < 86_400_000 && c.token) return c.token
    }
  } catch {}
  const key = posthogKey()
  if (!key) return null
  const r = await fetch(`${settings.posthog.host}/api/projects/${settings.posthog.projectId}/`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) })
  if (!r.ok) return null
  const t = (await r.json() as any).api_token
  if (t) try { writeFileSync(CACHE, JSON.stringify({ token: t, project: settings.posthog.projectId, host: settings.posthog.host, at: Date.now() }), { mode: 0o600 }) } catch {}
  return t ?? null
}
// us.posthog.com -> us.i.posthog.com; a self-hosted host takes events on itself.
export const ingestHost = (host: string) => host.replace(/^https:\/\/(us|eu)\.posthog\.com/, 'https://$1.i.posthog.com')

// Structure only, never values: which path area, which step kinds, whether a step was refused.
export function lookProps(args: any, resultText: string) {
  const steps = Array.isArray(args?.steps) ? args.steps : []
  const path = typeof args?.path === 'string' ? (args.path.match(/#([a-z-]+)/i)?.[1] ?? (args.path === '/' ? 'home' : 'other')) : undefined
  return {
    look_action: String(args?.action ?? 'picture'),
    look_target: args?.board_id ? 'board' : args?.text ? 'text' : path ? `page:${path}` : undefined,
    look_steps: steps.length || undefined,
    look_step_kinds: steps.length ? steps.map((s: any) => String(s?.do ?? '?')).slice(0, 20) : undefined,
    look_failed_steps: (resultText.match(/^\d+\. FAILED /gm) ?? []).length || undefined,
    look_refused: /\brefused:/.test(resultText) || undefined,
    look_screenshot: !!args?.screenshot || args?.action === undefined || args?.action === 'picture',
    look_no_app: /desktop app isn't running/.test(resultText) || undefined,
  }
}

export function toolCallEvent(name: string, args: any, ms: number, isError: boolean, resultText: string, tok: string) {
  const conversation = process.env.PERCH_CONVERSATION_ID
  return {
    api_key: tok, event: 'mcp_tool_call', distinct_id: `auto-m8:${installId()}`,
    properties: {
      $mcp_tool_name: name, $mcp_server_name: 'auto-m8', $mcp_server_version: VERSION, $mcp_source: 'auto-m8',
      $mcp_client_name: client.name, $mcp_client_version: client.version,
      $mcp_duration_ms: Math.round(ms), $mcp_is_error: isError,
      $mcp_conversation_id: conversation, $mcp_parameters: { keys: Object.keys(args ?? {}).sort() },
      ...(name === 'look' ? lookProps(args, resultText) : {}),
      $process_person_profile: false, $lib: 'auto-m8',
    },
    timestamp: new Date().toISOString(),
  }
}

// Never throws and never holds the tool reply: the caller has already answered the agent.
export async function trackToolCall(name: string, args: any, ms: number, isError: boolean, resultText: string) {
  if (!enabled()) return
  try {
    const tok = await token()
    if (!tok) return
    await fetch(`${ingestHost(settings.posthog.host)}/i/v0/e/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(toolCallEvent(name, args, ms, isError, resultText, tok)), signal: AbortSignal.timeout(4000) })
  } catch {}
}
