import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toItems } from './transcript.ts'
import { parseTaskNotification, waitsOf } from '../shared/waits.ts'

const line = (o: unknown) => JSON.stringify(o)
const notif = (id: string, status: string) => `<task-notification>\n<task-id>x</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n<summary>Agent "Dig into the query layer" finished</summary>\n</task-notification>`

test('a task-notification marks the background call that started it, and stays out of the thread', () => {
  const jsonl = [
    line({ type: 'user', message: { role: 'user', content: 'go' }, timestamp: '2026-11-16T10:00:00Z' }),
    line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { description: 'Query layer investigation' } }] }, timestamp: '2026-11-16T10:00:01Z' }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a1', content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: abc' }] }] }, timestamp: '2026-11-16T10:00:02Z' }),
    line({ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'f1', name: 'mcp__perch__follow_up', input: { conversation_id: 'c', note: 'Check CI', minutes: 30 } }] }, timestamp: '2026-11-16T10:00:03Z' }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'f1', content: 'Scheduled.' }] }, timestamp: '2026-11-16T10:00:04Z' }),
  ]
  const before = toItems(jsonl.join('\n'))
  const tools = (items: any[]) => items.flatMap(i => i.kind === 'assistant' ? i.blocks.filter((b: any) => b.type === 'tool').map((b: any) => ({ block: b, ts: i.ts })) : [])
  const w1 = waitsOf(tools(before))
  assert.equal(w1.length, 2)
  assert.deepEqual([w1[0].kind, (w1[0] as any).what, (w1[0] as any).state, w1[0].label], ['task', 'agent', 'live', 'Query layer investigation'])
  assert.equal(w1[1].kind, 'timer')
  assert.equal((w1[1] as any).dueAt, Date.parse('2026-11-16T10:00:03Z') + 30 * 60_000)

  const after = toItems([...jsonl, line({ type: 'user', message: { role: 'user', content: notif('a1', 'completed') }, timestamp: '2026-11-16T10:05:00Z' })].join('\n'))
  assert.equal(after.filter(i => i.kind === 'user').length, 1, 'the notification is not shown as a user message')
  const w2 = waitsOf(tools(after))
  assert.equal((w2[0] as any).state, 'done')
  assert.match((w2[0] as any).done.summary, /finished/)
})

test('parseTaskNotification reads failures and ignores other text', () => {
  assert.equal(parseTaskNotification(notif('t', 'failed'))?.status, 'failed')
  assert.equal(parseTaskNotification('hello'), null)
})

test('foreground calls and errors are not waits', () => {
  assert.deepEqual(waitsOf([{ block: { type: 'tool', id: 'b', name: 'Bash', input: {}, result: 'ok' } }, { block: { type: 'tool', id: 'c', name: 'Agent', input: {}, result: 'Async agent launched', isError: true } }]), [])
})
