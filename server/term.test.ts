// Agent-owned terminals: typed in but not run, finished and waiting events, reading and answering prompts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
process.env.SHELL = '/bin/zsh' // prefill uses bracketed paste, which macOS's bash 3.2 (the CI runner's default) doesn't do
// A clean zsh: the developer's own .zshrc (an oh-my-zsh "update?" prompt, a slow theme) would take over the test shell.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.ZDOTDIR = mkdtempSync(join(tmpdir(), 'term-test-zdot-'))
import { closeTerm, createTerm, plainText, readTerm, sendTerm, termEvents, waitTerm } from './term.ts'

test('plainText drops escape codes and applies carriage-return overwrites', () => {
  assert.equal(plainText('\x1b]2;title\x07\x1b[38;5;135mhi\x1b[39m there\r\n50%\r100%\n'), 'hi there\n100%\n')
})

test('an owned terminal: typed in, not run until Enter, then term_done for its owner', { timeout: 30_000 }, async () => {
  const events: [string, string, string][] = []
  const f = (owner: string, id: string, ev: string) => { events.push([owner, id, ev]) }
  termEvents.add(f)
  const t = createTerm({ prefill: 'echo DONE_$((6*7))', owner: 'conv-1' })
  try {
    await new Promise(r => setTimeout(r, 5000))
    assert.ok(!readTerm(t).output.includes('DONE_42'), 'prefill must not run by itself')
    assert.equal(readTerm(t).state, 'at prompt')
    sendTerm(t, '', true) // the user presses Enter
    await waitTerm(t, 10_000)
    await new Promise(r => setTimeout(r, 3500))
    assert.ok(readTerm(t).output.includes('DONE_42'), readTerm(t).output.slice(-500))
    assert.ok(events.some(e => e[0] === 'conv-1' && e[1] === t.id && e[2] === 'term_done'), JSON.stringify(events))
  } finally { closeTerm(t.id); termEvents.delete(f) }
})

test('an agent runs an interactive command, sees it waiting, and answers it', { timeout: 40_000 }, async () => {
  const events: string[] = []
  const f = (_o: string, _id: string, ev: string) => { events.push(ev) }
  termEvents.add(f)
  const t = createTerm({ prefill: `python3 -c 'print("got", input("Code: "))'`, run: true, owner: 'conv-2' })
  try {
    assert.equal(await waitTerm(t, 25_000), 'waiting for input')
    assert.match(readTerm(t).output, /Code:\s*$/)
    await new Promise(r => setTimeout(r, 2000))
    assert.ok(events.includes('term_waiting'))
    const off = readTerm(t).offset
    sendTerm(t, 'ABCD-1234', true)
    assert.equal(await waitTerm(t, 10_000), 'at prompt')
    assert.match(readTerm(t, { since: off }).output, /got ABCD-1234/)
  } finally { closeTerm(t.id); termEvents.delete(f) }
})
