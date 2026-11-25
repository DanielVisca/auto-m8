import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deployState, parseDeployComment } from './deploys.ts'

const body = `<!-- deploy-notify-bot -->
### Deploy status

| Environment | Status | Deployed At | Workflow |
|---|---|---|---|
| **dev** | :white_check_mark: Deployed | 2026-11-25 11:54 UTC | [Run](https://x) |
| **prod-us** | :white_check_mark: Deployed | 2026-11-25 12:29 UTC | [Run](https://x) |
| **prod-eu** | :hourglass: Deploying | | [Run](https://x) |`
const merged = Date.parse('2026-11-25T11:00:00Z')

test('parses the deploy bot table', () => {
  const envs = parseDeployComment(body)
  assert.deepEqual(envs.map(e => [e.env, e.status]), [['dev', 'deployed'], ['prod-us', 'deployed'], ['prod-eu', 'deploying']])
  assert.equal(envs[1].at, Date.parse('2026-11-25T12:29:00Z'))
})

test('one prod env live is still deploying; all live is deployed', () => {
  const envs = parseDeployComment(body)
  const d = deployState(merged, envs, null, merged + 3600_000)
  assert.equal(d.state, 'deploying')
  assert.equal(d.liveAt, Date.parse('2026-11-25T12:29:00Z'))
  assert.equal(deployState(merged, parseDeployComment(body.replace(':hourglass: Deploying | ', ':white_check_mark: Deployed | 2026-11-25 12:40 UTC')), null).state, 'deployed')
})

test('no prod env after a day is stuck; no signal is unknown, never deployed', () => {
  const devOnly = parseDeployComment(body).filter(e => e.env === 'dev')
  assert.equal(deployState(merged, devOnly, null, merged + 2 * 86400_000).state, 'stuck')
  assert.equal(deployState(merged, [], null, merged + 2 * 3600_000).state, 'unknown')
  assert.equal(deployState(merged, [], 'verified', merged + 2 * 3600_000).state, 'deployed')
  assert.equal(deployState(merged, [], 'deploying', merged + 2 * 86400_000).state, 'stuck')
})
