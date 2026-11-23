import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { run } from './db.ts'
import { need, reportNeed, updateNeed, HOUR } from './needsstore.ts'
import { ATTENTION, attentionFor, credit, DAY, pickForChat, recordAttention, sourceFamily, surfacings, sweepAttention } from './needsattention.ts'
import { userBody } from '../shared/messageOrigin.ts'

const now = Date.now()
beforeEach(() => { for (const t of ['needs', 'needs_events', 'needs_credit', 'needs_surfaced']) run(`delete from ${t}`) })
function ask(key: string, opts: { source?: string; conversation_id?: string; at?: number } = {}) {
  const n = reportNeed({ key, source: opts.source ?? 'shepherd', title: key, context: 'ctx', conversation_id: opts.conversation_id ?? null }, opts.at ?? now)
  return updateNeed(n.id, { status: 'needs_you', evidence: 'only the user', human_action: `Decide ${key}` }, 'reviewer', opts.at ?? now)
}

test('the owning chat gets one short note once; it is hidden from the displayed message', () => {
  const n = ask('a', { conversation_id: 'chat-a' })
  const note = attentionFor('chat-a', now)
  assert.match(note, /Decide a/)
  assert.match(note, new RegExp(n.id))
  assert.equal(userBody('hello' + note), 'hello')
  assert.equal(attentionFor('chat-a', now + 1), '', 'not repeated while the note is open')
  assert.equal(surfacings(n.id).length, 1)
})

test('daily budget and the cross-chat limit hold', () => {
  for (const k of ['a', 'b', 'c', 'd', 'e']) ask(k)
  assert.notEqual(attentionFor('x1', now), '', 'one cross-chat mention a day')
  assert.equal(attentionFor('x2', now), '')
  ask('own1', { conversation_id: 'o1' }); ask('own2', { conversation_id: 'o2' }); ask('own3', { conversation_id: 'o3' })
  assert.notEqual(attentionFor('o1', now), '')
  assert.notEqual(attentionFor('o2', now), '')
  assert.equal(attentionFor('o3', now), '', `at most ${ATTENTION.perDay} a day`)
  assert.notEqual(attentionFor('o3', now + DAY + 1), '')
})

test('wasted attention costs a source its access; used attention earns it back', () => {
  for (const k of ['w1', 'w2', 'w3']) { const n = ask(k, { source: 'PostHog scout · noisy' }); recordAttention(n.id, 'wasted', now) }
  assert.ok(credit('PostHog scout · noisy') < ATTENTION.minCredit)
  ask('w4', { source: 'PostHog scout · noisy', conversation_id: 'c' })
  assert.equal(pickForChat('c', now), null, 'a low-credit source no longer reaches the user, even in its own chat')
  const good = ask('g', { source: 'terminal' }); recordAttention(good.id, 'used', now)
  assert.ok(credit('terminal') > 0.5)
})

test('shepherd sources with PR numbers share one credit', () => {
  assert.equal(sourceFamily('perch shepherd prod check, cloud-infra#12578'), sourceFamily('perch shepherd prod check, cloud-infra#12482'))
})

test('an ignored mention goes back to agents and costs half; it is not raised again', () => {
  const n = ask('ig', { conversation_id: 'c' })
  attentionFor('c', now)
  sweepAttention(now + ATTENTION.ignoredAfter + 1)
  assert.equal(need(n.id)?.status, 'checking')
  assert.match(need(n.id)?.evidence ?? '', /no response/)
  assert.equal(surfacings(n.id)[0].outcome, 'ignored')
  assert.ok(Math.abs(credit('shepherd') - 1 / 2.5) < 1e-9)
  // The reviewer keeps it as needs_you: same revision never gets another mention.
  updateNeed(n.id, { status: 'needs_you', evidence: 'still blocked', human_action: 'Decide ig' }, 'reviewer', now + ATTENTION.ignoredAfter + 2)
  assert.equal(pickForChat('c', now + ATTENTION.ignoredAfter + 3), null)
})

test('a needs_you item that never earned a mention returns to agents once, not every sweep', () => {
  const n = ask('old', { at: now - ATTENTION.unseenAfter - HOUR })
  sweepAttention(now)
  assert.equal(need(n.id)?.status, 'checking')
  assert.match(need(n.id)?.evidence ?? '', /without earning a mention/)
  updateNeed(n.id, { status: 'needs_you', evidence: 'secret needed', human_action: 'Enter the key' }, 'reviewer', now + 1)
  sweepAttention(now + 2)
  assert.equal(need(n.id)?.status, 'needs_you')
})
