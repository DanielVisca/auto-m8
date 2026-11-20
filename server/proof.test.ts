// proof.ts: reading the production proof scorecard back from a PR comment, against a fake gh.
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const bin = mkdtempSync(join(tmpdir(), 'perch-proof-'))
process.env.PATH = `${bin}:${process.env.PATH}`
const { db, run } = await import('./db.ts')
await import('./shepherdstore.ts')
const { parseProof, proofOf, refreshProof } = await import('./proof.ts')

test('parseProof reads the marker line', () => {
  const body = '### 🧾 Production proof: ✅ Proven\n...\n<sub>🤖</sub>\n<!-- pr-proof state=proven live=pass healthy=n_a used=pass works=pass contained=pass -->'
  assert.deepEqual(parseProof(body), { state: 'proven', live: 'pass', healthy: 'n_a', used: 'pass', works: 'pass', contained: 'pass' })
  assert.equal(parseProof('no marker here'), null)
  assert.equal(parseProof('<!-- pr-proof live=pass -->'), null)
})

test('refreshProof stores the latest scorecard of a merged PostHog/posthog PR', async () => {
  const url = 'https://github.com/PostHog/posthog/pull/134064'
  run(`insert into shepherd_watch (url, enabled, source, created_at, stage, merged_at) values (?, 0, 'auto', ?, 'verified', ?)`, url, Date.now(), Date.now() - 3600_000)
  const pages = [[
    { body: 'deploy-notify-bot', html_url: 'x', updated_at: '2026-11-12T00:00:00Z' },
    { body: 'old <!-- pr-proof state=not_yet live=pass healthy=pending used=pending works=pending contained=pending -->', html_url: 'https://github.com/c/1', updated_at: '2026-11-12T01:00:00Z' },
    { body: 'new <!-- pr-proof state=concerns live=pass healthy=pass used=pass works=concern contained=pending -->', html_url: 'https://github.com/c/2', updated_at: '2026-11-12T02:00:00Z' },
  ]]
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(pages)}\nJSON\n`); chmodSync(join(bin, 'gh'), 0o755)
  await refreshProof()
  const p = proofOf(url)!
  assert.equal(p.state, 'concerns')
  assert.equal(p.works, 'concern')
  assert.equal(p.comment_url, 'https://github.com/c/2')
  // Not due again for 20 minutes.
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n')
  await refreshProof()
  assert.equal(proofOf(url)!.state, 'concerns')
  db.exec('delete from pr_proof')
})
