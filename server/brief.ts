// The home page: what needs you, your open PR stacks, what's slipping, today's note, and a
// short brief Claude writes from all of that once a day ("welcome back, pick up x, y or z").
import { openDecisions } from './decisionstore.ts'
import { needsList } from './needsstore.ts'
import { projects } from './projects.ts'
import { existsSync, readFileSync } from 'node:fs'
import { ephemeral, PERCH_MCP } from './chat.ts'
import { editLabels, focusIds, focusWords, list, type Row } from './conversations.ts'
import { all, get, run } from './db.ts'
import { settings } from './settings.ts'
import { recordError, resolveErrors } from './errors.ts'
import { toItems, itemsOf } from './transcript.ts'
import { snoozed } from './pr.ts'
import { mcpTool } from '../shared/brand.ts'

const DAY = 86400_000
export const today = () => new Date().toLocaleDateString('sv') // YYYY-MM-DD, local time

// Open PRs you authored, grouped into stacks: a PR whose base branch is another open PR's head
// sits on top of it. Each PR carries the conversations that touched it.
export function prStacks() {
  const prs = all<Row>(`select p.*, (select json_group_array(cp.conversation_id) from conversation_prs cp where cp.url = p.url) convs
                        from prs p where p.authored = 1 and p.state = 'OPEN' order by p.updated_at desc`)
  for (const p of prs) p.convs = JSON.parse(p.convs ?? '[]')
  const byHead = new Map(prs.filter(p => p.head).map(p => [`${p.repo}:${p.head}`, p]))
  const parent = (p: Row) => (p.base ? byHead.get(`${p.repo}:${p.base}`) : undefined)
  const roots = prs.filter(p => !parent(p))
  const stacks = roots.map(root => {
    const chain = [root]
    for (let i = 0; i < chain.length; i++) for (const p of prs) if (parent(p) === chain[i]) chain.push(p)
    return { repo: root.repo, prs: chain, updated_at: Math.max(...chain.map(p => p.updated_at ?? 0)) }
  })
  return stacks.sort((a, b) => b.prs.length - a.prs.length || b.updated_at - a.updated_at)
}

export function home() {
  const day = today()
  const now = list({ states: ['running', 'waiting', 'active'], limit: 60 }).conversations
  const returned = now.filter(c => c.returned)
  // In focus, only stacks that a focused conversation touched or whose titles match the areas.
  const ids = focusIds()
  const words = ids ? focusWords() : []
  const sz = snoozed()
  const allStacks = prStacks().filter(s => !ids || s.prs.some(p => p.convs.some((c: string) => ids.has(c)) || words.some(w => `${p.title} ${p.head} ${p.repo}`.toLowerCase().includes(w))))
  // Snoozed PRs ("not today") leave the stacks until their time comes.
  const stacks = allStacks.filter(s => !s.prs.every(p => sz.has(p.url)))
  // Slipping: open PRs untouched for 5+ days, and active work that went quiet without a PR.
  const stale = stacks.flatMap(s => s.prs).filter(p => Date.now() - (p.updated_at ?? 0) > 5 * DAY)
  return {
    day,
    note: get<Row>('select body, updated_at from notes where day = ?', day) ?? { body: '' },
    recentNotes: all<Row>('select day, body from notes where day < ? and body != \'\' order by day desc limit 5', day),
    running: now.filter(c => c.effective === 'running'),
    needsMe: now.filter(c => c.effective === 'waiting'),
    // Home shows only the count; the Needs me card loads the list itself (/api/needs). Sending every
    // item with its context and history made each Home answer several hundred KB heavier.
    interventions: { counts: needsList().counts },
    decisions: openDecisions(),
    projects: projects(),
    active: now.filter(c => c.effective === 'active').slice(0, 12),
    returned,
    stacks,
    stale,
    later: list({ states: ['later'], limit: 50 }).conversations.length,
    brief: hideSnoozed(focusBrief(briefFor(day), ids, words), sz),
    snoozedPrs: allStacks.length - stacks.length,
    briefing,
    focus: settings.focus.active ? settings.focus.areas : null,
    zen: settings.focus.active,
  }
}

