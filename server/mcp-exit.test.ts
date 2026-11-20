import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { exitWithParent } from './mcp.ts'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

test('the perch MCP server exits when its agent closes stdin', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough(); let code: number | null = null
  exitWithParent({ stdin, stdout, parent: 10, parentNow: () => 10, pending: () => 0, exit: c => { code = c } })
  stdin.end(); stdin.resume()
  await wait(50)
  assert.equal(code, 0)
})
test('it waits for a running call before exiting', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough(); let code: number | null = null, pending = 1
  exitWithParent({ stdin, stdout, parent: 10, parentNow: () => 10, pending: () => pending, exit: c => { code = c } })
  stdin.end(); stdin.resume()
  await wait(50); assert.equal(code, null)
  pending = 0; await wait(400); assert.equal(code, 0)
})
test('it exits when the parent agent dies even if stdin stays open', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough(); let code: number | null = null, parent = 10
  exitWithParent({ stdin, stdout, parent: 10, parentNow: () => parent, pending: () => 0, exit: c => { code = c }, every: 20 })
  parent = 1; await wait(80)
  assert.equal(code, 0)
})
