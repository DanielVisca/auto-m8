import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check, needsFrom, type Profile } from './runtimes.ts'

const local: Profile['can'] = { localFiles: true, tailscale: true, browserProfile: true, perchTools: true }
const profs: Profile[] = [
  { id: 'claude-local', label: 'Claude', where: 'mac', ready: true, can: local, github: { accounts: ['me'], owners: 'any-local-account' }, mcp: { grafana: 'connected', slack: 'needs authentication' }, strengths: [], limits: [] },
  { id: 'cloud-task', label: 'Cloud', where: 'cloud', ready: true, can: { localFiles: false, tailscale: false, browserProfile: false, perchTools: false }, github: { accounts: [], owners: ['PostHog'] }, mcp: {}, strengths: [], limits: [] },
]
const verdict = (v: ReturnType<typeof check>, id: string) => v.find(x => x.id === id)!

test('a personal repo cannot go to the cloud, but can stay local', () => {
  const v = check(profs, needsFrom('fix the readme', { repoOwner: 'octocat' }))
  assert.equal(verdict(v, 'cloud-task').ok, false)
  assert.match(verdict(v, 'cloud-task').blockers[0], /cannot push to octocat/)
  assert.equal(verdict(v, 'claude-local').ok, true)
})
test('PostHog repo with nothing local is fine in the cloud', () => {
  assert.equal(verdict(check(profs, needsFrom('add a test', { repoOwner: 'posthog' })), 'cloud-task').ok, true)
})
test('tailnet, browser and dirty work keep a job on the Mac', () => {
  const n = needsFrom('check Grafana for the vmagent queue, using the signed-in browser', { repoOwner: 'PostHog', dirty: true })
  assert.deepEqual([n.tailscale, n.browserProfile, n.localFiles], [true, true, true])
  assert.equal(verdict(check(profs, n), 'cloud-task').blockers.length, 3)
})
test('an MCP server that needs auth blocks that agent', () => {
  const n = needsFrom('summarise the slack thread', {}, ['slack', 'grafana'])
  assert.deepEqual(n.mcp, ['slack'])
  assert.match(verdict(check(profs, n), 'claude-local').blockers[0], /slack MCP is needs authentication/)
})
test('a runtime that is not ready says why', () => {
  const v = check([{ ...profs[0], ready: false, why: 'capped' }], {})
  assert.deepEqual(v[0].blockers, ['capped'])
})
