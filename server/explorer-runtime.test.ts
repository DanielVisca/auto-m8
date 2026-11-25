import { test } from 'node:test'
import assert from 'node:assert/strict'
import { originOf } from './explorer-runtime.ts'

const code = [{ image: 'x', sha: 'a'.repeat(40), repo: '/r', behind: 0, ahead: 0, github: null }]
test('an image tagged with a commit in your repos is your code', () => {
  assert.equal(originOf(['123.dkr.ecr.us-east-1.amazonaws.com/posthog-node:' + 'a'.repeat(40)], code, 'PostHog'), 'yours')
})
test('version-tagged public and mirrored images are third-party', () => {
  assert.equal(originOf(['public.ecr.aws/warpstream-labs/warpstream_agent:v843'], [], 'PostHog'), 'third-party')
  assert.equal(originOf(['123.dkr.ecr.us-east-1.amazonaws.com/dhi/kube-state-metrics:2.20-debian13@sha256:96a2'], [], 'PostHog'), 'third-party')
  assert.equal(originOf(['123.dkr.ecr.us-east-1.amazonaws.com/mirror/docker-hub/prometheuscommunity/pgbouncer-exporter:v0.12.0'], [], 'PostHog'), 'third-party')
})
test("your org's registry with a digest only, or a commit we can't find, is org-built", () => {
  assert.equal(originOf(['ghcr.io/posthog/statuspage-metrics-api@sha256:6c16'], [], 'PostHog'), 'org')
  assert.equal(originOf(['123.dkr.ecr.us-east-1.amazonaws.com/capture:' + 'b'.repeat(40)], [], 'PostHog'), 'org')
  assert.equal(originOf([], [], 'PostHog'), 'unknown')
})
