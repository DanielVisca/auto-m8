// Short, at-a-glance chat names. Claude Code names interactive sessions itself (ai-title), but
// chats perch runs with -p get none, so the list fell back to the first prompt: pulled-in
// context blocks, links, half a sentence. This names each one once, by the mission it was
// started for, and keeps that name while side tasks come and go. A rename by you always wins.
import { existsSync, openSync, readSync, closeSync } from 'node:fs'
import { ephemeral } from './chat.ts'
import { settings } from './settings.ts'
import { all, run, tx } from './db.ts'
import { readableTitle, userText } from './transcript.ts'

const BATCH = 15
const PER_SWEEP = 45
let running = false

// The first few things the user actually asked, cleaned of perch's machinery.
export function firstAsks(path: string, n = 3, bytes = 400_000): string[] {
  if (!existsSync(path)) return []
  const fd = openSync(path, 'r')
  const buf = Buffer.alloc(bytes)
  const len = readSync(fd, buf, 0, bytes, 0)
  closeSync(fd)
  const out: string[] = []
  for (const line of buf.subarray(0, len).toString('utf8').split('\n')) {
    if (out.length >= n) break
    let e: any
    try { e = JSON.parse(line) } catch { continue }
    if (e.type !== 'user' || e.isMeta) continue
    const t = userText(e.message?.content)
    if (t && !t.startsWith('/')) out.push(readableTitle(t).slice(0, 700))
  }
  return out.filter(Boolean)
}

const PROMPT = `Name each chat so its owner recognises it at a glance in a sidebar. Name the mission they started it for (the overarching goal), not the latest side task.
Rules: 2 to 6 words, max 45 characters. Plain words, sentence case, imperative or noun phrase. No URLs, no quotes, no trailing punctuation, no "Chat about". Keep product and repo names (PostHog, perch, ClickHouse, posthog-js, PR numbers like #1234) when they are the point.
Good: "Get all metrics into PostHog", "Short readable chat titles", "Fix logs ingestion lag", "Review Jimmy's alerts PR #134625".
Reply with ONLY JSON: {"<id>": "title", ...} covering every id.`

function name(batch: { id: string; asks: string[] }[]): Promise<Record<string, string> | null> {
  const prompt = `${PROMPT}\n\n${batch.map(b => `## ${b.id}\n${b.asks.map((a, i) => `${i + 1}. ${a}`).join('\n')}`).join('\n\n')}`
  return new Promise(resolve => {
    let out = ''
    ephemeral(['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--no-session-persistence',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk'], settings.chat.cwd, ev => {
      if (ev.type === 'result') out = String(ev.result ?? '')
      if (ev.type === 'perch_done') { try { resolve(JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))) } catch { resolve(null) } }
    })
  })
}

export const tidy = (t: string) => readableTitle(String(t ?? '')).replace(/^["'“”]+|["'“”.!]+$/g, '').trim().slice(0, 60)

// Untitled local chats from the last month that perch hasn't named yet, newest first.
export function untitled(limit = PER_SWEEP) {
  return all<any>(`select c.id, c.path from conversations c
    left join user_state u on u.id = c.id left join auto_titles a on a.id = c.id
    where c.title is null and u.title is null and a.id is null and c.path is not null
      and c.source <> 'posthog-task' and c.messages > 0 and c.updated_at > ?
    order by c.updated_at desc limit ?`, Date.now() - 30 * 86400_000, limit)
}

export async function sweepTitles() {
  if (running) return
  running = true
  try {
    const todo = untitled().map(r => ({ id: r.id as string, asks: firstAsks(r.path) })).filter(r => r.asks.join(' ').length >= 12) // "x" or "go" can't be named
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH)
      const got = await name(batch)
      if (!got) continue
      tx(() => {
        for (const b of batch) {
          const t = tidy(got[b.id] ?? '')
          if (!t) continue
          run('insert or replace into auto_titles (id, title, created_at) values (?, ?, ?)', b.id, t, Date.now())
          run('update conversations set title = ? where id = ? and title is null', t, b.id)
        }
      })
    }
  } finally { running = false }
  return true
}
