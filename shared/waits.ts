// What an agent left running when its turn ended: background agents, shell commands and
// workflows (Claude Code reports each back with a <task-notification>), and perch follow-up
// timers. The chat shows these as a "Waiting" card so you can tell a turn that's done from one
// that's waiting on something, whether that wait is still live, and what it's waiting for.

export type TaskDone = { status: string; summary?: string; at?: number }
type ToolLike = { type: 'tool'; id: string; name: string; input: any; result?: string; isError?: boolean; done?: TaskDone }

// <task-notification><tool-use-id>toolu_…</tool-use-id><status>completed</status><summary>…</summary>
export function parseTaskNotification(text: string): { toolUseId: string; status: string; summary?: string } | null {
  if (!/^\s*<task-notification>/.test(text)) return null
  const tag = (n: string) => text.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`))?.[1]?.trim()
  const toolUseId = tag('tool-use-id'), status = tag('status')
  return toolUseId && status ? { toolUseId, status, summary: tag('summary') } : null
}

export type Wait =
  | { kind: 'task'; id: string; label: string; what: 'agent' | 'command' | 'workflow'; state: 'live' | 'done' | 'failed'; startedAt?: number; done?: TaskDone }
  | { kind: 'timer'; id: string; label: string; what: 'follow-up' | 'wakeup'; dueAt?: number; prUrl?: string; until?: string }

const BACKGROUND = /^(Async agent launched|Command running in background with ID|Workflow launched in background|Monitor started)/

const str = (v: unknown) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''

// The waits one turn started, from its tool calls. ts is when the call was made.
export function waitsOf(tools: { block: ToolLike; ts?: number }[]): Wait[] {
  const out: Wait[] = []
  for (const { block: b, ts } of tools) {
    if (b.isError || b.result === undefined) continue
    if (BACKGROUND.test(b.result)) {
      const what = /^Async agent/.test(b.result) ? 'agent' : /^Workflow/.test(b.result) ? 'workflow' : 'command'
      const label = str(b.input?.description) || (what === 'workflow' ? str(b.result.match(/Summary: (.*)/)?.[1]) || str(b.input?.name) : '') || str(b.input?.command).slice(0, 100) || b.name
      const state = !b.done ? 'live' : b.done.status === 'completed' ? 'done' : 'failed'
      out.push({ kind: 'task', id: b.id, label, what, state, startedAt: ts, done: b.done })
    } else if (b.name === 'mcp__perch__follow_up') {
      const mins = Number(b.input?.minutes) || (b.input?.pr_url ? 120 : 20)
      out.push({ kind: 'timer', id: b.id, label: str(b.input?.note) || 'Follow-up', what: 'follow-up', dueAt: ts ? ts + mins * 60_000 : undefined, prUrl: b.input?.pr_url, until: b.input?.pr_url ? (b.input?.until ?? 'checks') : undefined })
    } else if (b.name === 'ScheduleWakeup' && !b.input?.stop) {
      out.push({ kind: 'timer', id: b.id, label: str(b.input?.reason) || 'Wake up', what: 'wakeup', dueAt: ts ? ts + Number(b.input?.delaySeconds ?? 0) * 1000 : undefined })
    }
  }
  return out
}
