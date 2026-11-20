// A chat's family: the one it branched from (and that one's parent, up to the root) and every
// chat branched off any of them. Branches, rewinds and "pull into a new chat" all count; loose
// "related" links don't, so the tree stays the line of work you started.
import { all, get } from './db.ts'

const KINDS = ['branch', 'rewound', 'context']
const MAX = 60

export type Member = { id: string; title: string; parent: string | null; depth: number; kind: string | null; updated_at: number | null }

const parentsOf = (id: string) => all<{ b: string; kind: string }>(`select b, kind from links where a = ? and kind in (${KINDS.map(() => '?').join(',')}) and b <> a order by created_at`, id, ...KINDS)
const childrenOf = (id: string) => all<{ a: string; kind: string }>(`select a, kind from links where b = ? and kind in (${KINDS.map(() => '?').join(',')}) and a <> b order by created_at`, id, ...KINDS)
const info = (id: string) => get<any>(`select coalesce(u.title, c.title, c.first_prompt) title, c.updated_at from conversations c left join user_state u on u.id = c.id where c.id = ?`, id)

export function family(id: string): { root: string; members: Member[] } {
  // Up: follow the first parent until there is none (guarding against loops).
  let root = id
  const up = new Set([id])
  for (;;) {
    const p = parentsOf(root)[0]
    if (!p || up.has(p.b) || !info(p.b)) break
    up.add(p.b)
    root = p.b
  }
  // Down: every descendant of the root, depth first so the list reads as a tree.
  const members: Member[] = []
  const seen = new Set<string>()
  const walk = (cid: string, parent: string | null, kind: string | null, depth: number) => {
    if (seen.has(cid) || members.length >= MAX) return
    seen.add(cid)
    const i = info(cid)
    if (!i) return
    members.push({ id: cid, title: String(i.title ?? 'Untitled').slice(0, 120), parent, depth, kind, updated_at: i.updated_at ?? null })
    for (const c of childrenOf(cid)) walk(c.a, cid, c.kind, depth + 1)
  }
  walk(root, null, null, 0)
  // A chat with a second parent (pulled two chats together) still shows the one you are in.
  if (!seen.has(id)) { const i = info(id); if (i) members.push({ id, title: String(i.title ?? 'Untitled'), parent: null, depth: 0, kind: null, updated_at: i.updated_at ?? null }) }
  return { root, members }
}
