// Codex instructions stay under its 32 KiB limit (2026-11-22: 42 KB failed every Codex turn).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { budgetAgentsMd, CODEX_LIMIT, memoryLines, threadMemory, TOTAL_BUDGET } from './codexbudget.ts'

const bytes = (s: string) => Buffer.byteLength(s, 'utf8')
const CLAUDE_MD = '# Opening pull requests\n' + 'Write a perch-plan in every PR. '.repeat(240) // ~7.7 KB, always kept
const index = Array.from({ length: 450 }, (_, i) => `- [Topic ${i}](topic-${i}.md) — note ${i} about ${i === 7 ? 'snuffle histogram pushdown' : 'dashboards and metrics'} filler filler filler`).join('\n')
const head = `<!-- marker -->\n# Standing instructions\n\n${CLAUDE_MD}`

test('a 45 KB input comes out under the limit, keeps CLAUDE.md, the newest memory and a pointer to the rest', () => {
  const lines = memoryLines([{ dir: '/mem', text: index }])
  assert.ok(bytes(head) + bytes(index) > 45_000, 'the input is at least 45 KB')
  const r = budgetAgentsMd(head, d => `### Memory in ${d}`, lines)
  assert.ok(bytes(r.text) < 11_500, `shared file is ${bytes(r.text)} bytes`)
  assert.ok(r.text.includes(CLAUDE_MD), 'CLAUDE.md is kept whole')
  assert.ok(r.text.includes('Topic 449'), 'the newest memory line is kept')
  assert.ok(!r.text.includes('[Topic 0]'), 'the oldest is dropped first')
  assert.match(r.text, /older memory lines not shown/)
  assert.ok(r.dropped > 0)
})

test('a thread gets the matching memory the shared file dropped, and the total stays under the budget', () => {
  const lines = memoryLines([{ dir: '/mem', text: index }])
  const r = budgetAgentsMd(head, d => `### Memory in ${d}`, lines)
  const system = "perch system prompt. ".repeat(615) // ~13 KB, the real size of perch's thread instructions
  const m = threadMemory('fix the snuffle histogram pushdown limit', lines, new Set(r.kept.map(l => l.line)), bytes(r.text), bytes(system))
  assert.ok(m.text.includes('Topic 7]'), 'the old but relevant line comes back for this task')
  const total = bytes(r.text) + bytes(system) + bytes(m.text)
  assert.ok(total <= TOTAL_BUDGET && total < CODEX_LIMIT, `total ${total} bytes`)
  assert.equal(threadMemory('xyzzy', lines, new Set(), bytes(r.text), bytes(system)).text, '', 'nothing matches: nothing added')
})
