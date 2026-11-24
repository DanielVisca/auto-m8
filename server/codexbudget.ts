// Codex refuses a turn when its combined instructions (global ~/.codex/AGENTS.md + this thread's
// developer instructions) pass project_doc_max_bytes, 32 KiB: on 2026-11-22 they were 42,434 bytes
// (CLAUDE.md + ~250 memory index lines), which silently removed the Claude -> Codex -> cloud -> local
// safety net. CLAUDE.md always stays; memory index lines are kept newest first within a budget, and
// the lines that match a chat's task go into that chat's thread instructions instead.
export const CODEX_LIMIT = 32_768
export const TOTAL_BUDGET = 26_000 // shared + thread; perch's own thread prompt alone is ~13 KB, so this leaves ~6.7 KB under CODEX_LIMIT
export const GLOBAL_BUDGET = 11_000 // the shared AGENTS.md: CLAUDE.md (~7.6 KB) plus the newest memory lines

export type MemLine = { dir: string; line: string; order: number }
const bytes = (s: string) => Buffer.byteLength(s, 'utf8')
const STOP = new Set('this that with from have will your what when then than they them were been into about only also just more most over such some very each make made does done using used here there their which would could should after before while where these those other being under again'.split(' '))
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9#\- ]+/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !STOP.has(w)))

// Index lines from each MEMORY.md, in file order (perch and Claude Code append, so later = newer).
export function memoryLines(indexes: { dir: string; text: string }[]): MemLine[] {
  let order = 0
  return indexes.flatMap(({ dir, text }) => text.split('\n').filter(l => l.trim().startsWith('- ')).map(line => ({ dir, line: line.trim(), order: order++ })))
}

// Newest lines first that fit maxBytes, returned in their original order.
export function newestWithin(lines: MemLine[], maxBytes: number): MemLine[] {
  const out: MemLine[] = []; let used = 0
  for (const l of [...lines].sort((a, b) => b.order - a.order)) { const n = bytes(l.line) + 1; if (used + n > maxBytes) continue; out.push(l); used += n }
  return out.sort((a, b) => a.order - b.order)
}

// Lines whose name/description share words with the task, best match first then newest, within maxBytes.
export function relevantLines(task: string, lines: MemLine[], maxBytes: number, skip: Set<string> = new Set()): MemLine[] {
  const want = words(task)
  if (!want.size) return []
  const scored = lines.filter(l => !skip.has(l.line)).map(l => { let s = 0; for (const w of words(l.line)) if (want.has(w)) s++; return { l, s } }).filter(x => x.s > 0)
  scored.sort((a, b) => b.s - a.s || b.l.order - a.l.order)
  const out: MemLine[] = []; let used = 0
  for (const { l } of scored) { const n = bytes(l.line) + 1; if (used + n > maxBytes) continue; out.push(l); used += n }
  return out
}

// The shared AGENTS.md: header and CLAUDE.md always, then as many newest memory lines as fit.
export function budgetAgentsMd(head: string, memHeader: (dir: string) => string, lines: MemLine[], budget = GLOBAL_BUDGET) {
  const dirs = [...new Set(lines.map(l => l.dir))]
  const pointer = (n: number) => n ? `\n\n(${n} older memory line${n === 1 ? '' : 's'} not shown to stay under Codex's instruction limit: grep the MEMORY.md files above, or the memory folder, for the topic before relying on memory.)` : ''
  const render = (kept: MemLine[]) => `${head}\n\n## Memory\n${dirs.map(d => `${memHeader(d)}\n\n${kept.filter(l => l.dir === d).map(l => l.line).join('\n')}`).join('\n\n') || '(none yet)'}${pointer(lines.length - kept.length)}\n`
  const fixed = bytes(render([])) + 200
  const kept = newestWithin(lines, Math.max(0, budget - fixed))
  return { text: render(kept), kept, dropped: lines.length - kept.length }
}

// This thread's share: memory lines relevant to the task that the shared file left out, within
// what the total budget leaves after the shared file and the thread's own instructions.
export function threadMemory(task: string, lines: MemLine[], shared: Set<string>, sharedBytes: number, systemBytes: number, budget = TOTAL_BUDGET) {
  const room = budget - sharedBytes - systemBytes - 300
  if (room <= 0) return { text: '', lines: [] as MemLine[] }
  const picked = relevantLines(task, lines, room, shared)
  return { text: picked.length ? `\n\nMEMORY FOR THIS TASK (index lines matched to this chat; each points to a file in ${[...new Set(picked.map(l => l.dir))].join(', ')}):\n${picked.map(l => l.line).join('\n')}` : '', lines: picked }
}
