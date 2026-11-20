import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { all, get, run } from './db.ts'
import { drainCloud, localGate, readReplayUsage, syncTrialQuota, verdict } from './shadow.ts'
import { noteClaude, usageNow } from './usage.ts'

test('shadow usage reports update capacity without a foreground chat and tolerate partial writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perch-shadow-usage-')), out = join(dir, 'replay.jsonl')
  const event = JSON.stringify({ type: 'rate_limit_event', timestamp: new Date().toISOString(), rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: (Date.now() + 60_000) / 1000 } } } })
  writeFileSync(out, event.slice(0, 70))
  readReplayUsage('stream', out)
  appendFileSync(out, event.slice(70) + '\n')
  readReplayUsage('stream', out)
  assert.equal(usageNow().claude?.windows[0].pct, 0.9)
  // Put a newer, low foreground observation in place; reading the old bytes again
  // must not overwrite it and spuriously pause background work.
  noteClaude({ rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: (Date.now() + 60_000) / 1000 } } } })
  readReplayUsage('stream', out)
  assert.equal(usageNow().claude?.windows[0].pct, 0.2)
})

test('a running replay suspends its process group, survives reattachment and resumes without counting wait time', async () => {
  const p = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' })
  const pid = p.pid!
  const now = Date.now()
  const snapshot = (pct: number) => ({ claude: { at: now, windows: [{ key: 'five_hour', label: '5h', pct, resetsAt: now + 1000 }] }, codex: null })
  run("insert into shadow_runs (id, pr_url) values ('suspend', 'https://github.com/a/b/pull/1')")
  run("insert into shadow_trials (id, run_id, pr_url, model, status, pid, started_at) values ('suspend', 'suspend', 'url', 'claude-sonnet-5-5', 'running', ?, ?)", pid, now)
  try {
    assert.equal(syncTrialQuota('suspend', snapshot(0.85), now), true)
    assert.equal(get<any>("select status from shadow_trials where id = 'suspend'")?.status, 'paused')
    assert.match(execFileSync('ps', ['-p', String(pid), '-o', 'state='], { encoding: 'utf8' }), /T/)
    assert.equal(syncTrialQuota('suspend', snapshot(0.9), now + 500), true, 'reattachment keeps it paused')
    assert.equal(get<any>("select paused_at from shadow_trials where id = 'suspend'")?.paused_at, now)
    assert.equal(syncTrialQuota('suspend', snapshot(0.9), now + 1000), false, 'reset releases it even with an old high reading')
    const t = get<any>("select * from shadow_trials where id = 'suspend'")
    assert.equal(t.status, 'running')
    assert.equal(t.paused_ms, 1000)
    assert.equal(t.paused_at, null)
    assert.equal(t.error, null)
    assert.equal(syncTrialQuota('suspend', snapshot(0.2), now + 1100), false)
    assert.equal(get<any>("select paused_ms from shadow_trials where id = 'suspend'")?.paused_ms, 1000, 'repeated resume never double counts')
  } finally {
    process.kill(-pid, 'SIGCONT'); process.kill(-pid, 'SIGTERM')
    await new Promise(resolve => p.once('exit', resolve))
    run("delete from shadow_trials where id = 'suspend'"); run("delete from shadow_runs where id = 'suspend'")
  }
})

test('queued replays and judges wait durably, reset launches each once and preserves measured results', { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'perch-shadow-quota-')), top = join(root, 'repo'), dir = join(root, 'trial'), marker = join(root, 'calls')
  execFileSync('git', ['init', '-q', top])
  writeFileSync(join(top, 'answer.txt'), 'before')
  execFileSync('git', ['-C', top, 'add', '.'])
  execFileSync('git', ['-C', top, '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--no-verify', '-qm', 'base'])
  const base = execFileSync('git', ['-C', top, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  writeFileSync(join(root, 'claude'), `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},'call\\n');const judge=process.argv[process.argv.indexOf('-p')+1].startsWith('You compare');if(!judge)fs.writeFileSync('answer.txt','after');console.log(JSON.stringify({result:judge?JSON.stringify({outcome:'same',score:95}):'done',total_cost_usd:0.2,duration_ms:1000}));`, { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = root + ':' + path
  const now = Date.now()
  const note = (reset: number, at: number) => noteClaude({ rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: reset / 1000 } } } }, at)
  run("insert into shadow_runs (id, pr_url, top, base, plain, task, original_diff) values ('queue', 'url', ?, ?, 'Replay task', 'task', '+after')", top, base)
  run("insert into shadow_trials (id, run_id, pr_url, model, status, worktree, mode) values ('queue', 'queue', 'url', 'claude-sonnet-5-5', 'queued', ?, 'brief')", dir)
  run("insert into shadow_trials (id, run_id, pr_url, model, status, diff, usd, duration_ms) values ('judge', 'queue', 'url', 'qwen3-coder:30b', 'judging', '+after', 0, 2000)")
  try {
    note(now + 60_000, now + 1)
    drainCloud(); drainCloud()
    assert.equal(existsSync(marker), false, 'no model call while paused, including the judge')
    assert.equal(get<any>("select status from shadow_trials where id = 'queue'")?.status, 'queued')
    assert.equal(get<any>("select status from shadow_trials where id = 'judge'")?.status, 'judging')
    assert.equal(localGate(), null, 'cloud queue must not get mistaken for local work')
    assert.match(verdict(null, all<any>('select * from shadow_trials'), 'running').text, /capacity/)
    note(now - 1000, now + 2)
    drainCloud(); drainCloud()
    while (get<any>("select status from shadow_runs where id = 'queue'")?.status === 'running') await new Promise(r => setTimeout(r, 50))
    assert.equal(get<any>("select status from shadow_trials where id = 'queue'")?.status, 'done')
    const j = get<any>("select * from shadow_trials where id = 'judge'")
    assert.equal(j.status, 'done'); assert.equal(j.usd, 0); assert.equal(j.duration_ms, 2000)
    const { readFileSync } = await import('node:fs')
    assert.equal(readFileSync(marker, 'utf8').trim().split('\n').length, 3, 'one replay, two judges; repeated drains must not duplicate calls')
  } finally {
    process.env.PATH = path
    run("delete from shadow_trials where run_id = 'queue'"); run("delete from shadow_runs where id = 'queue'")
  }
})
