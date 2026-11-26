// What a chat pulled in from other conversations, read from its own transcript: the brief of
// earlier conversations put in front of its first message, and every get_conversation read the
// agent made later. Each pull says where in the thread it happened (so the UI can jump there),
// how many characters crossed over, and a short preview of what it got.
import { statSync } from 'node:fs'
import { get } from './db.ts'
import { itemsOf } from './transcript.ts'
import { convIdOf } from '../shared/brand.ts'

export type Pull = {
  source: string | null // conversation it came from; null for a search
  title: string | null
  how: 'brief' | 'read' | 'search'
  chars: number
  ts: number | null
  uuid?: string // the user message carrying a brief
  tool?: string // the tool call that read or searched
  preview: string
  query?: string
}
export type Pulls = { pulls: Pull[]; total: { briefs: number; reads: number; searches: number; chars: number } }

const CONV = /mcp__(?:auto-m8|auto_m8|perch)__(get_conversation|search_conversations)$/
const titleOf = (id: string) => get<any>(`select coalesce(u.title, c.title, c.first_prompt) t from conversations c left join user_state u on u.id = c.id where c.id = ?`, id)?.t ?? null
const preview = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 600)

// Transcripts only grow, so a result is good until the file changes size.
const memo = new Map<string, { size: number; out: Pulls }>()

export function pulls(id: string): Pulls {
  const empty: Pulls = { pulls: [], total: { briefs: 0, reads: 0, searches: 0, chars: 0 } }
  const path = get<{ path: string }>('select path from conversations where id = ?', id)?.path
  if (!path) return empty
  let size = 0
  try { size = statSync(path).size } catch { return empty }
  const hit = memo.get(id)
  if (hit && hit.size === size) return hit.out
  const out: Pull[] = []
  for (const it of itemsOf(path)) {
    if (it.kind === 'user') {
      const block = it.text.match(/<earlier-conversations>([\s\S]*?)<\/earlier-conversations>/)?.[1]
      if (!block) continue
      // One section per conversation: "## <title> (conversation <id>)" then its brief.
      for (const sec of block.split(/\n(?=## )/).filter(s => s.startsWith('## '))) {
        const m = sec.match(/^## (.*) \(conversation ([^)\s]+)\)/)
        if (!m) continue
        out.push({ source: m[2], title: titleOf(m[2]) ?? m[1], how: 'brief', chars: sec.length, ts: it.ts ?? null, uuid: it.uuid, preview: preview(sec.split('\n').slice(1).join('\n')) })
      }
      continue
    }
    for (const b of it.blocks) {
      if (b.type !== 'tool') continue
      const m = b.name.match(CONV)
      if (!m) continue
      const input = (b.input ?? {}) as Record<string, unknown>
      const result = b.result ?? ''
      if (m[1] === 'get_conversation') {
        const src = typeof input.id === 'string' ? convIdOf(input.id) : null
        out.push({ source: src, title: src ? titleOf(src) : null, how: 'read', chars: b.isError ? 0 : result.length, ts: it.ts ?? null, tool: b.id, preview: preview(result) })
      } else {
        out.push({ source: null, title: null, how: 'search', chars: result.length, ts: it.ts ?? null, tool: b.id, preview: preview(result), query: typeof input.query === 'string' ? input.query : undefined })
      }
    }
  }
  const total = {
    briefs: out.filter(p => p.how === 'brief').length,
    reads: out.filter(p => p.how === 'read').length,
    searches: out.filter(p => p.how === 'search').length,
    chars: out.reduce((n, p) => n + p.chars, 0),
  }
  const res = { pulls: out, total }
  memo.set(id, { size, out: res })
  return res
}
