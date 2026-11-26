// What auto-m8's own MCP tools are used for, kept on this Mac: one row in mcp_events per tool call
// (tool, conversation, client, duration, error), plus for look its action, target and step outcomes.
// Read by Insights (main.ts analytics → mcp) and by tiles through source 'perch' /api/analytics.
// Nothing here is sent anywhere. tool_calls (derived from transcripts) counts every tool of every
// server; this adds what only the MCP process sees: timing, client, and per-action detail.
import { run } from './db.ts'

let client: { name?: string; version?: string } = {}
export const setClient = (c: any) => { client = { name: c?.name, version: c?.version } }

// Structure only, never values: which page area, which step kinds, whether a step was refused.
export function lookProps(args: any, resultText: string) {
  const steps = Array.isArray(args?.steps) ? args.steps : []
  const path = typeof args?.path === 'string' ? (args.path.match(/#([a-z-]+)/i)?.[1] ?? (args.path === '/' ? 'home' : 'other')) : undefined
  return {
    action: String(args?.action ?? 'picture'),
    target: args?.board_id ? 'board' : args?.text ? 'text' : path ? `page:${path}` : undefined,
    steps: steps.length || undefined,
    step_kinds: steps.length ? steps.map((s: any) => String(s?.do ?? '?')).slice(0, 20) : undefined,
    failed_steps: (resultText.match(/^\d+\. FAILED /gm) ?? []).length || undefined,
    refused: /\brefused:/.test(resultText) || undefined,
    no_app: /desktop app isn't running/.test(resultText) || undefined,
  }
}

// The row as stored. action: look's action, or the action argument most auto-m8 tools take.
export function toolCallRow(name: string, args: any, ms: number, isError: boolean, resultText: string) {
  const props = name === 'look' ? lookProps(args, resultText) : undefined
  return {
    ts: Date.now(), conversation_id: process.env.PERCH_CONVERSATION_ID ?? null, tool: name,
    action: props?.action ?? (typeof args?.action === 'string' ? args.action.slice(0, 40) : null),
    client: client.name ?? null, duration_ms: Math.round(ms), is_error: isError ? 1 : 0,
    props: props ? JSON.stringify(props) : null,
  }
}

// Never throws: the agent already has its answer.
export function recordToolCall(name: string, args: any, ms: number, isError: boolean, resultText: string) {
  try {
    const r = toolCallRow(name, args, ms, isError, resultText)
    run('insert into mcp_events (ts, conversation_id, tool, action, client, duration_ms, is_error, props) values (?, ?, ?, ?, ?, ?, ?, ?)',
      r.ts, r.conversation_id, r.tool, r.action, r.client, r.duration_ms, r.is_error, r.props)
  } catch {}
}