function hideSnoozed(b: Row | null, sz: Set<string>) {
  if (!b || !sz.size) return b
  const keep = (p: Row) => !(p.pr && sz.has(p.pr)) && !(p.id && sz.has(p.id))
  return { ...b, pickup: (b.pickup ?? []).filter(keep), dropping: (b.dropping ?? []).filter(keep) }
}

// In focus, the brief keeps only picks and slips that belong to the focused areas.
function focusBrief(b: Row | null, ids: Set<string> | null, words: string[]) {
  if (!b || !ids) return b
  const keep = (p: Row) => (p.id && ids.has(p.id)) || words.some(w => `${p.title} ${p.pr ?? ''}`.toLowerCase().includes(w))
  return { ...b, pickup: (b.pickup ?? []).filter(keep), dropping: (b.dropping ?? []).filter(keep), groups: [], greeting: b.greeting }
}

function briefFor(day: string) {
  const b = get<Row>('select data, created_at from briefs where day = ?', day)
  return b ? { ...JSON.parse(b.data), created_at: b.created_at } : null
}

function lastAnswer(path: string | null) {
  if (!path || !existsSync(path)) return ''
  const items = itemsOf(path)
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'assistant') {
      const t = it.blocks.filter(b => b.type === 'text').map(b => (b as any).text).join(' ')
      if (t) return t.replace(/\s+/g, ' ').slice(0, 350)
    }
  }
  return ''
}

