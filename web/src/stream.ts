// Folds Claude Code stream-json events into the same Item shape the server builds from a
// transcript, so history and live output render through one component.
import type { Block, Item } from './api'

const modelOf = (m: unknown) => typeof m === 'string' && m && m !== '<synthetic>' ? m : undefined

export type Live = { items: Item[]; seen: Set<string>; running: boolean; tools: Map<string, Extract<Block, { type: 'tool' }>>; cur: Extract<Item, { kind: 'assistant' }> | null }

export const emptyLive = (): Live => ({ items: [], seen: new Set(), running: false, tools: new Map(), cur: null })

// A background task finished (same parse as shared/waits.ts; this file stays import-free for its test sandbox).
function parseTaskNotification(text: string) {
  if (!/^\s*<task-notification>/.test(text)) return null
  const tag = (n: string) => text.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`))?.[1]?.trim()
  const toolUseId = tag('tool-use-id'), status = tag('status')
  return toolUseId && status ? { toolUseId, status, summary: tag('summary') } : null
}

export function apply(s: Live, ev: any): void {
  if (ev.parent_tool_use_id) return // a subagent's inner turns; its result arrives as a tool result
  // Codex saves before publishing; a reconnect can load the same message from both sources.
  if (ev.uuid && (ev.type === 'perch_user' || ev.type === 'assistant')) {
    if (s.seen.has(ev.uuid)) return
    s.seen.add(ev.uuid)
  }
  switch (ev.type) {
    case 'perch_user':
      s.items.push({ kind: 'user', text: ev.text, uuid: ev.uuid, ts: ev.ts ?? Date.now() })
      s.cur = null
      return
    case 'perch_state':
      s.running = ev.state === 'running'
      return
    case 'perch_notice':
      s.items.push({ kind: 'notice', text: ev.text })
      s.cur = null
      return
    case 'perch_error':
      s.items.push({ kind: 'error', text: ev.message })
      return
    case 'stream_event': {
      const e = ev.event
      if (e.type === 'message_start') {
        s.cur = { kind: 'assistant', blocks: [], mid: e.message?.id, ts: ev.ts ?? Date.now(), model: modelOf(e.message?.model) }
        s.items.push(s.cur)
      } else if (s.cur && e.type === 'content_block_start') {
        const b = e.content_block
        const block: Block = b.type === 'tool_use' ? { type: 'tool', id: b.id, name: b.name, input: b.input, json: '' }
          : b.type === 'thinking' ? { type: 'thinking', text: '' } : { type: 'text', text: b.text ?? '' }
        s.cur.blocks[e.index] = block
        if (block.type === 'tool') s.tools.set(block.id, block)
      } else if (s.cur && e.type === 'content_block_delta') {
        const b = s.cur.blocks[e.index]
        if (!b) return
        if (e.delta.type === 'text_delta' && b.type === 'text') b.text += e.delta.text
        else if (e.delta.type === 'thinking_delta' && b.type === 'thinking') b.text += e.delta.thinking
        else if (e.delta.type === 'input_json_delta' && b.type === 'tool') b.json = (b.json ?? '') + e.delta.partial_json
      } else if (s.cur && e.type === 'content_block_stop') {
        const b = s.cur.blocks[e.index]
        if (b?.type === 'tool' && b.json) { try { b.input = JSON.parse(b.json) } catch {} }
      }
      return
    }
    case 'assistant': {
      // Normally already streamed. Without a stream (e.g. a replayed turn) build it from here.
      if (s.cur?.mid === ev.message?.id) return
      const item: Item = { kind: 'assistant', blocks: [], uuid: ev.uuid, mid: ev.message?.id, ts: ev.ts ?? Date.now(), model: modelOf(ev.message?.model) }
      for (const b of ev.message?.content ?? []) {
        if (b.type === 'text') item.blocks.push({ type: 'text', text: b.text })
        else if (b.type === 'tool_use') { const t: Block = { type: 'tool', id: b.id, name: b.name, input: b.input }; s.tools.set(b.id, t); item.blocks.push(t) }
      }
      s.items.push(item)
      s.cur = item
      return
    }
    case 'user': {
      const c = ev.message?.content
      const note = parseTaskNotification(typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : '')
      if (note) { const t = s.tools.get(note.toolUseId); if (t) t.done = { status: note.status, summary: note.summary, at: ev.ts ?? Date.now() } }
      for (const b of Array.isArray(c) ? c : []) {
        if (b?.type !== 'tool_result') continue
        const t = s.tools.get(b.tool_use_id)
        if (t) {
          t.result = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c: any) => c.text ?? '').join('\n')
          t.isError = !!b.is_error
        }
      }
      return
    }
    case 'result':
      s.items.push({
        kind: 'result', ok: !ev.is_error, text: ev.is_error ? String(ev.result ?? ev.subtype) : '',
        cost: ev.perch_cost ?? ev.total_cost_usd, ms: ev.duration_ms, denials: ev.permission_denials?.length, switched: ev.perch_switch ?? undefined,
      })
      s.cur = null
      s.running = false
      return
  }
}

// Registers the tool blocks of loaded history so later results attach to them.
export function adopt(s: Live, history: Item[]) {
  for (const i of history) if ('uuid' in i && i.uuid) s.seen.add(i.uuid)
  for (const i of history) if (i.kind === 'assistant') for (const b of i.blocks) if (b.type === 'tool') s.tools.set(b.id, b)
}

// One line that says what a tool call did: the command, file, pattern or URL.
export function toolSummary(name: string, input: any): string {
  if (!input || typeof input !== 'object') return ''
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt ?? input.skill
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').slice(0, 160)
  const first = Object.values(input).find(x => typeof x === 'string') as string | undefined
  return first ? first.replace(/\s+/g, ' ').slice(0, 160) : ''
}

export function toolLabel(name: string) {
  if (name.startsWith('mcp__')) {
    const [, server, tool] = name.split('__')
    return `${server.replace(/^claude_ai_|^plugin_\w+?_/, '')} · ${tool}`
  }
  return name
}
