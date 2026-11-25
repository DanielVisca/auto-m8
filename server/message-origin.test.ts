import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentSender, QUEUED, stampPrompt, userBody } from '../shared/messageOrigin.ts'
import { toItems } from './transcript.ts'
// The browser module has type-only browser imports; load it without pulling its
// bundler-specific import paths into the server's NodeNext typecheck.
const { apply, emptyLive } = await import(new URL('../web/src/stream.ts', import.meta.url).href)

const relayed = '[perch: sent by an agent from perch://driver-1 "PR monitor". Not typed by the user.]\n\nShip the fix.'

test('queued agent messages retain sender identity after history reload', () => {
  const live = emptyLive()
  apply(live, { type: 'perch_user', text: relayed })
  const saved = toItems(JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: QUEUED + relayed } }))[0]
  assert.equal(saved.kind, 'user')
  assert.equal(live.items[0].kind, 'user')
  if (saved.kind !== 'user' || live.items[0].kind !== 'user') return
  assert.deepEqual(agentSender(saved.text), agentSender(live.items[0].text))
  assert.deepEqual(agentSender(saved.text), { id: 'driver-1', label: 'PR monitor', body: 'Ship the fix.' })
})

test('historical queued helper reports and unmarked automation show their origin', () => {
  assert.equal(agentSender(QUEUED + 'HELPER REPORT (from a helper): finished')?.label, 'helper report')
  assert.equal(agentSender(QUEUED + 'Continue the work.')?.label, 'auto-m8: queued message')
  assert.equal(agentSender('⏰ Follow-up from perch. Earlier you told the user: “check CI”')?.label, 'auto-m8: follow-up')
  assert.equal(agentSender('perch restarted while you were working, carry on.')?.label, 'auto-m8: resume')
  assert.equal(agentSender('Decision on "CI": perch decided this one without asking the user')?.label, 'auto-m8: decision relay')
})

test('unmarked automation is attributed at send time, independently of its wording', () => {
  const text = stampPrompt('Looks good, ship it.', 'routine')
  assert.deepEqual(agentSender(text), { label: 'auto-m8: routine', body: 'Looks good, ship it.' })
  assert.equal(stampPrompt(text, 'routine'), text)
  assert.equal(agentSender(stampPrompt('Continue.'))?.label, 'auto-m8: automation')
  assert.equal(stampPrompt(relayed, 'helper'), relayed)
})

test('a user quoting recommendations is not mistaken for their agent', () => {
  const quote = "What I recommend but didn't do\n\nChats that hang are the biggest problem.\n\nWork on this"
  assert.equal(stampPrompt(quote, 'you'), quote)
  assert.equal(agentSender(quote), null)
  assert.equal(stampPrompt(quote, 'search'), quote)
  // Even a pasted sender marker must not claim that the user is another agent.
  for (const copied of [relayed, QUEUED + relayed, '⏰ Follow-up from perch. Check CI.']) {
    const sent = stampPrompt(copied, 'you')
    assert.equal(agentSender(sent), null)
    assert.equal(userBody(sent), copied)
  }
})

test('quoting or discussing the queue preamble inside a message does not label it as automated', () => {
  assert.equal(agentSender('Why does it say this?\n' + QUEUED + relayed), null)
})

test('subagent hand-backs show as a subagent report, not as the user', () => {
  const report = 'Another Claude session sent a message:\n<agent-message from="ac145c6a9c2f4da8e">\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output. The report follows:\n  I confirmed the API.\n  \n  ## Pangram\n    - nested\n</agent-message>\n\nThat "other Claude session" is an agent working inside this same session.'
  assert.deepEqual(agentSender(report), { label: 'subagent report', body: 'I confirmed the API.\n\n## Pangram\n  - nested' })
  const saved = toItems(JSON.stringify({ type: 'user', uuid: 'u2', message: { role: 'user', content: report } }))[0]
  assert.equal(saved.kind === 'user' && agentSender(saved.text)?.label, 'subagent report')
  assert.equal(agentSender(report.replace('Another Claude session sent a message:\n', ''))?.label, 'subagent report')
})
