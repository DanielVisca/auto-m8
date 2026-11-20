// Finding earlier conversations that relate to a new prompt, and turning chosen ones into a
// context block. Ranking is FTS5 bm25 over titles and message text; titles weigh 3x.
import { readFileSync } from 'node:fs'
import { all, get, run } from './db.ts'
import { toItems, itemsOf } from './transcript.ts'
import { oneLine } from './transcript.ts'

const STOP = new Set('the and for that this with from have what when where which there their about would could should into your just like make want need some then them they will been also more very can how why are was not but all any our out get use its it\'s you'.split(' '))

// Free text to an FTS query: significant words OR'd, each as a prefix match.
export function ftsQuery(text: string) {
  const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])].filter(w => !STOP.has(w)).slice(0, 24)
  return words.map(w => `"${w.replace(/"/g, '')}"*`).join(' OR ')
}

export type Related = { id: string; title: string; snippet: string; updated_at: number; cwd: string | null; source: string; score: number }

export function related(text: string, opts: { limit?: number; exclude?: string } = {}): Related[] {
  const q = ftsQuery(text)
  if (!q) return []
  return all<Related>(`
    select c.id, coalesce(c.title, c.first_prompt) title, c.updated_at, c.cwd, c.source,
      snippet(search, 2, '«', '»', '…', 14) snippet, bm25(search, 0, 3, 1) score
    from search join conversations c on c.id = search.id
    where search match ? and c.id != ?
    order by score limit ?`, q, opts.exclude ?? '', opts.limit ?? 5)
}

// A short brief per conversation: the ask, the last answer, and where to read more.
export function contextBlock(ids: string[]) {
  const parts = ids.map(id => {
    const c = get<any>('select * from conversations where id = ?', id)
    if (!c) return ''
    let last = ''
    if (c.path) {
      const items = itemsOf(c.path)
      for (let i = items.length - 1; i >= 0 && !last; i--) {
        const it = items[i]
        if (it.kind === 'assistant') last = it.blocks.filter(b => b.type === 'text').map(b => (b as any).text).join('\n')
      }
    }
    return [
      `## ${c.title ?? c.first_prompt} (conversation ${c.id})`,
      `Source: ${c.source}${c.cwd ? `, cwd ${c.cwd}` : ''}${c.branch ? `, branch ${c.branch}` : ''}, last active ${new Date(c.updated_at).toISOString().slice(0, 16)}`,
      c.first_prompt ? `It started with: ${oneLine(c.first_prompt, 400)}` : '',
      last ? `Where it ended:\n${last.length > 2500 ? last.slice(0, 2500) + '…' : last}` : '',
    ].filter(Boolean).join('\n')
  }).filter(Boolean)
  return `<earlier-conversations>\nThe user pulled these earlier conversations into this one. Use the perch get_conversation tool to read one in full if this brief is not enough.\n\n${parts.join('\n\n')}\n</earlier-conversations>`
}

export function link(a: string, b: string, kind: string, note?: string) {
  run('insert or ignore into links (a, b, kind, note, created_at) values (?, ?, ?, ?, ?)', a, b, kind, note ?? null, Date.now())
}

export function links(id: string) {
  return all(`
    select l.kind, l.note, l.created_at, case when l.a = ? then l.b else l.a end other,
      case when l.a = ? then 'out' else 'in' end dir, coalesce(c.title, c.first_prompt) title, c.source, c.updated_at
    from links l left join conversations c on c.id = case when l.a = ? then l.b else l.a end
    where l.a = ? or l.b = ? order by l.created_at desc`, id, id, id, id, id)
}
