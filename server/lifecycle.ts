// Chat lifecycle: active → stale → harvested → closed.
// A conversation that has gone quiet (staleDays, or its PRs all merged/closed) gets one closing pass
// by an agent: it reads the conversation and the memory index and decides
// - how it ended: complete, abandoned, or unfinished (real work left that nothing will pick up),
// - what is worth keeping beyond this chat: facts about the user, their preferences and corrections,
//   project state, pointers to systems, written to Claude's memory (the same files every agent
//   loads), each with a pointer back to the conversation,
// - a one-line summary, kept as the conversation's note.
// Complete or abandoned chats are then closed (archived; a new message reopens them). Unfinished
// ones are not closed: they go to Needs me with the loose end, so nothing is dropped silently.
// Your own state always wins: a chat you pinned or set a state on by hand is never touched.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ephemeral } from './chat.ts'
import { all, get, run } from './db.ts'
import { autonomyOn, settings } from './settings.ts'
import { toItems, itemsOf } from './transcript.ts'

run(`create table if not exists attention (id text primary key, verdict integer not null, reason text, judged_at integer not null, judged_updated_at integer not null)`)
run(`create table if not exists lifecycle (
  id text primary key, outcome text, summary text, loose_ends text, memories text, memory_dir text,
  harvested_at integer not null, harvested_updated_at integer not null, closed integer not null default 0)`)

const DAY = 86400_000
const STALE_DAYS = 2
const BACKLOG_DAYS = 21 // older chats were archived long ago; harvesting all of history isn't worth it
const PER_SWEEP = 3 // pacing, not a cap: the sweep runs every few minutes
const MAX_TRANSCRIPT = 24_000

export const lifecycleStatus: { running: boolean; lastRun?: number; harvested: number; closed: number; memories: number } = { running: false, harvested: 0, closed: 0, memories: 0 }
export const harvestOf = (id: string) => get<any>('select * from lifecycle where id = ?', id)

// Claude keeps memory per project directory; agents load the one for the directory they start in.
// Use the conversation's own project memory when it exists, else the default chat directory's.
const slug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')
export function memoryDirFor(cwd: string | null | undefined) {
  const root = join(homedir(), '.claude', 'projects')
  const own = cwd ? join(root, slug(cwd), 'memory') : null
  return own && existsSync(own) ? own : join(root, slug(settings.chat.cwd), 'memory')
}

type Candidate = { id: string; path: string; cwd: string | null; title: string; updated_at: number }

export function candidates(now = Date.now()): Candidate[] {
  return all<any>(`select c.id, c.path, c.cwd, coalesce(u.title, c.title, c.first_prompt, '') title, c.updated_at, c.source, c.origin,
        u.state, u.state_auto, u.pinned, l.harvested_updated_at
      from conversations c left join user_state u on u.id = c.id left join lifecycle l on l.id = c.id
      where c.path is not null and c.source in ('claude', 'posthog-code') and c.updated_at between ? and ?
        and coalesce(u.pinned, 0) = 0 and not (u.state is not null and u.state_auto = 0)
        and coalesce(u.state, '') not in ('hidden', 'later')
        and (l.id is null or l.harvested_updated_at < c.updated_at)
        and c.id not in (select conversation_id from labels where label in ('helper', 'shepherd', 'search', 'autoresearch', 'routine'))
      order by c.updated_at desc`, now - BACKLOG_DAYS * DAY, now - STALE_DAYS * DAY)
}

