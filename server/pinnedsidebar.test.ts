// Pinned conversations are always in the sidebar's Pinned section, at the top, whatever their state.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { run } from './db.ts'
import { setStates } from './conversations.ts'
import { sidebar } from './sidebar.ts'

test('pinned conversations show at the top of the sidebar, and hiding or archiving unpins', () => {
  const now = Date.now()
  for (const [id, title] of [['pin-plain', 'Pinned plain'], ['pin-hidden', 'Pinned but hidden'], ['pin-archived', 'Pinned but archived'], ['pin-other', 'Not pinned']]) {
    run(`insert into conversations (id, source, title, first_prompt, started_at, updated_at, messages, status) values (?, 'claude-code', ?, ?, ?, ?, 2, 'completed')`, id, title, title, now, now)
  }
  setStates(['pin-plain', 'pin-hidden', 'pin-archived'], { pinned: true })
  setStates(['pin-hidden'], { state: 'hidden' })
  setStates(['pin-archived'], { state: 'archived' })

  const side = sidebar()
  const pinnedIds = side.pinned.map(c => c.id)
  assert.ok(pinnedIds.includes('pin-plain'))
  assert.ok(!pinnedIds.includes('pin-hidden'), 'hiding unpins')
  assert.ok(!pinnedIds.includes('pin-archived'), 'archiving unpins')
  assert.ok(!pinnedIds.includes('pin-other'))
  // Pinned rows are not repeated further down.
  const below = [...side.now, ...side.needs, ...side.working, ...side.groups.flatMap(g => g.items)].map(c => c.id)
  for (const id of pinnedIds) assert.ok(!below.includes(id), `${id} appears twice`)
})
