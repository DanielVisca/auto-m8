import './promises.ts' // creates perch_started
import './account.ts' // creates chat_account_span
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run } from './db.ts'
import { noteChatAccount } from './account.ts'
import { spendSummary } from './spend.ts'

test('spend splits a chat by the billing in force when each message ran', async () => {
  const now = Date.now()
  // One perch chat starts on the Claude Code login, moves to an API key 10 minutes later.
  noteChatAccount('chat-split', 'login', now - 3_600_000)
  noteChatAccount('chat-split', 'api', now - 600_000)
  noteChatAccount('chat-split', 'api', now - 300_000) // same billing again: no new span
  noteChatAccount('chat-api', 'api', now - 3_600_000) // a chat that ran on the API key from the start
  const ins = (id: string, ts: number, account: string, session: string, cost: number) =>
    run('insert or replace into usage_msgs (id, ts, account, source, session, cwd, model, in_tok, out_tok, cache_read, cache_write, cost, sidechain) values (?, ?, ?, ?, ?, ?, ?, 1, 1, 0, 0, ?, 0)',
      id, ts, account, 'perch', session, '/tmp', 'claude-sonnet-5-5', cost)
  ins('t-1', now - 1_800_000, 'work', 'chat-split', 1) // before the move: login
  ins('t-2', now - 60_000, 'work', 'chat-split', 2)   // after the move: API key
  ins('t-3', now - 120_000, 'work', 'terminal-only', 4) // a terminal session: login
  ins('t-4', now - 120_000, 'work', 'chat-api', 8) // a chat on the API key

  const all = await spendSummary(1)
  const by = Object.fromEntries(all.subscriptions.map((x: any) => [x.id, x.cost]))
  assert.equal(by.login, 5) // t-1 + t-3
  assert.equal(by.api, 10)  // t-2 + t-4
  assert.equal(all.subscription, null)

  const api = await spendSummary(1, 'api')
  assert.equal(api.subscription, 'api')
  assert.equal(api.cost, 10)
  assert.equal(api.subscriptions.length, all.subscriptions.length, 'breakdown ignores the filter')
})