const PROMPT = (c: Candidate, transcript: string, index: string) => `You close out one of the user's finished AI agent conversations. It has been quiet for days. Read it and return JSON only.

1. outcome: "complete" (done, or nothing is pending), "abandoned" (the user moved on; nothing important is lost), or "unfinished" (real work is left that matters and nothing will pick it up, e.g. a PR never opened, a fix promised and not made, a question to the user never answered).
2. summary: one plain sentence, what this conversation did or decided (under 140 characters).
3. loose_ends: for "unfinished" only, one sentence on exactly what is left.
4. memories: facts worth keeping for FUTURE conversations, in the memory format below. Be strict: most conversations yield nothing; return [] then. Keep only what a future agent can't get from the code, git history, PRs or CLAUDE.md, and what will still be true in weeks:
   - user: who the user is, their role, expertise, how they like to work.
   - feedback: a correction or a confirmed approach the user gave ("don't do X", "always Y"), with **Why:** and **How to apply:** lines.
   - project: an ongoing goal, constraint or decision not recorded elsewhere; absolute dates, never "yesterday". **Why:** and **How to apply:** lines.
   - reference: where something lives (a dashboard, notebook id, channel, URL).
   Never store secrets, tokens, or one-off task details. Don't repeat what an existing memory below already says; to add to one, use updates instead.
5. updates: additions to existing memories (by their file name from the index), when this conversation adds or corrects something there.

Existing memory index (MEMORY.md):
${index || '(empty)'}

Return exactly:
{"outcome":"complete|abandoned|unfinished","summary":"...","loose_ends":"","memories":[{"name":"short-kebab-slug","description":"one line used to decide relevance","type":"user|feedback|project|reference","title":"Short title","hook":"few words for the index","body":"the fact, with Why/How to apply for feedback and project"}],"updates":[{"file":"existing-file.md","add":"the sentence(s) to add"}]}

Conversation "${c.title.slice(0, 120)}" (last active ${new Date(c.updated_at).toISOString().slice(0, 10)}):
${transcript}`

function condensedTranscript(path: string) {
  const items = itemsOf(path)
  const lines: string[] = []
  let users = 0
  for (const i of items) {
    if (i.kind === 'user') { users++; lines.push(`USER: ${i.text.slice(0, 2000)}`) }
    else for (const b of i.blocks) if (b.type === 'text' && b.text.trim()) lines.push(`AGENT: ${b.text.slice(0, 1500)}`)
  }
  const text = lines.join('\n')
  return { users, text: text.length > MAX_TRANSCRIPT ? `${text.slice(0, MAX_TRANSCRIPT / 3)}\n[… middle clipped …]\n${text.slice(-(2 * MAX_TRANSCRIPT) / 3)}` : text }
}

function ask(prompt: string): Promise<any | null> {
  return new Promise(resolve => {
    let out = ''
    ephemeral(['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', settings.ai.model, '--no-session-persistence',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk'], settings.chat.cwd, ev => {
      if (ev.type === 'result') out = String(ev.result ?? '')
      if (ev.type === 'perch_done') { try { resolve(JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))) } catch { resolve(null) } }
    })
  })
}

export type Harvest = { outcome: 'complete' | 'abandoned' | 'unfinished'; summary: string; loose_ends?: string; memories: any[]; updates: any[] }