// Everything the brief is written from, as compact text. Capped so the call stays cheap.
export function digest() {
  const conv = list({ limit: 2000 }).conversations.concat(list({ states: ['later'], limit: 200 }).conversations)
    .filter(c => Date.now() - c.updated_at < 21 * DAY || c.prs.some((p: Row) => p.state === 'OPEN'))
    .slice(0, 45)
  const lines = conv.map((c, i) => {
    const prs = c.prs.map((p: Row) => `#${p.number ?? p.url.split('/').pop()} ${p.state ?? ''}${p.draft ? ' draft' : ''}${p.checks ? ' checks:' + p.checks : ''}${p.review ? ' review:' + p.review : ''}`).join(', ')
    const last = i < 15 ? lastAnswer(c.path) : ''
    return `- id=${c.id} | ${c.title ?? c.first_prompt} | state=${c.effective}${c.returned ? ' (back from snooze)' : ''} | ${Math.round((Date.now() - c.updated_at) / 3600_000)}h ago | ${c.source}${c.cwd ? ' ' + c.cwd.split('/').pop() : ''}${c.branch ? ' @' + c.branch : ''}${c.labels.length ? ' | labels ' + c.labels.join(',') : ''}${prs ? ' | PRs ' + prs : ''}${last ? `\n  last reply: ${last}` : ''}`
  })
  const stacks = prStacks().map(s => `- ${s.repo}: ${s.prs.map(p => `#${p.number} "${p.title}" ${p.draft ? 'draft' : 'open'}${p.checks ? ' checks:' + p.checks : ''}${p.review ? ' review:' + p.review : ''} updated ${Math.round((Date.now() - (p.updated_at ?? 0)) / DAY)}d ago`).join(' → ')}`)
  const notes = all<Row>('select day, body from notes where body != \'\' order by day desc limit 4').map(n => `### ${n.day}\n${n.body.slice(0, 2500)}`)
  return [
    `Today is ${new Date().toDateString()}.`,
    `## Conversations (most recent first)\n${lines.join('\n')}`,
    `## Open PRs I authored, as stacks (base → top)\n${stacks.join('\n') || 'none'}`,
    `## My notepad\n${notes.join('\n\n') || 'empty'}`,
  ].join('\n\n')
}

const BRIEF_PROMPT = `You are writing a short morning brief for an engineer about their own agent work. They run many conversations and PRs at once and lose track of them. Below is everything auto-m8 knows.

Reply with ONLY a JSON object, no prose, in exactly this shape:
{
  "greeting": "one sentence: what kind of day this looks like (driving existing work through, or making new things) and why",
  "mode": "drive" | "create",
  "pickup": [{"id": "<conversation id or empty>", "pr": "<PR url or empty>", "title": "short", "why": "one sentence: why this, why now"}],
  "dropping": [{"id": "", "pr": "", "title": "", "why": "what is slipping and the cost of leaving it"}],
  "groups": [{"label": "kebab-case-label", "ids": ["conversation ids that are one workstream"], "why": "short"}],
  "fromNotes": ["ideas or todos from the notepad that are not yet started, each one line"]
}
Rules: at most 3 pickup, 4 dropping, 4 groups (only real workstreams with 2+ conversations, reuse existing labels), 4 fromNotes. Prefer things that are close to done, blocking others, or failing. Use only ids and URLs from the data.`

export let briefing = false

export function generateBrief(): Promise<Row> {
  if (briefing) return Promise.resolve({ error: 'already running' })
  briefing = true
  return new Promise(resolve => {
    let text = ''
    // The prompt goes right after -p: variadic flags like --mcp-config would swallow it otherwise.
    const args = ['-p', `${BRIEF_PROMPT}\n\n${digest()}`, '--output-format', 'stream-json', '--verbose', '--model', settings.ai.model,
      '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk']
    ephemeral(args, settings.chat.cwd, ev => {
      if (ev.type === 'result') text = String(ev.result ?? '')
      if (ev.type !== 'perch_done') return
      briefing = false
      try {
        const data = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
        run('insert into briefs (day, created_at, data) values (?, ?, ?) on conflict(day) do update set created_at = excluded.created_at, data = excluded.data', today(), Date.now(), JSON.stringify(data))
        applyGroups(data)
        resolveErrors('Brief') // a good brief clears old failures, so autopilot stops reporting them
        resolve(data)
      } catch {
        resolve({ error: recordError('Brief', new Error(ev.error || `unreadable reply: ${text.slice(0, 160)}`), 'Writing the brief').message })
      }
    })
  })
}

// "Ask my history": Claude with only the perch tools answers from your past conversations.
const ASK_PROMPT = `You answer questions about the user's own past agent conversations, using only the auto-m8 tools (search_conversations, get_conversation, open_prs).
Search with two or three different phrasings, read the most relevant conversations, then answer concisely. For anything about PRs or stacks, also call open_prs: it is live GitHub state and beats what old conversations say.
Cite every conversation you rely on as a markdown link [title](auto-m8://<id>). If nothing relevant exists, say so plainly.`

export function ask(question: string, l: (ev: Row) => void) {
  const args = ['-p', question, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', settings.ai.model,
    '--no-session-persistence', '--strict-mcp-config', '--mcp-config', PERCH_MCP(), '--permission-mode', 'dontAsk',
    '--append-system-prompt', ASK_PROMPT, '--allowedTools', ...['search_conversations', 'get_conversation', 'open_prs'].map(t => mcpTool(t))]
  return ephemeral(args, settings.chat.cwd, l)
}

// The workstreams the brief spots are labelled straight away, no clicking: the label is what
// files them into folders. Only conversations that exist, and only labels they don't have yet.
export function applyGroups(data: Row) {
  let n = 0
  for (const g of data?.groups ?? []) {
    const label = String(g.label ?? '').toLowerCase().replace(/[^\w./-]+/g, '-').replace(/^-+|-+$/g, '')
    const ids = (g.ids ?? []).filter((id: string) => get('select 1 from conversations where id = ?', id) && !get('select 1 from labels where conversation_id = ? and label = ?', id, label))
    if (label && ids.length) { editLabels(ids, [label], [], 1); n += ids.length }
  }
  return n
}
// Today's brief, written before this existed.
try { const t = get<Row>('select data from briefs where day = ?', today()); if (t) applyGroups(JSON.parse(t.data)) } catch {}
