// Evolve's deterministic parts: the ask ledger, corrections, dropped work, and skill versions.
// The model calls (grouping, writing, tuning) aren't exercised here.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { QUEUED, stampPrompt } from '../shared/messageOrigin.ts'

const tmp = mkdtempSync(join(tmpdir(), 'perch-evolve-'))
process.env.PERCH_DATA = tmp // retired skills land here, not in the real app folder
const { run, get } = await import('./db.ts')
await import('./promises.ts') // perch_started, promises
const ev = await import('./evolve.ts')

const line = (o: object) => JSON.stringify(o)
const at = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()
const user = (h: number, text: string, uuid: string) => line({ type: 'user', uuid, timestamp: at(h), message: { role: 'user', content: text } })
const agent = (h: number, text: string, id: string) => line({ type: 'assistant', timestamp: at(h), message: { id, role: 'assistant', content: [{ type: 'text', text }] } })

function conversation(id: string, hoursAgo: number, lines: string[], extra: Record<string, any> = {}) {
  const path = join(tmp, `${id}.jsonl`)
  writeFileSync(path, lines.join('\n'))
  run(`insert or replace into conversations (id, source, title, path, started_at, updated_at, asks, stall) values (?, 'claude', ?, ?, ?, ?, ?, ?)`,
    id, id, path, Date.now() - (hoursAgo + 1) * 3600_000, Date.now() - hoursAgo * 3600_000, extra.asks ?? 0, extra.stall ?? null)
}

test('the ledger records each ask once, marks corrections and the last ask', () => {
  conversation('c1', 30, [
    user(32, '<command-name>/model</command-name>', 'u0'),
    user(32, 'Shepherd my open PRs to merge', 'u1'), agent(31.9, 'Done, merged two.', 'a1'),
    user(31, "no, that's wrong: don't merge without stamphog", 'u2'), agent(30.9, 'Reverted. Should I continue?', 'a2'),
  ], { asks: 1 })
  ev.ingest()
  const n = get<any>(`select count(*) n from asks where conversation_id = 'c1'`)!.n
  assert.equal(n, 2) // the slash command isn't an ask
  assert.equal(get<any>(`select corrected from asks where conversation_id = 'c1' and text like 'Shepherd%'`)!.corrected, 1)
  assert.equal(get<any>(`select last from asks where conversation_id = 'c1' and text like 'no,%'`)!.last, 1)
  ev.ingest() // unchanged file: nothing re-read, nothing duplicated
  assert.equal(get<any>(`select count(*) n from asks where conversation_id = 'c1'`)!.n, 2)
})

test("perch's own prompts (follow-ups, resumes, events) aren't your asks", () => {
  conversation('c5', 30, [
    user(33, 'Get the metrics PR merged', 'p1'), agent(32.9, 'On it.', 'q1'),
    user(32, '⏰ Follow-up from perch. Earlier you told the user: “I will check CI”', 'p2'), agent(31.9, 'CI green.', 'q2'),
    user(31, ev.RESUME_PROMPT, 'p3'), agent(30.9, 'Merged.', 'q3'),
    user(30.8, QUEUED + stampPrompt('Continue checking CI.', 'shepherd'), 'p4'),
    user(30.7, stampPrompt('Continue checking CI.', 'routine'), 'p5'),
  ])
  run(`insert into asks (id, conversation_id, ts, text) values ('old', 'c5', 0, '(perch: this chat stalled: x. Carry on)')`)
  ev.ingest()
  const texts = (get<any>(`select group_concat(text, '|') t from asks where conversation_id = 'c5'`)!.t as string).split('|')
  assert.deepEqual(texts, ['Get the metrics PR merged'])
})

test('dropped work: quiet for a day, unfinished, nobody came back', () => {
  conversation('c2', 2, [user(3, 'Fix the flaky test', 'x1'), agent(2.5, 'Which test?', 'y1')], { asks: 1 }) // too recent
  conversation('c3', 40, [user(41, 'Write the migration', 'x2'), agent(40.5, 'Done.', 'y2')]) // finished cleanly
  conversation('c4', 50, [user(51, 'Debug the consumer lag alert', 'x3')], { stall: 'died mid-tool' })
  ev.ingest()
  const ids = ev.dropped().map(d => d.id)
  assert.ok(ids.includes('c1')) // asked a question 30h ago, never answered
  assert.ok(ids.includes('c4')) // stalled
  assert.ok(!ids.includes('c2') && !ids.includes('c3'))
  run(`insert into user_state (id, state, state_auto) values ('c4', 'done', 0)`)
  assert.ok(!ev.dropped().map(d => d.id).includes('c4')) // you marked it done
})

test('skill wishes from agents join the ledger', () => {
  run(`insert into capability_wishes (id, conversation_id, need, would_help, created_at, kind) values ('w1', 'c1', 'a procedure for stamphog eligibility', 'saves 10 steps', ?, 'skill')`, Date.now())
  run(`insert into capability_wishes (id, conversation_id, need, created_at, kind) values ('w2', 'c1', 'Linear access', ?, 'data')`, Date.now())
  ev.ingest()
  assert.equal(get<any>(`select count(*) n from asks where intent = 'wish'`)!.n, 1) // data wishes stay MCP wishes
})

test('skills perch made: retire, restore and roll back keep every version', () => {
  const dir = join(tmp, 'skills', 'perch-shepherd-prs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: perch-shepherd-prs\nversion: 2\n---\nv2 body')
  run(`insert into use_cases (id, name, created_at, updated_at, status) values ('uc1', 'Shepherd PRs', 0, 0, 'forged')`)
  run(`insert into forged (id, name, use_case_id, path, version, status, created_at, updated_at) values ('sk1', 'perch-shepherd-prs', 'uc1', ?, 2, 'live', 0, ?)`, dir, Date.now())
  run(`insert into forged_versions values ('sk1', 1, '---\nname: perch-shepherd-prs\nversion: 1\n---\nv1 body', 'first', 0), ('sk1', 2, 'v2', 'tuned', 1)`)

  ev.rollback('sk1', 1)
  assert.match(readFileSync(join(dir, 'SKILL.md'), 'utf8'), /v1 body/)
  assert.match(readFileSync(join(dir, 'SKILL.md'), 'utf8'), /version: 3/) // a rollback is a new version
  assert.equal(get<any>(`select version from forged where id = 'sk1'`)!.version, 3)

  ev.retire('sk1')
  assert.ok(!existsSync(dir) && existsSync(join(tmp, 'retired-skills', 'perch-shepherd-prs', 'SKILL.md')))
  assert.equal(get<any>(`select status from use_cases where id = 'uc1'`)!.status, 'ignored') // you said no: not made again
  ev.restore('sk1')
  assert.ok(existsSync(join(dir, 'SKILL.md')))
  assert.equal(get<any>(`select status from forged where id = 'sk1'`)!.status, 'live')
})