// Writes the memories in Claude's memory format, each pointing back at the conversation.
export function writeMemories(dir: string, c: Pick<Candidate, 'id' | 'title' | 'updated_at'>, h: Harvest) {
  const written: string[] = []
  const source = `Source: perch://${c.id} ("${c.title.replace(/\s+/g, ' ').slice(0, 80)}", ${new Date(c.updated_at).toISOString().slice(0, 10)})`
  if (!h.memories?.length && !h.updates?.length) return written
  mkdirSync(dir, { recursive: true })
  const indexPath = join(dir, 'MEMORY.md')
  const index = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : ''
  for (const m of h.memories ?? []) {
    const name = String(m.name ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
    if (!name || !m.body || !['user', 'feedback', 'project', 'reference'].includes(m.type)) continue
    const file = `${name}.md`
    if (existsSync(join(dir, file))) { appendFileSync(join(dir, file), `\n\n${String(m.body).trim()}\n${source}\n`); written.push(file); continue }
    writeFileSync(join(dir, file), `---\nname: ${name}\ndescription: ${String(m.description ?? m.title ?? name).replace(/\n/g, ' ')}\nmetadata:\n  type: ${m.type}\n---\n\n${String(m.body).trim()}\n\n${source}\n`)
    if (!index.includes(`(${file})`)) appendFileSync(indexPath, `${index && !index.endsWith('\n') ? '\n' : ''}- [${String(m.title ?? name).replace(/[\[\]\n]/g, '')}](${file}) — ${String(m.hook ?? m.description ?? '').replace(/\n/g, ' ').slice(0, 120)}\n`)
    written.push(file)
  }
  for (const u of h.updates ?? []) {
    const file = String(u.file ?? '').replace(/[^\w.-]/g, '')
    if (!file.endsWith('.md') || file === 'MEMORY.md' || !existsSync(join(dir, file)) || !u.add) continue
    appendFileSync(join(dir, file), `\n\n${String(u.add).trim()}\n${source}\n`)
    written.push(file)
  }
  return written
}

export async function harvest(c: Candidate, opts: { dryRun?: boolean } = {}): Promise<(Harvest & { written: string[]; dir: string }) | null> {
  const t = condensedTranscript(c.path)
  const dir = memoryDirFor(c.cwd)
  // Too little to learn from: a one-shot question. Close it without asking a model.
  if (t.users < 2 && t.text.length < 3000) {
    const h: Harvest = { outcome: 'complete', summary: '', memories: [], updates: [] }
    if (!opts.dryRun) record(c, h, [], dir)
    return { ...h, written: [], dir }
  }
  const index = existsSync(join(dir, 'MEMORY.md')) ? readFileSync(join(dir, 'MEMORY.md'), 'utf8') : ''
  const h: Harvest | null = await ask(PROMPT(c, t.text, index))
  if (!h || !['complete', 'abandoned', 'unfinished'].includes(h.outcome)) return null
  if (opts.dryRun) return { ...h, written: [], dir }
  const written = writeMemories(dir, c, h)
  record(c, h, written, dir)
  return { ...h, written, dir }
}

function record(c: Candidate, h: Harvest, written: string[], dir: string) {
  const close = h.outcome !== 'unfinished'
  run(`insert into lifecycle (id, outcome, summary, loose_ends, memories, memory_dir, harvested_at, harvested_updated_at, closed) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set outcome = excluded.outcome, summary = excluded.summary, loose_ends = excluded.loose_ends, memories = excluded.memories,
         memory_dir = excluded.memory_dir, harvested_at = excluded.harvested_at, harvested_updated_at = excluded.harvested_updated_at, closed = excluded.closed`,
    c.id, h.outcome, h.summary ?? '', h.loose_ends ?? null, JSON.stringify(written), dir, Date.now(), c.updated_at, close ? 1 : 0)
  const note = [h.summary, written.length ? `Saved to memory: ${written.join(', ')}` : '', h.outcome === 'unfinished' ? `Loose end: ${h.loose_ends}` : ''].filter(Boolean).join('\n')
  run('insert into user_state (id) values (?) on conflict do nothing', c.id)
  // Don't overwrite a note the user wrote.
  if (note) run(`update user_state set note = ? where id = ? and (note is null or note = '' or note like 'Closed by perch%' or note like 'Went stale%')`, `${close ? 'Closed by perch' : 'Went stale unfinished'}: ${note}`, c.id)
  if (close) run(`update user_state set state = 'archived', state_auto = 2, state_at = ? where id = ? and (state_auto != 0 or state is null)`, Date.now(), c.id)
  // An unfinished loose end is NOT a "Needs me" flag on its own: forcing one here skipped the judge's rules and
  // filled the list with "uncommitted", "needs restart" and "PR awaits CI" (14 of 22 stale flags on 2026-11-12).
  // The note keeps the loose end visible; the attention judge decides if a human is actually needed.
  lifecycleStatus.harvested++
  if (close) lifecycleStatus.closed++
  lifecycleStatus.memories += written.length
}

export async function sweepLifecycle() {
  if (lifecycleStatus.running || settings.lifecycle?.enabled === false || !autonomyOn()) return
  lifecycleStatus.running = true
  try {
    for (const c of candidates().slice(0, PER_SWEEP)) {
      try { await harvest(c) } catch (e) { console.error('lifecycle', c.id, e) }
    }
  } finally { lifecycleStatus.running = false; lifecycleStatus.lastRun = Date.now() }
}
