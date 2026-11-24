// A lightweight detector for human chats that slipped through explicit signals. Its candidates
// transfer to the durable Needs me ledger for a capable agent to verify, act on and track.
import { readFileSync } from 'node:fs'
import { ephemeral } from './chat.ts'
import { all, get, run } from './db.ts'
import { settings } from './settings.ts'
import { needByKey, reportNeed } from './needsstore.ts'
import { toItems, itemsOf, type Item } from './transcript.ts'

run(`create table if not exists attention (
  id text primary key, verdict integer not null, reason text, judged_at integer not null, judged_updated_at integer not null)`)

const QUIET = 8 * 60_000 // a conversation still being written to isn't "slipped through"
const BATCH = 4
const PER_SWEEP = 12

export const attentionStatus: { running: boolean; lastRun?: number; judged: number; flagged: number } = { running: false, judged: 0, flagged: 0 }

// The last few turns, short enough to judge from: what you said, what the agent said, which tools ran.
export function tail(items: Item[], max = 1800) {
  const lines: string[] = []
  for (const i of items.slice(-8)) {
    if (i.kind === 'user') lines.push(`USER: ${i.text.replace(/\s+/g, ' ').slice(0, 400)}`)
    else {
      const text = i.blocks.filter(b => b.type === 'text').map((b: any) => b.text).join(' ').replace(/\s+/g, ' ')
      const tools = i.blocks.filter(b => b.type === 'tool').map((b: any) => `${b.name}${b.isError ? '(error)' : ''}`)
      lines.push(`AGENT: ${text.slice(0, 700)}${tools.length ? ` [tools: ${tools.slice(-4).join(', ')}]` : ''}`)
    }
  }
  const s = lines.join('\n')
  return s.length > max ? '…' + s.slice(-max) : s
}

const PROMPT = `You triage a busy engineer's AI agent conversations. Each one below ended quietly and nothing has flagged it. Decide for each whether the engineer should look at it now.

The engineer runs dozens of agents and wants agents to decide and finish things themselves. Flag ONLY what no agent can do for them:
- a direct question or choice the agent put to the engineer that is a real judgement call (direction, scope, taste, something outward-facing or irreversible) and still unanswered;
- a blocker only a human can physically clear: unlock a password manager or signing key, sign in / OAuth, a permission prompt, approve a settings change;
- the engineer's own last message is unanswered or was clearly misunderstood.
Do NOT flag (an agent or auto-m8's PR shepherd handles these, or nothing is actually waiting): "restart/reload the app to see it", "untested / unverified / try it yourself", "uncommitted or unpushed changes", a PR waiting for review, CI, approval or merge, a report or research answer that was delivered, a draft (Slack or otherwise) that was written, "I can do X if you want" offers, a follow-up that didn't fire, a cut-off summary, or anything superseded by later work. When unsure, do not flag.
The reason is one plain sentence (under 90 characters) naming the human action, starting with a verb (e.g. "Unlock 1Password so commits can be signed"), no hedging.

Reply with ONLY JSON: {"<id>": {"needs": true|false, "reason": "..."}, ...} covering every id.`

function judge(batch: { id: string; head: string; text: string }[]): Promise<Record<string, { needs: boolean; reason?: string }> | null> {
  const prompt = `${PROMPT}\n\n${batch.map(b => `## ${b.id}\n${b.head}\n${b.text}`).join('\n\n')}`
  return new Promise(resolve => {
    let out = ''
    ephemeral(['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', settings.ai.model, '--no-session-persistence',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk'], settings.chat.cwd, ev => {
      if (ev.type === 'result') out = String(ev.result ?? '')
      if (ev.type === 'perch_done') { try { resolve(JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))) } catch { resolve(null) } }
    })
  })
}

type Candidate = { id: string; title?: string | null; first_prompt?: string | null; source: string; path?: string | null; updated_at: number; effective: string; automated?: boolean; cwd?: string | null; prs?: any[] }

// `rows` are the conversations perch is showing (hydrated, with their effective state): the sweep only
// looks at ones that are quiet, recent, theirs, and not already flagged, done, snoozed or running.
export async function sweep(rows: Candidate[]) {
  if (attentionStatus.running || settings.ai.attention === false) return
  const now = Date.now()
  revalidate(now)
  const judged = new Map(all<any>('select id, judged_updated_at, judged_at from attention').map(r => [r.id, r]))
  const todo = rows
    .filter(r => r.path && r.source !== 'posthog-task' && !r.automated && ['active', 'idle'].includes(r.effective)
      && r.updated_at < now - QUIET && r.updated_at > now - 3 * 86400_000
      && !(judged.get(r.id)?.judged_updated_at === r.updated_at))
    .sort((a, b) => b.updated_at - a.updated_at).slice(0, PER_SWEEP)
  if (!todo.length) return
  attentionStatus.running = true
  try {
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH).map(r => {
        let text = ''
        try { text = tail(itemsOf(r.path!)) } catch {}
        const open = (r.prs ?? []).filter((p: any) => p.state === 'OPEN').length
        return { r, id: r.id, text, head: `Title: ${(r.title ?? r.first_prompt ?? '').slice(0, 120)} | last active ${Math.round((now - r.updated_at) / 60_000)} min ago${open ? ` | ${open} open PR(s) it created` : ''}` }
      }).filter(b => b.text)
      if (!batch.length) continue
      const verdicts = await judge(batch)
      if (!verdicts) continue // an unreadable reply is retried on the next sweep, not recorded
      for (const b of batch) {
        const v = verdicts[b.id]
        if (!v) continue
        run(`insert into attention (id, verdict, reason, judged_at, judged_updated_at) values (?, ?, ?, ?, ?)
             on conflict(id) do update set verdict = excluded.verdict, reason = excluded.reason, judged_at = excluded.judged_at, judged_updated_at = excluded.judged_updated_at`,
          b.id, v.needs ? 1 : 0, v.needs ? String(v.reason ?? 'worth a look').slice(0, 140) : null, Date.now(), b.r.updated_at)
        attentionStatus.judged++
        if (v.needs) attentionStatus.flagged++
      }
    }
    revalidate()
  } finally { attentionStatus.running = false; attentionStatus.lastRun = Date.now() }
}

// Transfer legacy flags into the durable ledger before retiring the ephemeral flag.
// Neither age nor a bare PR number proves that the human action was completed.
export function revalidate(now = Date.now()) {
  let captured = 0
  for (const f of all<any>('select id, reason from attention where verdict = 1')) {
    const c = get<any>('select title, url from conversations where id = ?', f.id)
    if (!needByKey(`chat:${f.id}`)) reportNeed({ key: `chat:${f.id}`, source: 'attention', title: f.reason ?? c?.title ?? 'Needs a check', context: f.reason ?? '', conversation_id: f.id, url: c?.url }, now)
    run('update attention set verdict = 0 where id = ?', f.id)
    captured++
  }
  return captured
}

// Wrong call? One click says so and the conversation is not re-flagged until it moves again.
export const dismiss = (id: string) => run('update attention set verdict = 0 where id = ?', id)
export const reasonFor = (id: string) => get<any>('select reason, judged_at from attention where id = ? and verdict = 1', id)
